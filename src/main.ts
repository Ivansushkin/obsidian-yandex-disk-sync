/**
 * Yandex Disk Sync Plugin for Obsidian
 * File synchronization with Yandex Disk
 */

import { Notice, Plugin } from "obsidian";
import {
	YandexDiskSyncSettings,
	DEFAULT_SETTINGS,
	SyncIndex,
} from "./types";
import { YandexDiskSyncSettingTab } from "./settings";
import { YandexDiskClient } from "./api/yandex-client";
import { VaultAdapter } from "./api/vault-adapter";
import { IndexManager } from "./sync/index-manager";
import { SyncEngine } from "./sync/sync-engine";
import { FileWatcher } from "./sync/file-watcher";
import { SyncScheduler } from "./sync/sync-scheduler";
import { SyncStatusBar } from "./ui/status-bar";
import { SyncStatusModal, ConfirmModal } from "./ui/init-modal";
import { ForceSyncModal } from "./ui/force-sync-modal";
import { PasswordPromptModal } from "./ui/encryption-modals";
import { BackupManager } from "./backup/backup-manager";
import { generateDeviceId, joinPath } from "./utils/path-utils";
import { logger } from "./utils/logger";
import { initI18n, t } from "./i18n";
import { EncryptionService } from "./crypto/encryption";

interface PluginData {
	settings: YandexDiskSyncSettings;
	localIndex: Partial<SyncIndex> | null;
	lastSyncStats: {
		uploaded: number;
		downloaded: number;
		deleted: number;
		errors: number;
	};
}

export default class YandexDiskSyncPlugin extends Plugin {
	settings: YandexDiskSyncSettings = DEFAULT_SETTINGS;

	private yandexClient!: YandexDiskClient;
	private vaultAdapter!: VaultAdapter;
	private indexManager!: IndexManager;
	private syncEngine!: SyncEngine;
	private fileWatcher!: FileWatcher;
	private syncScheduler!: SyncScheduler;
	private backupManager!: BackupManager;
	private statusBar: SyncStatusBar | null = null;
	private sidebarButton: HTMLElement | null = null;

	private lastSyncStats = {
		uploaded: 0,
		downloaded: 0,
		deleted: 0,
		errors: 0,
	};

	private isInitialized = false;
	private encryptionService: EncryptionService | null = null;

	async onload(): Promise<void> {
		// Initialize i18n service
		initI18n();

		logger.info("Loading Yandex Disk Sync plugin...");

		// Load settings
		await this.loadSettings();

		// Generate device ID if missing
		if (!this.settings.deviceId) {
			this.settings.deviceId = generateDeviceId();
			await this.saveSettings();
		}

		// Initialize components
		this.initializeComponents();

		// Register settings tab
		this.addSettingTab(new YandexDiskSyncSettingTab(this.app, this));

		// Register commands
		this.registerCommands();

		// Create status bar and sidebar button
		this.createStatusBar();
		this.createSyncSidebarButton();

		// Wait for layout ready to start synchronization
		this.app.workspace.onLayoutReady(() => {
			void this.onLayoutReady();
		});

		logger.info("Yandex Disk Sync plugin loaded");
	}

	onunload(): void {
		logger.info("Unloading Yandex Disk Sync plugin...");

		// Stop components
		if (this.fileWatcher) {
			this.fileWatcher.stop();
		}
		if (this.syncScheduler) {
			this.syncScheduler.stop();
		}
		if (this.statusBar) {
			this.statusBar.destroy();
		}
		if (this.sidebarButton) {
			this.sidebarButton.remove();
			this.sidebarButton = null;
		}

		// Save index (sync version - onunload is not async)
		void this.saveData({
			settings: this.settings,
			localIndex: this.indexManager?.getLocalIndex() ?? null,
			lastSyncStats: this.lastSyncStats,
		} as PluginData);

		logger.info("Yandex Disk Sync plugin unloaded");
	}

	/**
	 * Initialize components
	 */
	private initializeComponents(): void {
		// Create API client
		this.yandexClient = new YandexDiskClient({
			token: this.settings.yandexTokenSecret,
		});

		// Create vault adapter
		this.vaultAdapter = new VaultAdapter(this.app, this.settings);

		// Create index manager
		this.indexManager = new IndexManager(
			this.yandexClient,
			this.vaultAdapter,
			this.settings
		);

		// Create sync engine
		this.syncEngine = new SyncEngine(
			this.yandexClient,
			this.vaultAdapter,
			this.indexManager,
			this.settings
		);

		// Set callback for saving local index after auto-sync operations
		this.syncEngine.setIndexSaveCallback(async () => {
			await this.saveLocalIndex();
		});

		// Create file watcher
		this.fileWatcher = new FileWatcher(
			this.app,
			this.syncEngine,
			this.settings
		);

		// Create sync scheduler
		this.syncScheduler = new SyncScheduler(this.syncEngine, this.settings);

		// Create backup manager
		this.backupManager = new BackupManager(
			this.yandexClient,
			this.vaultAdapter,
			this.indexManager,
			this.settings
		);

		// Initialize encryption if enabled
		void this.initEncryption();
	}

	/**
	 * Create status bar
	 */
	private createStatusBar(): void {
		const statusBarEl = this.addStatusBarItem();
		this.statusBar = new SyncStatusBar(statusBarEl, this.syncEngine);
	}

	/**
	 * Add manual sync trigger button to sidebar
	 */
	private createSyncSidebarButton(): void {
		const button = this.addRibbonIcon(
			"refresh-cw",
			t("command.sync_now"),
			() => {
				void this.runFullSync();
			}
		);
		button.addClass("yandex-sync-sidebar-button");
		this.sidebarButton = button;
	}

	/**
	 * Register commands
	 */
	private registerCommands(): void {
		// Sync now
		this.addCommand({
			id: "sync-now",
			name: t("command.sync_now"),
			callback: async () => {
				await this.runFullSync();
			},
		});

		// Toggle sync
		this.addCommand({
			id: "toggle-sync",
			name: t("command.toggle_sync"),
			callback: () => {
				if (this.syncEngine.isSyncPaused()) {
					this.syncEngine.resume();
					this.fileWatcher.start();
					this.syncScheduler.start();
					new Notice(t("notice.sync_resumed"));
				} else {
					this.syncEngine.pause();
					this.fileWatcher.stop();
					this.syncScheduler.stop();
					new Notice(t("notice.sync_paused"));
				}
			},
		});

		// Show status
		this.addCommand({
			id: "show-status",
			name: t("command.show_status"),
			callback: () => {
				const state = this.syncEngine.getState();
				new SyncStatusModal(this.app, {
					lastSyncTime: state.lastSyncTime,
					...this.lastSyncStats,
				}).open();
			},
		});
	}

	/**
	 * Callback when layout is ready
	 */
	private async onLayoutReady(): Promise<void> {
		// Check if token is configured
		if (!this.settings.yandexTokenSecret) {
			logger.info("Token not configured, waiting for settings");
			return;
		}

		// Check remote for encryption salt before loading index
		await this.syncEncryptionStateWithRemote();

		// Load saved index
		const data = (await this.loadData()) as PluginData | null;
		if (data?.localIndex) {
			this.indexManager.loadLocalIndexFromData(data.localIndex);
		}
		if (data?.lastSyncStats) {
			this.lastSyncStats = data.lastSyncStats;
		}

	// Subscribe to sync engine events to pause/resume file watcher
		this.syncEngine.onSyncPause(() => {
			this.fileWatcher.pauseForSync();
		});
		this.syncEngine.onSyncResume(() => {
			this.fileWatcher.resumeAfterSync();
		});

		// Check if initial setup is needed
		const needsInitialSync = await this.needsInitialSync();
		if (needsInitialSync) {
			await this.checkAndRunInitialSync();
		} else {
			// Start regular synchronization
			this.startSync();
		}

		this.isInitialized = true;
	}

	/**
	 * Проверка необходимости первичной синхронизации
	 */
	private async needsInitialSync(): Promise<boolean> {
		try {
			// Проверяем наличие удаленного индекса
			const remoteIndexExists = await this.indexManager.remoteIndexExists();
			if (remoteIndexExists) {
				// Если индекс есть на диске - это не первичная синхронизация
				logger.info("Remote index exists, skipping initial sync");
				return false;
			}

			// Проверяем локальный индекс
			const localIndex = this.indexManager.getLocalIndex();
			if (localIndex.lastSyncTime > 0) {
				// Если была синхронизация - не первичная
				logger.info("Local index has sync time, skipping initial sync");
				return false;
			}

			// Иначе - нужна первичная синхронизация
			logger.info("Initial sync needed");
			return true;
		} catch (e) {
			logger.warn("Error checking initial sync status:", e);
			// В случае ошибки считаем что нужна первичная синхронизация
			return true;
		}
	}

	/**
	 * Check and run initial synchronization
	 */
	private async checkAndRunInitialSync(): Promise<void> {
		try {
			new Notice(t("notice.connection_check"));

			// Check token
			const tokenValid = await this.yandexClient.checkToken();
			if (!tokenValid) {
				new Notice(t("notice.token_invalid"));
				return;
			}

			new Notice(t("notice.sync_started"));
			await this.runInitialSync();
			this.startSync();
		} catch (e) {
			logger.error("Error during initial setup:", e);
			new Notice(`Initialization error: ${(e as Error).message}`);
		}
	}

	/**
	 * Run initial synchronization with merge strategy
	 */
	private async runInitialSync(): Promise<void> {
		try {
			// Create remote folder if not exists
			const exists = await this.indexManager.remotePathExists();
			if (!exists) {
				await this.indexManager.createRemotePath();
			}

			// Always load remote index for merge strategy
			await this.indexManager.loadRemoteIndex();

			// Run full synchronization
			const result = await this.syncEngine.fullSync();

			this.lastSyncStats = {
				uploaded: result.uploaded,
				downloaded: result.downloaded,
				deleted: result.deleted,
				errors: result.errors.length,
			};

			// Save updated index after sync
			await this.saveData({
				settings: this.settings,
				localIndex: this.indexManager.getLocalIndex(),
				lastSyncStats: this.lastSyncStats,
			} as PluginData);

			if (result.success) {
				new Notice(
					t("notice.sync_completed", { successful: result.uploaded + result.downloaded + result.deleted })
				);
			} else {
				new Notice(t("notice.sync_error", { errors: result.errors.length }));
			}
		} catch (e) {
			logger.error("Error during initial synchronization:", e);
			new Notice(`Sync error: ${(e as Error).message}`);
		}
	}

	/**
	 * Run full synchronization
	 */
	async runFullSync(): Promise<void> {
		if (!this.settings.yandexTokenSecret) {
			new Notice(t("notice.token_missing"));
			return;
		}

		new Notice(t("notice.sync_started"));

		try {
			const result = await this.syncEngine.fullSync();

			this.lastSyncStats = {
				uploaded: result.uploaded,
				downloaded: result.downloaded,
				deleted: result.deleted,
				errors: result.errors.length,
			};

			// Save updated index after sync
			await this.saveData({
				settings: this.settings,
				localIndex: this.indexManager.getLocalIndex(),
				lastSyncStats: this.lastSyncStats,
			} as PluginData);

			if (result.success) {
				new Notice(
					t("notice.sync_completed", { successful: result.uploaded + result.downloaded + result.deleted })
				);
			} else {
				new Notice(t("notice.sync_error", { errors: result.errors.length }));
			}
		} catch (e) {
			logger.error("Sync error:", e);
			new Notice(`Sync error: ${(e as Error).message}`);
		}
	}

	/**
	 * Show confirm modal for force sync operation
	 */
	private confirmForceSync(
		direction: "from_local" | "from_remote"
	): Promise<boolean> {
		return new Promise((resolve) => {
			new ForceSyncModal(
				this.app,
				direction,
				async () => await this.createBackup(),
				(action) => {
					resolve(action === "proceed");
				}
			).open();
		});
	}

	/**
	 * Run force synchronization from local to remote
	 */
	async runForceSyncFromLocal(): Promise<void> {
		if (!this.settings.yandexTokenSecret) {
			new Notice(t("notice.token_missing"));
			return;
		}

		const confirmed = await this.confirmForceSync("from_local");
		if (!confirmed) {
			return;
		}

		const notice = new Notice(t("notice.force_sync_from_local_started"), 600000);

		try {
			const result = await this.syncEngine.forceSyncFromLocal();

			this.lastSyncStats = {
				uploaded: result.uploaded,
				downloaded: result.downloaded,
				deleted: result.deleted,
				errors: result.errors.length,
			};

			await this.saveData({
				settings: this.settings,
				localIndex: this.indexManager.getLocalIndex(),
				lastSyncStats: this.lastSyncStats,
			} as PluginData);

			notice.hide();

			if (result.success) {
				new Notice(
					t("notice.force_sync_completed", {
						successful:
							result.uploaded +
							result.downloaded +
							result.deleted,
					})
				);
			} else {
				new Notice(
					t("notice.sync_error", { errors: result.errors.length })
				);
			}
		} catch (e) {
			notice.hide();
			logger.error("Force sync error:", e);
			new Notice(`Force sync error: ${(e as Error).message}`);
		}
	}

	/**
	 * Run force synchronization from remote to local
	 */
	async runForceSyncFromRemote(): Promise<void> {
		if (!this.settings.yandexTokenSecret) {
			new Notice(t("notice.token_missing"));
			return;
		}

		const confirmed = await this.confirmForceSync("from_remote");
		if (!confirmed) {
			return;
		}

		const notice = new Notice(t("notice.force_sync_from_remote_started"), 600000);

		try {
			const result = await this.syncEngine.forceSyncFromRemote();

			this.lastSyncStats = {
				uploaded: result.uploaded,
				downloaded: result.downloaded,
				deleted: result.deleted,
				errors: result.errors.length,
			};

			await this.saveData({
				settings: this.settings,
				localIndex: this.indexManager.getLocalIndex(),
				lastSyncStats: this.lastSyncStats,
			} as PluginData);

			notice.hide();

			if (result.success) {
				new Notice(
					t("notice.force_sync_completed", {
						successful:
							result.uploaded +
							result.downloaded +
							result.deleted,
					})
				);
			} else {
				new Notice(
					t("notice.sync_error", { errors: result.errors.length })
				);
			}
		} catch (e) {
			notice.hide();
			logger.error("Force sync error:", e);
			new Notice(`Force sync error: ${(e as Error).message}`);
		}
	}

	/**
	 * Start regular synchronization
	 */
	private startSync(): void {
		logger.info("[Main] Starting regular synchronization");

		// Start file watcher
		logger.info("[Main] Starting file watcher");
		this.fileWatcher.start();

		// Start scheduler
		logger.info("[Main] Starting sync scheduler");
		this.syncScheduler.start();

		logger.info("[Main] Synchronization started");

		// Run initial sync immediately to check for changes
		logger.info("[Main] Running initial sync check");
		// FileWatcher will be automatically paused by sync engine callbacks
		void this.runFullSync();
	}

	/**
	 * Confirm action via Modal
	 */
	private confirmAction(message: string): Promise<boolean> {
		return new Promise((resolve) => {
			new ConfirmModal(this.app, message, (confirmed) => {
				resolve(confirmed);
			}).open();
		});
	}

	/**
	 * Load settings
	 */
	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as PluginData | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);

		// Automatically determine path with vault name
		const vaultName = this.app.vault.getName();
		const saved = data?.settings;
		
		// Apply automatic path determination if:
		// - settings were not saved before, or
		// - path is not set, or
		// - path equals the default value
		if (!saved || !this.settings.remotePath || 
		    this.settings.remotePath === DEFAULT_SETTINGS.remotePath) {
			this.settings.remotePath = `${DEFAULT_SETTINGS.remotePath}/${vaultName}`;
			// Save updated settings
			await this.saveSettings();
		}
	}

	/**
	 * Save settings
	 */
	async saveSettings(): Promise<void> {
		// Update components
		if (this.yandexClient) {
			this.yandexClient.setToken(this.settings.yandexTokenSecret);
		}
		if (this.vaultAdapter) {
			this.vaultAdapter.updateSettings(this.settings);
		}
		if (this.indexManager) {
			this.indexManager.updateSettings(this.settings);
		}
		if (this.syncEngine) {
			this.syncEngine.updateSettings(this.settings);
		}
		if (this.fileWatcher) {
			this.fileWatcher.updateSettings(this.settings);
		}
		if (this.syncScheduler) {
			this.syncScheduler.updateSettings(this.settings);
		}
		if (this.backupManager) {
			this.backupManager.updateSettings(this.settings);
		}

		await this.saveData({
			settings: this.settings,
			localIndex: this.indexManager?.getLocalIndex() ?? null,
			lastSyncStats: this.lastSyncStats,
		} as PluginData);
	}

	// ============================================================================
	// Encryption
	// ============================================================================

	/**
	 * Initialize encryption service from stored settings.
	 * Called during plugin load; silently returns if encryption is disabled or
	 * if password/salt is missing.
	 */
	private async initEncryption(): Promise<void> {
		if (
			!this.settings.enableEncryption
			|| !this.settings.encryptionSalt
			|| !this.settings.encryptedPassword
		) {
			this.yandexClient.setEncryptionService(null);
			return;
		}

		try {
			const salt = EncryptionService.base64ToBytes(
				this.settings.encryptionSalt
			);
			const service = new EncryptionService(salt);
			await service.initializeKey(this.settings.encryptedPassword);
			this.encryptionService = service;
			this.yandexClient.setEncryptionService(service);
			logger.info("Encryption initialized successfully");
		} catch (e) {
			logger.warn("Failed to initialize encryption:", e);
			this.encryptionService = null;
			this.yandexClient.setEncryptionService(null);

			new Notice(t("notice.encryption_wrong_password"));
		}
	}

	/**
	 * Enable encryption with the given password.
	 *
	 * If remote already has an encryption salt (another device enabled encryption),
	 * uses that salt — so the same password produces the same key across devices.
	 * If no remote salt exists, generates a new one and uploads it.
	 *
	 * When using an existing remote salt, verifies the password by trying to
	 * load the encrypted index. Throws if the password is wrong.
	 */
	async enableEncryption(password: string): Promise<void> {
		const remoteSalt = await this.indexManager.downloadEncryptionSalt();

		let saltBytes: Uint8Array;
		let isNewEncryption: boolean;

		if (remoteSalt) {
			// Remote already has encryption — reuse the same salt
			saltBytes = EncryptionService.base64ToBytes(remoteSalt);
			isNewEncryption = false;
		} else {
			// First-time setup — generate new salt
			saltBytes = EncryptionService.generateSalt();
			isNewEncryption = true;
		}

		// Before setting encryption, save list of existing remote files for cleanup
		let oldRemoteFiles: Map<string, never> | null = null;
		if (isNewEncryption) {
			try {
				const remoteFiles = await this.indexManager.getRemoteFiles();
				if (remoteFiles && remoteFiles.size > 0) {
					oldRemoteFiles = remoteFiles as Map<string, never>;
				}
			} catch (e) {
				logger.warn("Failed to get remote file list before encryption:", e);
			}
		}

		const service = new EncryptionService(saltBytes);
		await service.initializeKey(password);

		this.yandexClient.setEncryptionService(service);

		// If using existing remote salt, verify password by loading the encrypted index
		if (!isNewEncryption) {
			try {
				await this.indexManager.loadRemoteIndex();
			} catch {
				this.yandexClient.setEncryptionService(null);
				throw new Error(t("notice.encryption_wrong_password"));
			}
		}

		this.encryptionService = service;
		this.settings.enableEncryption = true;
		this.settings.encryptionSalt = EncryptionService.bytesToBase64(saltBytes);
		this.settings.encryptedPassword = password;
		await this.saveSettings();

		// For first-time setup: upload salt, re-upload all files with encryption, clean up old files
		if (isNewEncryption) {
			try {
				await this.indexManager.uploadEncryptionSalt(
					EncryptionService.bytesToBase64(saltBytes)
				);

				// Re-upload all local files with encryption
				logger.info("Re-uploading all files with encryption...");
				await this.syncEngine.forceSyncFromLocal();

				// Clean up old plaintext files from remote
				if (oldRemoteFiles && oldRemoteFiles.size > 0) {
					logger.info(`Cleaning up ${oldRemoteFiles.size} old plaintext files...`);
					for (const [path] of oldRemoteFiles) {
						try {
							const remotePath = joinPath(this.settings.remotePath, path);
							await this.yandexClient.deleteResource(remotePath, false, true);
						} catch (e) {
							logger.warn(`Failed to delete old plaintext file ${path}:`, e);
						}
					}
				}
			} catch (e) {
				logger.warn("Failed to re-encrypt existing files:", e);
			}
		}

		logger.info("Encryption enabled");
	}

	/**
	 * Disable encryption.
	 *
	 * When `reuploadPlaintext` is true, re-uploads all local files as plaintext
	 * and deletes old encrypted files from remote. This is used when the user
	 * explicitly turns off encryption (toggle OFF).
	 *
	 * When `reuploadPlaintext` is false (change-password flow), only clears
	 * settings and salt without touching the files on disk.
	 */
	async disableEncryption(options?: { reuploadPlaintext?: boolean }): Promise<void> {
		this.encryptionService = null;
		this.yandexClient.setEncryptionService(null);

		if (options?.reuploadPlaintext) {
			logger.info("Re-uploading all files as plaintext...");
			await this.syncEngine.forceSyncFromLocal();
		}

		this.settings.enableEncryption = false;
		this.settings.encryptionSalt = null;
		this.settings.encryptedPassword = null;
		await this.saveSettings();

		// Remove salt from remote
		try {
			await this.indexManager.deleteEncryptionSalt();
		} catch (e) {
			logger.warn("Failed to delete encryption salt from remote:", e);
		}

		logger.info("Encryption disabled");
	}

	/**
	 * Check remote for encryption salt.
	 * If salt exists but no local password is configured, prompt the user
	 * to enter the encryption password for multi-device setup.
	 */
	private async syncEncryptionStateWithRemote(): Promise<void> {
		// Already configured locally — skip
		if (this.settings.enableEncryption && this.settings.encryptedPassword) {
			return;
		}

		try {
			const remoteSalt = await this.indexManager.downloadEncryptionSalt();
			if (!remoteSalt) {
				// No encryption on remote — nothing to do
				return;
			}

			// Local encryption is NOT configured but remote has salt
			// Need to prompt user for password
			new Notice(t("notice.encryption_detected"), 8000);

			const password = await new Promise<string | null>((resolve) => {
				new PasswordPromptModal(
					this.app,
					resolve,
					() => this.createBackup(),
					t("modal.encryption_enter_password")
				).open();
			});
			if (!password) {
				logger.warn("User cancelled encryption password prompt");
				return;
			}

			const saltBytes = EncryptionService.base64ToBytes(remoteSalt);
			const service = new EncryptionService(saltBytes);
			await service.initializeKey(password);

			// Verify by trying to load the encrypted index
			this.yandexClient.setEncryptionService(service);
			try {
				await this.indexManager.loadRemoteIndex();

				// Success — password is correct
				this.encryptionService = service;
				this.settings.enableEncryption = true;
				this.settings.encryptionSalt = remoteSalt;
				this.settings.encryptedPassword = password;
				await this.saveSettings();
				logger.info("Encryption configured from remote salt");
			} catch {
				// Wrong password
				this.yandexClient.setEncryptionService(null);
				this.encryptionService = null;
				new Notice(t("notice.encryption_wrong_password"));
			}
		} catch (e) {
			logger.warn("Error syncing encryption state with remote:", e);
		}
	}

	/**
	 * Get encryption service instance (may be null if disabled).
	 */
	getEncryptionService(): EncryptionService | null {
		return this.encryptionService;
	}

	/**
	 * Test connection to Yandex Disk
	 */
	async testConnection(): Promise<{ success: boolean; message: string }> {
		if (!this.settings.yandexTokenSecret) {
			return { success: false, message: t("notice.token_missing") };
		}

		try {
			const valid = await this.yandexClient.checkToken();
			if (valid) {
				return { success: true, message: t("notice.connection_test_success") };
			} else {
				return { success: false, message: t("notice.token_invalid") };
			}
		} catch (e) {
			return { success: false, message: (e as Error).message };
		}
	}

	/**
	 * Create backup of synchronized files
	 */
	async createBackup(): Promise<{ success: boolean; backupName?: string; error?: string }> {
		if (!this.settings.yandexTokenSecret) {
			return { success: false, error: t("notice.token_missing") };
		}

		new Notice(t("notice.backup_started"));

		try {
			const result = await this.backupManager.createBackup();

			if (result.success && result.backupName) {
				new Notice(t("notice.backup_completed", { name: result.backupName }));
				return { success: true, backupName: result.backupName };
			} else {
				return { success: false, error: result.error };
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error("Backup creation failed:", error);
			return { success: false, error: errorMessage };
		}
	}

	/**
	 * Get backup manager instance
	 */
	getBackupManager(): BackupManager {
		return this.backupManager;
	}

	/**
	 * Save local index to plugin data
	 */
	private async saveLocalIndex(): Promise<void> {
		await this.saveData({
			settings: this.settings,
			localIndex: this.indexManager.getLocalIndex(),
			lastSyncStats: this.lastSyncStats,
		} as PluginData);
	}
}
