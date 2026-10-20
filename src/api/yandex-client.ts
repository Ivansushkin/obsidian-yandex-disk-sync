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
import type { EncryptionCodec } from "../crypto/encryption";
import { logger } from "../utils/logger";
import {
	YandexApiError,
	RemoteHttpError,
	RemoteReadTimeoutError,
	NetworkRequestError,
	OperationFailure,
	decideRecovery,
	withFailureContext,
	type RetryProgress,
	isRemoteReadTimeout,
} from "../errors";
export {
	YandexApiError,
	RemoteReadTimeoutError,
	isRemoteReadTimeout,
} from "../errors";
import {
	encodePathForUrl,
	isProtectedPath,
	normalizePath,
} from "../utils/path-utils";
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
	readTimeoutMs?: number;
	downloadTimeoutMs?: number;
}

interface DownloadReadBudget {
	deadline: number;
	timeoutMs: number;
}

interface StableRawFileSnapshot {
	raw: ArrayBuffer;
	resource: YandexResource;
	fingerprint: string;
}

export interface StableLogicalFileSnapshot {
	content: ArrayBuffer;
	resource: YandexResource;
	fingerprint: string;
}

type ApiReadCategory = "manifest" | "index" | "root" | "tree" | "other";

export class YandexDiskClient {
	private token: string;
	private retryCallback?: (progress?: RetryProgress) => void;

	/** Report existing backoff without opening a new session or Notice. */
	setRetryCallback(callback?: (progress?: RetryProgress) => void): void {
		this.retryCallback = callback;
	}
	private maxRetries: number;
	private retryDelay: number;
	private readonly readTimeoutMs: number;
	private readonly downloadTimeoutMs: number;
	private folderCache: Set<string> = new Set();
	private encryptionService: EncryptionCodec | null = null;
	private remotePath = "";
	private writeGuard: (() => Promise<void>) | null = null;

	/** Check storage ownership again for each physical write or retry. */
	setWriteGuard(guard: () => Promise<void>): void {
		this.writeGuard = guard;
	}
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
		this.readTimeoutMs = config.readTimeoutMs ?? 60_000;
		this.downloadTimeoutMs = config.downloadTimeoutMs ?? 60_000;
	}

	/**
	 * Update token
	 */
	setToken(token: string): void {
		if (this.token !== token) {
			this.clearFolderCache();
		}
		this.token = token;
	}

	/**
	 * Set encryption service for transparent encryption/decryption.
	 * Pass null to disable encryption.
	 */
	setEncryptionService(service: EncryptionCodec | null): void {
		if (this.encryptionService !== service) {
			this.clearFolderCache();
		}
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
	 * Set the remote base path. The base path itself stays raw while user path
	 * segments below it are encrypted independently.
	 */
	setRemotePath(remotePath: string): void {
		const normalized = normalizePath(remotePath);
		if (this.remotePath !== normalized) {
			this.clearFolderCache();
		}
		this.remotePath = normalized;
	}

	/**
	 * Clear folder cache
	 */
	clearFolderCache(): void {
		this.folderCache.clear();
	}

	/** Remember one observed folder and its already-existing ancestors. */
	private rememberFolder(path: string): void {
		const parts = this.normalizeFolderObservation(path)
			.split("/")
			.filter(Boolean);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			this.folderCache.add(current);
		}
	}

	/** Invalidate a folder observation and every cached descendant. */
	private invalidateFolder(path: string): void {
		const normalized = this.normalizeFolderObservation(path);
		if (!normalized) {
			return;
		}
		for (const cached of [...this.folderCache]) {
			if (cached === normalized || cached.startsWith(`${normalized}/`)) {
				this.folderCache.delete(cached);
			}
		}
	}

	private hasObservedFolder(path: string): boolean {
		return this.folderCache.has(this.normalizeFolderObservation(path));
	}

	private normalizeFolderObservation(path: string): string {
		return normalizePath(path.replace(/^disk:\//, ""));
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
		budget = this.createDownloadBudget(),
	): Promise<StableRawFileSnapshot | null> {
		const startedAt = Date.now();
		const before =
			expectedResource ??
			(await this.getResource(path, 1, 0, true, budget));
		if (!before) {
			return null;
		}
		if (!this.getContentFingerprint(before)) {
			throw new Error(
				"Remote service file has no stable content fingerprint",
			);
		}

		const raw = await this.downloadFile(path, true, budget);
		const after = await this.getResource(path, 1, 0, true, budget);
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
	 * Read a logical user file between two matching physical metadata
	 * observations. The returned bytes are decrypted by the active codec.
	 */
	async downloadStableLogicalFile(
		path: string,
		expectedResource?: YandexResource,
		budget = this.createDownloadBudget(),
	): Promise<StableLogicalFileSnapshot | null> {
		const before =
			expectedResource ?? (await this.getLogicalResource(path, budget));
		if (!before || !this.getContentFingerprint(before)) {
			return null;
		}
		const content = await this.downloadFile(path, false, budget);
		const after = await this.getLogicalResource(path, budget);
		if (!after) {
			throw new Error("Remote user file disappeared while being read");
		}
		const matchingFingerprint = this.getMatchingContentFingerprint(
			before,
			after,
		);
		const afterFingerprint = this.getContentFingerprint(after);
		if (!matchingFingerprint || !afterFingerprint) {
			throw new Error("Remote user file changed while being read");
		}
		return { content, resource: after, fingerprint: afterFingerprint };
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
		if (!this.encryptionService) {
			return data;
		}
		return this.encryptionService.encrypt(data);
	}

	private async decryptContent(data: ArrayBuffer): Promise<ArrayBuffer> {
		if (!this.encryptionService) {
			return data;
		}
		return this.encryptionService.decrypt(data);
	}

	/** Map a logical file path to the current physical layout. */
	private async encryptFilePath(path: string): Promise<string> {
		if (!this.encryptionService) {
			return path;
		}
		if (isProtectedPath(path)) {
			return path;
		}

		const base = this.remotePath;
		const full = normalizePath(path);
		if (!full || full === base) {
			return path;
		}

		const hasBase = base !== "" && full.startsWith(base + "/");
		const relative = hasBase ? full.slice(base.length + 1) : full;
		const encrypted = await Promise.all(
			relative
				.split("/")
				.map((seg) => this.encryptionService!.encryptFilename(seg)),
		);
		const joined = encrypted.join("/");
		return hasBase ? `${base}/${joined}` : joined;
	}

	private async decryptFileName(name: string): Promise<string> {
		if (!this.encryptionService) {
			return name;
		}
		return await this.encryptionService.decryptFilename(name);
	}

	/** Decode a physical resource path without accepting ciphertext fallback. */
	private async decryptFilePath(path: string): Promise<string> {
		if (!this.encryptionService) {
			return path;
		}
		if (isProtectedPath(path)) {
			return path;
		}

		const diskPrefix = path.startsWith("disk:/") ? "disk:/" : "";
		const clean = normalizePath(path.replace(/^disk:\//, ""));
		const base = normalizePath(this.remotePath.replace(/^disk:\//, ""));
		if (!clean || clean === base) {
			return path;
		}

		const hasBase = base !== "" && clean.startsWith(base + "/");
		const relative = hasBase ? clean.slice(base.length + 1) : clean;
		const decrypted = await Promise.all(
			relative.split("/").map((seg) => this.decryptFileName(seg)),
		);
		const joined = decrypted.join("/");
		return hasBase
			? `${diskPrefix}${base}/${joined}`
			: `${diskPrefix}${joined}`;
	}

	private async decryptResource(
		resource: YandexResource,
	): Promise<YandexResource> {
		if (!this.encryptionService) {
			return resource;
		}
		const protectedRawResource = isProtectedPath(resource.path);
		return {
			...resource,
			name: protectedRawResource
				? resource.name
				: await this.decryptFileName(resource.name),
			path: await this.decryptFilePath(resource.path),
			_embedded: resource._embedded
				? {
						...resource._embedded,
						items: await Promise.all(
							resource._embedded.items.map((item) =>
								this.decryptResource(item),
							),
						),
					}
				: undefined,
		};
	}

	/**
	 * Convert raw Yandex resource metadata to the active logical path.
	 */
	async toLogicalResource(resource: YandexResource): Promise<YandexResource> {
		return await this.decryptResource(resource);
	}

	/**
	 * Get resource information (file or folder)
	 */
	async getResource(
		path: string,
		limit = 1000,
		offset = 0,
		raw = false,
		budget?: DownloadReadBudget,
	): Promise<YandexResource | null> {
		try {
			const encodedPath = encodePathForUrl(path);
			const response = await this.request(
				"GET",
				`/resources?path=${encodedPath}&limit=${limit}&offset=${offset}`,
				undefined,
				undefined,
				budget,
			);
			const resource = response.json as YandexResource;
			if (resource.type === "dir") {
				this.rememberFolder(path);
			}
			if (raw) {
				return resource;
			}
			return await this.decryptResource(resource);
		} catch (e: unknown) {
			if (this.isNotFoundError(e)) {
				this.invalidateFolder(path);
				return null;
			}
			throw e;
		}
	}

	/**
	 * Get a resource addressed by its logical, unencrypted path.
	 */
	async getLogicalResource(
		path: string,
		budget?: DownloadReadBudget,
	): Promise<YandexResource | null> {
		const target = await this.encryptFilePath(path);
		return await this.getResource(target, 1000, 0, true, budget);
	}

	/**
	 * Resolve a logical path to the physical remote path for transition cleanup.
	 */
	async getPhysicalPath(path: string): Promise<string> {
		return await this.encryptFilePath(path);
	}

	/** Decode one root-relative user path with an explicit transition codec. */
	async decodePhysicalUserPath(
		path: string,
		service: EncryptionCodec | null,
	): Promise<string> {
		const normalized = normalizePath(path);
		if (!normalized || normalized !== path || isProtectedPath(normalized)) {
			throw new Error(
				"Transition target contains an invalid physical path",
			);
		}
		if (!service) {
			return normalized;
		}
		return (
			await Promise.all(
				normalized
					.split("/")
					.map((segment) => service.decryptFilename(segment)),
			)
		).join("/");
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
			for (const currentPath of currentLevel) {
				visited.add(currentPath);
			}
			const batches = await runWithConcurrency(
				currentLevel.map(
					(currentPath) => async () =>
						await this.readDirectoryPageSet(currentPath, raw),
				),
				limit,
			);
			level = batches.flatMap((batch) => batch.directories);
			for (const batch of batches) {
				results.push(...batch.files);
			}
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
			if (!resource) {
				break;
			}
			if (resource.type === "file") {
				files.push(
					raw ? resource : await this.decryptResource(resource),
				);
				break;
			}
			const embedded = resource._embedded;
			if (!embedded) {
				break;
			}
			for (const item of embedded.items) {
				if (item.type === "dir") {
					this.rememberFolder(item.path.replace(/^disk:\//, ""));
					if (!isProtectedPath(item.path)) {
						directories.push(item.path);
					}
				} else {
					files.push(raw ? item : await this.decryptResource(item));
				}
			}
			if (offset + embedded.items.length >= embedded.total) {
				break;
			}
			offset += limit;
		}
		return { files, directories };
	}

	/**
	 * Create folder
	 */
	async createFolder(path: string): Promise<void> {
		// Check cache first
		if (this.hasObservedFolder(path)) {
			return;
		}

		const encodedPath = encodePathForUrl(path);
		try {
			await this.request("PUT", `/resources?path=${encodedPath}`);
			this.rememberFolder(path);
			logger.debug(`Created folder: ${path}`);
		} catch (e: unknown) {
			// Ignore error if folder already exists
			if (
				this.isConflictError(e) &&
				e instanceof YandexApiError &&
				e.code === "DiskPathPointsToExistentDirectoryError"
			) {
				this.rememberFolder(path);
			} else if (this.isConflictError(e)) {
				const existing = await this.getResource(path, 1, 0, true);
				if (existing?.type !== "dir") {
					throw e;
				}
				this.rememberFolder(path);
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
		// Encrypt every folder segment independently under the current profile.
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
				if (!this.hasObservedFolder(currentPath)) {
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
	 * The path uses the active encrypted directory layout so the real remote
	 * folder is inspected. Returns true when the folder does not exist or has
	 * no children. Used by the sync engine before pruning a folder that the
	 * in-memory index believes to be empty, to guard against a stale index
	 * (e.g. written by an older plugin version) wrongly claiming emptiness
	 * and causing the folder's actually-present files to be deleted.
	 */
	async isFolderEmpty(remotePath: string): Promise<boolean> {
		const target = await this.encryptFilePath(remotePath);
		const resource = await this.getResource(target, 1000, 0, true);
		if (!resource) {
			return true;
		}
		const items = resource._embedded?.items ?? [];
		return items.length === 0;
	}

	/**
	 * Check a physical transition-cleanup folder without applying path
	 * encryption.
	 */
	async isRawFolderEmpty(remotePath: string): Promise<boolean> {
		const resource = await this.getResource(remotePath, 1000, 0, true);
		if (!resource) {
			return true;
		}
		return (resource._embedded?.items ?? []).length === 0;
	}

	/**
	 * Get upload link for file
	 */
	async getUploadLink(
		path: string,
		overwrite = true,
		raw = false,
	): Promise<YandexUploadLink> {
		const targetPath = raw ? path : await this.encryptFilePath(path);
		const encodedPath = encodePathForUrl(targetPath);
		const response = await this.request(
			"GET",
			`/resources/upload?path=${encodedPath}&overwrite=${overwrite}`,
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
	 * instead of failing the operation until the next full sync. Only a 404
	 * triggers the retry; other failures (auth, quota, conflict, network, 5xx) are
	 * re-thrown immediately so the real cause isn't masked as a missing folder.
	 */
	async uploadFile(
		remotePath: string,
		content: ArrayBuffer | string,
		skipFolderCheck = false,
		raw = false,
		overwrite = true,
		beforeAttempt?: () => Promise<void>,
		confirmAmbiguousResult?: () => Promise<boolean>,
	): Promise<void> {
		await beforeAttempt?.();
		// Ensure parent folder exists (if not skipped) — derive the parent from
		// the encrypted target path so encrypted folder segments are created.
		if (!skipFolderCheck) {
			await this.ensureUploadParent(remotePath, raw);
		}

		try {
			await this.putFile(
				remotePath,
				content,
				raw,
				overwrite,
				beforeAttempt,
				confirmAmbiguousResult,
			);
			logger.debug(`Uploaded file: ${remotePath}`);
			return;
		} catch (e) {
			if (
				!skipFolderCheck &&
				e instanceof YandexApiError &&
				e.status === 404
			) {
				await this.recreateUploadParent(remotePath, raw);
				await this.putFile(
					remotePath,
					content,
					raw,
					overwrite,
					beforeAttempt,
					confirmAmbiguousResult,
				);
				logger.debug(
					`Uploaded file after folder recovery: ${remotePath}`,
				);
				return;
			}
			if (!skipFolderCheck) {
				throw e;
			}
			// Only retry when the failure is consistent with a missing/vanished
			// parent folder (404 not found). Other errors
			// (auth, quota, network, 5xx) are not caused by a missing folder
			// and would just waste an extra upload attempt while masking the
			// real cause.
			if (!(e instanceof YandexApiError) || e.status !== 404) {
				throw e;
			}
			// The preflight-created parent may have been pruned between preflight
			// and this upload (e.g. another device's fullSync removed the last
			// file in that folder and pruned the empty folder). Recreate the
			// parent and retry once.
			logger.info("Upload parent missing; recreating before one retry", {
				status: e.status,
				skipFolderCheck: true,
			});
			await this.recreateUploadParent(remotePath, raw);
			await this.putFile(
				remotePath,
				content,
				raw,
				overwrite,
				beforeAttempt,
				confirmAmbiguousResult,
			);
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
		await this.uploadFile(remotePath, content, skipFolderCheck, raw, false);
	}

	/**
	 * Ensure the parent folder of the given target path exists, deriving the
	 * parent from the (optionally encrypted) target path.
	 */
	private async ensureUploadParent(
		remotePath: string,
		raw: boolean,
	): Promise<void> {
		const parentPath = await this.getUploadParent(remotePath, raw);
		if (parentPath) {
			await this.createFolderRecursive(parentPath);
		}
	}

	/** Revalidate a cached upload parent after the server reports it missing. */
	private async recreateUploadParent(
		remotePath: string,
		raw: boolean,
	): Promise<void> {
		const parentPath = await this.getUploadParent(remotePath, raw);
		if (!parentPath) {
			return;
		}
		this.invalidateFolder(parentPath);
		await this.createFolderRecursive(parentPath);
	}

	private async getUploadParent(
		remotePath: string,
		raw: boolean,
	): Promise<string> {
		const targetPath = raw
			? remotePath
			: await this.encryptFilePath(remotePath);
		return targetPath.substring(0, targetPath.lastIndexOf("/"));
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
		beforeAttempt?: () => Promise<void>,
		confirmAmbiguousResult?: () => Promise<boolean>,
	): Promise<void> {
		const bytes =
			typeof content === "string"
				? new TextEncoder().encode(content)
				: new Uint8Array(content);

		const bodyContent = raw
			? bytes.buffer
			: await this.encryptContent(bytes.buffer);

		// Get upload link with optionally encrypted path
		const uploadLink = await this.getUploadLink(remotePath, overwrite, raw);

		let lastError: Error | null = null;
		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			await beforeAttempt?.();
			await this.writeGuard?.();
			const startedAt = Date.now();
			try {
				const response = await this.requestNative({
					url: uploadLink.href,
					method: "PUT",
					body: bodyContent,
					throw: false,
				});
				if (response.status >= 200 && response.status < 300) {
					return;
				}

				const errorData = this.readProviderError(response);
				const error = new YandexApiError(
					errorData?.description || `Upload HTTP ${response.status}`,
					response.status,
					errorData?.error,
				);
				throw error;
			} catch (e) {
				lastError = e as Error;
				const decision = this.recovery(
					e,
					"put",
					this.maxRetries - attempt,
				);
				if (decision.confirm) {
					const context = {
						stage: "upload",
						action: "put" as const,
						requestState: "completed" as const,
						outcome: "write-unconfirmed" as const,
						durationMs: Date.now() - startedAt,
					};
					withFailureContext(e, context);
					logger.warn("PUT response requires verification", {
						error: new OperationFailure(e, context),
						attempt: attempt + 1,
					});
					try {
						if (await confirmAmbiguousResult?.()) {
							return;
						}
					} catch (verificationError) {
						throw withFailureContext(verificationError, {
							...context,
							stage: "upload-verification",
						});
					}
				}
				if (!decision.retry) {
					break;
				}
			}
			await this.waitBeforeRetry(
				this.getRetryDelay(attempt),
				attempt,
				"upload",
			);
		}
		throw lastError || new Error("Upload failed");
	}

	/**
	 * Get download link for file
	 */
	async getDownloadLink(
		path: string,
		raw = false,
		budget?: DownloadReadBudget,
	): Promise<YandexDownloadLink> {
		const targetPath = raw ? path : await this.encryptFilePath(path);
		const encodedPath = encodePathForUrl(targetPath);
		const response = await this.request(
			"GET",
			`/resources/download?path=${encodedPath}`,
			undefined,
			undefined,
			budget,
		);
		return response.json as YandexDownloadLink;
	}

	/**
	 * Download complete bytes, retrying transient transfers with a fresh signed link.
	 * Decode only after transfer success; codec failures are not network retries.
	 * When `raw` is true, skip path and content decryption for service files.
	 */
	async downloadFile(
		remotePath: string,
		raw = false,
		budget = this.createDownloadBudget(),
	): Promise<ArrayBuffer> {
		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			const downloadLink = await this.getDownloadLink(
				remotePath,
				raw,
				budget,
			);
			let response: RequestUrlResponse | undefined;
			const startedAt = Date.now();
			logger.debug("Download transfer started", {
				attempt: attempt + 1,
				timeoutMs: this.readTimeoutMs,
			});
			try {
				response = await this.requestRead(
					{
						url: downloadLink.href,
						method: "GET",
						throw: false,
					},
					"download transfer",
					budget,
				);
			} catch (error) {
				logger.warn("Download transfer failed", {
					attempt: attempt + 1,
					durationMs: Date.now() - startedAt,
					kind: isRemoteReadTimeout(error) ? "timeout" : "network",
				});
				this.remainingReadTime(budget, "download transfer");
				if (
					!this.recovery(
						error,
						"read",
						this.maxRetries - attempt,
						budget,
					).retry
				) {
					throw error;
				}
			}
			if (response) {
				if (response.status >= 200 && response.status < 300) {
					logger.debug("Download transfer completed", {
						attempt: attempt + 1,
						durationMs: Date.now() - startedAt,
						size: response.arrayBuffer.byteLength,
						status: response.status,
					});
					const result = raw
						? response.arrayBuffer
						: await this.decryptContent(response.arrayBuffer);
					this.remainingReadTime(budget, "download decode");
					logger.debug(`Downloaded file: ${remotePath}`);
					return result;
				}
				if (
					!this.recovery(
						new YandexApiError("Download failed", response.status),
						"read",
						this.maxRetries - attempt,
						budget,
					).retry
				) {
					const message = `Download HTTP ${response.status}`;
					if (response.status === 401 || response.status === 403) {
						throw new YandexApiError(message, response.status);
					}
					// A signed-link 404 does not prove that the API resource is absent.
					throw withFailureContext(
						new RemoteHttpError(message, response.status),
						{
							stage: "download",
							action: "read",
							requestState: "completed",
						},
					);
				}
			}
			const delay = this.getRetryDelay(attempt);
			logger.warn("Download transfer interrupted; retrying", {
				attempt: attempt + 1,
				delay,
				status: response?.status,
			});
			await this.waitBeforeRetry(delay, attempt, "download", budget);
		}
		throw new Error("Download failed");
	}

	/**
	 * Decode already downloaded service-file bytes with an explicit codec.
	 * Passing undefined uses the currently configured codec, while null means
	 * plaintext. This keeps index rollback snapshots byte-identical.
	 */
	async decodeServiceFileContent(
		raw: ArrayBuffer,
		service?: EncryptionCodec | null,
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
		service: EncryptionCodec | null,
		overwrite = true,
	): Promise<void> {
		const plain = new TextEncoder().encode(content).buffer;
		const encoded = service ? await service.encrypt(plain) : plain;
		await this.uploadFile(remotePath, encoded, true, true, overwrite);
	}

	/**
	 * Delete file or folder.
	 * When `raw` is true, skips path encryption.
	 */
	async deleteResource(
		path: string,
		permanently = false,
		raw = false,
		beforeAttempt?: () => Promise<void>,
	): Promise<void> {
		const targetPath = raw ? path : await this.encryptFilePath(path);
		const encodedPath = encodePathForUrl(targetPath);
		let preflightFailed = false;
		let deleteAccepted = false;
		const revalidate = beforeAttempt
			? async () => {
					try {
						await beforeAttempt();
					} catch (error) {
						preflightFailed = true;
						throw error;
					}
				}
			: undefined;
		try {
			const response = await this.request(
				"DELETE",
				`/resources?path=${encodedPath}&permanently=${permanently}`,
				undefined,
				revalidate,
			);
			deleteAccepted = true;
			await this.waitForAsyncOperation(response);
			this.invalidateFolder(targetPath);
			logger.debug(`Deleted resource: ${path}`);
		} catch (e: unknown) {
			// Only the DELETE response can prove absence, never a guard or polling failure.
			if (preflightFailed || deleteAccepted || !this.isNotFoundError(e)) {
				throw e;
			}
			this.invalidateFolder(targetPath);
		}
	}

	/**
	 * Move/rename resource
	 */
	async moveResource(
		fromPath: string,
		toPath: string,
		overwrite = false,
	): Promise<void> {
		const encryptedFrom = await this.encryptFilePath(fromPath);
		const encryptedTo = await this.encryptFilePath(toPath);
		const encodedFrom = encodePathForUrl(encryptedFrom);
		const encodedTo = encodePathForUrl(encryptedTo);

		// Ensure target folder exists — derive parent from the encrypted path.
		const parentPath = encryptedTo.substring(
			0,
			encryptedTo.lastIndexOf("/"),
		);
		if (parentPath) {
			await this.createFolderRecursive(parentPath);
		}

		const response = await this.request(
			"POST",
			`/resources/move?from=${encodedFrom}&path=${encodedTo}&overwrite=${overwrite}`,
		);
		await this.waitForAsyncOperation(response);
		this.invalidateFolder(encryptedFrom);
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
		body?: unknown,
		beforeAttempt?: () => Promise<void>,
		budget?: DownloadReadBudget,
	): Promise<RequestUrlResponse> {
		const url = `${API_BASE_URL}${endpoint}`;
		const endpointName = endpoint.split("?", 1)[0] ?? endpoint;

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
			if (beforeAttempt) {
				await beforeAttempt();
			}
			if (method !== "GET") {
				await this.writeGuard?.();
			}
			const startedAt = Date.now();
			try {
				if (method === "GET") {
					this.recordApiRead(endpoint);
				}
				logger.debug(`API request: ${method} ${endpointName}`, {
					attempt: attempt + 1,
					maxRetries: this.maxRetries,
				});

				const response =
					method === "GET"
						? await this.requestRead(
								params,
								`API ${method} ${endpointName}`,
								budget,
							)
						: await this.requestNative(params);

				// Successful statuses
				if (response.status >= 200 && response.status < 300) {
					logger.debug(
						`API response: ${method} ${endpointName} -> ${response.status}`,
					);
					return response;
				}

				const errorData = this.readProviderError(response);
				const failure = new YandexApiError(
					errorData?.description || `HTTP ${response.status}`,
					response.status,
					errorData?.error,
				);
				const diagnostic = new OperationFailure(failure, {
					stage: `API ${method} ${endpointName}`,
					durationMs: Date.now() - startedAt,
					action: method === "GET" ? "read" : "write",
				});
				logger.debug("API response failed", {
					failure: diagnostic.summary,
					attempt: attempt + 1,
				});
				if (
					this.recovery(
						failure,
						method === "GET" ? "read" : "write",
						this.maxRetries - attempt,
						budget,
					).retry
				) {
					lastError = failure;
					const delay = this.getRetryDelay(attempt);
					logger.warn("Retrying API request", {
						failure: diagnostic.summary,
						attempt: attempt + 1,
						delay,
					});
					await this.waitBeforeRetry(
						delay,
						attempt,
						`API ${method} ${endpointName}`,
						budget,
					);
					continue;
				}
				throw withFailureContext(failure, {
					stage: `API ${method} ${endpointName}`,
					action: method === "GET" ? "read" : "write",
					requestState: "completed",
				});
			} catch (e) {
				if (e instanceof YandexApiError || isRemoteReadTimeout(e)) {
					throw e;
				}
				this.remainingReadTime(budget, `API ${method} ${endpointName}`);
				lastError = e as Error;

				logger.error(`API request failed: ${method} ${endpointName}`, {
					attempt: attempt + 1,
					error: (e as Error).message,
				});

				if (
					this.recovery(
						e,
						method === "GET" ? "read" : "write",
						this.maxRetries - attempt,
						budget,
					).retry
				) {
					const delay = this.getRetryDelay(attempt);
					logger.warn(`Network error, retry in ${delay}ms:`);
					await this.waitBeforeRetry(
						delay,
						attempt,
						`API ${method} ${endpointName}`,
						budget,
					);
				} else {
					throw e;
				}
			}
		}

		throw lastError || new Error("Unknown error");
	}

	/** HTTP status remains authoritative when an optional provider error body is not JSON. */
	private readProviderError(
		response: RequestUrlResponse,
	): YandexError | undefined {
		try {
			return response.json as YandexError;
		} catch {
			return undefined;
		}
	}

	/** Isolate native rejection from application and provider response parsing failures. */
	private async requestNative(
		params: RequestUrlParam,
	): Promise<RequestUrlResponse> {
		try {
			return await requestUrl(params);
		} catch (error) {
			throw new NetworkRequestError(error);
		}
	}

	private recovery(
		error: unknown,
		action: "read" | "write" | "put" | "poll",
		attemptsRemaining: number,
		budget?: DownloadReadBudget,
	) {
		return decideRecovery(
			new OperationFailure(error, { stage: "transport", action }),
			{
				attemptsRemaining,
				remainingMs: budget ? budget.deadline - Date.now() : Infinity,
			},
		);
	}

	/** Bound read waiting without retrying an unresolved native request or applying its late result. */
	private async requestRead(
		params: RequestUrlParam,
		operation: string,
		budget?: DownloadReadBudget,
	): Promise<RequestUrlResponse> {
		const timeoutMs = Math.min(
			this.readTimeoutMs,
			this.remainingReadTime(budget, operation),
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const response = await Promise.race([
				this.requestNative(params),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() =>
							reject(
								new RemoteReadTimeoutError(
									timeoutMs,
									operation,
								),
							),
						timeoutMs,
					);
				}),
			]);
			this.remainingReadTime(budget, operation);
			return response;
		} finally {
			clearTimeout(timer);
		}
	}

	/** Share one wall-clock deadline across a stable snapshot and its retries. */
	createDownloadBudget(): DownloadReadBudget {
		return {
			deadline: Date.now() + this.downloadTimeoutMs,
			timeoutMs: this.downloadTimeoutMs,
		};
	}

	private remainingReadTime(
		budget: DownloadReadBudget | undefined,
		operation: string,
	): number {
		if (!budget) {
			return this.readTimeoutMs;
		}
		const remaining = budget.deadline - Date.now();
		if (remaining <= 0) {
			throw new RemoteReadTimeoutError(budget.timeoutMs, operation);
		}
		return remaining;
	}

	/** Presentation must never change transport success, retry count or budget. */
	private async waitBeforeRetry(
		delayMs: number,
		attempt: number,
		stage: string,
		budget?: DownloadReadBudget,
	): Promise<void> {
		const notify = (progress?: RetryProgress) => {
			try {
				this.retryCallback?.(progress);
			} catch (error) {
				logger.warn("Retry presentation failed", { error });
			}
		};
		notify({
			stage,
			attempt: attempt + 2,
			maxAttempts: stage === "polling" ? 120 : this.maxRetries + 1,
			delayMs,
		});
		try {
			await this.sleepBeforeReadRetry(delayMs, budget);
		} finally {
			notify();
		}
	}

	/** Backoff consumes the same budget, without starting another native read. */
	private async sleepBeforeReadRetry(
		delay: number,
		budget?: DownloadReadBudget,
	): Promise<void> {
		const remaining = this.remainingReadTime(budget, "download retry");
		await this.sleep(budget ? Math.min(delay, remaining) : delay);
		this.remainingReadTime(budget, "download retry");
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

	/**
	 * Wait for a server-side operation returned as HTTP 202.
	 */
	private async waitForAsyncOperation(
		response: RequestUrlResponse,
	): Promise<void> {
		if (response.status !== 202) {
			return;
		}
		const href = (response.json as { href?: unknown } | null)?.href;
		if (typeof href !== "string" || !href) {
			return;
		}
		const operationUrl = href.startsWith("http")
			? href
			: `${API_BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;

		for (let attempt = 0; attempt < 120; attempt++) {
			const operationResponse = await this.requestRead(
				{
					url: operationUrl,
					method: "GET",
					headers: {
						Authorization: `OAuth ${this.token}`,
					},
					throw: false,
				},
				"operation status",
			);
			if (
				operationResponse.status < 200 ||
				operationResponse.status >= 300
			) {
				if (
					this.recovery(
						new YandexApiError(
							"Operation polling failed",
							operationResponse.status,
						),
						"poll",
						119 - attempt,
					).retry
				) {
					await this.waitBeforeRetry(
						this.getRetryDelay(attempt % 4),
						attempt,
						"polling",
					);
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
				typeof rawStatus === "string" ? rawStatus.toLowerCase() : "";
			if (status === "success") {
				return;
			}
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
