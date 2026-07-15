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

const API_BASE_URL = "https://cloud-api.yandex.net/v1/disk";

export interface YandexClientConfig {
	token: string;
	maxRetries?: number;
	retryDelay?: number;
}

export class YandexDiskClient {
	private token: string;
	private maxRetries: number;
	private retryDelay: number;
	private folderCache: Set<string> = new Set();
	private encryptionService: EncryptionService | null = null;
	private remotePath = "";

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
	 * Recursively get all files in folder
	 */
	async getResourcesRecursive(path: string, raw = false): Promise<YandexResource[]> {
		const results: YandexResource[] = [];
		const queue: string[] = [path];

		while (queue.length > 0) {
			const currentPath = queue.shift()!;
			let offset = 0;
			const limit = 1000;

			while (true) {
				// Always fetch raw: directory paths must stay encrypted so the
				// next traversal request hits the correct remote path. Only file
				// results are decrypted before being returned to the caller.
				const resource = await this.getResource(
					currentPath,
					limit,
					offset,
					true
				);
				if (!resource) break;
				if (resource.type === "file") {
					results.push(raw ? resource : await this.decryptResource(resource));
					break;
				}

				if (resource._embedded) {
					for (const item of resource._embedded.items) {
						if (item.type === "dir") {
							queue.push(item.path);
						} else {
							results.push(raw ? item : await this.decryptResource(item));
						}
					}

					// Check if there are more elements
					if (
						offset + resource._embedded.items.length >=
						resource._embedded.total
					) {
						break;
					}
					offset += limit;
				} else {
					break;
				}
			}
		}

		return results;
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
		raw = false
	): Promise<void> {
		// Ensure parent folder exists (if not skipped) — derive the parent from
		// the encrypted target path so encrypted folder segments are created.
		if (!skipFolderCheck) {
			await this.ensureUploadParent(remotePath, raw);
		}

		try {
			await this.putFile(remotePath, content, raw);
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
			await this.putFile(remotePath, content, raw);
			logger.debug(`Uploaded file after folder retry: ${remotePath}`);
		}
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
		raw: boolean
	): Promise<void> {
		const bytes =
			typeof content === "string"
				? new TextEncoder().encode(content)
				: new Uint8Array(content);

		const bodyContent = raw
			? bytes.buffer
			: await this.encryptContent(bytes.buffer);

		// Get upload link with optionally encrypted path
		const uploadLink = await this.getUploadLink(remotePath, true, raw);

		await requestUrl({
			url: uploadLink.href,
			method: "PUT",
			body: bodyContent,
			throw: true,
		});
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
			await this.request(
				"DELETE",
				`/resources?path=${encodedPath}&permanently=${permanently}`
			);
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

		await this.request(
			"POST",
			`/resources/move?from=${encodedFrom}&path=${encodedTo}&overwrite=${overwrite}`
		);
		logger.debug(`Moved resource: ${fromPath} -> ${toPath}`);
	}

	/**
	 * Copy resource
	 */
	async copyResource(
		fromPath: string,
		toPath: string,
		overwrite = false
	): Promise<void> {
		const encryptedFrom = await this.encryptFilePath(fromPath);
		const encryptedTo = await this.encryptFilePath(toPath);
		const encodedFrom = encodePathForUrl(encryptedFrom);
		const encodedTo = encodePathForUrl(encryptedTo);

		await this.request(
			"POST",
			`/resources/copy?from=${encodedFrom}&path=${encodedTo}&overwrite=${overwrite}`
		);
		logger.debug(`Copied resource: ${fromPath} -> ${toPath}`);
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
				if (response.status === 429 || response.status === 503) {
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
						const delay = this.retryDelay * Math.pow(2, attempt);
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
					const delay = this.retryDelay * Math.pow(2, attempt);
					logger.warn(
						`Network error, retry in ${delay}ms:`
					);
					await this.sleep(delay);
				}
			}
		}

		throw lastError || new Error("Unknown error");
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
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
