import { OperationFailure } from "../errors";
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
	shouldInspectRawSyncPath,
	getDirectory,
	hasPortablePathCollision,
	getAncestorDirectories,
	assertForcePath,
	isForceSourcePath,
	preservesForceLocalPath,
	containsForceLocalPreservedPath,
} from "../utils/path-utils";
import { logger } from "../utils/logger";
import { runWithConcurrency } from "../utils/semaphore";

export interface LocalWriteGuard {
	expectedSha256: string | null;
	validateBeforeWrite?: () => Promise<void>;
	beforeWrite?: () => void;
}

export class LocalFileChangedError extends Error {
	constructor() {
		super("Local file changed; reconciliation required");
	}
}

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

	/** Include unsynchronized files and empty folders when validating a write. */
	getLocalPathEntries(): { files: string[]; folders: string[] } {
		const files: string[] = [];
		const folders: string[] = [];
		for (const entry of this.vault.getAllLoadedFiles()) {
			if (!entry.path || entry.path === "/") {
				continue;
			}
			(entry instanceof TFolder ? folders : files).push(entry.path);
		}
		return { files, folders };
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

	/** Apply shared raw-path protection before attempting filename decryption. */
	shouldInspectRaw(path: string, encrypted: boolean): boolean {
		return shouldInspectRawSyncPath(
			path,
			this.settings.syncPatterns,
			this.settings.excludePatterns,
			this.settings.syncDotObsidian,
			this.app.vault.configDir,
			encrypted,
		);
	}

	/** Walk actual storage, including hidden configuration and empty directories. */
	async getForceTree(
		source: boolean,
	): Promise<{ files: string[]; directories: string[] }> {
		const files: string[] = [];
		const directories: string[] = [];
		const visit = async (directory: string) => {
			const listed = await this.vault.adapter.list(directory);
			for (const path of [...listed.files, ...listed.folders]) {
				assertForcePath(path);
				if (getDirectory(path) !== directory) {
					throw new Error("Force local listing escaped its parent");
				}
				if (
					source
						? !isForceSourcePath(path, this.vault.configDir)
						: preservesForceLocalPath(path, this.vault.configDir)
				) {
					continue;
				}
				if (listed.folders.includes(path)) {
					directories.push(path);
					await visit(path);
				} else {
					files.push(path);
				}
			}
		};
		await visit("");
		return { files: files.sort(), directories: directories.sort() };
	}

	/** Read hidden storage through the public adapter and loaded files through Vault. */
	async readForceFile(path: string): Promise<ArrayBuffer> {
		assertForcePath(path);
		return this.getFile(path)
			? this.readFile(path)
			: this.vault.adapter.readBinary(path);
	}

	/** Permanently remove a Force destination; never move it to Obsidian trash. */
	async deleteForcePath(
		path: string,
		beforeMutation?: () => Promise<void>,
	): Promise<void> {
		assertForcePath(path);
		if (
			preservesForceLocalPath(path, this.vault.configDir) ||
			containsForceLocalPreservedPath(path, this.vault.configDir)
		) {
			throw new Error(
				"Force cannot delete its preserved local installation",
			);
		}
		const entry = this.vault.getAbstractFileByPath(path);
		if (entry) {
			await beforeMutation?.();
			// eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- Confirmed Force explicitly requires permanent deletion without trash.
			await this.vault.delete(entry, true);
		} else {
			const stat = await this.vault.adapter.stat(path);
			await beforeMutation?.();
			if (stat?.type === "folder") {
				await this.vault.adapter.rmdir(path, true);
			} else if (stat) {
				await this.vault.adapter.remove(path);
			}
		}
	}

	/** Make a literal Force directory, replacing a file occupying that path. */
	async createForceDirectory(
		path: string,
		beforeMutation?: () => Promise<void>,
	): Promise<void> {
		for (const directory of [...getAncestorDirectories([path])]
			.reverse()
			.concat(path)) {
			assertForcePath(directory);
			const stat = await this.vault.adapter.stat(directory);
			if (stat?.type === "file") {
				await this.deleteForcePath(directory, beforeMutation);
			}
			if (!stat || stat.type === "file") {
				await beforeMutation?.();
				await this.vault.adapter.mkdir(directory);
			}
		}
	}

	/** Write directly to the final Force path without snapshots or protective copies. */
	async writeForceFile(
		path: string,
		content: ArrayBuffer,
		beforeMutation?: () => Promise<void>,
	): Promise<void> {
		assertForcePath(path);
		if (
			preservesForceLocalPath(path, this.vault.configDir) ||
			containsForceLocalPreservedPath(path, this.vault.configDir)
		) {
			throw new Error(
				"Force source collides with its local installation",
			);
		}
		const parent = getDirectory(path);
		if (parent) {
			await this.createForceDirectory(parent, beforeMutation);
		}
		if ((await this.vault.adapter.stat(path))?.type === "folder") {
			await this.deleteForcePath(path, beforeMutation);
		}
		const file = this.getFile(path);
		await beforeMutation?.();
		if (file) {
			await this.vault.modifyBinary(file, content);
		} else if (!path.split("/").some((part) => part.startsWith("."))) {
			await this.vault.createBinary(path, content);
		} else {
			await this.vault.adapter.writeBinary(path, content);
		}
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
	 * Write file
	 */
	async writeFile(
		path: string,
		content: ArrayBuffer | string,
		guard?: LocalWriteGuard,
	): Promise<void> {
		const normalizedPath = normalizePath(path);

		// Ensure folder exists
		const dir = getDirectory(normalizedPath);
		if (dir && !this.folderExists(dir)) {
			await this.createFolderRecursive(dir);
		}

		if (guard) {
			await guard.validateBeforeWrite?.();
			await this.assertLocalIdentity(
				normalizedPath,
				guard.expectedSha256,
			);
			const entries = this.getLocalPathEntries();
			if (
				hasPortablePathCollision(
					[normalizedPath, ...entries.files],
					entries.folders,
				)
			) {
				throw new Error("Portable local path collision");
			}
		}
		const existingFile = this.getFile(normalizedPath);
		if (
			guard &&
			(guard.expectedSha256 === null ? existingFile : !existingFile)
		) {
			throw new LocalFileChangedError();
		}
		guard?.beforeWrite?.();

		if (existingFile) {
			if (typeof content === "string") {
				await this.vault.modify(existingFile, content);
			} else {
				await this.vault.modifyBinary(existingFile, content);
			}
		} else {
			try {
				if (typeof content === "string") {
					await this.vault.create(normalizedPath, content);
				} else {
					await this.vault.createBinary(normalizedPath, content);
				}
			} catch (error) {
				if (
					guard?.expectedSha256 === null &&
					this.fileExists(normalizedPath)
				) {
					throw new LocalFileChangedError();
				}
				throw error;
			}
		}

		logger.debug(`Written file: ${normalizedPath}`);
	}

	/** Revalidate the local snapshot after asynchronous preparation. */
	async assertLocalIdentity(
		path: string,
		expectedSha256: string | null,
	): Promise<void> {
		const actual = this.fileExists(path)
			? await computeSha256(await this.readFile(path))
			: null;
		if (actual !== expectedSha256) {
			throw new LocalFileChangedError();
		}
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
	 * Walk up from a deleted file's directory and trash each ancestor folder
	 * that has become completely empty (no files and no subfolders). Stops at
	 * the first non-empty ancestor, at the vault root, or at the Obsidian
	 * config directory. Only folders that contain nothing are removed, so a
	 * folder holding local-only or excluded files is never touched. Trashed
	 * folders are recoverable from the system trash. Mirrors the remote
	 * remote folder pruning behavior so the local and remote
	 * folder trees stay consistent after deletions.
	 */
	async pruneEmptyLocalAncestors(
		filePath: string,
		canPrune?: (path: string) => boolean,
	): Promise<void> {
		const configDir = this.app.vault.configDir;
		let dir = getDirectory(normalizePath(filePath));
		while (dir) {
			if (dir === configDir || (canPrune && !canPrune(dir))) {
				break;
			}
			const folder = this.getFolder(dir);
			if (!folder) {
				break;
			}
			if (folder.children.length > 0) {
				break;
			}
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
	 * (including unknown first-sync content and Force remote), so unsaved local edits are never silently lost. The backup is
	 * flattened into a single file with a timestamp to avoid nested folder
	 * creation and to keep it out of the sync scope.
	 */
	async backupOverwrittenFile(
		originalPath: string,
		content: ArrayBuffer,
	): Promise<string> {
		try {
			const configDir = this.app.vault.configDir;
			const ts = new Date().toISOString().replace(/[:.]/g, "-");
			const safeName = originalPath.replace(/[\\/]+/g, "__");
			const backupName = `${safeName}_${ts}_${crypto.randomUUID()}`;
			const backupPath = obsidianNormalize(
				`${configDir}/plugins/yandex-disk-sync/overwritten/${backupName}`,
			);
			const backupDir = getDirectory(backupPath);
			if (backupDir) {
				await this.ensureAdapterDirectory(backupDir);
			}
			await this.vault.adapter.writeBinary(backupPath, content);
			const backupStat = await this.vault.adapter.stat(backupPath);
			if (
				!backupStat ||
				backupStat.type !== "file" ||
				backupStat.size !== content.byteLength
			) {
				throw new Error("Written backup could not be verified by size");
			}
			logger.info(`Backed up overwritten local file to: ${backupPath}`);
			return backupPath;
		} catch (error) {
			const failure = new OperationFailure(
				error,
				{
					stage: "protective-backup",
					path: originalPath,
					action: "local",
					outcome: "stopped-before-write",
				},
				{ category: "safety", code: "mandatory-backup-failed" },
			);
			logger.warn("Mandatory protective backup failed", {
				error: failure,
			});
			throw failure;
		}
	}

	/**
	 * Remove backup files under `overwritten/` older than `maxAgeDays`. Called
	 * once at plugin load to keep the backup directory from growing without
	 * bound. Each backup is trashed (recoverable) and counted. Errors per-file
	 * are logged and skipped so one bad file doesn't abort the whole sweep.
	 */
	async cleanupOldBackups(
		maxAgeDays = 30,
		assertActive: () => void = () => {},
	): Promise<number> {
		assertActive();
		const configDir = this.app.vault.configDir;
		const backupDir = obsidianNormalize(
			`${configDir}/plugins/yandex-disk-sync/overwritten`,
		);
		if (!(await this.vault.adapter.exists(backupDir))) {
			return 0;
		}

		const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
		let removed = 0;
		const listed = await this.vault.adapter.list(backupDir);
		for (const backupPath of listed.files) {
			assertActive();
			try {
				const stat = await this.vault.adapter.stat(backupPath);
				assertActive();
				if (stat?.type === "file" && stat.mtime < cutoff) {
					if (await this.vault.adapter.trashSystem(backupPath)) {
						removed++;
					} else {
						logger.warn(
							`System trash is unavailable; preserving stale backup ${backupPath}`,
						);
					}
				}
			} catch (e) {
				logger.warn(`Failed to remove stale backup ${backupPath}:`, {
					error: e,
				});
			}
		}
		assertActive();
		if (removed > 0) {
			logger.info(
				`Cleaned up ${removed} stale overwritten-file backup(s) older than ${maxAgeDays}d`,
			);
		}
		return removed;
	}

	/**
	 * Create a physical vault directory without relying on the Vault cache.
	 * Hidden config folders are not guaranteed to be represented as TFolder.
	 */
	private async ensureAdapterDirectory(path: string): Promise<void> {
		const parts = obsidianNormalize(path).split("/");
		let currentPath = "";
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			if (await this.vault.adapter.exists(currentPath)) {
				continue;
			}
			try {
				await this.vault.adapter.mkdir(currentPath);
			} catch (error) {
				if (!(await this.vault.adapter.exists(currentPath))) {
					throw error;
				}
			}
		}
	}

	/**
	 * Get metadata of synchronizable files; strict snapshots fail on any unreadable file.
	 */
	async getAllFileMetadata(
		failOnReadError = false,
	): Promise<Map<string, FileMetadata>> {
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
				if (failOnReadError) {
					throw e;
				}
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
}
