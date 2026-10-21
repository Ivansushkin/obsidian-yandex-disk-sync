import { StorageBindingController } from "./sync/local/storage-binding";
import { StorageScopeError } from "./sync/local/storage-scope";
import { StorageBindingModal } from "./ui/storage-binding-modal";
import {
	prepareSettingsPatch,
	type UserSettingsPatch,
} from "./settings-workflow";
import { OperationBackupModal } from "./ui/operation-backup-modal";
import type { OperationBackupChoice } from "./backup/operation-backup-choice";
/**
 * Yandex Disk Sync Plugin for Obsidian
 * File synchronization with Yandex Disk
 */

import { Notice, Platform, Plugin } from "obsidian";
import {
	YandexDiskSyncSettings,
	DEFAULT_SETTINGS,
	LocalSyncState,
	PendingMutation,
	PendingPhysicalAction,
	EncryptionManifest,
	RemoteEncryptionManifest,
	EncryptionTransitionPhase,
	EncryptionModeDescriptor,
	IndexMaintenance,
	SyncResult,
} from "./types";
import { YandexDiskSyncSettingTab } from "./settings";
import { YandexDiskClient } from "./api/yandex-client";
import { VaultAdapter } from "./api/vault-adapter";
import {
	IndexManager,
	LegacyIndexFormatError,
	LegacyPluginDataExposureError,
	LegacyServicePathCollisionError,
	RemoteIndexConcurrentModificationError,
} from "./sync/canonical/manager";
import {
	SyncEngine,
	type ForceBackupProof,
	type PhysicalRewriteUploadProof,
	type SyncRunOptions,
} from "./sync/engine";
import { DeferredWatcherEvent, FileWatcher } from "./sync/realtime/watcher";
import { SyncScheduler } from "./sync/scheduler";
import { formatSyncActivity } from "./ui/sync-status-presentation";
import { SyncIndicator } from "./ui/sync-indicator";
import { SyncStatusModal } from "./ui/init-modal";
import { ForceSyncModal } from "./ui/force-sync-modal";
import {
	ForceSyncController,
	type ForceDirection,
	type ForceFlowState,
} from "./sync/workflows/force-controller";
import {
	formatForceActivity,
	formatForceResult,
} from "./ui/force-sync-progress";
import { ConnectEncryptedVaultModal } from "./ui/encryption-modals";
import { BackupManager } from "./backup/backup-manager";
import {
	captureLogicalVaultSnapshot,
	captureRemoteRawSnapshot,
} from "./backup/backup-snapshot";
import { generateDeviceId, joinPath, toLocalPath } from "./utils/path-utils";
import { computeSha256 } from "./utils/hash-utils";
import {
	logger,
	sanitizeDiagnosticMessage,
	shortenDiagnosticValue,
} from "./utils/logger";
import type { FailureSummary } from "./errors";
import {
	createSyncFailure,
	formatOperationFailure,
	formatSyncErrorSummary,
} from "./sync/errors";
import { initI18n, t } from "./i18n/index";
import {
	createEncryptionCodec,
	EncryptionService,
	type EncryptionCodec,
	type EncryptionProfileId,
} from "./crypto/encryption";
import { EncryptionManager } from "./crypto/encryption-manager";
import {
	decideEncryptionRecovery,
	createTargetRawMapping,
	EncryptionTransitionController,
	hasPendingEncryptionCleanup,
	type EncryptionBackupProof,
	type LocalEncryptionSnapshot,
	type LocalEncryptionTransition,
} from "./crypto/encryption-transition";
import {
	PLUGIN_DATA_FORMAT,
	loadPluginDataWithSource,
} from "./plugin-data-loader";
import { UnsupportedHistoricalDataError } from "./compatibility-errors";

interface PluginData {
	format: typeof PLUGIN_DATA_FORMAT;
	settings: YandexDiskSyncSettings;
	localState: Partial<LocalSyncState> | null;
	pendingMutations: PendingMutation[];
	pendingPhysicalActions: PendingPhysicalAction[];
	pendingWatcherEvents: DeferredWatcherEvent[];
	encryptionTransition: LocalEncryptionTransition | null;
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
	/** Force admission checks authority without starting transition recovery or reconnect. */
	allowRecovery?: boolean;
}

class LegacyTokenRotationRequiredError extends Error {
	constructor() {
		super(
			"OAuth token rotation is required after legacy plugin-data exposure",
		);
		this.name = "LegacyTokenRotationRequiredError";
	}
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
	private syncIndicator: SyncIndicator | null = null;
	private sidebarButton: HTMLElement | null = null;
	private activeSyncNotice: Notice | null = null;
	private syncNoticeUnsubscribe: (() => void) | null = null;
	private syncNoticeHideTimer: number | null = null;
	private syncNoticeGeneration = 0;
	private activeManualFullPromise: Promise<SyncResult | null> | null = null;
	private readonly manualActivityListeners = new Set<() => void>();
	private forceSyncController: ForceSyncController | null = null;
	private epochRecoveryTimer: number | null = null;
	private blockingNotice: { code: string; notice: Notice } | null = null;
	private loadedPluginData: PluginData | null = null;
	private pluginDataLoaded = false;
	private pluginDataLoadGeneration = 0;
	private pluginDataPersistenceTail: Promise<void> = Promise.resolve();
	private localStateRestored = false;
	private syncLifecycleRegistered = false;
	private configuredToken: string | null = null;
	private configuredRemotePath: string | null = null;
	private remoteStateValidated = false;
	private migrationBlockReason: string | null = null;
	private historicalBlockReason: string | null = null;
	private authenticationBlockReason: string | null = null;
	private legacyExposureRemediationPending = false;
	private legacyExposedTokenInSession: string | null = null;

	private lastSyncStats = {
		uploaded: 0,
		downloaded: 0,
		deleted: 0,
		errors: 0,
	};

	private regularSyncStarted = false;
	private activeFullRuns = 0;
	private readonly encryptionManager = new EncryptionManager();
	private encryptionService: EncryptionCodec | null = null;
	private encryptionTransitionController!: EncryptionTransitionController;
	private encryptionBlockReason: string | null = null;
	private encryptionPromptPromise: Promise<boolean> | null = null;
	private encryptionTransition: LocalEncryptionTransition | null = null;
	/** Called whenever the encryption enabled/disabled state changes so UI can refresh. */
	encryptionStateChangeCallback: (() => void) | null = null;

	async onload(): Promise<void> {
		// Initialize i18n service
		initI18n();

		// Load settings before any component can start remote work.
		try {
			await this.loadSettings();
		} catch (error) {
			if (error instanceof UnsupportedHistoricalDataError) {
				new Notice(t("notice.unsupported_historical_data"), 0);
			}
			throw error;
		}
		this.legacyExposureRemediationPending =
			this.readLegacyExposureRemediationFlag();

		// Configure logger from settings
		logger.configure({
			app: this.app,
			minLevel: this.settings.enableDebugLogging ? "debug" : "info",
			consoleEnabled: true,
			fileEnabled: this.settings.logToFile,
			baseContext: {
				pluginVersion: this.manifest.version,
			},
		});
		logger.info("Loading Yandex Disk Sync plugin...");

		const installationDeviceId = this.settings.deviceId;
		logger.configure({
			baseContext: {
				pluginVersion: this.manifest.version,
				deviceId: shortenDiagnosticValue(installationDeviceId),
			},
		});

		// Initialize components
		this.initializeComponents();
		await this.initEncryption();

		// Register settings tab
		this.addSettingTab(new YandexDiskSyncSettingTab(this.app, this));

		// Register commands
		this.registerCommands();

		// Create status bar and sidebar button
		this.createSyncIndicator();
		this.createSyncSidebarButton();

		// Wait for layout ready to start synchronization
		this.app.workspace.onLayoutReady(() => {
			void this.onLayoutReady();
		});

		logger.info("Yandex Disk Sync plugin loaded");
	}

	onunload(): void {
		this.unloaded = true;
		this.forceSyncController?.dispose();
		logger.info("Unloading Yandex Disk Sync plugin...");

		// Stop components
		if (this.fileWatcher) {
			this.fileWatcher.stop();
		}
		if (this.syncScheduler) {
			this.syncScheduler.stop();
		}
		this.syncIndicator = null;
		if (this.sidebarButton) {
			this.sidebarButton.remove();
			this.sidebarButton = null;
		}
		this.disposeSyncNotice();
		if (this.epochRecoveryTimer !== null) {
			window.clearTimeout(this.epochRecoveryTimer);
			this.epochRecoveryTimer = null;
		}
		this.blockingNotice?.notice.hide();
		this.blockingNotice = null;

		// Save the sync snapshot; plugin unload itself is not asynchronous.
		if (this.pluginDataLoaded) {
			void this.persistPluginData().catch(() => {
				logger.warn("Plugin snapshot could not be saved on unload");
			});
		}

		logger.info("Yandex Disk Sync plugin unloaded");
		void logger.flush();
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
		this.configuredToken = this.settings.yandexTokenSecret;
		this.configuredRemotePath = this.settings.remotePath;

		// Create vault adapter
		this.vaultAdapter = new VaultAdapter(this.app, this.settings);

		// Create index manager
		this.indexManager = new IndexManager(
			this.yandexClient,
			this.vaultAdapter,
			this.settings,
		);
		if (this.loadedPluginData?.localState) {
			this.indexManager.loadLocalIndexFromData(
				this.loadedPluginData.localState,
			);
		}
		this.indexManager.loadPendingMutations(
			this.loadedPluginData?.pendingMutations,
		);
		this.indexManager.loadPendingPhysicalActions(
			this.loadedPluginData?.pendingPhysicalActions,
		);

		// Create sync engine
		this.syncEngine = new SyncEngine(
			this.yandexClient,
			this.vaultAdapter,
			this.indexManager,
			this.settings,
		);
		this.yandexClient.setRetryCallback((progress) =>
			this.syncEngine.reportRetry(progress),
		);
		this.register(() => this.yandexClient.setRetryCallback());

		this.encryptionTransitionController =
			new EncryptionTransitionController(
				this.indexManager,
				this.syncEngine,
				{
					claim: async (transition) =>
						await this.claimEncryptionMaintenance(transition),
					applyTarget: async (snapshot) =>
						await this.applyEncryptionSnapshot(snapshot),
					resolveTargetPaths: async (transition) =>
						await this.resolveTransitionTargetPaths(transition),
					assertSourceUnchanged: async (transition) =>
						await this.assertTransitionSourceUnchanged(transition),
					verifyTargetUpload: async (
						transition,
						logicalPath,
						sha256,
					) => {
						const proof = await this.verifyTransitionTargetObject(
							transition,
							logicalPath,
							sha256,
							this.encryptionService,
							false,
						);
						if (!proof) {
							throw new Error(
								`Uploaded target is missing for ${logicalPath}`,
							);
						}
						return proof;
					},
					setPhase: async (phase) =>
						await this.setEncryptionTransitionPhase(phase),
					stageMaintenance: async (transition, phase, cleanup) =>
						await this.stageCanonicalMaintenance(
							transition,
							phase,
							cleanup,
						),
					commitMaintenance: async (transition, phase, cleanup) =>
						await this.commitCanonicalMaintenance(
							transition,
							phase,
							cleanup,
						),
					publishStable: async (snapshot) => {
						const authority = this.indexManager.getMaintenance();
						if (!authority) {
							throw new Error(
								"Transition publication has no canonical authority",
							);
						}
						await this.indexManager.assertMaintenanceAuthority(
							this.indexManager.getRemoteIndex().epoch,
							authority,
						);
						await this.publishStableEncryptionSnapshot(snapshot);
					},
					prepareCleanup: async (paths, fingerprints) =>
						await this.prepareGuardedCleanup(paths, fingerprints),
					deletePaths: async (paths, fingerprints) =>
						await this.deleteRemoteRawPaths(paths, fingerprints),
					deleteFolders: async (paths) =>
						await this.deleteRemoteRawFolders(paths),
					finishMaintenance: async (transition) =>
						await this.finishCanonicalMaintenanceIfCleanupComplete(
							transition,
						),
					clearLocalTransition: async () => {
						this.encryptionTransition = null;
						await this.saveSettings();
					},
					recover: async () =>
						await this.recoverEncryptionTransition(),
					clearBlock: () => this.setEncryptionBlock(null),
					createSyncFailure: (errorCount) =>
						new Error(
							t("notice.encryption_sync_failed", {
								errors: errorCount,
							}),
						),
				},
				{
					client: this.yandexClient,
					getRemotePath: () => this.settings.remotePath,
					completeAction: (path) => this.completeGuardedCleanup(path),
					persist: () => this.persistPluginData(),
				},
			);

		this.storageBinding = new StorageBindingController({
			client: this.yandexClient,
			index: this.indexManager,
			getSettings: () => this.settings,
			hasPendingWork: () => this.hasDurableConfigurationWork(),
			hasTransition: () => this.encryptionTransition !== null,
			isUnloaded: () => this.unloaded,
			persist: () => this.persistPluginData(),
			confirm: (path, keep) =>
				new Promise((resolve) =>
					new StorageBindingModal(
						this.app,
						path,
						keep,
						resolve,
					).open(),
				),
		});

		// Set callback for saving local index after auto-sync operations
		this.yandexClient.setWriteGuard(() =>
			this.indexManager.assertRemoteScope(),
		);
		this.syncEngine.setIndexSaveCallback(async () => {
			await this.persistPluginData();
		});
		this.syncEngine.setSyncGuardCallback(async (validationToken) => {
			if (!(await this.ensureStorageBinding(false))) {
				return {
					blockReason: t("storage.blocked"),
					blockCode: "local-state-blocked",
					blockStatus: "error",
				};
			}
			if (this.settingsPersistenceFailed || this.unloaded) {
				return { blockReason: t("notice.remote_recheck_required") };
			}
			if (!this.settings.yandexTokenSecret) {
				return { blockReason: null };
			}
			if (validationToken !== undefined) {
				const unchanged =
					await this.indexManager.isEncryptionManifestTokenCurrent(
						validationToken,
					);
				return {
					blockReason: unchanged
						? null
						: t("notice.encryption_state_changed"),
					validationToken,
				};
			}
			const manifestRead =
				await this.indexManager.downloadEncryptionManifestForGuard();
			const ready = await this.ensureEncryptionReady(
				{ prompt: false },
				manifestRead,
			);
			return {
				blockReason: ready
					? null
					: (this.encryptionBlockReason ??
						t("notice.encryption_password_required")),
				validationToken: manifestRead.validationToken,
			};
		});

		// Create file watcher
		this.fileWatcher = new FileWatcher(
			this.app,
			this.syncEngine,
			this.settings,
		);
		this.fileWatcher.setPersistCallback(async () => {
			await this.persistPluginData();
		});
		this.fileWatcher.setFullSyncRequestCallback(async () => {
			await this.runFullSync(undefined, false);
		});

		// Create sync scheduler
		this.syncScheduler = new SyncScheduler(this.syncEngine, this.settings);

		// Create backup manager
		this.backupManager = new BackupManager(
			this.yandexClient,
			this.vaultAdapter,
			this.settings,
			this.manifest.version,
		);
	}

	/** Mount the same status disclosure above desktop chrome or below mobile headers. */
	private createSyncIndicator(): void {
		const indicator = this.addChild(
			new SyncIndicator(
				this.app,
				() => ({
					sync: this.syncEngine.getState(),
					force: this.forceSyncController?.getState() ?? null,
					foreground: this.foregroundOperation,
				}),
				Platform.isMobile ? "top" : "bottom",
			),
		);
		this.syncIndicator = indicator;
		this.register(this.syncEngine.onStateChange(() => indicator.update()));
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
			},
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
					await this.resumeSyncIfReady();
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
					errorMessage: state.errorMessage
						? sanitizeDiagnosticMessage(state.errorMessage)
						: undefined,
					...this.lastSyncStats,
				}).open();
			},
		});
	}

	/** Resume automation only after a fresh startup-state classification. */
	private async resumeSyncIfReady(): Promise<boolean> {
		if (
			this.isConfigurationBusy() ||
			this.settingsPersistenceFailed ||
			this.unloaded
		) {
			return false;
		}
		this.activeFullRuns = (this.activeFullRuns ?? 0) + 1;
		this.notifyManualActivity();
		try {
			if ((await this.refreshRemoteStartupState(true)) !== "ready") {
				return false;
			}
			if (this.unloaded) {
				return false;
			}
			this.syncEngine.resume();
			const result = await this.runFullSync(undefined, false);
			if (
				!result?.success ||
				this.unloaded ||
				this.syncEngine.isSyncPaused()
			) {
				return false;
			}
			this.regularSyncStarted = true;
			this.fileWatcher.start();
			this.syncScheduler.start();
			new Notice(t("notice.sync_resumed"));
			return true;
		} finally {
			this.activeFullRuns--;
			this.notifyManualActivity();
		}
	}

	/**
	 * Callback when layout is ready
	 */
	private async onLayoutReady(): Promise<void> {
		if (this.unloaded || this.isConfigurationBusy()) {
			return;
		}
		this.activeFullRuns = (this.activeFullRuns ?? 0) + 1;
		this.notifyManualActivity();
		try {
			this.restoreLocalStateOnce();
			this.registerSyncLifecycleOnce();
			if (
				(await this.refreshRemoteStartupState(true)) !== "ready" ||
				this.unloaded
			) {
				return;
			}

			// Sweep stale overwritten-file backups so the data folder doesn't grow
			// without bound. Non-critical: log and ignore failures so a backup
			// cleanup problem never blocks sync startup.
			try {
				await this.vaultAdapter.cleanupOldBackups();
			} catch (error) {
				logger.warn("Overwritten-file backup cleanup failed:", {
					error,
				});
			}
		} finally {
			this.activeFullRuns--;
			this.notifyManualActivity();
		}

		await this.startSync(true, true);
	}

	private async ensureStorageBinding(prompt: boolean): Promise<boolean> {
		let ready = false;
		try {
			ready = await this.storageBinding.ensure(prompt);
		} catch (error) {
			if (!(error instanceof StorageScopeError)) {
				throw error;
			}
			const failure = createSyncFailure(error, {
				stage: "storage-admission",
				action: "read",
				outcome: "stopped-before-write",
			});
			const message = formatOperationFailure(failure.summary);
			this.syncEngine.setExternalBlock(
				"local-state",
				message,
				failure.summary,
			);
			this.stopRegularSync();
			this.showBlockingNotice("local-state", message);
			return false;
		}
		this.syncEngine.setExternalBlock(
			"local-state",
			ready ? null : t("storage.blocked"),
		);
		if (!ready) {
			this.stopRegularSync();
			this.showBlockingNotice("local-state", t("storage.blocked"));
		} else {
			this.clearBlockingNotice("local-state");
		}
		return ready;
	}

	/** Restore persisted causal queues before token or remote checks. */
	private restoreLocalStateOnce(): void {
		if (this.localStateRestored) {
			return;
		}
		const data = this.loadedPluginData;
		if (data?.localState) {
			this.indexManager.loadLocalIndexFromData(data.localState);
		}
		this.indexManager.loadPendingMutations(data?.pendingMutations);
		this.indexManager.loadPendingPhysicalActions(
			data?.pendingPhysicalActions,
		);
		this.fileWatcher.loadDeferredEvents(data?.pendingWatcherEvents);
		if (data?.lastSyncStats) {
			this.lastSyncStats = data.lastSyncStats;
		}
		this.localStateRestored = true;
	}

	/** Register watcher lifecycle exactly once, even when startup is blocked. */
	private registerSyncLifecycleOnce(): void {
		if (this.syncLifecycleRegistered) {
			return;
		}
		this.syncEngine.onSyncPrepare(
			async (context) => await this.fileWatcher.prepareForSync(context),
		);
		this.syncEngine.onSyncPause(
			async (context) => await this.fileWatcher.pauseForSync(context),
		);
		this.syncEngine.onSyncFinalize(
			async (context, result) =>
				await this.fileWatcher.settleAfterReconciliation(
					context,
					result,
				),
		);
		this.syncEngine.onSyncResume(
			async (outcome) => await this.fileWatcher.resumeAfterSync(outcome),
		);
		this.syncLifecycleRegistered = true;
	}

	/**
	 * Reclassify remote state without writes before enabling automation. Legacy
	 * migration is distinct from encryption, historical, and authentication
	 * failures so only the intended Force path can pass its block.
	 */
	private async refreshRemoteStartupState(
		prompt: boolean,
		allowRecovery = true,
	): Promise<"ready" | "migration" | "blocked"> {
		if (!this.settings.yandexTokenSecret) {
			this.setAuthenticationBlock(t("notice.token_missing"));
			logger.info("Token not configured, waiting for settings");
			return "blocked";
		}
		try {
			if (!(await this.ensureStorageBinding(prompt))) {
				return "blocked";
			}
			if (this.remoteStateValidated) {
				if (this.migrationBlockReason) {
					// A different updated device may already have committed replacement.
					this.remoteStateValidated = false;
				} else {
					if (
						this.historicalBlockReason ||
						this.authenticationBlockReason
					) {
						return "blocked";
					}
					if (!this.encryptionBlockReason) {
						return "ready";
					}
					if (!prompt) {
						return "blocked";
					}
				}
			}
			const manifest =
				await this.indexManager.downloadEncryptionManifest();
			if (!manifest) {
				const canonicalFormat =
					await this.indexManager.inspectRemoteCanonicalFormat();
				if (
					canonicalFormat === "legacy" &&
					(this.settings.enableEncryption ||
						this.encryptionTransition)
				) {
					throw new UnsupportedHistoricalDataError(
						"Encrypted current local state cannot migrate a plaintext stable canonical",
					);
				}
				if (canonicalFormat === "legacy") {
					this.setAuthenticationBlock(null);
					this.setHistoricalBlock(null);
					this.setEncryptionBlock(null, false);
					this.setMigrationBlock(t("notice.legacy_index_blocked"));
					this.remoteStateValidated = true;
					return "migration";
				}
			}

			this.setMigrationBlock(null);
			this.setHistoricalBlock(null);
			this.setAuthenticationBlock(null);
			let recovered = false;
			if (allowRecovery) {
				if (this.encryptionTransition) {
					await this.syncEngine.runExclusiveMaintenance(async () => {
						await this.recoverEncryptionTransition();
					});
					recovered = true;
				} else {
					recovered = await this.tryRecoverRemoteTargetTransition();
				}
			} else if (this.encryptionTransition) {
				this.setEncryptionBlock(t("notice.encryption_remote_busy"));
				return "blocked";
			}
			const ready = await this.ensureEncryptionReady(
				{ prompt, allowRecovery },
				{
					manifest: recovered
						? await this.indexManager.downloadEncryptionManifest()
						: manifest,
				},
			);
			this.remoteStateValidated =
				ready || Boolean(this.encryptionBlockReason);
			if (!ready) {
				return "blocked";
			}
			this.setEncryptionBlock(null, false);

			return "ready";
		} catch (error) {
			this.remoteStateValidated = false;
			if (error instanceof LegacyIndexFormatError) {
				this.setAuthenticationBlock(null);
				this.setHistoricalBlock(null);
				this.setEncryptionBlock(null, false);
				this.setMigrationBlock(t("notice.legacy_index_blocked"));
				this.remoteStateValidated = true;
				return "migration";
			}
			if (error instanceof UnsupportedHistoricalDataError) {
				this.setMigrationBlock(null);
				this.setEncryptionBlock(null, false);
				this.setHistoricalBlock(
					t("notice.unsupported_historical_data"),
				);
				this.remoteStateValidated = true;
				return "blocked";
			}
			const failure = createSyncFailure(error, {
				stage: "startup",
				action: "read",
				outcome: "unknown",
			});
			logger.warn("Remote startup validation failed", { error: failure });
			this.setAuthenticationBlock(
				formatOperationFailure(failure.summary),
				failure.summary,
			);
			return "blocked";
		}
	}

	/**
	 * Run full synchronization
	 */
	async runFullSync(
		options?: SyncRunOptions,
		showProgressNotice = !options?.startup,
		forceFinalization = false,
	): Promise<SyncResult | null> {
		if (
			(this.isForceSyncBusy() ||
				this.configurationUpdatePending ||
				this.foregroundOperation ||
				this.unloaded ||
				this.settingsPersistenceFailed) &&
			!forceFinalization
		) {
			return null;
		}
		if (showProgressNotice && this.activeManualFullPromise) {
			return await this.activeManualFullPromise;
		}
		this.activeFullRuns = (this.activeFullRuns ?? 0) + 1;
		this.notifyManualActivity();
		const run = async (): Promise<SyncResult | null> => {
			try {
				if (!this.settings.yandexTokenSecret) {
					this.setAuthenticationBlock(t("notice.token_missing"));
					return null;
				}
				this.restoreLocalStateOnce();
				this.registerSyncLifecycleOnce();
				const startupState =
					await this.refreshRemoteStartupState(showProgressNotice);
				if (startupState !== "ready" || this.unloaded) {
					return null;
				}
				if (showProgressNotice) {
					this.beginSyncNotice(t("notice.sync_started"));
				}
				const result = await this.syncEngine.fullSync(options);

				this.updateLastSyncStats(result);

				// Save updated index after sync
				await this.persistPluginData();
				if (
					!options?.epochRetry &&
					result.errors.some(
						(error) => error.code === "epoch-replaced-during-sync",
					)
				) {
					this.queueEpochRecoveryFull(options);
				}

				if (this.handleBlockingSyncResult(result, showProgressNotice)) {
					return result;
				}
				if (result.success) {
					this.clearBlockingNotice();
				}
				if (result.epochAdopted && !showProgressNotice) {
					new Notice(
						result.conflicts > 0
							? t("notice.epoch_adopted_conflicts", {
									conflicts: result.conflicts,
								})
							: t("notice.epoch_adopted"),
						5000,
					);
				}
				if (showProgressNotice) {
					const successful =
						result.uploaded + result.downloaded + result.deleted;
					this.finishSyncNotice(
						result.epochAdopted
							? result.conflicts > 0
								? t("notice.epoch_adopted_conflicts", {
										conflicts: result.conflicts,
									})
								: t("notice.epoch_adopted")
							: result.success
								? successful === 0
									? t("notice.sync_no_changes")
									: t("notice.sync_completed", { successful })
								: formatSyncErrorSummary(result.errors),
						result.success ? 5000 : 10000,
					);
				}
				return result;
			} catch (e) {
				logger.error("Sync error:", { error: e });
				if (showProgressNotice) {
					this.finishSyncNotice(
						formatOperationFailure(
							createSyncFailure(e, {
								stage: "sync",
								action: "unknown",
							}).summary,
						),
						10000,
					);
				}
				return null;
			}
		};

		const promise = run().finally(() => {
			this.activeFullRuns--;
			this.notifyManualActivity();
		});
		if (!showProgressNotice) {
			return await promise;
		}
		this.activeManualFullPromise = promise.finally(() => {
			if (this.activeManualFullPromise === trackedPromise) {
				this.activeManualFullPromise = null;
				this.notifyManualActivity();
			}
		});
		const trackedPromise = this.activeManualFullPromise;
		this.notifyManualActivity();
		return await trackedPromise;
	}

	private queueEpochRecoveryFull(options?: SyncRunOptions): void {
		if (this.epochRecoveryTimer !== null) {
			return;
		}
		this.epochRecoveryTimer = window.setTimeout(() => {
			this.epochRecoveryTimer = null;
			void this.runFullSync(
				{ ...options, startup: false, epochRetry: true },
				false,
			);
		}, 0);
	}

	/** Show one live Notice backed by the same state as the status bar. */
	private beginSyncNotice(
		initialMessage: string,
		subscribeToEngine = true,
	): Notice {
		this.syncNoticeGeneration++;
		if (this.syncNoticeHideTimer !== null) {
			window.clearTimeout(this.syncNoticeHideTimer);
			this.syncNoticeHideTimer = null;
		}
		const reusableBlockingNotice = this.activeSyncNotice
			? null
			: (this.blockingNotice?.notice ?? null);
		if (reusableBlockingNotice) {
			this.blockingNotice = null;
		}
		const notice =
			this.activeSyncNotice ??
			reusableBlockingNotice ??
			new Notice(initialMessage, 0);
		notice.setMessage(initialMessage);
		this.activeSyncNotice = notice;
		if (!subscribeToEngine) {
			this.syncNoticeUnsubscribe?.();
			this.syncNoticeUnsubscribe = null;
		}
		if (subscribeToEngine && !this.syncNoticeUnsubscribe) {
			this.syncNoticeUnsubscribe = this.syncEngine.onStateChange(
				(state) => {
					if (state.status !== "syncing" || !this.activeSyncNotice) {
						return;
					}
					this.activeSyncNotice.setMessage(
						t("notice.sync_progress", {
							operation: formatSyncActivity(state),
						}),
					);
				},
			);
		}
		return notice;
	}

	/** Turn the active progress Notice into its final state. */
	private finishSyncNotice(message: string, durationMs: number): void {
		if (this.syncNoticeHideTimer !== null) {
			window.clearTimeout(this.syncNoticeHideTimer);
			this.syncNoticeHideTimer = null;
		}
		let notice = this.activeSyncNotice;
		this.syncNoticeUnsubscribe?.();
		this.syncNoticeUnsubscribe = null;
		// noticeEl is available on the minimum supported Obsidian; messageEl is newer.
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		if (!notice || notice.noticeEl?.isConnected === false) {
			notice = new Notice(message, 0);
			this.activeSyncNotice = notice;
		}
		notice.setMessage(message);
		if (durationMs <= 0) {
			return;
		}
		const generation = this.syncNoticeGeneration;
		this.syncNoticeHideTimer = window.setTimeout(() => {
			if (generation !== this.syncNoticeGeneration) {
				return;
			}
			notice.hide();
			if (this.activeSyncNotice === notice) {
				this.activeSyncNotice = null;
			}
			this.syncNoticeHideTimer = null;
		}, durationMs);
	}

	/** Close transient synchronization UI and detach its state subscription. */
	private disposeSyncNotice(): void {
		this.syncNoticeGeneration++;
		if (this.syncNoticeHideTimer !== null) {
			window.clearTimeout(this.syncNoticeHideTimer);
			this.syncNoticeHideTimer = null;
		}
		this.syncNoticeUnsubscribe?.();
		this.syncNoticeUnsubscribe = null;
		this.activeSyncNotice?.hide();
		this.activeSyncNotice = null;
	}

	/** Hide a blocking Notice when its code matches the resolved condition. */
	private clearBlockingNotice(code?: string): void {
		if (code && this.blockingNotice?.code !== code) {
			return;
		}
		this.blockingNotice?.notice.hide();
		this.blockingNotice = null;
	}

	/** Present one persistent actionable block, reusing progress UI when possible. */
	private showBlockingNotice(
		code: string,
		message: string,
		reuseProgressNotice = false,
	): void {
		if (this.isForceSyncBusy()) {
			reuseProgressNotice = true;
		}
		if (reuseProgressNotice && this.activeSyncNotice) {
			this.finishSyncNotice(message, 0);
			this.blockingNotice?.notice.hide();
			this.blockingNotice = {
				code,
				notice: this.activeSyncNotice,
			};
			this.activeSyncNotice = null;
			return;
		}
		if (this.blockingNotice?.code === code) {
			this.blockingNotice.notice.setMessage(message);
			return;
		}
		this.blockingNotice?.notice.hide();
		this.blockingNotice = {
			code,
			notice: new Notice(message, 0),
		};
	}

	/** Choose persistent or timed encryption error presentation by actionability. */
	private finishEncryptionError(error: unknown): void {
		const originalMessage = error instanceof Error ? error.message : "";
		const actionableMessages = new Set([
			t("notice.encryption_wrong_password"),
			t("notice.encryption_password_required"),
			t("notice.encryption_password_changed_remote"),
			t("notice.encryption_remote_busy"),
		]);
		if (
			actionableMessages.has(originalMessage) ||
			this.syncEngine.getState().status === "encryption-required"
		) {
			this.showBlockingNotice(
				"encryption-state",
				actionableMessages.has(originalMessage)
					? originalMessage
					: formatOperationFailure(
							createSyncFailure(error, {
								stage: "encryption",
								action: "unknown",
							}).summary,
						),
				true,
			);
			return;
		}
		this.finishSyncNotice(
			formatOperationFailure(
				createSyncFailure(error, {
					stage: "encryption",
					action: "unknown",
				}).summary,
			),
			10000,
		);
	}

	private handleBlockingSyncResult(
		result: SyncResult,
		reuseProgressNotice = false,
	): boolean {
		const blockingError = result.errors.find((error) =>
			[
				"unsupported-historical",
				"legacy-index",
				"migration-required",
				"unreadable-index",
				"invalid-index",
				"ambiguous-index-lock",
				"remote-maintenance",
				"encryption-blocked",
				"local-state-blocked",
				"authentication",
			].includes(error.code ?? ""),
		);
		if (!blockingError) {
			return false;
		}

		this.fileWatcher.stop();
		this.syncScheduler.stop();
		this.regularSyncStarted = false;
		const noticeKey = {
			"local-state-blocked": "storage.blocked",
			"unsupported-historical": "notice.unsupported_historical_data",
			"legacy-index": "notice.legacy_index_blocked",
			"migration-required": "notice.legacy_index_blocked",
			"unreadable-index": "notice.unreadable_index_blocked",
			"invalid-index": "notice.invalid_index_blocked",
			"ambiguous-index-lock": "notice.ambiguous_index_blocked",
			"remote-maintenance": "notice.encryption_remote_busy",
			"encryption-blocked": null,
			authentication: "notice.token_invalid",
		}[blockingError.code ?? ""];
		const message = noticeKey ? t(noticeKey) : blockingError.message;
		this.showBlockingNotice(
			blockingError.code ?? "unknown",
			message,
			reuseProgressNotice,
		);
		logger.warn("Synchronization blocked", {
			code: blockingError.code,
		});
		return true;
	}

	/**
	 * Show confirm modal for force sync operation
	 */
	private confirmForceSync(
		direction: ForceDirection,
		requireLegacyClientsStopped: boolean,
	): Promise<OperationBackupChoice> {
		return new Promise((resolve) => {
			new ForceSyncModal(
				this.app,
				direction,
				resolve,
				requireLegacyClientsStopped,
			).open();
		});
	}

	/** Read-only preflight with actionable presentation of migration blocks. */
	private async prepareForceSync(): Promise<{
		canonical: ForceBackupProof["canonical"];
		migration: boolean;
	} | null> {
		if (!this.settings.yandexTokenSecret) {
			this.showBlockingNotice("token-missing", t("notice.token_missing"));
			return null;
		}
		const startupState = await this.refreshRemoteStartupState(true, false);
		if (startupState === "blocked") {
			return null;
		}
		let canonical: ForceBackupProof["canonical"];
		try {
			canonical = await this.indexManager.captureForceCanonicalProof();
			await this.indexManager.assertLegacyMigrationPathsSafe();
			if (this.legacyExposureRemediationPending) {
				throw new LegacyTokenRotationRequiredError();
			}
		} catch (error) {
			logger.warn("Force preflight rejected the canonical source", {
				error,
			});
			if (error instanceof UnsupportedHistoricalDataError) {
				this.fileWatcher.stop();
				this.syncScheduler.stop();
				this.regularSyncStarted = false;
				this.showBlockingNotice(
					"unsupported-historical",
					t("notice.unsupported_historical_data"),
				);
				return null;
			}
			if (
				error instanceof LegacyPluginDataExposureError ||
				error instanceof LegacyServicePathCollisionError
			) {
				if (error instanceof LegacyPluginDataExposureError) {
					this.markLegacyExposureRemediationRequired();
				}
				this.setMigrationBlock(
					t(
						error instanceof LegacyPluginDataExposureError
							? "notice.legacy_plugin_data_exposure"
							: "notice.legacy_service_collision",
					),
				);
				return null;
			}
			if (error instanceof LegacyTokenRotationRequiredError) {
				this.setMigrationBlock(
					t("notice.legacy_token_rotation_required"),
				);
				return null;
			}
			throw createSyncFailure(error, {
				stage: "preflight",
				action: "read",
				outcome: "stopped-before-write",
			});
		}
		return { canonical, migration: startupState !== "ready" };
	}

	private async captureForceSnapshot(
		direction: ForceDirection,
	): Promise<string> {
		return direction === "from_local"
			? (
					await captureRemoteRawSnapshot(
						this.yandexClient,
						this.settings.remotePath,
					)
				).digest
			: (await captureLogicalVaultSnapshot(this.vaultAdapter)).digest;
	}

	/** Compose the shared Force workflow; the controller owns its lifetime. */
	getForceSyncController(): ForceSyncController {
		if (!this.forceSyncController) {
			this.forceSyncController = new ForceSyncController({
				isSyncBusy: () => this.isForceSyncUnavailable(),
				preflight: () => this.prepareForceSync(),
				confirm: (direction, migration) =>
					this.confirmForceSync(direction, migration),
				captureProtectedSnapshot: (direction) =>
					this.captureForceSnapshot(direction),
				readyForBackup: async (migration) =>
					(!migration ||
						(await this.recheckLegacyMigrationSafety())) &&
					(await this.ensureEncryptionReady({
						prompt: true,
						allowRecovery: false,
					})),
				backup: (direction, progress) =>
					direction === "from_local"
						? this.backupManager.createRemoteSnapshotBackup(
								undefined,
								progress,
							)
						: this.backupManager.createBackup(undefined, progress),
				beforeMutation: async (migration) => {
					if (
						migration &&
						!(await this.recheckLegacyMigrationSafety())
					) {
						throw new Error(
							"Legacy migration safety changed before Force cutover",
						);
					}
				},
				run: (direction, options) =>
					direction === "from_local"
						? this.syncEngine.forceSyncFromLocal(options)
						: this.syncEngine.forceSyncFromRemote(options),
				persist: async (result) => {
					this.updateLastSyncStats(result);
					await this.persistPluginData();
				},
				replacementCommitted: () => {
					this.setMigrationBlock(null);
					this.remoteStateValidated = false;
				},
				reconcile: async (onActivity) => {
					const result = await this.runFullSync(
						{ onActivity },
						false,
						true,
					);
					if (result?.success) {
						await this.indexManager.assertForceCleanupComplete();
					}
					if (
						result?.success &&
						!this.unloaded &&
						!this.syncEngine.isSyncPaused()
					) {
						this.regularSyncStarted = true;
						this.fileWatcher.start();
						this.syncScheduler.start();
					}
					return result;
				},
				hasPendingCleanup: () =>
					this.indexManager.getPendingPhysicalActions().length > 0 ||
					this.indexManager.getMaintenance() !== undefined,
				reportError: (error) =>
					logger.error("Force workflow failed", { error }),
			});
			this.forceSyncController.subscribe((state) =>
				this.renderForceProgress(state),
			);
		}
		return this.forceSyncController;
	}

	isForceSyncBusy(): boolean {
		return this.forceSyncController?.isBusy() ?? false;
	}

	isForceSyncUnavailable(): boolean {
		return Boolean(
			this.isConfigurationBusy() ||
			this.encryptionTransition ||
			this.settingsPersistenceFailed ||
			this.unloaded,
		);
	}

	/** Subscribe without exposing synchronization internals to settings. */
	onSyncActivityChange(callback: () => void): () => void {
		this.manualActivityListeners.add(callback);
		const unsubscribe = this.syncEngine.onStateChange(callback);
		return () => {
			unsubscribe();
			this.manualActivityListeners.delete(callback);
		};
	}

	private notifyManualActivity(): void {
		this.syncIndicator?.update();
		for (const callback of this.manualActivityListeners ?? []) {
			try {
				callback();
			} catch (error) {
				logger.warn("Manual activity presentation failed", { error });
			}
		}
	}

	/** Keep one foreground Notice across backup, Force, persistence and full reconciliation. */
	private renderForceProgress(state: ForceFlowState): void {
		this.syncIndicator?.update();
		if (state.active) {
			if (state.outcome) {
				return;
			}
			const notice = this.beginSyncNotice(
				formatForceActivity(state),
				false,
			);
			notice.setMessage(formatForceActivity(state));
			return;
		}
		if (state.outcome === "cancelled") {
			this.disposeSyncNotice();
			return;
		}
		if (state.outcome === "blocked" && this.blockingNotice) {
			this.disposeSyncNotice();
			return;
		}
		if (state.outcome === "success") {
			this.clearBlockingNotice();
		}
		this.beginSyncNotice(formatForceResult(state), false);
		this.finishSyncNotice(
			formatForceResult(state),
			state.outcome === "success" ? 8000 : 0,
		);
	}

	private async recheckLegacyMigrationSafety(): Promise<boolean> {
		try {
			await this.indexManager.assertLegacyMigrationPathsSafe();
			if (this.legacyExposureRemediationPending) {
				throw new LegacyTokenRotationRequiredError();
			}
			return true;
		} catch (error) {
			if (error instanceof LegacyPluginDataExposureError) {
				this.markLegacyExposureRemediationRequired();
				this.setMigrationBlock(t("notice.legacy_plugin_data_exposure"));
				return false;
			}
			if (error instanceof LegacyServicePathCollisionError) {
				this.setMigrationBlock(t("notice.legacy_service_collision"));
				return false;
			}
			if (error instanceof LegacyTokenRotationRequiredError) {
				this.setMigrationBlock(
					t("notice.legacy_token_rotation_required"),
				);
				return false;
			}
			logger.warn("Legacy migration safety recheck failed", { error });
			this.showBlockingNotice(
				"force-preflight",
				t("notice.force_sync_exception", {
					message:
						error instanceof Error ? error.message : String(error),
				}),
			);
			return false;
		}
	}

	/** Run the local-to-remote Force flow once. */
	async runForceSyncFromLocal(): Promise<void> {
		await this.getForceSyncController().run("from_local");
	}

	/** Run the remote-to-local Force flow once. */
	async runForceSyncFromRemote(): Promise<void> {
		await this.getForceSyncController().run("from_remote");
	}

	/**
	 * Start regular synchronization
	 */
	private async startSync(
		startup = false,
		remoteReady = false,
	): Promise<void> {
		if (
			this.isConfigurationBusy() ||
			this.unloaded ||
			this.settingsPersistenceFailed ||
			this.syncEngine.isSyncPaused()
		) {
			return;
		}
		if (this.regularSyncStarted) {
			logger.debug("[Main] Regular synchronization already started");
			return;
		}
		if (
			!remoteReady &&
			(await this.refreshRemoteStartupState(true)) !== "ready"
		) {
			return;
		}
		if (
			this.unloaded ||
			this.isConfigurationBusy() ||
			this.syncEngine.isSyncPaused()
		) {
			return;
		}
		const result = await this.runFullSync(
			startup ? { startup: true } : undefined,
			false,
		);
		if (
			!result?.success ||
			this.unloaded ||
			this.syncEngine.isSyncPaused()
		) {
			return;
		}
		if (startup) {
			const maintenance = this.indexManager.getMaintenance();
			const hasGuardedCleanup = this.indexManager
				.getPendingPhysicalActions()
				.some((action) => action.type === "guarded-cleanup");
			if (maintenance?.phase === "cleanup" || hasGuardedCleanup) {
				await this.syncEngine.runExclusiveMaintenance(async () => {
					await this.requireCanonicalMaintenanceCleanupComplete();
				});
			}
		}
		if (
			this.unloaded ||
			this.isConfigurationBusy() ||
			this.syncEngine.isSyncPaused()
		) {
			return;
		}
		this.fileWatcher.start();
		this.syncScheduler.start();
		this.regularSyncStarted = true;
		logger.info("[Main] Synchronization started");
	}

	/**
	 * Load settings
	 */
	async loadSettings(): Promise<void> {
		this.pluginDataLoaded = false;
		const generation = ++this.pluginDataLoadGeneration;
		// Drain in-flight saves and invalidate queued saves before reading storage.
		await this.pluginDataPersistenceTail;
		const loaded = loadPluginDataWithSource(
			(await this.loadData()) as PluginData | null,
		);
		if (generation !== this.pluginDataLoadGeneration) {
			throw new Error("Plugin data load was superseded");
		}
		const data = loaded.data;
		this.loadedPluginData = data;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
		if (data?.lastSyncStats) {
			this.lastSyncStats = data.lastSyncStats;
		}
		this.encryptionTransition = data?.encryptionTransition ?? null;

		// Automatically determine path with vault name
		const vaultName = this.app.vault.getName();
		const saved = data?.settings;
		this.pluginDataLoaded = true;

		// Apply automatic path determination if:
		// - settings were not saved before, or
		// - path is not set, or
		// - path equals the default value
		if (
			loaded.source !== "stable-1x" &&
			(!saved ||
				!this.settings.remotePath ||
				this.settings.remotePath === DEFAULT_SETTINGS.remotePath)
		) {
			this.settings.remotePath = `${DEFAULT_SETTINGS.remotePath}/${vaultName}`;
		}
		this.settings.deviceId = this.getInstallationDeviceId(
			data?.localState?.deviceId,
		);
		if (
			data?.localState &&
			data.localState.deviceId !== this.settings.deviceId
		) {
			if (
				data.pendingMutations.length ||
				data.pendingPhysicalActions.length ||
				data.pendingWatcherEvents.length ||
				data.encryptionTransition
			) {
				this.pluginDataLoaded = false;
				throw new StorageScopeError(
					"Unfinished state belongs to another installation",
				);
			}
			data.localState = {
				...data.localState,
				deviceId: this.settings.deviceId,
				nextMutationSeq: 1,
			};
		}
		try {
			await this.persistPluginData();
			try {
				globalThis.localStorage?.setItem(
					`yandex-disk-sync:device-id:${this.getVaultStorageScope()}`,
					this.settings.deviceId,
				);
			} catch {
				// Plugin data remains the durable causal snapshot.
			}
		} catch (error) {
			this.pluginDataLoaded = false;
			throw error;
		}
	}

	/**
	 * Return a stable installation-scoped device ID stored outside the vault.
	 * Desktop vaults use their absolute adapter path as a local-only namespace;
	 * mobile adapters fall back to the vault name inside the app profile.
	 */
	private getInstallationDeviceId(persistedDeviceId?: string): string {
		const key = `yandex-disk-sync:device-id:${this.getVaultStorageScope()}`;
		try {
			const existing = globalThis.localStorage?.getItem(key);
			if (existing && persistedDeviceId) {
				return existing;
			}
			return persistedDeviceId ?? generateDeviceId();
		} catch {
			return persistedDeviceId ?? generateDeviceId();
		}
	}

	private getVaultStorageScope(): string {
		const adapter = this.app.vault.adapter as unknown as {
			getBasePath?: () => string;
		};
		return adapter?.getBasePath?.() || this.app.vault.getName();
	}

	private getLegacyExposureStorageKey(): string {
		return `yandex-disk-sync:legacy-exposure:${this.getVaultStorageScope()}`;
	}

	private readLegacyExposureRemediationFlag(): boolean {
		try {
			return (
				globalThis.localStorage?.getItem(
					this.getLegacyExposureStorageKey(),
				) === "required"
			);
		} catch {
			return false;
		}
	}

	private markLegacyExposureRemediationRequired(): void {
		this.legacyExposureRemediationPending = true;
		this.legacyExposedTokenInSession = this.settings.yandexTokenSecret;
		try {
			globalThis.localStorage?.setItem(
				this.getLegacyExposureStorageKey(),
				"required",
			);
		} catch {
			// The in-memory block still protects this plugin session.
		}
	}

	private clearLegacyExposureRemediation(): void {
		this.legacyExposureRemediationPending = false;
		try {
			globalThis.localStorage?.removeItem(
				this.getLegacyExposureStorageKey(),
			);
		} catch {
			// The remote safety check still runs before every migration Force.
		}
	}

	private updateLegacyExposureAfterTokenChange(tokenChanged: boolean): void {
		if (
			tokenChanged &&
			this.settings.yandexTokenSecret &&
			this.settings.yandexTokenSecret !== this.legacyExposedTokenInSession
		) {
			this.clearLegacyExposureRemediation();
		} else if (
			this.legacyExposedTokenInSession !== null &&
			this.settings.yandexTokenSecret === this.legacyExposedTokenInSession
		) {
			this.markLegacyExposureRemediationRequired();
		}
	}

	private configurationUpdatePending = false;
	private foregroundOperation: "encryption" | "backup" | null = null;
	private unloaded = false;
	private settingsPersistenceFailed = false;
	private storageBinding!: StorageBindingController;

	/** Save a validated draft before publishing it to live components. */
	async applySettingsPatch(patch: UserSettingsPatch): Promise<void> {
		const draft = prepareSettingsPatch(this.settings, patch);
		patch = {
			...patch,
			...(patch.syncPatterns
				? { syncPatterns: [...patch.syncPatterns] }
				: {}),
			...(patch.excludePatterns
				? { excludePatterns: [...patch.excludePatterns] }
				: {}),
		};
		const recoveringPersistence = this.settingsPersistenceFailed;
		const changesScope = draft.changesScope || recoveringPersistence;
		if (
			changesScope &&
			(this.isConfigurationBusy() ||
				(this.encryptionTransition && draft.changesTransitionScope))
		) {
			throw new Error(t("notice.configuration_busy"));
		}
		if (draft.changesDestination && this.hasDurableConfigurationWork()) {
			throw new Error(t("notice.configuration_busy"));
		}
		if (changesScope) {
			this.configurationUpdatePending = true;
			this.notifyManualActivity();
			this.stopRegularSync();
			this.syncEngine?.setExternalBlock(
				"authentication",
				t("notice.configuration_busy"),
			);
		}
		try {
			if (changesScope) {
				await this.fileWatcher?.waitForPendingPersistence();
				if (
					this.syncEngine?.hasPendingWork() ||
					(draft.changesDestination &&
						this.hasDurableConfigurationWork())
				) {
					throw new Error(t("notice.configuration_busy"));
				}
			}
			await this.persistPluginData(patch);
			this.settingsPersistenceFailed = false;
			if (this.unloaded) {
				return;
			}
			if (changesScope) {
				this.invalidateRemoteStateClassification();
				const ready = await this.refreshRemoteStartupState(
					false,
					false,
				);
				if (
					ready === "ready" &&
					!this.unloaded &&
					this.app.workspace.layoutReady &&
					!this.syncEngine.isSyncPaused()
				) {
					if (draft.needsFull || recoveringPersistence) {
						const result = await this.runFullSync(
							undefined,
							false,
							true,
						);
						if (!result?.success) {
							return;
						}
					}
					if (!this.unloaded && !this.syncEngine.isSyncPaused()) {
						this.fileWatcher.start();
						this.syncScheduler.start();
						this.regularSyncStarted = true;
					}
				}
			}
		} catch (error) {
			if (changesScope || this.settingsPersistenceFailed) {
				this.remoteStateValidated = false;
				this.setAuthenticationBlock(
					t("notice.remote_recheck_required"),
				);
			}
			throw error;
		} finally {
			if (changesScope) {
				this.configurationUpdatePending = false;
				this.notifyManualActivity();
			}
		}
	}

	private hasDurableConfigurationWork(): boolean {
		return Boolean(
			this.indexManager?.getPendingMutations().length ||
			this.indexManager?.getPendingPhysicalActions().length ||
			this.fileWatcher?.getDeferredEvents().length,
		);
	}

	/** Include full-sync validation and persistence as well as scheduled engine sessions. */
	isFullSyncInProgress(): boolean {
		return Boolean(
			this.activeFullRuns ||
			this.syncEngine?.getState().sessionKind === "full",
		);
	}

	isConfigurationBusy(): boolean {
		return Boolean(
			this.configurationUpdatePending ||
			this.foregroundOperation ||
			this.isForceSyncBusy() ||
			this.activeManualFullPromise ||
			this.activeFullRuns ||
			this.syncEngine?.hasPendingWork(),
		);
	}

	/** Reserve manual preflight through completion without nesting coordinator sessions. */
	private async withForegroundOperation<T>(
		kind: "encryption" | "backup",
		operation: () => Promise<T>,
	): Promise<T> {
		this.assertForceIdle();
		if (
			this.isConfigurationBusy() ||
			this.unloaded ||
			this.settingsPersistenceFailed
		) {
			throw new Error(t("notice.configuration_busy"));
		}
		this.foregroundOperation = kind;
		this.notifyManualActivity();
		try {
			if (!(await this.ensureStorageBinding(true))) {
				throw new StorageScopeError(t("storage.blocked"));
			}
			return await operation();
		} finally {
			this.foregroundOperation = null;
			this.notifyManualActivity();
		}
	}

	async saveSettings(): Promise<void> {
		this.assertPluginDataLoaded();
		this.publishSettingsToComponents();
		await this.persistPluginData();
	}

	private publishSettingsToComponents(): void {
		const tokenChanged =
			this.configuredToken !== null &&
			this.configuredToken !== this.settings.yandexTokenSecret;
		const remoteConfigurationChanged =
			this.configuredToken !== null &&
			(this.configuredToken !== this.settings.yandexTokenSecret ||
				this.configuredRemotePath !== this.settings.remotePath);
		// Update logger configuration
		logger.configure({
			app: this.app,
			minLevel: this.settings.enableDebugLogging ? "debug" : "info",
			consoleEnabled: true,
			fileEnabled: this.settings.logToFile,
			baseContext: {
				pluginVersion: this.manifest.version,
				deviceId: shortenDiagnosticValue(this.settings.deviceId),
			},
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
		if (
			this.migrationBlockReason ||
			this.encryptionBlockReason ||
			this.historicalBlockReason ||
			this.authenticationBlockReason
		) {
			this.stopRegularSync();
		}
		if (remoteConfigurationChanged) {
			this.invalidateRemoteStateClassification();
		}
		this.updateLegacyExposureAfterTokenChange(tokenChanged);
		if (this.yandexClient) {
			this.configuredToken = this.settings.yandexTokenSecret;
			this.configuredRemotePath = this.settings.remotePath;
		}
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
			!this.settings.enableEncryption ||
			!this.settings.encryptionSalt ||
			!this.settings.encryptionPassword
		) {
			this.yandexClient.setEncryptionService(null);
			return;
		}

		try {
			const salt = EncryptionService.base64ToBytes(
				this.settings.encryptionSalt,
			);
			const service = createEncryptionCodec(
				this.requireEncryptionProfileId(),
				salt,
			);
			await service.initializeKey(this.settings.encryptionPassword);
			this.encryptionService = service;
			this.yandexClient.setEncryptionService(service);
			logger.info("Encryption initialized successfully");
		} catch (e) {
			logger.warn("Failed to initialize encryption:", { error: e });
			this.encryptionService = null;
			this.yandexClient.setEncryptionService(null);
			this.setEncryptionBlock(t("notice.encryption_wrong_password"));
		}
	}

	/**
	 * Enable encryption or connect to an already encrypted remote vault.
	 */
	async enableEncryption(password: string): Promise<void> {
		return await this.withForegroundOperation("encryption", async () => {
			this.assertForceIdle();
			if (this.migrationBlockReason) {
				throw new LegacyIndexFormatError();
			}
			const manifest =
				await this.indexManager.downloadEncryptionManifest();
			const choice = manifest
				? undefined
				: await this.confirmOperationBackup();
			if (choice === "cancel") {
				return;
			}
			if (this.unloaded) {
				throw new Error("Plugin was unloaded");
			}
			this.beginSyncNotice(t("notice.encryption_syncing"));
			try {
				await this.syncEngine.runExclusiveMaintenance(async () => {
					await this.enableEncryptionNow(password, choice);
				});
				await this.restoreAutomationAfterEncryption();
				this.clearBlockingNotice();
				this.finishSyncNotice(t("notice.encryption_enabled"), 5000);
			} catch (error) {
				this.finishEncryptionError(error);
				throw error;
			}
		});
	}

	private async enableEncryptionNow(
		password: string,
		choice?: OperationBackupChoice,
	): Promise<void> {
		const remoteManifest =
			await this.indexManager.downloadEncryptionManifest();
		if (remoteManifest) {
			await this.connectToRemoteEncryptionNow(password, remoteManifest);
			return;
		}

		await this.runEncryptionPreflight();
		const backupProof = await this.createSelectedEncryptionBackup(
			choice,
			password,
		);
		const sourceFiles = await this.indexManager.getRemoteRawFileSnapshots();
		const oldRawPaths = sourceFiles.map((file) => file.path);
		const source = this.captureEncryptionSnapshot();
		const saltBytes = EncryptionService.generateSalt();
		const saltBase64 = EncryptionService.bytesToBase64(saltBytes);
		const revision = 1;
		const service = createEncryptionCodec("hardened", saltBytes);
		await service.initializeKey(password);
		const target: LocalEncryptionSnapshot = {
			enabled: true,
			salt: saltBase64,
			password,
			revision,
			profileId: "hardened",
		};
		const transition = await this.beginEncryptionTransition(
			"enable",
			source,
			target,
			oldRawPaths,
			Object.fromEntries(
				sourceFiles.map((file) => [file.path, file.fingerprint]),
			),
			backupProof,
		);
		const publishEnablingManifest = this.createEncryptionManifestPublisher(
			service,
			saltBase64,
			"enabling",
			revision,
			transition,
		);

		logger.info("Re-uploading all files with encryption...");
		await this.encryptionTransitionController.execute({
			transition,
			sourceService: null,
			beforeApplyTarget: publishEnablingManifest,
			publishFilesCopied: publishEnablingManifest,
			publishIndexCommitted: publishEnablingManifest,
		});
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
	async disableEncryption(options?: {
		reuploadPlaintext?: boolean;
	}): Promise<{ hadErrors: boolean }> {
		return await this.withForegroundOperation("encryption", async () => {
			this.assertForceIdle();
			if (this.migrationBlockReason) {
				throw new LegacyIndexFormatError();
			}
			const choice = options?.reuploadPlaintext
				? await this.confirmOperationBackup()
				: undefined;
			if (choice === "cancel") {
				return { hadErrors: false };
			}
			if (this.unloaded) {
				throw new Error("Plugin was unloaded");
			}
			this.beginSyncNotice(t("notice.encryption_disabling"));
			try {
				const result = await this.syncEngine.runExclusiveMaintenance(
					async () => this.disableEncryptionNow(options, choice),
				);
				if (!result.hadErrors) {
					await this.restoreAutomationAfterEncryption();
				}
				this.finishSyncNotice(
					result.hadErrors
						? t("notice.encryption_disable_partial")
						: t("notice.encryption_disabled"),
					result.hadErrors ? 10000 : 5000,
				);
				return result;
			} catch (error) {
				this.finishEncryptionError(error);
				throw error;
			}
		});
	}

	private async disableEncryptionNow(
		options?: {
			reuploadPlaintext?: boolean;
		},
		choice?: OperationBackupChoice,
	): Promise<{ hadErrors: boolean }> {
		let partialErrors = false;

		if (options?.reuploadPlaintext) {
			if (this.settings.encryptionProfileId !== "hardened") {
				throw new UnsupportedHistoricalDataError(
					"Only hardened encryption can be disabled",
				);
			}
			await this.runEncryptionPreflight();
			const backupPassword = this.settings.encryptionPassword;
			if (!backupPassword) {
				throw new Error(t("notice.encryption_password_required"));
			}
			const backupProof = await this.createSelectedEncryptionBackup(
				choice,
				backupPassword,
			);
			const source = this.captureEncryptionSnapshot();
			const sourceService = this.encryptionService;
			// Capture encrypted paths while service is still active
			const sourceFiles =
				await this.indexManager.getRemoteRawFileSnapshots();
			const oldRawPaths = sourceFiles.map((file) => file.path);
			const target: LocalEncryptionSnapshot = {
				enabled: false,
				salt: null,
				password: null,
				revision: null,
				profileId: null,
			};
			const transition = await this.beginEncryptionTransition(
				"disable",
				source,
				target,
				oldRawPaths,
				Object.fromEntries(
					sourceFiles.map((file) => [file.path, file.fingerprint]),
				),
				backupProof,
			);

			try {
				const publishDisablingManifest =
					sourceService && source.salt
						? this.createEncryptionManifestPublisher(
								sourceService,
								source.salt,
								"disabling",
								source.revision ?? 1,
								transition,
							)
						: async () => undefined;
				logger.info("Re-uploading all files as plaintext...");
				await this.encryptionTransitionController.execute({
					transition,
					sourceService,
					beforeApplyTarget: publishDisablingManifest,
					publishFilesCopied: publishDisablingManifest,
					publishIndexCommitted: publishDisablingManifest,
				});
			} catch (error) {
				logger.warn("Encryption disable did not complete:", {
					error,
				});
				partialErrors = true;
			}
		} else {
			this.encryptionService = null;
			this.yandexClient.setEncryptionService(null);
		}

		if (partialErrors) {
			return { hadErrors: true };
		}

		// Always clear local encryption state regardless of remote errors
		this.settings.enableEncryption = false;
		this.settings.encryptionSalt = null;
		this.settings.encryptionPassword = null;
		this.settings.encryptionRevision = null;
		this.settings.encryptionProfileId = null;
		await this.saveSettings();

		try {
			await this.indexManager.deleteEncryptionManifest();
		} catch (e) {
			logger.warn("Failed to delete encryption manifest from remote:", {
				error: e,
			});
			partialErrors = true;
		}

		this.setEncryptionBlock(null);
		logger.info("Encryption disabled");

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
		this.settings.encryptionProfileId = null;
		await this.saveSettings();
		this.setEncryptionBlock(null);
	}

	/**
	 * Rotate the encryption password and re-upload all files with a new key.
	 */
	async rotateEncryptionPassword(newPassword: string): Promise<void> {
		return await this.withForegroundOperation("encryption", async () => {
			this.assertForceIdle();
			if (this.migrationBlockReason) {
				throw new LegacyIndexFormatError();
			}
			const choice = await this.confirmOperationBackup();
			if (choice === "cancel") {
				return;
			}
			if (this.unloaded) {
				throw new Error("Plugin was unloaded");
			}
			this.beginSyncNotice(t("notice.encryption_password_rotating"));
			try {
				await this.syncEngine.runExclusiveMaintenance(async () => {
					await this.rotateEncryptionPasswordNow(newPassword, choice);
				});
				await this.restoreAutomationAfterEncryption();
				this.finishSyncNotice(
					t("notice.encryption_password_changed"),
					5000,
				);
			} catch (error) {
				this.finishEncryptionError(error);
				throw error;
			}
		});
	}

	private async rotateEncryptionPasswordNow(
		newPassword: string,
		choice?: OperationBackupChoice,
	): Promise<void> {
		const currentManifest =
			await this.indexManager.downloadEncryptionManifest();
		if (currentManifest && currentManifest.state !== "enabled") {
			throw new Error(t("notice.encryption_remote_busy"));
		}
		if (this.settings.encryptionProfileId !== "hardened") {
			throw new UnsupportedHistoricalDataError(
				"Only hardened encryption can be rotated",
			);
		}
		if (!this.settings.enableEncryption || !this.settings.encryptionSalt) {
			throw new Error(t("notice.encryption_password_required"));
		}

		await this.runEncryptionPreflight();
		const backupProof = await this.createSelectedEncryptionBackup(
			choice,
			newPassword,
		);
		const source = this.captureEncryptionSnapshot();
		const sourceService = this.encryptionService;
		const sourceFiles = await this.indexManager.getRemoteRawFileSnapshots();
		const oldRawPaths = sourceFiles.map((file) => file.path);
		const saltBytes = EncryptionService.generateSalt();
		const saltBase64 = EncryptionService.bytesToBase64(saltBytes);
		const revision =
			Math.max(
				currentManifest?.revision ?? 1,
				this.settings.encryptionRevision ?? 1,
			) + 1;
		const service = createEncryptionCodec("hardened", saltBytes);
		await service.initializeKey(newPassword);
		const target: LocalEncryptionSnapshot = {
			enabled: true,
			salt: saltBase64,
			password: newPassword,
			revision,
			profileId: "hardened",
		};
		const transition = await this.beginEncryptionTransition(
			"rotate",
			source,
			target,
			oldRawPaths,
			Object.fromEntries(
				sourceFiles.map((file) => [file.path, file.fingerprint]),
			),
			backupProof,
		);
		const publishRotatingManifest = this.createEncryptionManifestPublisher(
			service,
			saltBase64,
			"rotating",
			revision,
			transition,
		);
		logger.info(
			"Re-uploading all files after encryption password rotation...",
		);
		await this.encryptionTransitionController.execute({
			transition,
			sourceService,
			beforeApplyTarget: publishRotatingManifest,
			publishFilesCopied: publishRotatingManifest,
			publishIndexCommitted: publishRotatingManifest,
		});
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
		manifest?: RemoteEncryptionManifest,
	): Promise<void> {
		await this.withForegroundOperation("encryption", async () => {
			await this.connectToRemoteEncryptionForSync(password, manifest);
			await this.restoreAutomationAfterEncryption();
		});
	}

	/** Reconcile before restarting automation stopped by an encryption block. */
	private async restoreAutomationAfterEncryption(): Promise<void> {
		if (
			this.regularSyncStarted ||
			this.unloaded ||
			this.encryptionTransition ||
			!this.app.workspace.layoutReady ||
			this.syncEngine.isSyncPaused()
		) {
			return;
		}
		const result = await this.runFullSync(undefined, false, true);
		if (
			!result?.success ||
			this.unloaded ||
			this.syncEngine.isSyncPaused()
		) {
			return;
		}
		this.fileWatcher.start();
		this.syncScheduler.start();
		this.regularSyncStarted = true;
	}

	/** Authenticate/recover as part of an admitted sync flow using the existing maintenance queue. */
	private async connectToRemoteEncryptionForSync(
		password: string,
		manifest?: RemoteEncryptionManifest,
	): Promise<void> {
		if (this.migrationBlockReason) {
			throw new LegacyIndexFormatError();
		}
		await this.syncEngine.runExclusiveMaintenance(async () => {
			await this.connectToRemoteEncryptionNow(password, manifest);
		});
	}

	/** Return whether the remote still requires explicit migration. */
	isStableMigrationPending(): boolean {
		return Boolean(this.migrationBlockReason);
	}

	private async connectToRemoteEncryptionNow(
		password: string,
		manifest?: RemoteEncryptionManifest,
	): Promise<void> {
		const remoteManifest =
			manifest ?? (await this.indexManager.downloadEncryptionManifest());
		if (!remoteManifest) {
			throw new Error(t("notice.encryption_remote_missing"));
		}
		const profileId =
			this.encryptionManager.getManifestProfileId(remoteManifest);
		const activeCodecMatchesCandidate = Boolean(
			this.encryptionService &&
			this.settings.enableEncryption &&
			this.settings.encryptionSalt === remoteManifest.salt &&
			this.settings.encryptionPassword === password &&
			this.settings.encryptionProfileId === profileId,
		);
		const candidate = activeCodecMatchesCandidate
			? this.encryptionService!
			: await this.encryptionManager.createCodec(
					profileId,
					remoteManifest.salt,
					password,
				);
		await this.verifyRemoteEncryptionPassword(candidate, remoteManifest);
		const recoveryKind =
			this.encryptionTransitionController.getRemoteTargetRecoveryKind(
				remoteManifest,
			);
		if (recoveryKind === "disable") {
			await this.recoverRemotePlaintextTargetTransition(
				remoteManifest,
				candidate,
			);
		} else if (recoveryKind === "enable" || recoveryKind === "rotate") {
			await this.recoverRemoteEncryptedTargetTransition(
				remoteManifest,
				candidate,
				password,
			);
		} else {
			const canonical = await this.encryptionManager.acceptCandidate({
				service: candidate,
				verifier: remoteManifest.verifier,
				validateAuthority: async () => {
					const current =
						await this.indexManager.readCanonicalIndexWithCodec(
							candidate,
						);
					await this.encryptionTransitionController.assertStableManifestTarget(
						remoteManifest,
						current.maintenance,
						candidate,
					);
					return current;
				},
				persist: async () => {
					await this.applyEncryptionSnapshot({
						enabled: true,
						salt: remoteManifest.salt,
						password,
						revision: remoteManifest.revision,
						profileId,
					});
				},
			});
			if (!canonical) {
				throw new Error(t("notice.encryption_wrong_password"));
			}
			if (canonical.maintenance) {
				await this.indexManager.runTargetMaintenanceRecovery(
					canonical.maintenance.id,
					async () => {
						await this.indexManager.loadRemoteIndexWithTargetCodec(
							candidate,
						);
						await this.encryptionTransitionController.assertStableManifestTarget(
							remoteManifest,
							this.indexManager.getMaintenance(),
							candidate,
						);
						const maintenance = this.indexManager.getMaintenance();
						if (maintenance?.phase === "index-committed") {
							this.indexManager.setMaintenance({
								...maintenance,
								phase: "cleanup",
							});
							await this.indexManager.saveRemoteIndex();
						}
						await this.requireCanonicalMaintenanceCleanupComplete();
					},
				);
			}
		}
		this.setEncryptionBlock(null);
		logger.info("Encryption configured from remote manifest");
	}

	/** Resume post-commit cleanup using only the target password. */
	private async recoverRemoteEncryptedTargetTransition(
		manifest: RemoteEncryptionManifest,
		service: EncryptionCodec,
		password: string,
	): Promise<void> {
		if (!manifest.transition) {
			throw new Error(t("notice.encryption_remote_busy"));
		}
		const candidateCanonical =
			await this.indexManager.readCanonicalIndexWithCodec(service);
		this.encryptionTransitionController.createRemoteTargetRecoveryPlan(
			manifest,
			candidateCanonical.maintenance,
		);
		await this.indexManager.runTargetMaintenanceRecovery(
			manifest.transition.id,
			async () => {
				await this.indexManager.loadRemoteIndexWithTargetCodec(service);
				const maintenance =
					await this.encryptionManager.acceptCandidate({
						service,
						verifier: manifest.verifier,
						validateAuthority: async () =>
							this.encryptionTransitionController.createRemoteTargetRecoveryPlan(
								manifest,
								this.indexManager.getMaintenance(),
							).maintenance,
						persist: async () => {
							await this.applyEncryptionSnapshot({
								enabled: true,
								salt: manifest.salt,
								password,
								revision: manifest.revision,
								profileId: "hardened",
							});
						},
					});
				if (!maintenance) {
					throw new Error(t("notice.encryption_remote_busy"));
				}
				await this.encryptionTransitionController.completeRemoteTarget(
					maintenance,
					async () =>
						this.indexManager.uploadEncryptionManifest(
							await this.createEncryptionManifest(
								service,
								manifest.salt,
								"enabled",
								manifest.revision,
							),
						),
					() => this.requireCanonicalMaintenanceCleanupComplete(),
				);
			},
		);
		this.setEncryptionBlock(null);
	}

	/** Recover a committed disable using the plaintext target canonical. */
	private async recoverRemotePlaintextTargetTransition(
		manifest: RemoteEncryptionManifest | null,
		verifiedSourceService: EncryptionCodec | null,
	): Promise<void> {
		const canonical =
			await this.indexManager.readCanonicalIndexWithCodecIfPresent(null);
		if (!canonical) {
			throw new Error(t("notice.encryption_remote_busy"));
		}
		const maintenance = canonical.maintenance;
		if (!maintenance) {
			throw new Error(t("notice.encryption_remote_busy"));
		}
		const plan =
			this.encryptionTransitionController.createRemoteTargetRecoveryPlan(
				manifest,
				maintenance,
			);
		if (plan.kind !== "disable" || maintenance.target.enabled) {
			throw new Error(t("notice.encryption_remote_busy"));
		}
		if (
			manifest &&
			(!verifiedSourceService ||
				!maintenance.source.verifier ||
				!(await verifiedSourceService.verifyVerifier(
					maintenance.source.verifier,
				)))
		) {
			throw new Error(t("notice.encryption_wrong_password"));
		}

		await this.indexManager.runTargetMaintenanceRecovery(
			maintenance.id,
			async () => {
				this.indexManager.setIndexTransitionServices(null, null);
				try {
					await this.indexManager.loadRemoteIndexWithTargetCodec(
						null,
					);
					const validateCurrent = async () =>
						this.encryptionTransitionController.createRemoteTargetRecoveryPlan(
							manifest,
							this.indexManager.getMaintenance(),
						).maintenance;
					let current: IndexMaintenance | null;
					if (manifest) {
						current = await this.encryptionManager.acceptCandidate({
							service: verifiedSourceService,
							verifier: manifest.verifier,
							validateAuthority: validateCurrent,
							persist: async () => {
								await this.applyEncryptionSnapshot({
									enabled: false,
									salt: null,
									password: null,
									revision: null,
									profileId: null,
								});
							},
						});
					} else {
						current = await validateCurrent();
						await this.applyEncryptionSnapshot({
							enabled: false,
							salt: null,
							password: null,
							revision: null,
							profileId: null,
						});
					}
					if (!current) {
						throw new Error(t("notice.encryption_wrong_password"));
					}
					await this.encryptionTransitionController.completeRemoteTarget(
						current,
						async () => {
							if (manifest) {
								await this.indexManager.deleteEncryptionManifest();
							}
						},
						() => this.requireCanonicalMaintenanceCleanupComplete(),
					);
				} finally {
					this.indexManager.clearIndexTransitionServices();
				}
			},
		);
		this.setEncryptionBlock(null);
		this.encryptionStateChangeCallback?.();
	}

	private async tryRecoverRemoteTargetTransition(): Promise<boolean> {
		try {
			const manifest =
				await this.indexManager.downloadEncryptionManifest();
			if (!manifest) {
				const canonical =
					await this.indexManager.readCanonicalIndexWithCodecIfPresent(
						null,
					);
				if (!canonical?.maintenance) {
					return false;
				}
				this.encryptionTransitionController.createRemoteTargetRecoveryPlan(
					null,
					canonical.maintenance,
				);
				await this.syncEngine.runExclusiveMaintenance(async () => {
					await this.recoverRemotePlaintextTargetTransition(
						null,
						null,
					);
				});
				return true;
			}
			const password = this.settings.encryptionPassword;
			if (
				!password ||
				!this.settings.enableEncryption ||
				this.settings.encryptionSalt !== manifest.salt ||
				this.settings.encryptionProfileId !== "hardened"
			) {
				return false;
			}
			await this.connectToRemoteEncryptionForSync(password, manifest);
			return true;
		} catch (error) {
			logger.warn("Target encryption transition recovery is blocked", {
				error,
			});
			throw error;
		}
	}

	/**
	 * Ensure local encryption settings match the remote manifest before sync.
	 */
	private async ensureEncryptionReady(
		options: EncryptionReadyOptions,
		knownManifest?: { manifest: RemoteEncryptionManifest | null },
	): Promise<boolean> {
		try {
			const manifest =
				knownManifest !== undefined
					? knownManifest.manifest
					: await this.indexManager.downloadEncryptionManifest();
			if (!manifest) {
				if (this.settings.enableEncryption) {
					if (options.allowRecovery === false) {
						this.setEncryptionBlock(
							t("notice.encryption_remote_busy"),
						);
						return false;
					}
					const plaintextCanonical =
						await this.indexManager.readCanonicalIndexWithCodecIfPresent(
							null,
						);
					if (!plaintextCanonical) {
						this.setEncryptionBlock(
							t("notice.encryption_remote_busy"),
						);
						return false;
					}
					if (plaintextCanonical.maintenance) {
						this.encryptionTransitionController.createRemoteTargetRecoveryPlan(
							null,
							plaintextCanonical.maintenance,
						);
						this.setEncryptionBlock(
							t("notice.encryption_remote_busy"),
						);
						if (!options.prompt) {
							return false;
						}
						await this.syncEngine.runExclusiveMaintenance(
							async () => {
								await this.recoverRemotePlaintextTargetTransition(
									null,
									null,
								);
							},
						);
						return true;
					}
					// A readable stable plaintext canonical proves remote disable.
					logger.info(
						"Remote encryption manifest gone; auto-disabling local encryption",
					);
					await this.clearLocalEncryptionState();
					new Notice(t("notice.encryption_disabled_remotely"), 10000);
					this.encryptionStateChangeCallback?.();
				}
				return true;
			}

			if (manifest.state !== "enabled") {
				this.setEncryptionBlock(t("notice.encryption_remote_busy"));
				if (!options.prompt || options.allowRecovery === false) {
					return false;
				}
				const recoveryKind =
					this.encryptionTransitionController.getRemoteTargetRecoveryKind(
						manifest,
					);
				return await this.promptForRemoteEncryptionPassword(
					manifest,
					recoveryKind === "rotate" ? "rotated" : "recover",
				);
			}

			const hasLocalEncryption = Boolean(
				this.settings.enableEncryption &&
				this.settings.encryptionSalt &&
				this.settings.encryptionPassword &&
				this.encryptionService,
			);
			const localRevision = this.settings.encryptionRevision ?? 1;
			const matchesRemote =
				hasLocalEncryption &&
				this.settings.encryptionSalt === manifest.salt &&
				this.settings.encryptionProfileId ===
					this.encryptionManager.getManifestProfileId(manifest) &&
				localRevision === manifest.revision;

			if (!matchesRemote) {
				const reason = hasLocalEncryption
					? t("notice.encryption_password_changed_remote")
					: t("notice.encryption_password_required");
				this.setEncryptionBlock(reason);
				if (!options.prompt || options.allowRecovery === false) {
					return false;
				}
				return await this.promptForRemoteEncryptionPassword(
					manifest,
					hasLocalEncryption ? "rotated" : "connect",
				);
			}

			if (this.encryptionService) {
				try {
					if (
						!(await this.encryptionService.verifyVerifier(
							manifest.verifier,
						))
					) {
						throw new Error(t("notice.encryption_wrong_password"));
					}
				} catch {
					this.setEncryptionBlock(
						t("notice.encryption_password_changed_remote"),
					);
					if (!options.prompt || options.allowRecovery === false) {
						return false;
					}
					return await this.promptForRemoteEncryptionPassword(
						manifest,
						"rotated",
					);
				}
			}

			this.setEncryptionBlock(null);
			return true;
		} catch (e) {
			if (e instanceof UnsupportedHistoricalDataError) {
				this.setEncryptionBlock(null, false);
				this.setHistoricalBlock(
					t("notice.unsupported_historical_data"),
				);
				return false;
			}
			const message = formatOperationFailure(
				createSyncFailure(e, {
					stage: "encryption-validation",
					action: "read",
				}).summary,
			);
			logger.warn("Error checking remote encryption state:", {
				error: e,
			});
			this.setEncryptionBlock(
				t("notice.encryption_state_check_failed", { error: message }),
			);
			return false;
		}
	}

	private async promptForRemoteEncryptionPassword(
		manifest: RemoteEncryptionManifest,
		mode: "connect" | "rotated" | "recover",
	): Promise<boolean> {
		if (this.encryptionPromptPromise) {
			return await this.encryptionPromptPromise;
		}

		this.encryptionPromptPromise =
			this.promptForRemoteEncryptionPasswordOnce(manifest, mode).finally(
				() => {
					this.encryptionPromptPromise = null;
				},
			);

		return await this.encryptionPromptPromise;
	}

	private async promptForRemoteEncryptionPasswordOnce(
		manifest: RemoteEncryptionManifest,
		mode: "connect" | "rotated" | "recover",
	): Promise<boolean> {
		const title =
			mode === "connect"
				? t("modal.encryption_connect_title")
				: mode === "rotated"
					? t("modal.encryption_rotated_title")
					: t("modal.encryption_recovery_title");
		const body =
			mode === "connect"
				? t("modal.encryption_connect_desc")
				: mode === "rotated"
					? t("modal.encryption_rotated_desc")
					: t("modal.encryption_recovery_desc");

		const password = await new Promise<string | null>((resolve) => {
			new ConnectEncryptedVaultModal(
				this.app,
				resolve,
				title,
				body,
				t("modal.encryption_connect_button"),
			).open();
		});
		if (!password) {
			logger.warn("User cancelled encryption password prompt");
			return false;
		}

		try {
			await this.connectToRemoteEncryptionForSync(password, manifest);
			new Notice(t("notice.encryption_connected"));
			this.encryptionStateChangeCallback?.();
			return true;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.setEncryptionBlock(message);
			return false;
		}
	}

	private async verifyRemoteEncryptionPassword(
		service: EncryptionCodec,
		manifest: RemoteEncryptionManifest,
	): Promise<void> {
		try {
			if (await service.verifyVerifier(manifest.verifier)) {
				return;
			}
		} catch {
			throw new Error(t("notice.encryption_wrong_password"));
		}
		throw new Error(t("notice.encryption_wrong_password"));
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
			const salt = EncryptionService.base64ToBytes(
				this.settings.encryptionSalt,
			);
			const candidate = createEncryptionCodec(
				this.requireEncryptionProfileId(),
				salt,
			);
			await candidate.initializeKey(password);
			const verifier = await this.encryptionService.createVerifier();
			return await candidate.verifyVerifier(verifier);
		} catch {
			return false;
		}
	}

	private requireEncryptionProfileId(): EncryptionProfileId {
		const profileId = this.settings.encryptionProfileId;
		if (!profileId) {
			throw new UnsupportedHistoricalDataError(
				"Encrypted settings have no current profile ID",
			);
		}
		return profileId;
	}

	private async createEncryptionManifest(
		service: EncryptionCodec,
		salt: string,
		state: EncryptionManifest["state"],
		revision: number,
		transition?: LocalEncryptionTransition,
	): Promise<EncryptionManifest> {
		return await this.encryptionManager.createManifest({
			service,
			salt,
			state,
			revision,
			deviceId: this.settings.deviceId,
			transition,
			maintenance: this.indexManager.getMaintenance(),
		});
	}

	/** Build a reusable publisher for one transition manifest state. */
	private createEncryptionManifestPublisher(
		service: EncryptionCodec,
		salt: string,
		state: EncryptionManifest["state"],
		revision: number,
		transition: LocalEncryptionTransition,
	): () => Promise<void> {
		return async () =>
			await this.indexManager.uploadEncryptionManifest(
				await this.createEncryptionManifest(
					service,
					salt,
					state,
					revision,
					transition,
				),
			);
	}

	private captureEncryptionSnapshot(): LocalEncryptionSnapshot {
		return this.encryptionManager.captureSnapshot(this.settings);
	}

	private async applyEncryptionSnapshot(
		snapshot: LocalEncryptionSnapshot,
	): Promise<EncryptionCodec | null> {
		const service = await this.encryptionManager.applySnapshot(
			this.settings,
			snapshot,
		);
		this.encryptionService = service;
		this.yandexClient.setEncryptionService(service);
		await this.saveSettings();
		return service;
	}

	private async beginEncryptionTransition(
		kind: LocalEncryptionTransition["kind"],
		source: LocalEncryptionSnapshot,
		target: LocalEncryptionSnapshot,
		sourceRawPaths: string[],
		sourceFingerprints: Record<string, string>,
		backupProof: EncryptionBackupProof | null,
	): Promise<LocalEncryptionTransition> {
		const transition: LocalEncryptionTransition = {
			id: `${this.settings.deviceId}:${kind}:${Date.now().toString(36)}`,
			kind,
			phase: "prepared",
			source,
			target,
			sourceRawPaths,
			targetRawByLogicalPath: {},
			sourceFingerprints,
			targetFingerprints: {},
			sourceCanonicalRevision:
				this.indexManager.getRemoteIndex().revision,
			backupProof,
		};
		this.encryptionTransition = transition;
		this.setEncryptionBlock(t("notice.encryption_remote_busy"), false);
		await this.saveSettings();
		logger.info("Encryption transition prepared locally", {
			...this.getEncryptionTransitionLogContext(transition),
			sourceFiles: transition.sourceRawPaths.length,
		});
		return transition;
	}

	/**
	 * Build a secret-free correlation context for encryption transition logs.
	 */
	private getEncryptionTransitionLogContext(
		transition: LocalEncryptionTransition,
		phase: EncryptionTransitionPhase = transition.phase,
	): Record<string, unknown> {
		return {
			transitionId: shortenDiagnosticValue(transition.id),
			transitionKind: transition.kind,
			transitionPhase: phase,
			sourceCanonicalRevision: transition.sourceCanonicalRevision,
			sourceEncrypted: transition.source.enabled,
			targetEncrypted: transition.target.enabled,
			sourceEncryptionRevision: transition.source.revision,
			targetEncryptionRevision: transition.target.revision,
			sourceRawPaths: transition.sourceRawPaths.length,
			targetRawPaths: Object.keys(transition.targetRawByLogicalPath)
				.length,
		};
	}

	private async createEncryptionModeDescriptor(
		snapshot: LocalEncryptionSnapshot,
	): Promise<EncryptionModeDescriptor> {
		return await this.encryptionManager.createModeDescriptor(snapshot);
	}

	private confirmOperationBackup(): Promise<OperationBackupChoice> {
		return new Promise((resolve) =>
			new OperationBackupModal(this.app, resolve).open(),
		);
	}

	/** Bind the archive choice to the current canonical source. */
	private async createSelectedEncryptionBackup(
		choice: OperationBackupChoice | undefined,
		password: string,
	): Promise<EncryptionBackupProof | null> {
		return await this.backupManager.createTransitionBackup(
			choice,
			password,
			this.indexManager.getRemoteIndex(),
		);
	}

	private async getLogicalVaultSnapshotDigest(): Promise<string> {
		return (await captureLogicalVaultSnapshot(this.vaultAdapter)).digest;
	}

	private async runEncryptionPreflight(): Promise<void> {
		// Parse the manifest immediately before the source sync. Only coordinator
		// nesting is bypassed; encryption and canonical-maintenance guards remain
		// authoritative until this orchestrator acquires its own claim.
		await this.indexManager.downloadEncryptionManifest();
		const result = await this.syncEngine.fullSync({
			skipMaintenanceGuard: true,
			requireStableCanonical: true,
			validateThroughExternalEncryptionBlock: Boolean(
				this.encryptionTransition,
			),
		});
		if (!result.success) {
			throw new Error(
				t("notice.encryption_sync_failed", {
					errors: result.errors.length,
				}),
			);
		}
	}

	/** Claim the selected source revision without silently refreshing its archive. */
	private async claimEncryptionMaintenance(
		transition: LocalEncryptionTransition,
	): Promise<void> {
		const canonical = await this.indexManager.readCanonicalIndex();
		if (
			canonical.revision !== transition.sourceCanonicalRevision ||
			canonical.epoch !== this.indexManager.getRemoteIndex().epoch ||
			canonical.maintenance
		) {
			throw new RemoteIndexConcurrentModificationError(
				"Encryption source changed before claim",
			);
		}
		await this.assertTransitionSourceUnchanged(transition);
		const proof = transition.backupProof;
		if (proof !== null) {
			if (
				proof.epoch !== canonical.epoch ||
				proof.canonicalRevision !== canonical.revision ||
				proof.localSnapshotDigest !==
					(await this.getLogicalVaultSnapshotDigest())
			) {
				throw new Error(
					"Encryption backup snapshot changed; start a new operation",
				);
			}
			const backup = await this.yandexClient.downloadStableRawFile(
				proof.path,
			);
			if (!backup || (await computeSha256(backup.raw)) !== proof.sha256) {
				throw new Error(
					"Selected encryption backup is missing or changed",
				);
			}
		}
		await this.commitCanonicalMaintenance(transition, "prepared");
	}

	private async stageCanonicalMaintenance(
		transition: LocalEncryptionTransition,
		phase: EncryptionTransitionPhase,
		cleanup: IndexMaintenance["cleanup"] = [],
	): Promise<void> {
		const existing = this.indexManager.getMaintenance();
		const maintenance: IndexMaintenance = {
			id: transition.id,
			kind: transition.kind,
			phase,
			initiatedBy: this.settings.deviceId,
			sourceRevision: transition.sourceCanonicalRevision,
			targetRevision:
				phase === "index-committed" ||
				phase === "cleanup" ||
				phase === "stable"
					? (existing?.targetRevision ??
						this.indexManager.getRemoteIndex().revision + 1)
					: null,
			source:
				existing?.source ??
				(await this.createEncryptionModeDescriptor(transition.source)),
			target:
				existing?.target ??
				(await this.createEncryptionModeDescriptor(transition.target)),
			cleanup,
		};
		this.indexManager.setMaintenance(maintenance);
		logger.debug("Encryption maintenance staged in memory", {
			...this.getEncryptionTransitionLogContext(transition, phase),
			targetCanonicalRevision: maintenance.targetRevision,
			cleanupActions: cleanup.length,
		});
	}

	private async commitCanonicalMaintenance(
		transition: LocalEncryptionTransition,
		phase: EncryptionTransitionPhase,
		cleanup: IndexMaintenance["cleanup"] = [],
	): Promise<void> {
		await this.stageCanonicalMaintenance(transition, phase, cleanup);
		logger.info("Committing encryption maintenance phase", {
			...this.getEncryptionTransitionLogContext(transition, phase),
			cleanupActions: cleanup.length,
		});
		await this.indexManager.saveRemoteIndex();
		await this.setEncryptionTransitionPhase(phase);
		logger.info("Encryption maintenance phase committed", {
			...this.getEncryptionTransitionLogContext(transition, phase),
			canonicalRevision: this.indexManager.getRemoteIndex().revision,
			cleanupActions: cleanup.length,
		});
	}

	private async finishCanonicalMaintenance(
		transition: LocalEncryptionTransition,
	): Promise<void> {
		logger.info("Finishing canonical encryption maintenance", {
			...this.getEncryptionTransitionLogContext(transition),
		});
		this.indexManager.clearMaintenance(transition.id);
		await this.indexManager.saveRemoteIndex();
		logger.info("Canonical encryption maintenance finished", {
			...this.getEncryptionTransitionLogContext(transition, "stable"),
			canonicalRevision: this.indexManager.getRemoteIndex().revision,
		});
	}

	private async finishCanonicalMaintenanceIfCleanupComplete(
		transition: LocalEncryptionTransition,
	): Promise<boolean> {
		const cleanupPending = this.hasPendingGuardedCleanup();
		if (!cleanupPending) {
			await this.finishCanonicalMaintenance(transition);
			return true;
		}
		return false;
	}

	private hasPendingGuardedCleanup(): boolean {
		const currentEpoch = this.indexManager.getRemoteIndex().epoch;
		return hasPendingEncryptionCleanup(
			this.indexManager.getPendingPhysicalActions(),
			currentEpoch,
		);
	}

	private async setEncryptionTransitionPhase(
		phase: EncryptionTransitionPhase,
	): Promise<void> {
		if (!this.encryptionTransition) {
			return;
		}
		const previousPhase = this.encryptionTransition.phase;
		this.encryptionTransition.phase = phase;
		await this.saveSettings();
		logger.info("Local encryption transition phase saved", {
			...this.getEncryptionTransitionLogContext(
				this.encryptionTransition,
				phase,
			),
			previousPhase,
		});
	}

	private async resolveTransitionTargetPaths(
		transition: LocalEncryptionTransition,
	): Promise<void> {
		const logicalPaths = Object.entries(
			this.indexManager.getRemoteIndex().files,
		)
			.filter(([, metadata]) => !metadata.deleted)
			.map(([logicalPath]) => logicalPath)
			.sort();
		const targetEntries: Array<readonly [string, string]> = [];
		for (const logicalPath of logicalPaths) {
			const rawPath = toLocalPath(
				await this.yandexClient.getPhysicalPath(
					joinPath(this.settings.remotePath, logicalPath),
				),
				this.settings.remotePath,
			);
			targetEntries.push([logicalPath, rawPath]);
		}
		transition.targetRawByLogicalPath = createTargetRawMapping(
			targetEntries,
			transition.sourceRawPaths,
		);
		await this.saveSettings();
	}

	/** Read back one target object and persist its exact deletion proof. */
	private async verifyTransitionTargetObject(
		transition: LocalEncryptionTransition,
		logicalPath: string,
		expectedSha256: string,
		targetService: EncryptionCodec | null,
		allowMissing: boolean,
	): Promise<PhysicalRewriteUploadProof | null> {
		const rawPath = transition.targetRawByLogicalPath[logicalPath];
		if (!rawPath) {
			throw new Error(
				`Transition target mapping is missing for ${logicalPath}`,
			);
		}
		if (transition.target.enabled !== Boolean(targetService)) {
			throw new Error("Transition target codec does not match its mode");
		}
		const snapshot = await this.yandexClient.downloadStableRawFile(
			joinPath(this.settings.remotePath, rawPath),
		);
		if (!snapshot) {
			if (allowMissing) {
				if (
					Object.prototype.hasOwnProperty.call(
						transition.targetFingerprints,
						rawPath,
					)
				) {
					delete transition.targetFingerprints[rawPath];
					await this.saveSettings();
				}
				return null;
			}
			throw new Error(`Transition target disappeared for ${logicalPath}`);
		}
		const decodedPath = await this.yandexClient.decodePhysicalUserPath(
			rawPath,
			targetService,
		);
		if (decodedPath !== logicalPath) {
			throw new Error(
				`Transition target decodes to a different logical path`,
			);
		}
		const plaintext = targetService
			? await targetService.decrypt(snapshot.raw)
			: snapshot.raw;
		if ((await computeSha256(plaintext)) !== expectedSha256) {
			throw new Error(
				`Transition target content does not match ${logicalPath}`,
			);
		}
		Object.defineProperty(transition.targetFingerprints, rawPath, {
			value: snapshot.fingerprint,
			writable: true,
			enumerable: true,
			configurable: true,
		});
		await this.saveSettings();
		const remoteMtime = new Date(snapshot.resource.modified).getTime();
		return {
			remoteFingerprint: snapshot.fingerprint,
			remoteMtime: Number.isFinite(remoteMtime) ? remoteMtime : undefined,
		};
	}

	private async assertTransitionSourceUnchanged(
		transition: LocalEncryptionTransition,
	): Promise<void> {
		const snapshots = await this.indexManager.getRemoteRawFileSnapshots();
		const current = new Map(
			snapshots.map((snapshot) => [snapshot.path, snapshot.fingerprint]),
		);
		for (const sourcePath of transition.sourceRawPaths) {
			if (
				current.get(sourcePath) !==
				transition.sourceFingerprints[sourcePath]
			) {
				throw new Error(
					`Source changed during encryption transition: ${sourcePath}`,
				);
			}
		}
		const allowed = new Set([
			...transition.sourceRawPaths,
			...Object.values(transition.targetRawByLogicalPath),
		]);
		const unexpected = snapshots.find(
			(snapshot) => !allowed.has(snapshot.path),
		);
		if (unexpected) {
			throw new Error(
				`Unexpected remote file appeared during encryption transition: ${unexpected.path}`,
			);
		}
	}

	private async publishStableEncryptionSnapshot(
		snapshot: LocalEncryptionSnapshot,
	): Promise<void> {
		if (!snapshot.enabled || !snapshot.salt) {
			await this.indexManager.deleteEncryptionManifest();
			return;
		}
		const service = await this.applyEncryptionSnapshot(snapshot);
		if (!service) {
			throw new Error("Could not initialize the stable encryption key");
		}
		await this.indexManager.uploadEncryptionManifest(
			await this.createEncryptionManifest(
				service,
				snapshot.salt,
				"enabled",
				snapshot.revision ?? 1,
			),
		);
	}

	private async canReadCanonicalWith(
		snapshot: LocalEncryptionSnapshot,
	): Promise<boolean> {
		try {
			await this.applyEncryptionSnapshot(snapshot);
			await this.indexManager.loadRemoteIndex();
			return true;
		} catch {
			return false;
		}
	}

	private async recoverEncryptionTransition(): Promise<void> {
		const transition = this.encryptionTransition;
		if (!transition) {
			return;
		}
		// Recovery may upload a stable manifest or resume cleanup, so reject
		// unsupported remote metadata before deciding either direction.
		const manifest = await this.indexManager.downloadEncryptionManifest();
		const committedPhase =
			transition.phase === "index-committed" ||
			transition.phase === "stable" ||
			transition.phase === "cleanup";
		const targetReadable = committedPhase
			? false
			: await this.canReadCanonicalWith(transition.target);
		const sourceReadable =
			!committedPhase &&
			!targetReadable &&
			(await this.canReadCanonicalWith(transition.source));
		const decision = decideEncryptionRecovery(
			transition.phase,
			targetReadable,
			sourceReadable,
		);
		logger.warn("Recovering interrupted encryption transition", {
			...this.getEncryptionTransitionLogContext(transition),
			targetReadable,
			sourceReadable,
			recoveryDecision: decision,
		});
		if (decision === "blocked") {
			throw new Error(
				"Encryption transition recovery could not read the canonical index with either key",
			);
		}

		if (decision === "finish-target") {
			await this.applyEncryptionSnapshot(transition.target);
			await this.indexManager.loadRemoteIndex();
			const maintenance = this.indexManager.getMaintenance();
			await this.encryptionTransitionController.assertLocalRecoveryCoherence(
				{
					transition,
					manifest,
					maintenance,
					deviceId: this.settings.deviceId,
					authority: "target",
					authoritativeService: this.encryptionService,
				},
			);
			if (!maintenance) {
				if (this.hasPendingGuardedCleanup()) {
					throw new Error(
						"Stable encryption recovery still has pending cleanup",
					);
				}
				this.encryptionTransition = null;
				await this.saveSettings();
				this.setEncryptionBlock(null);
				return;
			}
			await this.encryptionTransitionController.completeTarget(
				transition,
			);
			return;
		} else {
			await this.applyEncryptionSnapshot(transition.source);
			await this.indexManager.loadRemoteIndex();
			const maintenance = this.indexManager.getMaintenance();
			await this.encryptionTransitionController.assertLocalRecoveryCoherence(
				{
					transition,
					manifest,
					maintenance,
					deviceId: this.settings.deviceId,
					authority: "source",
					authoritativeService: this.encryptionService,
				},
			);
			let targetService: EncryptionCodec | null = null;
			if (transition.target.enabled) {
				if (
					!transition.target.profileId ||
					!transition.target.salt ||
					!transition.target.password
				) {
					throw new Error(
						"Encrypted transition target is incomplete",
					);
				}
				targetService = await this.encryptionManager.createCodec(
					transition.target.profileId,
					transition.target.salt,
					transition.target.password,
				);
			}
			for (const logicalPath of Object.keys(
				transition.targetRawByLogicalPath,
			)) {
				const metadata =
					this.indexManager.getRemoteIndex().files[logicalPath];
				if (!metadata || metadata.deleted) {
					throw new Error(
						`Transition target has no authoritative logical metadata for ${logicalPath}`,
					);
				}
				await this.verifyTransitionTargetObject(
					transition,
					logicalPath,
					metadata.sha256,
					targetService,
					true,
				);
			}
			const rollbackPaths = Object.values(
				transition.targetRawByLogicalPath,
			).filter(
				(path) =>
					typeof transition.targetFingerprints[path] === "string" &&
					transition.targetFingerprints[path].length > 0,
			);
			if (rollbackPaths.length > 0) {
				if (!maintenance) {
					throw new Error(
						"Rollback cleanup has no canonical authority",
					);
				}
				await this.commitCanonicalMaintenance(
					transition,
					maintenance.phase,
					rollbackPaths.map((path) => ({
						path,
						expectedFingerprint:
							transition.targetFingerprints[path]!,
					})),
				);
			}
			await this.prepareGuardedCleanup(
				rollbackPaths,
				transition.targetFingerprints,
			);
			if (maintenance) {
				await this.publishStableEncryptionSnapshot(transition.source);
			}
			await this.deleteRemoteRawPaths(
				rollbackPaths,
				transition.targetFingerprints,
			);
			await this.deleteRemoteRawFolders(rollbackPaths);
			if (maintenance) {
				if (
					!(await this.finishCanonicalMaintenanceIfCleanupComplete(
						transition,
					))
				) {
					throw new Error(
						"Encryption rollback cleanup is incomplete",
					);
				}
			} else if (this.hasPendingGuardedCleanup()) {
				throw new Error("Encryption rollback cleanup is incomplete");
			}
		}
		this.encryptionTransition = null;
		await this.saveSettings();
		this.setEncryptionBlock(null);
	}

	private setEncryptionBlock(reason: string | null, showNotice = true): void {
		const changed = this.encryptionBlockReason !== reason;
		this.encryptionBlockReason = reason;
		this.syncEngine?.setExternalBlock("encryption", reason);
		if (reason) {
			this.stopRegularSync();
			if (
				showNotice &&
				(changed || this.blockingNotice?.code !== "encryption-state")
			) {
				this.showBlockingNotice("encryption-state", reason);
			}
		} else {
			this.clearBlockingNotice("encryption-state");
		}
	}

	private setMigrationBlock(reason: string | null): void {
		this.migrationBlockReason = reason;
		this.syncEngine?.setExternalBlock("migration", reason);
		if (reason) {
			this.stopRegularSync();
			this.showBlockingNotice("migration-required", reason);
		} else {
			this.clearBlockingNotice("migration-required");
		}
	}

	private setHistoricalBlock(reason: string | null): void {
		this.historicalBlockReason = reason;
		this.syncEngine?.setExternalBlock("historical", reason);
		if (reason) {
			this.stopRegularSync();
			this.showBlockingNotice("unsupported-historical", reason);
		} else {
			this.clearBlockingNotice("unsupported-historical");
		}
	}

	private setAuthenticationBlock(
		reason: string | null,
		failure?: FailureSummary,
	): void {
		this.authenticationBlockReason = reason;
		this.syncEngine?.setExternalBlock("authentication", reason, failure);
		if (reason) {
			this.stopRegularSync();
			this.showBlockingNotice("authentication", reason);
		} else {
			this.clearBlockingNotice("authentication");
		}
	}

	private stopRegularSync(): void {
		this.fileWatcher?.stop();
		this.syncScheduler?.stop();
		this.regularSyncStarted = false;
	}

	/** Token or remote-path changes invalidate every cached startup decision. */
	private invalidateRemoteStateClassification(): void {
		this.remoteStateValidated = false;
		this.setMigrationBlock(null);
		this.setHistoricalBlock(null);
		this.setEncryptionBlock(null, false);
		this.setAuthenticationBlock(t("notice.remote_recheck_required"));
	}

	private async deleteRemoteRawPaths(
		paths: string[],
		expectedFingerprints: Record<string, string> = {},
	): Promise<void> {
		await this.encryptionTransitionController.cleanupRawPaths(
			paths,
			expectedFingerprints,
		);
	}

	private async prepareGuardedCleanup(
		paths: string[],
		fingerprints: Record<string, string>,
	): Promise<void> {
		logger.info("Persisting guarded encryption cleanup actions", {
			...(this.encryptionTransition
				? this.getEncryptionTransitionLogContext(
						this.encryptionTransition,
					)
				: {}),
			cleanupActions: paths.length,
		});
		for (const path of paths) {
			const expectedFingerprint = fingerprints[path];
			if (
				typeof expectedFingerprint !== "string" ||
				!expectedFingerprint
			) {
				throw new Error(`Missing cleanup fingerprint for ${path}`);
			}
			this.indexManager.enqueuePhysicalAction("guarded-cleanup", path, {
				expectedFingerprint,
				origin: "encryption-cleanup",
			});
		}
		await this.saveSettings();
	}

	private completeGuardedCleanup(path: string): void {
		const action = this.indexManager.getPendingPhysicalAction(
			"guarded-cleanup",
			path,
		);
		if (action?.epoch === this.indexManager.getRemoteIndex().epoch) {
			this.indexManager.completePhysicalAction(action.id);
		}
	}

	private async requireCanonicalMaintenanceCleanupComplete(): Promise<void> {
		if (await this.resumeCanonicalMaintenanceCleanup()) {
			return;
		}
		this.setEncryptionBlock(t("notice.encryption_remote_busy"));
		throw new Error("Encryption cleanup is incomplete");
	}

	private async resumeCanonicalMaintenanceCleanup(): Promise<boolean> {
		return await this.encryptionTransitionController.resumeCanonicalCleanup();
	}

	private async deleteRemoteRawFolders(
		rawFilePaths: string[],
	): Promise<void> {
		await this.encryptionTransitionController.cleanupRawFolders(
			rawFilePaths,
		);
	}

	/**
	 * Create backup of synchronized files
	 */
	async createBackup(): Promise<{
		success: boolean;
		backupName?: string;
		error?: string;
	}> {
		return await this.withForegroundOperation("backup", async () => {
			if (this.isForceSyncBusy()) {
				return { success: false, error: t("notice.force_busy") };
			}
			if (!this.settings.yandexTokenSecret) {
				return { success: false, error: t("notice.token_missing") };
			}

			try {
				if (!(await this.ensureEncryptionReady({ prompt: true }))) {
					return {
						success: false,
						error:
							this.encryptionBlockReason ??
							t("notice.unsupported_historical_data"),
					};
				}
				if (this.unloaded) {
					throw new Error("Plugin was unloaded");
				}
				new Notice(t("notice.backup_started"));
				const result = await this.syncEngine.runExclusiveMaintenance(
					() => this.backupManager.createBackup(),
				);

				if (result.success && result.backupName) {
					new Notice(
						t("notice.backup_completed", {
							name: result.backupName,
						}),
					);
					return { success: true, backupName: result.backupName };
				} else {
					return {
						success: false,
						error: result.failure
							? formatOperationFailure(result.failure)
							: result.error,
						failure: result.failure,
					};
				}
			} catch (error) {
				const failure = createSyncFailure(error, {
					stage: "backup",
					action: "unknown",
				});
				logger.error("Backup creation failed:", { error: failure });
				return {
					success: false,
					error: formatOperationFailure(failure.summary),
					failure: failure.summary,
				};
			}
		}).catch((error: unknown) => ({
			success: false,
			error: formatOperationFailure(
				createSyncFailure(error, { stage: "backup", action: "unknown" })
					.summary,
			),
		}));
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
	private buildPluginData(): PluginData {
		const data: PluginData = {
			format: PLUGIN_DATA_FORMAT,
			settings: this.settings,
			localState:
				this.indexManager?.getLocalIndexData() ??
				this.loadedPluginData?.localState ??
				null,
			pendingMutations:
				this.indexManager?.getPendingMutations() ??
				this.loadedPluginData?.pendingMutations ??
				[],
			pendingPhysicalActions:
				this.indexManager?.getPendingPhysicalActions() ??
				this.loadedPluginData?.pendingPhysicalActions ??
				[],
			pendingWatcherEvents:
				this.fileWatcher?.getDeferredEvents() ??
				this.loadedPluginData?.pendingWatcherEvents ??
				[],
			encryptionTransition: this.encryptionTransition,
			lastSyncStats: this.lastSyncStats,
		};
		return data;
	}

	/** Update the UI summary from one completed synchronization result. */
	private updateLastSyncStats(result: SyncResult): void {
		this.lastSyncStats = {
			uploaded: result.uploaded,
			downloaded: result.downloaded,
			deleted: result.deleted,
			errors: result.errors.length,
		};
	}

	/** Persist one coherent snapshot of every device-local sync queue. */
	private async persistPluginData(patch?: UserSettingsPatch): Promise<void> {
		this.assertPluginDataLoaded();
		const generation = this.pluginDataLoadGeneration;
		const persistence = this.pluginDataPersistenceTail.then(async () => {
			this.assertPluginDataLoaded();
			if (generation !== this.pluginDataLoadGeneration) {
				throw new Error(
					"Plugin data save was superseded by a new load",
				);
			}
			const current = this.buildPluginData();
			if (patch) {
				current.settings = prepareSettingsPatch(
					current.settings,
					patch,
				).settings;
			}
			try {
				await this.saveData(current);
			} catch (error) {
				if (patch) {
					this.settingsPersistenceFailed = true;
				}
				throw error;
			}
			this.loadedPluginData = current;
			if (patch) {
				// Internal encryption state may advance while a logging draft is saved.
				this.settings = prepareSettingsPatch(
					this.settings,
					patch,
				).settings;
				this.publishSettingsToComponents();
			}
		});
		this.pluginDataPersistenceTail = persistence.then(
			() => undefined,
			() => undefined,
		);
		await persistence;
	}

	/** A failed read must never turn defaults or stale memory into persisted data. */
	private assertPluginDataLoaded(): void {
		if (!this.pluginDataLoaded) {
			throw new Error(
				"Plugin data was not successfully loaded; saving is blocked",
			);
		}
	}

	private assertForceIdle(): void {
		if (this.isForceSyncBusy()) {
			throw new Error(t("notice.force_busy"));
		}
	}
}
