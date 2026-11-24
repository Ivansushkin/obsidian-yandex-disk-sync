import { ForceScopeConflictError } from "../force-errors";
import { OperationFailure, ConcurrentSyncChangeError } from "../errors";
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
	isVaultTrashPath,
	preservesForceLocalPath,
	containsForceLocalPreservedPath,
} from "../utils/path-utils";
import { logger } from "../utils/logger";
import { runWithConcurrency } from "../utils/semaphore";

export interface LocalWriteGuard {
	expectedSha256: string | null;
	validateBeforeWrite?: () => Promise<void>;
	beforeWrite?: () => void | (() => void);
}

export class LocalFileChangedError extends ConcurrentSyncChangeError {
	constructor() {
		super("Local file changed; reconciliation required");
	}
}

export class VaultAdapter {
	private app: App;
	private settings: YandexDiskSyncSettings;
	private localObservationReader?: (paths: readonly string[]) => number;

	/** Reuse the lifecycle-owned watcher instead of registering a second observer. */
	setLocalObservationReader(
		read: (paths: readonly string[]) => number,
	): void {
		this.localObservationReader = read;
	}

	/** Reject local events admitted while asynchronous safety checks were running. */
	captureLocalObservation(paths: readonly string[]): () => void {
		const revision = this.localObservationReader?.(paths);
		return () => {
			if (revision !== this.localObservationReader?.(paths)) {
				throw new LocalFileChangedError();
			}
		};
	}

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
			if (
				!entry.path ||
				entry.path === "/" ||
				isVaultTrashPath(entry.path)
			) {
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
		inspect: (path: string, directory: boolean) => boolean = () => true,
		root = "",
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
				if (!inspect(path, listed.folders.includes(path))) {
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
		await visit(root);
		return { files: files.sort(), directories: directories.sort() };
	}

	/** Read hidden storage through the public adapter and loaded files through Vault. */
	async readForceFile(path: string): Promise<ArrayBuffer> {
		assertForcePath(path);
		return this.getFile(path)
			? this.readFile(path)
			: this.vault.adapter.readBinary(path);
	}

	/** Delete a visible replacement target using Obsidian's deletion preference. */
	async deleteForcePath(
		path: string,
		beforeMutation?: () => Promise<void | (() => void)>,
		observe?: () => void | (() => void),
	): Promise<void> {
		assertForcePath(path);
		if (
			preservesForceLocalPath(path, this.vault.configDir) ||
			containsForceLocalPreservedPath(path, this.vault.configDir)
		) {
			throw new ForceScopeConflictError();
		}
		const entry = this.vault.getAbstractFileByPath(path);
		const assertObserved = this.captureLocalObservation([path]);
		const assertPrepared = await beforeMutation?.();
		const stat = await this.vault.adapter.stat(path);
		if (
			entry &&
			(!stat || (stat.type === "folder") !== entry instanceof TFolder)
		) {
			throw new LocalFileChangedError();
		}
		if (entry instanceof TFolder) {
			const tree = await this.getForceTree(false, undefined, path);
			if (
				[...tree.files, ...tree.directories].some(
					(child) => !this.vault.getAbstractFileByPath(child),
				)
			) {
				throw new ForceScopeConflictError();
			}
		}
		if (
			this.vault.getAbstractFileByPath(path) !== entry ||
			(entry && entry.path !== path)
		) {
			throw new LocalFileChangedError();
		}
		(assertPrepared ?? assertObserved)();
		if (!entry) {
			if (stat) {
				throw new ForceScopeConflictError();
			}
			return;
		}
		await this.observeMutation(
			() => this.app.fileManager.trashFile(entry),
			observe,
		);
		if (await this.vault.adapter.exists(path)) {
			throw new Error("Local replacement deletion was not confirmed");
		}
	}

	/** Make a Force directory only after explicit deletion has removed its blockers. */
	async createForceDirectory(
		path: string,
		beforeMutation?: () => void,
	): Promise<void> {
		if (preservesForceLocalPath(path, this.vault.configDir)) {
			throw new ForceScopeConflictError();
		}
		for (const directory of [...getAncestorDirectories([path])]
			.reverse()
			.concat(path)) {
			assertForcePath(directory);
			const stat = await this.vault.adapter.stat(directory);
			if (stat && stat.type !== "folder") {
				throw new ForceScopeConflictError();
			}
			if (!stat) {
				beforeMutation?.();
				await this.vault.adapter.mkdir(directory);
			}
		}
	}

	/** Write directly to the final Force path without snapshots or protective copies. */
	async writeForceFile(
		path: string,
		content: ArrayBuffer,
		beforeMutation?: () => void,
		observe?: () => void | (() => void),
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
		const file = this.getFile(path);
		const assertObserved = this.captureLocalObservation([path]);
		const stat = await this.vault.adapter.stat(path);
		assertObserved();
		if (stat?.type === "folder" || (stat && !file)) {
			throw new ForceScopeConflictError();
		}
		beforeMutation?.();
		await this.observeMutation(async () => {
			if (file) {
				await this.vault.modifyBinary(file, content);
			} else if (!path.split("/").some((part) => part.startsWith("."))) {
				await this.vault.createBinary(path, content);
			} else {
				await this.vault.adapter.writeBinary(path, content);
			}
		}, observe);
	}

	/** Retire the exact event expectation even when native storage rejects a mutation. */
	private async observeMutation<T>(
		mutate: () => Promise<T>,
		observe?: () => void | (() => void),
	): Promise<T> {
		const release = observe?.();
		try {
			return await mutate();
		} finally {
			release?.();
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
			throw new ConcurrentSyncChangeError(`File not found: ${path}`);
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

		let assertObserved: (() => void) | undefined;
		if (guard) {
			await guard.validateBeforeWrite?.();
			assertObserved = this.captureLocalObservation([normalizedPath]);
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
		assertObserved?.();
		await this.observeMutation(async () => {
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
		}, guard?.beforeWrite);

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

	/** Prune empty ancestors non-recursively so a hidden or newly created child survives. */
	async pruneEmptyLocalAncestors(
		filePath: string,
		canPrune?: (path: string) => boolean,
		observe?: (path: string) => void | (() => void),
	): Promise<void> {
		const configDir = this.app.vault.configDir;
		let dir = getDirectory(normalizePath(filePath));
		while (dir) {
			if (dir === configDir || (canPrune && !canPrune(dir))) {
				break;
			}
			const folder = this.getFolder(dir);
			if (!folder || folder.children.length > 0) {
				break;
			}
			try {
				const { files, folders } = await this.vault.adapter.list(dir);
				if (files.length > 0 || folders.length > 0) {
					break;
				}
				await this.observeMutation(
					() => this.vault.adapter.rmdir(dir, false),
					() => observe?.(dir),
				);
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

	/** Preserve ordinary sync's displaced local bytes in the plugin's excluded backup directory. */
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
			const path = file.path;
			try {
				const content = await this.vault.readBinary(file);
				const sha256 = await computeSha256(content);
				if (file.path !== path || this.getFile(path) !== file) {
					throw new LocalFileChangedError();
				}

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
					if (file.path !== path || this.getFile(path) !== file) {
						throw new LocalFileChangedError();
					}
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
