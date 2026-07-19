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

	/**
	 * Content fingerprint (Yandex-provided md5/sha256) of the remote index
	 * resource as observed at the last {@link loadRemoteIndex} call. Used by
	 * {@link saveRemoteIndex} to detect a concurrent write by another device
	 * between load and save (optimistic locking, since the Yandex REST API
	 * does not expose conditional PUT). undefined when no remote index existed
	 * at load time, or after the index has been (re)created locally.
	 */
	private remoteIndexFingerprint: string | null = null;

	constructor(
		yandexClient: YandexDiskClient,
		vaultAdapter: VaultAdapter,
		settings: YandexDiskSyncSettings,
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
		if (
			data &&
			(data.version === CURRENT_INDEX_VERSION || data.version === 1)
		) {
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
			REMOTE_INDEX_FILENAME,
		);

		try {
			logger.debug(
				"[loadRemoteIndex] Fetching resource metadata (raw)...",
			);
			const resource = await this.yandexClient.getResource(
				indexPath,
				1000,
				0,
				true,
			);
			if (!resource) {
				logger.info("Remote index not found, creating new one");
				this.remoteIndex = createEmptyIndex("");
				this.remoteIndexFingerprint = null;
				return this.remoteIndex;
			}

			// Record the server-side content fingerprint so saveRemoteIndex can
			// detect a concurrent modification by another device between load
			// and save. Prefer md5 (always present for files), fall back to
			// sha256, then resource_id.
			this.remoteIndexFingerprint =
				resource.md5 || resource.sha256 || resource.resource_id || null;

			logger.debug(
				"[loadRemoteIndex] Downloading index content...",
			);
			// Choose the download mode that matches the expected index format:
			// when encryption is active the index is stored encrypted (raw=false
			// decrypts the content); when encryption is inactive the index is
			// stored as plaintext (raw=true skips decryption). This avoids a
			// wasteful fallback round-trip in the common case. The fallback
			// below handles transition/migration scenarios where the index
			// format does not yet match the expected one.
			const encActive = this.yandexClient.hasEncryptionService();
			let content = await this.yandexClient.downloadFile(
				indexPath,
				!encActive,
			);
			let jsonStr = new TextDecoder().decode(content);
			logger.debug("[loadRemoteIndex] Parsing JSON...");
			let data: Partial<SyncIndex>;
			try {
				data = JSON.parse(jsonStr) as Partial<SyncIndex>;
			} catch {
				// The index format does not match the expectation: either the
				// index is encrypted but we tried plaintext, or vice-versa
				// (e.g. encryption was just enabled/disabled and the index
				// hasn't been rewritten yet). Try the opposite mode.
				logger.debug(
					"[loadRemoteIndex] Parse failed, retrying with opposite mode...",
				);
				content = await this.yandexClient.downloadFile(
					indexPath,
					encActive,
				);
				jsonStr = new TextDecoder().decode(content);
				data = JSON.parse(jsonStr) as Partial<SyncIndex>;
			}

			if (data.version === CURRENT_INDEX_VERSION || data.version === 1) {
				this.remoteIndex = {
					version: data.version,
					lastSyncTime: data.lastSyncTime || 0,
					deviceId: data.deviceId || "",
					files: data.files || {},
				};
			} else {
				logger.warn("Remote index version mismatch, resetting");
				this.remoteIndex = createEmptyIndex("");
				this.remoteIndexFingerprint = null;
			}

			logger.info(
				`Loaded remote index: ${
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
	 * Save remote index to Yandex Disk
	 */
	async saveRemoteIndex(): Promise<void> {
		const indexPath = joinPath(
			this.settings.remotePath,
			REMOTE_INDEX_FILENAME,
		);

		this.remoteIndex.version = CURRENT_INDEX_VERSION;
		this.remoteIndex.lastSyncTime = Date.now();
		this.remoteIndex.deviceId = this.settings.deviceId;

		const jsonStr = JSON.stringify(this.remoteIndex, null, 2);

		// Optimistic concurrency control: re-fetch the remote index resource
		// just before writing and verify its fingerprint matches the one we
		// observed at load time. If another device wrote a newer index in
		// between, abort with RemoteIndexConcurrentModificationError so the
		// caller can reload and re-resolve instead of silently overwriting
		// (which would lose the other device's updates). This works regardless
		// of the remote plugin version since it relies on Yandex-provided
		// content hashes, not any field the plugin itself writes.
		if (this.remoteIndexFingerprint !== null) {
			const current = await this.yandexClient.getResource(
				indexPath,
				1000,
				0,
				true,
			);
			if (current) {
				const currentFingerprint =
					current.md5 ||
					current.sha256 ||
					current.resource_id ||
					null;
				if (
					currentFingerprint !== null &&
					currentFingerprint !== this.remoteIndexFingerprint
				) {
					throw new RemoteIndexConcurrentModificationError(
						"Remote index was modified by another device during synchronization",
					);
				}
			}
			// If current is null, the index disappeared (another device deleted
			// it or we are in a transition). Proceed to recreate it.
		}

		// raw=false so that when encryption is active the index content is
		// encrypted (the index stores plaintext file paths which would leak
		// the vault structure if uploaded as plaintext). When encryption is
		// inactive, `encryptContent` returns the bytes unchanged, so
		// unencrypted vaults still get a plaintext index. The index path
		// itself stays plaintext because `isProtectedPath` short-circuits
		// `encryptFilePath`, keeping the file findable by all devices.
		await this.yandexClient.uploadFile(indexPath, jsonStr, true, false);

		// Re-fetch the resource so we have the authoritative server fingerprint
		// for the content we just wrote. This lets a subsequent save in the same
		// session still detect concurrent writes by other devices. Best-effort:
		// if the fetch fails we clear the fingerprint and lose within-session
		// detection, but never block the save.
		try {
			const written = await this.yandexClient.getResource(
				indexPath,
				1000,
				0,
				true,
			);
			this.remoteIndexFingerprint = written
				? written.md5 || written.sha256 || written.resource_id || null
				: null;
		} catch (e) {
			logger.warn(
				"Failed to re-read remote index fingerprint after save:",
				{ error: e },
			);
			this.remoteIndexFingerprint = null;
		}

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
		const meta = this.localIndex.files[path];
		if (!meta) return;
		if (!meta.deleted) {
			meta.deleted = true;
			meta.deletedAt = Date.now();
		}
		meta.lastModifiedBy = this.settings.deviceId;
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
		logger.info(
			`[IndexManager] Seeded local index with ${added} entries from remote`,
		);
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
	 * Stamp `remoteMtime` on remote index entries that are missing it, using
	 * the server-side mtime carried by a freshly-read remote file listing.
	 *
	 * Used as a batch replacement for per-upload `fetchServerMtime`: the bulk
	 * upload path writes remote index entries without `remoteMtime`, then the
	 * sync engine performs a single `getRemoteFiles` call and passes the
	 * result here. Entries that already carry a `remoteMtime` (e.g. written by
	 * a single-file upload path) are left untouched. Entries whose path is
	 * absent from `remoteFiles` (e.g. the file was deleted between upload and
	 * re-read) keep `remoteMtime` undefined and fall back to the legacy
	 * mixed-clock comparison, which is safe.
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
	markRemoteFileDeleted(path: string): void {
		const meta = this.remoteIndex.files[path];
		if (!meta) return;
		// Only stamp the deletion time on the first transition to deleted.
		// Re-stamping would reset the 7-day cleanup TTL and lose the original
		// deletion timestamp recorded by whichever device deleted first.
		if (!meta.deleted) {
			meta.deleted = true;
			meta.deletedAt = Date.now();
		}
		meta.lastModifiedBy = this.settings.deviceId;
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
			this.settings.remotePath,
		);

		const result = new Map<string, FileMetadata>();

		for (const resource of resources) {
			// Skip directories
			if (resource.type !== "file") {
				continue;
			}

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
		const now = Date.now();
		this.localIndex.lastSyncTime = now;
		this.remoteIndex.lastSyncTime = now;
	}

	/**
	 * Clean up deleted files older than specified age.
	 * Returns true when at least one tombstone was removed (i.e. the indexes
	 * changed and callers should persist them).
	 */
	cleanupDeletedFiles(maxAge: number = 7 * 24 * 60 * 60 * 1000): boolean {
		const now = Date.now();
		let changed = false;

		for (const [path, meta] of Object.entries(this.localIndex.files)) {
			if (
				meta.deleted &&
				meta.deletedAt &&
				now - meta.deletedAt > maxAge
			) {
				delete this.localIndex.files[path];
				changed = true;
			}
		}

		for (const [path, meta] of Object.entries(this.remoteIndex.files)) {
			if (
				meta.deleted &&
				meta.deletedAt &&
				now - meta.deletedAt > maxAge
			) {
				delete this.remoteIndex.files[path];
				changed = true;
			}
		}

		return changed;
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
	 * Check if remote index file exists
	 */
	async remoteIndexExists(): Promise<boolean> {
		const indexPath = joinPath(
			this.settings.remotePath,
			REMOTE_INDEX_FILENAME,
		);
		const resource = await this.yandexClient.getResource(
			indexPath,
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
		try {
			const resource = await this.yandexClient.getResource(
				this.getEncryptionManifestPath(),
				1000,
				0,
				true,
			);
			if (!resource) return null;

			const content = await this.yandexClient.downloadFile(
				this.getEncryptionManifestPath(),
				true,
			);
			const data = JSON.parse(
				new TextDecoder().decode(content),
			) as Record<string, unknown>;
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
			true,
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
				true,
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
				this.settings.remotePath,
			);
			if (isProtectedPath(localPath)) {
				continue;
			}

			result.push(localPath);
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

/**
 * Thrown by {@link IndexManager.saveRemoteIndex} when the remote index resource
 * changed on Yandex Disk between the load and the save of the current sync
 * run. Callers should abort, reload the remote index, and re-resolve
 * operations instead of overwriting the newer remote index.
 */
export class RemoteIndexConcurrentModificationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RemoteIndexConcurrentModificationError";
	}
}
