import { planRecursiveDeletes } from "../files/deletion-cover";
import {
	assertForceRecovery,
	ForceSourceFormatError,
	ForceScopeConflictError,
	type ForceDirection,
	type ForceRecovery,
	type ForceSourceFile,
} from "./force-state";
import type { VaultAdapter } from "../../api/vault-adapter";
import type { YandexDiskClient } from "../../api/yandex-client";
import type { EncryptionCodec } from "../../crypto/encryption";
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
	type RecursiveDeleteAction,
	type SyncIndex,
	type SyncPhase,
	type SyncResult,
	type YandexDiskSyncSettings,
} from "../../types";
import { computeSha256, computeSha256FromString } from "../../utils/hash-utils";
import {
	assertForcePath,
	containsForceLocalPreservedPath,
	getDirectory,
	hasPortablePathCollision,
	isForceSourcePath,
	joinPath,
	mayBeEncryptedPath,
	preservesForceLocalPath,
	shouldInspectRawSyncDirectory,
	shouldInspectRawSyncPath,
	shouldTraverseSyncDirectory,
	toLocalPath,
} from "../../utils/path-utils";
import { createSafeRecord, setRecordValue } from "../../utils/record-utils";
import { getPhysicalResourceFingerprint } from "../../utils/resource-fingerprint";
import type { IndexManager } from "../canonical/manager";
import { createSyncError } from "../errors";

export interface ForceReplacementDependencies {
	client: YandexDiskClient;
	adapter: VaultAdapter;
	index: IndexManager;
	settings: YandexDiskSyncSettings;
	persist(state: ForceRecovery | null): Promise<void>;
	password(create: boolean, invalid?: boolean): Promise<string | null>;
	sourceProgress?(completed: number, total: number): void;
	isCancelled?(): boolean;
	watcherCutoff?(): string[];
	retireWatcherEvents?(cutoff: string[]): Promise<void>;
	expectWatcherEvent?(path: string, action: "upload" | "delete"): void;
	getRecovery?(): ForceRecovery | null;
	progress?(phase: SyncPhase, completed: number, total: number): void;
}
export type ForceReplacementPorts = Pick<
	ForceReplacementDependencies,
	| "persist"
	| "password"
	| "isCancelled"
	| "watcherCutoff"
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
	assertConfiguration(): Promise<void>;
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

/** Allocate a replacement generation only after its destructive confirmation. */
export function confirmForceReplacementPlan(
	plan: PreparedForceReplacement,
): void {
	plan.recovery.id ||= createSyncEpoch();
	plan.recovery.epoch ||= createSyncEpoch();
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
): Promise<ArrayBuffer> {
	if (!codec) {
		return raw;
	}
	try {
		return await codec.decrypt(raw);
	} catch {
		throw new ForceSourceFormatError();
	}
}

/** Prove every selected source is readable before any destination deletion. */
async function scanSource(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
): Promise<void> {
	const state = plan.recovery;
	const direct = state.direct!;
	const source: ForceSourceFile[] = [];
	const directories: { path: string; rawPath: string }[] = [];
	await plan.assertConfiguration();
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
		deps.sourceProgress?.(0, total);
		for (const path of tree.directories) {
			await plan.assertConfiguration();
			if (plan.scope && !isReplacementPath(path, plan.scope)) {
				deps.sourceProgress?.(++completed, total);
				continue;
			}
			directories.push({
				path,
				rawPath: await physicalPath(path, plan.codec),
			});
			deps.sourceProgress?.(++completed, total);
		}
		for (const path of tree.files) {
			await plan.assertConfiguration();
			const content = await deps.adapter.readForceFile(path);
			await plan.assertConfiguration();
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
			deps.sourceProgress?.(++completed, total);
		}
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
		deps.sourceProgress?.(0, resources.length);
		const excluded = new Set<string>();
		for (const resource of resources) {
			await plan.assertConfiguration();
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
				deps.sourceProgress?.(++completed, resources.length);
				continue;
			}
			const path = await logicalPath(rawPath, plan.codec);
			if (
				!isForceSourcePath(path, direct.configDir) ||
				(plan.scope &&
					(resource.type === "dir"
						? !traverse(path, plan.scope)
						: !isReplacementPath(path, plan.scope)))
			) {
				if (resource.type === "dir") {
					excluded.add(rawPath);
				}
				deps.sourceProgress?.(++completed, resources.length);
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
				deps.sourceProgress?.(++completed, resources.length);
				continue;
			}
			await plan.assertConfiguration();
			const snapshot = await deps.client.downloadStableRawFile(
				joinPath(state.remotePath, rawPath),
			);
			await plan.assertConfiguration();
			if (!snapshot) {
				throw new Error("Force remote source became unavailable");
			}
			const content = await decodeSourceContent(snapshot.raw, plan.codec);
			source.push({
				path,
				rawPath,
				sha256: await computeSha256(content),
				size: content.byteLength,
				mtime: Date.parse(snapshot.resource.modified),
				fingerprint: snapshot.fingerprint,
			});
			deps.sourceProgress?.(++completed, resources.length);
		}
	}
	source.sort((a, b) => a.path.localeCompare(b.path));
	if (
		hasPortablePathCollision(
			source.map((file) => file.path),
			directories.map((folder) => folder.path),
		)
	) {
		throw new Error("Force source has ambiguous portable paths");
	}
	await plan.assertConfiguration();
	state.source = source;
	state.sourceDigest = await digestSource(source);
	direct.directories = directories.sort((a, b) =>
		a.path.localeCompare(b.path),
	);
	direct.pendingFiles = source.map((file) => file.path);
	direct.pendingDirectories = directories.map((folder) => folder.path);
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
		},
	};
	const plan: PreparedForceReplacement = {
		recovery,
		codec,
		password: codec ? password : null,
		scope,
		destinationCodec,
		destinationManifest,
		assertConfiguration: async () => {
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
				throw new Error("Force connection changed or plugin unloaded");
			}
		},
	};
	await scanSource(deps, plan);
	await prepareDeletion(deps, plan);
	return plan;
}

/** Resume direct progress only; old scoped checkpoints require a new explicit replacement. */
export async function resumeForceReplacement(
	deps: ForceReplacementDependencies,
	recovery: ForceRecovery,
): Promise<PreparedForceReplacement> {
	assertForceRecovery(recovery);
	if (!recovery.direct) {
		throw new Error(
			"Legacy Force recovery requires a new full replacement confirmation",
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
	const token = deps.settings.yandexTokenSecret;
	return {
		recovery,
		codec,
		password: recovery.password,
		assertConfiguration: async () => {
			if (
				deps.isCancelled?.() ||
				deps.settings.remotePath !== recovery.remotePath ||
				deps.settings.yandexTokenSecret !== token ||
				deps.adapter.vault.configDir !== recovery.direct!.configDir
			) {
				throw new Error(
					"Force recovery connection changed or plugin unloaded",
				);
			}
		},
	};
}

/** Create a missing root without using old baseline identity as admission authority. */
export async function ensureForceRoot(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
): Promise<void> {
	await plan.assertConfiguration();
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
	index.revision = final ? 3 : 1;
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
	}
	const removable = new Set<string>();
	const collapsible = new Set<string>();
	const logicalEntries = new Map<string, RecursiveDeleteAction>();
	for (const entry of [...entries].sort((a, b) =>
		a.path.localeCompare(b.path),
	)) {
		await plan.assertConfiguration();
		if (isPreservedRawPath(entry.path, [...preserved])) {
			continue;
		}
		const path = await logicalPath(entry.path, codec);
		logicalEntries.set(path, entry);
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
		...state.source.map((file) => ({ ...file, kind: "file" })),
		...state.direct!.directories.map((folder) => ({
			...folder,
			kind: "dir",
		})),
	]) {
		const targetPath = local ? file.path : file.rawPath;
		if (
			[...preserved].some(
				(path) =>
					targetPath === path ||
					targetPath.startsWith(`${path}/`) ||
					(file.kind === "file" && path.startsWith(`${targetPath}/`)),
			)
		) {
			throw new ForceScopeConflictError();
		}
		const target = logicalEntries.get(file.path);
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
			new Set([".backup", indexName, manifestName]),
		).map((entry) => ({ ...entry, location: "remote" }));
	} else {
		const tree = await deps.adapter.getForceTree(false);
		const directories = tree.directories.filter(
			(path) => !containsForceLocalPreservedPath(path, direct.configDir),
		);
		const top = directories.filter(
			(path) =>
				!directories.some((parent) => path.startsWith(parent + "/")),
		);
		direct.pendingDeletes = [
			...top.map((path) => ({
				path,
				location: "local" as const,
				kind: "dir" as const,
			})),
			...tree.files
				.filter(
					(path) =>
						!top.some((parent) => path.startsWith(parent + "/")),
				)
				.map((path) => ({
					path,
					location: "local" as const,
					kind: "file" as const,
				})),
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
): Promise<Awaited<ReturnType<YandexDiskClient["getResource"]>>> {
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

/** Transfer one file directly and record only the bytes that actually reached its destination. */
async function transferFile(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
	file: ForceSourceFile,
): Promise<void> {
	const state = plan.recovery;
	let content: ArrayBuffer;
	let resource: Awaited<ReturnType<YandexDiskClient["getResource"]>>;
	if (state.direction === "from_local") {
		content = await deps.adapter.readForceFile(file.path);
		const raw = plan.codec ? await plan.codec.encrypt(content) : content;
		const path = joinPath(state.remotePath, file.rawPath);
		const parent = getDirectory(file.rawPath);
		if (parent) {
			await ensureRemoteDirectory(deps, state.remotePath, parent, () =>
				plan.assertConfiguration(),
			);
		}
		if ((await deps.client.getResource(path, 1, 0, true))?.type === "dir") {
			throw new ForceScopeConflictError();
		}
		let uploadError: unknown;
		try {
			await deps.client.uploadFile(path, raw, true, true, true, () =>
				plan.assertConfiguration(),
			);
		} catch (error) {
			uploadError = error;
		}
		try {
			resource = await verifyUpload(deps, path, raw);
		} catch (error) {
			throw uploadError instanceof Error ? uploadError : error;
		}
		setRecordValue(
			state.targetHashes,
			file.rawPath,
			await computeSha256(raw),
		);
	} else {
		const source = await deps.client.downloadStableRawFile(
			joinPath(state.remotePath, file.rawPath),
		);
		if (!source) {
			throw new Error("Force remote source is no longer readable");
		}
		content = await decodeSourceContent(source.raw, plan.codec);
		resource = source.resource;
		deps.expectWatcherEvent?.(file.path, "upload");
		await deps.adapter.writeForceFile(file.path, content, () =>
			plan.assertConfiguration(),
		);
		if (
			(await computeSha256(
				await deps.adapter.readForceFile(file.path),
			)) !== (await computeSha256(content))
		) {
			throw new Error("Force local write was not confirmed");
		}
	}
	file.sha256 = await computeSha256(content);
	file.size = content.byteLength;
	state.sourceDigest = await digestSource(state.source);
	setRecordValue(state.files, file.path, {
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
	});
}

/** Preserve covered watcher boundaries and clear old history only after a confirmed final publication. */
async function finishForceReplacement(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
): Promise<void> {
	const state = plan.recovery;
	const canonical = forceIndex(deps, state, true);
	canonical.revision = state.completion!.revision;
	deps.index.finishForceReplacement(canonical, state.rootResourceId!);
	deps.settings.enableEncryption = state.target.enabled;
	deps.settings.encryptionPassword = plan.password;
	deps.settings.encryptionSalt = state.target.salt;
	deps.settings.encryptionRevision = state.target.revision;
	deps.settings.encryptionProfileId = state.target.enabled
		? "hardened"
		: null;
	await deps.retireWatcherEvents?.(state.watcherCutoff);
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
			await plan.assertConfiguration();
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
	await plan.assertConfiguration();
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
	const attempt = async (
		path: string,
		operation: () => Promise<void>,
	): Promise<boolean> => {
		try {
			await plan.assertConfiguration();
			await operation();
			return true;
		} catch (error) {
			result.errors.push(
				createSyncError(error, path, "none", "applying"),
			);
			return false;
		}
	};
	await plan.assertConfiguration();
	deps.client.setEncryptionService(plan.codec);
	if (state.completion) {
		await finishForceReplacement(deps, plan);
		result.completed = true;
		return result;
	}
	if (state.phase === "prepared") {
		await assertSourceEncryptionCurrent(deps, plan);
		await scanSource(deps, plan);
		await assertSourceEncryptionCurrent(deps, plan);
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
		await ensureForceRoot(deps, plan);
		await prepareDeletion(deps, plan);
		state.phase = "applying";
		await deps.persist(state);
	}
	assertForceRecovery(state);
	deps.client.clearFolderCache();
	await deps.index.withForceScope(state, async () => {
		deps.client.setEncryptionService(plan.codec);
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
		const deletions = [...direct.pendingDeletes];
		for (const [position, action] of deletions.entries()) {
			deps.progress?.("cleanup", position, deletions.length);
			await attempt(action.path, async () => {
				const affected = state.source.filter(
					(file) =>
						(action.location === "local"
							? file.path
							: file.rawPath) === action.path ||
						(action.location === "local"
							? file.path
							: file.rawPath
						).startsWith(action.path + "/"),
				);
				for (const file of affected) {
					if (!direct.pendingFiles.includes(file.path)) {
						direct.pendingFiles.push(file.path);
					}
					delete state.files[file.path];
				}
				for (const directory of direct.directories) {
					const path =
						action.location === "local"
							? directory.path
							: directory.rawPath;
					if (
						(path === action.path ||
							path.startsWith(action.path + "/")) &&
						!direct.pendingDirectories.includes(directory.path)
					) {
						direct.pendingDirectories.push(directory.path);
					}
				}
				await deps.persist(state);
				if (action.location === "remote") {
					const path = joinPath(state.remotePath, action.path);
					await deps.client.deleteResource(path, true, true, () =>
						plan.assertConfiguration(),
					);
					if (await deps.client.getResource(path, 1, 0, true)) {
						throw new Error("Force deletion was not confirmed");
					}
				} else {
					deps.expectWatcherEvent?.(action.path, "delete");
					await deps.adapter.deleteForcePath(action.path, () =>
						plan.assertConfiguration(),
					);
					if (await deps.adapter.vault.adapter.exists(action.path)) {
						throw new Error(
							"Force local deletion was not confirmed",
						);
					}
				}
				direct.pendingDeletes = direct.pendingDeletes.filter(
					(entry) => entry !== action,
				);
				result.deleted++;
				await deps.persist(state);
			});
		}
		direct.stage = "copying";
		await attempt("", () => deps.persist(state));
		for (const path of [...direct.pendingDirectories]) {
			await attempt(path, async () => {
				const directory = direct.directories.find(
					(entry) => entry.path === path,
				)!;
				if (state.direction === "from_local") {
					await ensureRemoteDirectory(
						deps,
						state.remotePath,
						directory.rawPath,
						() => plan.assertConfiguration(),
					);
				} else {
					await deps.adapter.createForceDirectory(path, () =>
						plan.assertConfiguration(),
					);
				}
				direct.pendingDirectories = direct.pendingDirectories.filter(
					(pending) => pending !== path,
				);
				await deps.persist(state);
			});
		}
		const pending = [...direct.pendingFiles];
		for (const [position, path] of pending.entries()) {
			deps.progress?.("applying", position, pending.length);
			await attempt(path, async () => {
				const file = state.source.find((entry) => entry.path === path)!;
				await transferFile(deps, plan, file);
				direct.pendingFiles = direct.pendingFiles.filter(
					(pendingPath) => pendingPath !== path,
				);
				if (state.direction === "from_local") {
					result.uploaded++;
				} else {
					result.downloaded++;
				}
				await deps.persist(state);
			});
		}
		direct.stage = "publishing";
		state.phase = "cleanup";
		await attempt("", () => deps.persist(state));
		const pendingWork =
			direct.pendingDeletes.length +
			direct.pendingFiles.length +
			direct.pendingDirectories.length;
		deps.progress?.("saving-index", 0, 1);
		if (pendingWork || result.errors.length) {
			await attempt(indexName, async () => {
				await deps.index.publishDirectForceCanonical(
					forceIndex(deps, state),
					plan.codec,
				);
			});
			return;
		}
		const manifestReady = await attempt(manifestName, () =>
			publishManifest(deps, plan),
		);
		if (!manifestReady) {
			return;
		}
		const committed = await attempt(indexName, async () => {
			state.completion = await deps.index.publishDirectForceCanonical(
				forceIndex(deps, state, true),
				plan.codec,
			);
			await deps.persist(state);
		});
		if (!committed) {
			return;
		}
		const finished = await attempt("", () =>
			finishForceReplacement(deps, plan),
		);
		result.completed = finished;
	});
	return result;
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
