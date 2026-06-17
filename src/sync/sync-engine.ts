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
import { IndexManager } from "./index-manager";
import { ConflictResolver } from "./conflict-resolver";
import { joinPath, getDirectory } from "../utils/path-utils";
import { computeSha256 } from "../utils/hash-utils";
import { logger } from "../utils/logger";
import { runWithConcurrencySettled } from "../utils/semaphore";

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
		settings: YandexDiskSyncSettings
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
				logger.error("Error in state handler:", e);
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
		if (this.isSyncing) {
			logger.warn("Synchronization already in progress");
			return this.createErrorResult("Synchronization already in progress");
		}

		if (this.isPaused) {
			logger.warn("Synchronization is paused");
			return this.createErrorResult("Synchronization is paused");
		}

		const blockReason = await this.getSyncBlockReason(options?.skipEncryptionGuard);
		if (blockReason) {
			return this.createBlockedResult(blockReason);
		}

		this.isSyncing = true;

		// Notify listeners that sync has started
		for (const callback of this.syncPauseCallbacks) {
			try {
				callback();
			} catch (e) {
				logger.error("Error in sync pause callback:", e);
			}
		}

		const startTime = Date.now();

		const result: SyncResult = {
			success: true,
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			conflicts: 0,
			errors: [],
			startTime,
			endTime: 0,
		};

		try {
			this.updateState({
				status: "syncing",
				currentOperation: "Preparing...",
				progress: 0,
			});

			// 1. Ensure remote folder exists
			this.updateState({
				currentOperation: "Checking remote folder...",
			});
			const remoteExists = await this.indexManager.remotePathExists();
			if (!remoteExists) {
				await this.indexManager.createRemotePath();
			}

			// 2. Load remote index
			this.updateState({
				currentOperation: "Loading remote index...",
			});
			await this.indexManager.loadRemoteIndex();

			// 3. Build local index
			this.updateState({
				currentOperation: "Scanning local files...",
			});
			const localFiles = await this.indexManager.buildLocalIndex();

			// 4. Get remote files list
			this.updateState({
				currentOperation: "Getting remote files list...",
			});
			const remoteFiles = await this.indexManager.getRemoteFiles();

			// 5. Determine operations
			this.updateState({ currentOperation: "Analyzing changes..." });
			const localIndex = this.indexManager.getLocalIndex();
			const remoteIndex = this.indexManager.getRemoteIndex();

			const operations = this.conflictResolver.determineOperations(
				localFiles,
				remoteFiles,
				localIndex.files,
				remoteIndex.files,
				startTime
			);

			logger.info(
				`Determined ${operations.length} synchronization operations`
			);

			// 6. Preflight: Create all necessary folders
			this.updateState({ currentOperation: "Creating folders..." });
			await this.ensureFoldersExist(operations);

			// 7. Execute operations in parallel by type
			const totalOps = operations.length;
			let processedOps = 0;

			// Group operations by type
			const uploads = operations.filter((op) => op.action === "upload");
			const downloads = operations.filter(
				(op) => op.action === "download"
			);
			const deletes = operations.filter(
				(op) =>
					op.action === "delete_remote" || op.action === "delete_local"
			);
			const conflicts = operations.filter(
				(op) => op.action === "conflict"
			);

			// Execute uploads in parallel
			if (uploads.length > 0) {
				this.updateState({ currentOperation: "Uploading files..." });
				const uploadResults = await this.executeOperationsParallel(
					uploads,
					result,
					(completed) => {
						processedOps = completed;
						const progress = Math.round(
							(processedOps / totalOps) * 100
						);
						this.updateState({
							progress,
							pendingCount: totalOps - processedOps,
						});
					}
				);
				result.uploaded = uploadResults.succeeded;
				result.errors.push(...uploadResults.errors);
			}

			// Execute downloads in parallel
			if (downloads.length > 0) {
				this.updateState({ currentOperation: "Downloading files..." });
				const downloadResults = await this.executeOperationsParallel(
					downloads,
					result,
					(completed) => {
						processedOps = uploads.length + completed;
						const progress = Math.round(
							(processedOps / totalOps) * 100
						);
						this.updateState({
							progress,
							pendingCount: totalOps - processedOps,
						});
					}
				);
				result.downloaded = downloadResults.succeeded;
				result.errors.push(...downloadResults.errors);
			}

			// Execute deletes in parallel
			if (deletes.length > 0) {
				this.updateState({ currentOperation: "Deleting files..." });
				const deleteResults = await this.executeOperationsParallel(
					deletes,
					result,
					(completed) => {
						processedOps =
							uploads.length + downloads.length + completed;
						const progress = Math.round(
							(processedOps / totalOps) * 100
						);
						this.updateState({
							progress,
							pendingCount: totalOps - processedOps,
						});
					}
				);
				result.deleted = deleteResults.succeeded;
				result.errors.push(...deleteResults.errors);
			}

			// Execute conflicts sequentially (require special handling)
			if (conflicts.length > 0) {
				this.updateState({
					currentOperation: "Resolving conflicts...",
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
					const progress = Math.round((processedOps / totalOps) * 100);
					this.updateState({
						currentOperation: `Conflict: ${op.path}`,
						progress,
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
							e
						);
					}
				}
			}

			// 8. Save indexes
			this.updateState({ currentOperation: "Saving indexes..." });
			this.indexManager.updateSyncTime();
			await this.indexManager.saveRemoteIndex();

			// 9. Cleanup old deleted records
			this.indexManager.cleanupDeletedFiles();

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

			logger.info(
				`Synchronization completed: uploaded ${result.uploaded}, downloaded ${result.downloaded}, deleted ${result.deleted}, conflicts ${result.conflicts}, errors ${result.errors.length}`
			);

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

			logger.error("Critical synchronization error:", e);
			return result;
		} finally {
			// Notify listeners that sync has ended
			for (const callback of this.syncResumeCallbacks) {
				try {
					callback();
				} catch (e) {
					logger.error("Error in sync resume callback:", e);
				}
			}

			this.isSyncing = false;
		}
	}

	/**
	 * Force synchronization from local to remote.
	 * Overwrites ALL remote files with local versions.
	 * Files not present locally are deleted from remote.
	 */
	async forceSyncFromLocal(options?: SyncRunOptions): Promise<SyncResult> {
		if (this.isSyncing) {
			logger.warn("Synchronization already in progress");
			return this.createErrorResult("Synchronization already in progress");
		}

		if (this.isPaused) {
			logger.warn("Synchronization is paused");
			return this.createErrorResult("Synchronization is paused");
		}

		const blockReason = await this.getSyncBlockReason(options?.skipEncryptionGuard);
		if (blockReason) {
			return this.createBlockedResult(blockReason);
		}

		this.isSyncing = true;

		for (const callback of this.syncPauseCallbacks) {
			try {
				callback();
			} catch (e) {
				logger.error("Error in sync pause callback:", e);
			}
		}

		const startTime = Date.now();

		const result: SyncResult = {
			success: true,
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			conflicts: 0,
			errors: [],
			startTime,
			endTime: 0,
		};

		try {
			this.updateState({
				status: "syncing",
				currentOperation: "Preparing...",
				progress: 0,
			});

			// 1. Ensure remote folder exists
			this.updateState({ currentOperation: "Checking remote folder..." });
			const remoteExists = await this.indexManager.remotePathExists();
			if (!remoteExists) {
				await this.indexManager.createRemotePath();
			}

			// 2. Build local index
			this.updateState({ currentOperation: "Scanning local files..." });
			const localFiles = await this.indexManager.buildLocalIndex();

			// 3. Get remote files list
			this.updateState({ currentOperation: "Getting remote files list..." });
			const remoteFiles = await this.indexManager.getRemoteFiles();

			// 4. Generate operations manually: all local → upload, remote-only → delete_remote
			// No ConflictResolver used — force overwrite regardless of timestamps/hashes
			this.updateState({ currentOperation: "Analyzing changes..." });
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
				`Force sync from local: ${operations.length} synchronization operations`
			);

			// 5. Preflight: Create all necessary folders
			this.updateState({ currentOperation: "Creating folders..." });
			await this.ensureFoldersExist(operations);

			// 6. Execute operations in parallel by type
			const totalOps = operations.length;
			let processedOps = 0;

			const uploads = operations.filter(
				(op) => op.action === "upload"
			);
			const deletes = operations.filter(
				(op) => op.action === "delete_remote"
			);

			if (uploads.length > 0) {
				this.updateState({ currentOperation: "Uploading files..." });
				const uploadResults = await this.executeOperationsParallel(
					uploads,
					result,
					(completed) => {
						processedOps = completed;
						const progress = Math.round(
							(processedOps / totalOps) * 100
						);
						this.updateState({
							progress,
							pendingCount: totalOps - processedOps,
						});
					}
				);
				result.uploaded = uploadResults.succeeded;
				result.errors.push(...uploadResults.errors);
			}

			if (deletes.length > 0) {
				this.updateState({ currentOperation: "Deleting remote files..." });
				const deleteResults = await this.executeOperationsParallel(
					deletes,
					result,
					(completed) => {
						processedOps = uploads.length + completed;
						const progress = Math.round(
							(processedOps / totalOps) * 100
						);
						this.updateState({
							progress,
							pendingCount: totalOps - processedOps,
						});
					}
				);
				result.deleted = deleteResults.succeeded;
				result.errors.push(...deleteResults.errors);
			}

			// 7. Sync indexes: remote becomes a copy of local
			this.updateState({ currentOperation: "Saving indexes..." });
			this.indexManager.cleanupDeletedFiles();
			const localIndex = this.indexManager.getLocalIndex();
			const remoteIndex = this.indexManager.getRemoteIndex();
			remoteIndex.files = { ...localIndex.files };
			this.indexManager.updateSyncTime();
			await this.indexManager.saveRemoteIndex();

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

			logger.info(
				`Force sync from local completed: uploaded ${result.uploaded}, deleted ${result.deleted}, errors ${result.errors.length}`
			);

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

			logger.error("Critical force sync error:", e);
			return result;
		} finally {
			for (const callback of this.syncResumeCallbacks) {
				try {
					callback();
				} catch (e) {
					logger.error("Error in sync resume callback:", e);
				}
			}

			this.isSyncing = false;
		}
	}

	/**
	 * Force synchronization from remote to local.
	 * Overwrites ALL local files with remote versions.
	 * Files not present on remote are deleted locally.
	 */
	async forceSyncFromRemote(options?: SyncRunOptions): Promise<SyncResult> {
		if (this.isSyncing) {
			logger.warn("Synchronization already in progress");
			return this.createErrorResult("Synchronization already in progress");
		}

		if (this.isPaused) {
			logger.warn("Synchronization is paused");
			return this.createErrorResult("Synchronization is paused");
		}

		const blockReason = await this.getSyncBlockReason(options?.skipEncryptionGuard);
		if (blockReason) {
			return this.createBlockedResult(blockReason);
		}

		this.isSyncing = true;

		for (const callback of this.syncPauseCallbacks) {
			try {
				callback();
			} catch (e) {
				logger.error("Error in sync pause callback:", e);
			}
		}

		const startTime = Date.now();

		const result: SyncResult = {
			success: true,
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			conflicts: 0,
			errors: [],
			startTime,
			endTime: 0,
		};

		try {
			this.updateState({
				status: "syncing",
				currentOperation: "Preparing...",
				progress: 0,
			});

			// 1. Ensure remote folder exists
			this.updateState({ currentOperation: "Checking remote folder..." });
			const remoteExists = await this.indexManager.remotePathExists();
			if (!remoteExists) {
				await this.indexManager.createRemotePath();
			}

			// 2. Build local index (to know what to delete)
			this.updateState({ currentOperation: "Scanning local files..." });
			const localFiles = await this.indexManager.buildLocalIndex();

			// 3. Load remote index
			this.updateState({ currentOperation: "Loading remote index..." });
			await this.indexManager.loadRemoteIndex();

			// 4. Get remote files list
			this.updateState({ currentOperation: "Getting remote files list..." });
			const remoteFiles = await this.indexManager.getRemoteFiles();

			// 5. Generate operations manually: all remote → download, local-only → delete_local
			this.updateState({ currentOperation: "Analyzing changes..." });
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
				`Force sync from remote: ${operations.length} synchronization operations`
			);

			// 6. Preflight: Create all necessary folders
			this.updateState({ currentOperation: "Creating folders..." });
			await this.ensureFoldersExist(operations);

			// 7. Execute operations in parallel by type
			const totalOps = operations.length;
			let processedOps = 0;

			const downloads = operations.filter(
				(op) => op.action === "download"
			);
			const deletes = operations.filter(
				(op) => op.action === "delete_local"
			);

			if (downloads.length > 0) {
				this.updateState({ currentOperation: "Downloading files..." });
				const downloadResults = await this.executeOperationsParallel(
					downloads,
					result,
					(completed) => {
						processedOps = completed;
						const progress = Math.round(
							(processedOps / totalOps) * 100
						);
						this.updateState({
							progress,
							pendingCount: totalOps - processedOps,
						});
					}
				);
				result.downloaded = downloadResults.succeeded;
				result.errors.push(...downloadResults.errors);
			}

			if (deletes.length > 0) {
				this.updateState({ currentOperation: "Deleting local files..." });
				const deleteResults = await this.executeOperationsParallel(
					deletes,
					result,
					(completed) => {
						processedOps = downloads.length + completed;
						const progress = Math.round(
							(processedOps / totalOps) * 100
						);
						this.updateState({
							progress,
							pendingCount: totalOps - processedOps,
						});
					}
				);
				result.deleted = deleteResults.succeeded;
				result.errors.push(...deleteResults.errors);
			}

			// 8. Sync indexes: local becomes a copy of remote
			this.updateState({ currentOperation: "Saving indexes..." });
			this.indexManager.cleanupDeletedFiles();
			const localIndex = this.indexManager.getLocalIndex();
			const remoteIndex = this.indexManager.getRemoteIndex();
			localIndex.files = { ...remoteIndex.files };
			this.indexManager.updateSyncTime();
			await this.indexManager.saveRemoteIndex();

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

			logger.info(
				`Force sync from remote completed: downloaded ${result.downloaded}, deleted ${result.deleted}, errors ${result.errors.length}`
			);

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

			logger.error("Critical force sync error:", e);
			return result;
		} finally {
			for (const callback of this.syncResumeCallbacks) {
				try {
					callback();
				} catch (e) {
					logger.error("Error in sync resume callback:", e);
				}
			}

			this.isSyncing = false;
		}
	}

	/**
	 * Execute single operation
	 */
	private async executeOperation(
		op: SyncOperation,
		result: SyncResult
	): Promise<void> {
		switch (op.action) {
			case "upload":
				await this.uploadFile(op.path);
				result.uploaded++;
				break;

			case "download":
				await this.downloadFile(op.path);
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
		operations: SyncOperation[]
	): Promise<void> {
		const folders = new Set<string>();

		for (const op of operations) {
			if (op.action === "upload" || op.action === "download") {
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
		onProgress?: (completed: number) => void
	): Promise<{ succeeded: number; errors: SyncError[] }> {
		const tasks = operations.map((op) => async () => {
			if (this.isPaused) {
				throw new Error("Synchronization interrupted");
			}

			switch (op.action) {
				case "upload":
					// Skip folder check since we pre-created all folders
					await this.uploadFile(op.path, true);
					break;
				case "download":
					await this.downloadFile(op.path);
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
			onProgress
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
					res.reason
				);
			} else {
				succeeded++;
			}
		}

		return { succeeded, errors };
	}

	/**
	 * Upload file to Yandex Disk
	 */
	async uploadFile(path: string, skipFolderCheck = false): Promise<void> {
		logger.debug(`Uploading file: ${path}`);

		const content = await this.vaultAdapter.readFile(path);
		const remotePath = joinPath(this.settings.remotePath, path);

		await this.yandexClient.uploadFile(remotePath, content, skipFolderCheck);

		// Update indexes
		const sha256 = await computeSha256(content);
		const mtime = this.vaultAdapter.getFileMtime(path) || Date.now();
		const size = content.byteLength;

		const metadata: FileMetadata = {
			path,
			sha256,
			size,
			mtime,
			syncedAt: Date.now(),
		};

		this.indexManager.updateLocalFile(path, metadata);
		this.indexManager.updateRemoteFile(path, metadata);
	}

	/**
	 * Download file from Yandex Disk
	 */
	async downloadFile(path: string): Promise<void> {
		logger.debug(`Downloading file: ${path}`);

		const remotePath = joinPath(this.settings.remotePath, path);
		const content = await this.yandexClient.downloadFile(remotePath);

		await this.vaultAdapter.writeFile(path, content);

		// Update indexes
		const sha256 = await computeSha256(content);
		const mtime = this.vaultAdapter.getFileMtime(path) || Date.now();

		const metadata: FileMetadata = {
			path,
			sha256,
			size: content.byteLength,
			mtime,
			syncedAt: Date.now(),
		};

		this.indexManager.updateLocalFile(path, metadata);
		this.indexManager.updateRemoteFile(path, metadata);
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

		// Remove parent folders that became empty after this deletion
		await this.pruneRemoteFolders([path]);
	}

	/**
	 * Delete remote folders that became empty after file deletions.
	 * Uses the in-memory remote index to determine emptiness — no extra API
	 * calls needed. Must be called after index updates so the index reflects
	 * the current state. Deletes deepest directories first so children are
	 * removed before their parents.
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
				(fp) => !remoteFiles[fp]?.deleted && fp.startsWith(prefix)
			);
		});
		if (emptyDirs.length === 0) return;

		emptyDirs.sort((a, b) => b.split("/").length - a.split("/").length);

		for (const dir of emptyDirs) {
			await this.yandexClient.deleteResource(
				joinPath(this.settings.remotePath, dir)
			);
			logger.debug(`[SyncEngine] Pruned empty remote folder: ${dir}`);
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
				this.settings.deviceId
			);

			const localContent = await this.vaultAdapter.readFile(op.path);
			await this.vaultAdapter.writeFile(conflictPath, localContent);

			// Upload conflict copy to disk
			const remoteConflictPath = joinPath(
				this.settings.remotePath,
				conflictPath
			);
			await this.yandexClient.uploadFile(
				remoteConflictPath,
				localContent
			);

			// Download remote version
			await this.downloadFile(op.path);

			logger.info(`Conflict resolved, copy created: ${conflictPath}`);
		}
	}

	/**
	 * Synchronize single file (for real-time sync)
	 */
	async syncSingleFile(
		path: string,
		action: "upload" | "delete"
	): Promise<void> {
		logger.info(`[SyncEngine] syncSingleFile called for ${path}, action: ${action}`);

		const blockReason = await this.getSyncBlockReason(false);
		if (blockReason) {
			logger.warn(`[SyncEngine] Skipping file sync ${path}: ${blockReason}`);
			this.setBlockedState(blockReason);
			return;
		}

		if (this.isPaused || this.isSyncing) {
			logger.info(
				`[SyncEngine] Skipping file sync ${path}: sync busy (${this.isSyncing}) or paused (${this.isPaused})`
			);
			// Persist the deletion intent so the next fullSync resolves it as
			// delete_remote (Case 3) rather than downloading the file (Case 2/8).
			if (action === "delete") {
				this.indexManager.markLocalFileDeleted(path);
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
			await this.indexManager.saveRemoteIndex();
			logger.debug(`Remote index saved after ${action} for ${path}`);

			// Save local index via callback
			if (this.indexSaveCallback) {
				await this.indexSaveCallback();
				logger.debug(`Local index saved after ${action} for ${path}`);
			}
		} catch (e) {
			logger.error(`Error synchronizing file ${path}:`, e);
		}
	}

	/**
	 * Rename file on Yandex Disk
	 */
	async renameFile(oldPath: string, newPath: string): Promise<void> {
		const blockReason = await this.getSyncBlockReason(false);
		if (blockReason) {
			logger.warn(`[SyncEngine] Skipping rename ${oldPath}: ${blockReason}`);
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
				await this.indexManager.saveRemoteIndex();
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
			await this.indexManager.saveRemoteIndex();
			logger.debug(`File renamed: ${oldPath} -> ${newPath}`);

			// Save local index via callback
			if (this.indexSaveCallback) {
				await this.indexSaveCallback();
			}
		} catch (e) {
			logger.error(`Error renaming file ${oldPath}:`, e);
			// If rename failed, upload file again
			await this.uploadFile(newPath);
			// Save remote index after upload
			await this.indexManager.saveRemoteIndex();
			// Save local index via callback
			if (this.indexSaveCallback) {
				await this.indexSaveCallback();
			}
		}
	}

	/**
	 * Create error result
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

	private async getSyncBlockReason(skipGuard?: boolean): Promise<string | null> {
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
