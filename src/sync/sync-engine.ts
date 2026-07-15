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
import { joinPath, getDirectory } from "../utils/path-utils";
import { computeSha256 } from "../utils/hash-utils";
import { logger } from "../utils/logger";
import { runWithConcurrencySettled } from "../utils/semaphore";
import { t } from "../i18n";

export type SyncEventCallback = (state: SyncState) => void;
export type IndexSaveCallback = () => void | Promise<void>;
export type SyncGuardCallback = () => string | null | Promise<string | null>;

export interface SyncRunOptions {
	/** Skip encryption state guard for internal encryption maintenance flows. */
	skipEncryptionGuard?: boolean;
	/**
	 * Skip generation of delete_remote operations. Used by encryption transition
	 * flows where remote cleanup of stale paths is handled separately as a bulk
	 * operation, avoiding race conditions from concurrent folder deletions.
	 */
	skipRemoteDeletes?: boolean;
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
		return await this.runSyncSession(
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
				const deletes = operations.filter(
					(op) =>
						op.action === "delete_remote" ||
						op.action === "delete_local",
				);
				const conflicts = operations.filter(
					(op) => op.action === "conflict",
				);

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

				// Cleanup expired tombstones BEFORE deciding whether to save.
				// This ensures removed tombstones are persisted in the same
				// write, not deferred to the next sync.
				const hadOperations =
					result.uploaded > 0 ||
					result.downloaded > 0 ||
					result.deleted > 0 ||
					result.conflicts > 0;
				const tombstonesRemoved =
					this.indexManager.cleanupDeletedFiles();

				// Skip the remote index write when nothing changed during this
				// sync: no file operations, no batch mtime stamping, and no
				// expired tombstones. This avoids unnecessary API calls, 409
				// "folder exists" noise, and reduces the window for concurrent-
				// index conflicts between devices. The local index is still
				// persisted by the caller via indexSaveCallback.
				const indexDirty =
					hadOperations || mtimeStamped || tombstonesRemoved;
				if (!indexDirty) {
					logger.debug(
						"[SyncEngine] No changes detected, skipping remote index save",
					);
					return;
				}

				this.indexManager.updateSyncTime();
				if (!(await this.saveRemoteIndexOrAbort(result))) {
					return;
				}
			},
			(result) =>
				`Synchronization completed: uploaded ${result.uploaded}, downloaded ${result.downloaded}, deleted ${result.deleted}, conflicts ${result.conflicts}, errors ${result.errors.length}`,
		);
	}

	/**
	 * Force synchronization from local to remote.
	 * Overwrites ALL remote files with local versions.
	 * Files not present locally are deleted from remote.
	 */
	async forceSyncFromLocal(options?: SyncRunOptions): Promise<SyncResult> {
		return await this.runSyncSession(
			options,
			async (result) => {
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
				const deletes = operations.filter(
					(op) => op.action === "delete_remote",
				);

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
				}

				if (deletes.length > 0) {
					this.updateState({
						currentOperation: t("status.op.deleting_remote_files"),
					});
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

				// 7. Sync indexes: remote becomes a copy of local (only for
				// operations that actually succeeded). Entries whose upload/delete
				// failed are left out of the remote index so that (a) the next
				// sync retries them, and (b) other devices don't try to download
				// files that never made it to remote and fail with 404.
				this.updateState({
					currentOperation: t("status.op.saving_indexes"),
				});
				this.indexManager.cleanupDeletedFiles();
				const localIndex = this.indexManager.getLocalIndex();
				const remoteIndex = this.indexManager.getRemoteIndex();
				const failedPaths = new Set(
					result.errors.map((e) => e.path).filter(Boolean),
				);
				const newRemoteFiles: Record<string, FileMetadata> = {};
				for (const [p, meta] of Object.entries(localIndex.files)) {
					if (failedPaths.has(p)) continue;
					newRemoteFiles[p] = meta;
				}
				remoteIndex.files = newRemoteFiles;
				this.indexManager.updateSyncTime();
				if (!(await this.saveRemoteIndexOrAbort(result))) {
					return;
				}
			},
			(result) =>
				`Force sync from local completed: uploaded ${result.uploaded}, deleted ${result.deleted}, errors ${result.errors.length}`,
		);
	}

	/**
	 * Force synchronization from remote to local.
	 * Overwrites ALL local files with remote versions.
	 * Files not present on remote are deleted locally.
	 */
	async forceSyncFromRemote(options?: SyncRunOptions): Promise<SyncResult> {
		return await this.runSyncSession(
			options,
			async (result) => {
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

				// 3. Load remote index
				this.updateState({
					currentOperation: t("status.op.loading_remote_index"),
				});
				await this.indexManager.loadRemoteIndex();

				// 4. Get remote files list
				this.updateState({
					currentOperation: t("status.op.getting_remote_files"),
				});
				const remoteFiles = await this.indexManager.getRemoteFiles();

				// 5. Generate operations manually: all remote → download, local-only → delete_local
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

				// 6. Preflight: Create all necessary folders
				this.updateState({
					currentOperation: t("status.op.creating_folders"),
				});
				await this.ensureFoldersExist(operations);

				// 7. Execute operations in parallel by type
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
				}

				if (deletes.length > 0) {
					this.updateState({
						currentOperation: t("status.op.deleting_local_files"),
					});
					const deleteResults = await this.executeOperationsParallel(
						deletes,
						result,
						(completed) => {
							processedOps = downloads.length + completed;
							this.reportProgress(processedOps, totalOps);
						},
					);
					result.deleted = deleteResults.succeeded;
					result.errors.push(...deleteResults.errors);
				}

				// 8. Sync indexes: local becomes a copy of remote (only for
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
				if (!(await this.saveRemoteIndexOrAbort(result))) {
					return;
				}
			},
			(result) =>
				`Force sync from remote completed: downloaded ${result.downloaded}, deleted ${result.deleted}, errors ${result.errors.length}`,
		);
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
	): Promise<void> {
		logger.debug(`Uploading file: ${path}`);

		const content = await this.vaultAdapter.readFile(path);
		const remotePath = joinPath(this.settings.remotePath, path);

		await this.yandexClient.uploadFile(
			remotePath,
			content,
			skipFolderCheck,
		);

		// Update indexes
		const sha256 = await computeSha256(content);
		const mtime = this.vaultAdapter.getFileMtime(path) || Date.now();
		const size = content.byteLength;
		// Best-effort: if the fetch fails, leave remoteMtime undefined and the
		// resolver falls back to the legacy mixed-clock comparison.
		const remoteMtime = stampRemoteMtime
			? await this.fetchServerMtime(path)
			: undefined;

		const metadata: FileMetadata = {
			path,
			sha256,
			size,
			mtime,
			syncedAt: Date.now(),
		};

		this.indexManager.updateLocalFile(path, metadata);
		// The remote index entry additionally carries the server mtime so the
		// next sync can detect external remote modifications without involving
		// the local clock.
		this.indexManager.updateRemoteFile(path, { ...metadata, remoteMtime });
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

		await this.vaultAdapter.writeFile(path, content);

		// Update indexes
		const sha256 = await computeSha256(content);
		const mtime = this.vaultAdapter.getFileMtime(path) || Date.now();
		const remoteMtime = serverMtime ?? (await this.fetchServerMtime(path));

		const metadata: FileMetadata = {
			path,
			sha256,
			size: content.byteLength,
			mtime,
			syncedAt: Date.now(),
		};

		this.indexManager.updateLocalFile(path, metadata);
		this.indexManager.updateRemoteFile(path, { ...metadata, remoteMtime });
	}

	/**
	 * Fetch the server-side modification time for a remote file. Returns
	 * undefined when the resource cannot be read (e.g. it was concurrently
	 * deleted) or the modified timestamp is not parseable. Callers treat
	 * undefined as "no remoteMtime known" and fall back to legacy logic.
	 */
	private async fetchServerMtime(path: string): Promise<number | undefined> {
		try {
			const remotePath = joinPath(this.settings.remotePath, path);
			const resource = await this.yandexClient.getResource(remotePath);
			if (!resource) return undefined;
			const ts = new Date(resource.modified).getTime();
			return Number.isFinite(ts) ? ts : undefined;
		} catch (e) {
			logger.debug(`Failed to fetch server mtime for ${path}:`, {
				error: e,
			});
			return undefined;
		}
	}

	/**
	 * Delete file on Yandex Disk
	 */
	async deleteRemoteFile(path: string): Promise<void> {
		logger.debug(`Deleting remote file: ${path}`);

		const remotePath = joinPath(this.settings.remotePath, path);
		await this.yandexClient.deleteResource(remotePath);

		// Update indexes
		this.indexManager.markRemoteFileDeleted(path);
		this.indexManager.removeFromLocalIndex(path);
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
		logger.debug(`Deleting local file: ${path}`);

		await this.vaultAdapter.deleteFile(path);

		// Update indexes
		this.indexManager.markLocalFileDeleted(path);
		this.indexManager.removeFromRemoteIndex(path);

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
			await this.vaultAdapter.writeFile(conflictPath, localContent);

			// Upload conflict copy to disk
			const remoteConflictPath = joinPath(
				this.settings.remotePath,
				conflictPath,
			);
			await this.yandexClient.uploadFile(
				remoteConflictPath,
				localContent,
			);

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

		if (this.isPaused || this.isSyncing) {
			logger.info(
				`[SyncEngine] Skipping file sync ${path}: sync busy (${this.isSyncing}) or paused (${this.isPaused})`,
			);
			// Persist the deletion intent so the next fullSync resolves it as
			// delete_remote (Case 3) rather than downloading the file (Case 2/8).
			if (action === "delete") {
				this.indexManager.markLocalFileDeleted(path);
				// Persist the local index to disk; otherwise an Obsidian restart
				// before the next full sync would lose the deletion intent and
				// the file would be re-downloaded (Case 8: remote mtime > 0).
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

		if (!this.vaultAdapter.shouldSync(path)) {
			logger.info(`[SyncEngine] File ${path} should not be synchronized`);
			return;
		}

		logger.info(`[SyncEngine] Starting file synchronization ${path}`);

		try {
			if (action === "upload") {
				await this.uploadFile(path);
			} else if (action === "delete") {
				await this.deleteRemoteFile(path);
			}

			// Save remote index after operation to keep it in sync
			await this.saveRemoteIndexBestEffort();
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
		const blockReason = await this.getSyncBlockReason(false);
		if (blockReason) {
			logger.warn(
				`[SyncEngine] Skipping rename ${oldPath}: ${blockReason}`,
			);
			this.setBlockedState(blockReason);
			return;
		}

		if (this.isPaused || this.isSyncing) {
			return;
		}

		if (!this.vaultAdapter.shouldSync(newPath)) {
			// If new path is not synchronized, delete old one
			if (this.vaultAdapter.shouldSync(oldPath)) {
				await this.deleteRemoteFile(oldPath);
				// Save remote index after deletion
				await this.saveRemoteIndexBestEffort();
				// Save local index via callback
				if (this.indexSaveCallback) {
					await this.indexSaveCallback();
				}
			}
			return;
		}

		try {
			const oldRemotePath = joinPath(this.settings.remotePath, oldPath);
			const newRemotePath = joinPath(this.settings.remotePath, newPath);

			await this.yandexClient.moveResource(oldRemotePath, newRemotePath);

			// Update indexes
			const oldLocalMeta =
				this.indexManager.getLocalIndex().files[oldPath];
			const oldRemoteMeta =
				this.indexManager.getRemoteIndex().files[oldPath];

			// Mark old file as deleted in both indexes
			// This is important for other devices to know the file was renamed/deleted
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

			// Remove source folders that became empty after the move
			await this.pruneRemoteFolders([oldPath]);

			// Save remote index after rename
			await this.saveRemoteIndexBestEffort();
			logger.debug(`File renamed: ${oldPath} -> ${newPath}`);

			// Save local index via callback
			if (this.indexSaveCallback) {
				await this.indexSaveCallback();
			}
		} catch (e) {
			logger.error(`Error renaming file ${oldPath}:`, { error: e });
			// If rename failed, the source remote file may still exist. Remove
			// it before re-uploading to the destination so we don't leave a
			// duplicate that would otherwise only be cleaned up on the next
			// full sync (ConflictResolver Case 3). Best-effort: ignore if it's
			// already gone (404) or if the move partially succeeded.
			try {
				const staleRemotePath = joinPath(
					this.settings.remotePath,
					oldPath,
				);
				await this.yandexClient.deleteResource(staleRemotePath);
			} catch (cleanupErr) {
				logger.warn(
					`Failed to clean up old remote file after rename failure (${oldPath}):`,
					{ error: cleanupErr },
				);
			}
			// Re-upload the file to the destination path
			await this.uploadFile(newPath);
			// Save remote index after upload
			await this.saveRemoteIndexBestEffort();
			// Save local index via callback
			if (this.indexSaveCallback) {
				await this.indexSaveCallback();
			}
		}
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
		if (this.isSyncing) {
			logger.warn("Synchronization already in progress");
			return this.createErrorResult(
				"Synchronization already in progress",
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

		try {
			this.updateState({
				status: "syncing",
				currentOperation: t("status.op.preparing"),
				progress: 0,
			});

			await body(result, startTime);

			result.success = result.errors.length === 0;
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

			logger.info(logMessage(result));

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

			logger.error("Critical synchronization error:", { error: e });
			return result;
		} finally {
			this.notifySyncResumeCallbacks();
			this.isSyncing = false;
		}
	}

	/**
	 * Save the remote index with optimistic concurrency control. If another
	 * device wrote a newer index during this sync, do NOT overwrite it: our
	 * physical file transfers already landed and will be reconciled on the next
	 * sync once we reload the newer index. Returns false (and records an error
	 * on `result`) when the save was skipped due to a concurrent modification.
	 */
	private async saveRemoteIndexOrAbort(result: SyncResult): Promise<boolean> {
		try {
			await this.indexManager.saveRemoteIndex();
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
	private async saveRemoteIndexBestEffort(): Promise<void> {
		try {
			await this.indexManager.saveRemoteIndex();
		} catch (e) {
			if (e instanceof RemoteIndexConcurrentModificationError) {
				logger.warn(
					"Remote index modified concurrently during single-file sync; skipping remote index save. It will be reconciled on the next full sync.",
				);
				return;
			}
			throw e;
		}
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
