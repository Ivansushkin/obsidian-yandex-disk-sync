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
import { logger } from "../utils/logger";
import { encodePathForUrl } from "../utils/path-utils";

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

	/**
	 * Get resource information (file or folder)
	 */
	async getResource(
		path: string,
		limit = 1000,
		offset = 0
	): Promise<YandexResource | null> {
		try {
			const encodedPath = encodePathForUrl(path);
			const response = await this.request(
				"GET",
				`/resources?path=${encodedPath}&limit=${limit}&offset=${offset}`
			);
			return response.json as YandexResource;
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
	async getResourcesRecursive(path: string): Promise<YandexResource[]> {
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
					offset
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
		const encodedPath = encodePathForUrl(path);
		try {
			await this.request("PUT", `/resources?path=${encodedPath}`);
			logger.debug(`Created folder: ${path}`);
		} catch (e: unknown) {
			// Ignore error if folder already exists
			if (!this.isConflictError(e)) {
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
	 * Get upload link for file
	 */
	async getUploadLink(
		path: string,
		overwrite = true
	): Promise<YandexUploadLink> {
		const encodedPath = encodePathForUrl(path);
		const response = await this.request(
			"GET",
			`/resources/upload?path=${encodedPath}&overwrite=${overwrite}`
		);
		return response.json as YandexUploadLink;
	}

	/**
	 * Upload file to Yandex Disk
	 */
	async uploadFile(
		remotePath: string,
		content: ArrayBuffer | string
	): Promise<void> {
		// Ensure parent folder exists
		const parentPath = remotePath.substring(0, remotePath.lastIndexOf("/"));
		if (parentPath) {
			await this.createFolderRecursive(parentPath);
		}

		// Get upload link
		const uploadLink = await this.getUploadLink(remotePath);

		// Upload file
		const bytes =
			typeof content === "string"
				? new TextEncoder().encode(content)
				: new Uint8Array(content);

		await requestUrl({
			url: uploadLink.href,
			method: "PUT",
			body: bytes.buffer as ArrayBuffer,
			throw: true,
		});

		logger.debug(`Uploaded file: ${remotePath}`);
	}

	/**
	 * Get download link for file
	 */
	async getDownloadLink(path: string): Promise<YandexDownloadLink> {
		const encodedPath = encodePathForUrl(path);
		const response = await this.request(
			"GET",
			`/resources/download?path=${encodedPath}`
		);
		return response.json as YandexDownloadLink;
	}

	/**
	 * Download file from Yandex Disk
	 */
	async downloadFile(remotePath: string): Promise<ArrayBuffer> {
		const downloadLink = await this.getDownloadLink(remotePath);

		const response = await requestUrl({
			url: downloadLink.href,
			method: "GET",
			throw: true,
		});

		logger.debug(`Downloaded file: ${remotePath}`);
		return response.arrayBuffer;
	}

	/**
	 * Delete file or folder
	 */
	async deleteResource(path: string, permanently = false): Promise<void> {
		const encodedPath = encodePathForUrl(path);
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
		const encodedFrom = encodePathForUrl(fromPath);
		const encodedTo = encodePathForUrl(toPath);

		// Ensure target folder exists
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
		const encodedFrom = encodePathForUrl(fromPath);
		const encodedTo = encodePathForUrl(toPath);

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
