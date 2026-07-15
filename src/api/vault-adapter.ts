/**
 * Adapter for working with Obsidian Vault files
 */

import {
	App,
	TFile,
	TFolder,
	Vault,
	normalizePath as obsidianNormalize,
} from "obsidian";
import type { FileMetadata, YandexDiskSyncSettings } from "../types";
import { computeSha256 } from "../utils/hash-utils";
import {
	normalizePath,
	shouldSyncFile,
	getDirectory,
} from "../utils/path-utils";
import { logger } from "../utils/logger";
import { runWithConcurrency } from "../utils/semaphore";

export class VaultAdapter {
	private app: App;
	private settings: YandexDiskSyncSettings;

	constructor(app: App, settings: YandexDiskSyncSettings) {
		this.app = app;
		this.settings = settings;
	}

	/**
	 * Update settings
	 */
	updateSettings(settings: YandexDiskSyncSettings): void {
		this.settings = settings;
	}

	/**
	 * Get Vault
	 */
	get vault(): Vault {
		return this.app.vault;
	}

	/**
	 * Get list of all files for synchronization
	 */
	getAllSyncableFiles(): TFile[] {
		const allFiles = this.vault.getFiles();
		const configDir = this.app.vault.configDir;

		logger.debug(`Total files in vault: ${allFiles.length}`);
		logger.debug(`Config dir: ${configDir}`);
		logger.debug(
			`Sync patterns: ${JSON.stringify(this.settings.syncPatterns)}`,
		);
		logger.debug(
			`Exclude patterns: ${JSON.stringify(this.settings.excludePatterns)}`,
		);
		logger.debug(`Sync .obsidian: ${this.settings.syncDotObsidian}`);

		const syncableFiles = allFiles.filter((file) => {
			return shouldSyncFile(
				file.path,
				this.settings.syncPatterns,
				this.settings.excludePatterns,
				this.settings.syncDotObsidian,
				configDir,
			);
		});

		logger.debug(`Files for synchronization: ${syncableFiles.length}`);
		return syncableFiles;
	}

	/**
	 * Check if file should be synchronized
	 */
	shouldSync(path: string): boolean {
		const result = shouldSyncFile(
			path,
			this.settings.syncPatterns,
			this.settings.excludePatterns,
			this.settings.syncDotObsidian,
			this.app.vault.configDir,
		);
		return result;
	}

	/**
	 * Get file by path
	 */
	getFile(path: string): TFile | null {
		const abstractFile = this.vault.getAbstractFileByPath(
			normalizePath(path),
		);
		if (abstractFile instanceof TFile) {
			return abstractFile;
		}
		return null;
	}

	/**
	 * Check file existence
	 */
	fileExists(path: string): boolean {
		return this.getFile(path) !== null;
	}

	/**
	 * Get folder by path
	 */
	getFolder(path: string): TFolder | null {
		const abstractFile = this.vault.getAbstractFileByPath(
			normalizePath(path),
		);
		if (abstractFile instanceof TFolder) {
			return abstractFile;
		}
		return null;
	}

	/**
	 * Check folder existence
	 */
	folderExists(path: string): boolean {
		return this.getFolder(path) !== null;
	}

	/**
	 * Read file content as ArrayBuffer
	 */
	async readFile(path: string): Promise<ArrayBuffer> {
		const file = this.getFile(path);
		if (!file) {
			throw new Error(`File not found: ${path}`);
		}
		return this.vault.readBinary(file);
	}

	/**
	 * Read file content as string
	 */
	async readFileAsString(path: string): Promise<string> {
		const file = this.getFile(path);
		if (!file) {
			throw new Error(`File not found: ${path}`);
		}
		return this.vault.read(file);
	}

	/**
	 * Write file
	 */
	async writeFile(
		path: string,
		content: ArrayBuffer | string,
	): Promise<void> {
		const normalizedPath = normalizePath(path);

		// Ensure folder exists
		const dir = getDirectory(normalizedPath);
		if (dir && !this.folderExists(dir)) {
			await this.createFolderRecursive(dir);
		}

		const existingFile = this.getFile(normalizedPath);

		if (existingFile) {
			if (typeof content === "string") {
				await this.vault.modify(existingFile, content);
			} else {
				await this.vault.modifyBinary(existingFile, content);
			}
		} else {
			if (typeof content === "string") {
				await this.vault.create(normalizedPath, content);
			} else {
				await this.vault.createBinary(normalizedPath, content);
			}
		}

		logger.debug(`Written file: ${normalizedPath}`);
	}

	/**
	 * Delete file
	 */
	async deleteFile(path: string): Promise<void> {
		const file = this.getFile(path);
		if (file) {
			await this.app.fileManager.trashFile(file);
			logger.debug(`Deleted file: ${path}`);
		}
	}

	/**
	 * Rename/move file
	 */
	async renameFile(oldPath: string, newPath: string): Promise<void> {
		const file = this.getFile(oldPath);
		if (!file) {
			throw new Error(`File not found: ${oldPath}`);
		}

		// Ensure target folder exists
		const dir = getDirectory(newPath);
		if (dir && !this.folderExists(dir)) {
			await this.createFolderRecursive(dir);
		}

		await this.vault.rename(file, normalizePath(newPath));
		logger.debug(`Renamed file: ${oldPath} -> ${newPath}`);
	}

	/**
	 * Create folder
	 */
	async createFolder(path: string): Promise<void> {
		const normalizedPath = normalizePath(path);
		if (!this.folderExists(normalizedPath)) {
			await this.vault.createFolder(normalizedPath);
			logger.debug(`Created folder: ${normalizedPath}`);
		}
	}

	/**
	 * Create folder with parent directories
	 */
	async createFolderRecursive(path: string): Promise<void> {
		const parts = normalizePath(path).split("/");
		let currentPath = "";

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			if (!this.folderExists(currentPath)) {
				await this.vault.createFolder(currentPath);
			}
		}
	}

	/**
	 * Delete folder
	 */
	async deleteFolder(path: string): Promise<void> {
		const folder = this.getFolder(path);
		if (folder) {
			await this.app.fileManager.trashFile(folder);
			logger.debug(`Deleted folder: ${path}`);
		}
	}

	/**
	 * Walk up from a deleted file's directory and trash each ancestor folder
	 * that has become completely empty (no files and no subfolders). Stops at
	 * the first non-empty ancestor, at the vault root, or at the Obsidian
	 * config directory. Only folders that contain nothing are removed, so a
	 * folder holding local-only or excluded files is never touched. Trashed
	 * folders are recoverable from the system trash. Mirrors the remote
	 * {@link SyncEngine.pruneRemoteFolders} behavior so the local and remote
	 * folder trees stay consistent after deletions.
	 */
	async pruneEmptyLocalAncestors(filePath: string): Promise<void> {
		const configDir = this.app.vault.configDir;
		let dir = getDirectory(normalizePath(filePath));
		while (dir) {
			if (dir === configDir) break;
			const folder = this.getFolder(dir);
			if (!folder) break;
			if (folder.children.length > 0) break;
			try {
				await this.app.fileManager.trashFile(folder);
				logger.debug(`Pruned empty local folder: ${dir}`);
			} catch (e) {
				logger.warn(`Failed to prune empty local folder ${dir}:`, {
					error: e,
				});
				break;
			}
			dir = getDirectory(dir);
		}
	}

	/**
	 * Save a recoverable backup copy of the given content under the plugin's
	 * data folder inside the Obsidian config directory (`.obsidian/plugins`),
	 * which is excluded from synchronization by default. Used before a download
	 * overwrites a local file whose content diverged from the last synced state
	 * (e.g. legacy mixed-clock conflict resolution, or a force-sync from
	 * remote), so unsaved local edits are never silently lost. The backup is
	 * flattened into a single file with a timestamp to avoid nested folder
	 * creation and to keep it out of the sync scope.
	 */
	async backupOverwrittenFile(
		originalPath: string,
		content: ArrayBuffer,
	): Promise<string | null> {
		try {
			const configDir = this.app.vault.configDir;
			const ts = new Date()
				.toISOString()
				.replace(/[:.]/g, "-")
				.slice(0, 19);
			const safeName = originalPath.replace(/[\\/]+/g, "__");
			const backupName = `${safeName}_${ts}`;
			const backupPath = obsidianNormalize(
				`${configDir}/plugins/yandex-disk-sync/overwritten/${backupName}`,
			);
			const backupDir = getDirectory(backupPath);
			if (backupDir && !this.folderExists(backupDir)) {
				await this.createFolderRecursive(backupDir);
			}
			await this.vault.createBinary(backupPath, content);
			logger.info(`Backed up overwritten local file to: ${backupPath}`);
			return backupPath;
		} catch (e) {
			logger.warn(`Failed to back up overwritten file ${originalPath}:`, {
				error: e,
			});
			return null;
		}
	}

	/**
	 * Remove backup files under `overwritten/` older than `maxAgeDays`. Called
	 * once at plugin load to keep the backup directory from growing without
	 * bound. Each backup is trashed (recoverable) and counted. Errors per-file
	 * are logged and skipped so one bad file doesn't abort the whole sweep.
	 */
	async cleanupOldBackups(maxAgeDays = 30): Promise<number> {
		const configDir = this.app.vault.configDir;
		const backupDir = obsidianNormalize(
			`${configDir}/plugins/yandex-disk-sync/overwritten`,
		);
		const folder = this.getFolder(backupDir);
		if (!folder) return 0;

		const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
		let removed = 0;
		for (const child of folder.children) {
			if (!(child instanceof TFile)) continue;
			if (child.stat.mtime < cutoff) {
				try {
					await this.app.fileManager.trashFile(child);
					removed++;
				} catch (e) {
					logger.warn(
						`Failed to remove stale backup ${child.path}:`,
						{ error: e },
					);
				}
			}
		}
		if (removed > 0) {
			logger.info(
				`Cleaned up ${removed} stale overwritten-file backup(s) older than ${maxAgeDays}d`,
			);
		}
		return removed;
	}

	/**
	 * Get file metadata
	 */
	async getFileMetadata(path: string): Promise<FileMetadata | null> {
		const file = this.getFile(path);
		if (!file) {
			return null;
		}

		const content = await this.vault.readBinary(file);
		const sha256 = await computeSha256(content);

		return {
			path: file.path,
			sha256,
			size: file.stat.size,
			mtime: file.stat.mtime,
			syncedAt: 0,
		};
	}

	/**
	 * Get metadata of all synchronizable files
	 */
	async getAllFileMetadata(): Promise<Map<string, FileMetadata>> {
		const files = this.getAllSyncableFiles();
		const metadata = new Map<string, FileMetadata>();

		// Process files in parallel with concurrency limit
		const tasks = files.map((file) => async () => {
			try {
				const content = await this.vault.readBinary(file);
				const sha256 = await computeSha256(content);

				return {
					path: file.path,
					metadata: {
						path: file.path,
						sha256,
						size: file.stat.size,
						mtime: file.stat.mtime,
						syncedAt: 0,
					},
				};
			} catch (e) {
				logger.warn(`Failed to get file metadata: ${file.path}`, {
					error: e,
				});
				return null;
			}
		});

		// Use higher concurrency for CPU-bound operations
		const results = await runWithConcurrency(tasks, 10);

		// Collect results into map
		for (const result of results) {
			if (result) {
				metadata.set(result.path, result.metadata);
			}
		}

		return metadata;
	}

	/**
	 * Get file modification time
	 */
	getFileMtime(path: string): number | null {
		const file = this.getFile(path);
		return file ? file.stat.mtime : null;
	}

	/**
	 * Get file size
	 */
	getFileSize(path: string): number | null {
		const file = this.getFile(path);
		return file ? file.stat.size : null;
	}
}
