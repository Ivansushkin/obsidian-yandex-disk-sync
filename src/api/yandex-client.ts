/**
 * HTTP client for Yandex Disk API
 */

import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import type {
	YandexResource,
	YandexUploadLink,
	YandexDownloadLink,
	YandexError,
} from "../types";
import type { EncryptionService } from "../crypto/encryption";
import { logger } from "../utils/logger";
import { encodePathForUrl, isProtectedPath, normalizePath } from "../utils/path-utils";
import { runWithConcurrency } from "../utils/semaphore";
import {
	getMatchingStableContentFingerprint,
	getStableContentFingerprint,
} from "../utils/resource-fingerprint";

const API_BASE_URL = "https://cloud-api.yandex.net/v1/disk";

export interface YandexClientConfig {
	token: string;
	maxRetries?: number;
	retryDelay?: number;
}

interface StableRawFileSnapshot {
	raw: ArrayBuffer;
	resource: YandexResource;
	fingerprint: string;
}

type ApiReadCategory = "manifest" | "index" | "root" | "tree" | "other";

export class YandexDiskClient {
	private token: string;
	private maxRetries: number;
	private retryDelay: number;
	private folderCache: Set<string> = new Set();
	private encryptionService: EncryptionService | null = null;
	private remotePath = "";
	private apiReadMetrics: Record<ApiReadCategory, number> = {
		manifest: 0,
		index: 0,
		root: 0,
		tree: 0,
		other: 0,
	};

	constructor(config: YandexClientConfig) {
		this.token = config.token;
		this.maxRetries = config.maxRetries ?? 3;
		this.retryDelay = config.retryDelay ?? 1000;
	}

	/**
	 * Update token
	 */
	setToken(token: string): void {
		this.token = token;
	}

	/**
	 * Set encryption service for transparent encryption/decryption.
	 * Pass null to disable encryption.
	 */
	setEncryptionService(service: EncryptionService | null): void {
		this.encryptionService = service;
	}

	/**
	 * Check whether an encryption service is currently active. Used by callers
	 * (e.g. `IndexManager.loadRemoteIndex`) to choose the optimal download mode
	 * without a wasteful fallback round-trip.
	 */
	hasEncryptionService(): boolean {
		return this.encryptionService !== null;
	}

	/**
	 * Set the remote base path. Required for segment-wise path encryption:
	 * the base path itself is never encrypted (it hosts service files and is
	 * the entry point for traversal), only segments below it are.
	 */
	setRemotePath(remotePath: string): void {
		this.remotePath = normalizePath(remotePath);
	}

	/**
	 * Clear folder cache
	 */
	clearFolderCache(): void {
		this.folderCache.clear();
	}

	/** Return a copy of cumulative API GET counters for session diagnostics. */
	getApiReadMetrics(): Record<ApiReadCategory, number> {
		return { ...this.apiReadMetrics };
	}

	/**
	 * Read a raw service file while proving that its remote content identity
	 * did not change between metadata observations.
	 */
	async downloadStableRawFile(
		path: string,
		expectedResource?: YandexResource,
	): Promise<StableRawFileSnapshot | null> {
		const startedAt = Date.now();
		const before =
			expectedResource ??
			(await this.getResource(path, 1, 0, true));
		if (!before) return null;
		if (!this.getContentFingerprint(before)) {
			throw new Error("Remote service file has no stable content fingerprint");
		}

		const raw = await this.downloadFile(path, true);
		const after = await this.getResource(path, 1, 0, true);
		if (!after) {
			throw new Error("Remote service file disappeared while being read");
		}
		const matchingFingerprint = this.getMatchingContentFingerprint(
			before,
			after,
		);
		const afterFingerprint = this.getContentFingerprint(after);
		if (!matchingFingerprint || !afterFingerprint) {
			throw new Error("Remote service file changed while being read");
		}
		logger.debug("Stable raw service-file read completed", {
			durationMs: Date.now() - startedAt,
			rawSize: raw.byteLength,
		});
		return { raw, resource: after, fingerprint: afterFingerprint };
	}

	/**
	 * Return a content-version fingerprint suitable for guarding service-file
	 * reads. A resource ID alone is intentionally insufficient after overwrite.
	 */
	getContentFingerprint(resource: YandexResource | null): string | null {
		return getStableContentFingerprint(resource);
	}

	private getMatchingContentFingerprint(
		before: YandexResource,
		after: YandexResource,
	): string | null {
		return getMatchingStableContentFingerprint(before, after);
	}

	/**
	 * Check token validity
	 */
	async checkToken(): Promise<boolean> {
		try {
			await this.request("GET", "/");
			return true;
		} catch (e) {
			logger.error("Token validation failed", {
				error: e instanceof Error ? e.message : String(e),
			});
			return false;
		}
	}

	// ============================================================================
	// Encryption helpers
	// ============================================================================

	private async encryptContent(data: ArrayBuffer): Promise<ArrayBuffer> {
		if (!this.encryptionService) return data;
		return this.encryptionService.encrypt(data);
	}

	private async decryptContent(data: ArrayBuffer): Promise<ArrayBuffer> {
		if (!this.encryptionService) return data;
		return this.encryptionService.decrypt(data);
	}

	/**
	 * Encrypt a remote path segment by segment. The base path is left intact;
	 * only the segments below it are encrypted. Protected paths (service files,
	 * backups) are returned unchanged so traversal entry points stay readable.
	 */
	private async encryptFilePath(path: string): Promise<string> {
		if (!this.encryptionService) return path;
		if (isProtectedPath(path)) return path;

		const base = this.remotePath;
		const full = normalizePath(path);
		if (!full || full === base) return path;

		const hasBase = base !== "" && full.startsWith(base + "/");
		const relative = hasBase ? full.slice(base.length + 1) : full;

		const encrypted = await Promise.all(
			relative.split("/").map((seg) => this.encryptionService!.encryptFilename(seg))
		);
		const joined = encrypted.join("/");
		return hasBase ? `${base}/${joined}` : joined;
	}

	private async decryptFileName(name: string): Promise<string> {
		if (!this.encryptionService) return name;
		try {
			return await this.encryptionService.decryptFilename(name);
		} catch {
			return name;
		}
	}

	/**
	 * Decrypt a remote path segment by segment, mirroring encryptFilePath().
	 * Handles the Yandex "disk:/" prefix and leaves the base path and protected
	 * paths intact. Individual segments fall back to their raw value if they are
	 * not valid ciphertext (handled inside decryptFileName).
	 */
	private async decryptFilePath(path: string): Promise<string> {
		if (!this.encryptionService) return path;
		if (isProtectedPath(path)) return path;

		const diskPrefix = path.startsWith("disk:/") ? "disk:/" : "";
		const clean = normalizePath(path.replace(/^disk:\//, ""));
		const base = normalizePath(this.remotePath.replace(/^disk:\//, ""));
		if (!clean || clean === base) return path;

		const hasBase = base !== "" && clean.startsWith(base + "/");
		const relative = hasBase ? clean.slice(base.length + 1) : clean;

		const decrypted = await Promise.all(
			relative.split("/").map((seg) => this.decryptFileName(seg))
		);
		const joined = decrypted.join("/");
		return hasBase ? `${diskPrefix}${base}/${joined}` : `${diskPrefix}${joined}`;
	}

	private async decryptResource(resource: YandexResource): Promise<YandexResource> {
		if (!this.encryptionService) return resource;
		return {
			...resource,
			name: await this.decryptFileName(resource.name),
			path: await this.decryptFilePath(resource.path),
			_embedded: resource._embedded
				? {
						...resource._embedded,
						items: await Promise.all(
							resource._embedded.items.map((item) => this.decryptResource(item))
						),
					}
				: undefined,
		};
	}

	/**
	 * Convert raw Yandex resource metadata to the active logical path.
	 */
	async toLogicalResource(
		resource: YandexResource,
	): Promise<YandexResource> {
		return await this.decryptResource(resource);
	}

	/**
	 * Get resource information (file or folder)
	 */
	async getResource(
		path: string,
		limit = 1000,
		offset = 0,
		raw = false
	): Promise<YandexResource | null> {
		try {
			const encodedPath = encodePathForUrl(path);
			const response = await this.request(
				"GET",
				`/resources?path=${encodedPath}&limit=${limit}&offset=${offset}`
			);
			const resource = response.json as YandexResource;
			if (raw) {
				return resource;
			}
			return await this.decryptResource(resource);
		} catch (e: unknown) {
			if (this.isNotFoundError(e)) {
				return null;
			}
			throw e;
		}
	}

	/**
	 * Get a resource addressed by its logical, unencrypted path.
	 */
	async getLogicalResource(path: string): Promise<YandexResource | null> {
		const target = await this.encryptFilePath(path);
		return await this.getResource(target, 1000, 0, true);
	}

	/**
	 * Resolve a logical path to the physical remote path for transition cleanup.
	 */
	async getPhysicalPath(path: string): Promise<string> {
		return await this.encryptFilePath(path);
	}

	/**
	 * Recursively get all files in folder
	 */
	async getResourcesRecursive(
		path: string,
		raw = false,
		concurrency = 4,
	): Promise<YandexResource[]> {
		const startedAt = Date.now();
		const results: YandexResource[] = [];
		const visited = new Set<string>();
		let level = [path];
		const limit = Math.max(1, Math.min(concurrency, 4));

		while (level.length > 0) {
			const currentLevel = [...new Set(level)]
				.filter((currentPath) => !visited.has(currentPath))
				.sort((left, right) => left.localeCompare(right));
			for (const currentPath of currentLevel) visited.add(currentPath);
			const batches = await runWithConcurrency(
				currentLevel.map((currentPath) => async () =>
					await this.readDirectoryPageSet(currentPath, raw),
				),
				limit,
			);
			level = batches.flatMap((batch) => batch.directories);
			for (const batch of batches) results.push(...batch.files);
		}
		logger.debug("Remote tree traversal completed", {
			folders: visited.size,
			files: results.length,
			concurrency: limit,
			durationMs: Date.now() - startedAt,
		});

		return results.sort((left, right) =>
			(left.path || left.name).localeCompare(right.path || right.name),
		);
	}

	private async readDirectoryPageSet(
		path: string,
		raw: boolean,
	): Promise<{ files: YandexResource[]; directories: string[] }> {
		const files: YandexResource[] = [];
		const directories: string[] = [];
		let offset = 0;
		const limit = 1000;
		while (true) {
			const resource = await this.getResource(path, limit, offset, true);
			if (!resource) break;
			if (resource.type === "file") {
				files.push(raw ? resource : await this.decryptResource(resource));
				break;
			}
			const embedded = resource._embedded;
			if (!embedded) break;
			for (const item of embedded.items) {
				if (item.type === "dir") {
					if (!isProtectedPath(item.path)) directories.push(item.path);
				} else {
					files.push(raw ? item : await this.decryptResource(item));
				}
			}
			if (offset + embedded.items.length >= embedded.total) break;
			offset += limit;
		}
		return { files, directories };
	}

	/**
	 * Create folder
	 */
	async createFolder(path: string): Promise<void> {
		// Check cache first
		if (this.folderCache.has(path)) {
			return;
		}

		const encodedPath = encodePathForUrl(path);
		try {
			await this.request("PUT", `/resources?path=${encodedPath}`);
			this.folderCache.add(path);
			logger.debug(`Created folder: ${path}`);
		} catch (e: unknown) {
			// Ignore error if folder already exists
			if (this.isConflictError(e)) {
				this.folderCache.add(path);
			} else {
				throw e;
			}
		}
	}

	/**
	 * Create folder with parent directories
	 */
	async createFolderRecursive(path: string): Promise<void> {
		const parts = path.split("/").filter(Boolean);
		let currentPath = "";

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			await this.createFolder(currentPath);
		}
	}

	/**
	 * Ensure multiple folders exist (optimized batch creation)
	 */
	async ensureFoldersExist(paths: string[]): Promise<void> {
		// Encrypt folder paths so intermediate levels are created with their
		// encrypted names. Each level is an independently-encrypted segment.
		const effectivePaths = this.encryptionService
			? await Promise.all(paths.map((p) => this.encryptFilePath(p)))
			: paths;

		// Collect all unique folder paths including parent folders
		const allFolders = new Set<string>();

		for (const path of effectivePaths) {
			const parts = path.split("/").filter(Boolean);
			let currentPath = "";

			for (const part of parts) {
				currentPath = currentPath ? `${currentPath}/${part}` : part;
				if (!this.folderCache.has(currentPath)) {
					allFolders.add(currentPath);
				}
			}
		}

		// Sort by depth to create parent folders first
		const sortedFolders = Array.from(allFolders).sort((a, b) => {
			const depthA = a.split("/").length;
			const depthB = b.split("/").length;
			return depthA - depthB;
		});

		// Create folders sequentially by level
		for (const folder of sortedFolders) {
			await this.createFolder(folder);
		}
	}

	/**
	 * Check whether a remote folder is empty (no child resources of any kind).
	 * The path is encrypted segment-wise under encryption so the real remote
	 * folder is inspected. Returns true when the folder does not exist or has
	 * no children. Used by the sync engine before pruning a folder that the
	 * in-memory index believes to be empty, to guard against a stale index
	 * (e.g. written by an older plugin version) wrongly claiming emptiness
	 * and causing the folder's actually-present files to be deleted.
	 */
	async isFolderEmpty(remotePath: string): Promise<boolean> {
		const target = await this.encryptFilePath(remotePath);
		const resource = await this.getResource(target, 1000, 0, true);
		if (!resource) return true;
		const items = resource._embedded?.items ?? [];
		return items.length === 0;
	}

	/**
	 * Check a physical transition-cleanup folder without applying path
	 * encryption.
	 */
	async isRawFolderEmpty(remotePath: string): Promise<boolean> {
		const resource = await this.getResource(
			remotePath,
			1000,
			0,
			true,
		);
		if (!resource) return true;
		return (resource._embedded?.items ?? []).length === 0;
	}

	/**
	 * Get upload link for file
	 */
	async getUploadLink(
		path: string,
		overwrite = true,
		raw = false
	): Promise<YandexUploadLink> {
		const targetPath = raw ? path : await this.encryptFilePath(path);
		const encodedPath = encodePathForUrl(targetPath);
		const response = await this.request(
			"GET",
			`/resources/upload?path=${encodedPath}&overwrite=${overwrite}`
		);
		return response.json as YandexUploadLink;
	}

	/**
	 * Upload file to Yandex Disk.
	 * When `raw` is true, skips content and path encryption (for metadata files).
	 *
	 * When `skipFolderCheck` is true the caller asserts that the parent folder
	 * already exists (preflight ensured it). If the upload then fails anyway —
	 * most commonly because another concurrent sync pruned that folder in the
	 * meantime — we recreate the parent folder and retry the upload once,
	 * instead of failing the operation until the next full sync. Only 404/409
	 * errors trigger the retry; other failures (auth, quota, network, 5xx) are
	 * re-thrown immediately so the real cause isn't masked as a missing folder.
	 */
	async uploadFile(
		remotePath: string,
		content: ArrayBuffer | string,
		skipFolderCheck = false,
		raw = false,
		overwrite = true,
	): Promise<void> {
		// Ensure parent folder exists (if not skipped) — derive the parent from
		// the encrypted target path so encrypted folder segments are created.
		if (!skipFolderCheck) {
			await this.ensureUploadParent(remotePath, raw);
		}

		try {
			await this.putFile(remotePath, content, raw, overwrite);
			logger.debug(`Uploaded file: ${remotePath}`);
			return;
		} catch (e) {
			if (!skipFolderCheck) throw e;
			// Only retry when the failure is consistent with a missing/vanished
			// parent folder (404 not found or 409 conflict). Other errors
			// (auth, quota, network, 5xx) are not caused by a missing folder
			// and would just waste an extra upload attempt while masking the
			// real cause.
			if (
				!(e instanceof YandexApiError) ||
				(e.status !== 404 && e.status !== 409)
			) {
				throw e;
			}
			// The preflight-created parent may have been pruned between preflight
			// and this upload (e.g. another device's fullSync removed the last
			// file in that folder and pruned the empty folder). Recreate the
			// parent and retry once.
			logger.warn(
				`Upload failed for ${remotePath} (skipFolderCheck); recreating parent and retrying once:`,
				{ error: e }
			);
			await this.ensureUploadParent(remotePath, raw);
			await this.putFile(remotePath, content, raw, overwrite);
			logger.debug(`Uploaded file after folder retry: ${remotePath}`);
		}
	}

	/**
	 * Upload a file only when the target path does not already exist.
	 *
	 * The Yandex upload link carries `overwrite=false`, so a competing writer
	 * receives HTTP 409 instead of replacing the existing resource.
	 */
	async uploadFileExclusive(
		remotePath: string,
		content: ArrayBuffer | string,
		skipFolderCheck = false,
		raw = false,
	): Promise<void> {
		await this.uploadFile(
			remotePath,
			content,
			skipFolderCheck,
			raw,
			false,
		);
	}

	/**
	 * Ensure the parent folder of the given target path exists, deriving the
	 * parent from the (optionally encrypted) target path.
	 */
	private async ensureUploadParent(remotePath: string, raw: boolean): Promise<void> {
		const encryptedPath = raw
			? remotePath
			: await this.encryptFilePath(remotePath);
		const parentPath = encryptedPath.substring(
			0,
			encryptedPath.lastIndexOf("/")
		);
		if (parentPath) {
			await this.createFolderRecursive(parentPath);
		}
	}

	/**
	 * Encrypt (unless raw) and PUT the file content to Yandex Disk via the
	 * upload link. Does not perform any folder checks.
	 */
	private async putFile(
		remotePath: string,
		content: ArrayBuffer | string,
		raw: boolean,
		overwrite: boolean,
	): Promise<void> {
		const bytes =
			typeof content === "string"
				? new TextEncoder().encode(content)
				: new Uint8Array(content);

		const bodyContent = raw
			? bytes.buffer
			: await this.encryptContent(bytes.buffer);

		// Get upload link with optionally encrypted path
		const uploadLink = await this.getUploadLink(
			remotePath,
			overwrite,
			raw,
		);

		let lastError: Error | null = null;
		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				const response = await requestUrl({
					url: uploadLink.href,
					method: "PUT",
					body: bodyContent,
					throw: false,
				});
				if (response.status >= 200 && response.status < 300) return;

				const errorData = response.json as YandexError;
				const error = new YandexApiError(
					errorData?.description ||
						`Upload HTTP ${response.status}`,
					response.status,
					errorData?.error,
				);
				if (
					!this.isTransientStatus(response.status) ||
					attempt === this.maxRetries
				) {
					throw error;
				}
				lastError = error;
			} catch (e) {
				if (
					e instanceof YandexApiError &&
					!this.isTransientStatus(e.status)
				) {
					throw e;
				}
				lastError = e as Error;
				if (attempt === this.maxRetries) break;
			}
			await this.sleep(this.getRetryDelay(attempt));
		}
		throw lastError || new Error("Upload failed");
	}

	/**
	 * Get download link for file
	 */
	async getDownloadLink(path: string, raw = false): Promise<YandexDownloadLink> {
		const targetPath = raw ? path : await this.encryptFilePath(path);
		const encodedPath = encodePathForUrl(targetPath);
		const response = await this.request(
			"GET",
			`/resources/download?path=${encodedPath}`
		);
		return response.json as YandexDownloadLink;
	}

	/**
	 * Download file from Yandex Disk.
	 * When `raw` is true, skips path and content decryption (for metadata files).
	 */
	async downloadFile(remotePath: string, raw = false): Promise<ArrayBuffer> {
		const downloadLink = await this.getDownloadLink(remotePath, raw);

		logger.debug(`Downloading file directly: ${remotePath}`);
		const response = await requestUrl({
			url: downloadLink.href,
			method: "GET",
			throw: true,
		});

		const result = raw
			? response.arrayBuffer
			: await this.decryptContent(response.arrayBuffer);

		logger.debug(`Downloaded file: ${remotePath}`);
		return result;
	}

	/**
	 * Decode already downloaded service-file bytes with an explicit codec.
	 * Passing undefined uses the currently configured codec, while null means
	 * plaintext. This keeps index rollback snapshots byte-identical.
	 */
	async decodeServiceFileContent(
		raw: ArrayBuffer,
		service?: EncryptionService | null,
	): Promise<ArrayBuffer> {
		if (service === undefined) {
			return await this.decryptContent(raw);
		}
		return service ? await service.decrypt(raw) : raw;
	}

	/**
	 * Upload a service file with an explicit content codec while keeping its
	 * physical path unencrypted.
	 */
	async uploadFileWithEncryptionService(
		remotePath: string,
		content: string,
		service: EncryptionService | null,
		overwrite = true,
	): Promise<void> {
		const plain = new TextEncoder().encode(content).buffer;
		const encoded = service ? await service.encrypt(plain) : plain;
		await this.uploadFile(
			remotePath,
			encoded,
			true,
			true,
			overwrite,
		);
	}

	/**
	 * Delete file or folder.
	 * When `raw` is true, skips path encryption.
	 */
	async deleteResource(
		path: string,
		permanently = false,
		raw = false
	): Promise<void> {
		const targetPath = raw ? path : await this.encryptFilePath(path);
		const encodedPath = encodePathForUrl(targetPath);
		try {
			const response = await this.request(
				"DELETE",
				`/resources?path=${encodedPath}&permanently=${permanently}`
			);
			await this.waitForAsyncOperation(response);
			logger.debug(`Deleted resource: ${path}`);
		} catch (e: unknown) {
			// Ignore error if resource doesn't exist
			if (!this.isNotFoundError(e)) {
				throw e;
			}
		}
	}

	/**
	 * Move/rename resource
	 */
	async moveResource(
		fromPath: string,
		toPath: string,
		overwrite = false
	): Promise<void> {
		const encryptedFrom = await this.encryptFilePath(fromPath);
		const encryptedTo = await this.encryptFilePath(toPath);
		const encodedFrom = encodePathForUrl(encryptedFrom);
		const encodedTo = encodePathForUrl(encryptedTo);

		// Ensure target folder exists — derive parent from the encrypted path.
		const parentPath = encryptedTo.substring(0, encryptedTo.lastIndexOf("/"));
		if (parentPath) {
			await this.createFolderRecursive(parentPath);
		}

		const response = await this.request(
			"POST",
			`/resources/move?from=${encodedFrom}&path=${encodedTo}&overwrite=${overwrite}`
		);
		await this.waitForAsyncOperation(response);
		logger.debug(`Moved resource: ${fromPath} -> ${toPath}`);
	}

	/**
	 * Atomically move a resource without replacing an existing target.
	 */
	async moveResourceExclusive(
		fromPath: string,
		toPath: string,
	): Promise<void> {
		await this.moveResource(fromPath, toPath, false);
	}

	/**
	 * Base method for HTTP requests with retry logic
	 */
	private async request(
		method: string,
		endpoint: string,
		body?: unknown
	): Promise<RequestUrlResponse> {
		const url = `${API_BASE_URL}${endpoint}`;

		const params: RequestUrlParam = {
			url,
			method,
			headers: {
				Authorization: `OAuth ${this.token}`,
				"Content-Type": "application/json",
			},
			throw: false,
		};

		if (body) {
			params.body = JSON.stringify(body);
		}

		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				if (method === "GET") {
					this.recordApiRead(endpoint);
				}
				logger.debug(`API request: ${method} ${endpoint}`, {
					attempt: attempt + 1,
					maxRetries: this.maxRetries,
				});

				const response = await requestUrl(params);

				// Successful statuses
				if (response.status >= 200 && response.status < 300) {
					logger.debug(`API response: ${method} ${endpoint} -> ${response.status}`);
					return response;
				}

				// Handle errors
				const errorData = response.json as YandexError;

				// Errors that can be retried
				if (
					this.isTransientStatus(response.status)
				) {
					lastError = new YandexApiError(
						errorData?.description ||
						"Rate limit or service unavailable",
						response.status,
						errorData?.error
					);

					logger.warn(`API rate/service error: ${method} ${endpoint} -> ${response.status}`, {
						code: errorData?.error,
						description: errorData?.description,
						attempt: attempt + 1,
					});

					if (attempt < this.maxRetries) {
						const delay = this.getRetryDelay(attempt);
						logger.warn(
							`Retrying API request in ${delay}ms`
						);
						await this.sleep(delay);
						continue;
					}
				}

			// Other errors - don't retry
			logger.debug(`API error: ${method} ${endpoint} -> ${response.status}`, {
				code: errorData?.error,
				description: errorData?.description,
				message: errorData?.message,
				reason: errorData?.reason,
			});
				throw new YandexApiError(
					errorData?.description || `HTTP ${response.status}`,
					response.status,
					errorData?.error
				);
			} catch (e) {
				if (e instanceof YandexApiError) {
					throw e;
				}
				lastError = e as Error;

				logger.error(`API request failed: ${method} ${endpoint}`, {
					attempt: attempt + 1,
					error: (e as Error).message,
				});

				if (attempt < this.maxRetries) {
					const delay = this.getRetryDelay(attempt);
					logger.warn(
						`Network error, retry in ${delay}ms:`
					);
					await this.sleep(delay);
				}
			}
		}

		throw lastError || new Error("Unknown error");
	}

	private recordApiRead(endpoint: string): void {
		let category: ApiReadCategory = "other";
		if (endpoint.includes(".obsidian-encrypt.json")) {
			category = "manifest";
		} else if (endpoint.includes(".obsidian-sync-index")) {
			category = "index";
		} else if (endpoint.startsWith("/resources?")) {
			const query = endpoint.slice(endpoint.indexOf("?") + 1);
			const encodedPath = new URLSearchParams(query).get("path") ?? "";
			const path = normalizePath(encodedPath.replace(/^disk:\//, ""));
			category = path === this.remotePath ? "root" : "tree";
		}
		this.apiReadMetrics[category]++;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private getRetryDelay(attempt: number): number {
		return (
			this.retryDelay * Math.pow(2, attempt) +
			Math.floor(Math.random() * this.retryDelay)
		);
	}

	private isTransientStatus(status: number): boolean {
		return status === 423 || status === 429 || status === 503;
	}

	/**
	 * Wait for a server-side operation returned as HTTP 202.
	 */
	private async waitForAsyncOperation(
		response: RequestUrlResponse,
	): Promise<void> {
		if (response.status !== 202) return;
		const href = (response.json as { href?: unknown } | null)?.href;
		if (typeof href !== "string" || !href) return;
		const operationUrl = href.startsWith("http")
			? href
			: `${API_BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;

		for (let attempt = 0; attempt < 120; attempt++) {
			const operationResponse = await requestUrl({
				url: operationUrl,
				method: "GET",
				headers: {
					Authorization: `OAuth ${this.token}`,
				},
				throw: false,
			});
			if (
				operationResponse.status < 200 ||
				operationResponse.status >= 300
			) {
				if (
					(operationResponse.status === 409 ||
						this.isTransientStatus(
							operationResponse.status,
						)) &&
					attempt < 119
				) {
					await this.sleep(this.getRetryDelay(attempt % 4));
					continue;
				}
				throw new YandexApiError(
					`Operation status HTTP ${operationResponse.status}`,
					operationResponse.status,
				);
			}
			const rawStatus = (
				operationResponse.json as { status?: unknown } | null
			)?.status;
			const status =
				typeof rawStatus === "string"
					? rawStatus.toLowerCase()
					: "";
			if (status === "success") return;
			if (status === "failed") {
				throw new YandexApiError(
					"Yandex Disk asynchronous operation failed",
					409,
				);
			}
			await this.sleep(500);
		}
		throw new YandexApiError(
			"Yandex Disk asynchronous operation timed out",
			408,
		);
	}

	private isNotFoundError(e: unknown): boolean {
		return e instanceof YandexApiError && e.status === 404;
	}

	private isConflictError(e: unknown): boolean {
		return e instanceof YandexApiError && e.status === 409;
	}
}

/**
 * Yandex API error
 */
export class YandexApiError extends Error {
	constructor(message: string, public status: number, public code?: string) {
		super(message);
		this.name = "YandexApiError";
	}
}
