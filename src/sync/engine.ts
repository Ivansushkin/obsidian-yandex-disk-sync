import { VaultAdapter } from "../api/vault-adapter";
import { YandexDiskClient } from "../api/yandex-client";
import type { FailureSummary, RetryProgress } from "../errors";
import { t } from "../i18n";
import type {
	SyncPhase,
	SyncProgress,
	SyncResult,
	SyncSessionKind,
	SyncState,
	YandexDiskSyncSettings,
} from "../types";
import { INITIAL_SYNC_STATE } from "../types";
import { logger, shortenDiagnosticValue } from "../utils/logger";
import { IndexManager } from "./canonical/manager";
import type {
	ExternalSyncBlock,
	ExternalSyncBlockKind,
	IndexSaveCallback,
	SyncEventCallback,
	SyncGuardCallback,
	SyncGuardResult,
	SyncLifecycleContext,
	SyncLifecycleOutcome,
	SyncRunOptions,
} from "./contracts";
import {
	SyncCoordinator,
	type ActiveSyncSession,
	type QueuedSyncSession,
} from "./coordinator";
import * as syncErrors from "./errors";
import * as folderMutations from "./files/folder-mutations";
import * as fileOperations from "./files/operations";
import * as remoteMoves from "./files/remote-moves";
import * as fileRename from "./files/rename";
import * as realtimeSync from "./realtime/batch";
import { renameBatchNow } from "./realtime/rename-batch";
import {
	type DurableFileRenameEvent,
	type DurableRenameEvent,
	type FileRenameOutcome,
	type FolderMutationOutcome,
	type RealtimeBatchResult,
	type RealtimeFileEvent,
	type RenameBatchResult,
	type WatcherCausalContext,
} from "./realtime/rules";
import { ConflictResolver } from "./reconciliation/conflicts";
import * as reconciliationContext from "./reconciliation/context";
import * as encryptionRewrite from "./workflows/encryption-rewrite";
import * as forceSync from "./workflows/force";
import {
	applyForceReplacement,
	type ForceReplacementDependencies,
	type ForceReplacementPorts,
} from "./workflows/force-replacement";
import * as fullSync from "./workflows/full";
export type {
	ExternalSyncBlock,
	ExternalSyncBlockKind,
	ForceBackupProof,
	ForcePreflightProof,
	IndexSaveCallback,
	PhysicalRewriteUploadProof,
	SyncEventCallback,
	SyncGuardCallback,
	SyncGuardResult,
	SyncLifecycleContext,
	SyncLifecycleOutcome,
	SyncRunOptions,
} from "./contracts";
export class SyncEngine {
	private yandexClient: YandexDiskClient;
	private vaultAdapter: VaultAdapter;
	private indexManager: IndexManager;
	private conflictResolver: ConflictResolver;
	private settings: YandexDiskSyncSettings;

	private state: SyncState = { ...INITIAL_SYNC_STATE };
	private eventListeners: SyncEventCallback[] = [];
	private indexSaveCallback: IndexSaveCallback | null = null;
	private syncGuardCallback: SyncGuardCallback | null = null;
	private externalBlocks = new Map<
		ExternalSyncBlockKind,
		ExternalSyncBlock
	>();
	private isSyncing = false;
	private isPaused = false;
	private coordinator: SyncCoordinator;
	private uiOwnerSessionId: string | null = null;
	private expectedWatcherEvents = new Map<string, number>();
	private realtimeGuardValidationToken: string | undefined;
	private epochReplacementPending = false;

	private syncPauseCallbacks: Array<
		(context: SyncLifecycleContext) => void | Promise<void>
	> = [];
	private syncPrepareCallbacks: Array<
		(context: SyncLifecycleContext) => void | Promise<void>
	> = [];
	private syncResumeCallbacks: Array<
		(outcome: SyncLifecycleOutcome) => void | Promise<void>
	> = [];
	private syncFinalizeCallbacks: Array<
		(
			context: SyncLifecycleContext,
			result: SyncResult,
		) => void | Promise<void>
	> = [];

	/** Surface transport backoff only inside the currently owned activity. */
	reportRetry(retry?: RetryProgress): void {
		if (this.state.status === "syncing") {
			this.updateState({ retry });
		}
	}

	hasPendingWork(): boolean {
		return this.coordinator.hasPendingWork();
	}

	constructor(
		yandexClient: YandexDiskClient,
		vaultAdapter: VaultAdapter,
		indexManager: IndexManager,
		settings: YandexDiskSyncSettings,
	) {
		this.yandexClient = yandexClient;
		this.vaultAdapter = vaultAdapter;
		this.indexManager = indexManager;
		this.conflictResolver = new ConflictResolver();
		this.settings = settings;
		this.coordinator = new SyncCoordinator({
			onPendingWorkChanged: () => this.updateState({}),
			onQueued: (session) => this.handleSessionQueued(session),
			onEnter: (session) => this.handleSessionEnter(session),
			onExit: (session, success, error) =>
				this.handleSessionExit(session, success, error),
		});
		logger.configure({
			contextProvider: () => {
				const session = this.coordinator.getActiveSession();
				return session
					? {
							sessionId: session.id,
							sessionKind: session.kind,
						}
					: undefined;
			},
		});
	}

	private forceReplacementPorts: ForceReplacementPorts | null = null;

	/** Wire plugin-owned Force callbacks separately from each verified run plan. */
	setForceReplacementPorts(ports: ForceReplacementPorts): void {
		this.forceReplacementPorts = ports;
	}

	private forceReplacementDependencies(): ForceReplacementDependencies {
		const readPorts = () => {
			if (!this.forceReplacementPorts) {
				throw new Error("Force replacement ports are not configured");
			}
			return this.forceReplacementPorts;
		};
		readPorts();
		const getSettings = () => this.settings;
		return {
			client: this.yandexClient,
			adapter: this.vaultAdapter,
			index: this.indexManager,
			get settings() {
				return getSettings();
			},
			get persist() {
				return readPorts().persist;
			},
			get password() {
				return readPorts().password;
			},
			get isCancelled() {
				return readPorts().isCancelled;
			},
			get chooseSourceMode() {
				return readPorts().chooseSourceMode;
			},
			get watcherCutoff() {
				return readPorts().watcherCutoff;
			},
			get retireWatcherEvents() {
				return readPorts().retireWatcherEvents;
			},
			expectWatcherEvent: this.workflowWatcherEvent,
		};
	}

	/**
	 * Set callback for saving local index after auto-sync operations
	 */
	setIndexSaveCallback(callback: IndexSaveCallback): void {
		this.indexSaveCallback = callback;
	}

	/**
	 * Set callback that can block sync before any operation starts.
	 */
	setSyncGuardCallback(callback: SyncGuardCallback): void {
		this.syncGuardCallback = callback;
	}

	/** Set or clear one non-persisted startup/runtime safety block. */
	setExternalBlock(
		kind: ExternalSyncBlockKind,
		reason: string | null,
		failure?: FailureSummary,
	): void {
		if (reason) {
			this.externalBlocks.set(kind, {
				failure,
				kind,
				reason,
				code: this.getExternalBlockCode(kind),
				status: this.getExternalBlockStatus(kind),
			});
		} else {
			this.externalBlocks.delete(kind);
		}
		const active = this.getHighestPriorityExternalBlock();
		if (active) {
			this.setBlockedState(active.reason, active.status, active.failure);
		} else if (
			this.state.status === "encryption-required" ||
			this.state.status === "migration-required" ||
			this.state.status === "error"
		) {
			this.updateState({
				status: "idle",
				errorMessage: undefined,
				retry: undefined,
				failure: undefined,
				currentOperation: undefined,
				progress: undefined,
				phase: undefined,
			});
		}
	}

	/** Compatibility wrapper for encryption-transition callers and tests. */
	setExternalBlockReason(reason: string | null): void {
		this.setExternalBlock("encryption", reason);
	}

	/**
	 * Register a callback for the start of a reconciliation or maintenance session.
	 */
	onSyncPause(
		callback: (context: SyncLifecycleContext) => void | Promise<void>,
	): () => void {
		this.syncPauseCallbacks.push(callback);
		return () => {
			const index = this.syncPauseCallbacks.indexOf(callback);
			if (index >= 0) {
				this.syncPauseCallbacks.splice(index, 1);
			}
		};
	}

	/** Register local preparation that must finish before a full session queues. */
	onSyncPrepare(
		callback: (context: SyncLifecycleContext) => void | Promise<void>,
	): () => void {
		this.syncPrepareCallbacks.push(callback);
		return () => {
			const index = this.syncPrepareCallbacks.indexOf(callback);
			if (index >= 0) {
				this.syncPrepareCallbacks.splice(index, 1);
			}
		};
	}

	/**
	 * Register a callback for the end of a reconciliation or maintenance session.
	 */
	onSyncResume(
		callback: (outcome: SyncLifecycleOutcome) => void | Promise<void>,
	): () => void {
		this.syncResumeCallbacks.push(callback);
		return () => {
			const index = this.syncResumeCallbacks.indexOf(callback);
			if (index >= 0) {
				this.syncResumeCallbacks.splice(index, 1);
			}
		};
	}

	/**
	 * Register reconciliation settlement that must finish before a successful
	 * result advances the local observed revision.
	 */
	onSyncFinalize(
		callback: (
			context: SyncLifecycleContext,
			result: SyncResult,
		) => void | Promise<void>,
	): () => void {
		this.syncFinalizeCallbacks.push(callback);
		return () => {
			const index = this.syncFinalizeCallbacks.indexOf(callback);
			if (index >= 0) {
				this.syncFinalizeCallbacks.splice(index, 1);
			}
		};
	}

	/**
	 * Update settings
	 */
	updateSettings(settings: YandexDiskSyncSettings): void {
		this.settings = settings;
	}

	/**
	 * Get current synchronization state
	 */
	getState(): SyncState {
		return { ...this.state };
	}

	/**
	 * Check if synchronization is in progress
	 */
	isSyncInProgress(): boolean {
		return this.isSyncing || this.uiOwnerSessionId !== null;
	}

	/**
	 * Check if synchronization is paused
	 */
	isSyncPaused(): boolean {
		return this.isPaused;
	}

	/**
	 * Serialize an encryption transition and buffer watcher events until it
	 * has fully completed.
	 */
	async runExclusiveMaintenance<T>(task: () => Promise<T>): Promise<T> {
		return await this.coordinator.run("maintenance", async () => {
			const context = this.getSyncLifecycleContext();
			let success = false;
			try {
				await this.notifySyncPauseCallbacks(context);
				const result = await task();
				success = true;
				return result;
			} finally {
				await this.notifySyncResumeCallbacks({
					...context,
					success,
				});
			}
		});
	}

	/** Show post-commit maintenance cleanup without replacing session ownership. */
	showMaintenanceCleanupPhase(): void {
		if (this.coordinator.getActiveKind() === "maintenance") {
			this.setSyncPhase("cleanup");
		}
	}

	/** Keep an outer full activity visible while pre-full realtime work drains. */
	showFullQueueWaitPhase(sessionId: string): void {
		if (this.uiOwnerSessionId === sessionId) {
			this.setSyncPhase("queued");
		}
	}

	/**
	 * Consume a watcher event produced by a local mutation performed by the
	 * sync engine itself.
	 */
	consumeInternalWatcherEvent(
		path: string,
		action: "upload" | "delete" | "rename",
	): boolean {
		const key = `${action}:${path}`;
		const count = this.expectedWatcherEvents.get(key) ?? 0;
		if (count <= 0) {
			return false;
		}
		if (count === 1) {
			this.expectedWatcherEvents.delete(key);
		} else {
			this.expectedWatcherEvents.set(key, count - 1);
		}
		logger.debug("Suppressed internal watcher event", {
			action,
			path,
			remainingExpectedEvents: Math.max(0, count - 1),
		});
		return true;
	}

	private expectWatcherEvent(
		path: string,
		action: "upload" | "delete" | "rename",
	): void {
		const key = `${action}:${path}`;
		this.expectedWatcherEvents.set(
			key,
			(this.expectedWatcherEvents.get(key) ?? 0) + 1,
		);
		logger.debug("Registered expected internal watcher event", {
			action,
			path,
			expectedEvents: this.expectedWatcherEvents.get(key),
		});
	}

	/**
	 * Subscribe to state changes
	 */
	onStateChange(callback: SyncEventCallback): () => void {
		this.eventListeners.push(callback);
		return () => {
			const index = this.eventListeners.indexOf(callback);
			if (index >= 0) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Notify listeners about state change
	 */
	private notifyStateChange(): void {
		for (const listener of this.eventListeners) {
			try {
				listener(this.state);
			} catch (e) {
				logger.error("Error in state handler:", { error: e });
			}
		}
	}

	/**
	 * Update state
	 */
	private updateState(partial: Partial<SyncState>): void {
		this.state = { ...this.state, ...partial };
		this.notifyStateChange();
	}

	/** Start representing a coordinator session without replacing an outer owner. */
	private beginUiActivity(
		sessionId: string,
		sessionKind: SyncSessionKind,
		phase: SyncPhase,
		startedAt = Date.now(),
	): boolean {
		if (this.uiOwnerSessionId && this.uiOwnerSessionId !== sessionId) {
			return false;
		}
		const existingOwner = this.uiOwnerSessionId === sessionId;
		this.uiOwnerSessionId = sessionId;
		this.updateState({
			status: "syncing",
			errorMessage: undefined,
			retry: undefined,
			failure: undefined,
			sessionId,
			sessionKind,
			startedAt: existingOwner
				? (this.state.startedAt ?? startedAt)
				: startedAt,
		});
		this.setSyncPhase(phase);
		return true;
	}

	/** Update one honest phase and clear stale determinate progress by default. */
	private setSyncPhase(
		phase: SyncPhase,
		currentOperation = this.getPhaseLabel(phase),
		progress?: SyncProgress,
	): void {
		this.updateState({
			phase,
			currentOperation,
			progress:
				progress && progress.total > 0
					? {
							completed: Math.min(
								Math.max(0, progress.completed),
								progress.total,
							),
							total: progress.total,
						}
					: undefined,
		});
	}

	/** Resolve the localized default operation text for a stable phase. */
	private getPhaseLabel(phase: SyncPhase): string {
		const keys: Record<SyncPhase, Parameters<typeof t>[0]> = {
			"preparing-local": "status.op.preparing_local",
			queued: "status.op.queued",
			validating: "status.op.validating",
			"checking-remote": "status.op.checking_remote_folder",
			"loading-index": "status.op.loading_remote_index",
			"scanning-local": "status.op.scanning_local_files",
			"scanning-remote": "status.op.getting_remote_files",
			analyzing: "status.op.analyzing_changes",
			"creating-folders": "status.op.creating_folders",
			applying: "status.op.applying_changes",
			"saving-index": "status.op.saving_indexes",
			cleanup: "status.op.cleanup",
			finalizing: "status.op.finalizing",
		};
		return t(keys[phase]);
	}

	/** Represent a session as waiting without replacing an outer UI owner. */
	private handleSessionQueued(session: QueuedSyncSession): void {
		this.beginUiActivity(
			session.id,
			session.kind,
			"queued",
			session.enqueuedAt,
		);
	}

	/** Represent a coordinator session after it obtains exclusive ownership. */
	private handleSessionEnter(session: ActiveSyncSession): void {
		this.beginUiActivity(
			session.id,
			session.kind,
			"validating",
			session.enqueuedAt,
		);
	}

	/** Publish the terminal status only after coordinator settlement completes. */
	private handleSessionExit(
		session: ActiveSyncSession,
		success: boolean,
		error?: unknown,
	): void {
		if (this.uiOwnerSessionId !== session.id) {
			return;
		}
		this.uiOwnerSessionId = null;
		const activeBlock = this.getHighestPriorityExternalBlock();
		const failed =
			!success || (this.state.status === "error" && !activeBlock);
		const terminalFailure =
			error instanceof Error
				? syncErrors.createSyncFailure(error, {
						stage: this.state.phase ?? session.kind,
						action: "unknown",
					}).summary
				: (activeBlock?.failure ??
					(failed ? this.state.failure : undefined));
		this.updateState({
			status: activeBlock?.status ?? (failed ? "error" : "idle"),
			failure: terminalFailure,
			lastSyncTime:
				!failed && !activeBlock ? Date.now() : this.state.lastSyncTime,
			errorMessage:
				error instanceof Error
					? syncErrors.formatOperationFailure(terminalFailure!)
					: activeBlock
						? activeBlock.reason
						: failed
							? this.state.errorMessage
							: undefined,
			sessionId: undefined,
			sessionKind: undefined,
			phase: undefined,
			startedAt: undefined,
			currentOperation: undefined,
			progress: undefined,
			retry: undefined,
		});
	}

	/**
	 * Pause synchronization
	 */
	pause(): void {
		this.isPaused = true;
		this.updateState({
			status: "paused",
			sessionId: undefined,
			sessionKind: undefined,
			phase: undefined,
			startedAt: undefined,
			currentOperation: undefined,
			progress: undefined,
			retry: undefined,
		});
		logger.info("Synchronization paused");
	}

	/**
	 * Resume synchronization
	 */
	resume(): void {
		this.isPaused = false;
		const activeBlock = this.getHighestPriorityExternalBlock();
		this.updateState({
			status: activeBlock?.status ?? "idle",
			errorMessage: activeBlock?.reason,
		});
		logger.info("Synchronization resumed");
	}

	/**
	 * Capture the causal baseline when a watcher event is observed.
	 */
	getWatcherCausalContext(): WatcherCausalContext {
		const local = this.indexManager.getLocalIndex();
		return {
			epoch: local.observedEpoch,
			baseRevision:
				local.observedEpoch === null ? null : local.observedRevision,
		};
	}

	/**
	 * Classify a missing-target watcher rename from the final in-memory state of
	 * a successful full reconciliation without performing remote operations.
	 */
	classifyPostFullRename(event: DurableFileRenameEvent): FileRenameOutcome {
		return fileRename.classifyPostFullRenameOutcome(
			this.fileRenameDependencies(),
			event,
		);
	}

	/**
	 * Perform full synchronization
	 */
	async fullSync(options?: SyncRunOptions): Promise<SyncResult> {
		const adoption: fullSync.FullSyncContext = {
			adoptionSnapshot: null,
			adoptedEpoch: null,
		};
		const run = async () => {
			try {
				const result = await this.runSyncSession(
					options,
					async (result, startTime, validationToken) => {
						return await fullSync.reconcileFullSync(
							this.fullSyncDependencies(),
							options,
							adoption,
							result,
							startTime,
							validationToken,
						);
					},
					(result) =>
						`Full reconciliation completed: uploaded ${result.uploaded}, downloaded ${result.downloaded}, deleted ${result.deleted}, conflicts ${result.conflicts}, errors ${result.errors.length}`,
				);
				if (adoption.adoptionSnapshot && !result.success) {
					fullSync.restoreAdoptionSnapshot(
						this.indexManager,
						adoption.adoptionSnapshot,
					);
					if (this.indexSaveCallback) {
						await this.indexSaveCallback();
					}
				}
				fullSync.reportEpochAdoption(adoption, result);
				return result;
			} finally {
				this.indexManager.endEpochAdoption?.();
			}
		};
		try {
			return await this.runCoordinatedSession("full", options, run);
		} catch (error) {
			if (adoption.adoptionSnapshot) {
				fullSync.restoreAdoptionSnapshot(
					this.indexManager,
					adoption.adoptionSnapshot,
				);
				if (this.indexSaveCallback) {
					await this.indexSaveCallback();
				}
			}
			const message =
				error instanceof Error ? error.message : String(error);
			logger.warn("Full reconciliation preparation failed", {
				error,
			});
			return this.createErrorResult(message);
		}
	}

	/** Keep watcher work local until a new installation has received the cloud baseline. */
	isInitialRemoteReceivePending(): boolean {
		return this.indexManager.isInitialRemoteReceivePending?.() ?? false;
	}

	/**
	 * Rewrite only the physical representation of every live canonical file
	 * while preserving epoch, logical revisions, tombstones, moves, and
	 * mutation watermarks.
	 */
	async reencodeRemoteFiles(options?: SyncRunOptions): Promise<SyncResult> {
		if (!options?.verifyPhysicalRewriteUpload) {
			throw new Error(
				"Encryption rewrite requires exact target upload proof",
			);
		}
		const run = async () =>
			await this.runSyncSession(
				options,
				async (result) => {
					return await encryptionRewrite.rewriteRemoteFiles(
						this.encryptionRewriteDependencies(),
						options,
						result,
					);
				},
				(result) =>
					`Encryption rewrite completed: uploaded ${result.uploaded}, errors ${result.errors.length}`,
			);
		return await this.runCoordinatedSession("maintenance", options, run);
	}

	/**
	 * Force synchronization from local to remote.
	 * Overwrites ALL remote files with local versions.
	 * Files not present locally are deleted from remote.
	 */
	async forceSyncFromLocal(options?: SyncRunOptions): Promise<SyncResult> {
		const force: forceSync.ForceRunContext = { bootstrapStarted: false };
		const run = async () =>
			await this.runSyncSession(
				options,
				async (result, _startTime, validationToken) => {
					if (options?.forceReplacement) {
						await applyForceReplacement(
							this.forceReplacementDependencies(),
							options.forceReplacement.plan,
							options.forceReplacement.backupMode,
						);
						result.replacementCommitted = true;
						result.epochAdopted = true;
						result.uploaded =
							options.forceReplacement.plan.recovery.source.length;
						return;
					}
					return await forceSync.reconcileForceLocal(
						this.forceSyncDependencies(),
						options,
						force,
						result,
						validationToken,
					);
				},
				(result) =>
					`Force sync from local completed: uploaded ${result.uploaded}, deleted ${result.deleted}, errors ${result.errors.length}`,
			);
		const result = await this.runCoordinatedSession("force", options, run);
		if (force.bootstrapStarted && !result.replacementCommitted) {
			this.indexManager.cancelForceBootstrap();
		}
		return result;
	}

	/**
	 * Force synchronization from remote to local.
	 * Overwrites ALL local files with remote versions.
	 * Files not present on remote are deleted locally.
	 */
	async forceSyncFromRemote(options?: SyncRunOptions): Promise<SyncResult> {
		const force: forceSync.ForceRunContext = { bootstrapStarted: false };
		const run = async () =>
			await this.runSyncSession(
				options,
				async (result) => {
					if (options?.forceReplacement) {
						await applyForceReplacement(
							this.forceReplacementDependencies(),
							options.forceReplacement.plan,
							options.forceReplacement.backupMode,
						);
						result.replacementCommitted = true;
						result.epochAdopted = true;
						result.downloaded =
							options.forceReplacement.plan.recovery.source.length;
						return;
					}
					return await forceSync.reconcileForceRemote(
						this.forceSyncDependencies(),
						options,
						force,
						result,
					);
				},
				(result) =>
					`Force sync from remote completed: downloaded ${result.downloaded}, deleted ${result.deleted}, errors ${result.errors.length}`,
			);
		const result = await this.runCoordinatedSession("force", options, run);
		if (force.bootstrapStarted && !result.replacementCommitted) {
			this.indexManager.cancelForceBootstrap();
		}
		return result;
	}

	/**
	 * Upload file to Yandex Disk.
	 *
	 * When `stampRemoteMtime` is true (default) the server-side mtime of the
	 * just-uploaded resource is fetched and stored on the remote index entry so
	 * the next sync can detect external remote changes via server-mtime
	 * comparison. Set it to false for bulk upload flows that perform a single
	 * batch re-read of the remote file list afterwards (see
	 * `IndexManager.applyServerMtimes`); this saves one `getResource` API call
	 * per uploaded file.
	 */
	async uploadFile(
		path: string,
		skipFolderCheck = false,
		stampRemoteMtime = true,
		snapshot?: { content: ArrayBuffer; sha256: string },
	): Promise<void> {
		return fileOperations.uploadFile(
			this.fileOperationsDependencies(),
			path,
			skipFolderCheck,
			stampRemoteMtime,
			snapshot,
		);
	}

	/**
	 * Download file from Yandex Disk.
	 * `serverMtime` is the server-side modification time of the remote resource
	 * (typically `remoteMeta.mtime` from the conflict resolver), used to stamp
	 * {@link FileMetadata.remoteMtime} on the remote index entry without an
	 * extra API call. When omitted, the server mtime is fetched best-effort.
	 */
	async downloadFile(
		path: string,
		serverMtime?: number,
		expectedLocalSha?: string | null,
	): Promise<void> {
		return fileOperations.downloadFile(
			this.fileOperationsDependencies(),
			path,
			serverMtime,
			expectedLocalSha,
		);
	}

	/**
	 * Delete file on Yandex Disk
	 */
	async deleteRemoteFile(path: string): Promise<void> {
		await fileOperations.deleteRemoteFile(
			this.fileOperationsDependencies(),
			path,
		);
	}

	/**
	 * Delete local file
	 */
	async deleteLocalFile(path: string): Promise<void> {
		await fileOperations.deleteLocalFile(
			this.fileOperationsDependencies(),
			path,
		);
	}

	/**
	 * Apply sequential file windows within one realtime coordinator session.
	 *
	 * The settlement callback receives each window once, before the next read.
	 * @returns Aggregate metadata used to acknowledge only completed or
	 * causally superseded watcher work.
	 */
	async syncFileBatch(
		events: RealtimeFileEvent[],
		settle?: (
			result: RealtimeBatchResult,
			context: SyncLifecycleContext,
		) => void | Promise<void>,
	): Promise<RealtimeBatchResult> {
		let windowsSettled = false;
		const batchResult = await this.coordinator
			.run(
				"realtime",
				async () => {
					const deps = this.realtimeSyncDependencies(
						async (result) => {
							if (this.epochReplacementPending) {
								result.requiresFullSync = "epoch-replaced";
							}
							const session =
								this.coordinator.getActiveSession()!;
							await settle?.(result, {
								sessionId: session.id,
								kind: session.kind,
							});
							windowsSettled = true;
						},
					);
					return await realtimeSync.reconcileRealtimeBatch(
						deps,
						events,
					);
				},
				{
					settle: async (outcome, session) => {
						if (outcome.status === "fulfilled" && !windowsSettled) {
							await settle?.(outcome.value, {
								sessionId: session.id,
								kind: session.kind,
							});
						}
					},
				},
			)
			.finally(() => {
				this.realtimeGuardValidationToken = undefined;
			});
		if (this.epochReplacementPending) {
			batchResult.requiresFullSync = "epoch-replaced";
		}
		return batchResult;
	}

	/** Run ordinary independent renames with shared commits and owned settlement. */
	async renameBatch(
		events: readonly DurableRenameEvent[],
		settle: (
			outcomes: RenameBatchResult,
			lifecycle: SyncLifecycleContext,
		) => void | Promise<void>,
	): Promise<RenameBatchResult | null> {
		return await this.coordinator
			.run(
				"realtime",
				() => {
					this.setSyncPhase("applying", t("status.op.renaming_file"));
					return renameBatchNow(
						this.fileRenameDependencies(),
						events,
					);
				},
				{
					settle: async (result, session) => {
						if (result.status === "fulfilled" && result.value) {
							await settle(result.value, {
								sessionId: session.id,
								kind: session.kind,
							});
						}
					},
				},
			)
			.finally(() => {
				this.realtimeGuardValidationToken = undefined;
			});
	}

	/**
	 * Rename file on Yandex Disk
	 */
	async renameFile(
		oldPath: string,
		newPath: string,
		context?: WatcherCausalContext,
		settle?: (
			outcome: FileRenameOutcome,
			lifecycle: SyncLifecycleContext,
		) => void | Promise<void>,
	): Promise<FileRenameOutcome> {
		return await this.coordinator
			.run(
				"realtime",
				() => {
					this.setSyncPhase("applying", t("status.op.renaming_file"));
					return fileRename.renameFileNow(
						this.fileRenameDependencies(),
						oldPath,
						newPath,
						context,
					);
				},
				{
					settle: async (outcome, session) => {
						if (outcome.status === "fulfilled") {
							await settle?.(outcome.value, {
								sessionId: session.id,
								kind: session.kind,
							});
						}
					},
				},
			)
			.finally(() => {
				this.realtimeGuardValidationToken = undefined;
			});
	}

	/**
	 * Synchronize deletion of a folder as one logical prefix mutation.
	 */
	async deleteFolder(
		path: string,
		context: WatcherCausalContext = this.getWatcherCausalContext(),
		onPrepared?: (outcome: FolderMutationOutcome) => void | Promise<void>,
	): Promise<FolderMutationOutcome> {
		return await this.enqueueRealtime(async () => {
			return await folderMutations.deleteFolderNow(
				this.folderMutationsDependencies(),
				path,
				context,
				onPrepared,
			);
		});
	}

	/**
	 * Synchronize a folder rename while preserving a logical move marker.
	 */
	async renameFolder(
		oldPath: string,
		newPath: string,
		context: WatcherCausalContext = this.getWatcherCausalContext(),
		onPrepared?: (outcome: FolderMutationOutcome) => void | Promise<void>,
	): Promise<FolderMutationOutcome> {
		return await this.enqueueRealtime(async () => {
			return await folderMutations.renameFolderNow(
				this.folderMutationsDependencies(),
				oldPath,
				newPath,
				context,
				onPrepared,
			);
		});
	}

	/**
	 * Create an empty result for a new sync session.
	 */
	private createEmptyResult(startTime: number): SyncResult {
		return {
			success: true,
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			conflicts: 0,
			errors: [],
			startTime,
			endTime: 0,
		};
	}

	private async enqueueRealtime<T>(task: () => Promise<T>): Promise<T> {
		return await this.coordinator.run("realtime", async () => {
			this.setSyncPhase("applying", t("status.op.applying_realtime"));
			return await task();
		});
	}

	/** Dispatch a session while allowing an owned maintenance body to nest. */
	private async runCoordinatedSession<T>(
		kind: SyncSessionKind,
		options: SyncRunOptions | undefined,
		run: () => Promise<T>,
	): Promise<T> {
		if (
			options?.skipMaintenanceGuard &&
			this.coordinator.getActiveKind() === "maintenance"
		) {
			return await run();
		}
		let preparedSessionId: string | null = null;
		const unsubscribe = options?.onActivity
			? this.onStateChange((state) => {
					if (state.sessionId === preparedSessionId) {
						options.onActivity?.(state);
					}
				})
			: undefined;
		try {
			return await this.coordinator.run(kind, run, {
				prepare: async (session) => {
					preparedSessionId = session.id;
					if (kind !== "full") {
						return;
					}
					this.beginUiActivity(
						session.id,
						session.kind,
						"preparing-local",
					);
					const context: SyncLifecycleContext = {
						sessionId: session.id,
						kind: session.kind,
						startup: options?.startup,
					};
					for (const callback of this.syncPrepareCallbacks) {
						await callback(context);
					}
				},
			});
		} catch (error) {
			if (
				preparedSessionId &&
				this.uiOwnerSessionId === preparedSessionId
			) {
				this.uiOwnerSessionId = null;
				this.updateState({
					status: "error",
					errorMessage:
						error instanceof Error ? error.message : String(error),
					sessionId: undefined,
					sessionKind: undefined,
					phase: undefined,
					startedAt: undefined,
					currentOperation: undefined,
					progress: undefined,
				});
			}
			throw error;
		} finally {
			unsubscribe?.();
		}
	}

	/**
	 * Notify listeners that sync has started.
	 */
	private async notifySyncPauseCallbacks(
		context: SyncLifecycleContext,
	): Promise<void> {
		for (const callback of this.syncPauseCallbacks) {
			await callback(context);
		}
	}

	/**
	 * Notify listeners that sync has ended.
	 */
	private async notifySyncResumeCallbacks(
		outcome: SyncLifecycleOutcome,
	): Promise<void> {
		let failure: { cause: unknown } | undefined;
		for (const callback of this.syncResumeCallbacks) {
			try {
				await callback({
					...outcome,
					success: outcome.success && !failure,
					epochAdopted: outcome.epochAdopted && !failure,
				});
			} catch (e) {
				failure ??= { cause: e };
				logger.error("Error in sync resume callback:", { error: e });
			}
		}
		if (failure && outcome.success) {
			throw failure.cause;
		}
	}

	/** Run durable reconciliation settlement before marking remote state observed. */
	private async notifySyncFinalizeCallbacks(
		context: SyncLifecycleContext,
		result: SyncResult,
	): Promise<void> {
		for (const callback of this.syncFinalizeCallbacks) {
			await callback(context, result);
		}
	}

	/**
	 * Capture immutable coordinator identity for watcher lifecycle callbacks.
	 */
	private getSyncLifecycleContext(): SyncLifecycleContext {
		const session = this.coordinator.getActiveSession();
		return {
			sessionId: session?.id ?? "uncoordinated",
			kind: session?.kind ?? "full",
		};
	}

	/**
	 * Update progress state during operation execution.
	 */
	private reportProgress(processedOps: number, totalOps: number): void {
		if (totalOps <= 0) {
			return;
		}
		this.setSyncPhase(
			"applying",
			this.state.currentOperation ?? this.getPhaseLabel("applying"),
			{ completed: processedOps, total: totalOps },
		);
	}

	/**
	 * Run a sync session with common guard, lifecycle, and error handling.
	 */
	private async runSyncSession(
		options: SyncRunOptions | undefined,
		body: (
			result: SyncResult,
			startTime: number,
			validationToken?: string,
		) => Promise<void>,
		logMessage: (result: SyncResult) => string,
	): Promise<SyncResult> {
		if (
			this.coordinator.getActiveKind() === "maintenance" &&
			!options?.skipMaintenanceGuard
		) {
			return this.createErrorResult(
				"Encryption maintenance is in progress",
			);
		}
		if (
			this.isPaused &&
			!(
				this.coordinator.getActiveKind() === "force" &&
				options?.forceReplacement
			)
		) {
			logger.warn("Synchronization is paused");
			return this.createErrorResult("Synchronization is paused");
		}

		const startTime = Date.now();
		const result = this.createEmptyResult(startTime);
		const lifecycleContext = this.getSyncLifecycleContext();
		const apiReadsBefore = this.yandexClient.getApiReadMetrics?.();
		this.isSyncing = true;
		let resumeAttempted = false;

		try {
			await this.notifySyncPauseCallbacks(lifecycleContext);
			logger.info(
				"Sync reconciliation started",
				this.getDiagnosticSnapshot(),
			);
			this.setSyncPhase("validating");
			const guard =
				this.coordinator.getActiveKind() === "force" &&
				options?.forceReplacement
					? {
							blockReason: null,
							validationToken: undefined,
							blockCode: undefined,
							failure: undefined,
							blockStatus: undefined,
						}
					: await this.getSyncGuardResult(
							options?.skipEncryptionGuard,
							undefined,
							options?.validateThroughExternalEncryptionBlock,
						);
			if (guard.blockReason) {
				result.errors.push({
					path: "",
					operation: "none",
					code: guard.blockCode ?? "encryption-blocked",
					message: guard.blockReason,
					failure: guard.failure,
				});
				this.setBlockedState(
					guard.blockReason,
					guard.blockStatus ?? "encryption-required",
					guard.failure,
				);
			} else {
				await body(result, startTime, guard.validationToken);
			}

			if (result.errors.length === 0) {
				if (result.epochAdopted) {
					await this.indexManager.assertCanonicalEpoch(
						this.indexManager.getRemoteIndex().epoch,
					);
				}
				this.setSyncPhase("finalizing");
				await this.notifySyncFinalizeCallbacks(
					lifecycleContext,
					result,
				);
			}
			result.success = result.errors.length === 0;
			if (result.success) {
				this.indexManager.markRemoteObserved();
				if (this.indexSaveCallback) {
					await this.indexSaveCallback();
				}
			}
			this.isSyncing = false;
			resumeAttempted = true;
			await this.notifySyncResumeCallbacks({
				...lifecycleContext,
				success: result.success,
				epochAdopted: result.success && result.epochAdopted,
			});
			result.endTime = Date.now();
			syncErrors.summarizeSyncFailure(result, this.state.phase ?? "sync");

			if (!guard.blockReason) {
				this.updateState({
					status: result.success ? "syncing" : "error",
					lastSyncTime: result.success
						? result.endTime
						: this.state.lastSyncTime,
					failure: result.failure,
					errorMessage: result.success
						? undefined
						: syncErrors.formatSyncErrorSummary(result.errors),
				});
			}

			const diagnosticResult = {
				...this.getDiagnosticSnapshot(),
				failure: result.failure,
				durationMs: result.endTime - startTime,
				apiReads: this.diffApiReadMetrics(
					apiReadsBefore,
					this.yandexClient.getApiReadMetrics?.(),
				),
				success: result.success,
				result: {
					uploaded: result.uploaded,
					downloaded: result.downloaded,
					deleted: result.deleted,
					conflicts: result.conflicts,
					errors: result.errors.length,
				},
			};
			if (result.success) {
				logger.info(logMessage(result), diagnosticResult);
			} else {
				logger.warn(
					"Sync reconciliation completed with errors",
					diagnosticResult,
				);
			}

			return result;
		} catch (e) {
			if (
				this.coordinator.getActiveKind() === "force" &&
				options?.forceReplacement &&
				options.forceReplacement.plan.recovery.completion !== null
			) {
				result.replacementCommitted = true;
			}
			result.success = false;
			result.errors.push(
				syncErrors.createSyncError(
					e,
					"",
					"none",
					this.state.phase ?? "sync",
				),
			);
			result.endTime = Date.now();
			syncErrors.summarizeSyncFailure(result, this.state.phase ?? "sync");

			this.updateState({
				status: "error",
				failure: result.failure,
				errorMessage: syncErrors.formatSyncErrorSummary(result.errors),
				progress: undefined,
			});

			logger.error("Critical synchronization error:", {
				...this.getDiagnosticSnapshot(),
				durationMs: result.endTime - startTime,
				apiReads: this.diffApiReadMetrics(
					apiReadsBefore,
					this.yandexClient.getApiReadMetrics?.(),
				),
				error: result.failureCause,
			});
			return result;
		} finally {
			this.isSyncing = false;
			if (!resumeAttempted) {
				await this.notifySyncResumeCallbacks({
					...lifecycleContext,
					success: false,
				});
			}
		}
	}

	/**
	 * Capture compact causal state at durable sync boundaries.
	 */
	private getDiagnosticSnapshot(): Record<string, unknown> {
		const local = this.indexManager.getLocalIndex();
		const canonical = this.indexManager.getRemoteIndex();
		const maintenance = this.indexManager.getMaintenance();
		return {
			epoch: shortenDiagnosticValue(canonical.epoch),
			observedEpoch: shortenDiagnosticValue(local.observedEpoch),
			observedRevision: local.observedRevision,
			canonicalRevision: canonical.revision,
			pendingMutations: this.indexManager.getPendingMutations().length,
			pendingPhysicalActions:
				this.indexManager.getPendingPhysicalActions().length,
			maintenance: maintenance
				? {
						transitionId: shortenDiagnosticValue(maintenance.id),
						kind: maintenance.kind,
						phase: maintenance.phase,
						cleanupPending: maintenance.cleanup.length,
					}
				: null,
		};
	}

	private diffApiReadMetrics(
		before?: ReturnType<YandexDiskClient["getApiReadMetrics"]>,
		after?: ReturnType<YandexDiskClient["getApiReadMetrics"]>,
	): ReturnType<YandexDiskClient["getApiReadMetrics"]> | undefined {
		if (!before || !after) {
			return undefined;
		}
		return {
			manifest: after.manifest - before.manifest,
			index: after.index - before.index,
			root: after.root - before.root,
			tree: after.tree - before.tree,
			other: after.other - before.other,
		};
	}

	/** Consume the one-shot request emitted by a realtime epoch replacement. */
	consumeEpochReplacementRequest(): boolean {
		const pending = this.epochReplacementPending;
		this.epochReplacementPending = false;
		return pending;
	}

	/**
	 * Create an error result.
	 */
	private createErrorResult(message: string): SyncResult {
		return {
			success: false,
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			conflicts: 0,
			errors: [{ path: "", operation: "none", message }],
			startTime: Date.now(),
			endTime: Date.now(),
		};
	}

	private async getSyncGuardResult(
		skipGuard?: boolean,
		validationToken?: string,
		validateThroughExternalBlock = false,
	): Promise<SyncGuardResult> {
		const external = this.getHighestPriorityExternalBlock((block) => {
			if (
				block.kind === "migration" &&
				this.coordinator.getActiveKind() === "force"
			) {
				return false;
			}
			if (
				block.kind === "encryption" &&
				(skipGuard || validateThroughExternalBlock)
			) {
				return false;
			}
			return true;
		});
		if (external) {
			return {
				blockReason: external.reason,
				failure: external.failure,
				blockCode: external.code,
				blockStatus: external.status,
			};
		}
		if (skipGuard) {
			return { blockReason: null };
		}
		if (!this.syncGuardCallback) {
			return { blockReason: null };
		}
		return await this.syncGuardCallback(validationToken);
	}

	private getExternalBlockCode(kind: ExternalSyncBlockKind): string {
		switch (kind) {
			case "force":
				return "force-recovery-pending";
			case "local-state":
				return "local-state-blocked";
			case "migration":
				return "migration-required";
			case "historical":
				return "unsupported-historical";
			case "authentication":
				return "authentication";
			case "encryption":
				return "encryption-blocked";
		}
	}

	private getExternalBlockStatus(
		kind: ExternalSyncBlockKind,
	): ExternalSyncBlock["status"] {
		if (kind === "migration") {
			return "migration-required";
		}
		if (kind === "encryption") {
			return "encryption-required";
		}
		return "error";
	}

	private getHighestPriorityExternalBlock(
		include: (block: ExternalSyncBlock) => boolean = () => true,
	): ExternalSyncBlock | null {
		for (const kind of [
			"local-state",
			"force",
			"historical",
			"authentication",
			"encryption",
			"migration",
		] as const) {
			const block = this.externalBlocks.get(kind);
			if (block && include(block)) {
				return block;
			}
		}
		return null;
	}

	private setBlockedState(
		reason: string,
		status:
			| "error"
			| "migration-required"
			| "encryption-required" = "encryption-required",
		failure?: FailureSummary,
	): void {
		this.updateState({
			status,
			errorMessage: reason,
			failure,
			currentOperation: undefined,
			phase: undefined,
			progress: undefined,
			retry: undefined,
		});
	}

	private readonly workflowGuard = this.getSyncGuardResult.bind(this);
	private readonly workflowBlocked = this.setBlockedState.bind(this);
	private readonly workflowWatcherEvent = this.expectWatcherEvent.bind(this);
	private readonly workflowPhase = this.setSyncPhase.bind(this);
	private readonly workflowProgress = this.reportProgress.bind(this);

	private fileOperationsDependencies(): fileOperations.Dependencies {
		const getSettings = () => this.settings;
		const getIsPaused = () => this.isPaused;
		return {
			getSyncGuardResult: (validationToken) =>
				this.getSyncGuardResult(false, validationToken),
			vaultAdapter: this.vaultAdapter,
			yandexClient: this.yandexClient,
			get settings() {
				return getSettings();
			},
			indexManager: this.indexManager,
			expectWatcherEvent: this.workflowWatcherEvent,
			setSyncPhase: this.workflowPhase,
			onOperationError: (error) => {
				if (!this.state.errorMessage) {
					this.updateState({
						failure: error.failure,
						errorMessage: syncErrors.formatSyncErrorSummary([
							error,
						]),
					});
				}
			},
			get isPaused() {
				return getIsPaused();
			},
		};
	}

	private remoteMovesDependencies(): remoteMoves.Dependencies {
		const getSettings = () => this.settings;
		return {
			indexManager: this.indexManager,
			get settings() {
				return getSettings();
			},
			yandexClient: this.yandexClient,
			vaultAdapter: this.vaultAdapter,
		};
	}

	private syncReconciliationDependencies(): reconciliationContext.Dependencies {
		const getIndexSaveCallback = () => this.indexSaveCallback;
		const getRealtimeGuardValidationToken = () =>
			this.realtimeGuardValidationToken;
		const getEpochReplacementPending = () => this.epochReplacementPending;
		const getSettings = () => this.settings;
		const setRealtimeGuardValidationToken = (
			value: typeof this.realtimeGuardValidationToken,
		) => {
			this.realtimeGuardValidationToken = value;
		};
		const setEpochReplacementPending = (
			value: typeof this.epochReplacementPending,
		) => {
			this.epochReplacementPending = value;
		};
		return {
			indexManager: this.indexManager,
			get indexSaveCallback() {
				return getIndexSaveCallback();
			},
			get realtimeGuardValidationToken() {
				return getRealtimeGuardValidationToken();
			},
			set realtimeGuardValidationToken(value) {
				setRealtimeGuardValidationToken(value);
			},
			getSyncGuardResult: this.workflowGuard,
			setBlockedState: this.workflowBlocked,
			get epochReplacementPending() {
				return getEpochReplacementPending();
			},
			set epochReplacementPending(value) {
				setEpochReplacementPending(value);
			},
			vaultAdapter: this.vaultAdapter,
			get settings() {
				return getSettings();
			},
			yandexClient: this.yandexClient,
			conflictResolver: this.conflictResolver,
			expectWatcherEvent: this.workflowWatcherEvent,
			fileOperations: this.fileOperationsDependencies(),
			remoteMoves: this.remoteMovesDependencies(),
		};
	}

	/** Supply the explicit UI decision used before transferring old offline changes. */
	setEpochAdoptionDecisionCallback(
		callback: (epoch: string) => Promise<"accept" | "preserve" | null>,
	): void {
		this.epochAdoptionDecision = callback;
	}

	private epochAdoptionDecision:
		((epoch: string) => Promise<"accept" | "preserve" | null>) | undefined;

	private forceSyncDependencies(): forceSync.Dependencies {
		const getSettings = () => this.settings;
		const getIndexSaveCallback = () => this.indexSaveCallback;
		return {
			yandexClient: this.yandexClient,
			get settings() {
				return getSettings();
			},
			indexManager: this.indexManager,
			vaultAdapter: this.vaultAdapter,
			setSyncPhase: this.workflowPhase,
			reportProgress: this.workflowProgress,
			get indexSaveCallback() {
				return getIndexSaveCallback();
			},
			fileOperations: this.fileOperationsDependencies(),
			syncReconciliation: this.syncReconciliationDependencies(),
		};
	}

	private encryptionRewriteDependencies(): encryptionRewrite.Dependencies {
		const getSettings = () => this.settings;
		return {
			yandexClient: this.yandexClient,
			setSyncPhase: this.workflowPhase,
			indexManager: this.indexManager,
			vaultAdapter: this.vaultAdapter,
			get settings() {
				return getSettings();
			},
			reportProgress: this.workflowProgress,
			fileOperations: this.fileOperationsDependencies(),
			syncReconciliation: this.syncReconciliationDependencies(),
		};
	}

	private fullSyncDependencies(): fullSync.Dependencies {
		const getSettings = () => this.settings;
		const getIndexSaveCallback = () => this.indexSaveCallback;
		const getIsPaused = () => this.isPaused;
		return {
			decideEpochAdoption: (epoch) =>
				this.epochAdoptionDecision?.(epoch) ?? Promise.resolve(null),
			indexManager: this.indexManager,
			get settings() {
				return getSettings();
			},
			setSyncPhase: this.workflowPhase,
			yandexClient: this.yandexClient,
			get indexSaveCallback() {
				return getIndexSaveCallback();
			},
			conflictResolver: this.conflictResolver,
			reportProgress: this.workflowProgress,
			get isPaused() {
				return getIsPaused();
			},
			getSyncGuardResult: this.workflowGuard,
			fileOperations: this.fileOperationsDependencies(),
			syncReconciliation: this.syncReconciliationDependencies(),
		};
	}

	private realtimeSyncDependencies(
		settleWindow?: realtimeSync.Dependencies["settleWindow"],
	): realtimeSync.Dependencies {
		const getSettings = () => this.settings;
		const getIsPaused = () => this.isPaused;
		const getRealtimeGuardValidationToken = () =>
			this.realtimeGuardValidationToken;
		const getIndexSaveCallback = () => this.indexSaveCallback;
		const setRealtimeGuardValidationToken = (
			value: typeof this.realtimeGuardValidationToken,
		) => {
			this.realtimeGuardValidationToken = value;
		};
		return {
			settleWindow,
			indexManager: this.indexManager,
			get settings() {
				return getSettings();
			},
			getSyncGuardResult: this.workflowGuard,
			get isPaused() {
				return getIsPaused();
			},
			setBlockedState: this.workflowBlocked,
			get realtimeGuardValidationToken() {
				return getRealtimeGuardValidationToken();
			},
			set realtimeGuardValidationToken(value) {
				setRealtimeGuardValidationToken(value);
			},
			setSyncPhase: this.workflowPhase,
			vaultAdapter: this.vaultAdapter,
			get indexSaveCallback() {
				return getIndexSaveCallback();
			},
			fileOperations: this.fileOperationsDependencies(),
			syncReconciliation: this.syncReconciliationDependencies(),
		};
	}

	private fileRenameDependencies(): fileRename.Dependencies {
		const getRealtimeGuardValidationToken = () =>
			this.realtimeGuardValidationToken;
		const getEpochReplacementPending = () => this.epochReplacementPending;
		const getIndexSaveCallback = () => this.indexSaveCallback;
		const getSettings = () => this.settings;
		const setRealtimeGuardValidationToken = (
			value: typeof this.realtimeGuardValidationToken,
		) => {
			this.realtimeGuardValidationToken = value;
		};
		const setEpochReplacementPending = (
			value: typeof this.epochReplacementPending,
		) => {
			this.epochReplacementPending = value;
		};
		return {
			getWatcherCausalContext: () => this.getWatcherCausalContext(),
			vaultAdapter: this.vaultAdapter,
			getSyncGuardResult: this.workflowGuard,
			setBlockedState: this.workflowBlocked,
			get realtimeGuardValidationToken() {
				return getRealtimeGuardValidationToken();
			},
			set realtimeGuardValidationToken(value) {
				setRealtimeGuardValidationToken(value);
			},
			indexManager: this.indexManager,
			get epochReplacementPending() {
				return getEpochReplacementPending();
			},
			set epochReplacementPending(value) {
				setEpochReplacementPending(value);
			},
			get indexSaveCallback() {
				return getIndexSaveCallback();
			},
			get settings() {
				return getSettings();
			},
			yandexClient: this.yandexClient,
			expectWatcherEvent: this.workflowWatcherEvent,
			syncReconciliation: this.syncReconciliationDependencies(),
			fileOperations: this.fileOperationsDependencies(),
			remoteMoves: this.remoteMovesDependencies(),
		};
	}

	private folderMutationsDependencies(): folderMutations.Dependencies {
		const getRealtimeGuardValidationToken = () =>
			this.realtimeGuardValidationToken;
		const getSettings = () => this.settings;
		const getIndexSaveCallback = () => this.indexSaveCallback;
		const setRealtimeGuardValidationToken = (
			value: typeof this.realtimeGuardValidationToken,
		) => {
			this.realtimeGuardValidationToken = value;
		};
		return {
			indexManager: this.indexManager,
			getSyncGuardResult: this.workflowGuard,
			setBlockedState: this.workflowBlocked,
			get realtimeGuardValidationToken() {
				return getRealtimeGuardValidationToken();
			},
			set realtimeGuardValidationToken(value) {
				setRealtimeGuardValidationToken(value);
			},
			get settings() {
				return getSettings();
			},
			get indexSaveCallback() {
				return getIndexSaveCallback();
			},
			fileOperations: this.fileOperationsDependencies(),
			syncReconciliation: this.syncReconciliationDependencies(),
			remoteMoves: this.remoteMovesDependencies(),
		};
	}
}
