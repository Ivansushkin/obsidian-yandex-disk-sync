import { isPreservedRawPath } from "../../crypto/replacement";
import { ForceRecoveryPendingError } from "../workflows/force-state";
/**
 * Synchronization index manager
 */

import {
	CanonicalRecovery,
	type StableRootListing,
	REMOTE_INDEX_FILENAME,
} from "./recovery";
import { commitCanonicalIndex } from "./commit";
import { ForcePublication } from "./force-publication";

import type {
	SyncIndex,
	LocalSyncState,
	FileMetadata,
	FolderTombstone,
	PendingMutation,
	PendingMutationType,
	PendingPhysicalAction,
	PendingPhysicalActionType,
	YandexDiskSyncSettings,
	YandexResource,
	EncryptionManifest,
	RemoteEncryptionManifest,
	IndexMaintenance,
} from "../../types";
import { createEmptyIndex, createEmptyLocalState } from "../../types";
import { YandexApiError, YandexDiskClient } from "../../api/yandex-client";
import { VaultAdapter } from "../../api/vault-adapter";
import {
	PathAncestryIndex,
	isProtectedPath,
	isLegacyPluginDataPath,
	isLegacyServicePathCollision,
	isRootIndexLockPath,
	joinPath,
	normalizePath,
	toLocalPath,
} from "../../utils/path-utils";
import {
	isJsonRecord,
	createSafeRecord,
	protectRecord,
	setRecordValue,
} from "../../utils/record-utils";
import { logger, shortenDiagnosticValue } from "../../utils/logger";
import { computeSha256 } from "../../utils/hash-utils";
import { UnsupportedHistoricalDataError } from "../../compatibility-errors";

import { parseStable1xIndex } from "../../compatibility/stable-1x";
import type { EncryptionCodec } from "../../crypto/encryption";
import {
	getPhysicalResourceFingerprint,
	isHashStableContentFingerprint,
	matchesStableContentFingerprint,
} from "../../utils/resource-fingerprint";
import {
	canApplyDestructiveFolderMutation,
	classifyIndexFormat,
} from "./mutation-rules";
import { LocalOperationStore } from "../local/operation-store";
import {
	readRemoteStorageScope,
	sameRemoteStorageScope,
	StorageScopeError,
} from "../local/storage-scope";
import {
	cloneIndex,
	isTargetRecoveryIndex,
	sameIndexValue,
} from "./transaction-rules";
import {
	type CanonicalCommitProof,
	type IndexCodec,
	type IndexFileSnapshot,
	type IndexLockObservation,
} from "./transaction";

import {
	RemoteIndexTransactionError,
	RemoteIndexConcurrentModificationError,
	ForceBackupStaleError,
	PortablePathCollisionError,
	LegacyPluginDataExposureError,
	LegacyServicePathCollisionError,
	LegacyIndexFormatError,
	InvalidCurrentIndexError,
	UnreadableRemoteIndexError,
	AmbiguousRemoteIndexLockError,
	IndexEpochMismatchError,
	RemoteMaintenanceActiveError,
	type IndexDecodeAttempt,
} from "./errors";
import {
	validateCurrentIndexShape,
	validateCurrentIndexCausality,
} from "./schema";
import {
	mergeDesiredIndex,
	type CanonicalMergeMode,
	type RejectedCanonicalPut,
} from "./merge";
import { parseEncryptionManifest } from "../../crypto/manifest-schema";
import { runWithConcurrencySettled } from "../../utils/semaphore";

declare const authorityObservation: unique symbol;
/** Opaque metadata usable only by validators during its owning read evaluation. */
export interface RemoteAuthorityObservation {
	readonly [authorityObservation]: true;
}

/** Invocation-owned bytes; validators share metadata only within each fresh read. */
export interface CanonicalReadSession {
	(
		validate?: (observation: RemoteAuthorityObservation) => Promise<void>,
	): Promise<SyncIndex>;
	load(allowEpochAdoption?: boolean): Promise<SyncIndex>;
	assertCurrent(): void;
	close(): void;
}

/** Startup service observations expire with their owning lifecycle invocation. */
export interface StartupReadSession extends CanonicalReadSession {
	inspectServices(): Promise<EncryptionManifestRead>;
	manifest(): Promise<EncryptionManifestRead>;
	readWithCodecIfPresent(
		service: EncryptionCodec | null,
	): Promise<SyncIndex | null>;
	inspectFormat(): Promise<RemoteCanonicalFormat>;
	bind(assertActive: () => void): void;
}

export {
	RemoteIndexTransactionError,
	RemoteIndexConcurrentModificationError,
	ForceBackupStaleError,
	ForceSourceChangedError,
	PortablePathCollisionError,
	LegacyPluginDataExposureError,
	LegacyServicePathCollisionError,
	RemoteIndexContentMismatchError,
	RemoteIndexRolledBackError,
	AmbiguousRemoteIndexStateError,
	RemoteIndexLockedError,
	LegacyIndexFormatError,
	InvalidCurrentIndexError,
	UnreadableRemoteIndexError,
	AmbiguousRemoteIndexLockError,
	IndexEpochMismatchError,
	RemoteMaintenanceActiveError,
	type IndexDecodeAttempt,
} from "./errors";
export { validateEncryptionModeDescriptor } from "./schema";

const ENCRYPTION_MANIFEST_FILENAME = ".obsidian-encrypt.json";
export interface EncryptionManifestRead {
	manifest: RemoteEncryptionManifest | null;
	validationToken: string;
}

export interface LocalCausalSnapshot {
	state: LocalSyncState;
	mutations: PendingMutation[];
	physicalActions: PendingPhysicalAction[];
}

export type ForceCanonicalProof = (
	{ state: "absent" } | { state: "present"; rawSha256: string }
) & { locks?: IndexLockObservation[] };

export type RemoteCanonicalFormat = "absent" | "legacy" | "current";

type IndexCodecAttemptResult =
	{ data: unknown } | { attempt: IndexDecodeAttempt };

type JsonRecord = Record<string, unknown>;

export class IndexManager {
	private canonicalReadGeneration = 0;
	private readonly authorityObservations = new WeakMap<
		RemoteAuthorityObservation,
		{ listing: StableRootListing; assertCurrent: () => void }
	>();
	private yandexClient: YandexDiskClient;
	private vaultAdapter: VaultAdapter;
	private settings: YandexDiskSyncSettings;

	private localState: LocalSyncState;
	private remoteIndex: SyncIndex;
	private loadedRemoteIndex: SyncIndex;
	private saveChain: Promise<void> = Promise.resolve();

	private allowLegacyWriteOnce = false;
	private replaceRemoteOnNextSave = false;
	private forcePreflightCanonical: ForceCanonicalProof | null = null;
	private readonly recovery: CanonicalRecovery;
	private readonly forcePublication: ForcePublication;
	private operationStore: LocalOperationStore;
	private completedMoveIds = new Set<string>();
	private rejectedPuts: RejectedCanonicalPut[] = [];
	private transitionIndexReadService: EncryptionCodec | null | undefined;
	private transitionIndexWriteService: EncryptionCodec | null | undefined;
	private physicalRewriteOnNextSave = false;
	private encryptionReplacementCommit = false;
	private forceScope: {
		remotePath: string;
		rootResourceId: string | null;
		direct?: { format: "direct-v1" };
	} | null = null;
	private epochAdoptionTarget: string | null = null;
	private targetRecoveryMaintenanceId: string | null = null;

	constructor(
		yandexClient: YandexDiskClient,
		vaultAdapter: VaultAdapter,
		settings: YandexDiskSyncSettings,
	) {
		this.yandexClient = yandexClient;
		this.vaultAdapter = vaultAdapter;
		this.settings = settings;
		this.localState = createEmptyLocalState(settings.deviceId);
		this.remoteIndex = createEmptyIndex("");
		this.loadedRemoteIndex = createEmptyIndex("");
		this.operationStore = new LocalOperationStore(settings.deviceId);
		this.recovery = new CanonicalRecovery({
			client: this.yandexClient,
			getRemotePath: () => this.settings.remotePath,
			getCanonicalPath: () => this.getRemoteIndexPath(),
			getDeviceId: () => this.settings.deviceId,
			getReadOptions: () => ({
				allowLegacy: this.allowLegacyWriteOnce,
				source: this.transitionIndexReadService,
				target: this.transitionIndexWriteService,
			}),
			isReplacing: () => this.replaceRemoteOnNextSave,
			readSnapshot: (...args) => this.downloadIndexSnapshot(...args),
			decodeSnapshot: (...args) => this.decodeIndexSnapshot(...args),
			serialize: (index) => this.serializeCurrentIndex(index),
			isLockContention: (error) => this.isLockContention(error),
		});
		this.forcePublication = new ForcePublication({
			client: this.yandexClient,
			getRemotePath: () => this.settings.remotePath,
			getCanonicalPath: () => this.getRemoteIndexPath(),
			getDeviceId: () => this.settings.deviceId,
			getCurrentIndex: () => this.remoteIndex,
			isScoped: () => this.forceScope !== null,
			assertRemoteScope: () => this.assertRemoteScope(),
			getStableRootListing: () => this.recovery.getStableRootListing(),
			readSnapshot: (...args) => this.downloadIndexSnapshot(...args),
			serialize: (index) => this.serializeCurrentIndex(index),
			createTransactionId: () => this.createTransactionId(),
			acceptPublishedIndex: (index) => {
				this.remoteIndex = cloneIndex(index);
				this.loadedRemoteIndex = cloneIndex(index);
			},
		});
	}

	/**
	 * Update settings
	 */
	updateSettings(settings: YandexDiskSyncSettings): void {
		if (this.settings.remotePath !== settings.remotePath) {
			this.canonicalReadGeneration++;
		}
		this.settings = settings;
		this.operationStore.updateDeviceId(settings.deviceId);
	}

	/** Bound history must never authorize work in another physical root. */
	async assertRemoteScope(
		observation?: RemoteAuthorityObservation,
	): Promise<void> {
		const listing = observation
			? this.getAuthorityListing(observation)
			: undefined;
		if (this.forceScope) {
			if (this.settings.remotePath !== this.forceScope.remotePath) {
				throw new StorageScopeError("Force remote path changed");
			}
			if (this.forceScope.direct) {
				return;
			}
			const root = await this.yandexClient.getResource(
				this.settings.remotePath,
				1,
				0,
				true,
			);
			if (
				(root?.resource_id ?? null) !== this.forceScope.rootResourceId
			) {
				throw new StorageScopeError("Force root identity changed");
			}
			return;
		}
		const expected = this.localState.remoteScope;
		if (!expected) {
			return;
		}
		const actual = listing
			? listing.root
				? {
						remotePath: normalizePath(
							this.settings.remotePath.replace(/^disk:\//, ""),
						),
						rootResourceId: listing.root.resource_id!,
					}
				: null
			: await readRemoteStorageScope(
					this.yandexClient,
					this.settings.remotePath,
				);
		if (!sameRemoteStorageScope(expected, actual)) {
			throw new StorageScopeError(
				"Remote storage changed; confirm the connection before synchronization",
			);
		}
	}

	/** Scope a confirmed replacement to its selected physical root, ignoring destination history. */
	async withForceScope<T>(
		scope: {
			remotePath: string;
			rootResourceId: string | null;
			direct?: { format: "direct-v1" };
		},
		body: () => Promise<T>,
	): Promise<T> {
		if (this.forceScope) {
			throw new Error("Nested Force replacement is not allowed");
		}
		this.forceScope = scope;
		try {
			return await body();
		} finally {
			this.forceScope = null;
		}
	}

	/** Publish only new Force bytes directly; old canonical authority is deliberately ignored. */
	async publishDirectForceCanonical(
		index: SyncIndex,
		codec: EncryptionCodec | null,
		reset = false,
	): Promise<{ epoch: string; revision: number; canonicalSha256: string }> {
		if (!this.forceScope?.direct) {
			throw new Error(
				"Direct Force publication requires its explicit scope",
			);
		}
		await this.assertRemoteScope();
		const plain = new TextEncoder().encode(
			this.serializeCurrentIndex(index),
		).buffer;
		const raw = codec ? await codec.encrypt(plain) : plain;
		const canonicalSha256 = await computeSha256(raw);
		const path = this.getRemoteIndexPath();
		if (reset) {
			await this.yandexClient.deleteResource(path, true, true);
		}
		let uploadError: unknown;
		try {
			await this.yandexClient.uploadFile(path, raw, false, true, true);
		} catch (error) {
			uploadError = error;
		}
		const snapshot = await this.yandexClient.downloadStableRawFile(path);
		if (
			!snapshot ||
			(await computeSha256(snapshot.raw)) !== canonicalSha256
		) {
			throw uploadError instanceof Error
				? uploadError
				: new Error(
						"Direct Force canonical publication was not confirmed",
					);
		}
		this.remoteIndex = cloneIndex(index);
		this.loadedRemoteIndex = cloneIndex(index);
		return {
			epoch: index.epoch,
			revision: index.revision,
			canonicalSha256,
		};
	}

	/** Require matching operation authority before every Force write and retry. */
	async assertForceAuthority(
		id: string,
		epoch: string,
		codec: EncryptionCodec | null,
	): Promise<SyncIndex> {
		return await this.forcePublication.assertForceAuthority(
			id,
			epoch,
			codec,
		);
	}

	/** Replace raw destination metadata under an exclusive lock without decoding its old content. */
	async publishForceCanonical(
		desired: SyncIndex,
		codec: EncryptionCodec | null,
		initial = false,
		beforeCommit?: () => Promise<void>,
	): Promise<
		NonNullable<
			import("../workflows/force-state").ForceRecovery["completion"]
		>
	> {
		return await this.forcePublication.publishForceCanonical(
			desired,
			codec,
			initial,
			beforeCommit,
		);
	}

	/** Resolve own staged publications after restart, without reading displaced destination bytes. */
	async recoverForcePublication(
		state: import("../workflows/force-state").ForceRecovery,
		codec: EncryptionCodec | null,
		beforeCommit?: () => Promise<void>,
	): Promise<SyncIndex | null> {
		return await this.forcePublication.recoverForcePublication(
			state,
			codec,
			beforeCommit,
		);
	}

	/** Clear only pinned service leftovers after the new operation has published authority. */
	async cleanupForceServiceLocks(
		state: import("../workflows/force-state").ForceRecovery,
		codec: EncryptionCodec | null,
		completed = false,
	): Promise<void> {
		return await this.forcePublication.cleanupForceServiceLocks(
			state,
			codec,
			completed,
		);
	}

	/** Accept only the verified replacement and retire queues from its old generation. */
	finishForceReplacement(
		index: SyncIndex,
		rootResourceId: string,
		baseline = index,
	): void {
		if (index.maintenance) {
			throw new Error("Force cleanup is still active");
		}
		this.remoteIndex = cloneIndex(index);
		this.loadedRemoteIndex = cloneIndex(index);
		if (this.localState.observedEpoch !== index.epoch) {
			this.finalizeForceEpoch(baseline);
		}
		this.localState.remoteScope = {
			remotePath: this.settings.remotePath,
			rootResourceId,
		};
	}

	/** Start a different storage only after all durable work has been settled. */
	resetLocalStorageHistory(): void {
		if (
			this.getPendingMutations().length ||
			this.getPendingPhysicalActions().length
		) {
			throw new StorageScopeError(
				"Pending operations must be resolved in their original storage",
			);
		}
		this.localState = createEmptyLocalState(this.settings.deviceId);
		this.operationStore.loadMutations([], 1);
	}

	/**
	 * Use different source and target codecs for the one canonical commit that
	 * changes encryption mode.
	 */
	setIndexTransitionServices(
		source: EncryptionCodec | null,
		target: EncryptionCodec | null,
	): void {
		this.canonicalReadGeneration++;
		this.transitionIndexReadService = source;
		this.transitionIndexWriteService = target;
	}

	/**
	 * Allow one target-codec device to adopt a committed foreign transition.
	 * The matching maintenance ID and post-commit phase are still validated.
	 */
	async runTargetMaintenanceRecovery<T>(
		maintenanceId: string,
		action: () => Promise<T>,
	): Promise<T> {
		if (this.targetRecoveryMaintenanceId !== null) {
			throw new Error("Target encryption recovery is already active");
		}
		this.targetRecoveryMaintenanceId = maintenanceId;
		try {
			return await action();
		} finally {
			this.targetRecoveryMaintenanceId = null;
		}
	}

	/** Classify and fingerprint canonical before a Force backup can be created. */
	async captureForceCanonicalProof(): Promise<ForceCanonicalProof> {
		const canonicalPath = this.getRemoteIndexPath();
		const { resources } = await this.recovery.getStableRootListing();
		const observedLocks = this.recovery.observeIndexLocks(resources);
		const locks = observedLocks.length > 0 ? { locks: observedLocks } : {};
		const resource = resources.find(
			(resource) =>
				resource.type === "file" &&
				resource.name === REMOTE_INDEX_FILENAME,
		);
		if (!resource) {
			return { state: "absent", ...locks };
		}
		const allowPlaintextLegacy =
			this.transitionIndexReadService === undefined &&
			!this.yandexClient.hasEncryptionService();
		try {
			const snapshot = await this.downloadIndexSnapshot(
				canonicalPath,
				allowPlaintextLegacy,
				this.transitionIndexReadService,
				"source",
				resource,
			);
			if (snapshot.index.maintenance) {
				throw new RemoteMaintenanceActiveError(
					snapshot.index.maintenance.id,
					snapshot.index.maintenance.initiatedBy,
				);
			}
			return {
				state: "present",
				rawSha256: await computeSha256(snapshot.raw),
				...locks,
			};
		} catch (error) {
			if (
				!allowPlaintextLegacy &&
				error instanceof LegacyIndexFormatError
			) {
				throw new UnsupportedHistoricalDataError(
					"Encrypted legacy canonical data is unsupported",
				);
			}
			throw error;
		}
	}

	/** Read-only canonical classification used to refresh startup migration state. */
	async inspectRemoteCanonicalFormat(): Promise<RemoteCanonicalFormat> {
		const canonicalPath = this.getRemoteIndexPath();
		const resource = await this.yandexClient.getResource(
			canonicalPath,
			1,
			0,
			true,
		);
		if (!resource) {
			return "absent";
		}
		try {
			await this.downloadIndexSnapshot(
				canonicalPath,
				false,
				null,
				"plaintext",
				resource,
			);
			return "current";
		} catch (error) {
			if (!(error instanceof LegacyIndexFormatError)) {
				throw error;
			}
			await this.downloadIndexSnapshot(
				canonicalPath,
				true,
				null,
				"plaintext",
			);
			return "legacy";
		}
	}

	/**
	 * Reject stable 1.1 paths that would expose plugin state or be silently
	 * hidden by current service-path filtering. No user object is downloaded.
	 */
	async assertLegacyMigrationPathsSafe(): Promise<void> {
		if (this.yandexClient.hasEncryptionService()) {
			const proof = await this.captureForceCanonicalProof();
			if (proof.state === "present") {
				return;
			}
		}
		const format = await this.inspectRemoteCanonicalFormat();
		if (format === "current") {
			return;
		}
		if (format === "legacy") {
			const canonical = await this.downloadIndexSnapshot(
				this.getRemoteIndexPath(),
				true,
				null,
				"plaintext",
			);
			for (const path of Object.keys(canonical.index.files)) {
				if (isLegacyPluginDataPath(path)) {
					throw new LegacyPluginDataExposureError();
				}
				if (path.includes("\\") || isLegacyServicePathCollision(path)) {
					throw new LegacyServicePathCollisionError();
				}
			}
		}
		const resources = await this.yandexClient.getResourcesRecursive(
			this.settings.remotePath,
			true,
			Math.min(this.settings.maxConcurrency, 4),
		);
		for (const resource of resources) {
			if (resource.path.includes("\\")) {
				throw new LegacyServicePathCollisionError();
			}
			const path = toLocalPath(resource.path, this.settings.remotePath);
			if (isLegacyPluginDataPath(path)) {
				throw new LegacyPluginDataExposureError();
			}
			const knownStableService =
				path === REMOTE_INDEX_FILENAME ||
				(resource.type === "file" && isRootIndexLockPath(path)) ||
				(resource.type === "file" &&
					path === ENCRYPTION_MANIFEST_FILENAME &&
					this.yandexClient.hasEncryptionService()) ||
				path === ".backup" ||
				path.startsWith(".backup/");
			if (!knownStableService && isLegacyServicePathCollision(path)) {
				throw new LegacyServicePathCollisionError();
			}
		}
	}

	/** Revalidate the canonical bytes protected by a completed Force backup. */
	async assertForceCanonicalProof(
		expected: ForceCanonicalProof,
	): Promise<void> {
		const actual = await this.captureForceCanonicalProof();
		if (!sameIndexValue(actual, expected)) {
			throw new ForceBackupStaleError(
				"Canonical changed after the Force backup was verified",
			);
		}
		this.forcePreflightCanonical = actual;
	}

	clearIndexTransitionServices(): void {
		this.canonicalReadGeneration++;
		this.transitionIndexReadService = undefined;
		this.transitionIndexWriteService = undefined;
	}

	/** Allow one full reconciliation to commit against a replacement epoch. */
	beginEpochAdoption(epoch: string, resetQueues = true): void {
		this.epochAdoptionTarget = epoch;
		if (!resetQueues) {
			return;
		}
		this.operationStore.resetForEpoch(epoch);
		this.operationStore.ensureSequenceFloor(
			this.remoteIndex.appliedMutationSeq[this.settings.deviceId] ?? 0,
		);
		this.localState.nextMutationSeq = 1;
	}

	/** Remove the temporary cross-epoch write authorization. */
	endEpochAdoption(): void {
		this.epochAdoptionTarget = null;
	}

	/** Capture local causal state so a failed adoption can be retried safely. */
	captureLocalCausalState(): LocalCausalSnapshot {
		return {
			state: this.cloneValue(this.localState),
			mutations: this.operationStore.getMutations(),
			physicalActions: this.operationStore.getPhysicalActions(),
		};
	}

	/** Restore the previous device baseline after an unsuccessful adoption. */
	restoreLocalCausalState(snapshot: LocalCausalSnapshot): void {
		this.localState = this.cloneValue(snapshot.state);
		this.localState.files = protectRecord(this.localState.files);
		this.localState.folderTombstones = protectRecord(
			this.localState.folderTombstones,
		);
		this.operationStore.loadMutations(
			snapshot.mutations,
			snapshot.state.nextMutationSeq,
		);
		this.operationStore.loadPhysicalActions(snapshot.physicalActions);
	}

	/** Capture selection without reading remote payloads or changing local bytes. */
	getEncryptionReplacementScope(): import("../../types").EncryptionReplacementScope {
		return {
			syncPatterns: [...this.settings.syncPatterns],
			excludePatterns: [...this.settings.excludePatterns],
			syncDotObsidian: this.settings.syncDotObsidian,
			configDir: this.vaultAdapter.vault.configDir,
		};
	}

	/** Only an owned transition can replace causal history at the target commit. */
	stageEncryptionReplacement(
		replacement: import("../../types").EncryptionReplacement,
	): void {
		const maintenance = this.remoteIndex.maintenance;
		if (
			!maintenance ||
			maintenance.initiatedBy !== this.settings.deviceId ||
			maintenance.replacement?.targetEpoch !== replacement.targetEpoch
		) {
			throw new Error(
				"Encryption replacement requires owned maintenance",
			);
		}
		this.encryptionReplacementCommit = true;
		this.epochAdoptionTarget = replacement.targetEpoch;
		this.remoteIndex.epoch = replacement.targetEpoch;
		this.remoteIndex.epochAdoption = {
			kind: "encryption-replacement",
			operationId: maintenance.id,
			initiatedBy: maintenance.initiatedBy,
			scope: structuredClone(replacement.scope),
			preservedRawPaths: [...replacement.preservedRawPaths],
		};
	}

	/** Retire old history only after authoritative bytes and the final index were verified. */
	finishEncryptionReplacement(files = this.remoteIndex.files): void {
		this.finalizeForceEpoch({ ...this.remoteIndex, files });
		this.epochAdoptionTarget = null;
	}

	beginPhysicalRewriteCommit(): void {
		this.physicalRewriteOnNextSave = true;
	}

	cancelPhysicalRewriteCommit(): void {
		this.encryptionReplacementCommit = false;
		this.physicalRewriteOnNextSave = false;
	}

	/**
	 * Get local index
	 */
	getLocalIndex(): LocalSyncState {
		return this.localState;
	}

	/** Identify an unfinished installation without reclassifying established or queued history. */
	isInitialRemoteReceivePending(): boolean {
		const state = this.localState;
		return (
			state.lastSyncTime === 0 &&
			state.observedRevision === 0 &&
			this.operationStore.getNextMutationSeq() === 1 &&
			this.getPendingMutations().length === 0 &&
			(state.observedEpoch !== null ||
				Object.keys(state.files).length === 0) &&
			this.getPendingPhysicalActions().every(
				(action) =>
					action.type === "delete-local" &&
					action.origin === "exact-delete",
			)
		);
	}

	/**
	 * Get remote index
	 */
	getRemoteIndex(): SyncIndex {
		return this.remoteIndex;
	}

	/** Include unpublished causal and maintenance work when comparing desired and loaded canonical JSON. */
	hasPendingCanonicalChanges(): boolean {
		return (
			this.getPendingMutations().length > 0 ||
			this.completedMoveIds.size > 0 ||
			this.replaceRemoteOnNextSave ||
			this.allowLegacyWriteOnce ||
			this.physicalRewriteOnNextSave ||
			this.targetRecoveryMaintenanceId !== null ||
			!sameIndexValue(this.remoteIndex, this.loadedRemoteIndex)
		);
	}

	/**
	 * Mark the currently loaded canonical state as fully reconciled locally.
	 */
	markRemoteObserved(): void {
		if (this.epochAdoptionTarget === this.remoteIndex.epoch) {
			const adoptedFiles = createSafeRecord<FileMetadata>();
			for (const [path, canonical] of Object.entries(
				this.remoteIndex.files,
			)) {
				const local = this.localState.files[path];
				setRecordValue(adoptedFiles, path, {
					...canonical,
					mtime:
						local && local.sha256 === canonical.sha256
							? local.mtime
							: canonical.mtime,
				});
			}
			this.localState.files = adoptedFiles;
		}
		for (const [path, baseline] of Object.entries(this.localState.files)) {
			const canonical = this.remoteIndex.files[path];
			if (!canonical) {
				continue;
			}
			setRecordValue(this.localState.files, path, {
				...baseline,
				sha256: canonical.sha256,
				size: canonical.size,
				syncedAt: canonical.syncedAt,
				remoteMtime: canonical.remoteMtime,
				remoteFingerprint: canonical.remoteFingerprint,
				deleted: canonical.deleted,
				deletedAt: canonical.deletedAt,
				deletedByFolder: canonical.deletedByFolder,
				lastModifiedBy: canonical.lastModifiedBy,
				mutationSeq: canonical.mutationSeq,
				changedRevision: canonical.changedRevision,
				baseRevision: canonical.baseRevision,
			});
		}
		this.localState.observedEpoch = this.remoteIndex.epoch;
		this.localState.observedRevision = this.remoteIndex.revision;
		this.localState.folderTombstones = protectRecord(
			this.cloneValue(this.remoteIndex.folderTombstones),
		);
		this.localState.nextMutationSeq =
			this.operationStore.getNextMutationSeq();
		this.localState.lastSyncTime = Date.now();
	}

	getObservedRevision(): number {
		return this.localState.observedRevision;
	}

	getObservedEpoch(): string | null {
		return this.localState.observedEpoch;
	}

	/**
	 * Finish an explicit Force replacement and discard causal work from the old
	 * epoch because the authoritative snapshot already includes its filesystem
	 * result.
	 */
	private finalizeForceEpoch(index: SyncIndex): void {
		this.operationStore.resetForEpoch(index.epoch);
		this.localState.observedEpoch = index.epoch;
		this.localState.observedRevision = index.revision;
		this.localState.files = protectRecord(this.cloneValue(index.files));
		this.localState.folderTombstones = createSafeRecord();
		this.localState.nextMutationSeq = 1;
		this.localState.lastSyncTime = Date.now();
	}

	/**
	 * Load local index from saved plugin data
	 */
	loadLocalIndexFromData(data: Partial<LocalSyncState> | null): void {
		if (data && typeof data.observedRevision === "number") {
			this.localState = {
				remoteScope: data.remoteScope ?? null,
				deviceId: this.settings.deviceId,
				observedEpoch:
					typeof data.observedEpoch === "string"
						? data.observedEpoch
						: null,
				observedRevision: data.observedRevision,
				lastSyncTime: data.lastSyncTime || 0,
				files: protectRecord(data.files || {}),
				folderTombstones: protectRecord(data.folderTombstones || {}),
				nextMutationSeq: Math.max(1, data.nextMutationSeq || 1),
			};
		} else {
			this.localState = createEmptyLocalState(this.settings.deviceId);
		}
	}

	/**
	 * Allow one force-sync commit to replace a stable 1.x index.
	 */
	beginForceBootstrap(replaceRemote = true): void {
		this.allowLegacyWriteOnce = true;
		this.replaceRemoteOnNextSave = replaceRemote;
		if (replaceRemote) {
			this.remoteIndex = createEmptyIndex(this.settings.deviceId);
			this.loadedRemoteIndex = createEmptyIndex(
				"",
				this.remoteIndex.epoch,
			);
		}
	}

	cancelForceBootstrap(): void {
		this.allowLegacyWriteOnce = false;
		this.replaceRemoteOnNextSave = false;
		this.forcePreflightCanonical = null;
	}

	/**
	 * Get local index data for saving
	 */
	getLocalIndexData(): LocalSyncState {
		this.localState.nextMutationSeq =
			this.operationStore.getNextMutationSeq();
		return this.localState;
	}

	loadPendingMutations(mutations: PendingMutation[] | undefined): void {
		this.operationStore.loadMutations(
			mutations?.filter(
				(mutation) =>
					typeof mutation.epoch === "string" &&
					mutation.epoch === this.localState.observedEpoch,
			),
			this.localState.nextMutationSeq,
		);
	}

	getPendingMutations(): PendingMutation[] {
		return this.operationStore.getMutations();
	}

	loadPendingPhysicalActions(
		actions: PendingPhysicalAction[] | undefined,
	): void {
		this.operationStore.loadPhysicalActions(
			actions?.filter(
				(action) =>
					typeof action.epoch === "string" &&
					action.epoch === this.localState.observedEpoch,
			),
		);
	}

	getPendingPhysicalActions(): PendingPhysicalAction[] {
		return this.operationStore.getPhysicalActions();
	}

	hasPendingPhysicalAction(
		type: PendingPhysicalActionType,
		path: string,
	): boolean {
		return this.operationStore.findPhysicalAction(type, path) !== undefined;
	}

	getPendingPhysicalAction(
		type: PendingPhysicalActionType,
		path: string,
	): PendingPhysicalAction | undefined {
		return this.operationStore.findPhysicalAction(type, path);
	}

	getPendingLocalDeletePaths(): Set<string> {
		return this.operationStore.getPendingLocalDeletePaths();
	}

	enqueuePhysicalAction(
		type: PendingPhysicalActionType,
		path: string,
		options?: {
			targetPath?: string;
			parentMutationId?: string;
			canonicalRevision?: number;
			expectedFingerprint?: string;
			expectedChangedRevision?: number;
			expectedTargetFingerprint?: string;
			baselineSha256?: string;
			origin?: PendingPhysicalAction["origin"];
		},
	): PendingPhysicalAction {
		return this.operationStore.enqueuePhysicalAction(
			type,
			path,
			this.remoteIndex.revision,
			{
				...options,
				epoch: this.remoteIndex.epoch,
			},
		);
	}

	/**
	 * Return the canonical revision on which a newly discovered local change
	 * causally depends.
	 */
	getCausalBaseRevision(): number {
		if (this.localState.observedEpoch === this.remoteIndex.epoch) {
			return this.localState.observedRevision;
		}
		return this.loadedRemoteIndex.revision;
	}

	completePhysicalAction(id: string): void {
		this.operationStore.completePhysicalAction(id);
	}

	/** Observe a matching pending put at the caller's current temporal boundary. */
	findPendingMatchingPut(
		path: string,
		sha256: string | undefined,
		order: "first" | "last",
	): PendingMutation | undefined {
		return this.operationStore.findMatchingPut(path, sha256, order);
	}

	getPendingPutBaseRevision(path: string): number | null | undefined {
		return this.operationStore.findLatestPutBaseRevision(path);
	}

	/**
	 * Move the newest unconfirmed put to a new logical path.
	 */
	retargetPendingPut(
		oldPath: string,
		newPath: string,
		sha256: string,
		baselineSha256?: string,
	): PendingMutation | undefined {
		return this.operationStore.retargetLatestPut(
			oldPath,
			newPath,
			sha256,
			baselineSha256,
		);
	}

	/**
	 * Reuse a put sequence for a delete that superseded it before commit.
	 */
	replacePendingPutWithDelete(id: string): PendingMutation | undefined {
		return this.operationStore.replacePutWithDelete(id);
	}

	/**
	 * Reuse a put sequence as a watermark-only full-sync settlement.
	 */
	replacePendingPutWithNoop(id: string): PendingMutation | undefined {
		return this.operationStore.replacePutWithNoop(id);
	}

	consumeRejectedPuts(): Array<{
		path: string;
		reason: "delete" | "conflict";
		remoteFingerprint: string;
		baselineSha256?: string;
	}> {
		const rejected = this.rejectedPuts;
		this.rejectedPuts = [];
		return rejected;
	}

	/**
	 * Reapply durable local intentions after loading the canonical index.
	 */
	replayPendingMutations(): boolean {
		const before = this.getPendingMutations().length;
		this.confirmAppliedMutations();
		let ancestry: PathAncestryIndex | undefined;
		for (const mutation of this.getPendingMutations()) {
			if (mutation.type === "delete-file") {
				this.markLocalFileDeleted(
					mutation.path,
					undefined,
					mutation.seq,
				);
				ancestry?.add(mutation.path);
				this.markRemoteFileDeleted(
					mutation.path,
					undefined,
					mutation.baseRevision ?? 0,
					mutation.seq,
				);
				continue;
			}
			if (mutation.type === "delete-folder") {
				this.markFolderDeleted(
					mutation.path,
					mutation.createdAt,
					mutation.baseRevision,
					mutation.seq,
				);
				const prefix = `${mutation.path.replace(/\/+$/, "")}/`;
				ancestry ??= new PathAncestryIndex([
					...Object.keys(this.localState.files),
					...Object.keys(this.remoteIndex.files),
				]);
				for (const path of ancestry.get(
					mutation.path.replace(/\/+$/, ""),
				) ?? []) {
					if (!path.startsWith(prefix)) {
						continue;
					}
					const current = this.remoteIndex.files[path];
					if (
						current &&
						!canApplyDestructiveFolderMutation(
							current,
							mutation.baseRevision ?? 0,
							this.settings.deviceId,
							mutation.seq,
						)
					) {
						continue;
					}
					this.markLocalFileDeleted(
						path,
						mutation.path,
						mutation.seq,
					);
					this.markRemoteFileDeleted(
						path,
						mutation.path,
						mutation.baseRevision ?? 0,
						mutation.seq,
					);
				}
				continue;
			}
		}
		return before !== this.getPendingMutations().length;
	}

	enqueueMutation(
		type: PendingMutationType,
		path: string,
		options?: {
			targetPath?: string;
			resourceKind?: "file" | "folder";
			sha256?: string;
			baselineSha256?: string;
			epoch?: string | null;
			baseRevision?: number | null;
		},
	): PendingMutation {
		return this.operationStore.enqueueMutation(
			type,
			path,
			options?.epoch === undefined
				? (this.epochAdoptionTarget ?? this.localState.observedEpoch)
				: options.epoch,
			options?.baseRevision === undefined
				? this.epochAdoptionTarget !== null
					? this.loadedRemoteIndex.revision
					: this.localState.observedEpoch === null
						? null
						: this.localState.observedRevision
				: options.baseRevision,
			options,
		);
	}

	stageMutation(mutation: PendingMutation): void {
		this.operationStore.stageMutation(
			this.remoteIndex.appliedMutationSeq,
			mutation,
		);
	}

	stagePendingMutations(): void {
		this.operationStore.stagePendingMutations(
			this.remoteIndex.appliedMutationSeq,
		);
	}

	confirmMutation(id: string): void {
		this.operationStore.confirmMutation(
			id,
			this.remoteIndex.appliedMutationSeq,
		);
	}

	/**
	 * Confirm local work against a canonical snapshot read outside the
	 * manager's current desired-index view.
	 */
	confirmMutationAgainst(
		id: string,
		appliedMutationSeq: Record<string, number>,
	): void {
		this.operationStore.confirmMutation(id, appliedMutationSeq);
	}

	discardMutation(id: string): void {
		this.operationStore.discardNewestMutation(id);
	}

	confirmAppliedMutations(): void {
		this.operationStore.confirmAppliedMutations(
			this.remoteIndex.appliedMutationSeq,
		);
	}

	/**
	 * Build a complete local snapshot; unreadable files must never imply absence.
	 */
	async buildLocalIndex(): Promise<Map<string, FileMetadata>> {
		logger.info("Building local index...");
		const metadata = await this.vaultAdapter.getAllFileMetadata(true);
		logger.info(`Found ${metadata.size} files for synchronization`);
		return metadata;
	}

	/**
	 * Load remote index from Yandex Disk
	 */
	async loadRemoteIndex(
		allowLegacy = false,
		stableRootDiscovery = false,
		allowEpochAdoption = false,
	): Promise<SyncIndex> {
		const snapshot = await this.loadRemoteIndexSnapshot(
			allowLegacy,
			stableRootDiscovery,
		);
		return this.acceptLoadedIndex(snapshot.index, allowEpochAdoption);
	}

	/** Obtain the verified load snapshot before exposing any mutable desired state. */
	private async loadRemoteIndexSnapshot(
		allowLegacy: boolean,
		stableRootDiscovery: boolean,
		assertCurrent: () => void = () => {},
	): Promise<IndexFileSnapshot> {
		assertCurrent();
		if (!stableRootDiscovery) {
			await this.assertRemoteScope();
		}
		assertCurrent();
		const discover = () =>
			this.recovery.waitForCanonicalIndexFromStableRoot(
				assertCurrent,
				(listing) =>
					this.withAuthorityObservation(
						listing,
						assertCurrent,
						async () => {},
					),
			);
		let discovery: {
			path: string | null;
			resource?: YandexResource;
			rootExists?: boolean;
		} = stableRootDiscovery
			? await discover()
			: { path: await this.recovery.waitForCanonicalIndex() };
		assertCurrent();
		if (!discovery.path) {
			if (stableRootDiscovery && discovery.rootExists === false) {
				await this.createRemotePath();
				assertCurrent();
			}
			await this.recovery.initializeCanonicalIndex();
			assertCurrent();
			discovery = stableRootDiscovery
				? await discover()
				: { path: await this.recovery.waitForCanonicalIndex() };
			assertCurrent();
			if (!discovery.path) {
				throw new RemoteIndexConcurrentModificationError(
					"Canonical index could not be initialized",
				);
			}
		}
		const snapshot = await this.downloadIndexSnapshot(
			discovery.path,
			allowLegacy,
			undefined,
			undefined,
			discovery.resource,
		);
		assertCurrent();
		return snapshot;
	}

	/** Keep desired and reducer baseline independent of a session's private snapshot. */
	private acceptLoadedIndex(
		index: SyncIndex,
		allowEpochAdoption: boolean,
	): SyncIndex {
		this.remoteIndex = cloneIndex(index);
		this.loadedRemoteIndex = cloneIndex(index);
		if (
			this.localState.observedEpoch === null ||
			this.localState.observedEpoch === index.epoch
		) {
			this.operationStore.ensureSequenceFloor(
				index.appliedMutationSeq[this.settings.deviceId] ?? 0,
			);
		}
		if (!allowEpochAdoption) {
			this.assertEpochCompatible(index);
		}
		this.assertMaintenanceCompatible(index);
		logger.info(
			`Loaded remote index revision ${index.revision}: ${Object.keys(index.files).length} files`,
		);
		return this.remoteIndex;
	}

	/**
	 * Read the current canonical index without advancing local observation or
	 * replacing the in-memory desired state.
	 */
	async readCanonicalIndex(): Promise<SyncIndex> {
		return await this.createCanonicalReadSession()();
	}

	/** Revalidate scoped bytes; read-only mode rejects locks/missing canonical without repair. */
	createCanonicalReadSession(
		assertActive: () => void = () => {},
		readOnly = false,
	): CanonicalReadSession {
		return this.createStartupReadSession(assertActive, readOnly);
	}

	/** Own private service bytes across classification, admission and the following full. */
	createStartupReadSession(
		assertActive: () => void = () => {},
		readOnlyCanonical = false,
	): StartupReadSession {
		const generation = this.canonicalReadGeneration;
		const configurationVersion =
			this.yandexClient.getReadConfigurationVersion();
		const remotePath = this.settings.remotePath;
		const source = this.transitionIndexReadService;
		const target = this.transitionIndexWriteService;
		let snapshot: IndexFileSnapshot | undefined;
		let prefetchedRaw:
			| Awaited<ReturnType<YandexDiskClient["downloadStableRawFile"]>>
			| undefined;
		// Undefined identifies the captured active/transition configuration; null is explicit plaintext.
		let snapshotService: EncryptionCodec | null | undefined;
		let manifestRead: EncryptionManifestRead | undefined;
		let closed = false;
		const activeGuards = [assertActive];
		let tail: Promise<unknown> = Promise.resolve();
		const assertConfiguration = () => {
			if (
				closed ||
				this.canonicalReadGeneration !== generation ||
				this.yandexClient.getReadConfigurationVersion() !==
					configurationVersion ||
				this.settings.remotePath !== remotePath ||
				this.transitionIndexReadService !== source ||
				this.transitionIndexWriteService !== target
			) {
				throw new StorageScopeError(
					"Canonical read configuration changed or invocation ended",
				);
			}
			for (const guard of activeGuards) {
				guard();
			}
		};
		const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
			const result = tail.then(action);
			tail = result;
			return result;
		};
		const observe = async (
			validate: (
				observation: RemoteAuthorityObservation,
			) => Promise<void>,
		) => {
			const listing =
				await this.recovery.getStableRootListing(assertConfiguration);
			await this.withAuthorityObservation(
				listing,
				assertConfiguration,
				validate,
			);
			assertConfiguration();
			return listing;
		};
		const readPresent = async (
			service: EncryptionCodec | null | undefined,
			validate: (
				observation: RemoteAuthorityObservation,
			) => Promise<void> = async () => {},
			readOnly = readOnlyCanonical,
		): Promise<SyncIndex | null> => {
			assertConfiguration();
			const listing = readOnly ? await observe(validate) : undefined;
			const resource = listing?.resources.find(
				(item) =>
					item.type === "file" && item.name === REMOTE_INDEX_FILENAME,
			);
			const discovery = listing
				? {
						path: resource ? this.getRemoteIndexPath() : null,
						resource,
						locks: this.recovery.selectIndexLocks(
							listing.resources,
						),
					}
				: await this.recovery.waitForCanonicalIndexFromStableRoot(
						assertConfiguration,
						(listing) =>
							this.withAuthorityObservation(
								listing,
								assertConfiguration,
								validate,
							),
					);
			assertConfiguration();
			if (readOnlyCanonical && discovery.locks.length > 0) {
				throw new RemoteIndexConcurrentModificationError(
					"Read-only canonical observation is locked",
				);
			}
			if (!discovery.path) {
				snapshot = undefined;
				snapshotService = undefined;
				return null;
			}
			if (
				!snapshot ||
				!this.canReuseCanonicalContent(
					snapshot.fingerprint,
					discovery.resource,
					discovery.locks,
				)
			) {
				if (
					prefetchedRaw &&
					this.canReuseCanonicalContent(
						prefetchedRaw.fingerprint,
						discovery.resource,
						discovery.locks,
					)
				) {
					const decoded = await this.decodeIndexSnapshot(
						prefetchedRaw.raw,
						false,
						service,
						undefined,
						prefetchedRaw.fingerprint,
					);
					snapshot = {
						raw: prefetchedRaw.raw,
						fingerprint: prefetchedRaw.fingerprint,
						...decoded,
					};
				} else {
					snapshot = await this.downloadIndexSnapshot(
						discovery.path,
						false,
						service,
						undefined,
						discovery.resource,
					);
				}
				prefetchedRaw = undefined;
				assertConfiguration();
				snapshotService = service;
			} else if (snapshotService !== service) {
				const decoded = await this.decodeIndexSnapshot(
					snapshot.raw,
					false,
					service,
					undefined,
					snapshot.fingerprint,
				);
				assertConfiguration();
				snapshot = { ...snapshot, ...decoded };
				snapshotService = service;
			}
			return cloneIndex(snapshot.index);
		};
		const read = (
			validate?: (
				observation: RemoteAuthorityObservation,
			) => Promise<void>,
		) =>
			enqueue(async () => {
				const index = await readPresent(undefined, validate);
				if (!index) {
					throw new RemoteIndexConcurrentModificationError(
						"Canonical index is missing",
					);
				}
				return index;
			});
		return Object.assign(read, {
			inspectServices: () =>
				enqueue(async () => {
					const listing = await observe(async () => {});
					const canonical = listing.resources.find(
						(entry) =>
							entry.name === REMOTE_INDEX_FILENAME &&
							entry.type === "file",
					);
					const manifest = listing.resources.find(
						(entry) =>
							entry.name === ENCRYPTION_MANIFEST_FILENAME &&
							entry.type === "file",
					);
					if (
						!canonical ||
						this.recovery.selectIndexLocks(listing.resources)
							.length ||
						!isHashStableContentFingerprint(
							this.yandexClient.getContentFingerprint(canonical),
						) ||
						(manifest &&
							!isHashStableContentFingerprint(
								this.yandexClient.getContentFingerprint(
									manifest,
								),
							))
					) {
						manifestRead =
							await this.downloadEncryptionManifestForGuard();
						assertConfiguration();
						return structuredClone(manifestRead);
					}
					const reads = await runWithConcurrencySettled<
						Awaited<
							ReturnType<
								YandexDiskClient["downloadStableRawFile"]
							>
						>
					>(
						[
							() =>
								this.yandexClient.downloadStableRawFile(
									this.getRemoteIndexPath(),
									canonical,
								),
							() =>
								manifest
									? this.yandexClient.downloadStableRawFile(
											this.getEncryptionManifestPath(),
											manifest,
										)
									: Promise.resolve(null),
						],
						Math.min(
							Math.max(1, this.settings.maxConcurrency || 1),
							4,
						),
						undefined,
						{ stopOnError: () => true },
					);
					assertConfiguration();
					const [canonicalRead, manifestResult] = reads;
					if (!canonicalRead || !manifestResult) {
						throw new Error(
							"Incomplete startup service observations",
						);
					}
					if (canonicalRead.status === "rejected") {
						throw canonicalRead.reason;
					}
					if (manifestResult.status === "rejected") {
						throw manifestResult.reason;
					}
					const raw = canonicalRead.value;
					const rawManifest = manifestResult.value;
					if (!raw || (manifest && !rawManifest)) {
						throw new RemoteIndexConcurrentModificationError(
							"Startup services disappeared during observation",
						);
					}
					prefetchedRaw = raw;
					manifestRead = rawManifest
						? {
								manifest: parseEncryptionManifest(
									JSON.parse(
										new TextDecoder().decode(
											rawManifest.raw,
										),
									) as Record<string, unknown>,
								),
								validationToken: `present:${rawManifest.fingerprint}`,
							}
						: { manifest: null, validationToken: "absent" };
					return structuredClone(manifestRead);
				}),
			assertCurrent: assertConfiguration,
			bind: (guard: () => void) => {
				activeGuards.push(guard);
				assertConfiguration();
			},
			close: () => {
				closed = true;
				snapshot = undefined;
				snapshotService = undefined;
				manifestRead = undefined;
				prefetchedRaw = undefined;
			},
			readWithCodecIfPresent: (service: EncryptionCodec | null) =>
				enqueue(() => readPresent(service)),
			inspectFormat: () =>
				enqueue(async (): Promise<RemoteCanonicalFormat> => {
					try {
						return (await readPresent(null, undefined, true))
							? "current"
							: "absent";
					} catch (error) {
						if (!(error instanceof LegacyIndexFormatError)) {
							throw error;
						}
						// Historical data never seeds a reusable current snapshot.
						const format =
							await this.inspectRemoteCanonicalFormat();
						assertConfiguration();
						return format;
					}
				}),
			manifest: () =>
				enqueue(async () => {
					assertConfiguration();
					if (manifestRead) {
						const cached = manifestRead;
						const token = cached.validationToken;
						const reusable =
							token === "absent" ||
							isHashStableContentFingerprint(
								token.slice("present:".length),
							);
						let unchanged = false;
						const listing = await observe(async (observation) => {
							unchanged =
								reusable &&
								(await this.isEncryptionManifestTokenCurrent(
									token,
									observation,
								));
						});
						if (
							unchanged &&
							this.recovery.selectIndexLocks(listing.resources)
								.length === 0
						) {
							return structuredClone(cached);
						}
						snapshot = undefined;
						snapshotService = undefined;
						prefetchedRaw = undefined;
					}
					manifestRead =
						await this.downloadEncryptionManifestForGuard();
					assertConfiguration();
					return structuredClone(manifestRead);
				}),

			load: (allowEpochAdoption = false) =>
				enqueue(async () => {
					assertConfiguration();
					let index =
						snapshot || prefetchedRaw
							? await readPresent(undefined)
							: null;
					if (!index) {
						const loaded = await this.loadRemoteIndexSnapshot(
							false,
							true,
							assertConfiguration,
						);
						assertConfiguration();
						snapshot = loaded;
						snapshotService = undefined;
						index = cloneIndex(loaded.index);
					}
					assertConfiguration();
					return cloneIndex(
						this.acceptLoadedIndex(index, allowEpochAdoption),
					);
				}),
		});
	}

	/** Keep composite metadata private and expire it before the next operation can use it. */
	private async withAuthorityObservation(
		listing: StableRootListing,
		assertCurrent: () => void,
		validate: (observation: RemoteAuthorityObservation) => Promise<void>,
	): Promise<void> {
		const observation = Object.freeze({}) as RemoteAuthorityObservation;
		this.authorityObservations.set(observation, { listing, assertCurrent });
		try {
			assertCurrent();
			await this.assertRemoteScope(observation);
			assertCurrent();
			await validate(observation);
			assertCurrent();
		} finally {
			this.authorityObservations.delete(observation);
		}
	}

	/** Copy fresh root metadata for read-only initial admission; this grants no write authority. */
	getObservedRootResources(
		observation: RemoteAuthorityObservation,
	): YandexResource[] {
		return JSON.parse(
			JSON.stringify(this.getAuthorityListing(observation).resources),
		) as YandexResource[];
	}

	private getAuthorityListing(
		observation: RemoteAuthorityObservation,
	): StableRootListing {
		const current = this.authorityObservations.get(observation);
		if (!current) {
			throw new StorageScopeError(
				"Read observation expired or belongs to another evaluation",
			);
		}
		current.assertCurrent();
		return current.listing;
	}

	/** Only a stable hash and an unlocked root permit reuse of validated canonical bytes. */
	private canReuseCanonicalContent(
		fingerprint: string | null | undefined,
		resource: YandexResource | undefined,
		locks: YandexResource[],
	): boolean {
		return (
			locks.length === 0 &&
			isHashStableContentFingerprint(fingerprint) &&
			matchesStableContentFingerprint(fingerprint, resource ?? null)
		);
	}

	/** Read canonical with an explicit target codec without changing local state. */
	async readCanonicalIndexWithCodec(
		service: EncryptionCodec | null,
	): Promise<SyncIndex> {
		const index = await this.readCanonicalIndexWithCodecIfPresent(service);
		if (index) {
			return index;
		}
		throw new RemoteIndexConcurrentModificationError(
			"Canonical index is missing",
		);
	}

	/** Read explicitly decoded canonical when one already exists. */
	async readCanonicalIndexWithCodecIfPresent(
		service: EncryptionCodec | null,
	): Promise<SyncIndex | null> {
		const discovery =
			await this.recovery.waitForCanonicalIndexFromStableRoot();
		if (!discovery.path) {
			return null;
		}
		return (
			await this.downloadIndexSnapshot(
				discovery.path,
				false,
				service,
				undefined,
				discovery.resource,
			)
		).index;
	}

	/** Adopt explicitly decoded canonical only inside matching target recovery. */
	async loadRemoteIndexWithTargetCodec(
		service: EncryptionCodec | null,
	): Promise<SyncIndex> {
		if (this.targetRecoveryMaintenanceId === null) {
			throw new Error(
				"Explicit target codec requires recovery ownership",
			);
		}
		const index = await this.readCanonicalIndexWithCodec(service);
		if (!isTargetRecoveryIndex(index, this.targetRecoveryMaintenanceId)) {
			throw new Error("Target recovery authority changed");
		}
		this.assertEpochCompatible(index);
		this.assertMaintenanceCompatible(index);
		this.remoteIndex = cloneIndex(index);
		this.loadedRemoteIndex = cloneIndex(index);
		return this.remoteIndex;
	}

	/**
	 * Read canonical state for post-commit repair, reusing a same-session proof
	 * only when a stable root listing still exposes the same content hash.
	 */
	async readCanonicalIndexForRepair(
		proof?: CanonicalCommitProof,
	): Promise<SyncIndex> {
		const discovery =
			await this.recovery.waitForCanonicalIndexFromStableRoot();
		if (!discovery.path || !discovery.resource) {
			throw new RemoteIndexConcurrentModificationError(
				"Canonical index is missing during physical repair",
			);
		}
		if (
			proof &&
			this.canReuseCanonicalContent(
				proof.contentFingerprint,
				discovery.resource,
				discovery.locks,
			)
		) {
			logger.debug("Post-commit canonical proof reused", {
				postCommitCanonical: "proof",
				canonicalRevision: proof.revision,
				canonicalFingerprint: shortenDiagnosticValue(
					proof.contentFingerprint,
				),
			});
			return cloneIndex(proof.index);
		}
		const snapshot = await this.downloadIndexSnapshot(
			discovery.path,
			false,
			undefined,
			undefined,
			discovery.resource,
		);
		logger.debug("Post-commit canonical proof refreshed", {
			postCommitCanonical: "refreshed",
			canonicalRevision: snapshot.index.revision,
			canonicalFingerprint: shortenDiagnosticValue(snapshot.fingerprint),
		});
		return snapshot.index;
	}

	/**
	 * Refresh the reducer baseline from the current canonical file before a new
	 * realtime mutation is staged. Call only while the sync coordinator is held.
	 */
	async refreshCanonicalForMutation(): Promise<SyncIndex> {
		const canonical = await this.readCanonicalIndex();
		this.remoteIndex = cloneIndex(canonical);
		this.loadedRemoteIndex = cloneIndex(canonical);
		return canonical;
	}

	/** Verify that Force did not replace the adopted generation mid-session. */
	async assertCanonicalEpoch(epoch: string): Promise<void> {
		const canonical = await this.readCanonicalIndex();
		if (canonical.epoch !== epoch) {
			throw new IndexEpochMismatchError(epoch, canonical.epoch);
		}
	}

	getMaintenance(): IndexMaintenance | undefined {
		return this.remoteIndex.maintenance
			? this.cloneValue(this.remoteIndex.maintenance)
			: undefined;
	}

	setMaintenance(maintenance: IndexMaintenance): void {
		this.remoteIndex.maintenance = this.cloneValue(maintenance);
	}

	clearMaintenance(id: string): void {
		if (this.remoteIndex.maintenance?.id !== id) {
			return;
		}
		delete this.remoteIndex.maintenance;
	}

	/**
	 * Save remote index; optional authority validation runs on the acquired lock before reduction.
	 */
	async saveRemoteIndex(
		assertLatest?: (index: Readonly<SyncIndex>) => void,
	): Promise<CanonicalCommitProof> {
		const save = this.saveChain.then(() =>
			this.saveRemoteIndexWithRetry(assertLatest),
		);
		this.saveChain = save.then(
			() => undefined,
			() => undefined,
		);
		return await save;
	}

	private async saveRemoteIndexWithRetry(
		assertLatest?: (index: Readonly<SyncIndex>) => void,
	): Promise<CanonicalCommitProof> {
		return await commitCanonicalIndex({
			client: this.yandexClient,
			recovery: this.recovery,
			assertRemoteScope: () => this.assertRemoteScope(),
			getRemotePath: () => this.settings.remotePath,
			getCanonicalPath: () => this.getRemoteIndexPath(),
			getDeviceId: () => this.settings.deviceId,
			createTransactionId: () => this.createTransactionId(),
			getDesired: () => ({
				revision: this.remoteIndex.revision,
				epoch: this.remoteIndex.epoch,
			}),
			getLoadedRevision: () => this.loadedRemoteIndex.revision,
			getPendingCounts: () => ({
				mutations: this.getPendingMutations().length,
				physicalActions: this.getPendingPhysicalActions().length,
			}),
			getCodecs: () => ({
				source: this.transitionIndexReadService,
				target: this.transitionIndexWriteService,
			}),
			isReplacing: () => this.replaceRemoteOnNextSave,
			allowLegacyWrite: () => this.allowLegacyWriteOnce,
			assertForceSourceSupported: () => this.assertForceSourceSupported(),
			assertForceLocksUnchanged: (path) =>
				this.assertForceLocksUnchanged(path),
			isLockContention: (error) => this.isLockContention(error),
			readSnapshot: (...args) => this.downloadIndexSnapshot(...args),
			readUnparsedSnapshot: (path) =>
				this.downloadUnparsedIndexSnapshot(path),
			serialize: (index) => this.serializeCurrentIndex(index),
			reduceLockedIndex: (...args) => {
				assertLatest?.(cloneIndex(args[0].index));
				return this.reduceLockedIndex(...args);
			},
			acceptCommit: (index, proof) =>
				this.finalizeCommittedTransaction(index, proof),
		});
	}

	/** Snapshot causal inputs only after acquiring the canonical lock. */
	private async reduceLockedIndex(
		original: IndexFileSnapshot,
		initializedIndex: SyncIndex | null,
		lockPath: string,
		transactionContext: Record<string, unknown>,
	): Promise<{ latest: SyncIndex; merged: SyncIndex }> {
		const latest = this.replaceRemoteOnNextSave
			? this.createReplacementBaseline(original.index)
			: original.index;
		if (this.replaceRemoteOnNextSave) {
			const expected = this.forcePreflightCanonical;
			const matchesPreflight =
				expected?.state === "present"
					? (await computeSha256(original.raw)) === expected.rawSha256
					: initializedIndex !== null &&
						sameIndexValue(original.index, initializedIndex);
			if (!matchesPreflight) {
				throw new ForceBackupStaleError(
					"Acquired canonical differs from Force preflight",
				);
			}
		}
		logger.debug("Latest canonical state loaded from lock", {
			...transactionContext,
			latestRevision: latest.revision,
			latestEpoch: shortenDiagnosticValue(latest.epoch),
			maintenance: latest.maintenance
				? {
						transitionId: shortenDiagnosticValue(
							latest.maintenance.id,
						),
						kind: latest.maintenance.kind,
						phase: latest.maintenance.phase,
					}
				: null,
		});
		if (!this.replaceRemoteOnNextSave) {
			this.assertEpochCompatible(latest);
			this.assertMaintenanceCompatible(latest);
		}
		this.rejectedPuts = [];
		const mode: CanonicalMergeMode = this.replaceRemoteOnNextSave
			? { kind: "replacement", replacementDeletedAt: Date.now() }
			: this.targetRecoveryMaintenanceId !== null
				? {
						kind: "target-recovery",
						maintenanceId: this.targetRecoveryMaintenanceId,
					}
				: this.encryptionReplacementCommit
					? { kind: "encryption-replacement" }
					: this.physicalRewriteOnNextSave
						? { kind: "physical-rewrite" }
						: { kind: "normal" };
		const result = mergeDesiredIndex({
			latest,
			loadedBase: this.loadedRemoteIndex,
			desired: this.remoteIndex,
			deviceId: this.settings.deviceId,
			baseRevision: this.loadedRemoteIndex.revision,
			mode,
			completedMoveIds: new Set(this.completedMoveIds),
			putBaselines: this.operationStore
				.getMutations()
				.map(({ type, path, baselineSha256 }) => ({
					type,
					path,
					baselineSha256,
				})),
		});
		const merged = result.index;
		this.rejectedPuts = result.rejectedPuts;
		for (const diagnostic of result.diagnostics) {
			logger.debug("File mutation reduced without logical write", {
				...diagnostic,
				deviceId: shortenDiagnosticValue(diagnostic.deviceId),
			});
		}
		if (this.replaceRemoteOnNextSave) {
			await this.assertForceLocksUnchanged(lockPath);
		}
		logger.debug("Canonical reducer completed", {
			...transactionContext,
			latestRevision: latest.revision,
			mergedRevision: merged.revision,
			fileEntries: Object.keys(merged.files).length,
			folderTombstones: Object.keys(merged.folderTombstones).length,
			pendingMoves: Object.keys(merged.moves).length,
		});
		return { latest, merged };
	}

	/** Reject unsupported historical or malformed data before Force takes a lock. */
	private async assertForceSourceSupported(): Promise<void> {
		const actual = await this.captureForceCanonicalProof();
		if (
			this.forcePreflightCanonical !== null &&
			!sameIndexValue(this.forcePreflightCanonical, actual)
		) {
			throw new ForceBackupStaleError(
				"Canonical or index locks changed after Force preflight",
			);
		}
		this.forcePreflightCanonical = actual;
	}

	/** Another transaction cannot join the set that this Force is authorized to replace. */
	private async assertForceLocksUnchanged(
		ownedLockPath: string,
	): Promise<void> {
		const { resources } = await this.recovery.getStableRootListing();
		const locks = this.recovery.observeIndexLocks(
			resources.filter(
				(resource) =>
					joinPath(this.settings.remotePath, resource.name) !==
					ownedLockPath,
			),
		);
		if (!sameIndexValue(locks, this.forcePreflightCanonical?.locks ?? [])) {
			throw new ForceBackupStaleError(
				"Index locks changed during Force replacement",
			);
		}
	}

	/**
	 * Update file metadata in local index
	 */
	updateLocalFile(path: string, metadata: FileMetadata): void {
		setRecordValue(this.localState.files, path, {
			...metadata,
			baseRevision:
				metadata.baseRevision ?? this.localState.observedRevision,
			lastModifiedBy: metadata.lastModifiedBy ?? this.settings.deviceId,
		});
	}

	/**
	 * Mark file as deleted in local index
	 */
	markLocalFileDeleted(
		path: string,
		deletedByFolder?: string,
		mutationSeq?: number,
	): void {
		const meta = this.localState.files[path];
		if (!meta) {
			return;
		}
		if (!meta.deleted) {
			meta.deleted = true;
			meta.deletedAt = Date.now();
		}
		if (deletedByFolder) {
			meta.deletedByFolder = deletedByFolder;
		}
		meta.lastModifiedBy = this.settings.deviceId;
		if (mutationSeq !== undefined) {
			meta.mutationSeq = mutationSeq;
		}
	}

	/**
	 * Remove file from local index
	 */
	removeFromLocalIndex(path: string): void {
		delete this.localState.files[path];
	}

	/**
	 * Update file metadata in remote index
	 */
	updateRemoteFile(path: string, metadata: FileMetadata): void {
		setRecordValue(this.remoteIndex.files, path, {
			...metadata,
			baseRevision:
				metadata.baseRevision ?? this.loadedRemoteIndex.revision,
			lastModifiedBy: metadata.lastModifiedBy ?? this.settings.deviceId,
		});
	}

	/**
	 * Stamp `remoteMtime` on remote index entries that are missing it, using
	 * fresh targeted metadata. Existing stamps remain unchanged. Unknown or
	 * missing resources retain fallback metadata for causal reconciliation;
	 * an absent result never authorizes deletion or acknowledges content.
	 */
	applyServerMtimes(remoteFiles: Map<string, FileMetadata>): boolean {
		let stamped = 0;
		for (const [path, meta] of Object.entries(this.remoteIndex.files)) {
			if (typeof meta.remoteMtime === "number") {
				continue;
			}
			if (meta.deleted) {
				continue;
			}
			const live = remoteFiles.get(path);
			if (!live) {
				continue;
			}
			if (typeof live.remoteMtime !== "number") {
				continue;
			}
			setRecordValue(this.remoteIndex.files, path, {
				...meta,
				remoteMtime: live.remoteMtime,
				remoteFingerprint: live.remoteFingerprint,
			});
			stamped++;
		}
		if (stamped > 0) {
			logger.debug(
				`[IndexManager] Stamped remoteMtime on ${stamped} remote index entries from batch re-read`,
			);
		}
		return stamped > 0;
	}

	/**
	 * Mark file as deleted in remote index
	 */
	markRemoteFileDeleted(
		path: string,
		deletedByFolder?: string,
		baseRevision = this.loadedRemoteIndex.revision,
		mutationSeq?: number,
	): void {
		const meta = this.remoteIndex.files[path] ||
			this.localState.files[path] || {
				path,
				sha256: "",
				size: 0,
				mtime: 0,
				syncedAt: 0,
			};
		setRecordValue(this.remoteIndex.files, path, meta);
		if (meta.deleted) {
			return;
		}
		if (mutationSeq === undefined) {
			throw new Error(
				`A live canonical entry cannot be deleted without a mutation sequence: ${path}`,
			);
		}
		meta.deleted = true;
		meta.deletedAt = Date.now();
		meta.deletedByFolder = deletedByFolder;
		meta.baseRevision = baseRevision;
		meta.lastModifiedBy = this.settings.deviceId;
		meta.mutationSeq = mutationSeq;
	}

	/** Apply an existing canonical folder tombstone without changing its author. */
	markRemoteFileDeletedByCanonicalFolder(
		path: string,
		folderPath: string,
	): void {
		const tombstone = this.remoteIndex.folderTombstones[folderPath];
		if (!tombstone) {
			throw new Error(
				`Canonical folder tombstone is missing: ${folderPath}`,
			);
		}
		const meta =
			this.remoteIndex.files[path] ?? this.localState.files[path];
		if (!meta || meta.deleted) {
			return;
		}
		setRecordValue(this.remoteIndex.files, path, {
			...meta,
			deleted: true,
			deletedAt: tombstone.deletedAt,
			deletedByFolder: folderPath,
			baseRevision: tombstone.baseRevision,
			lastModifiedBy: tombstone.lastModifiedBy,
			mutationSeq: tombstone.mutationSeq,
		});
	}

	/**
	 * Record deletion of a folder as a prefix tombstone.
	 */
	markFolderDeleted(
		path: string,
		deletedAt = Date.now(),
		baseRevision: number | null = this.loadedRemoteIndex.revision,
		mutationSeq?: number,
	): void {
		const normalized = path.replace(/\/+$/, "");
		const tombstone: FolderTombstone = {
			path: normalized,
			deletedAt,
			changedRevision: this.remoteIndex.revision,
			baseRevision: baseRevision ?? 0,
			lastModifiedBy: this.settings.deviceId,
			mutationSeq,
		};
		setRecordValue(
			this.remoteIndex.folderTombstones,
			normalized,
			tombstone,
		);
		setRecordValue(this.localState.folderTombstones, normalized, {
			...tombstone,
		});
	}

	/**
	 * Record a logical move so another device can finish a partially applied
	 * physical rename.
	 */
	recordMove(
		id: string,
		fromPath: string,
		toPath: string,
		kind: "file" | "folder",
		baseRevision = this.loadedRemoteIndex.revision,
		mutationSeq?: number,
	): void {
		setRecordValue(this.remoteIndex.moves, id, {
			id,
			fromPath,
			toPath,
			kind,
			baseRevision,
			changedRevision: this.remoteIndex.revision,
			pending: true,
			lastModifiedBy: this.settings.deviceId,
			mutationSeq,
		});
	}

	completeMove(id: string): void {
		if (!this.remoteIndex.moves[id]) {
			return;
		}
		delete this.remoteIndex.moves[id];
		this.completedMoveIds.add(id);
	}

	/**
	 * Get files list from remote storage
	 */
	async getRemoteFiles(
		directoryPages?: Map<string, number>,
	): Promise<Map<string, FileMetadata>> {
		logger.info("Getting remote files list...");

		const resources = await this.yandexClient.getResourcesRecursive(
			this.settings.remotePath,
			true,
			this.settings.maxConcurrency,
			false,
			undefined,
			true,
			directoryPages
				? (path, pages) => {
						directoryPages.set(path, pages);
					}
				: undefined,
		);

		const result = await this.remoteResourcesToFiles(resources);

		logger.info(`Found ${result.size} remote files`);
		return result;
	}

	/** Refresh only live entries without stamps, including entries predating this upload. */
	async refreshMissingServerMetadata(
		directoryPages: ReadonlyMap<string, number>,
		assertCurrent?: () => void,
	): Promise<Map<string, FileMetadata>> {
		const resources: YandexResource[] = [];
		const paths = Object.entries(this.remoteIndex.files)
			.filter(
				([path, meta]) =>
					!meta.deleted &&
					typeof meta.remoteMtime !== "number" &&
					this.vaultAdapter.shouldSync(path),
			)
			.map(([path]) => joinPath(this.settings.remotePath, path));
		await this.yandexClient.collectLogicalMetadata(
			paths,
			this.settings.maxConcurrency,
			async (_path, resource) => {
				if (resource) {
					resources.push(resource);
				}
			},
			{ knownDirectoryPages: directoryPages, assertCurrent },
		);
		return await this.remoteResourcesToFiles(resources);
	}

	/** Apply the ordinary codec, maintenance and user filters to observed resources. */
	private async remoteResourcesToFiles(
		resources: YandexResource[],
	): Promise<Map<string, FileMetadata>> {
		const result = new Map<string, FileMetadata>();
		const cleanupPaths = new Set(
			(this.remoteIndex.maintenance?.cleanup ?? []).map((cleanup) =>
				normalizePath(cleanup.path),
			),
		);

		for (const rawResource of resources) {
			// Skip directories
			if (rawResource.type !== "file") {
				continue;
			}
			if (rawResource.path.includes("\\")) {
				throw new PortablePathCollisionError();
			}
			const rawLocalPath = toLocalPath(
				rawResource.path,
				this.settings.remotePath,
			);
			if (
				isPreservedRawPath(
					rawLocalPath,
					this.remoteIndex.epochAdoption?.preservedRawPaths ?? [],
				) ||
				cleanupPaths.has(normalizePath(rawLocalPath)) ||
				this.vaultAdapter.shouldInspectRaw?.(
					rawLocalPath,
					this.yandexClient.hasEncryptionService(),
				) === false
			) {
				continue;
			}
			const resource =
				await this.yandexClient.toLogicalResource(rawResource);

			const localPath = toLocalPath(
				resource.path,
				this.settings.remotePath,
			);

			// Skip service/protected paths.
			if (isProtectedPath(localPath)) {
				continue;
			}

			// Check if file should be synchronized
			if (!this.vaultAdapter.shouldSync(localPath)) {
				continue;
			}

			const mtime = new Date(resource.modified).getTime();

			result.set(localPath, {
				path: localPath,
				sha256: resource.sha256 || "",
				remoteFingerprint:
					getPhysicalResourceFingerprint(resource) ?? undefined,
				size: resource.size || 0,
				mtime,
				// Server-side modification time, stored separately so remote-side
				// change detection can compare server timestamps against server
				// timestamps, avoiding clock skew with the local filesystem.
				remoteMtime: Number.isFinite(mtime) ? mtime : undefined,
				syncedAt: 0,
			});
		}

		return result;
	}

	/**
	 * Update last synchronization time
	 */
	updateSyncTime(): void {
		this.remoteIndex.lastSyncTime = Date.now();
	}

	/**
	 * Preserve causal deletion history until an explicit Force sync rebuilds
	 * the index.
	 */
	cleanupDeletedFiles(maxAge: number = 7 * 24 * 60 * 60 * 1000): boolean {
		void maxAge;
		return false;
	}

	/**
	 * Check if remote folder exists
	 */
	async remotePathExists(): Promise<boolean> {
		const resource = await this.yandexClient.getResource(
			this.settings.remotePath,
			1000,
			0,
			true,
		);
		return resource !== null;
	}

	/**
	 * Create remote folder
	 */
	async createRemotePath(): Promise<void> {
		await this.yandexClient.createFolderRecursive(this.settings.remotePath);
	}

	private getRemoteIndexPath(): string {
		return joinPath(this.settings.remotePath, REMOTE_INDEX_FILENAME);
	}

	/** Validate the exact JSON representation before publishing a current index. */
	private serializeCurrentIndex(index: SyncIndex): string {
		const content = JSON.stringify(index, null, 2);
		this.normalizeParsedIndex(JSON.parse(content) as unknown, false, false);
		return content;
	}

	private async downloadIndexSnapshot(
		path: string,
		allowLegacy: boolean,
		serviceOverride?: EncryptionCodec | null,
		codecLabel?: IndexCodec,
		expectedResource?: YandexResource,
	): Promise<IndexFileSnapshot> {
		const snapshot = await this.yandexClient.downloadStableRawFile(
			path,
			expectedResource,
		);
		if (!snapshot) {
			throw new RemoteIndexConcurrentModificationError(
				`Index resource disappeared while reading ${path}`,
			);
		}
		const decoded = await this.decodeIndexSnapshot(
			snapshot.raw,
			allowLegacy,
			serviceOverride,
			codecLabel,
			snapshot.fingerprint,
		);
		return {
			raw: snapshot.raw,
			index: decoded.index,
			fingerprint: snapshot.fingerprint,
			codec: decoded.codec,
		};
	}

	private async downloadUnparsedIndexSnapshot(
		path: string,
	): Promise<IndexFileSnapshot> {
		const snapshot = await this.yandexClient.downloadStableRawFile(path);
		if (!snapshot) {
			throw new RemoteIndexConcurrentModificationError(
				`Index resource disappeared while reading ${path}`,
			);
		}
		return {
			raw: snapshot.raw,
			index: createEmptyIndex(""),
			fingerprint: snapshot.fingerprint,
			codec: "source",
		};
	}

	private async decodeIndexSnapshot(
		raw: ArrayBuffer,
		allowLegacy: boolean,
		serviceOverride?: EncryptionCodec | null,
		codecLabel?: IndexCodec,
		fingerprint: string | null = null,
	): Promise<{ index: SyncIndex; codec: IndexCodec }> {
		if (serviceOverride !== undefined) {
			const codec =
				codecLabel ?? (serviceOverride ? "current" : "plaintext");
			const decoded = await this.tryDecodeIndexCodec(
				raw,
				serviceOverride,
				codec,
			);
			if ("attempt" in decoded) {
				throw await this.createUnreadableIndexError(raw, fingerprint, [
					decoded.attempt,
				]);
			}
			logger.debug("Decoded remote index snapshot", { codec });
			return {
				index: this.normalizeParsedIndex(
					decoded.data,
					allowLegacy,
					serviceOverride !== null,
				),
				codec,
			};
		}

		const attempts: IndexDecodeAttempt[] = [];
		const current = await this.tryDecodeIndexCodec(
			raw,
			undefined,
			"current",
		);
		if ("data" in current) {
			logger.debug("Decoded remote index snapshot", { codec: "current" });
			return {
				index: this.normalizeParsedIndex(
					current.data,
					allowLegacy,
					this.yandexClient.hasEncryptionService(),
				),
				codec: "current",
			};
		}
		attempts.push(current.attempt);

		throw await this.createUnreadableIndexError(raw, fingerprint, attempts);
	}

	/** Decode and parse one codec without catching semantic index errors. */
	private async tryDecodeIndexCodec(
		raw: ArrayBuffer,
		service: EncryptionCodec | null | undefined,
		codec: IndexCodec,
	): Promise<IndexCodecAttemptResult> {
		let content: ArrayBuffer;
		try {
			content = await this.yandexClient.decodeServiceFileContent(
				raw,
				service,
			);
		} catch (error) {
			return {
				attempt: {
					codec,
					stage: "decrypt",
					errorName: this.getErrorName(error),
				},
			};
		}
		try {
			return { data: this.parseIndexJson(content) };
		} catch (error) {
			if (!(error instanceof SyntaxError)) {
				throw error;
			}
			return {
				attempt: {
					codec,
					stage: "json",
					errorName: this.getErrorName(error),
				},
			};
		}
	}

	private parseIndexJson(content: ArrayBuffer): unknown {
		return JSON.parse(new TextDecoder().decode(content)) as unknown;
	}

	private normalizeParsedIndex(
		data: unknown,
		allowLegacy: boolean,
		decodedWithEncryption: boolean,
	): SyncIndex {
		if (!isJsonRecord(data)) {
			throw new InvalidCurrentIndexError("root", "must be an object");
		}
		const formatKind = classifyIndexFormat(data);
		if (formatKind !== "current") {
			if (formatKind === "legacy" && decodedWithEncryption) {
				throw new UnsupportedHistoricalDataError(
					"Encrypted legacy canonical data is unsupported",
				);
			}
			if (allowLegacy && formatKind === "legacy") {
				return this.normalizeLegacyIndex(data);
			}
			if (formatKind === "unsupported") {
				throw new UnsupportedHistoricalDataError(
					"Remote canonical data uses an unsupported historical format",
				);
			}
			throw new LegacyIndexFormatError();
		}
		validateCurrentIndexShape(data);
		validateCurrentIndexCausality(data);
		return cloneIndex(data);
	}

	private async createUnreadableIndexError(
		raw: ArrayBuffer,
		fingerprint: string | null,
		attempts: IndexDecodeAttempt[],
	): Promise<UnreadableRemoteIndexError> {
		const rawSha256 = await computeSha256(raw);
		const error = new UnreadableRemoteIndexError({
			rawSize: raw.byteLength,
			fingerprint,
			rawSha256,
			attempts,
		});
		logger.warn("Remote index snapshot is unreadable", {
			rawSize: error.rawSize,
			fingerprint: shortenDiagnosticValue(error.fingerprint),
			rawSha256: shortenDiagnosticValue(error.rawSha256),
			attempts: error.attempts,
		});
		return error;
	}

	private getErrorName(error: unknown): string {
		return error instanceof Error ? error.name : typeof error;
	}

	/** Convert only the exact plaintext canonical shape written by stable 1.0/1.1. */
	private normalizeLegacyIndex(data: JsonRecord): SyncIndex {
		const stable = parseStable1xIndex(data);
		if (!stable) {
			throw new UnsupportedHistoricalDataError(
				"Legacy canonical data is not an exact stable 1.0/1.1 index",
			);
		}
		const normalized = createEmptyIndex(stable.deviceId);
		normalized.lastSyncTime = stable.lastSyncTime;
		for (const [path, metadata] of Object.entries(stable.files)) {
			setRecordValue(normalized.files, path, {
				path,
				sha256: metadata.sha256,
				size: metadata.size,
				mtime: metadata.mtime,
				syncedAt: metadata.syncedAt,
				deleted: metadata.deleted,
				deletedAt: metadata.deletedAt,
				lastModifiedBy: metadata.lastModifiedBy,
				mutationSeq: 0,
				changedRevision: 0,
				baseRevision: 0,
			});
		}
		return normalized;
	}

	private createReplacementBaseline(previous: SyncIndex): SyncIndex {
		const baseline = createEmptyIndex("", this.remoteIndex.epoch);
		baseline.revision = Math.max(
			this.localState.observedRevision,
			this.remoteIndex.revision,
		);
		baseline.files = protectRecord(this.cloneValue(previous.files));
		return baseline;
	}

	private async cleanupForceReplacedLocks(
		proof: CanonicalCommitProof,
	): Promise<void> {
		for (const lock of this.forcePreflightCanonical?.locks ?? []) {
			await this.recovery.deleteObservedIndexLock(lock, this.remoteIndex);
		}
		await this.assertForceCleanupComplete(proof);
	}

	/** A successful normal full alone does not prove that Force orphan cleanup finished. */
	async assertForceCleanupComplete(
		proof?: CanonicalCommitProof,
	): Promise<void> {
		const { resources } = await this.recovery.getStableRootListing();
		const resource = resources.find(
			(resource) =>
				resource.type === "file" &&
				resource.name === REMOTE_INDEX_FILENAME,
		);
		if (!resource || this.recovery.selectIndexLocks(resources).length > 0) {
			throw new AmbiguousRemoteIndexLockError(
				"Force replacement still has unresolved index locks",
			);
		}
		if (
			proof &&
			isHashStableContentFingerprint(proof.contentFingerprint) &&
			matchesStableContentFingerprint(proof.contentFingerprint, resource)
		) {
			return;
		}
		const snapshot = await this.downloadIndexSnapshot(
			this.getRemoteIndexPath(),
			false,
			undefined,
			undefined,
			resource,
		);
		if (snapshot.index.maintenance) {
			throw new RemoteMaintenanceActiveError(
				snapshot.index.maintenance.id,
				snapshot.index.maintenance.initiatedBy,
			);
		}
	}

	private async finalizeCommittedTransaction(
		merged: SyncIndex,
		proof: CanonicalCommitProof,
	): Promise<void> {
		this.remoteIndex = merged;
		this.loadedRemoteIndex = cloneIndex(merged);
		this.completedMoveIds.clear();
		this.allowLegacyWriteOnce = false;
		const replacedRemote = this.replaceRemoteOnNextSave;
		this.replaceRemoteOnNextSave = false;
		if (!replacedRemote) {
			return;
		}

		this.finalizeForceEpoch(merged);
		try {
			await this.cleanupForceReplacedLocks(proof);
		} catch (cleanupError) {
			throw new RemoteIndexTransactionError(
				"Canonical index committed but orphan lock cleanup is incomplete",
				"RemoteIndexCleanupError",
				"committed",
				"committed",
				false,
				cleanupError,
			);
		} finally {
			this.forcePreflightCanonical = null;
		}
	}

	private cloneValue<T>(value: T): T {
		return JSON.parse(JSON.stringify(value)) as T;
	}

	private createTransactionId(): string {
		return `${Date.now().toString(36)}.${Math.random()
			.toString(36)
			.slice(2, 10)}`;
	}

	/** Re-read cleanup ownership independently of physical content identity. */
	async assertMaintenanceAuthority(
		epoch: string,
		expected: IndexMaintenance,
		readCanonical: () => Promise<SyncIndex> = () =>
			this.readCanonicalIndex(),
	): Promise<SyncIndex> {
		const current = await readCanonical();
		const maintenance = current.maintenance;
		if (
			current.epoch !== epoch ||
			!maintenance ||
			maintenance.id !== expected.id ||
			maintenance.kind !== expected.kind ||
			maintenance.initiatedBy !== expected.initiatedBy ||
			maintenance.sourceRevision !== expected.sourceRevision ||
			maintenance.targetRevision !== expected.targetRevision ||
			!sameIndexValue(maintenance.source, expected.source) ||
			!sameIndexValue(maintenance.target, expected.target) ||
			!sameIndexValue(maintenance.replacement, expected.replacement) ||
			maintenance.phase !== expected.phase
		) {
			throw new RemoteIndexConcurrentModificationError(
				"Encryption cleanup authority changed",
			);
		}
		return current;
	}

	private assertEpochCompatible(index: SyncIndex): void {
		if (isTargetRecoveryIndex(index, this.targetRecoveryMaintenanceId)) {
			return;
		}
		const observedEpoch = this.localState.observedEpoch;
		if (
			observedEpoch &&
			index.epoch !== observedEpoch &&
			!this.allowLegacyWriteOnce &&
			index.epoch !== this.epochAdoptionTarget
		) {
			throw new IndexEpochMismatchError(observedEpoch, index.epoch);
		}
	}

	private assertMaintenanceCompatible(index: SyncIndex): void {
		const maintenance = index.maintenance;
		if (maintenance?.kind === "force" && !this.forceScope) {
			throw new ForceRecoveryPendingError();
		}
		const allowedTargetRecovery =
			maintenance?.id === this.targetRecoveryMaintenanceId &&
			(maintenance.phase === "index-committed" ||
				maintenance.phase === "cleanup" ||
				maintenance.phase === "stable");
		if (
			maintenance &&
			maintenance.initiatedBy !== this.settings.deviceId &&
			!allowedTargetRecovery
		) {
			throw new RemoteMaintenanceActiveError(
				maintenance.id,
				maintenance.initiatedBy,
			);
		}
	}

	private isLockContention(error: unknown): boolean {
		return (
			error instanceof YandexApiError &&
			(error.status === 404 ||
				error.status === 409 ||
				error.status === 423)
		);
	}

	// ============================================================================
	// Encryption salt management
	// ============================================================================

	private getEncryptionManifestPath(): string {
		return joinPath(this.settings.remotePath, ENCRYPTION_MANIFEST_FILENAME);
	}

	/**
	 * Upload encryption manifest to Yandex Disk (raw — no encryption).
	 */
	async uploadEncryptionManifest(
		manifest: EncryptionManifest,
	): Promise<void> {
		const content = JSON.stringify(manifest, null, 2);
		await this.yandexClient.uploadFile(
			this.getEncryptionManifestPath(),
			content,
			false,
			true,
		);
		logger.info("Encryption manifest uploaded to remote");
	}

	/**
	 * Download encryption manifest from Yandex Disk (raw — no decryption).
	 * Returns null only if manifest file doesn't exist.
	 */
	async downloadEncryptionManifest(): Promise<RemoteEncryptionManifest | null> {
		return (await this.downloadEncryptionManifestForGuard()).manifest;
	}

	/** Read the manifest and retain its opaque content-version validation token. */
	async downloadEncryptionManifestForGuard(): Promise<EncryptionManifestRead> {
		const snapshot = await this.yandexClient.downloadStableRawFile(
			this.getEncryptionManifestPath(),
		);
		if (!snapshot) {
			return { manifest: null, validationToken: "absent" };
		}
		const data = JSON.parse(
			new TextDecoder().decode(snapshot.raw),
		) as Record<string, unknown>;
		return {
			manifest: parseEncryptionManifest(data),
			validationToken: `present:${snapshot.fingerprint}`,
		};
	}

	/** Validate a manifest token without downloading unchanged content. */
	async isEncryptionManifestTokenCurrent(
		token: string,
		observation?: RemoteAuthorityObservation,
	): Promise<boolean> {
		const listing = observation
			? this.getAuthorityListing(observation)
			: undefined;
		const resource = listing
			? (listing.resources.find(
					(item) =>
						item.name === ENCRYPTION_MANIFEST_FILENAME &&
						item.type === "file",
				) ?? null)
			: await this.yandexClient.getResource(
					this.getEncryptionManifestPath(),
					1,
					0,
					true,
				);
		if (
			listing?.resources.some(
				(item) =>
					item.name === ENCRYPTION_MANIFEST_FILENAME &&
					item.type !== "file",
			)
		) {
			return false;
		}
		if (token === "absent") {
			return resource === null;
		}
		if (!resource) {
			return false;
		}
		const fingerprint = this.yandexClient.getContentFingerprint(resource);
		if (!fingerprint) {
			const current = await this.downloadEncryptionManifestForGuard();
			return current.validationToken === token;
		}
		return token === `present:${fingerprint}`;
	}

	/**
	 * Delete encryption manifest from Yandex Disk.
	 */
	async deleteEncryptionManifest(): Promise<void> {
		await this.yandexClient.deleteResource(
			this.getEncryptionManifestPath(),
			false,
			true,
		);
		logger.info("Encryption manifest deleted from remote");
	}

	/**
	 * Get raw remote paths and immutable server identities for guarded cleanup.
	 */
	async getRemoteRawFileSnapshots(): Promise<
		Array<{ path: string; fingerprint: string }>
	> {
		let resources: YandexResource[];
		try {
			resources = await this.yandexClient.getResourcesRecursive(
				this.settings.remotePath,
				true,
				Math.min(this.settings.maxConcurrency, 4),
			);
		} catch (e) {
			if (this.isNotFoundError(e)) {
				return [];
			}
			throw e;
		}
		const result: Array<{ path: string; fingerprint: string }> = [];

		for (const resource of resources) {
			if (resource.type !== "file") {
				continue;
			}

			const localPath = toLocalPath(
				resource.path,
				this.settings.remotePath,
			);
			if (isProtectedPath(localPath)) {
				continue;
			}

			const fingerprint = getPhysicalResourceFingerprint(resource);
			if (!fingerprint) {
				throw new Error(
					"Remote user object has no stable fingerprint for encryption cleanup",
				);
			}
			result.push({ path: localPath, fingerprint });
		}

		return result;
	}

	private isNotFoundError(e: unknown): boolean {
		return e instanceof YandexApiError && e.status === 404;
	}
}
