import { assertForceRecovery } from "./force-state";
import type { VaultAdapter } from "../../api/vault-adapter";
import { YandexApiError } from "../../api/yandex-client";
import type { YandexDiskClient } from "../../api/yandex-client";
import { type EncryptionCodec } from "../../crypto/encryption";
import { EncryptionManager } from "../../crypto/encryption-manager";
import { assertSafeTransitionPath } from "../../crypto/encryption-transition";
import {
	createEmptyIndex,
	createSyncEpoch,
	type EncryptionManifest,
	type SyncIndex,
	type YandexDiskSyncSettings,
	type YandexResource,
} from "../../types";
import { computeSha256, computeSha256FromString } from "../../utils/hash-utils";
import {
	hasPortablePathCollision,
	isProtectedPath,
	joinPath,
	shouldSyncFile,
	toLocalPath,
} from "../../utils/path-utils";
import { createSafeRecord, setRecordValue } from "../../utils/record-utils";
import {
	getPhysicalResourceFingerprint,
	getStableContentFingerprint,
	matchesStableContentFingerprint,
} from "../../utils/resource-fingerprint";
import { ForceSourceChangedError } from "../canonical/errors";
import { type IndexManager } from "../canonical/manager";
import type {
	ForceDirection,
	ForceRecovery,
	ForceSourceFile,
} from "./force-state";

export interface ForceReplacementDependencies {
	client: YandexDiskClient;
	adapter: VaultAdapter;
	index: IndexManager;
	settings: YandexDiskSyncSettings;
	persist(state: ForceRecovery | null): Promise<void>;
	password(create: boolean): Promise<string | null>;
	isCancelled?(): boolean;
	chooseSourceMode?(): Promise<"plaintext" | "encrypted" | null>;
	watcherCutoff?(): string[];
	retireWatcherEvents?(cutoff: string[]): Promise<void>;
	expectWatcherEvent?(path: string, action: "upload" | "delete"): void;
}
/** Plugin-owned callbacks; engine supplies its existing stable services and live settings. */
export type ForceReplacementPorts = Pick<
	ForceReplacementDependencies,
	| "persist"
	| "password"
	| "isCancelled"
	| "chooseSourceMode"
	| "watcherCutoff"
	| "retireWatcherEvents"
>;
export interface PreparedForceReplacement {
	recovery: ForceRecovery;
	codec: EncryptionCodec | null;
	password: string | null;
	assertConfiguration(): Promise<void>;
}
/** Allocate replacement authority only after the destructive choice was confirmed. */
export function confirmForceReplacementPlan(
	plan: PreparedForceReplacement,
): void {
	plan.recovery.id ||= createSyncEpoch();
	plan.recovery.epoch ||= createSyncEpoch();
}

const encryption = new EncryptionManager();
const manifestName = ".obsidian-encrypt.json";
class ForceDestinationChangedError extends Error {}

/** Capture readable source bytes and a target codec without consulting destination history. */
export async function prepareForceReplacement(
	deps: ForceReplacementDependencies,
	direction: ForceDirection,
	deferIdentity = false,
): Promise<PreparedForceReplacement | null> {
	const remotePath = deps.settings.remotePath;
	const token = deps.settings.yandexTokenSecret;
	const root = await deps.client.getResource(remotePath, 1, 0, true);
	if (root && root.type !== "dir") {
		throw new Error("Force storage root is not a folder");
	}
	const resources = await rawFiles(deps);
	let codec: EncryptionCodec | null = null;
	let password = deps.settings.encryptionPassword;
	let manifest: EncryptionManifest | null = null;
	const source: ForceSourceFile[] = [];
	if (direction === "from_local") {
		for (const [path, meta] of await deps.adapter.getAllFileMetadata(
			true,
		)) {
			source.push({
				path,
				sha256: meta.sha256,
				size: meta.size,
				mtime: meta.mtime,
				rawPath: path,
				fingerprint: null,
			});
		}
		if (deps.settings.enableEncryption) {
			password ||= await deps.password(true);
			if (!password) {
				return null;
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
	} else {
		const userResources = resources.filter(
			(resource) =>
				!isProtectedPath(toLocalPath(resource.path, remotePath)) &&
				deps.adapter.shouldInspectRaw(
					toLocalPath(resource.path, remotePath),
					true,
				),
		);
		// An empty readable source needs no historical manifest or password.
		if (userResources.length === 0) {
			if (deps.settings.enableEncryption) {
				password ||= await deps.password(true);
				if (!password) {
					return null;
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
		} else {
			manifest = await deps.index.downloadEncryptionManifest();
			let encrypted = manifest !== null;
			if (!manifest) {
				const choice = await deps.chooseSourceMode?.();
				if (choice === null) {
					return null;
				}
				if (choice === undefined) {
					throw new Error(
						"Force source mode is ambiguous without a manifest; choose plaintext or encrypted reading",
					);
				}
				encrypted = choice === "encrypted";
			}
			if (encrypted) {
				const salt = manifest?.salt ?? deps.settings.encryptionSalt;
				const profile =
					manifest?.profileId ?? deps.settings.encryptionProfileId;
				if (!salt || profile !== "hardened") {
					throw new Error(
						"Encrypted Force source has lost its salt/profile; a password alone cannot restore the codec",
					);
				}
				password ||= await deps.password(false);
				if (!password) {
					return null;
				}
				codec = await encryption.createCodec(
					"hardened",
					salt,
					password,
				);
				if (
					manifest &&
					!(await encryption.verifyCandidate(
						codec,
						manifest.verifier,
					))
				) {
					password = await deps.password(false);
					if (!password) {
						return null;
					}
					codec = await encryption.createCodec(
						"hardened",
						salt,
						password,
					);
					if (
						!(await encryption.verifyCandidate(
							codec,
							manifest.verifier,
						))
					) {
						throw new Error(
							"Wrong encryption password for Force source",
						);
					}
				}
				manifest = await encryption.createManifest({
					service: codec,
					salt,
					revision:
						manifest?.revision ??
						deps.settings.encryptionRevision ??
						1,
					state: "enabled",
					deviceId: deps.settings.deviceId,
				});
			}
			for (const resource of userResources) {
				const rawPath = toLocalPath(resource.path, remotePath);
				if (!deps.adapter.shouldInspectRaw(rawPath, !!codec)) {
					continue;
				}
				const path = codec
					? (
							await Promise.all(
								rawPath
									.split("/")
									.map((segment) =>
										codec!.decryptFilename(segment),
									),
							)
						).join("/")
					: rawPath;
				assertSafeTransitionPath(path, "Force source");
				if (!deps.adapter.shouldSync(path)) {
					continue;
				}
				const snapshot = await deps.client.downloadStableRawFile(
					joinPath(remotePath, rawPath),
				);
				if (
					!snapshot ||
					!matchesStableContentFingerprint(
						getStableContentFingerprint(resource),
						snapshot.resource,
					)
				) {
					throw new ForceSourceChangedError();
				}
				const content = codec
					? await codec.decrypt(snapshot.raw)
					: snapshot.raw;
				source.push({
					path,
					rawPath,
					sha256: await computeSha256(content),
					size: content.byteLength,
					mtime: Date.parse(resource.modified),
					fingerprint: snapshot.fingerprint,
				});
			}
		}
	}
	if (direction === "from_local") {
		await remoteDestinationFiles(deps, resources, codec);
	}
	source.sort((left, right) => left.path.localeCompare(right.path));
	if (hasPortablePathCollision(source.map((file) => file.path))) {
		throw new Error("Force source has ambiguous portable paths");
	}
	const rootResourceId = root?.resource_id ?? null;
	if (root && !rootResourceId) {
		throw new Error("Force storage has no stable folder identity");
	}
	const mode = manifest
		? {
				enabled: true,
				salt: manifest.salt,
				verifier: manifest.verifier,
				revision: manifest.revision,
			}
		: { enabled: false, salt: null, verifier: null, revision: null };
	const canonicalResource = await deps.client.getResource(
		joinPath(remotePath, ".obsidian-sync-index.json"),
		1,
		0,
		true,
	);
	const recovery: ForceRecovery = {
		completion: null,
		password: codec ? password : null,
		id: deferIdentity ? "" : createSyncEpoch(),
		direction,
		phase: "prepared",
		backupMode: "without-backup",
		backupProof: null,
		epoch: deferIdentity ? "" : createSyncEpoch(),
		remotePath,
		rootResourceId,
		originalCanonicalFingerprint:
			getStableContentFingerprint(canonicalResource),
		serviceCleanup: resources
			.filter(
				(resource) =>
					toLocalPath(resource.path, remotePath).startsWith(
						".obsidian-sync-index.lock.",
					) && !toLocalPath(resource.path, remotePath).includes("/"),
			)
			.map((resource) => ({
				path: toLocalPath(resource.path, remotePath),
				expectedFingerprint: getStableContentFingerprint(resource)!,
			})),
		sourceDigest: await digestSource(source),
		source,
		target: mode,
		manifest: manifest
			? (JSON.parse(JSON.stringify(manifest)) as EncryptionManifest)
			: null,
		watcherCutoff: deps.watcherCutoff?.() ?? [],
		cleanup: [],
		targetHashes: createSafeRecord(),
		files: createSafeRecord(),
	};
	const assertConfiguration = async () => {
		if (
			deps.isCancelled?.() ||
			deps.settings.remotePath !== remotePath ||
			deps.settings.yandexTokenSecret !== token
		) {
			throw new Error("Force storage configuration changed");
		}
		const actual = await deps.client.getResource(remotePath, 1, 0, true);
		if ((actual?.resource_id ?? null) !== recovery.rootResourceId) {
			throw new Error("Force storage folder identity changed");
		}
	};
	const plan = {
		recovery,
		codec,
		password: codec ? password : null,
		assertConfiguration,
	};
	await assertSource(deps, plan);
	await assertConfiguration();
	return plan;
}

/** Rebuild a prepared plan from a coherent local checkpoint, keeping its operation ID and epoch. */
export async function resumeForceReplacement(
	deps: ForceReplacementDependencies,
	recovery: ForceRecovery,
): Promise<PreparedForceReplacement> {
	if (recovery.remotePath !== deps.settings.remotePath) {
		throw new Error("Force recovery belongs to another storage");
	}
	const currentManifest = recovery.completion
		? await deps.index.downloadEncryptionManifest()
		: null;
	const modeChanged =
		recovery.completion !== null &&
		(currentManifest
			? currentManifest.salt !== recovery.target.salt ||
				currentManifest.revision !== recovery.target.revision
			: recovery.target.enabled) &&
		(currentManifest
			? deps.settings.enableEncryption &&
				deps.settings.encryptionSalt === currentManifest.salt &&
				deps.settings.encryptionRevision === currentManifest.revision
			: !deps.settings.enableEncryption);
	const enabled = modeChanged
		? deps.settings.enableEncryption
		: recovery.target.enabled;
	const salt = modeChanged
		? deps.settings.encryptionSalt
		: recovery.target.salt;
	const password = enabled
		? modeChanged
			? deps.settings.encryptionPassword
			: recovery.password
		: null;
	if (enabled && (!password || !salt)) {
		throw new Error(
			"Force recovery requires the stored encryption password and salt",
		);
	}
	const codec = password
		? await encryption.createCodec("hardened", salt!, password)
		: null;
	if (
		codec &&
		!modeChanged &&
		!(await encryption.verifyCandidate(codec, recovery.target.verifier!))
	) {
		throw new Error("Force recovery password does not match target");
	}
	const token = deps.settings.yandexTokenSecret;
	if ((await digestSource(recovery.source)) !== recovery.sourceDigest) {
		throw new Error("Force recovery source digest is invalid");
	}
	return {
		recovery,
		codec,
		password,
		assertConfiguration: async () => {
			const root = await deps.client.getResource(
				recovery.remotePath,
				1,
				0,
				true,
			);
			if (
				deps.isCancelled?.() ||
				token !== deps.settings.yandexTokenSecret ||
				deps.settings.remotePath !== recovery.remotePath ||
				(root?.resource_id ?? null) !== recovery.rootResourceId
			) {
				throw new Error("Force recovery storage identity changed");
			}
		},
	};
}

/** Create only the missing destination directory after confirmation, before an optional archive. */
export async function ensureForceRoot(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
): Promise<void> {
	await plan.assertConfiguration();
	const state = plan.recovery;
	if (state.rootResourceId) {
		return;
	}
	await deps.index.withForceScope(state, async () => {
		await deps.client.createFolderRecursive(state.remotePath);
		const root = await deps.client.getResource(
			state.remotePath,
			1,
			0,
			true,
		);
		if (!root?.resource_id) {
			throw new Error("Force root creation could not be verified");
		}
		state.rootResourceId = root.resource_id;
	});
}

/** Apply one durable replacement; retries converge against the same source and epoch. */
export async function applyForceReplacement(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
	choice: "with-backup" | "without-backup",
): Promise<void> {
	const state = plan.recovery;
	assertForceRecovery(state);
	deps.client.clearFolderCache();
	await plan.assertConfiguration();
	const beforeCommit = async () => {
		await plan.assertConfiguration();
		await assertSource(deps, plan);
	};
	if (!state.rootResourceId) {
		await assertSource(deps, plan);
		await ensureForceRoot(deps, plan);
	}
	await deps.index.withForceScope(state, async () => {
		deps.client.setEncryptionService(plan.codec);
		if (state.phase !== "prepared") {
			const committed = await deps.index.recoverForcePublication(
				state,
				plan.codec,
				beforeCommit,
			);
			if (committed && !committed.maintenance) {
				await deps.persist(state);
				if (committed.revision === state.completion?.revision) {
					await verifyPublishedManifest(deps, state);
				}
				await deps.index.cleanupForceServiceLocks(
					state,
					plan.codec,
					true,
				);
				await deps.index.assertForceCleanupComplete();
				await finishForceReplacement(deps, plan, committed);
				return;
			}
		}
		if (choice !== state.backupMode && state.phase !== "prepared") {
			throw new Error(
				"Force continuation must preserve its backup choice",
			);
		}
		if (choice === "with-backup") {
			const proof = state.backupProof;
			if (!proof) {
				throw new Error("Force requires its selected archive proof");
			}
			const backup = await deps.client.downloadStableRawFile(
				joinPath(state.remotePath, ".backup", proof.name),
			);
			if (!backup || (await computeSha256(backup.raw)) !== proof.sha256) {
				throw new Error("Force archive proof changed or is missing");
			}
		}
		await assertSource(deps, plan);
		if (state.direction === "from_local" && state.phase === "prepared") {
			await remoteDestinationFiles(
				deps,
				await rawFiles(deps),
				plan.codec,
			);
		}
		state.backupMode = choice;
		state.watcherCutoff = [
			...new Set([
				...state.watcherCutoff,
				...(deps.watcherCutoff?.() ?? []),
			]),
		];
		await deps.persist(state);
		if (state.phase === "prepared") {
			const existing = await deps.index.recoverForcePublication(
				state,
				plan.codec,
				beforeCommit,
			);
			if (!existing) {
				await deps.index.publishForceCanonical(
					forceIndex(deps, state),
					plan.codec,
					true,
				);
			}
			state.phase = "applying";
			await deps.persist(state);
		}
		const authority = async () => {
			await plan.assertConfiguration();
			await deps.index.assertForceAuthority(
				state.id,
				state.epoch,
				plan.codec,
			);
		};
		await deps.index.cleanupForceServiceLocks(state, plan.codec);
		for (let attempt = 0; attempt < 3; attempt++) {
			await authority();
			await assertSource(deps, plan);
			try {
				if (state.direction === "from_local") {
					await replaceRemote(deps, plan, authority);
				} else {
					await replaceLocal(deps, plan, authority);
				}
			} catch (error) {
				if (error instanceof ForceDestinationChangedError) {
					deps.client.clearFolderCache();
					continue;
				}
				throw error;
			}
			await assertSource(deps, plan);
			if (!(await verifyDestination(deps, plan))) {
				continue;
			}
			state.phase = "cleanup";
			await deps.persist(state);
			await deps.index.publishForceCanonical(
				forceIndex(deps, state),
				plan.codec,
			);
			await publishManifest(deps, plan, authority);
			await authority();
			if (!(await verifyDestination(deps, plan))) {
				continue;
			}
			state.watcherCutoff = [
				...new Set([
					...state.watcherCutoff,
					...(deps.watcherCutoff?.() ?? []),
				]),
			];
			await deps.persist(state);
			const final = forceIndex(deps, state);
			delete final.maintenance;
			await assertSource(deps, plan);
			state.completion = await deps.index.publishForceCanonical(
				final,
				plan.codec,
				false,
				async () => {
					await plan.assertConfiguration();
					await assertSource(deps, plan);
				},
			);
			await deps.persist(state);
			const committed = await deps.index.recoverForcePublication(
				state,
				plan.codec,
				beforeCommit,
			);
			if (!committed || committed.maintenance) {
				throw new Error("Force final canonical changed");
			}
			await verifyPublishedManifest(deps, state);
			await deps.index.assertForceCleanupComplete();
			await finishForceReplacement(deps, plan, committed);
			return;
		}
		throw new Error(
			"Force destination did not converge after three passes; recovery remains pending",
		);
	});
}

/** Adopt verified target state and retire only the durable watcher cutoff before clearing recovery. */
async function finishForceReplacement(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
	canonical: SyncIndex,
): Promise<void> {
	const state = plan.recovery;
	const baseline = forceIndex(deps, state);
	delete baseline.maintenance;
	baseline.revision = state.completion!.revision;
	deps.index.finishForceReplacement(
		canonical,
		state.rootResourceId!,
		baseline,
	);
	if (canonical.revision === state.completion!.revision) {
		deps.settings.enableEncryption = state.target.enabled;
		deps.settings.encryptionPassword = plan.password;
		deps.settings.encryptionSalt = state.target.salt;
		deps.settings.encryptionRevision = state.target.revision;
		deps.settings.encryptionProfileId = state.target.enabled
			? "hardened"
			: null;
	}
	await deps.retireWatcherEvents?.(state.watcherCutoff);
	await deps.persist(null);
}

async function rawFiles(
	deps: ForceReplacementDependencies,
): Promise<YandexResource[]> {
	return await deps.client.getResourcesRecursive(
		deps.settings.remotePath,
		true,
	);
}

/** Require raw scope or authenticated logical scope; filename shape alone never authorizes cleanup. */
async function remoteDestinationFiles(
	deps: ForceReplacementDependencies,
	resources: YandexResource[],
	codec: EncryptionCodec | null,
): Promise<YandexResource[]> {
	const selected: YandexResource[] = [];
	for (const resource of resources) {
		const path = toLocalPath(resource.path, deps.settings.remotePath);
		if (
			isProtectedPath(path) ||
			!deps.adapter.shouldInspectRaw(path, true)
		) {
			continue;
		}
		if (deps.adapter.shouldInspectRaw(path, false)) {
			selected.push(resource);
			continue;
		}
		let logical: string;
		try {
			if (!codec) {
				throw new Error("No authenticated filename codec");
			}
			logical = (
				await Promise.all(
					path
						.split("/")
						.map((segment) => codec.decryptFilename(segment)),
				)
			).join("/");
			assertSafeTransitionPath(logical, "Force destination");
		} catch {
			throw new Error(
				"Force destination scope is ambiguous: a raw path outside sync patterns may be encrypted; explicitly exclude unrelated objects or resolve the destination scope before retrying",
			);
		}
		if (deps.adapter.shouldSync(logical)) {
			selected.push(resource);
		}
	}
	return selected;
}

async function digestSource(files: ForceSourceFile[]): Promise<string> {
	return await computeSha256FromString(
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

async function assertSource(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
): Promise<void> {
	const state = plan.recovery;
	if (state.direction === "from_local") {
		const actual = await deps.adapter.getAllFileMetadata(true);
		if (
			actual.size !== state.source.length ||
			state.source.some(
				(file) =>
					actual.get(file.path)?.sha256 !== file.sha256 ||
					actual.get(file.path)?.size !== file.size,
			)
		) {
			throw new ForceSourceChangedError();
		}
	} else {
		const resources = (await rawFiles(deps)).filter(
			(resource) =>
				!isProtectedPath(toLocalPath(resource.path, state.remotePath)),
		);
		const expected = new Map(
			state.source.map((file) => [file.rawPath, file]),
		);
		const actualPaths = new Set<string>();
		for (const resource of resources) {
			const rawPath = toLocalPath(resource.path, state.remotePath);
			if (!deps.adapter.shouldInspectRaw(rawPath, !!plan.codec)) {
				continue;
			}
			const path = plan.codec
				? (
						await Promise.all(
							rawPath
								.split("/")
								.map((segment) =>
									plan.codec!.decryptFilename(segment),
								),
						)
					).join("/")
				: rawPath;
			if (!deps.adapter.shouldSync(path)) {
				continue;
			}
			actualPaths.add(rawPath);
			if (
				!expected.has(rawPath) ||
				!matchesStableContentFingerprint(
					expected.get(rawPath)!.fingerprint,
					resource,
				)
			) {
				throw new ForceSourceChangedError();
			}
		}
		if (actualPaths.size !== expected.size) {
			throw new ForceSourceChangedError();
		}
	}
}

function forceIndex(
	deps: ForceReplacementDependencies,
	state: ForceRecovery,
): SyncIndex {
	const index = createEmptyIndex(deps.settings.deviceId, state.epoch);
	index.revision =
		state.phase === "prepared" ? 1 : state.phase === "applying" ? 2 : 3;
	index.files = structuredClone(state.files);
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
		cleanup: state.cleanup,
	};
	return index;
}

async function replaceRemote(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
	authority: () => Promise<void>,
): Promise<void> {
	const state = plan.recovery;
	const wanted = new Map<string, ForceSourceFile>();
	for (const file of state.source) {
		const raw = toLocalPath(
			await deps.client.getPhysicalPath(
				joinPath(state.remotePath, file.path),
			),
			state.remotePath,
		);
		wanted.set(raw, file);
	}
	const inventory = await remoteDestinationFiles(
		deps,
		await rawFiles(deps),
		plan.codec,
	);
	for (const rawPath of wanted.keys()) {
		const target = await deps.client.getResource(
			joinPath(state.remotePath, rawPath),
			1,
			0,
			true,
		);
		if (target?.type === "dir") {
			throw new Error(
				"Force remote file target is a directory; move the directory aside before continuing recovery",
			);
		}
	}
	state.cleanup = inventory
		.filter((resource) => {
			const path = toLocalPath(resource.path, state.remotePath);
			return !wanted.has(path);
		})
		.map((resource) => ({
			path: toLocalPath(resource.path, state.remotePath),
			expectedFingerprint: getStableContentFingerprint(resource)!,
		}));
	if (state.cleanup.some((action) => !action.expectedFingerprint)) {
		throw new Error("Force cleanup object has no stable fingerprint");
	}
	await deps.persist(state);
	await deps.index.publishForceCanonical(forceIndex(deps, state), plan.codec);
	for (const action of state.cleanup) {
		await authority();
		const path = joinPath(state.remotePath, action.path);
		await deps.client.deleteResource(path, true, true, async () => {
			await authority();
			const actual = await deps.client.getResource(path, 1, 0, true);
			if (
				actual &&
				(actual.type !== "file" ||
					!matchesStableContentFingerprint(
						action.expectedFingerprint,
						actual,
					))
			) {
				throw new ForceDestinationChangedError(
					"Force destination changed during cleanup; retry inventory",
				);
			}
		});
		if (await deps.client.getResource(path, 1, 0, true)) {
			throw new Error("Force remote deletion was not confirmed");
		}
	}
	for (const file of state.source) {
		await authority();
		const rawPath = toLocalPath(
			await deps.client.getPhysicalPath(
				joinPath(state.remotePath, file.path),
			),
			state.remotePath,
		);
		const targetPath = joinPath(state.remotePath, rawPath);
		const resource = await deps.client.getResource(targetPath, 1, 0, true);
		if (resource?.type === "dir") {
			throw new Error(
				"Force remote file target is a directory; move the directory aside before continuing recovery",
			);
		}
		const content = await deps.adapter.readFile(file.path);
		if ((await computeSha256(content)) !== file.sha256) {
			throw new ForceSourceChangedError();
		}
		const encoded = plan.codec
			? await plan.codec.encrypt(content)
			: content;
		const sha = await computeSha256(encoded);
		setRecordValue(state.targetHashes, rawPath, sha);
		try {
			await writeForceRemoteTarget(
				deps,
				plan,
				file.path,
				targetPath,
				encoded,
				sha,
				authority,
			);
		} catch (error) {
			if (
				error instanceof YandexApiError &&
				(error.status === 404 ||
					(error.status === 409 &&
						error.code === "DiskPathDoesntExistsError"))
			) {
				await authority();
				const parent = targetPath.slice(0, targetPath.lastIndexOf("/"));
				if (
					parent &&
					!(await deps.client.getResource(parent, 1, 0, true))
				) {
					throw new ForceDestinationChangedError(
						"Force parent disappeared; retry inventory",
					);
				}
			}
			throw error;
		}
		const actual = await deps.client.getResource(targetPath, 1, 0, true);
		if (!actual || actual.sha256 !== sha) {
			const readback =
				await deps.client.downloadStableRawFile(targetPath);
			if (!readback || (await computeSha256(readback.raw)) !== sha) {
				throw new Error("Force uploaded bytes were not verified");
			}
		}
		setRecordValue(state.files, file.path, {
			path: file.path,
			sha256: file.sha256,
			size: file.size,
			mtime: file.mtime,
			syncedAt: Date.now(),
			remoteFingerprint:
				getPhysicalResourceFingerprint(actual) ?? undefined,
			remoteMtime: actual ? Date.parse(actual.modified) : undefined,
			lastModifiedBy: deps.settings.deviceId,
			mutationSeq: 0,
			baseRevision: 0,
			changedRevision: 1,
		});
		await deps.persist(state);
	}
	state.cleanup = [];
}

/** Empty directories may be pruned independently of file include patterns. */
function canPruneForceDirectory(
	deps: ForceReplacementDependencies,
	path: string,
): boolean {
	return shouldSyncFile(
		path,
		[],
		deps.settings.excludePatterns,
		deps.settings.syncDotObsidian,
		deps.adapter.vault.configDir,
	);
}

async function replaceLocal(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
	authority: () => Promise<void>,
): Promise<void> {
	const state = plan.recovery;
	const wanted = new Set(state.source.map((file) => file.path));
	for (const file of deps.adapter.getAllSyncableFiles()) {
		if (!wanted.has(file.path)) {
			await authority();
			deps.expectWatcherEvent?.(file.path, "delete");
			await deps.adapter.deleteFile(file.path);
			await deps.adapter.pruneEmptyLocalAncestors(file.path);
		}
	}
	for (const file of state.source) {
		await authority();
		const snapshot = await deps.client.downloadStableRawFile(
			joinPath(state.remotePath, file.rawPath),
		);
		if (
			!snapshot ||
			!matchesStableContentFingerprint(
				file.fingerprint,
				snapshot.resource,
			)
		) {
			throw new ForceSourceChangedError();
		}
		const content = plan.codec
			? await plan.codec.decrypt(snapshot.raw)
			: snapshot.raw;
		if ((await computeSha256(content)) !== file.sha256) {
			throw new ForceSourceChangedError();
		}
		const folders = deps.adapter
			.getLocalPathEntries()
			.folders.filter(
				(path) =>
					path === file.path || path.startsWith(`${file.path}/`),
			)
			.sort(
				(left, right) =>
					right.split("/").length - left.split("/").length,
			);
		for (const folder of folders) {
			if (canPruneForceDirectory(deps, folder)) {
				await authority();
				await deps.adapter.pruneEmptyLocalAncestors(
					`${folder}/.force-empty-check`,
					(path) => canPruneForceDirectory(deps, path),
				);
			}
		}
		await authority();
		deps.expectWatcherEvent?.(file.path, "upload");
		await deps.adapter.writeFile(file.path, content);
		setRecordValue(state.files, file.path, {
			path: file.path,
			sha256: file.sha256,
			size: file.size,
			mtime: file.mtime,
			syncedAt: Date.now(),
			remoteFingerprint:
				getPhysicalResourceFingerprint(snapshot.resource) ?? undefined,
			remoteMtime: Date.parse(snapshot.resource.modified),
			lastModifiedBy: deps.settings.deviceId,
			mutationSeq: 0,
			baseRevision: 0,
			changedRevision: 1,
		});
		await deps.persist(state);
	}
}

async function verifyDestination(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
): Promise<boolean> {
	const state = plan.recovery;
	if (state.direction === "from_remote") {
		const actual = await deps.adapter.getAllFileMetadata(true);
		return (
			actual.size === state.source.length &&
			state.source.every(
				(file) => actual.get(file.path)?.sha256 === file.sha256,
			)
		);
	}
	const actual = await remoteDestinationFiles(
		deps,
		await rawFiles(deps),
		plan.codec,
	);
	if (actual.length !== state.source.length) {
		return false;
	}
	for (const file of state.source) {
		const target = await deps.client.getPhysicalPath(
			joinPath(state.remotePath, file.path),
		);
		const resource = actual.find(
			(resource) =>
				toLocalPath(resource.path, state.remotePath) ===
				toLocalPath(target, state.remotePath),
		);
		if (!resource) {
			return false;
		}
		const hash = state.targetHashes[toLocalPath(target, state.remotePath)];
		if (resource.sha256) {
			if (resource.sha256 !== hash) {
				return false;
			}
		} else {
			const snapshot = await deps.client.downloadStableRawFile(target);
			if (!snapshot || (await computeSha256(snapshot.raw)) !== hash) {
				return false;
			}
		}
	}
	return true;
}

async function publishManifest(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
	authority: () => Promise<void>,
): Promise<void> {
	const path = joinPath(plan.recovery.remotePath, manifestName);
	await authority();
	if (plan.recovery.manifest) {
		const content = JSON.stringify(plan.recovery.manifest);
		await deps.client.uploadFile(
			path,
			content,
			false,
			true,
			true,
			authority,
		);
		await verifyPublishedManifest(deps, plan.recovery);
	} else {
		await deps.client.deleteResource(path, true, true, authority);
		if (await deps.client.getResource(path, 1, 0, true)) {
			throw new Error(
				"Force plaintext manifest cleanup was not verified",
			);
		}
	}
}

/** Verify only the new metadata written by this operation before accepting its baseline. */
async function verifyPublishedManifest(
	deps: ForceReplacementDependencies,
	state: ForceRecovery,
): Promise<void> {
	const snapshot = await deps.client.downloadStableRawFile(
		joinPath(state.remotePath, manifestName),
	);
	if (
		state.manifest
			? !snapshot ||
				(await computeSha256(snapshot.raw)) !==
					(await computeSha256FromString(
						JSON.stringify(state.manifest),
					))
			: snapshot !== null
	) {
		throw new Error("Force final manifest changed");
	}
}

/** Stage payloads so an upload accepted before revocation cannot overwrite a completed successor. */
async function writeForceRemoteTarget(
	deps: ForceReplacementDependencies,
	plan: PreparedForceReplacement,
	logicalPath: string,
	targetPath: string,
	content: ArrayBuffer,
	hash: string,
	authority: () => Promise<void>,
): Promise<void> {
	const staging = joinPath(
		plan.recovery.remotePath,
		`.obsidian-sync-index.lock.${plan.recovery.id}.payload.${createSyncEpoch()}`,
	);
	let fingerprint: string | null = null;
	let failure: Error | null = null;
	try {
		let uploadError: unknown;
		try {
			await deps.client.uploadFile(
				staging,
				content,
				false,
				true,
				false,
				authority,
			);
		} catch (error) {
			uploadError = error;
		}
		const uploaded = await deps.client.getResource(staging, 1, 0, true);
		// A server SHA-256 proves the uploaded bytes without depending on signed-download availability.
		if (uploaded?.sha256) {
			if (
				uploaded.type === "file" &&
				uploaded.sha256 === hash &&
				uploaded.size === content.byteLength
			) {
				fingerprint = getStableContentFingerprint(uploaded);
			}
		} else if (uploaded?.type === "file") {
			const stage = await deps.client.downloadStableRawFile(
				staging,
				uploaded,
			);
			if (stage && (await computeSha256(stage.raw)) === hash) {
				fingerprint = stage.fingerprint;
			}
		}
		if (!fingerprint) {
			throw uploadError instanceof Error
				? uploadError
				: new Error("Force staged upload was not verified");
		}
		await authority();
		const previous = await deps.client.getResource(targetPath, 1, 0, true);
		if (previous) {
			if (
				previous.type === "dir" &&
				!(await deps.client.isRawFolderEmpty(targetPath))
			) {
				throw new ForceDestinationChangedError(
					"Force target folder gained descendants",
				);
			}
			const expected = getStableContentFingerprint(previous);
			try {
				await deps.client.deleteResource(
					targetPath,
					true,
					true,
					async () => {
						await authority();
						if (
							previous.type === "dir" &&
							!(await deps.client.isRawFolderEmpty(targetPath))
						) {
							throw new ForceDestinationChangedError(
								"Force target folder gained descendants",
							);
						}
						const current = await deps.client.getResource(
							targetPath,
							1,
							0,
							true,
						);
						if (
							current &&
							!matchesStableContentFingerprint(expected, current)
						) {
							throw new ForceDestinationChangedError(
								"Force target changed before replacement",
							);
						}
					},
				);
			} catch (error) {
				await authority();
				if (await deps.client.getResource(targetPath, 1, 0, true)) {
					throw error;
				}
			}
			if (await deps.client.getResource(targetPath, 1, 0, true)) {
				throw new ForceDestinationChangedError(
					"Force target deletion was not confirmed",
				);
			}
		}
		try {
			await deps.client.moveResourceExclusive(
				staging,
				joinPath(plan.recovery.remotePath, logicalPath),
				authority,
			);
		} catch (error) {
			await authority();
			const [current, remaining] = await Promise.all([
				deps.client.getResource(targetPath, 1, 0, true),
				deps.client.getResource(staging, 1, 0, true),
			]);
			if (
				!current ||
				remaining ||
				!matchesStableContentFingerprint(fingerprint, current)
			) {
				throw error;
			}
		}
	} catch (error) {
		failure =
			error instanceof Error
				? error
				: new Error("Force staged transfer failed");
	}
	try {
		const remaining = await deps.client.getResource(staging, 1, 0, true);
		if (remaining && fingerprint) {
			// The unique payload path belongs only to this run, even after its canonical authority was revoked.
			await deps.client.deleteResource(staging, true, true, async () => {
				const current = await deps.client.getResource(
					staging,
					1,
					0,
					true,
				);
				if (
					current &&
					!matchesStableContentFingerprint(fingerprint, current)
				) {
					throw new Error("Force staging cleanup proof changed");
				}
			});
			if (await deps.client.getResource(staging, 1, 0, true)) {
				throw new Error("Force staging cleanup is incomplete");
			}
		}
	} catch (error) {
		failure ??=
			error instanceof Error
				? error
				: new Error("Force staging cleanup failed");
	}
	if (failure) {
		throw failure;
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
