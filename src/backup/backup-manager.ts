/**
 * Backup manager for creating and managing vault backups
 */

import JSZip from "jszip";
import type { YandexDiskSyncSettings, BackupInfo } from "../types";
import { YandexDiskClient, YandexApiError } from "../api/yandex-client";
import { VaultAdapter } from "../api/vault-adapter";
import { joinPath, toLocalPath } from "../utils/path-utils";
import { logger } from "../utils/logger";
import { t } from "../i18n";
import { computeSha256 } from "../utils/hash-utils";
import {
	BackupEnvelopeAuthenticationError,
	isBackupEnvelope,
	openBackupEnvelope,
	sealBackupEnvelope,
} from "./backup-envelope";

export interface BackupResult {
	success: boolean;
	backupName?: string;
	fileCount: number;
	totalSize: number;
	remoteFingerprint?: string;
	sha256?: string;
	error?: string;
}

export class BackupPasswordRequiredError extends Error {
	constructor() {
		super("A password is required to open this backup");
		this.name = "BackupPasswordRequiredError";
	}
}

/**
 * Manages creation and storage of vault backups
 */
export class BackupManager {
	private yandexClient: YandexDiskClient;
	private vaultAdapter: VaultAdapter;
	private settings: YandexDiskSyncSettings;
	private readonly pluginVersion: string;

	constructor(
		yandexClient: YandexDiskClient,
		vaultAdapter: VaultAdapter,
		settings: YandexDiskSyncSettings,
		pluginVersion = "unknown",
	) {
		this.yandexClient = yandexClient;
		this.vaultAdapter = vaultAdapter;
		this.settings = settings;
		this.pluginVersion = pluginVersion;
	}

	/**
	 * Create backup of all synchronized files
	 */
	async createBackup(passwordOverride?: string): Promise<BackupResult> {
		try {
			logger.info("Starting backup creation...");

			// Get list of files to backup
			const files = this.vaultAdapter.getAllSyncableFiles();
			logger.info(`Found ${files.length} files to backup`);

			// Create ZIP archive
			const zip = new JSZip();
			let totalSize = 0;

			for (const file of files) {
				try {
					const content = await this.vaultAdapter.readFile(file.path);
					zip.file(file.path, content);
					totalSize += content.byteLength;
				} catch (error) {
					logger.warn(
						`Failed to read file for backup: ${file.path}`,
						{ error },
					);
					throw error;
				}
			}

			// Generate ZIP content
			const zipContent = await zip.generateAsync({
				type: "arraybuffer",
				compression: "DEFLATE",
				compressionOptions: { level: 6 },
			});

			const password =
				passwordOverride ??
				(this.yandexClient.hasEncryptionService()
					? (this.settings.encryptionPassword ?? undefined)
					: undefined);
			const createdAt = Date.now();
			const uploadContent = password
				? await sealBackupEnvelope(zipContent, password, {
						kind: "logical-vault",
						createdAt,
						pluginVersion: this.pluginVersion,
						fileCount: files.length,
					})
				: zipContent;
			const uploaded = await this.uploadVerifiedBackup(
				uploadContent,
				Boolean(password),
				createdAt,
			);

			logger.info("Backup upload verified", {
				backupName: uploaded.backupName,
				fileCount: files.length,
				totalSize,
				remoteFingerprint: uploaded.remoteFingerprint,
				sha256: uploaded.sha256,
			});

			return {
				success: true,
				backupName: uploaded.backupName,
				fileCount: files.length,
				totalSize,
				remoteFingerprint: uploaded.remoteFingerprint,
				sha256: uploaded.sha256,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error("Backup creation failed:", { error });

			return {
				success: false,
				fileCount: 0,
				totalSize: 0,
				error: errorMessage,
			};
		}
	}

	/**
	 * Back up the raw remote snapshot before Force local replaces its epoch.
	 * Raw ciphertext and service metadata make this independent from a
	 * potentially ambiguous canonical index.
	 */
	async createRemoteSnapshotBackup(
		passwordOverride?: string,
	): Promise<BackupResult> {
		try {
			const resources =
				await this.yandexClient.getResourcesRecursive(
					this.settings.remotePath,
					true,
				);
			const files = resources.filter((resource) => {
				if (resource.type !== "file") return false;
				const relative = toLocalPath(
					resource.path,
					this.settings.remotePath,
				);
				return (
					relative !== ".backup" &&
					!relative.startsWith(".backup/")
				);
			});
			const zip = new JSZip();
			let totalSize = 0;
			for (const file of files) {
				const relative = toLocalPath(
					file.path,
					this.settings.remotePath,
				);
				const content = await this.yandexClient.downloadFile(
					file.path,
					true,
				);
				zip.file(`remote-raw/${relative}`, content);
				totalSize += content.byteLength;
			}
			const zipContent = await zip.generateAsync({
				type: "arraybuffer",
				compression: "DEFLATE",
				compressionOptions: { level: 6 },
			});
			const password =
				passwordOverride ??
				(this.yandexClient.hasEncryptionService()
					? (this.settings.encryptionPassword ?? undefined)
					: undefined);
			const createdAt = Date.now();
			const uploadContent = password
				? await sealBackupEnvelope(zipContent, password, {
						kind: "remote-raw",
						createdAt,
						pluginVersion: this.pluginVersion,
						fileCount: files.length,
					})
				: zipContent;
			const uploaded = await this.uploadVerifiedBackup(
				uploadContent,
				Boolean(password),
				createdAt,
			);
			logger.info("Remote snapshot backup upload verified", {
				backupName: uploaded.backupName,
				rawObjectCount: files.length,
				totalSize,
				remoteFingerprint: uploaded.remoteFingerprint,
				sha256: uploaded.sha256,
			});
			return {
				success: true,
				backupName: uploaded.backupName,
				fileCount: files.length,
				totalSize,
				remoteFingerprint: uploaded.remoteFingerprint,
				sha256: uploaded.sha256,
			};
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			logger.error("Remote snapshot backup failed:", { error });
			return {
				success: false,
				fileCount: 0,
				totalSize: 0,
				error: message,
			};
		}
	}

	private async uploadVerifiedBackup(
		content: ArrayBuffer,
		encrypted: boolean,
		createdAt: number,
	): Promise<{
		backupName: string;
		remoteFingerprint: string;
		sha256: string;
	}> {
		const expectedSha256 = await computeSha256(content);
		let lastError: Error | null = null;
		for (let attempt = 0; attempt < 3; attempt++) {
			let uploadError: unknown;
			let readbackError: unknown;
			const backupName = this.formatBackupName(
				new Date(createdAt),
				encrypted,
			);
			const backupPath = joinPath(
				this.settings.remotePath,
				".backup",
				backupName,
			);
			try {
				await this.yandexClient.uploadFileExclusive(
					backupPath,
					content,
					false,
					true,
				);
			} catch (error) {
				uploadError = error;
			}

			try {
				const readback =
					await this.yandexClient.downloadStableRawFile(backupPath);
				if (readback) {
					const actualSha256 = await computeSha256(readback.raw);
					if (
						actualSha256 === expectedSha256 &&
						bytesEqual(readback.raw, content)
					) {
						return {
							backupName,
							remoteFingerprint: readback.fingerprint,
							sha256: expectedSha256,
						};
					}
				}
			} catch (error) {
				readbackError = error;
			}
			if (readbackError) throw normalizeError(readbackError);

			if (
				uploadError instanceof YandexApiError &&
				![408, 409, 423, 429, 500, 502, 503, 504].includes(
					uploadError.status,
				)
			) {
				throw normalizeError(uploadError);
			}
			lastError = new Error("Backup name collision or byte mismatch");
		}
		throw lastError ?? new Error("Backup upload could not be verified");
	}

	/**
	 * Format backup filename with current timestamp
	 */
	private formatBackupName(now: Date, encrypted: boolean): string {
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const hours = String(now.getHours()).padStart(2, "0");
		const minutes = String(now.getMinutes()).padStart(2, "0");
		const seconds = String(now.getSeconds()).padStart(2, "0");
		const milliseconds = String(now.getMilliseconds()).padStart(3, "0");
		const random = randomBase64Url(12);
		const suffix = encrypted ? ".enc" : "";

		return `backup_${year}-${month}-${day}_${hours}-${minutes}-${seconds}-${milliseconds}_${random}${suffix}.zip`;
	}

	/**
	 * Update settings
	 */
	updateSettings(settings: YandexDiskSyncSettings): void {
		this.settings = settings;
	}

	/**
	 * Parse backup filename to extract creation date
	 */
	private parseBackupName(name: string): Date | null {
		// Accept historical second-resolution names and v2 random-suffix names.
		const match = name.match(
			/^backup_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-(\d{3})_[A-Za-z0-9_-]{16})?(?:\.enc)?\.zip$/,
		);
		if (!match || match.length < 7) {
			return null;
		}

		const year = match[1]!;
		const month = match[2]!;
		const day = match[3]!;
		const hours = match[4]!;
		const minutes = match[5]!;
		const seconds = match[6]!;

		const date = new Date(
			parseInt(year, 10),
			parseInt(month, 10) - 1,
			parseInt(day, 10),
			parseInt(hours, 10),
			parseInt(minutes, 10),
			parseInt(seconds, 10),
			match[7] ? parseInt(match[7], 10) : 0,
		);

		return isNaN(date.getTime()) ? null : date;
	}

	/**
	 * List all available backups from the .backup folder
	 */
	async listBackups(): Promise<BackupInfo[]> {
		try {
			const backupFolder = joinPath(this.settings.remotePath, ".backup");
			logger.info(`Fetching backup list from: ${backupFolder}`);

			// raw=true: .backup is a protected path — filenames are always
			// plaintext timestamps and never need decryption. Skipping
			// decryptResource avoids unnecessary crypto attempts per file.
			const resources = await this.yandexClient.getResourcesRecursive(
				backupFolder,
				true,
			);
			const backups: BackupInfo[] = [];

			for (const resource of resources) {
				// Only process files with .zip extension
				if (
					resource.type !== "file" ||
					!resource.name.endsWith(".zip")
				) {
					continue;
				}

				const created = this.parseBackupName(resource.name);
				if (!created) {
					logger.warn(
						`Invalid backup filename format: ${resource.name}`,
					);
					continue;
				}

				backups.push({
					name: resource.name,
					created,
					size: resource.size || 0,
					remotePath: resource.path,
				});
			}

			// Sort by creation date (newest first)
			backups.sort((a, b) => b.created.getTime() - a.created.getTime());

			logger.info(`Found ${backups.length} backups`);
			return backups;
		} catch (error) {
			if (error instanceof YandexApiError && error.status === 404) {
				logger.info("Backup folder does not exist yet");
				return [];
			}
			throw error;
		}
	}

	/**
	 * Download backup file to local device
	 */
	async downloadBackup(
		backupPath: string,
		password?: string,
	): Promise<ArrayBuffer> {
		const isEncrypted = backupPath.includes(".enc.zip");
		try {
			logger.info(`Starting backup download: ${backupPath}`);
			const raw = await this.yandexClient.downloadFile(backupPath, true);
			if (isBackupEnvelope(raw)) {
				const effectivePassword =
					password ?? this.settings.encryptionPassword ?? undefined;
				if (!effectivePassword) throw new BackupPasswordRequiredError();
				try {
					return (
						await openBackupEnvelope(raw, effectivePassword)
					).content;
				} catch (error) {
					if (!(error instanceof BackupEnvelopeAuthenticationError)) {
						throw error;
					}
					logger.warn("Backup envelope password verification failed", {
						error,
					});
					throw new BackupPasswordRequiredError();
				}
			}
			if (isEncrypted && !this.yandexClient.hasEncryptionService()) {
				throw new Error(t("notice.backup_encrypted_no_key"));
			}
			const content = isEncrypted
				? await this.yandexClient.decodeServiceFileContent(raw)
				: raw;
			logger.info("Backup downloaded successfully");
			return content;
		} catch (error) {
			// If the backup is encrypted and the download attempt was made
			// (encryption service was active), a decrypt failure likely means
			// the backup was created with a different key — e.g. before a
			// password rotation. Surface a clear message.
			if (
				isEncrypted &&
				!(
					error instanceof Error &&
					error.message === t("notice.backup_encrypted_no_key")
				)
			) {
				const isCryptoError =
					error instanceof DOMException ||
					(error instanceof Error &&
						/decrypt|crypto|aes|gcm|auth/i.test(error.message));
				if (isCryptoError) {
					throw new Error(t("notice.backup_old_key"));
				}
			}
			logger.error("Error downloading backup:", { error });
			throw error;
		}
	}

	getSuggestedDownloadName(name: string): string {
		return name.replace(/\.enc\.zip$/, ".zip");
	}
}

function bytesEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
	if (left.byteLength !== right.byteLength) return false;
	const a = new Uint8Array(left);
	const b = new Uint8Array(right);
	return a.every((byte, index) => byte === b[index]);
}

function randomBase64Url(byteLength: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function normalizeError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
