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

export class SyncEngine {
	private yandexClient: YandexDiskClient;
	private vaultAdapter: VaultAdapter;
	private indexManager: IndexManager;
	private conflictResolver: ConflictResolver;
	private settings: YandexDiskSyncSettings;

	private state: SyncState = { ...INITIAL_SYNC_STATE };
	private eventListeners: SyncEventCallback[] = [];
	private indexSaveCallback: IndexSaveCallback | null = null;
	private isSyncing = false;
	private isPaused = false;

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
	async fullSync(): Promise<SyncResult> {
		if (this.isSyncing) {
			logger.warn("Synchronization already in progress");
			return this.createErrorResult("Synchronization already in progress");
		}

		if (this.isPaused) {
			logger.warn("Synchronization is paused");
			return this.createErrorResult("Synchronization is paused");
		}

		this.isSyncing = true;
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
				remoteIndex.files
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
			// eslint-disable-next-line @typescript-eslint/no-unsafe-call
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

		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
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

		if (this.isPaused || this.isSyncing) {
			logger.info(
				`[SyncEngine] Skipping file sync ${path}: sync busy (${this.isSyncing}) or paused (${this.isPaused})`
			);
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
}
