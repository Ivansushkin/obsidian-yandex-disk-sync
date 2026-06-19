/**
 * Yandex Disk Sync Plugin for Obsidian
 * File synchronization with Yandex Disk
 */

import { Notice, Plugin } from "obsidian";
import {
	YandexDiskSyncSettings,
	DEFAULT_SETTINGS,
	SyncIndex,
	EncryptionManifest,
	RemoteEncryptionManifest,
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
import { ConnectEncryptedVaultModal } from "./ui/encryption-modals";
import { BackupManager } from "./backup/backup-manager";
import { generateDeviceId, joinPath } from "./utils/path-utils";
import { logger } from "./utils/logger";
import { initI18n, t } from "./i18n";
import {
	EncryptionService,
	PBKDF2_ITERATIONS,
	AES_KEY_LENGTH,
	IV_LENGTH,
} from "./crypto/encryption";

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

interface EncryptionReadyOptions {
	/** Whether the user can be prompted for a missing or rotated password. */
	prompt: boolean;
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
	private encryptionBlockReason: string | null = null;
	private encryptionPromptPromise: Promise<boolean> | null = null;
	/** Called whenever the encryption enabled/disabled state changes so UI can refresh. */
	encryptionStateChangeCallback: (() => void) | null = null;

	async onload(): Promise<void> {
		// Initialize i18n service
		initI18n();

		logger.info("Loading Yandex Disk Sync plugin...");

		// Load settings
		await this.loadSettings();

		// Configure logger from settings
		logger.configure({
			app: this.app,
			minLevel: this.settings.enableDebugLogging ? "debug" : "info",
			consoleEnabled: true,
			fileEnabled: this.settings.logToFile,
		});
		logger.info("Loading Yandex Disk Sync plugin...");

		// Generate device ID if missing
		if (!this.settings.deviceId) {
			this.settings.deviceId = generateDeviceId();
			await this.saveSettings();
		}

		// Initialize components
		this.initializeComponents();
		await this.initEncryption();

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
		this.yandexClient.setRemotePath(this.settings.remotePath);

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
		this.syncEngine.setSyncGuardCallback(async () => {
			if (!this.settings.yandexTokenSecret) {
				return null;
			}
			const ready = await this.ensureEncryptionReady({ prompt: true });
			return ready
				? null
				: this.encryptionBlockReason ?? t("notice.encryption_password_required");
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
			callback: async () => {
				if (this.syncEngine.isSyncPaused()) {
					if (!(await this.ensureEncryptionReady({ prompt: true }))) {
						return;
					}
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

		// Check remote encryption state before loading index or starting sync.
		if (!(await this.ensureEncryptionReady({ prompt: true }))) {
			return;
		}

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
			await this.startSync();
		}

		this.isInitialized = true;
	}

	/**
	 * Check whether an initial sync is required.
	 */
	private async needsInitialSync(): Promise<boolean> {
		try {
			// Check whether a remote index exists
			const remoteIndexExists = await this.indexManager.remoteIndexExists();
			if (remoteIndexExists) {
				// Existing remote index means this is not the first sync
				logger.info("Remote index exists, skipping initial sync");
				return false;
			}

			// Check the local index
			const localIndex = this.indexManager.getLocalIndex();
			if (localIndex.lastSyncTime > 0) {
				// A previous sync was recorded, so this is not the first sync
				logger.info("Local index has sync time, skipping initial sync");
				return false;
			}

			// Otherwise an initial sync is needed
			logger.info("Initial sync needed");
			return true;
		} catch (e) {
			logger.warn("Error checking initial sync status:", { error: e });
			// If the check fails, assume an initial sync is required
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
			await this.startSync();
		} catch (e) {
			logger.error("Error during initial setup:", { error: e });
			new Notice(`Initialization error: ${(e as Error).message}`);
		}
	}

	/**
	 * Run initial synchronization with merge strategy
	 */
	private async runInitialSync(): Promise<void> {
		try {
			if (!(await this.ensureEncryptionReady({ prompt: true }))) {
				return;
			}

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
			logger.error("Error during initial synchronization:", { error: e });
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
		if (!(await this.ensureEncryptionReady({ prompt: true }))) {
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
			logger.error("Sync error:", { error: e });
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
		if (!(await this.ensureEncryptionReady({ prompt: true }))) {
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
			logger.error("Force sync error:", { error: e });
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
		if (!(await this.ensureEncryptionReady({ prompt: true }))) {
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
			logger.error("Force sync error:", { error: e });
			new Notice(`Force sync error: ${(e as Error).message}`);
		}
	}

	/**
	 * Start regular synchronization
	 */
	private async startSync(): Promise<void> {
		logger.info("[Main] Starting regular synchronization");
		if (!(await this.ensureEncryptionReady({ prompt: true }))) {
			logger.warn("[Main] Synchronization blocked by encryption state");
			return;
		}

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

		// Migrate legacy field name `encryptedPassword` -> `encryptionPassword`.
		const legacySettings = data?.settings as
			| (Partial<YandexDiskSyncSettings> & { encryptedPassword?: string | null })
			| undefined;
		if (legacySettings?.encryptedPassword && !this.settings.encryptionPassword) {
			this.settings.encryptionPassword = legacySettings.encryptedPassword;
		}

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
		// Update logger configuration
		logger.configure({
			app: this.app,
			minLevel: this.settings.enableDebugLogging ? "debug" : "info",
			consoleEnabled: true,
			fileEnabled: this.settings.logToFile,
		});

		// Update components
		if (this.yandexClient) {
			this.yandexClient.setToken(this.settings.yandexTokenSecret);
			this.yandexClient.setRemotePath(this.settings.remotePath);
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
		if (this.encryptionBlockReason) {
			this.fileWatcher?.stop();
			this.syncScheduler?.stop();
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
			|| !this.settings.encryptionPassword
		) {
			this.yandexClient.setEncryptionService(null);
			return;
		}

		try {
			const salt = EncryptionService.base64ToBytes(
				this.settings.encryptionSalt
			);
			const service = new EncryptionService(salt);
			await service.initializeKey(this.settings.encryptionPassword);
			this.encryptionService = service;
			this.yandexClient.setEncryptionService(service);
			logger.info("Encryption initialized successfully");
		} catch (e) {
			logger.warn("Failed to initialize encryption:", { error: e });
			this.encryptionService = null;
			this.yandexClient.setEncryptionService(null);

			new Notice(t("notice.encryption_wrong_password"));
		}
	}

	/**
	 * Enable encryption or connect to an already encrypted remote vault.
	 */
	async enableEncryption(password: string): Promise<void> {
		const remoteManifest = await this.indexManager.downloadEncryptionManifest();
		if (remoteManifest) {
			await this.connectToRemoteEncryption(password, remoteManifest);
			return;
		}

		const oldRawPaths = await this.indexManager.getRemoteRawFilePaths();
		const saltBytes = EncryptionService.generateSalt();
		const saltBase64 = EncryptionService.bytesToBase64(saltBytes);
		const revision = 1;
		const service = new EncryptionService(saltBytes);
		await service.initializeKey(password);

		this.encryptionService = service;
		this.yandexClient.setEncryptionService(service);
		this.settings.enableEncryption = true;
		this.settings.encryptionSalt = saltBase64;
		this.settings.encryptionPassword = password;
		this.settings.encryptionRevision = revision;
		await this.saveSettings();

		await this.indexManager.uploadEncryptionManifest(
			await this.createEncryptionManifest(service, saltBase64, "enabling", revision)
		);

		logger.info("Re-uploading all files with encryption...");
		const result = await this.syncEngine.forceSyncFromLocal({
			skipEncryptionGuard: true,
			skipRemoteDeletes: true,
		});
		if (!result.success) {
			throw new Error(t("notice.encryption_sync_failed", { errors: result.errors.length }));
		}

		await this.deleteRemoteRawPaths(oldRawPaths);
		await this.deleteRemoteRawFolders(oldRawPaths);
		await this.indexManager.uploadEncryptionManifest(
			await this.createEncryptionManifest(service, saltBase64, "enabled", revision)
		);
		this.setEncryptionBlock(null);
		logger.info("Encryption enabled");
	}

	/**
	 * Disable encryption.
	 *
	 * When `reuploadPlaintext` is true, re-uploads all local files as plaintext
	 * and deletes old encrypted files from remote. This is used when the user
	 * explicitly turns off encryption (toggle OFF).
	 *
	 * When `reuploadPlaintext` is false, only clears local encryption settings.
	 */
	async disableEncryption(options?: { reuploadPlaintext?: boolean }): Promise<{ hadErrors: boolean }> {
		let partialErrors = false;

		if (options?.reuploadPlaintext) {
			// Capture encrypted paths while service is still active
			const oldRawPaths = await this.indexManager.getRemoteRawFilePaths();

			if (this.encryptionService && this.settings.encryptionSalt) {
				const revision = this.settings.encryptionRevision ?? 1;
				try {
					await this.indexManager.uploadEncryptionManifest(
						await this.createEncryptionManifest(
							this.encryptionService,
							this.settings.encryptionSalt,
							"disabling",
							revision
						)
					);
				} catch (e) {
					logger.warn("Failed to upload disabling manifest:", { error: e });
					partialErrors = true;
				}
			}

			this.encryptionService = null;
			this.yandexClient.setEncryptionService(null);

			logger.info("Re-uploading all files as plaintext...");
			const result = await this.syncEngine.forceSyncFromLocal({
				skipEncryptionGuard: true,
				skipRemoteDeletes: true,
			});
			if (!result.success) {
				logger.warn(`Disable re-upload completed with ${result.errors.length} errors`);
				partialErrors = true;
			}

			// Bulk cleanup of old encrypted files and folders — sequential, no concurrent
			// folder-delete race. Both helpers suppress individual errors internally.
			await this.deleteRemoteRawPaths(oldRawPaths);
			await this.deleteRemoteRawFolders(oldRawPaths);
		} else {
			this.encryptionService = null;
			this.yandexClient.setEncryptionService(null);
		}

		// Always clear local encryption state regardless of remote errors
		this.settings.enableEncryption = false;
		this.settings.encryptionSalt = null;
		this.settings.encryptionPassword = null;
		this.settings.encryptionRevision = null;
		await this.saveSettings();

		try {
			await this.indexManager.deleteEncryptionManifest();
		} catch (e) {
			logger.warn("Failed to delete encryption manifest from remote:", { error: e });
			partialErrors = true;
		}

		this.setEncryptionBlock(null);
		logger.info("Encryption disabled");

		if (partialErrors) {
			new Notice(t("notice.encryption_disable_partial"), 30000);
		}

		return { hadErrors: partialErrors };
	}

	/**
	 * Clear local encryption settings and service without touching remote state.
	 * Used when remote state already reflects the disabled encryption (e.g. another
	 * device disabled it) so there is nothing to clean up on the server side.
	 */
	private async clearLocalEncryptionState(): Promise<void> {
		this.encryptionService = null;
		this.yandexClient.setEncryptionService(null);
		this.settings.enableEncryption = false;
		this.settings.encryptionSalt = null;
		this.settings.encryptionPassword = null;
		this.settings.encryptionRevision = null;
		await this.saveSettings();
		this.setEncryptionBlock(null);
	}

	/**
	 * Rotate the encryption password and re-upload all files with a new key.
	 */
	async rotateEncryptionPassword(newPassword: string): Promise<void> {
		const currentManifest = await this.indexManager.downloadEncryptionManifest();
		if (currentManifest && currentManifest.state !== "enabled") {
			throw new Error(t("notice.encryption_remote_busy"));
		}
		if (!this.settings.enableEncryption || !this.settings.encryptionSalt) {
			throw new Error(t("notice.encryption_password_required"));
		}

		const oldRawPaths = await this.indexManager.getRemoteRawFilePaths();
		const saltBytes = EncryptionService.generateSalt();
		const saltBase64 = EncryptionService.bytesToBase64(saltBytes);
		const revision = Math.max(
			currentManifest?.revision ?? 1,
			this.settings.encryptionRevision ?? 1
		) + 1;
		const service = new EncryptionService(saltBytes);
		await service.initializeKey(newPassword);

		await this.indexManager.uploadEncryptionManifest(
			await this.createEncryptionManifest(service, saltBase64, "rotating", revision)
		);

		this.encryptionService = service;
		this.yandexClient.setEncryptionService(service);
		this.settings.enableEncryption = true;
		this.settings.encryptionSalt = saltBase64;
		this.settings.encryptionPassword = newPassword;
		this.settings.encryptionRevision = revision;
		await this.saveSettings();

		logger.info("Re-uploading all files after encryption password rotation...");
		const result = await this.syncEngine.forceSyncFromLocal({
			skipEncryptionGuard: true,
			skipRemoteDeletes: true,
		});
		if (!result.success) {
			throw new Error(t("notice.encryption_sync_failed", { errors: result.errors.length }));
		}

		await this.deleteRemoteRawPaths(oldRawPaths);
		await this.deleteRemoteRawFolders(oldRawPaths);
		await this.indexManager.uploadEncryptionManifest(
			await this.createEncryptionManifest(service, saltBase64, "enabled", revision)
		);
		this.setEncryptionBlock(null);
		logger.info("Encryption password rotated");
	}

	/**
	 * Download remote encryption manifest for UI decisions.
	 */
	async getRemoteEncryptionManifest(): Promise<RemoteEncryptionManifest | null> {
		return await this.indexManager.downloadEncryptionManifest();
	}

	/**
	 * Connect this device to an encrypted remote vault using the provided password.
	 */
	async connectToRemoteEncryption(
		password: string,
		manifest?: RemoteEncryptionManifest
	): Promise<void> {
		const remoteManifest = manifest ?? await this.indexManager.downloadEncryptionManifest();
		if (!remoteManifest) {
			throw new Error(t("notice.encryption_remote_missing"));
		}
		if (remoteManifest.state !== "enabled") {
			throw new Error(t("notice.encryption_remote_busy"));
		}

		const saltBytes = EncryptionService.base64ToBytes(remoteManifest.salt);
		const service = new EncryptionService(saltBytes);
		await service.initializeKey(password);
		await this.verifyRemoteEncryptionPassword(service, remoteManifest);

		this.encryptionService = service;
		this.yandexClient.setEncryptionService(service);
		this.settings.enableEncryption = true;
		this.settings.encryptionSalt = remoteManifest.salt;
		this.settings.encryptionPassword = password;
		this.settings.encryptionRevision = remoteManifest.revision;

		// Populate localIndex from remote so the conflict resolver has a baseline.
		// Without this, any local deletions before the first fullSync are
		// misidentified as "new remote files" and re-downloaded.
		try {
			await this.indexManager.loadRemoteIndex();
			this.indexManager.seedLocalIndexFromRemote();
		} catch (e) {
			logger.warn("Could not seed local index from remote after connecting:", { error: e });
		}

		await this.saveSettings();
		this.setEncryptionBlock(null);
		logger.info("Encryption configured from remote manifest");
	}

	/**
	 * Ensure local encryption settings match the remote manifest before sync.
	 */
	private async ensureEncryptionReady(options: EncryptionReadyOptions): Promise<boolean> {

		try {
			const manifest = await this.indexManager.downloadEncryptionManifest();
			if (!manifest) {
				if (this.settings.enableEncryption) {
					// Encryption was disabled on another device — auto-sync local state
					logger.info("Remote encryption manifest gone; auto-disabling local encryption");
					await this.clearLocalEncryptionState();
					new Notice(t("notice.encryption_disabled_remotely"), 10000);
					this.encryptionStateChangeCallback?.();
				}
				return true;
			}

			if (manifest.state !== "enabled") {
				this.setEncryptionBlock(t("notice.encryption_remote_busy"));
				return false;
			}

			const hasLocalEncryption = Boolean(
				this.settings.enableEncryption
				&& this.settings.encryptionSalt
				&& this.settings.encryptionPassword
				&& this.encryptionService
			);
			const localRevision = this.settings.encryptionRevision ?? 1;
			const matchesRemote = hasLocalEncryption
				&& this.settings.encryptionSalt === manifest.salt
				&& (manifest.version === 1 || localRevision === manifest.revision);

			if (!matchesRemote) {
				const reason = hasLocalEncryption
					? t("notice.encryption_password_changed_remote")
					: t("notice.encryption_password_required");
				this.setEncryptionBlock(reason);
				if (!options.prompt) {
					return false;
				}
				return await this.promptForRemoteEncryptionPassword(
					manifest,
					hasLocalEncryption ? "rotated" : "connect"
				);
			}

			if (manifest.version === 2 && this.encryptionService) {
				try {
					if (!(await this.encryptionService.verifyVerifier(manifest.verifier))) {
						throw new Error(t("notice.encryption_wrong_password"));
					}
				} catch {
					this.setEncryptionBlock(t("notice.encryption_password_changed_remote"));
					if (!options.prompt) {
						return false;
					}
					return await this.promptForRemoteEncryptionPassword(manifest, "rotated");
				}
			}

			this.setEncryptionBlock(null);
			return true;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			logger.warn("Error checking remote encryption state:", { error: e });
			this.setEncryptionBlock(t("notice.encryption_state_check_failed", { error: message }));
			return false;
		}
	}

	private async promptForRemoteEncryptionPassword(
		manifest: RemoteEncryptionManifest,
		mode: "connect" | "rotated"
	): Promise<boolean> {
		if (this.encryptionPromptPromise) {
			return await this.encryptionPromptPromise;
		}

		this.encryptionPromptPromise = this.promptForRemoteEncryptionPasswordOnce(
			manifest,
			mode
		).finally(() => {
			this.encryptionPromptPromise = null;
		});

		return await this.encryptionPromptPromise;
	}

	private async promptForRemoteEncryptionPasswordOnce(
		manifest: RemoteEncryptionManifest,
		mode: "connect" | "rotated"
	): Promise<boolean> {
		const title = mode === "connect"
			? t("modal.encryption_connect_title")
			: t("modal.encryption_rotated_title");
		const body = mode === "connect"
			? t("modal.encryption_connect_desc")
			: t("modal.encryption_rotated_desc");

		const password = await new Promise<string | null>((resolve) => {
			new ConnectEncryptedVaultModal(
				this.app,
				resolve,
				title,
				body,
				t("modal.encryption_connect_button")
			).open();
		});
		if (!password) {
			logger.warn("User cancelled encryption password prompt");
			return false;
		}

		try {
			await this.connectToRemoteEncryption(password, manifest);
			new Notice(t("notice.encryption_connected"));
			this.encryptionStateChangeCallback?.();
			return true;
		} catch (e) {
			this.encryptionService = null;
			this.yandexClient.setEncryptionService(null);
			const message = e instanceof Error ? e.message : String(e);
			this.setEncryptionBlock(t("notice.encryption_password_required"));
			new Notice(message);
			return false;
		}
	}

	private async verifyRemoteEncryptionPassword(
		service: EncryptionService,
		manifest: RemoteEncryptionManifest
	): Promise<void> {
		if (manifest.version === 2) {
			try {
				if (await service.verifyVerifier(manifest.verifier)) {
					return;
				}
			} catch {
				throw new Error(t("notice.encryption_wrong_password"));
			}
			throw new Error(t("notice.encryption_wrong_password"));
		}

		const previousService = this.encryptionService;
		this.yandexClient.setEncryptionService(service);
		try {
			await this.indexManager.loadRemoteIndex();
		} catch {
			throw new Error(t("notice.encryption_wrong_password"));
		} finally {
			this.yandexClient.setEncryptionService(previousService);
		}
	}

	/**
	 * Verify a candidate encryption password against the currently initialized
	 * encryption service. Returns false if encryption is not active or the
	 * password does not derive the same key.
	 */
	async verifyEncryptionPassword(password: string): Promise<boolean> {
		if (!this.encryptionService || !this.settings.encryptionSalt) {
			return false;
		}

		try {
			const salt = EncryptionService.base64ToBytes(this.settings.encryptionSalt);
			const candidate = new EncryptionService(salt);
			await candidate.initializeKey(password);
			const verifier = await this.encryptionService.createVerifier();
			return await candidate.verifyVerifier(verifier);
		} catch {
			return false;
		}
	}

	private async createEncryptionManifest(
		service: EncryptionService,
		salt: string,
		state: EncryptionManifest["state"],
		revision: number
	): Promise<EncryptionManifest> {
		return {
			version: 2,
			state,
			revision,
			salt,
			verifier: await service.createVerifier(),
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
			updatedAt: Date.now(),
			updatedBy: this.settings.deviceId,
		};
	}

	private setEncryptionBlock(reason: string | null): void {
		const changed = this.encryptionBlockReason !== reason;
		this.encryptionBlockReason = reason;
		this.syncEngine?.setExternalBlockReason(reason);
		if (reason) {
			this.fileWatcher?.stop();
			this.syncScheduler?.stop();
			if (changed) {
				new Notice(reason, 10000);
			}
		}
	}

	private async deleteRemoteRawPaths(paths: string[]): Promise<void> {
		if (paths.length === 0) {
			return;
		}

		logger.info(`Cleaning up ${paths.length} old remote files...`);
		for (const path of paths) {
			try {
				const remotePath = joinPath(this.settings.remotePath, path);
				await this.yandexClient.deleteResource(remotePath, false, true);
			} catch (e) {
				logger.warn(`Failed to delete old remote file ${path}:`, { error: e });
			}
		}
	}

	/**
	 * Delete remote folders that were parents of the given raw file paths.
	 * Used during encryption enable/rotate where the remote index already
	 * reflects the new key and cannot be used to verify emptiness. Since
	 * deleteRemoteRawPaths removed all files beforehand, the folders are
	 * guaranteed to be empty. Deletes deepest first so children are gone
	 * before parents are attempted.
	 */
	private async deleteRemoteRawFolders(rawFilePaths: string[]): Promise<void> {
		if (rawFilePaths.length === 0) return;

		const folders = new Set<string>();
		for (const filePath of rawFilePaths) {
			const segments = filePath.split("/");
			for (let i = 1; i < segments.length; i++) {
				folders.add(segments.slice(0, i).join("/"));
			}
		}
		if (folders.size === 0) return;

		const sorted = Array.from(folders).sort(
			(a, b) => b.split("/").length - a.split("/").length
		);

		logger.info(`Cleaning up ${sorted.length} old remote folders...`);
		for (const folder of sorted) {
			try {
				const remotePath = joinPath(this.settings.remotePath, folder);
				await this.yandexClient.deleteResource(remotePath, false, true);
				logger.debug(`Deleted old remote folder: ${folder}`);
			} catch (e) {
				logger.warn(`Failed to delete old remote folder ${folder}:`, { error: e });
			}
		}
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
			logger.error("Backup creation failed:", { error });
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
