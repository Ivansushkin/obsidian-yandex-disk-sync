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
import { encodePathForUrl, getFileName, getDirectory } from "../utils/path-utils";

const API_BASE_URL = "https://cloud-api.yandex.net/v1/disk";
const REMOTE_INDEX_FILENAME = ".obsidian-sync-index.json";
const ENCRYPTION_MANIFEST_FILENAME = ".obsidian-encrypt.json";

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
		} catch {
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

	private async encryptFilePath(path: string): Promise<string> {
		if (!this.encryptionService) return path;
		const fileName = getFileName(path);
		if (!fileName) return path;
		if (fileName === REMOTE_INDEX_FILENAME || fileName === ENCRYPTION_MANIFEST_FILENAME) return path;
		const encrypted = await this.encryptionService.encryptFilename(fileName);
		const dir = getDirectory(path);
		return dir ? `${dir}/${encrypted}` : encrypted;
	}

	private async decryptFileName(name: string): Promise<string> {
		if (!this.encryptionService) return name;
		try {
			return await this.encryptionService.decryptFilename(name);
		} catch {
			return name;
		}
	}

	private async decryptFilePath(path: string): Promise<string> {
		if (!this.encryptionService) return path;
		const fileName = getFileName(path);
		if (!fileName) return path;
		const decrypted = await this.decryptFileName(fileName);
		const dir = getDirectory(path);
		return dir ? `${dir}/${decrypted}` : decrypted;
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
				const resource = await this.getResource(
					currentPath,
					limit,
					offset,
					raw
				);
				if (!resource) break;
				if (resource.type === "file") {
					results.push(resource);
					break;
				}

				if (resource._embedded) {
					for (const item of resource._embedded.items) {
						if (item.type === "dir") {
							queue.push(item.path);
						} else {
							results.push(item);
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
		// Collect all unique folder paths including parent folders
		const allFolders = new Set<string>();

		for (const path of paths) {
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
	 */
	async uploadFile(
		remotePath: string,
		content: ArrayBuffer | string,
		skipFolderCheck = false,
		raw = false
	): Promise<void> {
		// Ensure parent folder exists (if not skipped) — use plaintext parent path
		if (!skipFolderCheck) {
			const parentPath = remotePath.substring(
				0,
				remotePath.lastIndexOf("/")
			);
			if (parentPath) {
				await this.createFolderRecursive(parentPath);
			}
		}

		const bytes =
			typeof content === "string"
				? new TextEncoder().encode(content)
				: new Uint8Array(content);

		const bodyContent = raw
			? bytes.buffer
			: await this.encryptContent(bytes.buffer);

		// Get upload link with optionally encrypted path
		const uploadLink = await this.getUploadLink(remotePath, true, raw);

		// Upload file
		await requestUrl({
			url: uploadLink.href,
			method: "PUT",
			body: bodyContent,
			throw: true,
		});

		logger.debug(`Uploaded file: ${remotePath}`);
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

		// Ensure target folder exists — use plaintext parent path
		const parentPath = toPath.substring(0, toPath.lastIndexOf("/"));
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
				const response = await requestUrl(params);

				// Successful statuses
				if (response.status >= 200 && response.status < 300) {
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

					if (attempt < this.maxRetries) {
						const delay = this.retryDelay * Math.pow(2, attempt);
						logger.warn(
							`Error ${response.status}, retry in ${delay}ms`
						);
						await this.sleep(delay);
						continue;
					}
				}

				// Other errors - don't retry
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

				if (attempt < this.maxRetries) {
					const delay = this.retryDelay * Math.pow(2, attempt);
					logger.warn(
						`Network error, retry in ${delay}ms:`,
						(e as Error).message
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
