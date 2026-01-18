/**
 * Backup manager for creating and managing vault backups
 */

import JSZip from 'jszip';
import type {
	YandexDiskSyncSettings,
} from '../types';
import { YandexDiskClient } from '../api/yandex-client';
import { VaultAdapter } from '../api/vault-adapter';
import type { IndexManager } from '../sync/index-manager';
import { joinPath } from '../utils/path-utils';
import { logger } from '../utils/logger';

export interface BackupResult {
	success: boolean;
	backupName?: string;
	fileCount: number;
	totalSize: number;
	error?: string;
}

/**
 * Manages creation and storage of vault backups
 */
export class BackupManager {
	private yandexClient: YandexDiskClient;
	private vaultAdapter: VaultAdapter;
	private indexManager: IndexManager;
	private settings: YandexDiskSyncSettings;

	constructor(
		yandexClient: YandexDiskClient,
		vaultAdapter: VaultAdapter,
		indexManager: IndexManager,
		settings: YandexDiskSyncSettings
	) {
		this.yandexClient = yandexClient;
		this.vaultAdapter = vaultAdapter;
		this.indexManager = indexManager;
		this.settings = settings;
	}

	/**
	 * Create backup of all synchronized files
	 */
	async createBackup(): Promise<BackupResult> {
		try {
			logger.info('Starting backup creation...');

			// Get list of files to backup
			const files = await this.vaultAdapter.getAllSyncableFiles();
			logger.info(`Found ${files.length} files to backup`);

			if (files.length === 0) {
				return {
					success: false,
					fileCount: 0,
					totalSize: 0,
					error: 'No files to backup',
				};
			}

			// Create ZIP archive
			const zip = new JSZip();
			let totalSize = 0;

			for (const file of files) {
				try {
					const content = await this.vaultAdapter.readFile(file.path);
					zip.file(file.path, content);
					totalSize += content.byteLength;
				} catch (error) {
					logger.warn(`Failed to read file for backup: ${file.path}`, error);
					// Continue with other files
				}
			}

			// Generate ZIP content
			const zipContent = await zip.generateAsync({
				type: 'arraybuffer',
				compression: 'DEFLATE',
				compressionOptions: { level: 6 },
			});

			// Generate backup filename
			const backupName = this.formatBackupName();

			// Upload to Yandex Disk
			const backupPath = joinPath(this.settings.remotePath, '.backup', backupName);
			await this.yandexClient.uploadFile(backupPath, zipContent);

			logger.info(`Backup created successfully: ${backupName} (${files.length} files, ${totalSize} bytes)`);

			// Update backup time in index and save it
			const backupTime = Date.now();
			this.indexManager.setLastBackupTime(backupTime);
			await this.indexManager.saveRemoteIndex();

			return {
				success: true,
				backupName,
				fileCount: files.length,
				totalSize,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error('Backup creation failed:', error);

			return {
				success: false,
				fileCount: 0,
				totalSize: 0,
				error: errorMessage,
			};
		}
	}

	/**
	 * Format backup filename with current timestamp
	 */
	private formatBackupName(): string {
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, '0');
		const day = String(now.getDate()).padStart(2, '0');
		const hours = String(now.getHours()).padStart(2, '0');
		const minutes = String(now.getMinutes()).padStart(2, '0');
		const seconds = String(now.getSeconds()).padStart(2, '0');

		return `backup_${year}-${month}-${day}_${hours}-${minutes}-${seconds}.zip`;
	}

	/**
	 * Update settings
	 */
	updateSettings(settings: YandexDiskSyncSettings): void {
		this.settings = settings;
	}
}