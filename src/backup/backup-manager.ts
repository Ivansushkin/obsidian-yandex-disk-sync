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

export interface BackupResult {
	success: boolean;
	backupName?: string;
	fileCount: number;
	totalSize: number;
	remoteFingerprint?: string;
	error?: string;
}

/**
 * Manages creation and storage of vault backups
 */
export class BackupManager {
	private yandexClient: YandexDiskClient;
	private vaultAdapter: VaultAdapter;
	private settings: YandexDiskSyncSettings;

	constructor(
		yandexClient: YandexDiskClient,
		vaultAdapter: VaultAdapter,
		settings: YandexDiskSyncSettings,
	) {
		this.yandexClient = yandexClient;
		this.vaultAdapter = vaultAdapter;
		this.settings = settings;
	}

	/**
	 * Create backup of all synchronized files
	 */
	async createBackup(): Promise<BackupResult> {
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

			// Generate backup filename. Include `.enc` in the name when
			// encryption is active so downloadBackup can choose the correct
			// raw mode without decrypting plaintext or skipping encrypted
			// content.
			const backupName = this.formatBackupName(
				this.yandexClient.hasEncryptionService(),
			);

			// Upload to Yandex Disk
			const backupPath = joinPath(
				this.settings.remotePath,
				".backup",
				backupName,
			);
			await this.yandexClient.uploadFile(backupPath, zipContent);
			const fingerprint = await this.verifyBackupUpload(backupPath);

			logger.info("Backup upload verified", {
				backupName,
				fileCount: files.length,
				totalSize,
				remoteFingerprint: fingerprint,
			});

			return {
				success: true,
				backupName,
				fileCount: files.length,
				totalSize,
				remoteFingerprint: fingerprint,
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
	async createRemoteSnapshotBackup(): Promise<BackupResult> {
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
			const backupName = this.formatBackupName(
				this.yandexClient.hasEncryptionService(),
			);
			const backupPath = joinPath(
				this.settings.remotePath,
				".backup",
				backupName,
			);
			await this.yandexClient.uploadFile(backupPath, zipContent);
			const fingerprint = await this.verifyBackupUpload(backupPath);
			logger.info("Remote snapshot backup upload verified", {
				backupName,
				rawObjectCount: files.length,
				totalSize,
				remoteFingerprint: fingerprint,
			});
			return {
				success: true,
				backupName,
				fileCount: files.length,
				totalSize,
				remoteFingerprint: fingerprint,
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

	private async verifyBackupUpload(backupPath: string): Promise<string> {
		const resource = await this.yandexClient.getResource(
			backupPath,
			1,
			0,
			true,
		);
		const fingerprint = resource
			? resource.md5 ||
				resource.sha256 ||
				resource.resource_id ||
				resource.modified
			: null;
		if (!resource || resource.type !== "file" || !fingerprint) {
			throw new Error(
				"Backup upload could not be confirmed on Yandex Disk",
			);
		}
		return fingerprint;
	}

	/**
	 * Format backup filename with current timestamp
	 */
	private formatBackupName(encrypted: boolean): string {
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const hours = String(now.getHours()).padStart(2, "0");
		const minutes = String(now.getMinutes()).padStart(2, "0");
		const seconds = String(now.getSeconds()).padStart(2, "0");
		const suffix = encrypted ? ".enc" : "";

		return `backup_${year}-${month}-${day}_${hours}-${minutes}-${seconds}${suffix}.zip`;
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
		// Matches both `backup_YYYY-MM-DD_HH-MM-SS.zip` (plaintext)
		// and `backup_YYYY-MM-DD_HH-MM-SS.enc.zip` (encrypted).
		const match = name.match(
			/^backup_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:\.enc)?\.zip$/,
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
			logger.error("Error listing backups:", { error });
			throw error;
		}
	}

	/**
	 * Download backup file to local device
	 */
	async downloadBackup(backupPath: string): Promise<ArrayBuffer> {
		// Determine the download mode from the filename: `.enc.zip` was
		// encrypted at creation time and needs decryption (raw=false);
		// plain `.zip` was stored as plaintext and must be downloaded
		// raw to avoid a futile decrypt attempt on non-encrypted bytes.
		const isEncrypted = backupPath.includes(".enc.zip");
		try {
			logger.info(`Starting backup download: ${backupPath}`);
			if (isEncrypted && !this.yandexClient.hasEncryptionService()) {
				throw new Error(t("notice.backup_encrypted_no_key"));
			}
			const content = await this.yandexClient.downloadFile(
				backupPath,
				!isEncrypted,
			);
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
}
