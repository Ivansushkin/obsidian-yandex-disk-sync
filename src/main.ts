/**
 * Yandex Disk Sync Plugin for Obsidian
 * File synchronization with Yandex Disk
 */

import { Notice, Plugin } from "obsidian";
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
	RemoteIndexConcurrentModificationError,
} from "./sync/index-manager";
import {
	SyncEngine,
	type ForceBackupProof,
	type PhysicalRewriteUploadProof,
	type SyncRunOptions,
} from "./sync/sync-engine";
import {
	DeferredWatcherEvent,
	FileWatcher,
} from "./sync/file-watcher";
import { SyncScheduler } from "./sync/sync-scheduler";
import {
	formatSyncActivity,
	SyncStatusBar,
} from "./ui/status-bar";
import { SyncStatusModal } from "./ui/init-modal";
import { ForceSyncModal } from "./ui/force-sync-modal";
import { ConnectEncryptedVaultModal } from "./ui/encryption-modals";
import {
	BackupManager,
	type BackupResult,
} from "./backup/backup-manager";
import { captureLogicalVaultSnapshot } from "./backup/backup-snapshot";
import {
	generateDeviceId,
	getAncestorDirectoriesDeepestFirst,
	isProtectedPath,
	joinPath,
	toLocalPath,
} from "./utils/path-utils";
import { computeSha256 } from "./utils/hash-utils";
import { logger, shortenDiagnosticValue } from "./utils/logger";
import { initI18n, t } from "./i18n";
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
	getPhysicalResourceFingerprint,
	matchesPhysicalResourceFingerprint,
} from "./utils/resource-fingerprint";
import {
	PLUGIN_DATA_FORMAT,
	loadPluginData,
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
	private activeSyncNotice: Notice | null = null;
	private syncNoticeUnsubscribe: (() => void) | null = null;
	private syncNoticeHideTimer: number | null = null;
	private activeManualFullPromise: Promise<SyncResult | null> | null = null;
	private epochRecoveryTimer: number | null = null;
	private blockingNotice: { code: string; notice: Notice } | null = null;
	private loadedPluginData: PluginData | null = null;
	private pluginDataPersistenceTail: Promise<void> = Promise.resolve();

	private lastSyncStats = {
		uploaded: 0,
		downloaded: 0,
		deleted: 0,
		errors: 0,
	};

	private regularSyncStarted = false;
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

		// The installation ID lives outside the vault so copying or syncing the
		// plugin data cannot make two devices share one mutation sequence.
		const installationDeviceId = this.getInstallationDeviceId();
		if (this.settings.deviceId !== installationDeviceId) {
			this.settings.deviceId = installationDeviceId;
			await this.saveSettings();
		}
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
		this.disposeSyncNotice();
		if (this.epochRecoveryTimer !== null) {
			window.clearTimeout(this.epochRecoveryTimer);
			this.epochRecoveryTimer = null;
		}
		this.blockingNotice?.notice.hide();
		this.blockingNotice = null;

		// Save the sync snapshot; plugin unload itself is not asynchronous.
		void this.persistPluginData();

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
							throw new Error(`Uploaded target is missing for ${logicalPath}`);
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
					publishStable: async (snapshot) =>
						await this.publishStableEncryptionSnapshot(snapshot),
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
			);

		// Set callback for saving local index after auto-sync operations
		this.syncEngine.setIndexSaveCallback(async () => {
			await this.persistPluginData();
		});
		this.syncEngine.setSyncGuardCallback(async (validationToken) => {
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
		this.fileWatcher.loadDeferredEvents(
			this.loadedPluginData?.pendingWatcherEvents,
		);

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

		// Restore all local causal state before any recovery path can persist
		// settings again.
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

		try {
			if (this.encryptionTransition) {
				await this.syncEngine.runExclusiveMaintenance(async () => {
					await this.recoverEncryptionTransition();
				});
			} else {
				await this.tryRecoverRemoteTargetTransition();
			}
		} catch (error) {
			const historical = error instanceof UnsupportedHistoricalDataError;
			const message = historical
				? t("notice.unsupported_historical_data")
				: error instanceof Error
					? error.message
					: t("notice.encryption_remote_busy");
			this.setEncryptionBlock(message);
			this.showBlockingNotice(
				historical ? "unsupported-historical" : "encryption-state",
				message,
			);
			return;
		}

		// Sweep stale overwritten-file backups so the data folder doesn't grow
		// without bound. Non-critical: log and ignore failures so a backup
		// cleanup problem never blocks sync startup.
		try {
			await this.vaultAdapter.cleanupOldBackups();
		} catch (e) {
			logger.warn("Overwritten-file backup cleanup failed:", {
				error: e,
			});
		}

		// Subscribe to sync engine events to pause/resume file watcher
		this.syncEngine.onSyncPrepare(
			async (context) =>
				await this.fileWatcher.prepareForSync(context),
		);
		this.syncEngine.onSyncPause(
			async (context) =>
				await this.fileWatcher.pauseForSync(context),
		);
		this.syncEngine.onSyncFinalize(
			async (context, result) =>
				await this.fileWatcher.settleAfterReconciliation(
					context,
					result,
				),
		);
		this.syncEngine.onSyncResume(
			async (outcome) =>
				await this.fileWatcher.resumeAfterSync(outcome),
		);

		await this.startSync(true);
	}

	/**
	 * Run full synchronization
	 */
	async runFullSync(
		options?: SyncRunOptions,
		showProgressNotice = !options?.startup,
	): Promise<SyncResult | null> {
		if (!this.settings.yandexTokenSecret) {
			this.showBlockingNotice("token-missing", t("notice.token_missing"));
			return null;
		}
		if (showProgressNotice && this.activeManualFullPromise) {
			return await this.activeManualFullPromise;
		}
		if (
			showProgressNotice &&
			!(await this.ensureEncryptionReady({ prompt: true }))
		) {
			return null;
		}
		if (showProgressNotice) {
			this.beginSyncNotice(t("notice.sync_started"));
		}

		const run = async (): Promise<SyncResult | null> => {
			try {
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
				if (result.success) this.clearBlockingNotice();
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
							: t("notice.sync_error", {
									errors: result.errors.length,
								}),
						result.success ? 5000 : 10000,
					);
				}
				return result;
			} catch (e) {
				logger.error("Sync error:", { error: e });
				if (showProgressNotice) {
					this.finishSyncNotice(
						t("notice.sync_exception", {
							message: e instanceof Error ? e.message : String(e),
						}),
						10000,
					);
				}
				return null;
			}
		};

		const promise = run();
		if (!showProgressNotice) return await promise;
		this.activeManualFullPromise = promise.finally(() => {
			if (this.activeManualFullPromise === trackedPromise) {
				this.activeManualFullPromise = null;
			}
		});
		const trackedPromise = this.activeManualFullPromise;
		return await trackedPromise;
	}

	private queueEpochRecoveryFull(options?: SyncRunOptions): void {
		if (this.epochRecoveryTimer !== null) return;
		this.epochRecoveryTimer = window.setTimeout(() => {
			this.epochRecoveryTimer = null;
			void this.runFullSync(
				{ ...options, startup: false, epochRetry: true },
				false,
			);
		}, 0);
	}

	/** Show one live Notice backed by the same state as the status bar. */
	private beginSyncNotice(initialMessage: string): Notice {
		if (this.syncNoticeHideTimer !== null) {
			window.clearTimeout(this.syncNoticeHideTimer);
			this.syncNoticeHideTimer = null;
		}
		const reusableBlockingNotice = this.activeSyncNotice
			? null
			: (this.blockingNotice?.notice ?? null);
		if (reusableBlockingNotice) this.blockingNotice = null;
		const notice =
			this.activeSyncNotice ??
			reusableBlockingNotice ??
			new Notice(initialMessage, 0);
		notice.setMessage(initialMessage);
		this.activeSyncNotice = notice;
		if (!this.syncNoticeUnsubscribe) {
			this.syncNoticeUnsubscribe = this.syncEngine.onStateChange((state) => {
				if (state.status !== "syncing" || !this.activeSyncNotice) return;
				this.activeSyncNotice.setMessage(
					t("notice.sync_progress", {
						operation: formatSyncActivity(state),
					}),
				);
			});
		}
		return notice;
	}

	/** Turn the active progress Notice into its final state. */
	private finishSyncNotice(message: string, durationMs: number): void {
		const notice = this.activeSyncNotice;
		this.syncNoticeUnsubscribe?.();
		this.syncNoticeUnsubscribe = null;
		if (!notice) {
			new Notice(message, durationMs);
			return;
		}
		notice.setMessage(message);
		if (durationMs <= 0) return;
		this.syncNoticeHideTimer = window.setTimeout(() => {
			notice.hide();
			if (this.activeSyncNotice === notice) {
				this.activeSyncNotice = null;
			}
			this.syncNoticeHideTimer = null;
		}, durationMs);
	}

	/** Close transient synchronization UI and detach its state subscription. */
	private disposeSyncNotice(): void {
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
		if (code && this.blockingNotice?.code !== code) return;
		this.blockingNotice?.notice.hide();
		this.blockingNotice = null;
	}

	/** Present one persistent actionable block, reusing progress UI when possible. */
	private showBlockingNotice(
		code: string,
		message: string,
		reuseProgressNotice = false,
	): void {
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
		const message = error instanceof Error ? error.message : String(error);
		const actionableMessages = new Set([
			t("notice.encryption_wrong_password"),
			t("notice.encryption_password_required"),
			t("notice.encryption_password_changed_remote"),
			t("notice.encryption_remote_busy"),
		]);
		if (
			actionableMessages.has(message) ||
			this.syncEngine.getState().status === "encryption-required"
		) {
			this.showBlockingNotice("encryption-state", message, true);
			return;
		}
		this.finishSyncNotice(
			t("notice.encryption_transition_error", { message }),
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
				"unreadable-index",
				"invalid-index",
				"ambiguous-index-lock",
				"remote-maintenance",
				"encryption-blocked",
				"authentication",
			].includes(error.code ?? ""),
		);
		if (!blockingError) return false;

		this.fileWatcher.stop();
		this.syncScheduler.stop();
		this.regularSyncStarted = false;
		const noticeKey = {
			"unsupported-historical": "notice.unsupported_historical_data",
			"legacy-index": "notice.legacy_index_blocked",
			"unreadable-index": "notice.unreadable_index_blocked",
			"invalid-index": "notice.invalid_index_blocked",
			"ambiguous-index-lock": "notice.ambiguous_index_blocked",
			"remote-maintenance": "notice.encryption_remote_busy",
			"encryption-blocked": null,
			"authentication": "notice.token_invalid",
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
		direction: "from_local" | "from_remote",
	): Promise<BackupResult | null> {
		return new Promise((resolve) => {
			let completedBackup: BackupResult | null = null;
			new ForceSyncModal(
				this.app,
				direction,
				async () => {
					if (!(await this.ensureEncryptionReady({ prompt: true }))) {
						return { success: false };
					}
					const result = direction === "from_local"
						? await this.backupManager.createRemoteSnapshotBackup()
						: await this.backupManager.createBackup();
					if (result.success) completedBackup = result;
					return result;
				},
				(action) => {
					resolve(action === "proceed" ? completedBackup : null);
				},
			).open();
		});
	}

	/** Run the shared confirmed Force UI and persistence lifecycle. */
	private async runConfirmedForceSync(
		direction: "from_local" | "from_remote",
		task: (options: SyncRunOptions) => Promise<SyncResult>,
	): Promise<void> {
		let canonical: ForceBackupProof["canonical"];
		try {
			canonical = await this.indexManager.captureForceCanonicalProof();
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
				return;
			}
			new Notice(
				t("notice.force_sync_exception", {
					message:
						error instanceof Error ? error.message : String(error),
				}),
				10000,
			);
			return;
		}
		const backup = await this.confirmForceSync(direction);
		if (!backup) return;
		if (
			!backup.backupName ||
			!backup.sha256 ||
			!backup.snapshotDigest
		) {
			new Notice(t("notice.force_backup_stale"), 10000);
			return;
		}
		const forceBackupProof: ForceBackupProof = {
			direction,
			canonical,
			snapshotDigest: backup.snapshotDigest,
			backupName: backup.backupName,
			backupSha256: backup.sha256,
		};
		this.beginSyncNotice(
			t(
				direction === "from_local"
					? "notice.force_sync_from_local_started"
					: "notice.force_sync_from_remote_started",
			),
		);
		try {
			const result = await task({ forceBackupProof });
			this.updateLastSyncStats(result);
			await this.persistPluginData();
			if (!result.success) {
				if (
					result.errors.some(
						(error) => error.code === "force-backup-stale",
					)
				) {
					this.finishSyncNotice(t("notice.force_backup_stale"), 10000);
					return;
				}
				this.finishSyncNotice(
					t("notice.sync_error", { errors: result.errors.length }),
					10000,
				);
				return;
			}
			await this.startSync();
			this.clearBlockingNotice();
			this.finishSyncNotice(
				t("notice.force_sync_completed", {
					successful:
						result.uploaded + result.downloaded + result.deleted,
				}),
				5000,
			);
		} catch (error) {
			logger.error("Force sync error:", { error });
			this.finishSyncNotice(
				t("notice.force_sync_exception", {
					message:
						error instanceof Error ? error.message : String(error),
				}),
				10000,
			);
		}
	}

	/**
	 * Run force synchronization from local to remote
	 */
	async runForceSyncFromLocal(): Promise<void> {
		if (!this.settings.yandexTokenSecret) {
			this.showBlockingNotice("token-missing", t("notice.token_missing"));
			return;
		}
		if (!(await this.ensureEncryptionReady({ prompt: true }))) {
			return;
		}

		await this.runConfirmedForceSync(
			"from_local",
			async (options) =>
				await this.syncEngine.forceSyncFromLocal(options),
		);
	}

	/**
	 * Run force synchronization from remote to local
	 */
	async runForceSyncFromRemote(): Promise<void> {
		if (!this.settings.yandexTokenSecret) {
			this.showBlockingNotice("token-missing", t("notice.token_missing"));
			return;
		}
		if (!(await this.ensureEncryptionReady({ prompt: true }))) {
			return;
		}

		await this.runConfirmedForceSync(
			"from_remote",
			async (options) =>
				await this.syncEngine.forceSyncFromRemote(options),
		);
	}

	/**
	 * Start regular synchronization
	 */
	private async startSync(startup = false): Promise<void> {
		if (this.regularSyncStarted) {
			logger.debug("[Main] Regular synchronization already started");
			return;
		}
		if (!(await this.ensureEncryptionReady({ prompt: true }))) {
			return;
		}
		this.regularSyncStarted = true;
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
		if (startup) {
			const result = await this.runFullSync({ startup: true });
			const maintenance = this.indexManager.getMaintenance();
			const hasGuardedCleanup = this.indexManager
				.getPendingPhysicalActions()
				.some((action) => action.type === "guarded-cleanup");
			if (
				result?.success &&
				(maintenance?.phase === "cleanup" || hasGuardedCleanup)
			) {
				await this.syncEngine.runExclusiveMaintenance(async () => {
					await this.requireCanonicalMaintenanceCleanupComplete();
				});
			}
			return;
		}
		await this.runFullSync(undefined, false);
	}

	/**
	 * Load settings
	 */
	async loadSettings(): Promise<void> {
		const data = loadPluginData(
			(await this.loadData()) as PluginData | null,
		);
		this.loadedPluginData = data;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
		if (data?.lastSyncStats) this.lastSyncStats = data.lastSyncStats;
		this.encryptionTransition = data?.encryptionTransition ?? null;

		// Automatically determine path with vault name
		const vaultName = this.app.vault.getName();
		const saved = data?.settings;

		// Apply automatic path determination if:
		// - settings were not saved before, or
		// - path is not set, or
		// - path equals the default value
		if (
			!saved ||
			!this.settings.remotePath ||
			this.settings.remotePath === DEFAULT_SETTINGS.remotePath
		) {
			this.settings.remotePath = `${DEFAULT_SETTINGS.remotePath}/${vaultName}`;
			// Save updated settings
			await this.saveSettings();
		}
	}

	/**
	 * Return a stable installation-scoped device ID stored outside the vault.
	 * Desktop vaults use their absolute adapter path as a local-only namespace;
	 * mobile adapters fall back to the vault name inside the app profile.
	 */
	private getInstallationDeviceId(): string {
		const adapter = this.app.vault.adapter as unknown as {
			getBasePath?: () => string;
		};
		const vaultScope =
			adapter.getBasePath?.() || this.app.vault.getName();
		const key = `yandex-disk-sync:device-id:${vaultScope}`;
		try {
			const existing = globalThis.localStorage?.getItem(key);
			if (existing) return existing;
			const created = generateDeviceId();
			globalThis.localStorage?.setItem(key, created);
			return created;
		} catch {
			return generateDeviceId();
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
		if (this.encryptionBlockReason) {
			this.fileWatcher?.stop();
			this.syncScheduler?.stop();
		}

		await this.persistPluginData();
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
		this.beginSyncNotice(t("notice.encryption_syncing"));
		try {
			await this.syncEngine.runExclusiveMaintenance(async () => {
				await this.enableEncryptionNow(password);
			});
			this.clearBlockingNotice();
			this.finishSyncNotice(t("notice.encryption_enabled"), 5000);
		} catch (error) {
			this.finishEncryptionError(error);
			throw error;
		}
	}

	private async enableEncryptionNow(password: string): Promise<void> {
		const remoteManifest =
			await this.indexManager.downloadEncryptionManifest();
		if (remoteManifest) {
			await this.connectToRemoteEncryptionNow(password, remoteManifest);
			return;
		}

		await this.runEncryptionPreflight();
		const backupProof =
			await this.createMandatoryEncryptionBackup(password);
		const sourceFiles =
			await this.indexManager.getRemoteRawFileSnapshots();
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
		const publishEnablingManifest =
			this.createEncryptionManifestPublisher(
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
		this.beginSyncNotice(t("notice.encryption_disabling"));
		try {
			const result = await this.syncEngine.runExclusiveMaintenance(
				async () => this.disableEncryptionNow(options),
			);
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
	}

	private async disableEncryptionNow(options?: {
		reuploadPlaintext?: boolean;
	}): Promise<{ hadErrors: boolean }> {
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
			const backupProof =
				await this.createMandatoryEncryptionBackup(backupPassword);
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
					sourceFiles.map((file) => [
						file.path,
						file.fingerprint,
					]),
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
				logger.warn("Encryption disable rolled back:", {
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
		this.beginSyncNotice(t("notice.encryption_password_rotating"));
		try {
			await this.syncEngine.runExclusiveMaintenance(async () => {
				await this.rotateEncryptionPasswordNow(newPassword);
			});
			this.finishSyncNotice(
				t("notice.encryption_password_changed"),
				5000,
			);
		} catch (error) {
			this.finishEncryptionError(error);
			throw error;
		}
	}

	private async rotateEncryptionPasswordNow(
		newPassword: string,
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
		const backupProof =
			await this.createMandatoryEncryptionBackup(newPassword);
		const source = this.captureEncryptionSnapshot();
		const sourceService = this.encryptionService;
		const sourceFiles =
			await this.indexManager.getRemoteRawFileSnapshots();
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
		const publishRotatingManifest =
			this.createEncryptionManifestPublisher(
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
		await this.syncEngine.runExclusiveMaintenance(async () => {
			await this.connectToRemoteEncryptionNow(password, manifest);
		});
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
						await this.indexManager.readCanonicalIndexWithCodec(candidate);
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
				const maintenance = await this.encryptionManager.acceptCandidate({
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
				if (maintenance.phase === "index-committed") {
					this.indexManager.setMaintenance({
						...maintenance,
						phase: "cleanup",
					});
					await this.indexManager.saveRemoteIndex();
				}
				await this.indexManager.uploadEncryptionManifest(
					await this.createEncryptionManifest(
						service,
						manifest.salt,
						"enabled",
						manifest.revision,
					),
				);
				await this.requireCanonicalMaintenanceCleanupComplete();
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
					await this.indexManager.loadRemoteIndexWithTargetCodec(null);
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
					if (current.phase === "index-committed") {
						this.indexManager.setMaintenance({
							...current,
							phase: "cleanup",
						});
						await this.indexManager.saveRemoteIndex();
					}
					if (manifest) {
						await this.indexManager.deleteEncryptionManifest();
					}
					await this.requireCanonicalMaintenanceCleanupComplete();
				} finally {
					this.indexManager.clearIndexTransitionServices();
				}
			},
		);
		this.setEncryptionBlock(null);
		this.encryptionStateChangeCallback?.();
	}

	private async tryRecoverRemoteTargetTransition(): Promise<void> {
		try {
			const manifest =
				await this.indexManager.downloadEncryptionManifest();
			if (!manifest) {
				const canonical =
					await this.indexManager.readCanonicalIndexWithCodecIfPresent(null);
				if (!canonical?.maintenance) return;
				this.encryptionTransitionController.createRemoteTargetRecoveryPlan(
					null,
					canonical.maintenance,
				);
				await this.syncEngine.runExclusiveMaintenance(async () => {
					await this.recoverRemotePlaintextTargetTransition(null, null);
				});
				return;
			}
			const password = this.settings.encryptionPassword;
			if (
				!password ||
				!this.settings.enableEncryption ||
				this.settings.encryptionSalt !== manifest.salt ||
				this.settings.encryptionProfileId !== "hardened"
			) {
				return;
			}
			await this.connectToRemoteEncryption(password, manifest);
		} catch (error) {
			logger.warn("Target encryption transition recovery is blocked", {
				error,
			});
			this.setEncryptionBlock(
				error instanceof UnsupportedHistoricalDataError
					? t("notice.unsupported_historical_data")
					: t("notice.encryption_remote_busy"),
			);
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
					const plaintextCanonical =
						await this.indexManager.readCanonicalIndexWithCodecIfPresent(null);
					if (!plaintextCanonical) {
						this.setEncryptionBlock(t("notice.encryption_remote_busy"));
						return false;
					}
					if (plaintextCanonical.maintenance) {
						this.encryptionTransitionController.createRemoteTargetRecoveryPlan(
							null,
							plaintextCanonical.maintenance,
						);
						this.setEncryptionBlock(t("notice.encryption_remote_busy"));
						if (!options.prompt) return false;
						await this.syncEngine.runExclusiveMaintenance(async () => {
							await this.recoverRemotePlaintextTargetTransition(null, null);
						});
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
				if (!options.prompt) return false;
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
				if (!options.prompt) {
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
					if (!options.prompt) {
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
				this.setEncryptionBlock(t("notice.unsupported_historical_data"));
				return false;
			}
			const message = e instanceof Error ? e.message : String(e);
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
			await this.connectToRemoteEncryption(password, manifest);
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
		backupProof: EncryptionBackupProof,
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
			sourceCanonicalRevision:
				transition.sourceCanonicalRevision,
			sourceEncrypted: transition.source.enabled,
			targetEncrypted: transition.target.enabled,
			sourceEncryptionRevision: transition.source.revision,
			targetEncryptionRevision: transition.target.revision,
			sourceRawPaths: transition.sourceRawPaths.length,
			targetRawPaths: Object.keys(
				transition.targetRawByLogicalPath,
			).length,
		};
	}

	private async createEncryptionModeDescriptor(
		snapshot: LocalEncryptionSnapshot,
	): Promise<EncryptionModeDescriptor> {
		return await this.encryptionManager.createModeDescriptor(snapshot);
	}

	/** Create and byte-verify a backup of one stable logical vault snapshot. */
	private async createMandatoryEncryptionBackup(
		password: string,
	): Promise<EncryptionBackupProof> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const before = await this.getLogicalVaultSnapshotDigest();
			const result = await this.backupManager.createBackup(password);
			if (
				!result.success ||
				!result.backupName ||
				!result.sha256 ||
				!result.snapshotDigest
			) {
				throw new Error(
					result.error ?? "Mandatory encryption backup failed",
				);
			}
			const after = await this.getLogicalVaultSnapshotDigest();
			if (
				before !== result.snapshotDigest ||
				result.snapshotDigest !== after
			) {
				logger.warn("Vault changed while creating encryption backup", {
					attempt: attempt + 1,
				});
				continue;
			}
			const canonical = this.indexManager.getRemoteIndex();
			return {
				path: joinPath(
					this.settings.remotePath,
					".backup",
					result.backupName,
				),
				sha256: result.sha256,
				epoch: canonical.epoch,
				canonicalRevision: canonical.revision,
				localSnapshotDigest: result.snapshotDigest,
				createdAt: Date.now(),
			};
		}
		throw new Error("Vault changed during mandatory encryption backup");
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

	/**
	 * Acquire distributed maintenance only against the revision reconciled by
	 * the source preflight. A concurrent commit refreshes both the local
	 * baseline and guarded source fingerprints before retrying.
	 */
	private async claimEncryptionMaintenance(
		transition: LocalEncryptionTransition,
	): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const canonical = this.indexManager.getRemoteIndex();
			transition.sourceCanonicalRevision = canonical.revision;
			const currentDigest = await this.getLogicalVaultSnapshotDigest();
			if (
				!transition.backupProof ||
				transition.backupProof.epoch !== canonical.epoch ||
				transition.backupProof.canonicalRevision !== canonical.revision ||
				transition.backupProof.localSnapshotDigest !== currentDigest
			) {
				const backupPassword = transition.target.enabled
					? transition.target.password
					: transition.source.password;
				if (!backupPassword) {
					throw new Error("Encryption backup password is unavailable");
				}
				transition.backupProof =
					await this.createMandatoryEncryptionBackup(backupPassword);
			}
			logger.info("Claiming encryption maintenance ownership", {
				...this.getEncryptionTransitionLogContext(transition),
				attempt: attempt + 1,
				maxAttempts: 3,
			});
			try {
				await this.commitCanonicalMaintenance(
					transition,
					"prepared",
				);
				logger.info("Encryption maintenance ownership acquired", {
					...this.getEncryptionTransitionLogContext(transition),
					attempt: attempt + 1,
				});
				return;
			} catch (error) {
				if (
					!(error instanceof RemoteIndexConcurrentModificationError) ||
					attempt === 2
				) {
					throw error;
				}
				logger.warn(
					"Canonical changed before maintenance claim; repeating preflight",
					{
						...this.getEncryptionTransitionLogContext(
							transition,
						),
						attempt: attempt + 1,
						error,
					},
				);
				await this.runEncryptionPreflight();
				const backupPassword = transition.target.enabled
					? transition.target.password
					: transition.source.password;
				if (!backupPassword) {
					throw new Error("Encryption backup password is unavailable");
				}
				transition.backupProof =
					await this.createMandatoryEncryptionBackup(backupPassword);
				const sourceFiles =
					await this.indexManager.getRemoteRawFileSnapshots();
				transition.sourceRawPaths = sourceFiles.map(
					(file) => file.path,
				);
				transition.sourceFingerprints = Object.fromEntries(
					sourceFiles.map((file) => [
						file.path,
						file.fingerprint,
					]),
				);
				await this.saveSettings();
			}
		}
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
					? existing?.targetRevision ??
						this.indexManager.getRemoteIndex().revision + 1
					: null,
			source:
				existing?.source ??
				(await this.createEncryptionModeDescriptor(
					transition.source,
				)),
			target:
				existing?.target ??
				(await this.createEncryptionModeDescriptor(
					transition.target,
				)),
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
			canonicalRevision:
				this.indexManager.getRemoteIndex().revision,
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
			...this.getEncryptionTransitionLogContext(
				transition,
				"stable",
			),
			canonicalRevision:
				this.indexManager.getRemoteIndex().revision,
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
		if (!this.encryptionTransition) return;
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
			throw new Error(`Transition target mapping is missing for ${logicalPath}`);
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
			throw new Error(`Transition target decodes to a different logical path`);
		}
		const plaintext = targetService
			? await targetService.decrypt(snapshot.raw)
			: snapshot.raw;
		if ((await computeSha256(plaintext)) !== expectedSha256) {
			throw new Error(`Transition target content does not match ${logicalPath}`);
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
		const snapshots =
			await this.indexManager.getRemoteRawFileSnapshots();
		const current = new Map(
			snapshots.map((snapshot) => [
				snapshot.path,
				snapshot.fingerprint,
			]),
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
		if (!transition) return;
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
			await this.encryptionTransitionController.assertLocalRecoveryCoherence({
				transition,
				manifest,
				maintenance,
				deviceId: this.settings.deviceId,
				authority: "target",
				authoritativeService: this.encryptionService,
			});
			if (!maintenance) {
				if (this.hasPendingGuardedCleanup()) {
					throw new Error("Stable encryption recovery still has pending cleanup");
				}
				this.encryptionTransition = null;
				await this.saveSettings();
				this.setEncryptionBlock(null);
				return;
			}
			await this.encryptionTransitionController.completeTarget(transition);
			return;
		} else {
			await this.applyEncryptionSnapshot(transition.source);
			await this.indexManager.loadRemoteIndex();
			const maintenance = this.indexManager.getMaintenance();
			await this.encryptionTransitionController.assertLocalRecoveryCoherence({
				transition,
				manifest,
				maintenance,
				deviceId: this.settings.deviceId,
				authority: "source",
				authoritativeService: this.encryptionService,
			});
			let targetService: EncryptionCodec | null = null;
			if (transition.target.enabled) {
				if (
					!transition.target.profileId ||
					!transition.target.salt ||
					!transition.target.password
				) {
					throw new Error("Encrypted transition target is incomplete");
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
				const metadata = this.indexManager.getRemoteIndex().files[logicalPath];
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
					throw new Error("Encryption rollback cleanup is incomplete");
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
		this.syncEngine?.setExternalBlockReason(reason);
		if (reason) {
			if (!this.syncEngine?.isSyncInProgress()) {
				this.fileWatcher?.stop();
				this.syncScheduler?.stop();
			}
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

	private async deleteRemoteRawPaths(
		paths: string[],
		expectedFingerprints?: Record<string, string>,
	): Promise<void> {
		if (paths.length === 0) {
			return;
		}

		const transitionContext = this.encryptionTransition
			? this.getEncryptionTransitionLogContext(
					this.encryptionTransition,
				)
			: {};
		logger.info(`Cleaning up ${paths.length} old remote files...`, {
			...transitionContext,
			cleanupActions: paths.length,
		});
		for (const path of paths) {
			try {
				const remotePath = joinPath(this.settings.remotePath, path);
				const expected = expectedFingerprints?.[path];
				if (expectedFingerprints) {
					if (typeof expected !== "string" || !expected) {
						logger.warn("Blocked encryption cleanup without a fingerprint", {
							...transitionContext,
							path,
						});
						continue;
					}
					const resource = await this.yandexClient.getResource(
						remotePath,
						1,
						0,
						true,
					);
					if (!resource) {
						this.completeGuardedCleanup(path);
						logger.info("Guarded encryption cleanup already complete", {
							...transitionContext,
							path,
							expectedFingerprint:
								shortenDiagnosticValue(expected),
						});
						continue;
					}
					const current = getPhysicalResourceFingerprint(resource);
					if (
						!matchesPhysicalResourceFingerprint(expected, resource)
					) {
						logger.warn("Skipped changed encryption cleanup target", {
							...transitionContext,
							path,
							expectedFingerprint:
								shortenDiagnosticValue(expected),
							currentFingerprint:
								shortenDiagnosticValue(current),
						});
						continue;
					}
				}
				await this.yandexClient.deleteResource(remotePath, false, true);
				this.completeGuardedCleanup(path);
				logger.info("Guarded encryption cleanup confirmed", {
					...transitionContext,
					path,
					expectedFingerprint:
						shortenDiagnosticValue(expected),
				});
			} catch (e) {
				logger.warn(`Failed to delete old remote file ${path}:`, {
					error: e,
				});
			}
		}
		await this.saveSettings();
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
			if (typeof expectedFingerprint !== "string" || !expectedFingerprint) {
				throw new Error(`Missing cleanup fingerprint for ${path}`);
			}
			this.indexManager.enqueuePhysicalAction(
				"guarded-cleanup",
				path,
				{
					expectedFingerprint,
					origin: "encryption-cleanup",
				},
			);
		}
		await this.saveSettings();
	}

	private completeGuardedCleanup(path: string): void {
		const action = this.indexManager.getPendingPhysicalAction(
			"guarded-cleanup",
			path,
		);
		if (action) {
			this.indexManager.completePhysicalAction(action.id);
		}
	}

	private async resumeGuardedCleanupActions(
		cleanup: IndexMaintenance["cleanup"],
	): Promise<void> {
		const expectedByPath = new Map(
			cleanup.map((action) => [action.path, action.expectedFingerprint]),
		);
		const currentEpoch = this.indexManager.getRemoteIndex().epoch;
		const actions = this.indexManager
			.getPendingPhysicalActions()
			.filter(
				(action) =>
					action.type === "guarded-cleanup" &&
					action.epoch === currentEpoch &&
					action.expectedFingerprint === expectedByPath.get(action.path),
			);
		await this.deleteRemoteRawPaths(
			actions.map((action) => action.path),
			Object.fromEntries(
				actions.flatMap((action) =>
					action.expectedFingerprint
						? [[action.path, action.expectedFingerprint]]
						: [],
				),
			),
		);
	}

	private async requireCanonicalMaintenanceCleanupComplete(): Promise<void> {
		if (await this.resumeCanonicalMaintenanceCleanup()) return;
		this.setEncryptionBlock(t("notice.encryption_remote_busy"));
		throw new Error("Encryption cleanup is incomplete");
	}

	private async resumeCanonicalMaintenanceCleanup(): Promise<boolean> {
		const maintenance = this.indexManager.getMaintenance();
		if (!maintenance || maintenance.phase !== "cleanup") return true;
		for (const cleanup of maintenance.cleanup) {
			this.indexManager.enqueuePhysicalAction(
				"guarded-cleanup",
				cleanup.path,
				{
					expectedFingerprint: cleanup.expectedFingerprint,
					origin: "encryption-cleanup",
					canonicalRevision:
						this.indexManager.getRemoteIndex().revision,
				},
			);
		}
		await this.resumeGuardedCleanupActions(maintenance.cleanup);
		await this.deleteRemoteRawFolders(
			maintenance.cleanup.map((cleanup) => cleanup.path),
		);
		const stillPending = this.hasPendingGuardedCleanup();
		if (!stillPending) {
			this.indexManager.clearMaintenance(maintenance.id);
			await this.indexManager.saveRemoteIndex();
		}
		await this.saveSettings();
		return !stillPending;
	}

	/**
	 * Delete remote folders that were parents of the given raw file paths.
	 * Used during encryption enable/rotate where the remote index already
	 * reflects the new key and cannot be used to verify emptiness. Since
	 * deleteRemoteRawPaths removed all files beforehand, the folders are
	 * guaranteed to be empty. Deletes deepest first so children are gone
	 * before parents are attempted.
	 */
	private async deleteRemoteRawFolders(
		rawFilePaths: string[],
	): Promise<void> {
		if (rawFilePaths.length === 0) return;

		const sorted = getAncestorDirectoriesDeepestFirst(rawFilePaths);
		if (sorted.length === 0) return;

		logger.info(`Cleaning up ${sorted.length} old remote folders...`);
		for (const folder of sorted) {
			if (isProtectedPath(folder)) {
				logger.debug(
					`Skipping protected folder during cleanup: ${folder}`,
				);
				continue;
			}
			try {
				const remotePath = joinPath(this.settings.remotePath, folder);
				if (!(await this.yandexClient.isRawFolderEmpty(remotePath))) {
					continue;
				}
				await this.yandexClient.deleteResource(remotePath, false, true);
				logger.debug(`Deleted old remote folder: ${folder}`);
			} catch (e) {
				logger.warn(`Failed to delete old remote folder ${folder}:`, {
					error: e,
				});
			}
		}
	}

	/**
	 * Create backup of synchronized files
	 */
	async createBackup(): Promise<{
		success: boolean;
		backupName?: string;
		error?: string;
	}> {
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
			new Notice(t("notice.backup_started"));
			const result = await this.backupManager.createBackup();

			if (result.success && result.backupName) {
				new Notice(
					t("notice.backup_completed", { name: result.backupName }),
				);
				return { success: true, backupName: result.backupName };
			} else {
				return { success: false, error: result.error };
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
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
	private async persistPluginData(): Promise<void> {
		const persistence = this.pluginDataPersistenceTail.then(async () => {
			await this.saveData(this.buildPluginData());
		});
		this.pluginDataPersistenceTail = persistence.then(
			() => undefined,
			() => undefined,
		);
		await persistence;
	}
}
