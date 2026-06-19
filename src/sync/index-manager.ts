/**
 * Synchronization index manager
 */

import type {
	SyncIndex,
	FileMetadata,
	YandexDiskSyncSettings,
	YandexResource,
	EncryptionManifest,
	EncryptionManifestState,
	RemoteEncryptionManifest,
} from "../types";
import { CURRENT_INDEX_VERSION, createEmptyIndex } from "../types";
import { YandexApiError, YandexDiskClient } from "../api/yandex-client";
import { VaultAdapter } from "../api/vault-adapter";
import { isProtectedPath, joinPath, toLocalPath } from "../utils/path-utils";
import { logger } from "../utils/logger";
import {
	PBKDF2_ITERATIONS,
	AES_KEY_LENGTH,
	IV_LENGTH,
} from "../crypto/encryption";

const REMOTE_INDEX_FILENAME = ".obsidian-sync-index.json";
const ENCRYPTION_MANIFEST_FILENAME = ".obsidian-encrypt.json";
const ENCRYPTION_MANIFEST_STATES: EncryptionManifestState[] = [
	"enabled",
	"enabling",
	"rotating",
	"disabling",
];

export class IndexManager {
	private yandexClient: YandexDiskClient;
	private vaultAdapter: VaultAdapter;
	private settings: YandexDiskSyncSettings;

	private localIndex: SyncIndex;
	private remoteIndex: SyncIndex;

	constructor(
		yandexClient: YandexDiskClient,
		vaultAdapter: VaultAdapter,
		settings: YandexDiskSyncSettings
	) {
		this.yandexClient = yandexClient;
		this.vaultAdapter = vaultAdapter;
		this.settings = settings;
		this.localIndex = createEmptyIndex(settings.deviceId);
		this.remoteIndex = createEmptyIndex("");
	}

	/**
	 * Update settings
	 */
	updateSettings(settings: YandexDiskSyncSettings): void {
		this.settings = settings;
	}

	/**
	 * Get local index
	 */
	getLocalIndex(): SyncIndex {
		return this.localIndex;
	}

	/**
	 * Get remote index
	 */
	getRemoteIndex(): SyncIndex {
		return this.remoteIndex;
	}

	/**
	 * Load local index from saved plugin data
	 */
	loadLocalIndexFromData(data: Partial<SyncIndex> | null): void {
		if (data && (data.version === CURRENT_INDEX_VERSION || data.version === 1)) {
			this.localIndex = {
				version: CURRENT_INDEX_VERSION,
				lastSyncTime: data.lastSyncTime || 0,
				deviceId: data.deviceId || this.settings.deviceId,
				files: data.files || {},
			};
		} else {
			this.localIndex = createEmptyIndex(this.settings.deviceId);
		}
	}

	/**
	 * Get local index data for saving
	 */
	getLocalIndexData(): SyncIndex {
		return this.localIndex;
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
	async loadRemoteIndex(): Promise<SyncIndex> {
		const indexPath = joinPath(
			this.settings.remotePath,
			REMOTE_INDEX_FILENAME
		);

		try {
			const resource = await this.yandexClient.getResource(indexPath);
			if (!resource) {
				logger.info("Remote index not found, creating new one");
				this.remoteIndex = createEmptyIndex("");
				return this.remoteIndex;
			}

			const content = await this.yandexClient.downloadFile(indexPath);
			const decoder = new TextDecoder();
			const jsonStr = decoder.decode(content);
			const data = JSON.parse(jsonStr) as Partial<SyncIndex>;

			if (data.version === CURRENT_INDEX_VERSION || data.version === 1) {
				this.remoteIndex = {
					version: data.version,
					lastSyncTime: data.lastSyncTime || 0,
					deviceId: data.deviceId || "",
					files: data.files || {},
				};
			} else {
				logger.warn(
					"Remote index version mismatch, resetting"
				);
				this.remoteIndex = createEmptyIndex("");
			}

			logger.info(
				`Loaded remote index: ${Object.keys(this.remoteIndex.files).length
				} files`
			);
			return this.remoteIndex;
		} catch (e) {
			logger.warn("Error loading remote index:", { error: e });
			throw e;
		}
	}

	/**
	 * Save remote index to Yandex Disk
	 */
	async saveRemoteIndex(): Promise<void> {
		const indexPath = joinPath(
			this.settings.remotePath,
			REMOTE_INDEX_FILENAME
		);

		this.remoteIndex.version = CURRENT_INDEX_VERSION;
		this.remoteIndex.lastSyncTime = Date.now();
		this.remoteIndex.deviceId = this.settings.deviceId;

		const jsonStr = JSON.stringify(this.remoteIndex, null, 2);
		await this.yandexClient.uploadFile(indexPath, jsonStr);

		logger.info("Remote index saved");
	}

	/**
	 * Update file metadata in local index
	 */
	updateLocalFile(path: string, metadata: FileMetadata): void {
		this.localIndex.files[path] = {
			...metadata,
			lastModifiedBy: this.settings.deviceId,
		};
	}

	/**
	 * Mark file as deleted in local index
	 */
	markLocalFileDeleted(path: string): void {
		if (this.localIndex.files[path]) {
			this.localIndex.files[path].deleted = true;
			this.localIndex.files[path].deletedAt = Date.now();
			this.localIndex.files[path].lastModifiedBy = this.settings.deviceId;
		}
	}

	/**
	 * Remove file from local index
	 */
	removeFromLocalIndex(path: string): void {
		delete this.localIndex.files[path];
	}

	/**
	 * Seed local index from the currently loaded remote index.
	 * Called after connecting to an already-encrypted remote vault so the sync
	 * engine knows which files exist remotely. Without this, subsequent local
	 * deletions resolve to localIndexMeta=null and are mis-classified as
	 * "new remote files" (Case 2 in conflict resolver) instead of deletions.
	 * Only adds entries that are absent from localIndex; existing entries are
	 * not overwritten.
	 */
	seedLocalIndexFromRemote(): void {
		let added = 0;
		for (const [path, meta] of Object.entries(this.remoteIndex.files)) {
			if (meta.deleted) continue;
			if (this.localIndex.files[path]) continue;
			this.localIndex.files[path] = {
				...meta,
				lastModifiedBy: this.settings.deviceId,
			};
			added++;
		}
		logger.info(`[IndexManager] Seeded local index with ${added} entries from remote`);
	}

	/**
	 * Update file metadata in remote index
	 */
	updateRemoteFile(path: string, metadata: FileMetadata): void {
		this.remoteIndex.files[path] = {
			...metadata,
			lastModifiedBy: this.settings.deviceId,
		};
	}

	/**
	 * Mark file as deleted in remote index
	 */
	markRemoteFileDeleted(path: string): void {
		if (this.remoteIndex.files[path]) {
			this.remoteIndex.files[path].deleted = true;
			this.remoteIndex.files[path].deletedAt = Date.now();
			this.remoteIndex.files[path].lastModifiedBy =
				this.settings.deviceId;
		}
	}

	/**
	 * Remove file from remote index
	 */
	removeFromRemoteIndex(path: string): void {
		delete this.remoteIndex.files[path];
	}

	/**
	 * Get files list from remote storage
	 */
	async getRemoteFiles(): Promise<Map<string, FileMetadata>> {
		logger.info("Getting remote files list...");

		const resources = await this.yandexClient.getResourcesRecursive(
			this.settings.remotePath
		);

		const result = new Map<string, FileMetadata>();

		for (const resource of resources) {
			// Skip directories
			if (resource.type !== "file") {
				continue;
			}

			const localPath = toLocalPath(
				resource.path,
				this.settings.remotePath
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
				size: resource.size || 0,
				mtime,
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
		const now = Date.now();
		this.localIndex.lastSyncTime = now;
		this.remoteIndex.lastSyncTime = now;
	}

	/**
	 * Clean up deleted files older than specified age
	 */
	cleanupDeletedFiles(maxAge: number = 7 * 24 * 60 * 60 * 1000): void {
		const now = Date.now();

		for (const [path, meta] of Object.entries(this.localIndex.files)) {
			if (
				meta.deleted &&
				meta.deletedAt &&
				now - meta.deletedAt > maxAge
			) {
				delete this.localIndex.files[path];
			}
		}

		for (const [path, meta] of Object.entries(this.remoteIndex.files)) {
			if (
				meta.deleted &&
				meta.deletedAt &&
				now - meta.deletedAt > maxAge
			) {
				delete this.remoteIndex.files[path];
			}
		}
	}

	/**
	 * Check if remote folder exists
	 */
	async remotePathExists(): Promise<boolean> {
		const resource = await this.yandexClient.getResource(
			this.settings.remotePath
		);
		return resource !== null;
	}

	/**
	 * Check if remote index file exists
	 */
	async remoteIndexExists(): Promise<boolean> {
		const indexPath = joinPath(
			this.settings.remotePath,
			REMOTE_INDEX_FILENAME
		);
		const resource = await this.yandexClient.getResource(indexPath);
		return resource !== null;
	}

	/**
	 * Create remote folder
	 */
	async createRemotePath(): Promise<void> {
		await this.yandexClient.createFolderRecursive(this.settings.remotePath);
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
	async uploadEncryptionManifest(manifest: EncryptionManifest): Promise<void> {
		const content = JSON.stringify(manifest, null, 2);
		await this.yandexClient.uploadFile(
			this.getEncryptionManifestPath(),
			content,
			false,
			true
		);
		logger.info("Encryption manifest uploaded to remote");
	}

	/**
	 * Download encryption manifest from Yandex Disk (raw — no decryption).
	 * Returns null only if manifest file doesn't exist.
	 */
	async downloadEncryptionManifest(): Promise<RemoteEncryptionManifest | null> {
		try {
			const resource = await this.yandexClient.getResource(
				this.getEncryptionManifestPath(),
				1000,
				0,
				true
			);
			if (!resource) return null;

			const content = await this.yandexClient.downloadFile(
				this.getEncryptionManifestPath(),
				true
			);
			const data = JSON.parse(new TextDecoder().decode(content)) as Record<string, unknown>;
			return this.parseEncryptionManifest(data);
		} catch (e) {
			if (this.isNotFoundError(e)) {
				return null;
			}
			throw e;
		}
	}

	/**
	 * Delete encryption manifest from Yandex Disk.
	 */
	async deleteEncryptionManifest(): Promise<void> {
		await this.yandexClient.deleteResource(
			this.getEncryptionManifestPath(),
			false,
			true
		);
		logger.info("Encryption manifest deleted from remote");
	}

	/**
	 * Get raw remote user file paths without decrypting filenames.
	 */
	async getRemoteRawFilePaths(): Promise<string[]> {
		let resources: YandexResource[];
		try {
			resources = await this.yandexClient.getResourcesRecursive(
				this.settings.remotePath,
				true
			);
		} catch (e) {
			if (this.isNotFoundError(e)) {
				return [];
			}
			throw e;
		}
		const result: string[] = [];

		for (const resource of resources) {
			if (resource.type !== "file") {
				continue;
			}

			const localPath = toLocalPath(
				resource.path,
				this.settings.remotePath
			);
			if (isProtectedPath(localPath)) {
				continue;
			}

			result.push(localPath);
		}

		return result;
	}

	private parseEncryptionManifest(data: Record<string, unknown>): RemoteEncryptionManifest {
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

		if (typeof state !== "string" || !this.isEncryptionManifestState(state)) {
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
		};
	}

	private isEncryptionManifestState(value: string): value is EncryptionManifestState {
		return ENCRYPTION_MANIFEST_STATES.includes(value as EncryptionManifestState);
	}

	private isNotFoundError(e: unknown): boolean {
		return e instanceof YandexApiError && e.status === 404;
	}
}
