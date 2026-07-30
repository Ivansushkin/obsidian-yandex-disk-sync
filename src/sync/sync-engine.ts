/**
 * Main synchronization engine
 */

import type {
	SyncState,
	SyncResult,
	SyncOperation,
	SyncError,
	FileMetadata,
	YandexDiskSyncSettings,
} from "../types";
import { INITIAL_SYNC_STATE } from "../types";
import { YandexDiskClient } from "../api/yandex-client";
import { VaultAdapter } from "../api/vault-adapter";
import {
	IndexManager,
	RemoteIndexConcurrentModificationError,
} from "./index-manager";
import { ConflictResolver } from "./conflict-resolver";
import {
	joinPath,
	getDirectory,
	getExtension,
	getFileName,
} from "../utils/path-utils";
import { computeSha256 } from "../utils/hash-utils";
import { logger, shortenDiagnosticValue } from "../utils/logger";
import { runWithConcurrencySettled } from "../utils/semaphore";
import { t } from "../i18n";
import { SyncCoordinator } from "./sync-coordinator";
import { createConfirmedBaseline } from "./baseline-rules";
import {
	isPhysicalDeleteAuthorized,
	shouldBackupLocalDelete,
} from "./physical-action-rules";

export type SyncEventCallback = (state: SyncState) => void;
export type IndexSaveCallback = () => void | Promise<void>;
export type SyncGuardCallback = () => string | null | Promise<string | null>;

export interface SyncRunOptions {
	/** Skip encryption state guard for internal encryption maintenance flows. */
	skipEncryptionGuard?: boolean;
	/** Allow a sync nested inside the active encryption maintenance flow. */
	skipMaintenanceGuard?: boolean;
	/**
	 * Skip generation of delete_remote operations. Used by encryption transition
	 * flows where remote cleanup of stale paths is handled separately as a bulk
	 * operation, avoiding race conditions from concurrent folder deletions.
	 */
	skipRemoteDeletes?: boolean;
	/** Run after all target files are uploaded and before the canonical commit. */
	beforeIndexCommit?: () => void | Promise<void>;
}

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
	private externalBlockReason: string | null = null;
	private isSyncing = false;
	private isPaused = false;
	private coordinator = new SyncCoordinator();
	private expectedWatcherEvents = new Map<string, number>();

	private syncPauseCallbacks: Array<() => void> = [];
	private syncResumeCallbacks: Array<() => void> = [];

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

	/**
	 * Set externally managed sync block reason.
	 */
	setExternalBlockReason(reason: string | null): void {
		this.externalBlockReason = reason;
		if (reason) {
			this.setBlockedState(reason);
		} else if (this.state.status === "encryption-required") {
			this.updateState({
				status: "idle",
				errorMessage: undefined,
				currentOperation: undefined,
				progress: undefined,
				pendingCount: 0,
			});
		}
	}

	/**
	 * Register callback to be called when full sync starts
	 */
	onSyncPause(callback: () => void): () => void {
		this.syncPauseCallbacks.push(callback);
		return () => {
			const index = this.syncPauseCallbacks.indexOf(callback);
			if (index >= 0) {
				this.syncPauseCallbacks.splice(index, 1);
			}
		};
	}

	/**
	 * Register callback to be called when full sync ends
	 */
	onSyncResume(callback: () => void): () => void {
		this.syncResumeCallbacks.push(callback);
		return () => {
			const index = this.syncResumeCallbacks.indexOf(callback);
			if (index >= 0) {
				this.syncResumeCallbacks.splice(index, 1);
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
		return this.isSyncing;
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
			this.notifySyncPauseCallbacks();
			try {
				return await task();
			} finally {
				this.notifySyncResumeCallbacks();
			}
		});
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
		if (count <= 0) return false;
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

	/**
	 * Pause synchronization
	 */
	pause(): void {
		this.isPaused = true;
		this.updateState({ status: "paused" });
		logger.info("Synchronization paused");
	}

	/**
	 * Resume synchronization
	 */
	resume(): void {
		this.isPaused = false;
		this.updateState({ status: "idle" });
		logger.info("Synchronization resumed");
	}

	/**
	 * Perform full synchronization
	 */
	async fullSync(options?: SyncRunOptions): Promise<SyncResult> {
		const run = async () =>
			await this.runSyncSession(
			options,
			async (result, startTime) => {
				// 1. Ensure remote folder exists
				this.updateState({
					currentOperation: t("status.op.checking_remote_folder"),
				});
				const remoteExists = await this.indexManager.remotePathExists();
				if (!remoteExists) {
					await this.indexManager.createRemotePath();
				}

				// 2. Load remote index
				this.updateState({
					currentOperation: t("status.op.loading_remote_index"),
				});
				await this.indexManager.loadRemoteIndex();
				if (this.indexManager.replayPendingMutations()) {
					if (this.indexSaveCallback) {
						await this.indexSaveCallback();
					}
				}
				await this.resumePendingMoves(result);
				await this.resumePendingPhysicalActions(result);
				if (result.errors.length > 0) return;

				// 3. Build local index
				this.updateState({
					currentOperation: t("status.op.scanning_local_files"),
				});
				const localFiles = await this.indexManager.buildLocalIndex();

				// 4. Get remote files list
				this.updateState({
					currentOperation: t("status.op.getting_remote_files"),
				});
				const remoteFiles = await this.indexManager.getRemoteFiles();
				if (
					this.reconcileCompletedPhysicalActions(
						localFiles,
						remoteFiles,
					) &&
					this.indexSaveCallback
				) {
					await this.indexSaveCallback();
				}

				// 5. Determine operations
				this.updateState({
					currentOperation: t("status.op.analyzing_changes"),
				});
				const localIndex = this.indexManager.getLocalIndex();
				const remoteIndex = this.indexManager.getRemoteIndex();

				const operations = this.conflictResolver.determineOperations(
					localFiles,
					remoteFiles,
					localIndex.files,
					remoteIndex.files,
					startTime,
					remoteIndex.folderTombstones,
					this.indexManager.getPendingLocalDeletePaths(),
				);
				const baselinesChanged = this.recordConfirmedBaselines(
					localFiles,
					remoteFiles,
					operations,
				);

				logger.info(
					`Determined ${operations.length} synchronization operations`,
				);

				// 6. Preflight: Create all necessary folders
				this.updateState({
					currentOperation: t("status.op.creating_folders"),
				});
				await this.ensureFoldersExist(operations);

				// 7. Execute operations in parallel by type
				const totalOps = operations.length;
				let processedOps = 0;

				const uploads = operations.filter(
					(op) => op.action === "upload",
				);
				const downloads = operations.filter(
					(op) => op.action === "download",
				);
				let deletes = operations.filter(
					(op) =>
						op.action === "delete_remote" ||
						op.action === "delete_local",
				);
				const conflicts = operations.filter(
					(op) => op.action === "conflict",
				);
				let indexCommittedBeforeDeletes = false;

				let mtimeStamped = false;
				if (uploads.length > 0) {
					this.updateState({
						currentOperation: t("status.op.uploading_files"),
					});
					const uploadResults = await this.executeOperationsParallel(
						uploads,
						result,
						(completed) => {
							processedOps = completed;
							this.reportProgress(processedOps, totalOps);
						},
					);
					result.uploaded = uploadResults.succeeded;
					result.errors.push(...uploadResults.errors);

					// Batch-fill `remoteMtime` on the remote index entries just
					// created by the upload group. uploads ran with
					// `stampRemoteMtime=false`, so a single re-read of the remote
					// file list replaces N per-file `getResource` calls. Best-effort:
					// on failure the entries stay without `remoteMtime` and the
					// conflict resolver falls back to legacy comparison.
					if (uploadResults.succeeded > 0) {
						try {
							const liveRemote =
								await this.indexManager.getRemoteFiles();
							mtimeStamped =
								this.indexManager.applyServerMtimes(liveRemote);
						} catch (e) {
							logger.warn(
								"Batch server mtime re-read after uploads failed; entries will use legacy comparison:",
								{ error: e },
							);
						}
					}
				}

				if (downloads.length > 0) {
					this.updateState({
						currentOperation: t("status.op.downloading_files"),
					});
					const downloadResults =
						await this.executeOperationsParallel(
							downloads,
							result,
							(completed) => {
								processedOps = uploads.length + completed;
								this.reportProgress(processedOps, totalOps);
							},
						);
					result.downloaded = downloadResults.succeeded;
					result.errors.push(...downloadResults.errors);
				}

				if (deletes.length > 0) {
					this.updateState({
						currentOperation: t("status.op.deleting_files"),
					});
					if (
						!(await this.commitDeletionIntents(deletes, result))
					) {
						return;
					}
					await this.repairMissingAcceptedUploads(
						uploads.map((operation) => operation.path),
					);
					indexCommittedBeforeDeletes = true;
					deletes = this.filterCommittedDeletions(deletes);
					const deleteResults = await this.executeOperationsParallel(
						deletes,
						result,
						(completed) => {
							processedOps =
								uploads.length + downloads.length + completed;
							this.reportProgress(processedOps, totalOps);
						},
					);
					result.deleted = deleteResults.succeeded;
					result.errors.push(...deleteResults.errors);
					if (this.indexSaveCallback) {
						await this.indexSaveCallback();
					}
				}

				// Prune remote folders that became empty after the delete group.
				// Done centrally (once) rather than per-file to avoid the parallel
				// race where each delete sees the others' targets as still-present
				// and skips pruning. Only delete_remote operations affect remote
				// folders; delete_local is irrelevant here.
				const deletedRemotePaths = deletes
					.filter((op) => op.action === "delete_remote")
					.map((op) => op.path);
				if (deletedRemotePaths.length > 0) {
					try {
						await this.pruneRemoteFolders(deletedRemotePaths);
					} catch (e) {
						logger.warn(
							"Failed to prune remote folders after deletes:",
							{ error: e },
						);
					}
				}

				if (conflicts.length > 0) {
					this.updateState({
						currentOperation: t("status.op.resolving_conflicts"),
					});
					for (const op of conflicts) {
						if (this.isPaused) {
							result.success = false;
							result.errors.push({
								path: "",
								operation: "none",
								message: "Synchronization interrupted",
							});
							break;
						}

						processedOps++;
						this.updateState({
							currentOperation: t("status.op.conflict", {
								path: op.path,
							}),
							progress: Math.round(
								(processedOps / totalOps) * 100,
							),
							pendingCount: totalOps - processedOps,
						});

						try {
							await this.handleConflict(op);
							result.conflicts++;
						} catch (e) {
							const error: SyncError = {
								path: op.path,
								operation: op.action,
								message: (e as Error).message,
							};
							result.errors.push(error);
							logger.error(
								`Error resolving conflict for ${op.path}:`,
								{ error: e },
							);
						}
					}
				}

				// 8. Save indexes
				this.updateState({
					currentOperation: t("status.op.saving_indexes"),
				});

				// A long sync may have taken minutes, during which another device could
				// have flipped the remote encryption state (enable/rotate/disable). If
				// so, abort before committing the index so we don't record a sync
				// against a now-stale encryption context. File transfers that already
				// landed are harmless and will be reconciled on the next sync.
				const staleReason = await this.getSyncBlockReason(false);
				if (staleReason) {
					result.errors.push({
						path: "",
						operation: "none",
						message: `Sync aborted before saving: ${staleReason}`,
					});
					return;
				}

				// Tombstones are intentionally retained; Force sync is the only
				// operation that compacts causal deletion history.
				const hadOperations =
					result.uploaded > 0 ||
					result.downloaded > 0 ||
					result.deleted > 0 ||
					result.conflicts > 0;
				const tombstonesRemoved =
					this.indexManager.cleanupDeletedFiles();

				// Skip the remote index write when nothing changed during this
				// sync: no file operations, no batch mtime stamping, and no
				// tombstone changes. This avoids unnecessary API calls, 409
				// "folder exists" noise, and reduces the window for concurrent-
				// index conflicts between devices. The local index is still
				// persisted by the caller via indexSaveCallback.
				const indexDirty =
					hadOperations ||
					mtimeStamped ||
					tombstonesRemoved ||
					baselinesChanged;
				if (!indexDirty) {
					logger.debug(
						"[SyncEngine] No changes detected, skipping remote index save",
					);
					if (this.indexSaveCallback) {
						await this.indexSaveCallback();
					}
					return;
				}
				if (
					indexCommittedBeforeDeletes &&
					conflicts.length === 0
				) {
					return;
				}

				this.indexManager.updateSyncTime();
				if (!(await this.saveRemoteIndexOrAbort(result))) {
					return;
				}
				await this.repairMissingAcceptedUploads(
					uploads.map((operation) => operation.path),
				);
			},
			(result) =>
				`Synchronization completed: uploaded ${result.uploaded}, downloaded ${result.downloaded}, deleted ${result.deleted}, conflicts ${result.conflicts}, errors ${result.errors.length}`,
			);
		if (
			options?.skipMaintenanceGuard &&
			this.coordinator.getActiveKind() === "maintenance"
		) {
			return await run();
		}
		return await this.coordinator.run("full", run);
	}

	/**
	 * Rewrite only the physical representation of every live canonical file
	 * while preserving epoch, logical revisions, tombstones, moves, and
	 * mutation watermarks.
	 */
	async reencodeRemoteFiles(
		options?: SyncRunOptions,
	): Promise<SyncResult> {
		const run = async () =>
			await this.runSyncSession(
				options,
				async (result) => {
					const localFiles = await this.indexManager.buildLocalIndex();
					const canonical = this.indexManager.getRemoteIndex();
					const liveCanonical = Object.entries(canonical.files).filter(
						([, metadata]) => !metadata.deleted,
					);
					for (const [path, metadata] of liveCanonical) {
						const local = localFiles.get(path);
						if (!local || local.sha256 !== metadata.sha256) {
							throw new Error(
								`Encryption preflight baseline is incomplete for ${path}`,
							);
						}
					}

					await this.ensureFoldersExist(
						liveCanonical.map(([path]) => ({
							action: "upload",
							path,
							reason: "Encryption transition",
						})),
					);

					const tasks = liveCanonical.map(
						([path, logicalMetadata]) =>
							async () => {
								const content =
									await this.vaultAdapter.readFile(path);
								const sha256 = await computeSha256(content);
								if (sha256 !== logicalMetadata.sha256) {
									throw new Error(
										`File changed during encryption transition: ${path}`,
									);
								}
								await this.yandexClient.uploadFile(
									joinPath(this.settings.remotePath, path),
									content,
									true,
								);
								const stamp = await this.fetchRemoteStamp(path);
								canonical.files[path] = {
									...logicalMetadata,
									size: content.byteLength,
									sha256,
									remoteMtime: stamp.remoteMtime,
									remoteFingerprint:
										stamp.remoteFingerprint,
								};
								this.indexManager.updateLocalFile(path, {
									...canonical.files[path],
								});
							},
					);
					const settled = await runWithConcurrencySettled(
						tasks,
						Math.max(1, this.settings.maxConcurrency || 5),
					);
					for (let index = 0; index < settled.length; index++) {
						const outcome = settled[index];
						if (outcome?.status === "fulfilled") {
							result.uploaded++;
							continue;
						}
						const path = liveCanonical[index]?.[0] ?? "";
						result.errors.push({
							path,
							operation: "upload",
							message:
								outcome?.reason instanceof Error
									? outcome.reason.message
									: String(outcome?.reason),
						});
					}
					if (result.errors.length > 0) return;
					await options?.beforeIndexCommit?.();
					this.indexManager.updateSyncTime();
					this.indexManager.beginPhysicalRewriteCommit();
					try {
						await this.saveRemoteIndexOrAbort(result, false);
					} finally {
						this.indexManager.cancelPhysicalRewriteCommit();
					}
				},
				(result) =>
					`Encryption rewrite completed: uploaded ${result.uploaded}, errors ${result.errors.length}`,
			);
		if (
			options?.skipMaintenanceGuard &&
			this.coordinator.getActiveKind() === "maintenance"
		) {
			return await run();
		}
		return await this.coordinator.run("maintenance", run);
	}

	/**
	 * Force synchronization from local to remote.
	 * Overwrites ALL remote files with local versions.
	 * Files not present locally are deleted from remote.
	 */
	async forceSyncFromLocal(options?: SyncRunOptions): Promise<SyncResult> {
		let bootstrapStarted = false;
		const run = async () => await this.runSyncSession(
			options,
			async (result) => {
				const inheritedCleanup =
					this.indexManager.getMaintenance();
				this.indexManager.beginForceBootstrap(true);
				if (inheritedCleanup?.phase === "cleanup") {
					this.indexManager.setMaintenance(inheritedCleanup);
				}
				bootstrapStarted = true;
				// 1. Ensure remote folder exists
				this.updateState({
					currentOperation: t("status.op.checking_remote_folder"),
				});
				const remoteExists = await this.indexManager.remotePathExists();
				if (!remoteExists) {
					await this.indexManager.createRemotePath();
				}

				// 2. Build local index
				this.updateState({
					currentOperation: t("status.op.scanning_local_files"),
				});
				const localFiles = await this.indexManager.buildLocalIndex();

				// 3. Get remote files list
				this.updateState({
					currentOperation: t("status.op.getting_remote_files"),
				});
				const remoteFiles = await this.indexManager.getRemoteFiles();
				if (inheritedCleanup) {
					this.indexManager.clearMaintenance(inheritedCleanup.id);
				}

				// 4. Generate operations manually: all local → upload, remote-only → delete_remote
				this.updateState({
					currentOperation: t("status.op.analyzing_changes"),
				});
				const operations: SyncOperation[] = [];

				for (const [path, meta] of localFiles) {
					operations.push({
						action: "upload",
						path,
						reason: "Force sync from local",
						localMeta: meta,
					});
				}

				if (!options?.skipRemoteDeletes) {
					for (const [path, meta] of remoteFiles) {
						if (!localFiles.has(path)) {
							operations.push({
								action: "delete_remote",
								path,
								reason: "Force sync from local: file not present locally",
								remoteMeta: meta,
							});
						}
					}
				}

				logger.info(
					`Force sync from local: ${operations.length} synchronization operations`,
				);

				// 5. Preflight: Create all necessary folders
				this.updateState({
					currentOperation: t("status.op.creating_folders"),
				});
				await this.ensureFoldersExist(operations);

				// 6. Execute operations in parallel by type
				const totalOps = operations.length;
				let processedOps = 0;

				const uploads = operations.filter(
					(op) => op.action === "upload",
				);
				let deletes = operations.filter(
					(op) => op.action === "delete_remote",
				);
				let indexCommittedBeforeDeletes = false;

				if (uploads.length > 0) {
					this.updateState({
						currentOperation: t("status.op.uploading_files"),
					});
					const uploadResults = await this.executeOperationsParallel(
						uploads,
						result,
						(completed) => {
							processedOps = completed;
							this.reportProgress(processedOps, totalOps);
						},
					);
					result.uploaded = uploadResults.succeeded;
					result.errors.push(...uploadResults.errors);

					// Batch-fill `remoteMtime` on the remote index entries just
					// created by the upload group (see fullSync for rationale).
					if (uploadResults.succeeded > 0) {
						try {
							const liveRemote =
								await this.indexManager.getRemoteFiles();
							this.indexManager.applyServerMtimes(liveRemote);
						} catch (e) {
							logger.warn(
								"Batch server mtime re-read after force uploads failed; entries will use legacy comparison:",
								{ error: e },
							);
						}
					}
					if (uploadResults.errors.length > 0) return;
				}

				await options?.beforeIndexCommit?.();

				if (deletes.length > 0) {
					this.updateState({
						currentOperation: t("status.op.deleting_remote_files"),
					});
					for (const operation of deletes) {
						this.indexManager.enqueuePhysicalAction(
							"delete-remote",
							operation.path,
							{
								canonicalRevision:
									this.indexManager.getRemoteIndex().revision + 1,
								expectedFingerprint:
									operation.remoteMeta?.remoteFingerprint,
								origin: "force-reset",
							},
						);
					}
					if (this.indexSaveCallback) await this.indexSaveCallback();
					this.indexManager.updateSyncTime();
					if (!(await this.saveRemoteIndexOrAbort(result, false))) {
						return;
					}
					await this.repairMissingAcceptedUploads(
						uploads.map((operation) => operation.path),
					);
					indexCommittedBeforeDeletes = true;
					deletes = deletes.filter(
						(operation) =>
							!this.indexManager.getRemoteIndex().files[
								operation.path
							],
					);
					const deleteResults = await this.executeOperationsParallel(
						deletes,
						result,
						(completed) => {
							processedOps = uploads.length + completed;
							this.reportProgress(processedOps, totalOps);
						},
					);
					result.deleted = deleteResults.succeeded;
					result.errors.push(...deleteResults.errors);
					if (this.indexSaveCallback) {
						await this.indexSaveCallback();
					}

					// Prune remote folders emptied by the delete group (centralized,
					// once, after all parallel deletes have settled).
					try {
						await this.pruneRemoteFolders(
							deletes.map((op) => op.path),
						);
					} catch (e) {
						logger.warn(
							"Failed to prune remote folders after force deletes:",
							{ error: e },
						);
					}
				}

				// 7. Commit the v3 index. Failed physical deletions deliberately
				// remain tombstoned so the next sync retries them. Failed uploads
				// never updated the desired index and are likewise retried.
				this.updateState({
					currentOperation: t("status.op.saving_indexes"),
				});
				this.indexManager.cleanupDeletedFiles();
				if (indexCommittedBeforeDeletes) return;
				this.indexManager.updateSyncTime();
				if (!(await this.saveRemoteIndexOrAbort(result, false))) {
					return;
				}
				await this.repairMissingAcceptedUploads(
					uploads.map((operation) => operation.path),
				);
			},
			(result) =>
				`Force sync from local completed: uploaded ${result.uploaded}, deleted ${result.deleted}, errors ${result.errors.length}`,
		);
		const result =
			options?.skipMaintenanceGuard &&
			this.coordinator.getActiveKind() === "maintenance"
				? await run()
				: await this.coordinator.run("force", run);
		if (bootstrapStarted && !result.success) {
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
		let bootstrapStarted = false;
		const run = async () => await this.runSyncSession(
			options,
			async (result) => {
				const inheritedCleanup =
					this.indexManager.getMaintenance();
				this.indexManager.beginForceBootstrap(true);
				if (inheritedCleanup?.phase === "cleanup") {
					this.indexManager.setMaintenance(inheritedCleanup);
				}
				bootstrapStarted = true;
				// 1. Ensure remote folder exists
				this.updateState({
					currentOperation: t("status.op.checking_remote_folder"),
				});
				const remoteExists = await this.indexManager.remotePathExists();
				if (!remoteExists) {
					await this.indexManager.createRemotePath();
				}

				// 2. Build local index (to know what to delete)
				this.updateState({
					currentOperation: t("status.op.scanning_local_files"),
				});
				const localFiles = await this.indexManager.buildLocalIndex();

				// 3. Read the authoritative physical remote snapshot. Force
				// remote intentionally does not trust a legacy or ambiguous
				// canonical index.
				this.updateState({
					currentOperation: t("status.op.getting_remote_files"),
				});
				const remoteFiles = await this.indexManager.getRemoteFiles();
				if (inheritedCleanup) {
					this.indexManager.clearMaintenance(inheritedCleanup.id);
				}

				// 4. Generate operations manually: all remote → download,
				// local-only → delete locally.
				this.updateState({
					currentOperation: t("status.op.analyzing_changes"),
				});
				const operations: SyncOperation[] = [];

				for (const [path, meta] of remoteFiles) {
					operations.push({
						action: "download",
						path,
						reason: "Force sync from remote",
						remoteMeta: meta,
					});
				}

				for (const [path, meta] of localFiles) {
					if (!remoteFiles.has(path)) {
						operations.push({
							action: "delete_local",
							path,
							reason: "Force sync from remote: file not present on disk",
							localMeta: meta,
						});
					}
				}

				logger.info(
					`Force sync from remote: ${operations.length} synchronization operations`,
				);

				// 5. Preflight: Create all necessary folders
				this.updateState({
					currentOperation: t("status.op.creating_folders"),
				});
				await this.ensureFoldersExist(operations);

				// 6. Execute operations in parallel by type
				const totalOps = operations.length;
				let processedOps = 0;

				const downloads = operations.filter(
					(op) => op.action === "download",
				);
				const deletes = operations.filter(
					(op) => op.action === "delete_local",
				);

				if (downloads.length > 0) {
					this.updateState({
						currentOperation: t("status.op.downloading_files"),
					});
					const downloadResults =
						await this.executeOperationsParallel(
							downloads,
							result,
							(completed) => {
								processedOps = completed;
								this.reportProgress(processedOps, totalOps);
							},
						);
					result.downloaded = downloadResults.succeeded;
					result.errors.push(...downloadResults.errors);
					if (downloadResults.errors.length > 0) return;
				}

				if (deletes.length > 0) {
					this.updateState({
						currentOperation: t("status.op.deleting_local_files"),
					});
					const deleteResults = await runWithConcurrencySettled(
						deletes.map((operation) => async () => {
							await this.deleteLocalFileForForce(operation.path);
						}),
						Math.max(1, this.settings.maxConcurrency || 5),
						(completed) => {
							processedOps = downloads.length + completed;
							this.reportProgress(processedOps, totalOps);
						},
					);
					for (let index = 0; index < deleteResults.length; index++) {
						const deletion = deleteResults[index];
						const operation = deletes[index];
						if (!deletion || !operation) continue;
						if (deletion.status === "fulfilled") {
							result.deleted++;
							continue;
						}
						result.errors.push({
							path: operation.path,
							operation: "delete_local",
							message:
								deletion.reason instanceof Error
									? deletion.reason.message
									: String(deletion.reason),
						});
					}
					if (this.indexSaveCallback) {
						await this.indexSaveCallback();
					}
					if (result.errors.length > 0) return;
				}

				// 7. Sync indexes: local becomes a copy of remote (only for
				// downloads that actually succeeded). Entries whose download failed
				// are left out of the local index so the next sync retries them and
				// the local state does not falsely claim a file is present.
				this.updateState({
					currentOperation: t("status.op.saving_indexes"),
				});
				this.indexManager.cleanupDeletedFiles();
				const localIndex = this.indexManager.getLocalIndex();
				const remoteIndex = this.indexManager.getRemoteIndex();
				const failedPaths = new Set(
					result.errors.map((e) => e.path).filter(Boolean),
				);
				const newLocalFiles: Record<string, FileMetadata> = {};
				for (const [p, meta] of Object.entries(remoteIndex.files)) {
					if (failedPaths.has(p)) continue;
					newLocalFiles[p] = meta;
				}
				localIndex.files = newLocalFiles;
				this.indexManager.updateSyncTime();
				if (!(await this.saveRemoteIndexOrAbort(result, false))) {
					return;
				}
			},
			(result) =>
				`Force sync from remote completed: downloaded ${result.downloaded}, deleted ${result.deleted}, errors ${result.errors.length}`,
		);
		const result =
			options?.skipMaintenanceGuard &&
			this.coordinator.getActiveKind() === "maintenance"
				? await run()
				: await this.coordinator.run("force", run);
		if (bootstrapStarted && !result.success) {
			this.indexManager.cancelForceBootstrap();
		}
		return result;
	}

	/**
	 * Execute single operation
	 */
	private async executeOperation(
		op: SyncOperation,
		result: SyncResult,
	): Promise<void> {
		switch (op.action) {
			case "upload":
				await this.uploadFile(op.path);
				result.uploaded++;
				break;

			case "download":
				await this.downloadFile(
					op.path,
					op.remoteMeta?.remoteMtime ?? op.remoteMeta?.mtime,
				);
				result.downloaded++;
				break;

			case "delete_remote":
				await this.deleteRemoteFile(op.path);
				result.deleted++;
				break;

			case "delete_local":
				await this.deleteLocalFile(op.path);
				result.deleted++;
				break;

			case "conflict":
				await this.handleConflict(op);
				result.conflicts++;
				break;
		}
	}

	/**
	 * Ensure all necessary folders exist before operations
	 */
	private async ensureFoldersExist(
		operations: SyncOperation[],
	): Promise<void> {
		const folders = new Set<string>();

		for (const op of operations) {
			// Only uploads need their destination folders ensured on remote — the
			// source folder for a download already exists by definition, and
			// creating it here wastes API calls and, under encryption, creates
			// no-op encrypted folder entries. Conflict copies create their own
			// folder at upload time (uploadFile with default skipFolderCheck).
			if (op.action === "upload") {
				const remotePath = joinPath(this.settings.remotePath, op.path);
				const dir = getDirectory(remotePath);
				if (dir) {
					folders.add(dir);
				}
			}
		}

		if (folders.size > 0) {
			logger.info(`Ensuring ${folders.size} folders exist...`);
			const folderPaths: string[] = [];
			folders.forEach((folder: string) => {
				folderPaths.push(folder);
			});
			await this.yandexClient.ensureFoldersExist(folderPaths);
		}
	}

	/**
	 * Execute operations in parallel with concurrency control
	 */
	private async executeOperationsParallel(
		operations: SyncOperation[],
		result: SyncResult,
		onProgress?: (completed: number) => void,
	): Promise<{ succeeded: number; errors: SyncError[] }> {
		const tasks = operations.map((op) => async () => {
			if (this.isPaused) {
				throw new Error("Synchronization interrupted");
			}

			switch (op.action) {
				case "upload":
					// Skip folder check since we pre-created all folders, and
					// skip per-file server mtime fetch — the caller performs a
					// single batch re-read of the remote file list after the
					// upload group via `applyServerMtimes`.
					await this.uploadFile(op.path, true, false);
					break;
				case "download":
					await this.downloadFile(
						op.path,
						op.remoteMeta?.remoteMtime ?? op.remoteMeta?.mtime,
					);
					break;
				case "delete_remote":
					await this.deleteRemoteFile(op.path);
					break;
				case "delete_local":
					await this.deleteLocalFile(op.path);
					if (op.remoteMeta) {
						await this.deleteRemoteFile(op.path);
					}
					break;
			}
		});

		const concurrency: number =
			typeof this.settings.maxConcurrency === "number"
				? this.settings.maxConcurrency
				: 5;
		const results = await runWithConcurrencySettled(
			tasks,
			concurrency,
			onProgress,
		);

		const errors: SyncError[] = [];
		let succeeded = 0;

		for (let i = 0; i < results.length; i++) {
			const res = results[i];
			const op = operations[i];

			if (!res || !op) {
				continue;
			}

			if (res.status === "rejected") {
				const errorMessage =
					res.reason instanceof Error
						? res.reason.message
						: String(res.reason);
				errors.push({
					path: op.path,
					operation: op.action,
					message: errorMessage,
				});
				logger.error(
					`Error executing ${op.action} operation for ${op.path}:`,
					{ error: res.reason },
				);
			} else {
				succeeded++;
			}
		}

		return { succeeded, errors };
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
		logger.debug(`Uploading file: ${path}`);

		const content =
			snapshot?.content ?? (await this.vaultAdapter.readFile(path));
		const remotePath = joinPath(this.settings.remotePath, path);

		await this.yandexClient.uploadFile(
			remotePath,
			content,
			skipFolderCheck,
		);

		// Update indexes
		const sha256 = snapshot?.sha256 ?? (await computeSha256(content));
		const mtime = this.vaultAdapter.getFileMtime(path) || Date.now();
		const size = content.byteLength;
		// Best-effort: if the fetch fails, leave remoteMtime undefined and the
		// resolver falls back to the legacy mixed-clock comparison.
		const remoteStamp = stampRemoteMtime
			? await this.fetchRemoteStamp(path)
			: {};

		const metadata: FileMetadata = {
			path,
			sha256,
			size,
			mtime,
			syncedAt: Date.now(),
		};

		this.indexManager.updateLocalFile(path, metadata);
		const pendingBaseRevision =
			this.indexManager.getPendingPutBaseRevision(path);
		// The remote index entry additionally carries the server mtime so the
		// next sync can detect external remote modifications without involving
		// the local clock.
		this.indexManager.updateRemoteFile(path, {
			...metadata,
			...remoteStamp,
			baseRevision:
				pendingBaseRevision === undefined
					? this.indexManager.getCausalBaseRevision()
					: pendingBaseRevision ??
						this.indexManager.getRemoteIndex().revision,
		});
	}

	/**
	 * Download file from Yandex Disk.
	 * `serverMtime` is the server-side modification time of the remote resource
	 * (typically `remoteMeta.mtime` from the conflict resolver), used to stamp
	 * {@link FileMetadata.remoteMtime} on the remote index entry without an
	 * extra API call. When omitted, the server mtime is fetched best-effort.
	 */
	async downloadFile(path: string, serverMtime?: number): Promise<void> {
		logger.debug(`Downloading file: ${path}`);

		const remotePath = joinPath(this.settings.remotePath, path);
		const content = await this.yandexClient.downloadFile(remotePath);

		// If a local file already exists and its content has diverged from the
		// last synced state (per the local index), it means the local copy
		// carried unsynced changes that this download is about to overwrite.
		// Back it up first so the edit is recoverable. This is especially
		// important for the legacy mixed-clock conflict path and for
		// force-sync-from-remote, which can overwrite non-trivial local edits.
		const localIndexMeta = this.indexManager.getLocalIndex().files[path];
		if (localIndexMeta && this.vaultAdapter.fileExists(path)) {
			try {
				const existing = await this.vaultAdapter.readFile(path);
				const existingSha = await computeSha256(existing);
				if (existingSha !== localIndexMeta.sha256) {
					await this.vaultAdapter.backupOverwrittenFile(
						path,
						existing,
					);
				}
			} catch (e) {
				logger.warn(
					`Could not back up local ${path} before overwrite:`,
					{ error: e },
				);
			}
		}

		this.expectWatcherEvent(path, "upload");
		await this.vaultAdapter.writeFile(path, content);

		// Update indexes
		const sha256 = await computeSha256(content);
		const mtime = this.vaultAdapter.getFileMtime(path) || Date.now();
		const remoteStamp = await this.fetchRemoteStamp(path);
		const remoteMtime = serverMtime ?? remoteStamp.remoteMtime;

		const metadata: FileMetadata = {
			path,
			sha256,
			size: content.byteLength,
			mtime,
			syncedAt: Date.now(),
		};

		this.indexManager.updateLocalFile(path, metadata);
		this.indexManager.updateRemoteFile(path, {
			...metadata,
			remoteMtime,
			remoteFingerprint: remoteStamp.remoteFingerprint,
		});
	}

	/**
	 * Fetch the server-side modification time for a remote file. Returns
	 * undefined when the resource cannot be read (e.g. it was concurrently
	 * deleted) or the modified timestamp is not parseable. Callers treat
	 * undefined as "no remoteMtime known" and fall back to legacy logic.
	 */
	private async fetchRemoteStamp(path: string): Promise<{
		remoteMtime?: number;
		remoteFingerprint?: string;
	}> {
		try {
			const remotePath = joinPath(this.settings.remotePath, path);
			const resource =
				await this.yandexClient.getLogicalResource(remotePath);
			if (!resource) return {};
			const ts = new Date(resource.modified).getTime();
			return {
				remoteMtime: Number.isFinite(ts) ? ts : undefined,
				remoteFingerprint:
					resource.sha256 || resource.md5 || undefined,
			};
		} catch (e) {
			logger.debug(`Failed to fetch remote stamp for ${path}:`, {
				error: e,
			});
			return {};
		}
	}

	/**
	 * Delete file on Yandex Disk
	 */
	async deleteRemoteFile(path: string): Promise<void> {
		const physicalAction =
			this.indexManager.getPendingPhysicalAction("delete-remote", path);
		if (!physicalAction) {
			throw new Error(
				`Refusing to delete ${path} without a pending physical action`,
			);
		}
		const actionContext = {
			actionId: physicalAction.id,
			actionType: physicalAction.type,
			origin: physicalAction.origin,
			epoch: shortenDiagnosticValue(physicalAction.epoch),
			canonicalRevision: physicalAction.canonicalRevision,
			expectedChangedRevision:
				physicalAction.expectedChangedRevision,
			expectedFingerprint: shortenDiagnosticValue(
				physicalAction.expectedFingerprint,
			),
			path,
		};
		logger.info("Remote physical deletion started", actionContext);
		const canonical = await this.indexManager.readCanonicalIndex();
		if (!isPhysicalDeleteAuthorized(physicalAction, canonical)) {
			this.indexManager.completePhysicalAction(physicalAction.id);
			logger.warn("Cancelled obsolete remote deletion", {
				...actionContext,
				currentEpoch: shortenDiagnosticValue(canonical.epoch),
				currentRevision: canonical.revision,
				currentChangedRevision:
					canonical.files[path]?.changedRevision,
				currentDeleted: canonical.files[path]?.deleted ?? null,
			});
			return;
		}

		const remotePath = joinPath(this.settings.remotePath, path);
		const resource =
			await this.yandexClient.getLogicalResource(remotePath);
		if (!resource) {
			this.indexManager.completePhysicalAction(physicalAction.id);
			logger.info("Remote physical deletion already complete", actionContext);
			return;
		}
		const fingerprint =
			resource.sha256 || resource.md5 || resource.resource_id;
		if (
			physicalAction.expectedFingerprint &&
			fingerprint &&
			physicalAction.expectedFingerprint !== fingerprint
		) {
			this.indexManager.completePhysicalAction(physicalAction.id);
			logger.warn("Deferred remote deletion after fingerprint change", {
				...actionContext,
				currentFingerprint: shortenDiagnosticValue(fingerprint),
			});
			return;
		}
		await this.yandexClient.deleteResource(remotePath);
		if (await this.yandexClient.getLogicalResource(remotePath)) {
			throw new Error(`Remote deletion of ${path} was not confirmed`);
		}
		this.indexManager.completePhysicalAction(physicalAction.id);
		logger.info("Remote physical deletion confirmed", actionContext);

		// Update indexes
		if (physicalAction.origin !== "force-reset") {
			this.indexManager.markRemoteFileDeleted(path);
			this.indexManager.markLocalFileDeleted(path);
		}
		// Note: pruning of now-empty remote folders is performed centrally
		// after the whole delete group (see fullSync/forceSyncFromLocal) to
		// avoid the race where parallel deletes each observe the others'
		// targets as still-present and skip pruning, leaving empty folders
		// behind forever.
	}

	/**
	 * Delete remote folders that became empty after file deletions.
	 *
	 * Candidates are derived from the in-memory remote index (which tracks
	 * only files, not folders): a folder is a candidate when no non-deleted
	 * index entry lives under it. Because the index may be stale (written by
	 * an older plugin version, or lagging behind another device's sync), every
	 * candidate is re-verified against Yandex Disk via {@link
	 * YandexDiskClient.isFolderEmpty} before deletion — never delete a folder
	 * the server reports as non-empty, since that would wipe its contents.
	 * Deepest directories are processed first so children are pruned before
	 * their parents; a folder that still contains a (candidate) subfolder is
	 * left untouched this round and retried on the next sync.
	 */
	private async pruneRemoteFolders(localPaths: string[]): Promise<void> {
		const candidates = new Set<string>();
		for (const filePath of localPaths) {
			const segments = filePath.split("/");
			for (let i = 1; i < segments.length; i++) {
				candidates.add(segments.slice(0, i).join("/"));
			}
		}
		if (candidates.size === 0) return;

		const remoteFiles = this.indexManager.getRemoteIndex().files;
		const emptyDirs = Array.from(candidates).filter((dir) => {
			const prefix = dir + "/";
			return !Object.keys(remoteFiles).some(
				(fp) => !remoteFiles[fp]?.deleted && fp.startsWith(prefix),
			);
		});
		if (emptyDirs.length === 0) return;

		emptyDirs.sort((a, b) => b.split("/").length - a.split("/").length);

		for (const dir of emptyDirs) {
			const remoteDir = joinPath(this.settings.remotePath, dir);
			// Re-check against the live remote state. Under a stale index this
			// prevents deleting a folder that actually still contains files.
			let isEmpty: boolean;
			try {
				isEmpty = await this.yandexClient.isFolderEmpty(remoteDir);
			} catch (e) {
				logger.warn(
					`[SyncEngine] Could not verify emptiness of ${dir}, skipping prune:`,
					{ error: e },
				);
				continue;
			}
			if (!isEmpty) continue;

			try {
				await this.yandexClient.deleteResource(remoteDir);
				logger.debug(`[SyncEngine] Pruned empty remote folder: ${dir}`);
			} catch (e) {
				logger.warn(
					`[SyncEngine] Failed to prune empty folder ${dir}:`,
					{ error: e },
				);
			}
		}
	}

	/**
	 * Delete local file
	 */
	async deleteLocalFile(path: string): Promise<void> {
		const physicalAction =
			this.indexManager.getPendingPhysicalAction("delete-local", path);
		if (!physicalAction) {
			throw new Error(
				`Refusing to delete ${path} without a pending physical action`,
			);
		}
		const actionContext = {
			actionId: physicalAction.id,
			actionType: physicalAction.type,
			origin: physicalAction.origin,
			epoch: shortenDiagnosticValue(physicalAction.epoch),
			canonicalRevision: physicalAction.canonicalRevision,
			expectedChangedRevision:
				physicalAction.expectedChangedRevision,
			baselineSha256: shortenDiagnosticValue(
				physicalAction.baselineSha256,
			),
			path,
		};
		logger.info("Local physical deletion started", actionContext);
		const canonical = await this.indexManager.readCanonicalIndex();
		if (!isPhysicalDeleteAuthorized(physicalAction, canonical)) {
			this.indexManager.completePhysicalAction(physicalAction.id);
			logger.warn("Cancelled obsolete local deletion", {
				...actionContext,
				currentEpoch: shortenDiagnosticValue(canonical.epoch),
				currentRevision: canonical.revision,
				currentChangedRevision:
					canonical.files[path]?.changedRevision,
				currentDeleted: canonical.files[path]?.deleted ?? null,
			});
			return;
		}

		const baseline = this.indexManager.getLocalIndex().files[path];
		if (this.vaultAdapter.fileExists(path)) {
			try {
				const content = await this.vaultAdapter.readFile(path);
				const sha256 = await computeSha256(content);
				const baselineSha256 =
					physicalAction.baselineSha256 ?? baseline?.sha256;
				if (shouldBackupLocalDelete(sha256, baselineSha256)) {
					logger.info("Backing up changed local file before deletion", {
						...actionContext,
						currentSha256: shortenDiagnosticValue(sha256),
					});
					const backupPath =
						await this.vaultAdapter.backupOverwrittenFile(
							path,
							content,
						);
					if (!backupPath) {
						throw new Error(
							`Could not create a backup before deleting ${path}`,
						);
					}
				}
			} catch (e) {
				throw new Error(
					`Could not safely delete ${path}: ${(e as Error).message}`,
				);
			}
		}
		this.expectWatcherEvent(path, "delete");
		await this.vaultAdapter.deleteFile(path);
		this.indexManager.completePhysicalAction(physicalAction.id);
		logger.info("Local physical deletion confirmed", actionContext);

		// Update indexes
		this.indexManager.markLocalFileDeleted(path);
		this.indexManager.markRemoteFileDeleted(path);

		// Prune local ancestor folders that became empty after this deletion,
		// so the local tree mirrors the remote tree after a delete sync. Only
		// truly empty folders are trashed (recoverable).
		try {
			await this.vaultAdapter.pruneEmptyLocalAncestors(path);
		} catch (e) {
			logger.warn(`Failed to prune empty local ancestors for ${path}:`, {
				error: e,
			});
		}
	}

	/**
	 * Apply a Force-remote snapshot locally. The mandatory vault backup is the
	 * recovery boundary, so no tombstone is added to the new canonical epoch.
	 */
	private async deleteLocalFileForForce(path: string): Promise<void> {
		if (!this.vaultAdapter.fileExists(path)) {
			this.indexManager.removeFromLocalIndex(path);
			return;
		}
		this.expectWatcherEvent(path, "delete");
		await this.vaultAdapter.deleteFile(path);
		this.indexManager.removeFromLocalIndex(path);
		await this.vaultAdapter.pruneEmptyLocalAncestors(path);
	}

	/**
	 * Handle conflict
	 */
	private async handleConflict(op: SyncOperation): Promise<void> {
		logger.warn(`Handling conflict: ${op.path}`);

		// Strategy: create conflict copy of local file,
		// then download remote version
		if (op.localMeta && op.remoteMeta) {
			// Save local version as conflict copy
			const conflictPath = this.conflictResolver.generateConflictName(
				op.path,
				this.settings.deviceId,
			);

			const localContent = await this.vaultAdapter.readFile(op.path);
			this.expectWatcherEvent(conflictPath, "upload");
			await this.vaultAdapter.writeFile(conflictPath, localContent);

			await this.uploadFile(conflictPath, false, true, {
				content: localContent,
				sha256: await computeSha256(localContent),
			});

			// Download remote version
			await this.downloadFile(
				op.path,
				op.remoteMeta?.remoteMtime ?? op.remoteMeta?.mtime,
			);

			logger.info(`Conflict resolved, copy created: ${conflictPath}`);
		}
	}

	/**
	 * Synchronize single file (for real-time sync)
	 */
	async syncSingleFile(
		path: string,
		action: "upload" | "delete",
	): Promise<void> {
		return await this.enqueueRealtime(() =>
			this.syncSingleFileNow(path, action),
		);
	}

	/**
	 * Apply a debounced realtime file batch with one canonical index commit.
	 *
	 * @returns `true` only when every event is durably reconciled. A `false`
	 * result tells the watcher to retain the batch for a later retry.
	 */
	async syncFileBatch(
		events: Array<{ path: string; action: "upload" | "delete" }>,
	): Promise<boolean> {
		return await this.coordinator.run("realtime", async () => {
			const blockReason = await this.getSyncBlockReason(false);
			if (blockReason || this.isPaused) {
				if (blockReason) this.setBlockedState(blockReason);
				return false;
			}

			const prepared: Array<{
				path: string;
				action: "upload" | "delete";
				mutation: ReturnType<IndexManager["enqueueMutation"]>;
				snapshot?: { content: ArrayBuffer; sha256: string };
			}> = [];
			let preparationFailed = false;
			for (const event of events) {
				if (!this.vaultAdapter.shouldSync(event.path)) continue;
				if (event.action === "upload") {
					try {
						const content = await this.vaultAdapter.readFile(event.path);
						const sha256 = await computeSha256(content);
						prepared.push({
							...event,
							mutation: this.indexManager.enqueueMutation(
								"put",
								event.path,
								{
									sha256,
									baselineSha256:
										this.indexManager.getLocalIndex().files[
											event.path
										]?.sha256,
								},
							),
							snapshot: { content, sha256 },
						});
					} catch (e) {
						logger.warn(
							`Could not prepare realtime upload ${event.path}:`,
							{ error: e },
						);
						preparationFailed = true;
					}
					continue;
				}
				this.indexManager.markLocalFileDeleted(event.path);
				prepared.push({
					...event,
					mutation: this.indexManager.enqueueMutation(
						"delete-file",
						event.path,
					),
				});
			}
			if (prepared.length === 0) return !preparationFailed;
			if (this.indexSaveCallback) await this.indexSaveCallback();

			const accepted: typeof prepared = [];
			let processingFailed = false;
			for (const item of prepared) {
				try {
					if (item.action === "upload") {
						await this.uploadFile(
							item.path,
							false,
							true,
							item.snapshot,
						);
					} else {
						this.indexManager.markRemoteFileDeleted(item.path);
						this.indexManager.enqueuePhysicalAction(
							"delete-remote",
							item.path,
							{
								canonicalRevision:
									this.indexManager.getRemoteIndex().revision + 1,
								expectedFingerprint:
									this.indexManager.getRemoteIndex().files[
										item.path
									]?.remoteFingerprint,
								origin: "exact-delete",
							},
						);
					}
					this.indexManager.stageMutation(item.mutation);
					accepted.push(item);
				} catch (e) {
					logger.error(
						`Realtime batch stopped at ${item.path}:`,
						{ error: e },
					);
					processingFailed = true;
					break;
				}
			}
			if (accepted.length === 0) return false;
			if (this.indexSaveCallback) await this.indexSaveCallback();
			if (!(await this.saveRemoteIndexBestEffort())) return false;
			await this.repairMissingAcceptedUploads(
				accepted
					.filter((item) => item.action === "upload")
					.map((item) => item.path),
			);
			for (const item of accepted) {
				this.indexManager.confirmMutation(item.mutation.id);
			}

			const deletes = accepted.filter(
				(item) => item.action === "delete",
			);
			const deleteResults = await runWithConcurrencySettled(
				deletes.map((item) => async () => {
					await this.deleteRemoteFile(item.path);
				}),
				Math.max(1, this.settings.maxConcurrency || 5),
			);
			if (deletes.length > 0) {
				await this.pruneRemoteFolders(
					deletes.map((item) => item.path),
				);
			}
			if (
				deleteResults.every(
					(outcome) => outcome.status === "fulfilled",
				)
			) {
				this.indexManager.markRemoteObserved();
			}
			if (this.indexSaveCallback) await this.indexSaveCallback();
			return (
				!preparationFailed &&
				!processingFailed &&
				accepted.length === prepared.length &&
				deleteResults.every(
					(outcome) => outcome.status === "fulfilled",
				)
			);
		});
	}

	private async syncSingleFileNow(
		path: string,
		action: "upload" | "delete",
	): Promise<void> {
		logger.info(
			`[SyncEngine] syncSingleFile called for ${path}, action: ${action}`,
		);

		const blockReason = await this.getSyncBlockReason(false);
		if (blockReason) {
			logger.warn(
				`[SyncEngine] Skipping file sync ${path}: ${blockReason}`,
			);
			this.setBlockedState(blockReason);
			return;
		}
		if (!this.vaultAdapter.shouldSync(path)) {
			logger.info(`[SyncEngine] File ${path} should not be synchronized`);
			return;
		}

		let snapshot:
			| { content: ArrayBuffer; sha256: string }
			| undefined;
		if (action === "upload") {
			try {
				const content = await this.vaultAdapter.readFile(path);
				snapshot = {
					content,
					sha256: await computeSha256(content),
				};
			} catch (e) {
				logger.debug(
					`Could not hash pending upload ${path}:`,
					{ error: e },
				);
			}
		}
		const mutation = this.indexManager.enqueueMutation(
			action === "upload" ? "put" : "delete-file",
			path,
			{
				sha256: snapshot?.sha256,
				baselineSha256:
					this.indexManager.getLocalIndex().files[path]?.sha256,
			},
		);
		if (action === "delete") {
			this.indexManager.markLocalFileDeleted(path);
		}
		if (this.indexSaveCallback) await this.indexSaveCallback();

		if (this.isPaused || this.isSyncing) {
			logger.info(
				`[SyncEngine] Skipping file sync ${path}: sync busy (${this.isSyncing}) or paused (${this.isPaused})`,
			);
			// Persist the deletion intent so the next full sync resolves it as
			// delete_remote rather than treating the remote file as new.
			if (action === "delete") {
				// Persist the local index to disk so an Obsidian restart before
				// the next full sync cannot lose the deletion intent.
				if (this.indexSaveCallback) {
					try {
						await this.indexSaveCallback();
					} catch (e) {
						logger.error(
							`Error persisting deletion intent for ${path}:`,
							{ error: e },
						);
					}
				}
			}
			return;
		}

		logger.info(`[SyncEngine] Starting file synchronization ${path}`);

		try {
			if (action === "upload") {
				await this.uploadFile(path, false, true, snapshot);
			} else if (action === "delete") {
				this.indexManager.markRemoteFileDeleted(path);
				this.indexManager.enqueuePhysicalAction(
					"delete-remote",
					path,
					{
						canonicalRevision:
							this.indexManager.getRemoteIndex().revision + 1,
						expectedFingerprint:
							this.indexManager.getRemoteIndex().files[path]
								?.remoteFingerprint,
						origin: "exact-delete",
					},
				);
				if (this.indexSaveCallback) {
					await this.indexSaveCallback();
				}
			}
			this.indexManager.stageMutation(mutation);

			// Save remote index after operation to keep it in sync
			const committed = await this.saveRemoteIndexBestEffort();
			if (!committed) return;
			this.indexManager.confirmMutation(mutation.id);

			if (action === "delete") {
				await this.deleteRemoteFile(path);
				await this.pruneRemoteFolders([path]);
			}
			this.indexManager.markRemoteObserved();
			logger.debug(`Remote index saved after ${action} for ${path}`);

			// Save local index via callback
			if (this.indexSaveCallback) {
				await this.indexSaveCallback();
				logger.debug(`Local index saved after ${action} for ${path}`);
			}
		} catch (e) {
			logger.error(`Error synchronizing file ${path}:`, { error: e });
		}
	}

	/**
	 * Rename file on Yandex Disk
	 */
	async renameFile(oldPath: string, newPath: string): Promise<void> {
		return await this.enqueueRealtime(() =>
			this.renameFileNow(oldPath, newPath),
		);
	}

	private async renameFileNow(
		oldPath: string,
		newPath: string,
	): Promise<void> {
		const blockReason = await this.getSyncBlockReason(false);
		if (blockReason) {
			logger.warn(
				`[SyncEngine] Skipping rename ${oldPath}: ${blockReason}`,
			);
			this.setBlockedState(blockReason);
			throw new Error(blockReason);
		}

		const mutation = this.indexManager.enqueueMutation("move", oldPath, {
			targetPath: newPath,
			resourceKind: "file",
		});
		this.indexManager.recordMove(
			mutation.id,
			oldPath,
			newPath,
			"file",
			mutation.baseRevision ?? this.indexManager.getRemoteIndex().revision,
		);
		const physicalMove = this.indexManager.enqueuePhysicalAction(
			"move-remote",
			oldPath,
			{
				targetPath: newPath,
				canonicalRevision:
					this.indexManager.getRemoteIndex().revision + 1,
				expectedFingerprint:
					this.indexManager.getRemoteIndex().files[oldPath]
						?.remoteFingerprint,
				origin: "move",
			},
		);
		if (this.indexSaveCallback) await this.indexSaveCallback();

		if (this.isPaused || this.isSyncing) {
			return;
		}

		if (!this.vaultAdapter.shouldSync(newPath)) {
			// If new path is not synchronized, delete old one
			if (this.vaultAdapter.shouldSync(oldPath)) {
				this.indexManager.markRemoteFileDeleted(oldPath);
				this.indexManager.enqueuePhysicalAction(
					"delete-remote",
					oldPath,
					{
						expectedFingerprint:
							this.indexManager.getRemoteIndex().files[oldPath]
								?.remoteFingerprint,
						origin: "exact-delete",
					},
				);
				this.indexManager.completePhysicalAction(physicalMove.id);
				this.indexManager.completeMove(mutation.id);
				this.indexManager.stageMutation(mutation);
				if (!(await this.saveRemoteIndexBestEffort())) return;
				await this.deleteRemoteFile(oldPath);
				this.indexManager.confirmMutation(mutation.id);
				if (this.indexSaveCallback) {
					await this.indexSaveCallback();
				}
			} else {
				this.indexManager.completePhysicalAction(physicalMove.id);
				this.indexManager.completeMove(mutation.id);
				this.indexManager.discardMutation(mutation.id);
			}
			return;
		}

		try {
			const oldLocalMeta =
				this.indexManager.getLocalIndex().files[oldPath];
			const oldRemoteMeta =
				this.indexManager.getRemoteIndex().files[oldPath];

			if (oldLocalMeta) {
				this.indexManager.markLocalFileDeleted(oldPath);
			}

			if (oldRemoteMeta) {
				this.indexManager.markRemoteFileDeleted(oldPath);
			}

			// Read new file metadata for the renamed file
			const content = await this.vaultAdapter.readFile(newPath);
			const sha256 = await computeSha256(content);
			const mtime = this.vaultAdapter.getFileMtime(newPath) || Date.now();

			const newMetadata: FileMetadata = {
				path: newPath,
				sha256,
				size: content.byteLength,
				mtime,
				syncedAt: Date.now(),
			};

			// Add new file to indexes
			this.indexManager.updateLocalFile(newPath, newMetadata);
			this.indexManager.updateRemoteFile(newPath, newMetadata);
			if (mutation.baseRevision !== null) {
				this.indexManager.getRemoteIndex().files[
					newPath
				]!.baseRevision = mutation.baseRevision;
			}

			if (!(await this.saveRemoteIndexBestEffort())) return;
			if (
				this.indexManager.getRemoteIndex().files[newPath]
					?.sha256 !== newMetadata.sha256
			) {
				this.indexManager.completePhysicalAction(physicalMove.id);
				this.indexManager.completeMove(mutation.id);
				this.indexManager.stageMutation(mutation);
				if (await this.saveRemoteIndexBestEffort()) {
					this.indexManager.confirmMutation(mutation.id);
				}
				if (this.indexSaveCallback) {
					await this.indexSaveCallback();
				}
				return;
			}
			if (
				this.indexManager.getRemoteIndex().files[newPath]?.deleted
			) {
				await this.vaultAdapter.backupOverwrittenFile(
					newPath,
					content,
				);
				this.expectWatcherEvent(newPath, "delete");
				await this.vaultAdapter.deleteFile(newPath);
				this.indexManager.markLocalFileDeleted(newPath);
				this.indexManager.completePhysicalAction(physicalMove.id);
				this.indexManager.completeMove(mutation.id);
				this.indexManager.stageMutation(mutation);
				if (await this.saveRemoteIndexBestEffort()) {
					this.indexManager.confirmMutation(mutation.id);
				}
				if (this.indexSaveCallback) {
					await this.indexSaveCallback();
				}
				return;
			}

			await this.executeGuardedRemoteMove(
				oldPath,
				newPath,
				physicalMove.id,
			);

			// Remove source folders that became empty after the move
			await this.pruneRemoteFolders([oldPath]);

			// Save remote index after rename
			this.indexManager.completeMove(mutation.id);
			this.indexManager.stageMutation(mutation);
			if (await this.saveRemoteIndexBestEffort()) {
				this.indexManager.confirmMutation(mutation.id);
			}
			logger.debug(`File renamed: ${oldPath} -> ${newPath}`);

			// Save local index via callback
			if (this.indexSaveCallback) {
				await this.indexSaveCallback();
			}
		} catch (e) {
			logger.error(`Error renaming file ${oldPath}:`, { error: e });
			if (this.indexSaveCallback) {
				await this.indexSaveCallback();
			}
		}
	}

	/**
	 * Synchronize deletion of a folder as one logical prefix mutation.
	 */
	async deleteFolder(path: string): Promise<void> {
		return await this.enqueueRealtime(async () => {
			const mutation = this.indexManager.enqueueMutation(
				"delete-folder",
				path,
			);
			if (this.indexSaveCallback) await this.indexSaveCallback();
			const folderPath = path.replace(/\/+$/, "");
			const prefix = `${folderPath}/`;
			const affected = Object.keys(
				this.indexManager.getRemoteIndex().files,
			).filter((filePath) => filePath.startsWith(prefix));
			if (affected.length === 0) {
				this.indexManager.discardMutation(mutation.id);
				if (this.indexSaveCallback) {
					await this.indexSaveCallback();
				}
				return;
			}

			this.indexManager.markFolderDeleted(
				folderPath,
				mutation.createdAt,
				mutation.baseRevision,
			);
			for (const filePath of affected) {
				this.indexManager.markRemoteFileDeleted(
					filePath,
					folderPath,
					mutation.baseRevision ?? 0,
				);
				this.indexManager.markLocalFileDeleted(
					filePath,
					folderPath,
				);
				this.indexManager.enqueuePhysicalAction(
					"delete-remote",
					filePath,
					{
						canonicalRevision:
							this.indexManager.getRemoteIndex().revision + 1,
						expectedFingerprint:
							this.indexManager.getRemoteIndex().files[filePath]
								?.remoteFingerprint,
						origin: "folder-delete",
					},
				);
			}
			this.indexManager.stageMutation(mutation);
			if (this.indexSaveCallback) await this.indexSaveCallback();

			if (!(await this.saveRemoteIndexBestEffort())) return;
			this.indexManager.confirmMutation(mutation.id);
			if (this.indexSaveCallback) await this.indexSaveCallback();

			const committedPaths = affected.filter((filePath) => {
				const meta =
					this.indexManager.getRemoteIndex().files[filePath];
				return (
					meta?.deleted === true &&
					meta.deletedByFolder === folderPath
				);
			});
			await runWithConcurrencySettled(
				committedPaths.map((filePath) => async () => {
					await this.deleteRemoteFile(filePath);
				}),
				Math.max(1, this.settings.maxConcurrency || 5),
			);
			await this.pruneRemoteFolders(committedPaths);
			if (this.indexSaveCallback) await this.indexSaveCallback();
		});
	}

	/**
	 * Synchronize a folder rename while preserving a logical move marker.
	 */
	async renameFolder(oldPath: string, newPath: string): Promise<void> {
		return await this.enqueueRealtime(async () => {
			const mutation = this.indexManager.enqueueMutation(
				"move",
				oldPath,
				{
					targetPath: newPath,
					resourceKind: "folder",
				},
			);
			if (this.indexSaveCallback) await this.indexSaveCallback();
			const id = mutation.id;
			const oldPrefix = `${oldPath.replace(/\/+$/, "")}/`;
			const newPrefix = `${newPath.replace(/\/+$/, "")}/`;
			const remoteIndex = this.indexManager.getRemoteIndex();
			const localIndex = this.indexManager.getLocalIndex();
			const hasIndexedDescendants =
				Object.entries(remoteIndex.files).some(
					([filePath, meta]) =>
						filePath.startsWith(oldPrefix) && !meta.deleted,
				) ||
				Object.entries(localIndex.files).some(
					([filePath, meta]) =>
						filePath.startsWith(oldPrefix) && !meta.deleted,
				);
			if (!hasIndexedDescendants) {
				this.indexManager.discardMutation(mutation.id);
				if (this.indexSaveCallback) {
					await this.indexSaveCallback();
				}
				return;
			}

			this.indexManager.recordMove(
				id,
				oldPath,
				newPath,
				"folder",
				mutation.baseRevision ??
					this.indexManager.getRemoteIndex().revision,
			);
			const physicalMove = this.indexManager.enqueuePhysicalAction(
				"move-remote",
				oldPath,
				{
					targetPath: newPath,
					canonicalRevision:
						this.indexManager.getRemoteIndex().revision + 1,
					origin: "move",
				},
			);
			this.indexManager.markFolderDeleted(
				oldPath,
				mutation.createdAt,
				mutation.baseRevision,
			);

			const targetHashes = new Map<string, string>();
			for (const [filePath, meta] of Object.entries({
				...remoteIndex.files,
			})) {
				if (!filePath.startsWith(oldPrefix) || meta.deleted) continue;
				const target = `${newPrefix}${filePath.slice(oldPrefix.length)}`;
				this.indexManager.markRemoteFileDeleted(
					filePath,
					oldPath,
					mutation.baseRevision ?? 0,
				);
				this.indexManager.updateRemoteFile(target, {
					...meta,
					path: target,
					deleted: false,
					deletedAt: undefined,
				});
				targetHashes.set(target, meta.sha256);
			}
			for (const [filePath, meta] of Object.entries({
				...localIndex.files,
			})) {
				if (!filePath.startsWith(oldPrefix) || meta.deleted) continue;
				this.indexManager.markLocalFileDeleted(filePath, oldPath);
				this.indexManager.updateLocalFile(
					`${newPrefix}${filePath.slice(oldPrefix.length)}`,
					{
						...meta,
						path: `${newPrefix}${filePath.slice(oldPrefix.length)}`,
						deleted: false,
						deletedAt: undefined,
					},
				);
			}

			if (!(await this.saveRemoteIndexBestEffort())) return;
			const hasConcurrentSurvivor = Object.entries(
				this.indexManager.getRemoteIndex().files,
			).some(
				([filePath, meta]) =>
					filePath.startsWith(oldPrefix) && !meta.deleted,
			);
			const hasRejectedTarget = Object.entries(
				this.indexManager.getRemoteIndex().files,
			).some(
				([filePath, meta]) =>
					filePath.startsWith(newPrefix) &&
					(meta.deleted ||
						(targetHashes.has(filePath) &&
							targetHashes.get(filePath) !==
								meta.sha256)),
			);
			if (hasConcurrentSurvivor || hasRejectedTarget) {
				this.indexManager.completePhysicalAction(physicalMove.id);
				this.indexManager.completeMove(id);
				this.indexManager.stageMutation(mutation);
				if (await this.saveRemoteIndexBestEffort()) {
					this.indexManager.confirmMutation(mutation.id);
				}
				if (this.indexSaveCallback) {
					await this.indexSaveCallback();
				}
				return;
			}
			await this.executeGuardedRemoteMove(
				oldPath,
				newPath,
				physicalMove.id,
			);
			this.indexManager.completeMove(id);
			this.indexManager.stageMutation(mutation);
			if (await this.saveRemoteIndexBestEffort()) {
				this.indexManager.confirmMutation(mutation.id);
			}
			if (this.indexSaveCallback) await this.indexSaveCallback();
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

	private async enqueueRealtime(task: () => Promise<void>): Promise<void> {
		return await this.coordinator.run("realtime", task);
	}

	/**
	 * Notify listeners that sync has started.
	 */
	private notifySyncPauseCallbacks(): void {
		for (const callback of this.syncPauseCallbacks) {
			try {
				callback();
			} catch (e) {
				logger.error("Error in sync pause callback:", { error: e });
			}
		}
	}

	/**
	 * Notify listeners that sync has ended.
	 */
	private notifySyncResumeCallbacks(): void {
		for (const callback of this.syncResumeCallbacks) {
			try {
				callback();
			} catch (e) {
				logger.error("Error in sync resume callback:", { error: e });
			}
		}
	}

	/**
	 * Update progress state during operation execution.
	 */
	private reportProgress(processedOps: number, totalOps: number): void {
		const progress = Math.round((processedOps / totalOps) * 100);
		this.updateState({
			progress,
			pendingCount: totalOps - processedOps,
		});
	}

	/**
	 * Run a sync session with common guard, lifecycle, and error handling.
	 */
	private async runSyncSession(
		options: SyncRunOptions | undefined,
		body: (result: SyncResult, startTime: number) => Promise<void>,
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
		if (this.isPaused) {
			logger.warn("Synchronization is paused");
			return this.createErrorResult("Synchronization is paused");
		}

		const blockReason = await this.getSyncBlockReason(
			options?.skipEncryptionGuard,
		);
		if (blockReason) {
			return this.createBlockedResult(blockReason);
		}

		this.isSyncing = true;
		this.notifySyncPauseCallbacks();

		const startTime = Date.now();
		const result = this.createEmptyResult(startTime);
		logger.info("Sync reconciliation started", this.getDiagnosticSnapshot());

		try {
			this.updateState({
				status: "syncing",
				currentOperation: t("status.op.preparing"),
				progress: 0,
			});

			await body(result, startTime);

			result.success = result.errors.length === 0;
			if (result.success) {
				this.indexManager.markRemoteObserved();
				if (this.indexSaveCallback) {
					await this.indexSaveCallback();
				}
			}
			result.endTime = Date.now();

			this.updateState({
				status: result.success ? "idle" : "error",
				lastSyncTime: result.endTime,
				errorMessage: result.success
					? undefined
					: `Errors: ${result.errors.length}`,
				currentOperation: undefined,
				progress: undefined,
				pendingCount: 0,
			});

			logger.info(logMessage(result), {
				...this.getDiagnosticSnapshot(),
				durationMs: result.endTime - startTime,
				result: {
					uploaded: result.uploaded,
					downloaded: result.downloaded,
					deleted: result.deleted,
					conflicts: result.conflicts,
					errors: result.errors.length,
				},
			});

			return result;
		} catch (e) {
			const error = e as Error;
			result.success = false;
			result.errors.push({
				path: "",
				operation: "none",
				message: error.message,
			});
			result.endTime = Date.now();

			this.updateState({
				status: "error",
				errorMessage: error.message,
				currentOperation: undefined,
				progress: undefined,
			});

			logger.error("Critical synchronization error:", {
				...this.getDiagnosticSnapshot(),
				durationMs: result.endTime - startTime,
				error: e,
			});
			return result;
		} finally {
			this.isSyncing = false;
			this.notifySyncResumeCallbacks();
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
			pendingMutations:
				this.indexManager.getPendingMutations().length,
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

	/**
	 * Save the remote index with optimistic concurrency control. If another
	 * device wrote a newer index during this sync, do NOT overwrite it: our
	 * physical file transfers already landed and will be reconciled on the next
	 * sync once we reload the newer index. Returns false (and records an error
	 * on `result`) when the save was skipped due to a concurrent modification.
	 */
	private async saveRemoteIndexOrAbort(
		result: SyncResult,
		includePendingMutations = true,
	): Promise<boolean> {
		try {
			if (includePendingMutations) {
				this.indexManager.stagePendingMutations();
			}
			await this.indexManager.saveRemoteIndex();
			await this.cleanupRejectedUploads();
			if (includePendingMutations) {
				this.indexManager.confirmAppliedMutations();
			}
			if (this.indexSaveCallback) {
				await this.indexSaveCallback();
			}
			return true;
		} catch (e) {
			if (!(e instanceof RemoteIndexConcurrentModificationError)) {
				throw e;
			}
			logger.warn(
				"Remote index was modified by another device during sync; skipping index overwrite.",
			);
			result.errors.push({
				path: "",
				operation: "none",
				message:
					"Concurrent sync detected from another device. Index not overwritten; please run sync again to reconcile.",
			});
			result.success = false;
			return false;
		}
	}

	/**
	 * Save the remote index from a single-file (real-time) flow. Unlike the
	 * bulk sync path, a concurrent modification here is not surfaced as an
	 * error: the file transfer already succeeded, and the next full sync will
	 * reload the newer remote index and reconcile. We only log a warning so
	 * real-time editing stays non-disruptive.
	 */
	private async saveRemoteIndexBestEffort(): Promise<boolean> {
		try {
			await this.indexManager.saveRemoteIndex();
			await this.cleanupRejectedUploads();
			return true;
		} catch (e) {
			if (e instanceof RemoteIndexConcurrentModificationError) {
				logger.warn(
					"Remote index modified concurrently during single-file sync; skipping remote index save. It will be reconciled on the next full sync.",
				);
				return false;
			}
			throw e;
		}
	}

	/**
	 * Repair only a missing physical object after its put won the canonical
	 * merge. A changed existing object is left for causal reconciliation.
	 */
	private async repairMissingAcceptedUploads(
		paths: string[],
	): Promise<void> {
		if (paths.length === 0) return;
		const canonical = await this.indexManager.readCanonicalIndex();
		const liveRemote = await this.indexManager.getRemoteFiles();
		let repaired = false;
		for (const path of new Set(paths)) {
			const accepted = canonical.files[path];
			if (!accepted || accepted.deleted) {
				continue;
			}
			if (!this.vaultAdapter.fileExists(path)) continue;
			const content = await this.vaultAdapter.readFile(path);
			const sha256 = await computeSha256(content);
			if (sha256 !== accepted.sha256) continue;
			const physical = liveRemote.get(path);
			const physicalMatches =
				physical !== undefined &&
				(accepted.remoteFingerprint !== undefined &&
				physical.remoteFingerprint !== undefined
					? accepted.remoteFingerprint ===
						physical.remoteFingerprint
					: typeof accepted.remoteMtime === "number" &&
						  typeof physical.remoteMtime === "number"
						? accepted.remoteMtime === physical.remoteMtime
						: accepted.sha256 === physical.sha256);
			if (
				physical &&
				physicalMatches
			) {
				continue;
			}
			if (physical) {
				const remoteContent =
					await this.yandexClient.downloadFile(
						joinPath(this.settings.remotePath, path),
					);
				const remoteSha256 = await computeSha256(remoteContent);
				if (remoteSha256 !== accepted.sha256) {
					const conflictPath =
						this.conflictResolver.generateConflictName(
							path,
							this.settings.deviceId,
						);
					this.expectWatcherEvent(conflictPath, "upload");
					await this.vaultAdapter.writeFile(
						conflictPath,
						remoteContent,
					);
					await this.uploadFile(conflictPath, false, true, {
						content: remoteContent,
						sha256: remoteSha256,
					});
				} else {
					this.indexManager.getRemoteIndex().files[path] = {
						...accepted,
						remoteMtime: physical.remoteMtime,
						remoteFingerprint:
							physical.remoteFingerprint,
					};
					repaired = true;
					continue;
				}
			}
			this.indexManager.getRemoteIndex().files[path] = {
				...accepted,
			};
			await this.uploadFile(path, false, true, { content, sha256 });
			repaired = true;
		}
		if (repaired && !(await this.saveRemoteIndexBestEffort())) {
			throw new Error(
				"Repaired uploads could not be confirmed in canonical index",
			);
		}
	}

	/**
	 * Execute a committed move without overwriting a concurrent target and
	 * verify the final physical state before acknowledging local work.
	 */
	private async executeGuardedRemoteMove(
		fromPath: string,
		toPath: string,
		actionId?: string,
	): Promise<void> {
		const action =
			this.indexManager.getPendingPhysicalAction(
				"move-remote",
				fromPath,
			);
		const actionContext = {
			actionId: action?.id ?? actionId ?? null,
			actionType: "move-remote",
			origin: action?.origin ?? "move",
			epoch: shortenDiagnosticValue(action?.epoch),
			canonicalRevision: action?.canonicalRevision ?? null,
			expectedFingerprint: shortenDiagnosticValue(
				action?.expectedFingerprint,
			),
			fromPath,
			toPath,
		};
		logger.info("Guarded remote move started", actionContext);
		const canonical = await this.indexManager.readCanonicalIndex();
		const move = Object.values(canonical.moves).find(
			(candidate) =>
				candidate.pending &&
				candidate.fromPath === fromPath &&
				candidate.toPath === toPath,
		);
		if (!move || canonical.files[toPath]?.deleted) {
			if (action) this.indexManager.completePhysicalAction(action.id);
			logger.warn("Cancelled obsolete guarded remote move", {
				...actionContext,
				currentRevision: canonical.revision,
				movePending: move?.pending ?? false,
				targetDeleted: canonical.files[toPath]?.deleted ?? null,
			});
			return;
		}

		const remoteFrom = joinPath(this.settings.remotePath, fromPath);
		const remoteTo = joinPath(this.settings.remotePath, toPath);
		const [source, target] = await Promise.all([
			this.yandexClient.getLogicalResource(remoteFrom),
			this.yandexClient.getLogicalResource(remoteTo),
		]);
		if (!source && target) {
			if (action) this.indexManager.completePhysicalAction(action.id);
			logger.info("Guarded remote move already complete", actionContext);
			return;
		}
		if (!source) {
			throw new Error(`Move source is missing: ${fromPath}`);
		}
		if (target) {
			throw new Error(`Move target already exists: ${toPath}`);
		}
		const sourceFingerprint =
			source.sha256 || source.md5 || source.resource_id;
		if (
			action?.expectedFingerprint &&
			sourceFingerprint &&
			action.expectedFingerprint !== sourceFingerprint
		) {
			logger.warn("Guarded remote move source fingerprint changed", {
				...actionContext,
				currentFingerprint: shortenDiagnosticValue(
					sourceFingerprint,
				),
			});
			throw new Error(
				`Move source changed after commit: ${fromPath}`,
			);
		}

		await this.yandexClient.moveResource(remoteFrom, remoteTo, false);
		const [remainingSource, writtenTarget] = await Promise.all([
			this.yandexClient.getLogicalResource(remoteFrom),
			this.yandexClient.getLogicalResource(remoteTo),
		]);
		if (remainingSource || !writtenTarget) {
			throw new Error(
				`Move result could not be confirmed: ${fromPath} -> ${toPath}`,
			);
		}
		if (action) this.indexManager.completePhysicalAction(action.id);
		if (actionId && action?.id !== actionId) {
			this.indexManager.completePhysicalAction(actionId);
		}
		logger.info("Guarded remote move confirmed", {
			...actionContext,
			targetFingerprint: shortenDiagnosticValue(
				writtenTarget.sha256 ||
					writtenTarget.md5 ||
					writtenTarget.resource_id,
			),
		});
	}

	/**
	 * Finish logical moves left pending by an interrupted device.
	 */
	private async resumePendingMoves(result: SyncResult): Promise<void> {
		const pendingMoves = Object.values(
			this.indexManager.getRemoteIndex().moves,
		).filter((move) => move.pending);
		if (pendingMoves.length === 0) return;

		let changed = false;
		for (const move of pendingMoves) {
			try {
				if (
					this.indexManager.getRemoteIndex().files[move.toPath]
						?.deleted
				) {
					this.indexManager.completeMove(move.id);
					changed = true;
					continue;
				}
				if (move.kind === "file") {
					const target =
						this.indexManager.getRemoteIndex().files[
							move.toPath
						];
					if (
						target &&
						!target.deleted &&
						target.lastModifiedBy !== move.lastModifiedBy
					) {
						this.indexManager.completeMove(move.id);
						const action =
							this.indexManager.getPendingPhysicalAction(
								"move-remote",
								move.fromPath,
							);
						if (action) {
							this.indexManager.completePhysicalAction(
								action.id,
							);
						}
						changed = true;
						continue;
					}
				}
				if (move.kind === "folder") {
					const prefix = `${move.fromPath.replace(/\/+$/, "")}/`;
					const targetPrefix = `${move.toPath.replace(/\/+$/, "")}/`;
					const hasConcurrentSurvivor = Object.entries(
						this.indexManager.getRemoteIndex().files,
					).some(
						([path, meta]) =>
							path.startsWith(prefix) && !meta.deleted,
					);
					const hasRejectedTarget = Object.entries(
						this.indexManager.getRemoteIndex().files,
					).some(
						([path, meta]) =>
							path.startsWith(targetPrefix) &&
							(meta.deleted ||
								(!meta.deleted &&
									meta.lastModifiedBy !==
										move.lastModifiedBy)),
					);
					if (hasConcurrentSurvivor || hasRejectedTarget) {
						this.indexManager.completeMove(move.id);
						changed = true;
						continue;
					}
				}
				this.indexManager.enqueuePhysicalAction(
					"move-remote",
					move.fromPath,
					{
						targetPath: move.toPath,
						canonicalRevision:
							this.indexManager.getRemoteIndex().revision,
						expectedFingerprint:
							this.indexManager.getRemoteIndex().files[
								move.fromPath
							]?.remoteFingerprint,
						origin: "move",
					},
				);
				await this.executeGuardedRemoteMove(
					move.fromPath,
					move.toPath,
				);
				this.indexManager.completeMove(move.id);
				changed = true;
			} catch (e) {
				logger.warn(
					`Could not resume pending move ${move.fromPath} -> ${move.toPath}:`,
					{ error: e },
				);
			}
		}
		if (changed) {
			await this.saveRemoteIndexOrAbort(result, false);
		}
	}

	/**
	 * Finish canonical-authorized destructive work before scanning physical
	 * files, so an interrupted delete cannot be mistaken for a new file.
	 */
	private async resumePendingPhysicalActions(
		result: SyncResult,
	): Promise<void> {
		const actions = this.indexManager
			.getPendingPhysicalActions()
			.filter(
				(action) =>
					action.type === "delete-local" ||
					action.type === "delete-remote",
			);
		for (const action of actions) {
			try {
				if (action.type === "delete-local") {
					await this.deleteLocalFile(action.path);
				} else {
					await this.deleteRemoteFile(action.path);
				}
			} catch (error) {
				result.errors.push({
					path: action.path,
					operation:
						action.type === "delete-local"
							? "delete_local"
							: "delete_remote",
					message:
						error instanceof Error
							? error.message
							: String(error),
				});
			}
		}
		if (actions.length > 0 && this.indexSaveCallback) {
			await this.indexSaveCallback();
		}
	}

	/**
	 * Persist a local baseline for every path whose two live copies were
	 * confirmed equal and canonicalize an untracked physical match.
	 */
	private recordConfirmedBaselines(
		localFiles: Map<string, FileMetadata>,
		remoteFiles: Map<string, FileMetadata>,
		operations: SyncOperation[],
	): boolean {
		const operatedPaths = new Set(operations.map((operation) => operation.path));
		const remoteIndex = this.indexManager.getRemoteIndex();
		let canonicalChanged = false;

		for (const [path, localMeta] of localFiles) {
			if (operatedPaths.has(path)) continue;
			const remoteMeta = remoteFiles.get(path);
			if (!remoteMeta) continue;
			const canonical = remoteIndex.files[path];
			const baseline = createConfirmedBaseline(
				localMeta,
				remoteMeta,
				canonical,
			);
			this.indexManager.updateLocalFile(path, baseline);
			if (!canonical || canonical.deleted) {
				this.indexManager.updateRemoteFile(path, baseline);
				canonicalChanged = true;
			}
		}
		return canonicalChanged;
	}

	private reconcileCompletedPhysicalActions(
		localFiles: Map<string, FileMetadata>,
		remoteFiles: Map<string, FileMetadata>,
	): boolean {
		let changed = false;
		for (const action of this.indexManager.getPendingPhysicalActions()) {
			const completed =
				(action.type === "delete-local" &&
					!localFiles.has(action.path)) ||
				(action.type === "delete-remote" &&
					!remoteFiles.has(action.path)) ||
				(action.type === "move-remote" &&
					action.targetPath !== undefined &&
					!remoteFiles.has(action.path) &&
					remoteFiles.has(action.targetPath));
			if (!completed) continue;
			this.indexManager.completePhysicalAction(action.id);
			changed = true;
		}
		return changed;
	}

	/**
	 * Commit deletion intent before removing any physical resource.
	 */
	private async commitDeletionIntents(
		operations: SyncOperation[],
		result: SyncResult,
	): Promise<boolean> {
		for (const operation of operations) {
			this.indexManager.markRemoteFileDeleted(
				operation.path,
				operation.folderTombstonePath,
				operation.folderTombstonePath
					? undefined
					: this.indexManager.getCausalBaseRevision(),
			);
			this.indexManager.markLocalFileDeleted(
				operation.path,
				operation.folderTombstonePath,
			);
			this.indexManager.enqueuePhysicalAction(
				operation.action === "delete_local"
					? "delete-local"
					: "delete-remote",
				operation.path,
				{
					canonicalRevision:
						this.indexManager.getRemoteIndex().revision + 1,
					expectedFingerprint:
						operation.remoteMeta?.remoteFingerprint,
					origin: operation.folderTombstonePath
						? "folder-delete"
						: "exact-delete",
				},
			);
			if (operation.action === "delete_local" && operation.remoteMeta) {
				this.indexManager.enqueuePhysicalAction(
					"delete-remote",
					operation.path,
					{
						canonicalRevision:
							this.indexManager.getRemoteIndex().revision + 1,
						expectedFingerprint:
							operation.remoteMeta.remoteFingerprint,
						origin: operation.folderTombstonePath
							? "folder-delete"
							: "exact-delete",
					},
				);
			}
		}
		if (this.indexSaveCallback) {
			await this.indexSaveCallback();
		}
		this.indexManager.updateSyncTime();
		return await this.saveRemoteIndexOrAbort(result);
	}

	private filterCommittedDeletions(
		operations: SyncOperation[],
	): SyncOperation[] {
		const canonicalFiles = this.indexManager.getRemoteIndex().files;
		return operations.filter((operation) => {
			const canonical = canonicalFiles[operation.path];
			if (!canonical?.deleted) return false;
			const actionType =
				operation.action === "delete_local"
					? "delete-local"
					: "delete-remote";
			this.indexManager.enqueuePhysicalAction(actionType, operation.path, {
				canonicalRevision:
					this.indexManager.getRemoteIndex().revision,
				expectedChangedRevision: canonical.changedRevision,
			});
			if (operation.action === "delete_local" && operation.remoteMeta) {
				this.indexManager.enqueuePhysicalAction(
					"delete-remote",
					operation.path,
					{
						canonicalRevision:
							this.indexManager.getRemoteIndex().revision,
						expectedChangedRevision:
							canonical.changedRevision,
					},
				);
			}
			return true;
		});
	}

	/**
	 * Remove a put rejected by a concurrent tombstone only when the live
	 * server object is still the exact upload that lost the merge.
	 */
	private async cleanupRejectedUploads(): Promise<void> {
		for (const rejected of this.indexManager.consumeRejectedPuts()) {
			if (rejected.reason === "conflict") {
				await this.preserveRejectedConcurrentPut(rejected.path);
				continue;
			}
			if (this.vaultAdapter.fileExists(rejected.path)) {
				const content =
					await this.vaultAdapter.readFile(rejected.path);
				const currentSha = await computeSha256(content);
				const localAction =
					this.indexManager.enqueuePhysicalAction(
					"delete-local",
					rejected.path,
					{
						canonicalRevision:
							this.indexManager.getRemoteIndex().revision,
						origin: "rejected-upload",
						baselineSha256: rejected.baselineSha256,
					},
				);
				if (this.indexSaveCallback) await this.indexSaveCallback();
				const canonical =
					await this.indexManager.readCanonicalIndex();
				if (
					!isPhysicalDeleteAuthorized(localAction, canonical)
				) {
					this.indexManager.completePhysicalAction(
						localAction.id,
					);
					continue;
				}
				if (
					rejected.baselineSha256 === undefined ||
					currentSha !== rejected.baselineSha256
				) {
					const backupPath =
						await this.vaultAdapter.backupOverwrittenFile(
							rejected.path,
							content,
						);
					if (!backupPath) {
						throw new Error(
							`Could not create a backup before deleting ${rejected.path}`,
						);
					}
				}
				this.expectWatcherEvent(rejected.path, "delete");
				await this.vaultAdapter.deleteFile(rejected.path);
				this.indexManager.completePhysicalAction(localAction.id);
				this.indexManager.markLocalFileDeleted(rejected.path);
				if (this.indexSaveCallback) await this.indexSaveCallback();
			}
			try {
				this.indexManager.enqueuePhysicalAction(
					"delete-remote",
					rejected.path,
					{
						canonicalRevision:
							this.indexManager.getRemoteIndex().revision,
						expectedFingerprint:
							rejected.remoteFingerprint,
						origin: "rejected-upload",
					},
				);
				await this.deleteRemoteFile(rejected.path);
			} catch (e) {
				logger.warn(
					`Could not clean up rejected upload ${rejected.path}:`,
					{ error: e },
				);
			}
		}
	}

	/**
	 * Preserve the losing side of a concurrent live put as a conflict copy,
	 * then restore the canonical winner at the original path.
	 */
	private async preserveRejectedConcurrentPut(path: string): Promise<void> {
		if (!this.vaultAdapter.fileExists(path)) return;
		const localContent = await this.vaultAdapter.readFile(path);
		const localSha256 = await computeSha256(localContent);
		const currentCanonical =
			await this.indexManager.readCanonicalIndex();
		const directory = getDirectory(path);
		const fileName = getFileName(path);
		const extension = getExtension(path);
		const baseName = extension
			? fileName.slice(0, -(extension.length + 1))
			: fileName;
		const conflictPrefix = `${
			directory ? `${directory}/` : ""
		}${baseName}_conflict_`;
		const existingConflict = Object.entries(
			currentCanonical.files,
		).find(
			([candidatePath, metadata]) =>
				candidatePath.startsWith(conflictPrefix) &&
				!metadata.deleted &&
				metadata.sha256 === localSha256 &&
				(extension
					? candidatePath.endsWith(`.${extension}`)
					: !getFileName(candidatePath).includes(".")),
		)?.[0];
		const conflictPath =
			existingConflict ??
			this.conflictResolver.generateConflictName(
				path,
				this.settings.deviceId,
			);
		this.expectWatcherEvent(conflictPath, "upload");
		await this.vaultAdapter.writeFile(conflictPath, localContent);
		if (!existingConflict) {
			await this.uploadFile(conflictPath, false, true, {
				content: localContent,
				sha256: localSha256,
			});
			if (!(await this.saveRemoteIndexBestEffort())) {
				throw new Error(
					`Could not commit conflict copy for ${path}`,
				);
			}
		}

		const canonical = await this.indexManager.readCanonicalIndex();
		const winner = canonical.files[path];
		if (!winner || winner.deleted) return;
		const remotePath = joinPath(this.settings.remotePath, path);
		const physical =
			await this.yandexClient.getLogicalResource(remotePath);
		const fingerprint =
			physical?.sha256 || physical?.md5 || physical?.resource_id;
		if (
			!physical ||
			(winner.remoteFingerprint &&
				fingerprint !== winner.remoteFingerprint)
		) {
			throw new Error(
				`Canonical winner for ${path} is not physically available yet`,
			);
		}
		await this.downloadFile(
			path,
			new Date(physical.modified).getTime(),
		);
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

	private async getSyncBlockReason(
		skipGuard?: boolean,
	): Promise<string | null> {
		if (skipGuard) {
			return null;
		}
		if (this.externalBlockReason) {
			return this.externalBlockReason;
		}
		if (!this.syncGuardCallback) {
			return null;
		}
		return await this.syncGuardCallback();
	}

	private createBlockedResult(reason: string): SyncResult {
		this.setBlockedState(reason);
		return this.createErrorResult(reason);
	}

	private setBlockedState(reason: string): void {
		this.updateState({
			status: "encryption-required",
			errorMessage: reason,
			currentOperation: undefined,
			progress: undefined,
			pendingCount: 0,
		});
	}
}
