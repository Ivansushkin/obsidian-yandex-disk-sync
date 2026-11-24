import { planRecursiveDeletes } from "../files/deletion-cover";
import { isPathInsideFolder } from "../canonical/mutation-rules";
import {
	assertForceRecovery,
	ForceRecoveryPendingError,
	ForceSourceFormatError,
	ForceScopeConflictError,
	type ForceDirection,
	type ForceRecovery,
	type ForceSourceFile,
} from "./force-state";
import type { VaultAdapter } from "../../api/vault-adapter";
import type { YandexDiskClient } from "../../api/yandex-client";
import {
	EncryptionService,
	type EncryptionCodec,
} from "../../crypto/encryption";
import { EncryptionManager } from "../../crypto/encryption-manager";
import { getNewEncryptionPasswordError } from "../../crypto/password-policy";
import { parseEncryptionManifest } from "../../crypto/manifest-schema";
import {
	isReplacementPath,
	isReplacementSubtree,
	isPreservedRawPath,
} from "../../crypto/replacement";
import {
	createEmptyIndex,
	createSyncEpoch,
	type EncryptionManifest,
	type EncryptionReplacementScope,
	type FileMetadata,
	type RecursiveDeleteAction,
	type SyncIndex,
	type SyncPhase,
	type SyncResult,
	type YandexResource,
	type YandexDiskSyncSettings,
} from "../../types";
import { computeSha256, computeSha256FromString } from "../../utils/hash-utils";
import {
	assertForcePath,
	containsForceLocalPreservedPath,
	getDirectory,
	getPortablePathKey,
	hasPortablePathCollision,
	isForceSourcePath,
	isVaultTrashPath,
	joinPath,
	mayBeEncryptedPath,
	mayBeEncodedVaultTrashRoot,
	normalizePath,
	preservesForceLocalPath,
	shouldInspectRawSyncDirectory,
	shouldInspectRawSyncPath,
	shouldTraverseSyncDirectory,
	toLocalPath,
} from "../../utils/path-utils";
import {
	createSafeRecord,
	getRecordValue,
	protectRecord,
	setRecordValue,
} from "../../utils/record-utils";
import { getPhysicalResourceFingerprint } from "../../utils/resource-fingerprint";
import {
	ConcurrentSyncChangeError,
	isConcurrentSyncChange,
	RemoteHttpError,
} from "../../errors";
import { findErrorCause } from "../../utils/error-utils";
import type { IndexManager } from "../canonical/manager";
import {
	LegacyIndexFormatError,
	UnreadableRemoteIndexError,
} from "../canonical/errors";
import { createSyncError } from "../errors";
import { logger, shortenDiagnosticValue } from "../../utils/logger";
import { runWithConcurrencySettled } from "../../utils/semaphore";
import { planTransferWindows } from "../files/transfer-windows";

export interface ForceReplacementDependencies {
	client: YandexDiskClient;
	adapter: VaultAdapter;
	index: IndexManager;
	settings: YandexDiskSyncSettings;
	persist(state: ForceRecovery | null): Promise<void>;
	password(create: boolean, invalid?: boolean): Promise<string | null>;
	sourceProgress?(this: void, completed: number, total: number): void;
	isCancelled?(): boolean;
	watcherCutoff?(): string[];
	watcherBoundary?(): Record<string, string>;
	hasLocalChanges?(path: string, boundary: Record<string, string>): boolean;
	retireWatcherEvents?(
		cutoff: string[],
		boundary?: Record<string, string>,
	): Promise<void>;
	expectWatcherEvent?(
		path: string,
		action: "upload" | "delete",
	): void | (() => void);
	getRecovery?(): ForceRecovery | null;
	progress?(phase: SyncPhase, completed: number, total: number): void;
}
export type ForceReplacementPorts = Pick<
	ForceReplacementDependencies,
	| "persist"
	| "password"
	| "isCancelled"
	| "watcherCutoff"
	| "watcherBoundary"
	| "hasLocalChanges"
	| "retireWatcherEvents"
	| "getRecovery"
>;
export interface PreparedForceReplacement {
	recovery: ForceRecovery;
	codec: EncryptionCodec | null;
	password: string | null;
	/** Ephemeral selection; persisted pending actions already freeze the admitted remainder. */
	scope?: EncryptionReplacementScope;
	destinationCodec?: EncryptionCodec | null;
	destinationManifest?: EncryptionManifest | null;
	assertConfiguration(this: void): void;
}
export interface ForceApplyResult {
	uploaded: number;
	downloaded: number;
	deleted: number;
	errors: SyncResult["errors"];
	completed: boolean;
}
const encryption = new EncryptionManager();
const manifestName = ".obsidian-encrypt.json";
const indexName = ".obsidian-sync-index.json";
const emptyWatcherBoundary: Record<string, string> = Object.freeze({});

class ForceConfigurationChangedError extends Error {
	constructor() {
		super("Force connection changed or plugin unloaded");
	}
}

class ForceSourceMissingError extends ConcurrentSyncChangeError {
	constructor() {
		super("Force source disappeared before transfer", "missing");
	}
}

function traverse(path: string, scope: EncryptionReplacementScope): boolean {
	return shouldTraverseSyncDirectory(
		path,
		scope.syncPatterns,
		scope.excludePatterns,
		scope.syncDotObsidian,
		scope.configDir,
	);
}

function inspectRaw(
	path: string,
	scope: EncryptionReplacementScope,
	encrypted: boolean,
	directory: boolean,
): boolean {
	const inspect = directory
		? shouldInspectRawSyncDirectory
		: shouldInspectRawSyncPath;
	return inspect(
		path,
		scope.syncPatterns,
		scope.excludePatterns,
		scope.syncDotObsidian,
		scope.configDir,
		encrypted,
	);
}

const confirmedForcePlans = new WeakSet<PreparedForceReplacement>();

/** Record confirmation on the in-memory plan, separate from recovery identity. */
export function confirmForceReplacementPlan(
	plan: PreparedForceReplacement,
): void {
	plan.recovery.id ||= createSyncEpoch();
	plan.recovery.epoch ||= createSyncEpoch();
	confirmedForcePlans.add(plan);
}

/** Check confirmation without inferring it from the persisted recovery fields. */
export function isForceReplacementPlanConfirmed(
	plan: PreparedForceReplacement,
): boolean {
	return confirmedForcePlans.has(plan);
}

/** Hash identities rather than retaining the whole vault in memory. */
async function digestSource(files: ForceSourceFile[]): Promise<string> {
	return computeSha256FromString(
		JSON.stringify(
			files.map(({ path, sha256, size, rawPath, fingerprint }) => ({
				path,
				sha256,
				size,
				rawPath,
				fingerprint,
			})),
		),
	);
}

/** Map user paths explicitly; raw control names never select the payload codec. */
async function physicalPath(
	path: string,
	codec: EncryptionCodec | null,
): Promise<string> {
	return codec
		? (
				await Promise.all(
					path.split("/").map((part) => codec.encryptFilename(part)),
				)
			).join("/")
		: path;
}

type ForceSourcePosition = {
	resourceNumber: number;
	totalResources: number;
	resourceType: "file" | "dir";
};

function forceReadConcurrency(settings: YandexDiskSyncSettings): number {
	return Math.max(1, Math.min(Math.trunc(settings.maxConcurrency) || 1, 20));
}

interface ForceReadObservation {
	resource: YandexResource;
	budget: ReturnType<YandexDiskClient["createDownloadBudget"]>;
}

/** Validate the response before treating a missing resource or a directory as absence. */
function assertForceResourceIdentity(
	resource: YandexResource | null,
	path: string,
): void {
	if (
		resource &&
		((resource.type !== "file" && resource.type !== "dir") ||
			typeof resource.path !== "string" ||
			resource.path.includes("\\") ||
			normalizePath(resource.path.replace(/^disk:\//, "")) !==
				normalizePath(path.replace(/^disk:\//, "")) ||
			typeof resource.modified !== "string" ||
			!Number.isSafeInteger(Date.parse(resource.modified)) ||
			Date.parse(resource.modified) < 0 ||
			(resource.size !== undefined &&
				(!Number.isSafeInteger(resource.size) || resource.size < 0)))
	) {
		throw new Error("Force resource metadata is invalid");
	}
}

/** Read a stable physical file and authenticate its bytes within the active Force plan. */
async function readRemoteForceSource(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
	rawPath: string,
	assertActive: () => void,
	position?: ForceSourcePosition,
	observation?: ForceReadObservation,
) {
	assertActive();
	const path = joinPath(plan.recovery.remotePath, rawPath);
	const snapshot = await deps.client
		.downloadStableRawFile(path, observation?.resource, observation?.budget)
		.catch((error: unknown) => {
			if (
				(error instanceof ConcurrentSyncChangeError &&
					error.observation === "missing") ||
				findErrorCause(
					error,
					(cause) =>
						cause instanceof RemoteHttpError &&
						cause.status === 404,
				)
			) {
				throw new ForceSourceMissingError();
			}
			throw error;
		});
	assertActive();
	if (!snapshot) {
		throw new ForceSourceMissingError();
	}
	assertForceResourceIdentity(snapshot.resource, path);
	if (snapshot.resource.type !== "file") {
		throw new ForceSourceMissingError();
	}
	const content = await decodeSourceContent(
		snapshot.raw,
		plan.codec,
		position,
	);
	const sha256 = await computeSha256(content);
	assertActive();
	return {
		content,
		sha256,
		resource: snapshot.resource,
		fingerprint: snapshot.fingerprint,
	};
}

/** Recheck the next window before admitting payloads, keeping each observation's deadline. */
async function* readRemoteForceWindows(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
	pending: readonly ForceSourceFile[],
	assertActive: () => void,
) {
	const concurrency = forceReadConcurrency(deps.settings);
	for (const window of planTransferWindows(
		pending.map((file) => ({ file, size: file.size })),
		concurrency,
	)) {
		type Candidate = {
			file: ForceSourceFile;
			size?: number;
			renewed?: boolean;
		};
		const remaining: Candidate[][] = [window];
		while (remaining.length > 0) {
			const candidates = remaining.pop()!;
			assertActive();
			const metadata = await Promise.allSettled(
				candidates.map(async (candidate) => {
					const budget = deps.client.createDownloadBudget();
					const path = joinPath(
						plan.recovery.remotePath,
						candidate.file.rawPath,
					);
					const resource = await deps.client.getResource(
						path,
						1,
						0,
						true,
						budget,
					);
					assertForceResourceIdentity(resource, path);
					if (resource?.type !== "file") {
						throw new ForceSourceMissingError();
					}
					return {
						...candidate,
						size: resource.size,
						observation: { resource, budget },
					};
				}),
			);
			assertActive();
			const expired: Candidate[][] = [];
			const now = Date.now();
			const observed = metadata.flatMap((entry) => {
				if (entry.status === "rejected") {
					return [];
				}
				const { file, size, observation, renewed } = entry.value;
				if (!renewed && observation.budget.deadline <= now) {
					// A slow sibling must not consume a fast file's only read budget.
					expired.push([{ file, size, renewed: true }]);
					return [];
				}
				return [entry.value];
			});
			const [first = [], ...later] = planTransferWindows(
				observed,
				concurrency,
			);
			// Discard observations for postponed files. Their next window rechecks them.
			const postponed = later.map((batch) =>
				batch.map(({ file, size, renewed }) => ({
					file,
					size,
					renewed,
				})),
			);
			remaining.push(...postponed.reverse(), ...expired.reverse());
			const reads = await Promise.allSettled(
				first.map(({ file, observation }) =>
					readRemoteForceSource(
						deps,
						plan,
						file.rawPath,
						assertActive,
						undefined,
						observation,
					),
				),
			);
			assertActive();
			yield [
				...metadata.flatMap((read, index) =>
					read.status === "rejected"
						? [{ file: candidates[index]!.file, read }]
						: [],
				),
				...reads.map((read, index) => ({
					file: first[index]!.file,
					read,
				})),
			];
		}
	}
}

/** Fence transfers against an intervening client connection or codec change. */
function forceConnectionGuard(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
): () => void {
	const version = deps.client.getReadConfigurationVersion();
	return () => {
		plan.assertConfiguration();
		if (deps.client.getReadConfigurationVersion() !== version) {
			throw new ForceConfigurationChangedError();
		}
	};
}

async function logicalPath(
	path: string,
	codec: EncryptionCodec | null,
): Promise<string> {
	let logical = path;
	if (codec) {
		try {
			logical = (
				await Promise.all(
					path.split("/").map((part) => codec.decryptFilename(part)),
				)
			).join("/");
		} catch {
			throw new ForceSourceFormatError();
		}
	}
	assertForcePath(logical);
	return logical;
}

/** Preserve the selected source mode; failed authentication never becomes raw plaintext. */
async function decodeSourceContent(
	raw: ArrayBuffer,
	codec: EncryptionCodec | null,
	sourcePosition?: ForceSourcePosition,
): Promise<ArrayBuffer> {
	if (!codec) {
		return raw;
	}
	try {
		return await codec.decrypt(raw);
	} catch {
		if (sourcePosition) {
			logger.warn("Force encrypted source verification failed", {
				...sourcePosition,
				decodeStage: "content",
			});
		}
		throw new ForceSourceFormatError();
	}
}

/** Retired encrypted trash cannot be classified by a plaintext Force snapshot. */
async function assertNoRetiredTrash(
	deps: ForceReplacementDependencies,
	paths: string[],
): Promise<void> {
	const roots = new Set(
		paths
			.filter(mayBeEncodedVaultTrashRoot)
			.map((path) => path.split("/", 1)[0]),
	);
	if (!roots.size) {
		return;
	}
	const canonical = await deps.index
		.readCanonicalIndexWithCodecIfPresent(null)
		.catch((error: unknown) => {
			if (
				error instanceof LegacyIndexFormatError ||
				error instanceof UnreadableRemoteIndexError
			) {
				return null;
			}
			throw error;
		});
	if (
		canonical?.epochAdoption?.preservedRawPaths.some((path) =>
			roots.has(path.split("/", 1)[0]),
		) ||
		paths.some(
			(path) =>
				path.includes("/") &&
				mayBeEncodedVaultTrashRoot(path) &&
				mayBeEncryptedPath(path) &&
				(!canonical?.files[path] || canonical.files[path].deleted),
		)
	) {
		throw new ForceScopeConflictError();
	}
}

/** A Force epoch cannot carry the previous encryption adoption receipt. */
async function assertForceCanReplaceReceipt(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
): Promise<void> {
	const root = plan.recovery.remotePath;
	const destinationCodec = plan.destinationCodec ?? null;
	const children = await deps.client.getRawChildren(root);
	const opaqueRoots = new Set<string>();
	for (const child of children) {
		const path = toLocalPath(child.path, root);
		if (!mayBeEncryptedPath(path)) {
			continue;
		}
		try {
			EncryptionService.base64UrlDecode(path);
		} catch {
			continue;
		}
		if (
			!destinationCodec ||
			(await logicalPath(path, destinationCodec).catch(
				(error: unknown) => {
					if (error instanceof ForceSourceFormatError) {
						return null;
					}
					throw error;
				},
			)) === null
		) {
			opaqueRoots.add(path);
		}
	}
	if (!opaqueRoots.size) {
		return;
	}
	const canonical = await deps.index
		.readCanonicalIndexWithCodecIfPresent(destinationCodec)
		.catch((error: unknown) => {
			if (
				error instanceof LegacyIndexFormatError ||
				(!destinationCodec &&
					error instanceof UnreadableRemoteIndexError)
			) {
				return null;
			}
			throw error;
		});
	for (const path of canonical?.epochAdoption?.preservedRawPaths ?? []) {
		if (
			!opaqueRoots.has(path.split("/", 1)[0]!) ||
			!mayBeEncryptedPath(path)
		) {
			continue;
		}
		const raw = joinPath(root, path);
		const resource = await deps.client.getResource(raw, 1, 0, true);
		assertForceResourceIdentity(resource, raw);
		if (
			resource?.type === "file" ||
			(resource?.type === "dir" &&
				(
					await deps.client.getResourcesRecursive(
						raw,
						true,
						4,
						false,
						() => true,
						false,
					)
				).length > 0)
		) {
			throw new ForceScopeConflictError(
				"Force would lose the exclusion for retained ciphertext from an earlier encryption mode",
			);
		}
	}
	plan.assertConfiguration();
}

/** Prove every selected source is readable before any destination deletion. */
async function scanSource(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
	progress = deps.sourceProgress,
): Promise<void> {
	const state = plan.recovery;
	const direct = state.direct!;
	const source: ForceSourceFile[] = [];
	const directories: { path: string; rawPath: string }[] = [];
	const assertActive =
		state.direction === "from_remote"
			? forceConnectionGuard(deps, plan)
			: plan.assertConfiguration;
	assertActive();
	let completed = 0;
	if (state.direction === "from_local") {
		const tree = await deps.adapter.getForceTree(
			true,
			(path, directory) =>
				!plan.scope ||
				(directory
					? traverse(path, plan.scope)
					: isReplacementPath(path, plan.scope)),
		);
		const total = tree.directories.length + tree.files.length;
		progress?.(0, total);
		for (const path of tree.directories) {
			plan.assertConfiguration();
			if (plan.scope && !isReplacementPath(path, plan.scope)) {
				progress?.(++completed, total);
				continue;
			}
			directories.push({
				path,
				rawPath: await physicalPath(path, plan.codec),
			});
			progress?.(++completed, total);
		}
		for (const path of tree.files) {
			plan.assertConfiguration();
			const content = await deps.adapter.readForceFile(path);
			plan.assertConfiguration();
			const stat = await deps.adapter.vault.adapter.stat(path);
			if (!stat || stat.type !== "file") {
				throw new Error("Force local source became unavailable");
			}
			source.push({
				path,
				rawPath: await physicalPath(path, plan.codec),
				sha256: await computeSha256(content),
				size: content.byteLength,
				mtime: stat.mtime,
				fingerprint: null,
			});
			progress?.(++completed, total);
		}
		assertForceSourcePaths(source, directories);
	} else {
		const resources = await deps.client.getResourcesRecursive(
			state.remotePath,
			true,
			4,
			true,
			(raw, kind) => {
				const path = toLocalPath(raw, state.remotePath);
				return (
					isForceSourcePath(path, direct.configDir) &&
					(!plan.scope ||
						inspectRaw(
							path,
							plan.scope,
							!!plan.codec,
							kind === "dir",
						))
				);
			},
			false,
		);
		assertActive();
		if (!plan.codec) {
			await assertNoRetiredTrash(
				deps,
				resources.map(({ path }) =>
					toLocalPath(path, state.remotePath),
				),
			);
		}
		assertActive();
		progress?.(0, resources.length);
		const excluded = new Set<string>();
		const selected: {
			path: string;
			rawPath: string;
			size?: number;
			position: ForceSourcePosition;
		}[] = [];
		for (const [index, resource] of resources.entries()) {
			assertActive();
			const rawPath = toLocalPath(resource.path, state.remotePath);
			assertForcePath(rawPath);
			if (
				isPreservedRawPath(rawPath, [...excluded]) ||
				(plan.scope &&
					!inspectRaw(
						rawPath,
						plan.scope,
						!!plan.codec,
						resource.type === "dir",
					))
			) {
				progress?.(++completed, resources.length);
				continue;
			}
			const sourcePosition: ForceSourcePosition = {
				resourceNumber: index + 1,
				totalResources: resources.length,
				resourceType: resource.type,
			};
			const path = await logicalPath(rawPath, plan.codec).catch(
				async (error: unknown) => {
					assertActive();
					if (!(error instanceof ForceSourceFormatError)) {
						throw error;
					}
					if (resource.type === "dir") {
						// A retired codec can leave empty trees. Check every raw descendant, including protected paths.
						const files = await deps.client.getResourcesRecursive(
							joinPath(state.remotePath, rawPath),
							true,
							4,
							false,
							() => true,
							false,
						);
						assertActive();
						if (files.length === 0) {
							return null;
						}
					}
					logger.warn("Force encrypted source verification failed", {
						...sourcePosition,
						decodeStage: "name",
					});
					throw error;
				},
			);
			assertActive();
			if (
				path === null ||
				!isForceSourcePath(path, direct.configDir) ||
				(plan.scope &&
					(resource.type === "dir"
						? !traverse(path, plan.scope)
						: !isReplacementPath(path, plan.scope)))
			) {
				if (resource.type === "dir") {
					excluded.add(rawPath);
				}
				progress?.(++completed, resources.length);
				continue;
			}
			if (
				preservesForceLocalPath(path, direct.configDir) ||
				(resource.type === "file" &&
					containsForceLocalPreservedPath(path, direct.configDir))
			) {
				throw new Error(
					"Force source conflicts with the preserved local installation",
				);
			}
			if (resource.type === "dir") {
				if (!plan.scope || isReplacementPath(path, plan.scope)) {
					directories.push({ path, rawPath });
				}
				progress?.(++completed, resources.length);
				continue;
			}
			selected.push({
				path,
				rawPath,
				size: resource.size,
				position: sourcePosition,
			});
		}
		assertForceSourcePaths(selected, directories);
		for (const window of planTransferWindows(
			selected,
			forceReadConcurrency(deps.settings),
		)) {
			assertActive();
			let firstFailure: { reason: unknown } | undefined;
			const outcomes = await runWithConcurrencySettled(
				window.map(
					({ path, rawPath, position }) =>
						async (): Promise<ForceSourceFile> => {
							const snapshot = await readRemoteForceSource(
								deps,
								plan,
								rawPath,
								assertActive,
								position,
							);
							if (!firstFailure) {
								progress?.(++completed, resources.length);
							}
							return {
								path,
								rawPath,
								sha256: snapshot.sha256,
								size: snapshot.content.byteLength,
								mtime: Date.parse(snapshot.resource.modified),
								fingerprint: snapshot.fingerprint,
							};
						},
				),
				window.length,
				undefined,
				{
					onError: (reason) => {
						firstFailure ??= { reason };
					},
				},
			);
			if (firstFailure) {
				if (firstFailure.reason instanceof ForceSourceMissingError) {
					throw new Error("Force remote source became unavailable");
				}
				throw firstFailure.reason;
			}
			for (const outcome of outcomes) {
				if (outcome.status === "fulfilled") {
					source.push(outcome.value);
				}
			}
		}
	}
	source.sort((a, b) => a.path.localeCompare(b.path));
	const sourceDigest = await digestSource(source);
	assertActive();
	state.source = source;
	state.sourceDigest = sourceDigest;
	direct.directories = directories.sort((a, b) =>
		a.path.localeCompare(b.path),
	);
	direct.pendingFiles = source.map((file) => file.path);
	direct.pendingDirectories = directories.map((folder) => folder.path);
}

/** Reject ambiguous source paths before admitting destination work. */
function assertForceSourcePaths(
	files: readonly { path: string }[],
	directories: readonly { path: string }[],
): void {
	if (
		hasPortablePathCollision(
			files.map((file) => file.path),
			directories.map((folder) => folder.path),
		)
	) {
		throw new Error("Force source has ambiguous portable paths");
	}
}

/** Choose a source codec without decoding the old destination index. */
export async function prepareForceReplacement(
	deps: ForceReplacementDependencies,
	direction: ForceDirection,
	deferIdentity = false,
): Promise<PreparedForceReplacement | null> {
	const remotePath = deps.settings.remotePath;
	assertForcePath(remotePath.replace(/^disk:\//, ""));
	const token = deps.settings.yandexTokenSecret;
	if (deps.isCancelled?.()) {
		return null;
	}
	const root = await deps.client.getResource(remotePath, 1, 0, true);
	if (deps.isCancelled?.()) {
		return null;
	}
	if (direction === "from_remote" && !root) {
		throw new Error("Force remote source is unavailable");
	}
	if (root && root.type !== "dir") {
		throw new Error("Force storage root is not a folder");
	}
	const scope: EncryptionReplacementScope = {
		syncPatterns: [...deps.settings.syncPatterns],
		excludePatterns: [...deps.settings.excludePatterns],
		syncDotObsidian: deps.settings.syncDotObsidian,
		configDir: deps.adapter.vault.configDir,
	};
	const destinationManifest = await deps.index.downloadEncryptionManifest();
	let destinationCodec: EncryptionCodec | null = null;
	let password = deps.settings.encryptionPassword;
	if (destinationManifest) {
		let invalid = false;
		while (true) {
			if (deps.isCancelled?.()) {
				return null;
			}
			if (password) {
				destinationCodec = await encryption.createCodec(
					"hardened",
					destinationManifest.salt,
					password,
				);
				if (
					await encryption.verifyCandidate(
						destinationCodec,
						destinationManifest.verifier,
					)
				) {
					break;
				}
				invalid = true;
			}
			password = await deps.password(false, invalid);
			if (!password) {
				return null;
			}
		}
	}
	let codec: EncryptionCodec | null = null;
	let manifest: EncryptionManifest | null = null;
	const encryptedOutput =
		direction === "from_remote"
			? !!destinationManifest
			: deps.settings.enableEncryption;
	if (encryptedOutput) {
		if (destinationManifest) {
			codec = destinationCodec;
			manifest =
				destinationManifest.state === "enabled" &&
				!destinationManifest.transition
					? destinationManifest
					: await encryption.createManifest({
							service: codec!,
							salt: destinationManifest.salt,
							revision: destinationManifest.revision,
							state: "enabled",
							deviceId: deps.settings.deviceId,
						});
		} else {
			if (!password) {
				password = await deps.password(true);
				if (!password) {
					return null;
				}
				const passwordError = getNewEncryptionPasswordError(password);
				if (passwordError) {
					throw new Error(passwordError);
				}
			}
			const { snapshot } = encryption.createTargetSnapshot(
				password,
				(deps.settings.encryptionRevision ?? 0) + 1,
			);
			codec = await encryption.createCodec(
				"hardened",
				snapshot.salt!,
				password,
			);
			manifest = await encryption.createManifest({
				service: codec,
				salt: snapshot.salt!,
				revision: snapshot.revision!,
				state: "enabled",
				deviceId: deps.settings.deviceId,
			});
		}
	}
	const recovery: ForceRecovery = {
		completion: null,
		password: codec ? password : null,
		id: deferIdentity ? "" : createSyncEpoch(),
		epoch: deferIdentity ? "" : createSyncEpoch(),
		direction,
		phase: "prepared",
		backupMode: "without-backup",
		backupProof: null,
		remotePath,
		rootResourceId: root?.resource_id ?? null,
		originalCanonicalFingerprint: null,
		serviceCleanup: [],
		sourceDigest: "",
		source: [],
		target: manifest
			? {
					enabled: true,
					salt: manifest.salt,
					verifier: manifest.verifier,
					revision: manifest.revision,
				}
			: { enabled: false, salt: null, verifier: null, revision: null },
		manifest: manifest
			? (JSON.parse(JSON.stringify(manifest)) as EncryptionManifest)
			: null,
		watcherCutoff: deps.watcherCutoff?.() ?? [],
		...(deps.watcherBoundary
			? { watcherBoundary: deps.watcherBoundary() }
			: {}),
		cleanup: [],
		targetHashes: createSafeRecord(),
		files: createSafeRecord(),
		direct: {
			format: "direct-v1",
			configDir: deps.adapter.vault.configDir,
			stage: "purging",
			directories: [],
			pendingDeletes: [],
			pendingFiles: [],
			pendingDirectories: [],
			canonicalReset: false,
			trashExcluded: true,
		},
	};
	const plan: PreparedForceReplacement = {
		recovery,
		codec,
		password: codec ? password : null,
		scope,
		destinationCodec,
		destinationManifest,
		assertConfiguration: () => {
			if (
				deps.isCancelled?.() ||
				deps.settings.remotePath !== remotePath ||
				deps.settings.yandexTokenSecret !== token ||
				deps.adapter.vault.configDir !== recovery.direct!.configDir ||
				JSON.stringify(deps.settings.syncPatterns) !==
					JSON.stringify(scope.syncPatterns) ||
				JSON.stringify(deps.settings.excludePatterns) !==
					JSON.stringify(scope.excludePatterns) ||
				deps.settings.syncDotObsidian !== scope.syncDotObsidian
			) {
				throw new ForceConfigurationChangedError();
			}
		},
	};
	await assertForceCanReplaceReceipt(deps, plan);
	await scanSource(deps, plan);
	await prepareDeletion(deps, plan);
	return plan;
}

/** Resume only direct progress whose explicit actions were saved at apply time. */
export async function resumeForceReplacement(
	deps: ForceReplacementDependencies,
	recovery: ForceRecovery,
): Promise<PreparedForceReplacement> {
	const token = deps.settings.yandexTokenSecret;
	const configuration = deps.client.getReadConfigurationVersion();
	assertForceRecovery(recovery);
	if (!recovery.direct) {
		throw new Error(
			"Legacy Force recovery requires a new full replacement confirmation",
		);
	}
	if (recovery.phase === "prepared") {
		throw new ForceRecoveryPendingError(
			"The saved Force has no confirmed replacement scope; prepare and confirm a new replacement",
		);
	}
	if (
		recovery.remotePath !== deps.settings.remotePath ||
		recovery.direct.configDir !== deps.adapter.vault.configDir
	) {
		throw new Error("Force recovery belongs to another storage");
	}
	if ((await digestSource(recovery.source)) !== recovery.sourceDigest) {
		throw new Error("Force source checkpoint digest is invalid");
	}
	const codec = recovery.target.enabled
		? await encryption.createCodec(
				"hardened",
				recovery.target.salt!,
				recovery.password!,
			)
		: null;
	if (
		codec &&
		!(await encryption.verifyCandidate(codec, recovery.target.verifier!))
	) {
		throw new Error("Force recovery encryption parameters are invalid");
	}
	await assertForceRemainderScope(deps, recovery, codec);
	if (
		deps.isCancelled?.() ||
		deps.settings.yandexTokenSecret !== token ||
		deps.settings.remotePath !== recovery.remotePath ||
		deps.adapter.vault.configDir !== recovery.direct.configDir ||
		deps.client.getReadConfigurationVersion() !== configuration
	) {
		throw new Error("Force recovery connection changed during preparation");
	}
	logger.info("Direct Force recovery prepared", {
		operationId: shortenDiagnosticValue(recovery.id),
		direction: recovery.direction,
		phase: recovery.phase,
		stage: recovery.direct.stage,
		pendingDeletes: recovery.direct.pendingDeletes.length,
		pendingFiles: recovery.direct.pendingFiles.length,
		pendingDirectories: recovery.direct.pendingDirectories.length,
	});
	return {
		recovery,
		codec,
		password: recovery.password,
		assertConfiguration: () => {
			if (
				deps.isCancelled?.() ||
				deps.settings.remotePath !== recovery.remotePath ||
				deps.settings.yandexTokenSecret !== token ||
				deps.adapter.vault.configDir !== recovery.direct!.configDir
			) {
				throw new ForceConfigurationChangedError();
			}
		},
	};
}

/** Reject old checkpoints that would act outside today's protected replacement scope. */
async function assertForceRemainderScope(
	deps: ForceReplacementDependencies,
	state: ForceRecovery,
	codec: EncryptionCodec | null,
): Promise<void> {
	const direct = state.direct!;
	const incompatible = () =>
		new ForceRecoveryPendingError(
			"The saved Force includes protected or unavailable paths; prepare and confirm a new replacement",
		);
	if (
		[
			...state.source.map(({ path }) => path),
			...direct.directories.map(({ path }) => path),
			...direct.pendingDeletes.map(({ path }) => path),
		].some(isVaultTrashPath)
	) {
		throw incompatible();
	}
	const remoteDeletes = direct.pendingDeletes.filter(
		({ location, path }) =>
			location === "remote" && mayBeEncodedVaultTrashRoot(path),
	);
	if (
		!direct.trashExcluded &&
		remoteDeletes.length > 0 &&
		!codec &&
		state.direction === "from_local" &&
		(direct.canonicalReset ||
			(await deps.index.downloadEncryptionManifest()))
	) {
		throw incompatible();
	}
	if (codec) {
		for (const root of new Set(
			remoteDeletes.map(({ path }) => path.split("/", 1)[0]!),
		)) {
			const decoded = await codec.decryptFilename(root).catch(() => null);
			if (decoded !== null && isVaultTrashPath(decoded)) {
				throw incompatible();
			}
		}
	}
	if (
		state.direction === "from_remote" &&
		(direct.pendingDeletes.some(({ location }) => location === "local") ||
			direct.pendingFiles.length ||
			direct.pendingDirectories.length)
	) {
		const { files, directories } = await deps.adapter.getForceTree(false);
		const unindexed = (path: string) =>
			!deps.adapter.vault.getAbstractFileByPath(path);
		const unavailableFiles = files.filter(unindexed);
		const unavailableDirs = directories.filter(unindexed);
		const deleted = direct.pendingDeletes.filter(
			({ location }) => location === "local",
		);
		if (
			[...unavailableFiles, ...unavailableDirs].some((path) =>
				deleted.some(
					(action) =>
						action.path === path ||
						path.startsWith(`${action.path}/`),
				),
			) ||
			hasPortablePathCollision(
				direct.pendingFiles,
				direct.pendingDirectories,
				{ files: unavailableFiles, directories: unavailableDirs },
			)
		) {
			throw incompatible();
		}
	}
}

/** Create a missing root without using old baseline identity as admission authority. */
export async function ensureForceRoot(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
): Promise<void> {
	plan.assertConfiguration();
	await deps.index.withForceScope(plan.recovery, async () => {
		await deps.client.createFolderRecursive(plan.recovery.remotePath);
		const root = await deps.client.getResource(
			plan.recovery.remotePath,
			1,
			0,
			true,
		);
		if (!root || root.type !== "dir" || !root.resource_id) {
			throw new Error("Force root creation was not confirmed");
		}
		plan.recovery.rootResourceId = root.resource_id;
	});
}

/** Build fresh causal metadata; failed transfers never become confirmed baselines. */
function forceIndex(
	deps: ForceReplacementDependencies,
	state: ForceRecovery,
	final = false,
): SyncIndex {
	const index = createEmptyIndex(deps.settings.deviceId, state.epoch);
	index.revision = final ? (state.completion?.revision ?? 3) : 1;
	index.files = structuredClone(state.files);
	if (!final) {
		index.maintenance = {
			id: state.id,
			kind: "force",
			phase: state.phase,
			initiatedBy: deps.settings.deviceId,
			sourceRevision: 0,
			targetRevision: index.revision,
			source: state.target,
			target: state.target,
			direction: state.direction,
			sourceDigest: state.sourceDigest,
			cleanup: [],
		};
	}
	return index;
}

/** A raw-only file can be acknowledged only when no write is needed. */
async function assertRetainedForceFileMatches(
	adapter: VaultAdapter,
	path: string,
	sha256: string,
): Promise<void> {
	if ((await computeSha256(await adapter.readForceFile(path))) !== sha256) {
		throw new ForceScopeConflictError();
	}
}

/** Freeze selected deletes while retaining every excluded or protected descendant. */
async function prepareScopedDeletion(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
): Promise<void> {
	const state = plan.recovery;
	const scope = plan.scope!;
	const local = state.direction === "from_remote";
	const codec = local ? null : (plan.destinationCodec ?? null);
	const preserved = new Set<string>();
	let preservedEncrypted = false;
	let entries: RecursiveDeleteAction[];
	if (local) {
		const tree = await deps.adapter.getForceTree(false);
		entries = [
			...tree.files.map((path) => ({ path, kind: "file" as const })),
			...tree.directories.map((path) => ({ path, kind: "dir" as const })),
		];
	} else {
		const resources = await deps.client.getResourcesRecursive(
			state.remotePath,
			true,
			4,
			true,
			(raw, kind) => {
				const path = toLocalPath(raw, state.remotePath);
				const inspect =
					isForceSourcePath(path, scope.configDir) &&
					inspectRaw(path, scope, !!codec, kind === "dir");
				if (!inspect) {
					preserved.add(path);
					preservedEncrypted ||= !!codec && mayBeEncryptedPath(path);
				}
				return inspect;
			},
		);
		entries = resources.map((entry) => ({
			path: toLocalPath(entry.path, state.remotePath),
			kind: entry.type,
		}));
		if (!codec) {
			await assertNoRetiredTrash(
				deps,
				entries.map(({ path }) => path),
			);
		}
	}
	const removable = new Set<string>();
	const collapsible = new Set<string>();
	const unindexedLocal = new Set<string>();
	const logicalEntries = new Map<string, RecursiveDeleteAction>();
	for (const entry of [...entries].sort((a, b) =>
		a.path.localeCompare(b.path),
	)) {
		plan.assertConfiguration();
		if (!local && isPreservedRawPath(entry.path, [...preserved])) {
			continue;
		}
		const path = await logicalPath(entry.path, codec);
		logicalEntries.set(path, entry);
		if (local && !deps.adapter.vault.getAbstractFileByPath(path)) {
			preserved.add(path);
			unindexedLocal.add(path);
			continue;
		}
		const selected =
			isForceSourcePath(path, scope.configDir) &&
			isReplacementPath(path, scope);
		if (
			(entry.kind === "file" && !selected) ||
			(entry.kind === "dir" &&
				(!isForceSourcePath(path, scope.configDir) ||
					!traverse(path, scope)))
		) {
			preserved.add(entry.path);
			preservedEncrypted ||= !!codec;
			continue;
		}
		if (selected) {
			removable.add(entry.path);
		}
		if (
			entry.kind === "dir" &&
			isReplacementSubtree(path, scope) &&
			!containsForceLocalPreservedPath(path, scope.configDir)
		) {
			collapsible.add(entry.path);
		}
	}
	if (preservedEncrypted && !plan.codec) {
		throw new ForceScopeConflictError();
	}
	// A selected file must not recursively replace a directory holding excluded data.
	for (const file of [
		...state.source.map((file) => ({ ...file, kind: "file" as const })),
		...state.direct!.directories.map((folder) => ({
			...folder,
			kind: "dir" as const,
		})),
	]) {
		const targetPath = local ? file.path : file.rawPath;
		if (
			[...preserved].some((path) => {
				const retained = local ? logicalEntries.get(path) : undefined;
				if (unindexedLocal.has(path)) {
					if (
						retained?.kind === "dir" &&
						targetPath.startsWith(`${path}/`)
					) {
						return false;
					}
					if (targetPath === path && retained?.kind === file.kind) {
						return false;
					}
				}
				return (
					targetPath === path ||
					targetPath.startsWith(`${path}/`) ||
					(file.kind === "file" &&
						path.startsWith(`${targetPath}/`)) ||
					(retained !== undefined &&
						hasPortablePathCollision(
							[file, retained]
								.filter(({ kind }) => kind === "file")
								.map(({ path }) => path),
							[file, retained]
								.filter(({ kind }) => kind === "dir")
								.map(({ path }) => path),
						))
				);
			})
		) {
			throw new ForceScopeConflictError();
		}
		const target = logicalEntries.get(file.path);
		if (file.kind === "file" && unindexedLocal.has(targetPath)) {
			await assertRetainedForceFileMatches(
				deps.adapter,
				file.path,
				file.sha256,
			);
			plan.assertConfiguration();
		}
		if (
			file.kind === "file" &&
			target?.kind === "dir" &&
			(!collapsible.has(target.path) ||
				[...preserved].some((path) =>
					path.startsWith(`${target.path}/`),
				))
		) {
			throw new ForceScopeConflictError();
		}
		for (
			let parent = getDirectory(file.path);
			parent;
			parent = getDirectory(parent)
		) {
			const blocker = logicalEntries.get(parent);
			if (blocker?.kind === "file" && !removable.has(blocker.path)) {
				throw new ForceScopeConflictError();
			}
		}
	}
	state.direct!.pendingDeletes = planRecursiveDeletes(
		entries,
		removable,
		preserved,
		(path) => collapsible.has(path),
	).map((entry) => ({ ...entry, location: local ? "local" : "remote" }));
	{
		state.direct!.pendingDeletes.push(
			...(await deps.client.getRawChildren(state.remotePath))
				.filter((entry) =>
					toLocalPath(entry.path, state.remotePath).startsWith(
						".obsidian-sync-index.lock.",
					),
				)
				.map((entry) => ({
					path: toLocalPath(entry.path, state.remotePath),
					location: "remote" as const,
					kind: entry.type,
				})),
		);
	}
}

/** Inventory deletion targets once; subsequent sync retries never restart the broad purge. */
async function prepareDeletion(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
): Promise<void> {
	const state = plan.recovery;
	const direct = state.direct!;
	if (plan.scope) {
		await prepareScopedDeletion(deps, plan);
		return;
	}
	if (state.direction === "from_local") {
		const entries = (
			await deps.client.getRawChildren(state.remotePath)
		).map((entry) => ({
			path: toLocalPath(entry.path, state.remotePath),
			kind: entry.type,
		}));
		direct.pendingDeletes = planRecursiveDeletes(
			entries,
			new Set(entries.map((entry) => entry.path)),
			new Set([
				".backup",
				indexName,
				manifestName,
				...entries
					.filter(({ path }) => isVaultTrashPath(path))
					.map(({ path }) => path),
			]),
		).map((entry) => ({ ...entry, location: "remote" }));
	} else {
		const tree = await deps.adapter.getForceTree(false);
		const entries = [
			...tree.directories.map((path) => ({ path, kind: "dir" as const })),
			...tree.files.map((path) => ({ path, kind: "file" as const })),
		];
		const preserved = new Set(
			entries
				.filter(
					({ path }) =>
						!deps.adapter.vault.getAbstractFileByPath(path),
				)
				.map(({ path }) => path),
		);
		const removable = new Set(entries.map(({ path }) => path));
		direct.pendingDeletes = [
			...planRecursiveDeletes(
				entries,
				removable,
				preserved,
				(path) =>
					!containsForceLocalPreservedPath(path, direct.configDir),
			).map((entry) => ({ ...entry, location: "local" as const })),
			...(await deps.client.getRawChildren(state.remotePath))
				.filter((entry) =>
					toLocalPath(entry.path, state.remotePath).startsWith(
						".obsidian-sync-index.lock.",
					),
				)
				.map((entry) => ({
					path: toLocalPath(entry.path, state.remotePath),
					location: "remote" as const,
					kind: entry.type,
				})),
		];
	}
}

/** Publish compatible encryption parameters directly, never temporary source/target manifests. */
async function publishManifest(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
): Promise<void> {
	const path = joinPath(plan.recovery.remotePath, manifestName);
	const manifest = plan.recovery.manifest;
	if (manifest) {
		if (plan.recovery.direction === "from_remote") {
			const snapshot = await deps.client.downloadStableRawFile(path);
			if (snapshot) {
				let matching = false;
				try {
					matching =
						JSON.stringify(
							parseEncryptionManifest(
								JSON.parse(
									new TextDecoder().decode(snapshot.raw),
								) as Record<string, unknown>,
							),
						) === JSON.stringify(manifest);
				} catch {
					/* A readable source can reconstruct malformed metadata from its authenticated codec. */
				}
				if (matching) {
					return;
				}
			}
		}
		const resource = await deps.client.getResource(path, 1, 0, true);
		if (resource?.type === "dir") {
			await deps.client.deleteResource(path, true, true);
		}
		const content = JSON.stringify(manifest);
		let uploadError: unknown;
		try {
			await deps.client.uploadFile(path, content, false, true, true);
		} catch (error) {
			uploadError = error;
		}
		const actual = await deps.client.downloadStableRawFile(path);
		if (
			!actual ||
			(await computeSha256(actual.raw)) !==
				(await computeSha256FromString(content))
		) {
			throw uploadError instanceof Error
				? uploadError
				: new Error("Force encryption manifest was not confirmed");
		}
	} else {
		await deps.client.deleteResource(path, true, true);
		if (await deps.client.getResource(path, 1, 0, true)) {
			throw new Error(
				"Force plaintext manifest removal was not confirmed",
			);
		}
	}
}

async function ensureRemoteDirectory(
	deps: ForceReplacementDependencies,
	root: string,
	path: string,
	beforeMutation: () => Promise<void>,
): Promise<void> {
	let current = root;
	for (const segment of path.split("/")) {
		current = joinPath(current, segment);
		const resource = await deps.client.getResource(current, 1, 0, true);
		if (resource?.type === "file") {
			throw new ForceScopeConflictError();
		}
		await beforeMutation();
		await deps.client.createFolder(current);
	}
}

/** Verify known newly written bytes; no destination-content snapshot is required. */
async function verifyUpload(
	deps: ForceReplacementDependencies,
	path: string,
	content: ArrayBuffer,
): Promise<YandexResource> {
	const hash = await computeSha256(content);
	const resource = await deps.client.getResource(path, 1, 0, true);
	if (resource?.type !== "file") {
		throw new Error("Force upload was not confirmed");
	}
	if (resource.sha256) {
		if (resource.sha256 !== hash || resource.size !== content.byteLength) {
			throw new Error(
				"Force uploaded bytes do not match the selected source",
			);
		}
	} else {
		const actual = await deps.client.downloadStableRawFile(path);
		if (!actual || (await computeSha256(actual.raw)) !== hash) {
			throw new Error("Force uploaded bytes were not verified");
		}
	}
	return resource;
}

interface VerifiedForceCopy {
	sha256: string;
	size: number;
	resource: YandexResource;
	rawSha256?: string;
}

/** Transfer one file directly and return the identity of the verified destination bytes. */
async function uploadForceFile(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
	file: ForceSourceFile,
): Promise<VerifiedForceCopy> {
	const state = plan.recovery;
	let content: ArrayBuffer;
	let raw: ArrayBuffer;
	let resource: YandexResource;
	const path = joinPath(state.remotePath, file.rawPath);
	if ((await deps.adapter.vault.adapter.stat(file.path))?.type !== "file") {
		const recovered = await deps.client.downloadStableRawFile(path);
		if (!recovered) {
			throw new ForceSourceMissingError();
		}
		content = await decodeSourceContent(recovered.raw, plan.codec);
		if ((await computeSha256(content)) !== file.sha256) {
			throw new ConcurrentSyncChangeError(
				"Force destination does not match the missing source",
			);
		}
		resource = recovered.resource;
		raw = recovered.raw;
	} else {
		content = await deps.adapter.readForceFile(file.path);
		raw = plan.codec ? await plan.codec.encrypt(content) : content;
		const parent = getDirectory(file.rawPath);
		if (parent) {
			await ensureRemoteDirectory(
				deps,
				state.remotePath,
				parent,
				async () => plan.assertConfiguration(),
			);
		}
		if ((await deps.client.getResource(path, 1, 0, true))?.type === "dir") {
			throw new ForceScopeConflictError();
		}
		let uploadError: unknown;
		try {
			await deps.client.uploadFile(
				path,
				raw,
				true,
				true,
				true,
				async () => plan.assertConfiguration(),
			);
		} catch (error) {
			uploadError = error;
		}
		try {
			resource = await verifyUpload(deps, path, raw);
		} catch (error) {
			throw uploadError instanceof Error ? uploadError : error;
		}
	}
	return {
		sha256: await computeSha256(content),
		size: content.byteLength,
		resource,
		rawSha256: await computeSha256(raw),
	};
}

/** Build the same canonical metadata for a verified copy or preserved late edit. */
function forceFileMetadata(
	deps: ForceReplacementDependencies,
	file: ForceSourceFile,
	resource: YandexResource | null,
): FileMetadata {
	return {
		path: file.path,
		sha256: file.sha256,
		size: file.size,
		mtime: file.mtime,
		syncedAt: Date.now(),
		remoteFingerprint:
			getPhysicalResourceFingerprint(resource) ?? undefined,
		remoteMtime: resource ? Date.parse(resource.modified) : undefined,
		lastModifiedBy: deps.settings.deviceId,
		mutationSeq: 0,
		baseRevision: 0,
		changedRevision: 1,
	};
}

/** Apply a prefetched copy only against current Vault state and verify its output. */
async function writeRemoteForceFile(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
	file: ForceSourceFile,
	source: Awaited<ReturnType<typeof readRemoteForceSource>>,
	assertActive: () => void,
): Promise<"copied" | "already-copied" | "preserved"> {
	const state = plan.recovery;
	const stat = await deps.adapter.vault.adapter.stat(file.path);
	assertActive();
	if (stat && stat.type !== "file") {
		throw new ForceScopeConflictError();
	}
	if (stat && !deps.adapter.vault.getAbstractFileByPath(file.path)) {
		await assertRetainedForceFileMatches(
			deps.adapter,
			file.path,
			source.sha256,
		);
		assertActive();
		return "already-copied";
	}
	const hasLocalChanges = () =>
		deps.hasLocalChanges?.(
			file.path,
			state.watcherBoundary ?? emptyWatcherBoundary,
		);
	if (hasLocalChanges()) {
		return "preserved";
	}
	if (
		!getRecordValue(state.files, file.path) &&
		(await deps.adapter.vault.adapter.exists(file.path))
	) {
		if (stat?.type === "file") {
			const local = await deps.adapter.readForceFile(file.path);
			if ((await computeSha256(local)) === source.sha256) {
				return "already-copied";
			}
		}
		return "preserved";
	}
	await deps.adapter.writeForceFile(
		file.path,
		source.content,
		() => {
			assertActive();
			if (hasLocalChanges()) {
				throw new ConcurrentSyncChangeError(
					"Force destination changed before copying",
				);
			}
		},
		() => deps.expectWatcherEvent?.(file.path, "upload"),
	);
	if (
		(await computeSha256(await deps.adapter.readForceFile(file.path))) !==
		source.sha256
	) {
		throw new Error("Force local write was not confirmed");
	}
	return "copied";
}

/** Retire a missing source only after a readable root and repeated absence observations. */
async function confirmForceSourceAbsent(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
	file: ForceSourceFile,
	assertActive = plan.assertConfiguration,
): Promise<boolean> {
	const state = plan.recovery;
	assertActive();
	let absent = false;
	if (state.direction === "from_local") {
		const stat = () => deps.adapter.vault.adapter.stat(file.path);
		if ((await stat())?.type !== "file") {
			await deps.adapter.vault.adapter.list("");
			absent = (await stat())?.type !== "file";
		}
	} else {
		const root = await deps.client.getResource(
			state.remotePath,
			1,
			0,
			true,
		);
		assertForceResourceIdentity(root, state.remotePath);
		if (root?.type === "dir" && root.resource_id === state.rootResourceId) {
			const sourcePath = joinPath(state.remotePath, file.rawPath);
			const stat = async () => {
				assertActive();
				const resource = await deps.client.getResource(
					sourcePath,
					1,
					0,
					true,
				);
				assertForceResourceIdentity(resource, sourcePath);
				return resource;
			};
			absent =
				(await stat())?.type !== "file" &&
				(await stat())?.type !== "file";
		}
	}
	assertActive();
	return absent;
}

/** Save a verified copy or confirmed absence before retiring the path in memory. */
async function persistForceFileOutcome(
	deps: ForceReplacementDependencies,
	state: ForceRecovery,
	file: ForceSourceFile,
	copy: VerifiedForceCopy | null,
	assertActive: () => void,
): Promise<void> {
	const direct = state.direct!;
	const verified = copy && {
		...file,
		sha256: copy.sha256,
		size: copy.size,
	};
	const source = !verified
		? state.source.filter((entry) => entry.path !== file.path)
		: verified.sha256 !== file.sha256 || verified.size !== file.size
			? state.source.map((entry) =>
					entry.path === file.path ? verified : entry,
				)
			: state.source;
	const sourceDigest =
		source === state.source
			? state.sourceDigest
			: await digestSource(source);
	const files = protectRecord({ ...state.files });
	const targetHashes = protectRecord({ ...state.targetHashes });
	if (verified && copy) {
		setRecordValue(
			files,
			file.path,
			forceFileMetadata(deps, verified, copy.resource),
		);
		if (copy.rawSha256 !== undefined) {
			setRecordValue(targetHashes, file.rawPath, copy.rawSha256);
		}
	} else {
		delete files[file.path];
		delete targetHashes[file.rawPath];
	}
	const pendingFiles = direct.pendingFiles.filter(
		(path) => path !== file.path,
	);
	assertActive();
	await deps.persist({
		...state,
		source,
		sourceDigest,
		files,
		targetHashes,
		direct: { ...direct, pendingFiles },
	});
	state.source = source;
	state.sourceDigest = sourceDigest;
	state.files = files;
	state.targetHashes = targetHashes;
	direct.pendingFiles = pendingFiles;
}

/** Preserve covered watcher boundaries and clear old history only after a confirmed final publication. */
async function finishForceReplacement(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
	assertActive: () => void,
	observed?: SyncIndex,
): Promise<void> {
	const state = plan.recovery;
	const baseline = forceIndex(deps, state, true);
	assertActive();
	deps.index.finishForceReplacement(
		observed ?? baseline,
		state.rootResourceId!,
		baseline,
	);
	deps.settings.enableEncryption = state.target.enabled;
	deps.settings.encryptionPassword = plan.password;
	deps.settings.encryptionSalt = state.target.salt;
	deps.settings.encryptionRevision = state.target.revision;
	deps.settings.encryptionProfileId = state.target.enabled
		? "hardened"
		: null;
	await deps.retireWatcherEvents?.(
		state.watcherCutoff,
		state.watcherBoundary,
	);
	assertActive();
	await deps.persist(null);
}

/** Revalidate the selected source mode before and after its final read-only scan. */
async function assertSourceEncryptionCurrent(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
): Promise<void> {
	if (plan.recovery.direction !== "from_remote") {
		if (plan.scope) {
			const current = await deps.index.downloadEncryptionManifest();
			plan.assertConfiguration();
			if (
				JSON.stringify(current) !==
				JSON.stringify(plan.destinationManifest)
			) {
				throw new Error(
					"Force destination encryption changed during preparation",
				);
			}
		}
		return;
	}
	const manifest = await deps.index.downloadEncryptionManifest();
	plan.assertConfiguration();
	const target = plan.recovery.target;
	if (
		Boolean(manifest) !== target.enabled ||
		(manifest &&
			(manifest.salt !== target.salt ||
				manifest.revision !== target.revision ||
				!plan.codec ||
				!(await encryption.verifyCandidate(
					plan.codec,
					manifest.verifier,
				))))
	) {
		throw new Error("Force source encryption changed after preparation");
	}
}

/** Attempt all independent deletes and transfers, keeping only unfinished work for ordinary sync. */
export async function applyForceReplacement(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
	choice: "with-backup" | "without-backup",
): Promise<ForceApplyResult> {
	const state = plan.recovery;
	if (!state.direct) {
		throw new Error(
			"Legacy Force requires a newly confirmed full replacement",
		);
	}
	const direct = state.direct;
	const result: ForceApplyResult = {
		uploaded: 0,
		downloaded: 0,
		deleted: 0,
		errors: [],
		completed: false,
	};
	const diagnostic = () => ({
		operationId: shortenDiagnosticValue(state.id),
		direction: state.direction,
		phase: state.phase,
		stage: direct.stage,
		pendingDeletes: direct.pendingDeletes.length,
		pendingFiles: direct.pendingFiles.length,
		pendingDirectories: direct.pendingDirectories.length,
		errors: result.errors.length,
	});
	logger.info("Direct Force applying", diagnostic());
	let failed = false;
	try {
		plan.assertConfiguration();
		deps.client.setEncryptionService(plan.codec);
		// Installing the output codec starts this invocation's connection lifetime.
		const assertActive = forceConnectionGuard(deps, plan);
		const attempt = async (
			path: string,
			operation: () => Promise<void>,
		): Promise<boolean> => {
			try {
				assertActive();
				await operation();
				return true;
			} catch (error) {
				if (error instanceof ForceConfigurationChangedError) {
					throw error;
				}
				if (isConcurrentSyncChange(error)) {
					return false;
				}
				result.errors.push(
					createSyncError(error, path, "none", "applying"),
				);
				return false;
			}
		};
		const pendingActions = () =>
			direct.pendingDeletes.length +
			direct.pendingFiles.length +
			direct.pendingDirectories.length;
		let observedFinal: SyncIndex | undefined;
		const publishFinal = async () => {
			const expected = forceIndex(deps, state, true);
			const inspect = () =>
				deps.index.readDirectForcePublication(
					state,
					expected,
					plan.codec,
					assertActive,
				);
			let completion: NonNullable<ForceRecovery["completion"]>;
			try {
				completion = await deps.index.publishDirectForceCanonical(
					expected,
					plan.codec,
					false,
					async () => {
						if (!(await inspect()).maintenance) {
							throw new ForceRecoveryPendingError(
								"The final Force publication has already advanced",
							);
						}
					},
				);
			} catch (error) {
				assertActive();
				const current = await inspect();
				if (current.maintenance) {
					throw error;
				}
				observedFinal = current;
				return;
			}
			assertActive();
			await deps.persist({ ...state, completion });
			state.completion = completion;
		};
		if (
			state.completion ||
			(direct.stage === "publishing" && !pendingActions())
		) {
			const baseline = forceIndex(deps, state, true);
			result.completed = await attempt(indexName, async () => {
				const observed = await deps.index.readDirectForcePublication(
					state,
					baseline,
					plan.codec,
					assertActive,
				);
				assertActive();
				if (observed.maintenance) {
					await deps.index.withForceScope(state, () =>
						deps.client.withWriteGuard(assertActive, publishFinal),
					);
				} else {
					observedFinal = observed;
				}
				await finishForceReplacement(
					deps,
					plan,
					assertActive,
					observedFinal,
				);
			});
			return result;
		}
		if (state.phase === "prepared") {
			await assertSourceEncryptionCurrent(deps, plan);
			await scanSource(
				deps,
				plan,
				state.direction === "from_remote" && deps.progress
					? (completed, total) =>
							deps.progress?.("validating", completed, total)
					: deps.sourceProgress,
			);
			await assertSourceEncryptionCurrent(deps, plan);
			await assertForceCanReplaceReceipt(deps, plan);
			if (choice === "with-backup") {
				const proof = state.backupProof;
				if (!proof) {
					throw new Error(
						"The selected Force archive must be created before replacement",
					);
				}
				const archive = await deps.client.downloadStableRawFile(
					joinPath(state.remotePath, ".backup", proof.name),
				);
				if (
					!archive ||
					(await computeSha256(archive.raw)) !== proof.sha256
				) {
					throw new Error(
						"The selected Force archive is missing or unreadable",
					);
				}
			}
			state.backupMode = choice;
			await deps.client.withWriteGuard(assertActive, () =>
				ensureForceRoot(deps, plan),
			);
			await prepareDeletion(deps, plan);
			assertActive();
			state.phase = "applying";
			await deps.persist(state);
			logger.info("Direct Force phase saved", diagnostic());
		}
		assertForceRecovery(state);
		deps.client.clearFolderCache();
		const apply = async (): Promise<boolean> => {
			if (!direct.canonicalReset) {
				await attempt(indexName, async () => {
					await deps.index.publishDirectForceCanonical(
						forceIndex(deps, state),
						plan.codec,
						true,
					);
					direct.canonicalReset = true;
					await deps.persist(state);
				});
			}
			await attempt(manifestName, () => publishManifest(deps, plan));
			const destination =
				state.direction === "from_local" ? "remote" : "local";
			const destinationKey = (path: string) =>
				destination === "remote" ? path : getPortablePathKey(path);
			const copyKey = (entry: { path: string; rawPath: string }) =>
				destinationKey(
					destination === "remote" ? entry.rawPath : entry.path,
				);
			const deletions = [...direct.pendingDeletes];
			for (const [position, action] of deletions.entries()) {
				deps.progress?.("cleanup", position, deletions.length);
				await attempt(action.path, async () => {
					if (
						action.location === "local" &&
						deps.hasLocalChanges?.(
							action.path,
							state.watcherBoundary ?? emptyWatcherBoundary,
						)
					) {
						const tree = await deps.adapter.getForceTree(false);
						const entries = [
							...tree.files.map((path) => ({
								path,
								kind: "file" as const,
							})),
							...tree.directories.map((path) => ({
								path,
								kind: "dir" as const,
							})),
						].filter(
							(entry) =>
								entry.path === action.path ||
								entry.path.startsWith(`${action.path}/`),
						);
						const retained = entries.filter(
							(entry) =>
								(entry.kind === "file" &&
									deps.hasLocalChanges!(
										entry.path,
										state.watcherBoundary ??
											emptyWatcherBoundary,
									)) ||
								(plan.scope &&
									!isReplacementPath(entry.path, plan.scope)),
						);
						const narrowed = planRecursiveDeletes(
							entries,
							new Set(
								entries
									.filter(
										(entry) => !retained.includes(entry),
									)
									.map((entry) => entry.path),
							),
							new Set(retained.map((entry) => entry.path)),
							(path) =>
								!deps.hasLocalChanges!(
									path,
									state.watcherBoundary ??
										emptyWatcherBoundary,
								),
						)
							.filter((entry) =>
								entry.path.startsWith(`${action.path}/`),
							)
							.map((entry) => ({
								...entry,
								location: "local" as const,
							}));
						direct.pendingDeletes = [
							...direct.pendingDeletes.filter(
								(entry) => entry !== action,
							),
							...narrowed,
						];
						deletions.push(...narrowed);
						await deps.persist(state);
						return;
					}
					const deletion = destinationKey(action.path);
					const affected = (entry: {
						path: string;
						rawPath: string;
					}) =>
						action.location === destination &&
						isPathInsideFolder(copyKey(entry), deletion);
					for (const file of state.source.filter(affected)) {
						if (!direct.pendingFiles.includes(file.path)) {
							direct.pendingFiles.push(file.path);
						}
						delete state.files[file.path];
					}
					for (const directory of direct.directories.filter(
						affected,
					)) {
						if (
							!direct.pendingDirectories.includes(directory.path)
						) {
							direct.pendingDirectories.push(directory.path);
						}
					}
					await deps.persist(state);
					if (action.location === "remote") {
						const path = joinPath(state.remotePath, action.path);
						const absent = new Error(
							"Force deletion target is already absent",
						);
						try {
							await deps.client.deleteResource(
								path,
								true,
								true,
								async () => {
									assertActive();
									const target =
										await deps.client.getResource(
											path,
											1,
											0,
											true,
										);
									assertActive();
									if (target === null) {
										throw absent;
									}
									assertForceResourceIdentity(target, path);
									if (target.type !== action.kind) {
										throw new ForceScopeConflictError();
									}
								},
							);
							if (
								(await deps.client.getResource(
									path,
									1,
									0,
									true,
								)) !== null
							) {
								throw new Error(
									"Force deletion was not confirmed",
								);
							}
						} catch (error) {
							if (error !== absent) {
								throw error;
							}
						}
						assertActive();
					} else {
						await deps.adapter.deleteForcePath(
							action.path,
							async () => () => {
								assertActive();
								if (
									deps.hasLocalChanges?.(
										action.path,
										state.watcherBoundary ??
											emptyWatcherBoundary,
									)
								) {
									throw new ConcurrentSyncChangeError(
										"Force destination changed before deletion",
									);
								}
							},
							() =>
								deps.expectWatcherEvent?.(
									action.path,
									"delete",
								),
						);
					}
					direct.pendingDeletes = direct.pendingDeletes.filter(
						(entry) => entry !== action,
					);
					result.deleted++;
					await deps.persist(state);
				});
			}
			direct.stage = "copying";
			if (await attempt("", () => deps.persist(state))) {
				logger.info("Direct Force phase saved", diagnostic());
			}
			const pendingPurge = direct.pendingDeletes
				.filter(({ location }) => location === destination)
				.map(({ path }) => destinationKey(path));
			const canCopy = (entry: { path: string; rawPath: string }) => {
				const path = copyKey(entry);
				return !pendingPurge.some(
					(deletion) =>
						isPathInsideFolder(path, deletion) ||
						isPathInsideFolder(deletion, path),
				);
			};
			for (const path of [...direct.pendingDirectories]) {
				const directory = direct.directories.find(
					(entry) => entry.path === path,
				)!;
				if (!canCopy(directory)) {
					continue;
				}
				await attempt(path, async () => {
					if (state.direction === "from_local") {
						await ensureRemoteDirectory(
							deps,
							state.remotePath,
							directory.rawPath,
							async () => plan.assertConfiguration(),
						);
					} else {
						await deps.adapter.createForceDirectory(
							path,
							assertActive,
						);
					}
					direct.pendingDirectories =
						direct.pendingDirectories.filter(
							(pending) => pending !== path,
						);
					await deps.persist(state);
				});
			}
			const source = new Map(
				state.source.map((file) => [file.path, file]),
			);
			const pending = direct.pendingFiles
				.map((path) => source.get(path)!)
				.filter(canCopy);
			if (state.direction === "from_remote") {
				let completed = 0;
				deps.progress?.("applying", completed, pending.length);
				for await (const reads of readRemoteForceWindows(
					deps,
					plan,
					pending,
					assertActive,
				)) {
					for (const { file, read } of reads) {
						await attempt(file.path, async () => {
							if (read.status === "rejected") {
								if (
									!(
										read.reason instanceof
										ForceSourceMissingError
									) ||
									!(await confirmForceSourceAbsent(
										deps,
										plan,
										file,
										assertActive,
									))
								) {
									throw read.reason;
								}
								await persistForceFileOutcome(
									deps,
									state,
									file,
									null,
									assertActive,
								);
								return;
							}
							const disposition = await writeRemoteForceFile(
								deps,
								plan,
								file,
								read.value,
								assertActive,
							);
							await persistForceFileOutcome(
								deps,
								state,
								file,
								{
									sha256: read.value.sha256,
									size: read.value.content.byteLength,
									resource: read.value.resource,
								},
								assertActive,
							);
							if (disposition === "copied") {
								result.downloaded++;
							}
						});
						deps.progress?.(
							"applying",
							++completed,
							pending.length,
						);
					}
				}
			} else {
				for (const [position, file] of pending.entries()) {
					deps.progress?.("applying", position, pending.length);
					await attempt(file.path, async () => {
						let copy: VerifiedForceCopy | null = null;
						try {
							copy = await uploadForceFile(deps, plan, file);
						} catch (error) {
							if (
								!(error instanceof ForceSourceMissingError) ||
								!(await confirmForceSourceAbsent(
									deps,
									plan,
									file,
									assertActive,
								))
							) {
								throw error;
							}
						}
						await persistForceFileOutcome(
							deps,
							state,
							file,
							copy,
							assertActive,
						);
						if (copy) {
							result.uploaded++;
						}
					});
				}
			}
			assertActive();
			deps.progress?.("saving-index", 0, 1);
			if (
				pendingActions() ||
				result.errors.length ||
				!direct.canonicalReset
			) {
				await attempt(indexName, async () => {
					await deps.index.publishDirectForceCanonical(
						forceIndex(deps, state),
						plan.codec,
					);
				});
				return false;
			}
			if (
				!(await attempt(manifestName, () =>
					publishManifest(deps, plan),
				))
			) {
				return false;
			}
			return attempt(indexName, async () => {
				const publishing = {
					...state,
					phase: "cleanup" as const,
					direct: { ...direct, stage: "publishing" as const },
				};
				await deps.persist(publishing);
				state.phase = publishing.phase;
				direct.stage = publishing.direct.stage;
				logger.info("Direct Force phase saved", diagnostic());
				assertActive();
				await publishFinal();
			});
		};
		await deps.index.withForceScope(state, async () => {
			const committed = await deps.client.withWriteGuard(
				assertActive,
				apply,
			);
			if (committed) {
				result.completed = await attempt("", () =>
					finishForceReplacement(
						deps,
						plan,
						assertActive,
						observedFinal,
					),
				);
			}
		});
		return result;
	} catch (error) {
		failed = true;
		if (
			state.phase !== "prepared" &&
			error instanceof ForceConfigurationChangedError
		) {
			result.completed = false;
			result.errors.push(createSyncError(error, "", "none", "applying"));
			return result;
		}
		throw error;
	} finally {
		const outcome =
			failed || result.errors.length
				? "error"
				: result.completed
					? "completed"
					: "deferred";
		logger.info("Direct Force outcome", { ...diagnostic(), outcome });
	}
}

/** Authenticate a completed replacement before rebinding an existing device to a recreated root. */
export async function prepareForceEpochConnection(
	deps: ForceReplacementDependencies,
): Promise<{
	epoch: string;
	snapshot: import("../../crypto/encryption-transition").LocalEncryptionSnapshot;
}> {
	const manifest = await deps.index.downloadEncryptionManifest();
	let codec: EncryptionCodec | null = null;
	let password: string | null = null;
	if (manifest) {
		if (manifest.state !== "enabled" || manifest.transition) {
			throw new Error("Replacement encryption maintenance is unfinished");
		}
		password = deps.settings.encryptionPassword;
		if (password) {
			codec = await encryption.createCodec(
				"hardened",
				manifest.salt,
				password,
			);
		}
		if (
			!codec ||
			!(await encryption.verifyCandidate(codec, manifest.verifier))
		) {
			password = await deps.password(false);
			if (!password) {
				throw new Error("Replacement connection was cancelled");
			}
			codec = await encryption.createCodec(
				"hardened",
				manifest.salt,
				password,
			);
			if (!(await encryption.verifyCandidate(codec, manifest.verifier))) {
				throw new Error("Wrong replacement encryption password");
			}
		}
	}
	const canonical =
		await deps.index.readCanonicalIndexWithCodecIfPresent(codec);
	if (
		!canonical ||
		canonical.maintenance ||
		canonical.epoch === deps.index.getObservedEpoch()
	) {
		throw new Error(
			"The recreated root has no completed replacement generation",
		);
	}
	return {
		epoch: canonical.epoch,
		snapshot: {
			enabled: !!manifest,
			salt: manifest?.salt ?? null,
			password,
			revision: manifest?.revision ?? null,
			profileId: manifest ? "hardened" : null,
		},
	};
}
