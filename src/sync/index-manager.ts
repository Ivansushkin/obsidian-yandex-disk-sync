/**
 * Synchronization index manager
 */

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
	EncryptionManifestState,
	EncryptionTransitionDescriptor,
	RemoteEncryptionManifest,
	IndexMaintenance,
} from "../types";
import {
	CURRENT_INDEX_VERSION,
	createEmptyIndex,
	createEmptyLocalState,
} from "../types";
import { YandexApiError, YandexDiskClient } from "../api/yandex-client";
import { VaultAdapter } from "../api/vault-adapter";
import {
	isProtectedPath,
	joinPath,
	normalizePath,
	toLocalPath,
} from "../utils/path-utils";
import { logger, shortenDiagnosticValue } from "../utils/logger";
import {
	computeSha256,
	computeSha256FromString,
} from "../utils/hash-utils";
import {
	PBKDF2_ITERATIONS,
	AES_KEY_LENGTH,
	IV_LENGTH,
} from "../crypto/encryption";
import type { EncryptionService } from "../crypto/encryption";
import {
	getPhysicalResourceFingerprint,
	getStableContentFingerprint,
} from "../utils/resource-fingerprint";
import {
	classifyIndexVersion,
	isPathInsideFolder,
	isStableLockStale,
	mergeFileMutation,
	shouldPreserveConcurrentFolderChild,
} from "./index-rules";
import { LocalOperationStore } from "./local-operation-store";
import { mergePhysicalMetadata } from "./baseline-rules";
import {
	collectStablePaginatedItems,
	didCanonicalChangeBeforeMaintenanceClaim,
	isOrphanIndexAmbiguous,
	stableSerialize,
} from "./index-transaction-rules";
import {
	classifyIndexMoveRecovery,
	rollbackRawIndexSnapshot,
	shouldRetryIndexTransaction,
	type IndexCodec,
	type IndexFileSnapshot,
	type IndexTransactionOutcome,
	type IndexTransactionStage,
} from "./index-transaction";

const REMOTE_INDEX_FILENAME = ".obsidian-sync-index.json";
const REMOTE_INDEX_LOCK_PREFIX = ".obsidian-sync-index.lock.";
const INDEX_LOCK_STALE_MS = 2 * 60 * 1000;
const INDEX_LOCK_RETRY_MS = 750;
const INDEX_LOCK_ATTEMPTS =
	Math.ceil(INDEX_LOCK_STALE_MS / INDEX_LOCK_RETRY_MS) + 10;
const ENCRYPTION_MANIFEST_FILENAME = ".obsidian-encrypt.json";
const ENCRYPTION_MANIFEST_STATES: EncryptionManifestState[] = [
	"enabled",
	"enabling",
	"rotating",
	"disabling",
];

type IndexDecodeStage = "decrypt" | "json";

interface EncryptionManifestRead {
	manifest: RemoteEncryptionManifest | null;
	validationToken: string;
}

export interface IndexDecodeAttempt {
	codec: IndexCodec;
	stage: IndexDecodeStage;
	errorName: string;
}

type IndexCodecAttemptResult =
	| { data: Partial<SyncIndex> }
	| { attempt: IndexDecodeAttempt };

export class IndexManager {
	private yandexClient: YandexDiskClient;
	private vaultAdapter: VaultAdapter;
	private settings: YandexDiskSyncSettings;

	private localState: LocalSyncState;
	private remoteIndex: SyncIndex;
	private loadedRemoteIndex: SyncIndex;
	private saveChain: Promise<void> = Promise.resolve();
	private observedLocks = new Map<
		string,
		{ fingerprint: string; firstSeenAt: number }
	>();
	private allowLegacyWriteOnce = false;
	private replaceRemoteOnNextSave = false;
	private operationStore: LocalOperationStore;
	private completedMoveIds = new Set<string>();
	private rejectedPuts: Array<{
		path: string;
		reason: "delete" | "conflict";
		remoteFingerprint: string;
		baselineSha256?: string;
	}> = [];
	private transitionIndexReadService: EncryptionService | null | undefined;
	private transitionIndexWriteService: EncryptionService | null | undefined;
	private physicalRewriteOnNextSave = false;

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
	}

	/**
	 * Update settings
	 */
	updateSettings(settings: YandexDiskSyncSettings): void {
		this.settings = settings;
		this.operationStore.updateDeviceId(settings.deviceId);
	}

	/**
	 * Use different source and target codecs for the one canonical commit that
	 * changes encryption mode.
	 */
	setIndexTransitionServices(
		source: EncryptionService | null,
		target: EncryptionService | null,
	): void {
		this.transitionIndexReadService = source;
		this.transitionIndexWriteService = target;
	}

	clearIndexTransitionServices(): void {
		this.transitionIndexReadService = undefined;
		this.transitionIndexWriteService = undefined;
	}

	beginPhysicalRewriteCommit(): void {
		this.physicalRewriteOnNextSave = true;
	}

	cancelPhysicalRewriteCommit(): void {
		this.physicalRewriteOnNextSave = false;
	}

	/**
	 * Get local index
	 */
	getLocalIndex(): LocalSyncState {
		return this.localState;
	}

	/**
	 * Get remote index
	 */
	getRemoteIndex(): SyncIndex {
		return this.remoteIndex;
	}

	/**
	 * Mark the currently loaded canonical state as fully reconciled locally.
	 */
	markRemoteObserved(): void {
		for (const [path, baseline] of Object.entries(this.localState.files)) {
			const canonical = this.remoteIndex.files[path];
			if (!canonical) continue;
			this.localState.files[path] = {
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
				changedRevision: canonical.changedRevision,
				baseRevision: canonical.baseRevision,
			};
		}
		this.localState.observedEpoch = this.remoteIndex.epoch;
		this.localState.observedRevision = this.remoteIndex.revision;
		this.localState.folderTombstones = this.cloneValue(
			this.remoteIndex.folderTombstones,
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
		this.localState.files = this.cloneValue(index.files);
		this.localState.folderTombstones = {};
		this.localState.nextMutationSeq = 1;
		this.localState.lastSyncTime = Date.now();
	}

	/**
	 * Load local index from saved plugin data
	 */
	loadLocalIndexFromData(data: Partial<LocalSyncState> | null): void {
		if (
			data?.version === 1 &&
			typeof data.observedRevision === "number"
		) {
			this.localState = {
				version: 1,
				deviceId: this.settings.deviceId,
				observedEpoch:
					typeof data.observedEpoch === "string"
						? data.observedEpoch
						: null,
				observedRevision: data.observedRevision,
				lastSyncTime: data.lastSyncTime || 0,
				files: data.files || {},
				folderTombstones: data.folderTombstones || {},
				nextMutationSeq: Math.max(1, data.nextMutationSeq || 1),
			};
		} else {
			this.localState = createEmptyLocalState(this.settings.deviceId);
		}
	}

	/**
	 * Allow one force-sync commit to replace a legacy index with v3.
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

	getPendingPutBaseRevision(
		path: string,
	): number | null | undefined {
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
	replacePendingPutWithDelete(
		id: string,
	): PendingMutation | undefined {
		return this.operationStore.replacePutWithDelete(id);
	}

	/**
	 * Reuse a put sequence as a watermark-only full-sync settlement.
	 */
	replacePendingPutWithNoop(
		id: string,
	): PendingMutation | undefined {
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
		for (const mutation of this.getPendingMutations()) {
			if (mutation.type === "delete-file") {
				this.markLocalFileDeleted(mutation.path);
				this.markRemoteFileDeleted(mutation.path);
				continue;
			}
			if (mutation.type === "delete-folder") {
				this.markFolderDeleted(
					mutation.path,
					mutation.createdAt,
					mutation.baseRevision,
				);
				const prefix = `${mutation.path.replace(/\/+$/, "")}/`;
				const paths = new Set([
					...Object.keys(this.localState.files),
					...Object.keys(this.remoteIndex.files),
				]);
				for (const path of paths) {
					if (!path.startsWith(prefix)) continue;
					this.markLocalFileDeleted(path, mutation.path);
					this.markRemoteFileDeleted(
						path,
						mutation.path,
						mutation.baseRevision ?? 0,
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
				? this.localState.observedEpoch
				: options.epoch,
			options?.baseRevision === undefined
				? this.localState.observedEpoch === null
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
	 * Build local files index
	 */
	async buildLocalIndex(): Promise<Map<string, FileMetadata>> {
		logger.info("Building local index...");
		const metadata = await this.vaultAdapter.getAllFileMetadata();
		logger.info(`Found ${metadata.size} files for synchronization`);
		return metadata;
	}

	/**
	 * Load remote index from Yandex Disk
	 */
	async loadRemoteIndex(
		allowLegacy = false,
		stableRootDiscovery = false,
	): Promise<SyncIndex> {
		let discovery: {
			path: string | null;
			resource?: YandexResource;
			rootExists?: boolean;
		} = stableRootDiscovery
			? await this.waitForCanonicalIndexFromStableRoot()
			: { path: await this.waitForCanonicalIndex() };
		if (!discovery.path) {
			if (stableRootDiscovery && discovery.rootExists === false) {
				await this.createRemotePath();
			}
			const initial = createEmptyIndex(this.settings.deviceId);
			try {
				await this.yandexClient.uploadFileExclusive(
					this.getRemoteIndexPath(),
					JSON.stringify(initial, null, 2),
					false,
					false,
				);
			} catch (error) {
				if (!this.isLockContention(error)) throw error;
			}
			discovery = stableRootDiscovery
				? await this.waitForCanonicalIndexFromStableRoot()
				: { path: await this.waitForCanonicalIndex() };
			if (!discovery.path) {
				throw new RemoteIndexConcurrentModificationError(
					"Canonical index could not be initialized",
				);
			}
		}

		try {
			this.remoteIndex = (
				await this.downloadIndexSnapshot(
					discovery.path,
					allowLegacy,
					undefined,
					undefined,
					discovery.resource,
				)
			).index;
			this.loadedRemoteIndex = this.cloneIndex(this.remoteIndex);
			this.assertEpochCompatible(this.remoteIndex);
			this.assertMaintenanceCompatible(this.remoteIndex);
			logger.info(
				`Loaded remote index revision ${this.remoteIndex.revision}: ${
					Object.keys(this.remoteIndex.files).length
				} files`,
			);
			return this.remoteIndex;
		} catch (e) {
			logger.warn("Error loading remote index:", { error: e });
			throw e;
		}
	}

	/**
	 * Read the current canonical index without advancing local observation or
	 * replacing the in-memory desired state.
	 */
	async readCanonicalIndex(): Promise<SyncIndex> {
		const path = await this.waitForCanonicalIndex();
		if (!path) {
			throw new RemoteIndexConcurrentModificationError(
				"Canonical index is missing",
			);
		}
		return await this.downloadIndex(path, false);
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
		if (this.remoteIndex.maintenance?.id !== id) return;
		delete this.remoteIndex.maintenance;
	}

	/**
	 * Save remote index to Yandex Disk
	 */
	async saveRemoteIndex(): Promise<void> {
		const save = this.saveChain.then(() =>
			this.saveRemoteIndexWithRetry(),
		);
		this.saveChain = save.catch(() => undefined);
		return await save;
	}

	private async saveRemoteIndexWithRetry(): Promise<void> {
		let lastError: Error | null = null;
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				await this.saveRemoteIndexLocked();
				return;
			} catch (e) {
				if (
					!(
						e instanceof RemoteIndexTransactionError &&
						e.retryable
					)
				) {
					throw e;
				}
				lastError = e;
				logger.warn("Retrying canonical index transaction", {
					attempt: attempt + 1,
					maxAttempts: 4,
					outcome: e.outcome,
					failedStage: e.stage,
					canonicalRevision: this.remoteIndex.revision,
					epoch: shortenDiagnosticValue(this.remoteIndex.epoch),
					error: e,
				});
				await this.wait(
					INDEX_LOCK_RETRY_MS + Math.random() * 500,
				);
			}
		}
		throw (
			lastError ||
			new RemoteIndexConcurrentModificationError(
				"Remote index commit could not be retried",
			)
		);
	}

	private async saveRemoteIndexLocked(): Promise<IndexTransactionOutcome> {
		const canonicalPath = this.getRemoteIndexPath();
		const transactionId = this.createTransactionId();
		const lockPath = joinPath(
			this.settings.remotePath,
			`${REMOTE_INDEX_LOCK_PREFIX}${this.settings.deviceId}.${transactionId}`,
		);
		const transactionContext = {
			indexTransactionId: transactionId,
			lockName: lockPath.split("/").pop() ?? lockPath,
			desiredRevision: this.remoteIndex.revision,
			loadedRevision: this.loadedRemoteIndex.revision,
			epoch: shortenDiagnosticValue(this.remoteIndex.epoch),
			pendingMutations: this.getPendingMutations().length,
			pendingPhysicalActions:
				this.getPendingPhysicalActions().length,
		};
		logger.info("Canonical index transaction started", transactionContext);

		await this.ensureCanonicalIndex();

		let acquired = false;
		for (let attempt = 0; attempt < INDEX_LOCK_ATTEMPTS; attempt++) {
			try {
				await this.yandexClient.moveResourceExclusive(
					canonicalPath,
					lockPath,
				);
				acquired = true;
				logger.debug("Canonical index lock acquired", {
					...transactionContext,
					lockAttempt: attempt + 1,
				});
				break;
			} catch (e) {
				if (
					await this.wasLockAcquiredDespiteError(
						lockPath,
						canonicalPath,
					)
				) {
					acquired = true;
					logger.warn(
						"Canonical index lock acquisition was ambiguous but ownership was verified",
						{
							...transactionContext,
							lockAttempt: attempt + 1,
						},
					);
					break;
				}
				if (!this.isLockContention(e)) throw e;
				if (attempt === 0 || (attempt + 1) % 10 === 0) {
					logger.debug("Waiting for canonical index lock", {
						...transactionContext,
						lockAttempt: attempt + 1,
						maxLockAttempts: INDEX_LOCK_ATTEMPTS,
						error: e,
					});
				}
				await this.wait(INDEX_LOCK_RETRY_MS + Math.random() * 300);
				await this.recoverStaleLock();
			}
		}
		if (!acquired) {
			throw new RemoteIndexLockedError(
				"Timed out waiting for the remote index transaction",
			);
		}

		let stage: IndexTransactionStage = "acquired";
		let originalSnapshot: IndexFileSnapshot | null = null;
		let merged: SyncIndex | null = null;
		let writtenFingerprint: string | null = null;
		try {
			try {
				originalSnapshot = await this.downloadIndexSnapshot(
					lockPath,
					true,
					this.transitionIndexReadService,
					"source",
				);
			} catch (sourceReadError) {
				if (!this.replaceRemoteOnNextSave) throw sourceReadError;
				originalSnapshot =
					await this.downloadUnparsedIndexSnapshot(lockPath);
				logger.warn(
					"Force transaction captured an unreadable source index as raw bytes",
					{
						...transactionContext,
						sourceReadable: false,
						sourceFingerprint: shortenDiagnosticValue(
							originalSnapshot.fingerprint,
						),
						error: sourceReadError,
					},
				);
			}
			const latest = this.replaceRemoteOnNextSave
				? this.createReplacementBaseline()
				: originalSnapshot.index;
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
			merged = this.mergeDesiredIndex(latest);
			logger.debug("Canonical reducer completed", {
				...transactionContext,
				latestRevision: latest.revision,
				mergedRevision: merged.revision,
				fileEntries: Object.keys(merged.files).length,
				folderTombstones: Object.keys(
					merged.folderTombstones,
				).length,
				pendingMoves: Object.keys(merged.moves).length,
			});
			if (
				this.allowLegacyWriteOnce &&
				merged.revision === latest.revision
			) {
				merged.revision = latest.revision + 1;
			}
			if (merged.revision !== latest.revision) {
				merged.version = CURRENT_INDEX_VERSION;
				merged.deviceId = this.settings.deviceId;
				merged.lastSyncTime = Date.now();
				let uploadError: unknown;
				try {
					if (this.transitionIndexWriteService !== undefined) {
						await this.yandexClient.uploadFileWithEncryptionService(
							lockPath,
							JSON.stringify(merged, null, 2),
							this.transitionIndexWriteService,
						);
					} else {
						await this.yandexClient.uploadFile(
							lockPath,
							JSON.stringify(merged, null, 2),
							true,
							false,
						);
					}
				} catch (error) {
					uploadError = error;
				}
				stage = "written";
				const verifiedLock = await this.downloadIndexSnapshot(
					lockPath,
					this.allowLegacyWriteOnce,
					this.transitionIndexWriteService,
					"target",
				);
				if (!this.sameValue(verifiedLock.index, merged)) {
					await this.logSemanticIndexMismatch(
						merged,
						verifiedLock.index,
						transactionContext,
					);
					if (uploadError) {
						throw uploadError instanceof Error
							? uploadError
							: new Error(
									"Lock upload failed with a non-Error value",
								);
					}
					throw new RemoteIndexContentMismatchError(
						"Written lock revision or contents could not be verified",
						stage,
					);
				}
				writtenFingerprint = verifiedLock.fingerprint;
				stage = "verified";
				logger.debug("Written index lock verified", {
					...transactionContext,
					mergedRevision: merged.revision,
					lockFingerprint: shortenDiagnosticValue(
						writtenFingerprint,
					),
				});
			}
			if (writtenFingerprint === null) {
				const writtenLock = await this.yandexClient.getResource(
					lockPath,
					1,
					0,
					true,
				);
				writtenFingerprint =
					this.getResourceFingerprint(writtenLock);
				stage = "verified";
			}
			stage = "move-attempted";
			try {
				await this.yandexClient.moveResourceExclusive(
					lockPath,
					canonicalPath,
				);
			} catch (error) {
				const recovered = await this.recoverAmbiguousFinalMove(
					lockPath,
					canonicalPath,
					merged,
					writtenFingerprint,
				);
				if (recovered === "concurrent") {
					throw new RemoteIndexConcurrentModificationError(
						"Canonical index changed during the final move",
						stage,
						false,
						error,
					);
				}
				if (recovered !== "committed") {
					throw new AmbiguousRemoteIndexStateError(
						"Canonical index move could not be resolved safely",
						stage,
						error,
					);
				}
			}
			const canonicalSnapshot = await this.verifyCanonicalCommit(
				lockPath,
				canonicalPath,
				merged,
				writtenFingerprint,
			);
			stage = "committed";
			logger.debug("Canonical index fingerprint verified", {
				...transactionContext,
				committedRevision: merged.revision,
				canonicalFingerprint: shortenDiagnosticValue(
					canonicalSnapshot.fingerprint,
				),
			});
			await this.finalizeCommittedTransaction(merged);
			logger.info("Canonical index transaction committed", {
				...transactionContext,
				outcome: "committed",
				stage,
				committedRevision: merged.revision,
				canonicalFingerprint: shortenDiagnosticValue(
					canonicalSnapshot.fingerprint,
				),
			});
			return "committed";
		} catch (e) {
			if (
				stage === "move-attempted" &&
				merged &&
				(await this.isExpectedCanonicalCommitted(
					lockPath,
					canonicalPath,
					merged,
					writtenFingerprint,
				))
			) {
				stage = "committed";
				await this.finalizeCommittedTransaction(merged);
				logger.warn(
					"Canonical index commit was confirmed after an ambiguous response",
					{
						...transactionContext,
						outcome: "committed",
						stage,
						committedRevision: merged.revision,
						error: e,
					},
				);
				return "committed";
			}

			const rollbackOutcome = originalSnapshot
				? await this.rollbackOwnedLock(
						lockPath,
						canonicalPath,
						originalSnapshot,
						transactionContext,
					)
				: "ambiguous";
			logger.error("Canonical index transaction failed", {
				...transactionContext,
				outcome: rollbackOutcome,
				failedStage: stage,
				expectedRevision: merged?.revision,
				actualRevision:
					rollbackOutcome === "rolled-back"
						? originalSnapshot?.index.revision
						: null,
				expectedEpoch: shortenDiagnosticValue(merged?.epoch),
				actualEpoch: shortenDiagnosticValue(
					rollbackOutcome === "rolled-back"
						? originalSnapshot?.index.epoch
						: null,
				),
				expectedFingerprint: shortenDiagnosticValue(
					writtenFingerprint,
				),
				actualFingerprint: shortenDiagnosticValue(
					rollbackOutcome === "rolled-back"
						? originalSnapshot?.fingerprint
						: null,
				),
				error: e,
			});
			if (rollbackOutcome === "rolled-back") {
				throw new RemoteIndexRolledBackError(
					e instanceof Error
						? e.message
						: "Canonical index transaction failed",
					stage,
					e,
				);
			}
			if (rollbackOutcome === "concurrent") {
				throw new RemoteIndexConcurrentModificationError(
					"Canonical index changed while the transaction was active",
					stage,
					false,
					e,
				);
			}
			throw new AmbiguousRemoteIndexStateError(
				"Canonical index and lock require explicit recovery",
				stage,
				e,
			);
		}
	}

	/**
	 * Update file metadata in local index
	 */
	updateLocalFile(path: string, metadata: FileMetadata): void {
		this.localState.files[path] = {
			...metadata,
			baseRevision:
				metadata.baseRevision ?? this.localState.observedRevision,
			lastModifiedBy: this.settings.deviceId,
		};
	}

	/**
	 * Mark file as deleted in local index
	 */
	markLocalFileDeleted(path: string, deletedByFolder?: string): void {
		const meta = this.localState.files[path];
		if (!meta) return;
		if (!meta.deleted) {
			meta.deleted = true;
			meta.deletedAt = Date.now();
		}
		if (deletedByFolder) {
			meta.deletedByFolder = deletedByFolder;
		}
		meta.lastModifiedBy = this.settings.deviceId;
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
		this.remoteIndex.files[path] = {
			...metadata,
			baseRevision:
				metadata.baseRevision ?? this.loadedRemoteIndex.revision,
			lastModifiedBy: this.settings.deviceId,
		};
	}

	/**
	 * Stamp `remoteMtime` on remote index entries that are missing it, using
	 * the server-side mtime carried by a freshly-read remote file listing.
	 *
	 * Used as a batch replacement for per-upload `fetchServerMtime`: the bulk
	 * upload path writes remote index entries without `remoteMtime`, then the
	 * sync engine performs a single `getRemoteFiles` call and passes the
	 * result here. Entries that already carry a `remoteMtime` (e.g. written by
	 * a single-file upload path) are left untouched. Entries whose path is
	 * absent from `remoteFiles` keep `remoteMtime` undefined and are verified
	 * by fingerprint/content during the next causal reconciliation.
	 */
	applyServerMtimes(remoteFiles: Map<string, FileMetadata>): boolean {
		let stamped = 0;
		for (const [path, meta] of Object.entries(this.remoteIndex.files)) {
			if (typeof meta.remoteMtime === "number") continue;
			if (meta.deleted) continue;
			const live = remoteFiles.get(path);
			if (!live) continue;
			if (typeof live.remoteMtime !== "number") continue;
			this.remoteIndex.files[path] = {
				...meta,
				remoteMtime: live.remoteMtime,
				remoteFingerprint: live.remoteFingerprint,
			};
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
	): void {
		const meta =
			this.remoteIndex.files[path] ||
			this.localState.files[path] || {
				path,
				sha256: "",
				size: 0,
				mtime: 0,
				syncedAt: 0,
			};
		this.remoteIndex.files[path] = meta;
		if (meta.deleted) return;
		meta.deleted = true;
		meta.deletedAt = Date.now();
		meta.deletedByFolder = deletedByFolder;
		meta.baseRevision = baseRevision;
		meta.lastModifiedBy = this.settings.deviceId;
	}

	/**
	 * Record deletion of a folder as a prefix tombstone.
	 */
	markFolderDeleted(
		path: string,
		deletedAt = Date.now(),
		baseRevision: number | null = this.loadedRemoteIndex.revision,
	): void {
		const normalized = path.replace(/\/+$/, "");
		const tombstone: FolderTombstone = {
			path: normalized,
			deletedAt,
			changedRevision: this.remoteIndex.revision,
			baseRevision: baseRevision ?? 0,
			lastModifiedBy: this.settings.deviceId,
		};
		this.remoteIndex.folderTombstones[normalized] = tombstone;
		this.localState.folderTombstones[normalized] = { ...tombstone };
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
	): void {
		this.remoteIndex.moves[id] = {
			id,
			fromPath,
			toPath,
			kind,
			baseRevision,
			changedRevision: this.remoteIndex.revision,
			pending: true,
			lastModifiedBy: this.settings.deviceId,
		};
	}

	completeMove(id: string): void {
		if (!this.remoteIndex.moves[id]) return;
		delete this.remoteIndex.moves[id];
		this.completedMoveIds.add(id);
	}

	/**
	 * Get files list from remote storage
	 */
	async getRemoteFiles(): Promise<Map<string, FileMetadata>> {
		logger.info("Getting remote files list...");

		const resources = await this.yandexClient.getResourcesRecursive(
			this.settings.remotePath,
			true,
			Math.min(this.settings.maxConcurrency, 4),
		);

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
			const rawLocalPath = toLocalPath(
				rawResource.path,
				this.settings.remotePath,
			);
			if (cleanupPaths.has(normalizePath(rawLocalPath))) continue;
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

		logger.info(`Found ${result.size} remote files`);
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

	private async waitForCanonicalIndex(): Promise<string | null> {
		const canonicalPath = this.getRemoteIndexPath();
		for (let attempt = 0; attempt < INDEX_LOCK_ATTEMPTS; attempt++) {
			const canonical = await this.yandexClient.getResource(
				canonicalPath,
				1000,
				0,
				true,
			);
			if (canonical) {
				if (!this.replaceRemoteOnNextSave) {
					await this.cleanupStaleOrphanLocks();
				}
				return canonicalPath;
			}

			const locks = await this.getIndexLocks();
			if (locks.length === 0) return null;
			if (this.replaceRemoteOnNextSave) return null;
			if (locks.length > 1) {
				throw new AmbiguousRemoteIndexLockError(
					"Multiple remote index locks require an explicit force sync",
				);
			}

			await this.recoverStaleLock(locks);
			await this.wait(INDEX_LOCK_RETRY_MS);
		}
		throw new RemoteIndexLockedError(
			"Remote index is locked by another device",
		);
	}

	private async waitForCanonicalIndexFromStableRoot(): Promise<{
		path: string | null;
		resource?: YandexResource;
		rootExists: boolean;
	}> {
		const canonicalPath = this.getRemoteIndexPath();
		for (let attempt = 0; attempt < INDEX_LOCK_ATTEMPTS; attempt++) {
			const { resources, rootExists } =
				await this.getStableRootListing();
			const canonical = resources.find(
				(resource) =>
					resource.type === "file" &&
					resource.name === REMOTE_INDEX_FILENAME,
			);
			const locks = this.selectIndexLocks(resources);
			if (canonical) {
				if (!this.replaceRemoteOnNextSave) {
					await this.cleanupStaleOrphanLocks(locks);
				}
				return { path: canonicalPath, resource: canonical, rootExists };
			}
			if (locks.length === 0 || this.replaceRemoteOnNextSave) {
				return { path: null, rootExists };
			}
			if (locks.length > 1) {
				throw new AmbiguousRemoteIndexLockError(
					"Multiple remote index locks require an explicit force sync",
				);
			}
			await this.recoverStaleLock(locks);
			await this.wait(INDEX_LOCK_RETRY_MS);
		}
		throw new RemoteIndexLockedError(
			"Remote index is locked by another device",
		);
	}

	private async ensureCanonicalIndex(): Promise<void> {
		const existing = await this.waitForCanonicalIndex();
		if (existing) return;

		const empty = createEmptyIndex("");
		try {
			await this.yandexClient.uploadFileExclusive(
				this.getRemoteIndexPath(),
				JSON.stringify(empty, null, 2),
				false,
				false,
			);
		} catch (e) {
			if (!this.isLockContention(e)) throw e;
		}
	}

	private async downloadIndex(
		path: string,
		allowLegacy: boolean,
		serviceOverride?: EncryptionService | null,
	): Promise<SyncIndex> {
		return (
			await this.downloadIndexSnapshot(
				path,
				allowLegacy,
				serviceOverride,
			)
		).index;
	}

	private async downloadIndexSnapshot(
		path: string,
		allowLegacy: boolean,
		serviceOverride?: EncryptionService | null,
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
		serviceOverride?: EncryptionService | null,
		codecLabel?: IndexCodec,
		fingerprint: string | null = null,
	): Promise<{ index: SyncIndex; codec: IndexCodec }> {
		if (serviceOverride !== undefined) {
			const codec =
				codecLabel ??
				(serviceOverride ? "current" : "plaintext");
			const decoded = await this.tryDecodeIndexCodec(
				raw,
				serviceOverride,
				codec,
			);
			if ("attempt" in decoded) {
				throw await this.createUnreadableIndexError(
					raw,
					fingerprint,
					[decoded.attempt],
				);
			}
			logger.debug("Decoded remote index snapshot", { codec });
			return {
				index: this.normalizeParsedIndex(decoded.data, allowLegacy),
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
				index: this.normalizeParsedIndex(current.data, allowLegacy),
				codec: "current",
			};
		}
		attempts.push(current.attempt);

		if (!this.yandexClient.hasEncryptionService()) {
			throw await this.createUnreadableIndexError(
				raw,
				fingerprint,
				attempts,
			);
		}

		const plaintext = await this.tryDecodeIndexCodec(
			raw,
			null,
			"plaintext",
		);
		if ("data" in plaintext) {
			logger.debug("Decoded remote index snapshot", {
				codec: "plaintext",
			});
			return {
				index: this.normalizeParsedIndex(plaintext.data, allowLegacy),
				codec: "plaintext",
			};
		}
		attempts.push(plaintext.attempt);
		throw await this.createUnreadableIndexError(raw, fingerprint, attempts);
	}

	/** Decode and parse one codec without catching semantic index errors. */
	private async tryDecodeIndexCodec(
		raw: ArrayBuffer,
		service: EncryptionService | null | undefined,
		codec: IndexCodec,
	): Promise<IndexCodecAttemptResult> {
		let content: ArrayBuffer;
		try {
			content = await this.yandexClient.decodeServiceFileContent(raw, service);
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
			if (!(error instanceof SyntaxError)) throw error;
			return {
				attempt: {
					codec,
					stage: "json",
					errorName: this.getErrorName(error),
				},
			};
		}
	}

	private parseIndexJson(content: ArrayBuffer): Partial<SyncIndex> {
		return JSON.parse(
			new TextDecoder().decode(content),
		) as Partial<SyncIndex>;
	}

	private normalizeParsedIndex(
		data: Partial<SyncIndex>,
		allowLegacy: boolean,
	): SyncIndex {
		const versionKind = classifyIndexVersion(data.version);
		if (versionKind !== "current") {
			if (allowLegacy && versionKind === "legacy") {
				return this.normalizeLegacyIndex(data);
			}
			if (versionKind === "unsupported") {
				throw new Error(
					`Remote sync index version ${String(data.version)} is not supported by this plugin version.`,
				);
			}
			throw new LegacyIndexVersionError(data.version);
		}
		if (typeof data.epoch !== "string" || !data.epoch) {
			throw new LegacyIndexVersionError(data.version);
		}

		const normalized: SyncIndex = {
			version: CURRENT_INDEX_VERSION,
			epoch: data.epoch,
			revision: data.revision || 0,
			lastSyncTime: data.lastSyncTime || 0,
			deviceId: data.deviceId || "",
			files: data.files || {},
			folderTombstones: data.folderTombstones || {},
			moves: data.moves || {},
			appliedMutationSeq: data.appliedMutationSeq || {},
		};
		if (data.maintenance !== undefined) {
			normalized.maintenance = data.maintenance;
		}
		return normalized;
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

	private normalizeLegacyIndex(data: Partial<SyncIndex>): SyncIndex {
		const normalized = createEmptyIndex(data.deviceId || "");
		normalized.lastSyncTime = data.lastSyncTime || 0;
		normalized.files = data.files || {};
		for (const meta of Object.values(normalized.files)) {
			meta.changedRevision = 0;
			meta.baseRevision = 0;
		}
		return normalized;
	}

	private createReplacementBaseline(): SyncIndex {
		const baseline = createEmptyIndex("", this.remoteIndex.epoch);
		baseline.revision = Math.max(
			this.localState.observedRevision,
			this.remoteIndex.revision,
		);
		return baseline;
	}

	private mergeDesiredIndex(latest: SyncIndex): SyncIndex {
		this.rejectedPuts = [];
		const nextRevision = latest.revision + 1;
		if (this.replaceRemoteOnNextSave) {
			const replacement = this.cloneIndex(this.remoteIndex);
			replacement.revision = nextRevision;
			for (const meta of Object.values(replacement.files)) {
				meta.changedRevision = nextRevision;
				meta.baseRevision = latest.revision;
			}
			for (const tombstone of Object.values(
				replacement.folderTombstones,
			)) {
				tombstone.changedRevision = nextRevision;
				tombstone.baseRevision = latest.revision;
			}
			for (const move of Object.values(replacement.moves)) {
				move.changedRevision = nextRevision;
				move.baseRevision = latest.revision;
			}
			return replacement;
		}

		const merged = this.cloneIndex(latest);
		let changed = false;
		const baseRevision = this.loadedRemoteIndex.revision;
		const desiredMaintenance = this.remoteIndex.maintenance;
		if (
			desiredMaintenance?.phase === "prepared" &&
			!this.sameValue(
				desiredMaintenance,
				this.loadedRemoteIndex.maintenance,
			) &&
			didCanonicalChangeBeforeMaintenanceClaim(
				this.loadedRemoteIndex.revision,
				latest.revision,
			)
		) {
			throw new RemoteIndexConcurrentModificationError(
				"Canonical revision changed before encryption maintenance ownership was acquired",
			);
		}

		for (const [path, desired] of Object.entries(this.remoteIndex.files)) {
			const baseline = this.loadedRemoteIndex.files[path];
			if (this.sameValue(desired, baseline)) continue;

			const current = merged.files[path];
			if (this.physicalRewriteOnNextSave) {
				const physical = mergePhysicalMetadata(
					current,
					baseline,
					desired,
				);
				if (!physical) {
					throw new RemoteIndexConcurrentModificationError(
						`Logical state changed during physical rewrite: ${path}`,
					);
				}
				merged.files[path] = physical;
				changed = true;
				continue;
			}
			const mutationBase = desired.baseRevision ?? baseRevision;
			const next = mergeFileMutation(
				current,
				desired,
				mutationBase,
				nextRevision,
				this.settings.deviceId,
			);
			if (next === current || !next) {
				if (
					desired.deletedByFolder &&
					current &&
					!current.deleted
				) {
					merged.files[path] = {
						...current,
						changedRevision: nextRevision,
					};
					changed = true;
					continue;
				}
				if (!desired.deleted && current && desired.remoteFingerprint) {
					this.rejectedPuts.push({
						path,
						reason: current.deleted
							? "delete"
							: "conflict",
						remoteFingerprint: desired.remoteFingerprint,
						baselineSha256:
							this.operationStore.findLatestPutBaselineSha(
								path,
							),
					});
				}
				continue;
			}

			merged.files[path] = next;
			changed = true;
		}

		for (const [path, tombstone] of Object.entries(
			this.remoteIndex.folderTombstones,
		)) {
			if (
				this.sameValue(
					tombstone,
					this.loadedRemoteIndex.folderTombstones[path],
				)
			) {
				continue;
			}
			merged.folderTombstones[path] = {
				...tombstone,
				baseRevision: tombstone.baseRevision ?? baseRevision,
				changedRevision: nextRevision,
				lastModifiedBy: this.settings.deviceId,
			};
			const mutationBase =
				tombstone.baseRevision ?? baseRevision;
			for (const [filePath, current] of Object.entries(
				merged.files,
			)) {
				if (
					!isPathInsideFolder(filePath, path) ||
					!shouldPreserveConcurrentFolderChild(
						current,
						mutationBase,
					)
				) {
					continue;
				}
				merged.files[filePath] = {
					...current,
					changedRevision: nextRevision,
				};
			}
			changed = true;
		}

		for (const [id, move] of Object.entries(this.remoteIndex.moves)) {
			if (this.sameValue(move, this.loadedRemoteIndex.moves[id])) {
				continue;
			}
			merged.moves[id] = {
				...move,
				changedRevision: nextRevision,
				lastModifiedBy: this.settings.deviceId,
			};
			changed = true;
		}
		for (const id of this.completedMoveIds) {
			if (!merged.moves[id]) continue;
			delete merged.moves[id];
			changed = true;
		}

		for (const [deviceId, sequence] of Object.entries(
			this.remoteIndex.appliedMutationSeq,
		)) {
			const current = merged.appliedMutationSeq[deviceId] || 0;
			if (sequence <= current) continue;
			merged.appliedMutationSeq[deviceId] = sequence;
			changed = true;
		}

		if (
			!this.sameValue(
				this.remoteIndex.maintenance,
				this.loadedRemoteIndex.maintenance,
			)
		) {
			if (this.remoteIndex.maintenance) {
				merged.maintenance = this.cloneValue(
					this.remoteIndex.maintenance,
				);
			} else {
				delete merged.maintenance;
			}
			changed = true;
		}

		merged.revision = changed ? nextRevision : latest.revision;
		return merged;
	}

	private async getIndexLocks(): Promise<YandexResource[]> {
		return this.selectIndexLocks(
			(await this.getStableRootListing()).resources,
		);
	}

	private async getStableRootListing(): Promise<{
		resources: YandexResource[];
		rootExists: boolean;
	}> {
		let rootExists = false;
		const resources = await collectStablePaginatedItems(
			async (limit, offset) => {
				const root = await this.yandexClient.getResource(
					this.settings.remotePath,
					limit,
					offset,
					true,
				);
				if (offset === 0) rootExists = root !== null;
				return {
					items: root?._embedded?.items ?? [],
					total: root?._embedded?.total ?? 0,
				};
			},
			(resource) => resource.path || resource.name,
			(resource) =>
				[
					resource.resource_id || "",
					getStableContentFingerprint(resource) || "",
				].join(":"),
			4,
			() => (rootExists ? "exists" : "missing"),
		);
		return { resources, rootExists };
	}

	private selectIndexLocks(resources: YandexResource[]): YandexResource[] {
		return resources.filter(
			(resource) =>
				resource.type === "file" &&
				resource.name.startsWith(REMOTE_INDEX_LOCK_PREFIX),
		);
	}

	/**
	 * Observe one lock lease using content identity that changes on overwrite.
	 */
	private isObservedLockStale(resource: YandexResource): boolean {
		const fingerprint = getStableContentFingerprint(resource);
		if (!fingerprint) {
			throw new AmbiguousRemoteIndexLockError(
				"Index lock has no stable content identity",
			);
		}
		const now = Date.now();
		const observed = this.observedLocks.get(resource.name);
		if (!observed || observed.fingerprint !== fingerprint) {
			this.observedLocks.set(resource.name, {
				fingerprint,
				firstSeenAt: now,
			});
			return false;
		}
		return isStableLockStale(
			observed.firstSeenAt,
			now,
			INDEX_LOCK_STALE_MS,
		);
	}

	private async recoverStaleLock(
		knownLocks?: YandexResource[],
	): Promise<void> {
		const locks = knownLocks || (await this.getIndexLocks());
		if (locks.length === 0) return;
		if (locks.length > 1) {
			throw new AmbiguousRemoteIndexLockError(
				"Multiple remote index locks require an explicit force sync",
			);
		}

		for (const resource of locks) {
			if (!this.isObservedLockStale(resource)) continue;

			const lockPath = joinPath(
				this.settings.remotePath,
				resource.name,
			);
			await this.assertStaleLockReadable(lockPath);
			try {
				await this.yandexClient.moveResourceExclusive(
					lockPath,
					this.getRemoteIndexPath(),
				);
				this.observedLocks.delete(resource.name);
				logger.warn(`Recovered stale index lock: ${resource.name}`);
				return;
			} catch (e) {
				if (!this.isLockContention(e)) throw e;
			}
		}
	}

	private async assertStaleLockReadable(lockPath: string): Promise<void> {
		const candidates: Array<{
			service: EncryptionService | null | undefined;
			codec: IndexCodec;
		}> = [
			{
				service: this.transitionIndexReadService,
				codec: "source",
			},
			{
				service: this.transitionIndexWriteService,
				codec: "target",
			},
			{ service: undefined, codec: "current" },
		];
		for (const candidate of candidates) {
			try {
				await this.downloadIndexSnapshot(
					lockPath,
					true,
					candidate.service,
					candidate.codec,
				);
				return;
			} catch {
				// Continue with the other codec before blocking recovery.
			}
		}
		throw new AmbiguousRemoteIndexLockError(
			"Stale index lock is unreadable and cannot be published automatically",
		);
	}

	private async cleanupStaleOrphanLocks(
		knownLocks?: YandexResource[],
	): Promise<void> {
		const locks = knownLocks ?? (await this.getIndexLocks());
		if (locks.length > 1) {
			throw new AmbiguousRemoteIndexLockError(
				"Multiple orphan index locks require an explicit force sync",
			);
		}
		for (const resource of locks) {
			if (!this.isObservedLockStale(resource)) continue;
			const canonical = await this.downloadIndex(
				this.getRemoteIndexPath(),
				this.allowLegacyWriteOnce,
			);
			const orphan = await this.downloadIndex(
				joinPath(this.settings.remotePath, resource.name),
				this.allowLegacyWriteOnce,
			);
			if (isOrphanIndexAmbiguous(canonical, orphan)) {
				throw new AmbiguousRemoteIndexLockError(
					"An orphan lock conflicts with the canonical index",
				);
			}
			await this.yandexClient.deleteResource(
				joinPath(this.settings.remotePath, resource.name),
				false,
				true,
			);
			this.observedLocks.delete(resource.name);
			logger.warn(`Removed stale orphan index lock: ${resource.name}`);
		}
	}

	private async cleanupForceReplacedLocks(): Promise<void> {
		for (const resource of await this.getIndexLocks()) {
			await this.yandexClient.deleteResource(
				joinPath(this.settings.remotePath, resource.name),
				false,
				true,
			);
		}
	}

	private async wasLockAcquiredDespiteError(
		lockPath: string,
		canonicalPath: string,
	): Promise<boolean> {
		try {
			const [lock, canonical] = await Promise.all([
				this.yandexClient.getResource(lockPath, 1, 0, true),
				this.yandexClient.getResource(
					canonicalPath,
					1,
					0,
					true,
				),
			]);
			return lock !== null && canonical === null;
		} catch {
			return false;
		}
	}

	private async inspectExpectedIndex(
		path: string,
		expected: SyncIndex,
		serviceOverride?: EncryptionService | null,
		codecLabel?: IndexCodec,
	): Promise<{
		exists: boolean;
		readable: boolean;
		matches: boolean;
		snapshot: IndexFileSnapshot | null;
	}> {
		const resource = await this.yandexClient.getResource(
			path,
			1,
			0,
			true,
		);
		if (!resource) {
			return {
				exists: false,
				readable: false,
				matches: false,
				snapshot: null,
			};
		}
		try {
			const snapshot = await this.downloadIndexSnapshot(
				path,
				this.allowLegacyWriteOnce,
				serviceOverride,
				codecLabel,
			);
			return {
				exists: true,
				readable: true,
				matches: this.sameValue(snapshot.index, expected),
				snapshot,
			};
		} catch {
			return {
				exists: true,
				readable: false,
				matches: false,
				snapshot: null,
			};
		}
	}

	private async recoverAmbiguousFinalMove(
		lockPath: string,
		canonicalPath: string,
		expected: SyncIndex,
		expectedFingerprint: string | null,
	): Promise<IndexTransactionOutcome> {
		const [canonical, lock] = await Promise.all([
			this.inspectExpectedIndex(
				canonicalPath,
				expected,
				this.transitionIndexWriteService,
				"target",
			),
			this.inspectExpectedIndex(
				lockPath,
				expected,
				this.transitionIndexWriteService,
				"target",
			),
		]);
		let decision = classifyIndexMoveRecovery({
			canonicalExists: canonical.exists,
			lockExists: lock.exists,
			canonicalReadable: canonical.readable,
			lockReadable: lock.readable,
			canonicalMatchesExpected: canonical.matches,
			lockMatchesExpected: lock.matches,
		});
		if (
			decision === "committed" &&
			expectedFingerprint &&
			canonical.snapshot?.fingerprint !== expectedFingerprint
		) {
			decision = "ambiguous";
		}
		if (decision === "retry-move") {
			try {
				await this.yandexClient.moveResourceExclusive(
					lockPath,
					canonicalPath,
				);
			} catch {
				// The read-back below is authoritative for an ambiguous API reply.
			}
			try {
				await this.verifyCanonicalCommit(
					lockPath,
					canonicalPath,
					expected,
					expectedFingerprint,
				);
				return "committed";
			} catch (error) {
				if (
					error instanceof
					RemoteIndexConcurrentModificationError
				) {
					return "concurrent";
				}
				return "ambiguous";
			}
		}
		return decision === "committed" ? "committed" : decision;
	}

	private async verifyCanonicalCommit(
		lockPath: string,
		canonicalPath: string,
		expected: SyncIndex,
		expectedFingerprint: string | null,
	): Promise<IndexFileSnapshot> {
		const [canonical, lock] = await Promise.all([
			this.inspectExpectedIndex(
				canonicalPath,
				expected,
				this.transitionIndexWriteService,
				"target",
			),
			this.yandexClient.getResource(lockPath, 1, 0, true),
		]);
		if (
			canonical.exists &&
			canonical.readable &&
			canonical.matches &&
			!lock &&
			(!expectedFingerprint ||
				canonical.snapshot?.fingerprint === expectedFingerprint) &&
			canonical.snapshot
		) {
			return canonical.snapshot;
		}
		if (
			canonical.exists &&
			canonical.readable &&
			!canonical.matches &&
			!lock
		) {
			throw new RemoteIndexConcurrentModificationError(
				"Canonical index contains a different logical state",
				"move-attempted",
				false,
			);
		}
		throw new AmbiguousRemoteIndexStateError(
			"Canonical index commit could not be verified",
			"move-attempted",
		);
	}

	private async isExpectedCanonicalCommitted(
		lockPath: string,
		canonicalPath: string,
		expected: SyncIndex,
		expectedFingerprint: string | null,
	): Promise<boolean> {
		try {
			await this.verifyCanonicalCommit(
				lockPath,
				canonicalPath,
				expected,
				expectedFingerprint,
			);
			return true;
		} catch {
			return false;
		}
	}

	private async rollbackOwnedLock(
		lockPath: string,
		canonicalPath: string,
		original: IndexFileSnapshot,
		context: Record<string, unknown>,
	): Promise<IndexTransactionOutcome> {
		try {
			const outcome = await rollbackRawIndexSnapshot(
				{
					exists: async (path) =>
						(await this.yandexClient.getResource(
							path,
							1,
							0,
							true,
						)) !== null,
					readRaw: async (path) =>
						await this.yandexClient.downloadFile(path, true),
					writeRaw: async (path, raw) =>
						await this.yandexClient.uploadFile(
							path,
							raw,
							true,
							true,
							true,
						),
					moveExclusive: async (fromPath, toPath) =>
						await this.yandexClient.moveResourceExclusive(
							fromPath,
							toPath,
						),
				},
				lockPath,
				canonicalPath,
				original.raw,
				async (raw) => {
					await this.decodeIndexSnapshot(
						raw,
						true,
						this.transitionIndexReadService,
						"source",
					);
				},
			);
			if (outcome !== "rolled-back") return outcome;
			logger.warn("Canonical index transaction rolled back", {
				...context,
				outcome: "rolled-back",
				restoredRevision: original.index.revision,
				restoredEpoch: shortenDiagnosticValue(original.index.epoch),
				restoredFingerprint: shortenDiagnosticValue(
					original.fingerprint,
				),
			});
			return outcome;
		} catch (rollbackError) {
			logger.error("Canonical index rollback is ambiguous", {
				...context,
				outcome: "ambiguous",
				error: rollbackError,
			});
			return "ambiguous";
		}
	}

	private async finalizeCommittedTransaction(
		merged: SyncIndex,
	): Promise<void> {
		this.remoteIndex = merged;
		this.loadedRemoteIndex = this.cloneIndex(merged);
		this.completedMoveIds.clear();
		this.allowLegacyWriteOnce = false;
		const replacedRemote = this.replaceRemoteOnNextSave;
		this.replaceRemoteOnNextSave = false;
		if (!replacedRemote) return;

		this.finalizeForceEpoch(merged);
		try {
			await this.cleanupForceReplacedLocks();
		} catch (cleanupError) {
			logger.warn("Could not remove locks superseded by force sync:", {
				error: cleanupError,
			});
		}
	}

	private async logSemanticIndexMismatch(
		expected: SyncIndex,
		actual: SyncIndex,
		context: Record<string, unknown>,
	): Promise<void> {
		const sections: Array<Record<string, unknown>> = [];
		const keys = new Set([
			...Object.keys(expected),
			...Object.keys(actual),
		]);
		for (const key of keys) {
			const expectedValue = stableSerialize(
				(expected as unknown as Record<string, unknown>)[key],
			);
			const actualValue = stableSerialize(
				(actual as unknown as Record<string, unknown>)[key],
			);
			if (expectedValue === actualValue) continue;
			const [expectedHash, actualHash] = await Promise.all([
				computeSha256FromString(expectedValue),
				computeSha256FromString(actualValue),
			]);
			sections.push({
				section: key,
				expectedSize: expectedValue.length,
				actualSize: actualValue.length,
				expectedSha256: expectedHash.slice(0, 12),
				actualSha256: actualHash.slice(0, 12),
			});
		}
		logger.error("Written index differs after JSON roundtrip", {
			...context,
			sections,
		});
	}

	private cloneIndex(index: SyncIndex): SyncIndex {
		return this.cloneValue(index);
	}

	private cloneValue<T>(value: T): T {
		return JSON.parse(JSON.stringify(value)) as T;
	}

	private sameValue(left: unknown, right: unknown): boolean {
		return stableSerialize(left) === stableSerialize(right);
	}

	private getResourceFingerprint(
		resource: YandexResource | null,
	): string | null {
		return this.yandexClient.getContentFingerprint(resource);
	}

	private createTransactionId(): string {
		return `${Date.now().toString(36)}.${Math.random()
			.toString(36)
			.slice(2, 10)}`;
	}

	private assertEpochCompatible(index: SyncIndex): void {
		const observedEpoch = this.localState.observedEpoch;
		if (
			observedEpoch &&
			index.epoch !== observedEpoch &&
			!this.allowLegacyWriteOnce
		) {
			throw new IndexEpochMismatchError(observedEpoch, index.epoch);
		}
	}

	private assertMaintenanceCompatible(index: SyncIndex): void {
		const maintenance = index.maintenance;
		if (
			maintenance &&
			maintenance.initiatedBy !== this.settings.deviceId &&
			maintenance.phase !== "cleanup" &&
			maintenance.phase !== "stable"
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

	private wait(ms: number): Promise<void> {
		return new Promise((resolve) => window.setTimeout(resolve, ms));
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
		try {
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
				manifest: this.parseEncryptionManifest(data),
				validationToken: `present:${snapshot.fingerprint}`,
			};
		} catch (e) {
			if (this.isNotFoundError(e)) {
				return { manifest: null, validationToken: "absent" };
			}
			throw e;
		}
	}

	/** Validate a manifest token without downloading unchanged content. */
	async isEncryptionManifestTokenCurrent(token: string): Promise<boolean> {
		const resource = await this.yandexClient.getResource(
			this.getEncryptionManifestPath(),
			1,
			0,
			true,
		);
		if (token === "absent") return resource === null;
		if (!resource) return false;
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
			if (!fingerprint) continue;
			result.push({ path: localPath, fingerprint });
		}

		return result;
	}

	private parseEncryptionManifest(
		data: Record<string, unknown>,
	): RemoteEncryptionManifest {
		const salt = data.salt;
		if (typeof salt !== "string" || !salt) {
			throw new Error("Invalid encryption manifest: missing salt");
		}

		if (data.version === 1) {
			return {
				version: 1,
				state: "enabled",
				revision: 1,
				salt,
				verifier: null,
				legacy: true,
				updatedAt: 0,
				updatedBy: "",
			};
		}

		if (data.version !== 2) {
			throw new Error("Unsupported encryption manifest version");
		}

		const state = data.state;
		const revision = data.revision;
		const verifier = data.verifier;
		const updatedAt = data.updatedAt;
		const updatedBy = data.updatedBy;

		if (
			typeof state !== "string" ||
			!this.isEncryptionManifestState(state)
		) {
			throw new Error("Invalid encryption manifest: unsupported state");
		}
		if (typeof revision !== "number" || revision < 1) {
			throw new Error("Invalid encryption manifest: invalid revision");
		}
		if (typeof verifier !== "string" || !verifier) {
			throw new Error("Invalid encryption manifest: missing verifier");
		}
		if (typeof updatedAt !== "number") {
			throw new Error("Invalid encryption manifest: invalid updatedAt");
		}
		if (typeof updatedBy !== "string") {
			throw new Error("Invalid encryption manifest: invalid updatedBy");
		}

		return {
			version: 2,
			state,
			revision,
			salt,
			verifier,
			kdf: {
				name: "PBKDF2",
				hash: "SHA-256",
				iterations: PBKDF2_ITERATIONS,
			},
			cipher: {
				name: "AES-GCM",
				keyLength: AES_KEY_LENGTH,
				ivLength: IV_LENGTH,
			},
				updatedAt,
				updatedBy,
			transition: this.parseEncryptionTransition(data.transition),
			};
	}

	private parseEncryptionTransition(
		value: unknown,
	): EncryptionTransitionDescriptor | undefined {
		if (value === undefined) return undefined;
		if (!value || typeof value !== "object") {
			throw new Error("Invalid encryption manifest: invalid transition");
		}
		const data = value as Record<string, unknown>;
		const phases = [
			"prepared",
			"files-copied",
			"index-committed",
			"stable",
			"cleanup",
		];
		const validRevision = (revision: unknown): boolean =>
			revision === null ||
			(typeof revision === "number" &&
				Number.isInteger(revision) &&
				revision >= 1);
		if (
			typeof data.id !== "string" ||
			typeof data.phase !== "string" ||
			!phases.includes(data.phase) ||
			!validRevision(data.sourceRevision) ||
			!validRevision(data.targetRevision) ||
			typeof data.initiatedBy !== "string"
		) {
			throw new Error("Invalid encryption manifest: invalid transition");
		}
		return {
			id: data.id,
			phase: data.phase as EncryptionTransitionDescriptor["phase"],
			sourceRevision: data.sourceRevision as number | null,
			targetRevision: data.targetRevision as number | null,
			initiatedBy: data.initiatedBy,
			source: this.parseEncryptionModeDescriptor(data.source),
			target: this.parseEncryptionModeDescriptor(data.target),
		};
	}

	private parseEncryptionModeDescriptor(
		value: unknown,
	): EncryptionTransitionDescriptor["source"] {
		if (value === undefined) return undefined;
		if (!value || typeof value !== "object") {
			throw new Error(
				"Invalid encryption manifest: invalid mode descriptor",
			);
		}
		const descriptor = value as Record<string, unknown>;
		if (
			typeof descriptor.enabled !== "boolean" ||
			!(
				descriptor.revision === null ||
				typeof descriptor.revision === "number"
			) ||
			!(
				descriptor.salt === null ||
				typeof descriptor.salt === "string"
			) ||
			!(
				descriptor.verifier === null ||
				typeof descriptor.verifier === "string"
			)
		) {
			throw new Error(
				"Invalid encryption manifest: invalid mode descriptor",
			);
		}
		return {
			enabled: descriptor.enabled,
			revision: descriptor.revision,
			salt: descriptor.salt,
			verifier: descriptor.verifier,
		};
	}

	private isEncryptionManifestState(
		value: string,
	): value is EncryptionManifestState {
		return ENCRYPTION_MANIFEST_STATES.includes(
			value as EncryptionManifestState,
		);
	}

	private isNotFoundError(e: unknown): boolean {
		return e instanceof YandexApiError && e.status === 404;
	}
}

export class RemoteIndexTransactionError extends Error {
	readonly retryable: boolean;
	readonly cause?: unknown;

	constructor(
		message: string,
		name: string,
		readonly outcome: IndexTransactionOutcome,
		readonly stage: IndexTransactionStage,
		lockContention: boolean,
		cause?: unknown,
	) {
		super(message);
		this.name = name;
		this.retryable = shouldRetryIndexTransaction(
			outcome,
			lockContention,
		);
		this.cause = cause;
	}
}

/**
 * Thrown when another writer conclusively changed canonical index state.
 */
export class RemoteIndexConcurrentModificationError extends RemoteIndexTransactionError {
	constructor(
		message: string,
		stage: IndexTransactionStage = "acquired",
		lockContention = true,
		cause?: unknown,
	) {
		super(
			message,
			"RemoteIndexConcurrentModificationError",
			"concurrent",
			stage,
			lockContention,
			cause,
		);
	}
}

export class RemoteIndexContentMismatchError extends RemoteIndexTransactionError {
	constructor(message: string, stage: IndexTransactionStage) {
		super(
			message,
			"RemoteIndexContentMismatchError",
			"ambiguous",
			stage,
			false,
		);
	}
}

export class RemoteIndexRolledBackError extends RemoteIndexTransactionError {
	constructor(
		message: string,
		stage: IndexTransactionStage,
		cause?: unknown,
	) {
		super(
			message,
			"RemoteIndexRolledBackError",
			"rolled-back",
			stage,
			false,
			cause,
		);
	}
}

export class AmbiguousRemoteIndexStateError extends RemoteIndexTransactionError {
	constructor(
		message: string,
		stage: IndexTransactionStage,
		cause?: unknown,
	) {
		super(
			message,
			"AmbiguousRemoteIndexStateError",
			"ambiguous",
			stage,
			false,
			cause,
		);
	}
}

export class RemoteIndexLockedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RemoteIndexLockedError";
	}
}

export class LegacyIndexVersionError extends Error {
	readonly version: number | undefined;

	constructor(version: number | undefined) {
		super(
			`Remote sync index version ${String(version)} is not supported by plugin 2.0.0-beta.8. Run an explicit force sync to create index v3.`,
		);
		this.name = "LegacyIndexVersionError";
		this.version = version;
	}
}

export class UnreadableRemoteIndexError extends Error {
	readonly rawSize: number;
	readonly fingerprint: string | null;
	readonly rawSha256: string;
	readonly attempts: IndexDecodeAttempt[];

	constructor(details: {
		rawSize: number;
		fingerprint: string | null;
		rawSha256: string;
		attempts: IndexDecodeAttempt[];
	}) {
		super(
			"Remote sync index could not be decoded with any permitted codec.",
		);
		this.name = "UnreadableRemoteIndexError";
		this.rawSize = details.rawSize;
		this.fingerprint = details.fingerprint;
		this.rawSha256 = details.rawSha256;
		this.attempts = details.attempts.map((attempt) => ({ ...attempt }));
	}
}

export class AmbiguousRemoteIndexLockError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AmbiguousRemoteIndexLockError";
	}
}

export class IndexEpochMismatchError extends Error {
	constructor(
		readonly observedEpoch: string,
		readonly canonicalEpoch: string,
	) {
		super(
			"Canonical sync history was replaced by Force sync on another device. Create a backup and run Force sync from remote.",
		);
		this.name = "IndexEpochMismatchError";
	}
}

export class RemoteMaintenanceActiveError extends Error {
	constructor(
		public readonly transitionId: string,
		public readonly initiatedBy: string,
	) {
		super(
			`Remote encryption maintenance ${transitionId} is owned by ${initiatedBy}`,
		);
		this.name = "RemoteMaintenanceActiveError";
	}
}
