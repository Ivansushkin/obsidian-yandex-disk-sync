import type { StartupReadSession } from "./sync/canonical/manager";
import type { RetryProgress } from "./errors";
import { SYNC_BUILD_ID } from "./build-info";
import type { StartupInvocation } from "./plugin-startup";
import type { RemoteAuthorityObservation } from "./sync/canonical/manager";
import type { OperationBackupChoice } from "./backup/operation-backup-choice";
import type { EncryptionReadyOptions } from "./crypto/admission";
import type { EncryptionPromptMode } from "./crypto/context";
import { EncryptionWorkflow } from "./crypto/workflow";
import {
	applyUserSettingsPatch,
	prepareSettingsPatch,
	type UserSettingsPatch,
} from "./settings-workflow";
import { StorageBindingController } from "./sync/local/storage-binding";
import { StorageScopeError } from "./sync/local/storage-scope";
import {
	ensureForceRoot,
	prepareForceEpochConnection,
	prepareForceReplacement,
	type ForceReplacementDependencies,
} from "./sync/workflows/force-replacement";
import type { ForceRecovery } from "./sync/workflows/force-state";
import { DecisionModal } from "./ui/decision-modal";
import { OperationBackupModal } from "./ui/operation-backup-modal";
import { StorageBindingModal } from "./ui/storage-binding-modal";
/**
 * Yandex Disk Sync Plugin for Obsidian
 * File synchronization with Yandex Disk
 */

import { Notice, Platform, Plugin } from "obsidian";
import { VaultAdapter } from "./api/vault-adapter";
import { YandexDiskClient } from "./api/yandex-client";
import { BackupManager } from "./backup/backup-manager";
import {
	captureLogicalVaultDigest,
	captureRemoteRawDigest,
} from "./backup/backup-snapshot";
import { UnsupportedHistoricalDataError } from "./compatibility-errors";
import { type EncryptionCodec } from "./crypto/encryption";
import { EncryptionManager } from "./crypto/encryption-manager";
import {
	type LocalEncryptionSnapshot,
	type LocalEncryptionTransition,
} from "./crypto/encryption-transition";
import type { FailureSummary } from "./errors";
import { initI18n, t } from "./i18n/index";
import { PLUGIN_DATA_FORMAT } from "./plugin-data-loader";
import { PluginPersistence, type PluginData } from "./plugin-persistence";
import {
	PluginStartup,
	type StartupBlockKind,
	type StartupState,
} from "./plugin-startup";
import { YandexDiskSyncSettingTab } from "./settings";
import {
	LegacyIndexFormatError,
	LegacyPluginDataExposureError,
	LegacyServicePathCollisionError,
} from "./sync/canonical/errors";
import { IndexManager } from "./sync/canonical/manager";
import {
	SyncEngine,
	type ForceBackupProof,
	type SyncRunOptions,
} from "./sync/engine";
import {
	createSyncFailure,
	formatOperationFailure,
	formatSyncErrorSummary,
} from "./sync/errors";
import { FileWatcher } from "./sync/realtime/watcher";
import { SyncScheduler } from "./sync/scheduler";
import {
	ForceSyncController,
	type ForceDirection,
	type ForceFlowState,
	type ForcePreparationContext,
} from "./sync/workflows/force-controller";
import {
	DEFAULT_SETTINGS,
	RemoteEncryptionManifest,
	SyncResult,
	YandexDiskSyncSettings,
} from "./types";
import { ConnectEncryptedVaultModal } from "./ui/encryption-modals";
import { ForceSyncModal } from "./ui/force-sync-modal";
import {
	formatForceActivity,
	formatForceResult,
} from "./ui/force-sync-progress";
import { SyncStatusModal } from "./ui/init-modal";
import { SyncIndicator } from "./ui/sync-indicator";
import { formatSyncActivity } from "./ui/sync-status-presentation";
import {
	logger,
	sanitizeDiagnosticMessage,
	shortenDiagnosticValue,
} from "./utils/logger";
import { generateDeviceId } from "./utils/path-utils";

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
	private forceRecovery: ForceRecovery | null = null;
	private epochRecoveryTimer: number | null = null;
	private blockingNotice: { code: string; notice: Notice } | null = null;
	private readonly persistence = new PluginPersistence({
		read: () => this.loadData(),
		save: (data) => this.saveData(data),
		snapshot: () => this.buildPluginData(),
		publish: (patch) => {
			this.settings = prepareSettingsPatch(this.settings, patch).settings;
			this.publishSettingsToComponents();
		},
		isUnloaded: () => this.unloaded,
		failed: (failure) => {
			this.stopRegularSync();
			this.remoteStateValidated = false;
			const reason = formatOperationFailure(failure);
			this.syncEngine?.setExternalBlock("persistence", reason, failure);
			this.showBlockingNotice("local-persistence", reason);
		},
	});
	private localStateRestored = false;
	private syncLifecycleRegistered = false;
	private syncLifecycleDisposers: (() => void)[] = [];
	private configuredToken: string | null = null;
	private configuredRemotePath: string | null = null;
	private migrationBlockReason: string | null = null;
	private historicalBlockReason: string | null = null;
	private authenticationBlockReason: string | null = null;
	private forceBlockReason: string | null = null;
	private legacyExposureRemediationPending = false;
	private legacyExposedTokenInSession: string | null = null;

	private lastSyncStats = {
		uploaded: 0,
		downloaded: 0,
		deleted: 0,
		errors: 0,
	};

	private regularSyncStarted = false;
	private automationReady = false;
	private backupSweepScheduled = false;
	private readonly pluginLoadStartedAt = Date.now();
	private activeFullRuns = 0;
	private activeFullPromise: Promise<SyncResult | null> | null = null;
	private readonly encryptionManager = new EncryptionManager();
	private encryptionService: EncryptionCodec | null = null;
	private encryptionWorkflow!: EncryptionWorkflow;
	private encryptionBlockReason: string | null = null;
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
		if (this.unloaded) {
			return;
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
				buildId: SYNC_BUILD_ID,
			},
		});
		logger.info("Loading Yandex Disk Sync plugin...");

		const installationDeviceId = this.settings.deviceId;
		logger.configure({
			baseContext: {
				pluginVersion: this.manifest.version,
				buildId: SYNC_BUILD_ID,
				deviceId: shortenDiagnosticValue(installationDeviceId),
			},
		});

		// Initialize components
		this.initializeComponents();
		this.restoreLocalStateOnce();
		this.registerSyncLifecycleOnce();
		await this.initEncryption();
		if (this.unloaded) {
			return;
		}

		// Register settings tab
		this.addSettingTab(new YandexDiskSyncSettingTab(this.app, this));

		// Register commands
		this.registerCommands();

		// Create status disclosure and sidebar button
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
		this.yandexClient?.stopReads();
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
		this.disposeSyncLifecycle();
		if (this.epochRecoveryTimer !== null) {
			window.clearTimeout(this.epochRecoveryTimer);
			this.epochRecoveryTimer = null;
		}
		this.blockingNotice?.notice.hide();
		this.blockingNotice = null;

		// Unload admission is checked at execution, after earlier saves settle.
		void this.persistence.saveOnUnload().catch(() => {
			logger.warn("Plugin snapshot could not be saved on unload");
		});

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
			maxConcurrency: this.settings.maxConcurrency,
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
		if (this.persistence.current?.localState) {
			this.indexManager.loadLocalIndexFromData(
				this.persistence.current.localState,
			);
		}
		this.indexManager.loadPendingMutations(
			this.persistence.current?.pendingMutations,
		);
		this.indexManager.loadPendingPhysicalActions(
			this.persistence.current?.pendingPhysicalActions,
		);

		// Create sync engine
		this.syncEngine = new SyncEngine(
			this.yandexClient,
			this.vaultAdapter,
			this.indexManager,
			this.settings,
			() => this.unloaded || this.persistence.failed,
		);
		this.yandexClient.setRetryCallback((progress) => {
			this.syncEngine.reportRetry(progress);
			this.connectionRetry = progress;
			this.notifyManualActivity();
		});
		this.register(() => this.yandexClient.setRetryCallback());

		this.encryptionWorkflow = new EncryptionWorkflow({
			readLocalFile: (path) => this.vaultAdapter.readFile(path),
			client: this.yandexClient,
			index: this.indexManager,
			engine: this.syncEngine,
			getLocalSnapshotDigest: async () =>
				await captureLogicalVaultDigest(this.vaultAdapter),
			backup: {
				createTransitionBackup: (...args) =>
					this.backupManager.createTransitionBackup(...args),
			},
			manager: this.encryptionManager,
			getSettings: () => this.settings,
			getService: () => this.encryptionService,
			setService: (service) => {
				this.encryptionService = service;
			},
			getTransition: () => this.encryptionTransition,
			setTransition: (transition) => {
				this.encryptionTransition = transition;
			},
			persist: () => this.saveSettings(),
			isCancelled: () => this.unloaded,
			assertConnectionAllowed: () => {
				if (this.unloaded) {
					throw new Error("Plugin was unloaded");
				}
				if (this.migrationBlockReason) {
					throw new LegacyIndexFormatError();
				}
			},
			ui: {
				setBlock: (reason, showNotice) =>
					this.setEncryptionBlock(reason, showNotice),
				setHistoricalBlock: (reason) => this.setHistoricalBlock(reason),
				requestPassword: (_manifest, mode) =>
					this.requestEncryptionPassword(mode),
				connected: () => {
					new Notice(t("notice.encryption_connected"));
				},
				disabledRemotely: () => {
					new Notice(t("notice.encryption_disabled_remotely"), 10000);
				},
				stateChanged: () => this.encryptionStateChangeCallback?.(),
			},
		});

		this.storageBinding = new StorageBindingController({
			client: this.yandexClient,
			index: this.indexManager,
			getSettings: () => this.settings,
			hasPendingWork: () => this.hasDurableConfigurationWork(),
			hasTransition: () => this.encryptionTransition !== null,
			isUnloaded: () => this.unloaded,
			persist: () => this.persistPluginData(),
			verifyReplacement: async () => {
				const proof = await prepareForceEpochConnection(
					this.forceReplacementDependencies(),
				);
				const previous = this.encryptionManager.captureSnapshot(
					this.settings,
				);
				const apply = async (snapshot: LocalEncryptionSnapshot) => {
					const codec = await this.encryptionManager.applySnapshot(
						this.settings,
						snapshot,
					);
					this.encryptionService = codec;
					this.yandexClient.setEncryptionService(codec);
				};
				return {
					epoch: proof.epoch,
					apply: () => apply(proof.snapshot),
					rollback: () => apply(previous),
				};
			},
			confirm: (path, keep, replacement) =>
				new Promise((resolve) =>
					new StorageBindingModal(
						this.app,
						path,
						keep,
						resolve,
						replacement,
					).open(),
				),
		});

		// Set callback for saving local index after auto-sync operations
		this.yandexClient.setWriteGuard(() => {
			if (this.unloaded) {
				throw new Error("Plugin unloaded before remote mutation");
			}
			return this.indexManager.assertRemoteScope();
		});
		this.syncEngine.setEpochAdoptionDecisionCallback(
			() =>
				new Promise((resolve) =>
					new DecisionModal<"accept" | "preserve" | null>(
						this.app,
						t("force.epoch_title"),
						t("force.epoch_description"),
						[
							{ label: t("force.epoch_accept"), value: "accept" },
							{
								label: t("force.epoch_preserve"),
								value: "preserve",
							},
							{ label: t("force.epoch_later"), value: null },
						],
						null,
						resolve,
					).open(),
				),
		);
		this.syncEngine.setIndexSaveCallback(async () => {
			await this.persistPluginData();
		});
		this.syncEngine.setSyncGuardCallback(
			async (validationToken, observation, knownManifest) => {
				const hostBlock = () => {
					if (this.unloaded) {
						return {
							blockReason: t("notice.sync_interrupted"),
							blockCode: "sync-interrupted",
							blockStatus: "error" as const,
						};
					}
					if (this.persistence.failed) {
						const failure = this.persistence.failure;
						return {
							blockReason: failure
								? formatOperationFailure(failure)
								: t("notice.local_persistence_failed"),
							blockCode: "local-persistence",
							blockStatus: "error" as const,
							failure,
						};
					}
					return null;
				};
				const initialBlock = hostBlock();
				if (initialBlock) {
					return initialBlock;
				}
				if (this.forceRecovery) {
					return {
						blockReason: t("force.recovery_pending"),
						blockCode: "force-recovery-pending",
					};
				}
				if (!(await this.ensureStorageBinding(false, observation))) {
					return {
						blockReason: t("storage.blocked"),
						blockCode: "local-state-blocked",
						blockStatus: "error",
					};
				}
				const lateBlock = hostBlock();
				if (lateBlock) {
					return lateBlock;
				}
				if (!this.settings.yandexTokenSecret) {
					return { blockReason: null };
				}
				if (validationToken !== undefined) {
					const unchanged =
						await this.indexManager.isEncryptionManifestTokenCurrent(
							validationToken,
							observation,
						);
					return {
						blockReason: unchanged
							? null
							: t("notice.encryption_state_changed"),
						validationToken,
					};
				}
				const manifestRead =
					knownManifest ??
					(await this.indexManager.downloadEncryptionManifestForGuard());
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
			},
		);

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

	/** Mount one shared disclosure with the existing manual sync and diagnostic actions. */
	private createSyncIndicator(): void {
		const indicator = this.addChild(
			new SyncIndicator(
				this.app,
				() => ({
					sync: this.syncEngine.getState(),
					force: this.forceSyncController?.getState() ?? null,
					foreground: this.getForegroundOperation(),
					fullSyncInProgress: this.isFullSyncInProgress(),
					connection: this.getConnectionActivity(),
					syncUnavailable: this.isConfigurationBusy(),
				}),
				Platform.isMobile ? "top" : "bottom",
				{
					synchronize: async () => {
						if (!this.isConfigurationBusy()) {
							await this.runFullSync();
						}
					},
					readLogs: async () =>
						sanitizeDiagnosticMessage(
							await logger.getLogContents(),
						),
				},
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
	private async resumeSyncIfReady(
		invocation?: StartupInvocation,
	): Promise<boolean> {
		if (!invocation) {
			return await this.getStartup().runInvocation((owned) =>
				this.resumeSyncIfReady(owned),
			);
		}
		if (
			this.isConfigurationBusy() ||
			this.persistence.failed ||
			this.unloaded
		) {
			return false;
		}
		this.beginConnectionCheck();
		this.activeFullRuns = (this.activeFullRuns ?? 0) + 1;
		this.notifyManualActivity();
		try {
			if (
				(await this.refreshRemoteStartupState(
					true,
					true,
					invocation,
				)) !== "ready"
			) {
				return false;
			}
			if (this.unloaded) {
				return false;
			}
			this.syncEngine.resume();
			const result = await this.runFullSync(
				undefined,
				false,
				false,
				invocation,
			);
			if (
				!result?.success ||
				this.unloaded ||
				this.syncEngine.isSyncPaused()
			) {
				return false;
			}
			this.automationReady = true;
			this.startAutomationIfReady();
			new Notice(t("notice.sync_resumed"));
			return true;
		} finally {
			this.activeFullRuns--;
			this.notifyManualActivity();
			this.startAutomationIfReady();
		}
	}

	/**
	 * Callback when layout is ready
	 */
	private async onLayoutReady(invocation?: StartupInvocation): Promise<void> {
		if (!invocation) {
			logger.info("Startup layout ready", {
				elapsedSincePluginLoadMs: Date.now() - this.pluginLoadStartedAt,
			});
			return await this.getStartup().runInvocation((owned) =>
				this.onLayoutReady(owned),
			);
		}
		if (this.unloaded || this.isConfigurationBusy()) {
			return;
		}
		this.beginConnectionCheck();
		this.activeFullRuns = (this.activeFullRuns ?? 0) + 1;
		this.notifyManualActivity();
		try {
			this.restoreLocalStateOnce();
			this.registerSyncLifecycleOnce();
			if (this.forceRecovery?.direct) {
				this.forceReplacementDependencies();
				await this.runFullSync({ startup: true }, false);
				return;
			}
			if (this.forceRecovery) {
				this.presentStartupBlock("force", t("force.legacy_recovery"));
				return;
			}
			if (
				(await this.refreshRemoteStartupState(
					true,
					true,
					invocation,
				)) !== "ready" ||
				this.unloaded
			) {
				return;
			}
		} catch (error) {
			this.stopRegularSync();
			if (this.forceRecovery) {
				this.forceBlockReason = t("force.recovery_pending");
				this.presentStartupBlock("force", this.forceBlockReason);
			}
			logger.warn("Startup recovery remains pending", { error });
			return;
		} finally {
			this.activeFullRuns--;
			this.notifyManualActivity();
			this.startAutomationIfReady();
		}

		await this.startSync(true, true, invocation);
	}

	private async ensureStorageBinding(
		prompt: boolean,
		observation?: RemoteAuthorityObservation,
	): Promise<boolean> {
		let ready = false;
		try {
			ready = await this.storageBinding.ensure(prompt, observation);
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
		const data = this.persistence.current;
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
		this.syncLifecycleDisposers.push(
			this.syncEngine.onSyncPrepare(
				async (context) =>
					await this.fileWatcher.prepareForSync(context),
			),
		);
		this.syncLifecycleDisposers.push(
			this.syncEngine.onSyncPause(
				async (context) => await this.fileWatcher.pauseForSync(context),
			),
		);
		this.syncLifecycleDisposers.push(
			this.syncEngine.onSyncFinalize(
				async (context, result) =>
					await this.fileWatcher.settleAfterReconciliation(
						context,
						result,
					),
			),
		);
		this.syncLifecycleDisposers.push(
			this.syncEngine.onSyncResume(
				async (outcome) =>
					await this.fileWatcher.resumeAfterSync(outcome),
			),
		);
		this.syncLifecycleRegistered = true;
	}

	/** Detach subscriptions after any admitted session has finalized its stopped watcher. */
	private disposeSyncLifecycle(): void {
		const dispose = () => {
			for (const unsubscribe of this.syncLifecycleDisposers) {
				unsubscribe();
			}
			this.syncLifecycleDisposers = [];
			this.syncLifecycleRegistered = false;
		};
		if (this.syncEngine?.hasPendingWork()) {
			const unsubscribe = this.syncEngine.onStateChange(() => {
				if (!this.syncEngine.hasPendingWork()) {
					unsubscribe();
					dispose();
				}
			});
		} else {
			dispose();
		}
	}

	/** Use the same startup oracle for layout, settings, resume and manual full. */
	private async refreshRemoteStartupState(
		prompt: boolean,
		allowRecovery = true,
		invocation?: StartupInvocation,
	): Promise<StartupState> {
		return await this.getStartup().refresh(
			prompt,
			allowRecovery,
			invocation,
		);
	}

	private startup: PluginStartup | null = null;
	private getStartup(): PluginStartup {
		if (!this.startup) {
			this.startup = new PluginStartup({
				index: this.indexManager,
				engine: this.syncEngine,
				getSettings: () => this.settings,
				getBlocks: () => ({
					force: this.forceBlockReason,
					migration: this.migrationBlockReason,
					historical: this.historicalBlockReason,
					authentication: this.authenticationBlockReason,
					encryption: this.encryptionBlockReason,
				}),
				hasTransition: () => this.encryptionTransition !== null,
				hasForceRecovery: () => this.forceRecovery !== null,
				isStopped: () => this.unloaded || this.persistence.failed,
				setBlock: (kind, reason, failure, showNotice) => {
					switch (kind) {
						case "force":
							this.forceBlockReason = reason;
							this.presentStartupBlock(
								kind,
								reason,
								failure,
								showNotice,
							);
							break;
						case "migration":
							this.setMigrationBlock(reason);
							break;
						case "historical":
							this.setHistoricalBlock(reason);
							break;
						case "authentication":
							this.setAuthenticationBlock(reason, failure);
							break;
						case "encryption":
							this.setEncryptionBlock(reason, showNotice);
							break;
					}
				},
				ensureStorageBinding: (prompt) =>
					this.ensureStorageBinding(prompt),
				recoverEncryptionTransition: () =>
					this.recoverEncryptionTransition(),
				tryRecoverRemoteTargetTransition: (reads) =>
					this.tryRecoverRemoteTargetTransition(reads),
				ensureEncryptionReady: (options, read) =>
					this.ensureEncryptionReady(options, read),
			});
		}
		return this.startup;
	}

	private get remoteStateValidated(): boolean {
		return this.startup?.validated ?? false;
	}
	private set remoteStateValidated(value: boolean) {
		if (value) {
			this.getStartup().validated = true;
		} else if (this.startup) {
			this.startup.validated = false;
		}
	}

	/**
	 * Run full synchronization
	 */
	async runFullSync(
		options?: SyncRunOptions,
		showProgressNotice = !options?.startup,
		forceFinalization = false,
		invocation?: StartupInvocation,
	): Promise<SyncResult | null> {
		if (!invocation) {
			return await this.getStartup().runInvocation((owned) =>
				this.runFullSync(
					options,
					showProgressNotice,
					forceFinalization,
					owned,
				),
			);
		}
		if (
			(this.isForceSyncBusy() ||
				this.configurationUpdatePending ||
				this.foregroundOperation ||
				this.unloaded ||
				this.persistence.failed) &&
			!forceFinalization
		) {
			return null;
		}
		if (this.activeFullPromise) {
			return await this.activeFullPromise;
		}
		if (showProgressNotice && this.activeManualFullPromise) {
			return await this.activeManualFullPromise;
		}
		this.beginConnectionCheck();
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
				if (this.forceRecovery?.direct) {
					this.forceReplacementDependencies();
				}
				const startupState = this.forceRecovery?.direct
					? "ready"
					: await this.refreshRemoteStartupState(
							showProgressNotice,
							true,
							invocation,
						);
				if (startupState !== "ready" || this.unloaded) {
					return null;
				}
				if (showProgressNotice) {
					this.beginSyncNotice(t("notice.sync_started"));
				}
				const recoveryGeneration = this.persistence.recoveryGeneration;
				const result = await this.syncEngine.fullSync(
					options,
					this.forceRecovery?.direct ? undefined : invocation.reads,
				);

				this.updateLastSyncStats(result);

				// Save updated index after sync
				await this.persistPluginData();
				if (result.success && recoveryGeneration !== undefined) {
					this.persistence.completeRecovery(recoveryGeneration);
				}
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
					this.automationReady = true;
					this.clearBlockingNotice();
				}
				const adoptionMessage =
					result.epochAdopted &&
					this.indexManager.getRemoteIndex().epochAdoption?.kind ===
						"encryption-replacement"
						? t("notice.encryption_reference_received")
						: result.conflicts > 0
							? t("notice.epoch_adopted_conflicts", {
									conflicts: result.conflicts,
								})
							: t("notice.epoch_adopted");
				if (result.epochAdopted && !showProgressNotice) {
					new Notice(adoptionMessage, 5000);
				}
				if (showProgressNotice) {
					const successful =
						result.uploaded + result.downloaded + result.deleted;
					this.finishSyncNotice(
						result.epochAdopted
							? adoptionMessage
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
			if (this.activeFullPromise === promise) {
				this.activeFullPromise = null;
			}
			this.activeFullRuns--;
			this.notifyManualActivity();
			this.startAutomationIfReady();
		});
		this.activeFullPromise = promise;
		if (!showProgressNotice) {
			return await promise;
		}
		this.activeManualFullPromise = promise.finally(() => {
			if (this.activeManualFullPromise === trackedPromise) {
				this.activeManualFullPromise = null;
				this.notifyManualActivity();
				this.startAutomationIfReady();
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
			if (this.unloaded) {
				return;
			}
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
		warning?: string,
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
		notice.setMessage(
			warning ? `${initialMessage}\n\n${warning}` : initialMessage,
		);
		this.activeSyncNotice = notice;
		this.syncNoticeUnsubscribe?.();
		this.syncNoticeUnsubscribe = null;
		if (subscribeToEngine) {
			this.syncNoticeUnsubscribe = this.syncEngine.onStateChange(
				(state) => {
					if (state.status !== "syncing" || !this.activeSyncNotice) {
						return;
					}
					const progress = t("notice.sync_progress", {
						operation: formatSyncActivity(state),
					});
					this.activeSyncNotice.setMessage(
						warning ? `${progress}\n\n${warning}` : progress,
					);
				},
			);
		}
		return notice;
	}

	/** Turn the active progress Notice into its final state. */
	private finishSyncNotice(message: string, durationMs: number): void {
		if (this.unloaded) {
			return;
		}
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
		if (!code || this.connectionIssue?.kind === code) {
			this.connectionIssue = undefined;
		}
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
		if (this.unloaded) {
			return;
		}
		if (this.getConnectionActivity()) {
			this.connectionIssue = { kind: code, message };
		}
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
				"force-recovery-pending",
				"encryption-blocked",
				"local-state-blocked",
				"authentication",
			].includes(error.code ?? ""),
		);
		if (!blockingError) {
			return false;
		}

		this.stopRegularSync();
		const noticeKey = {
			"force-recovery-pending": "force.recovery_pending",
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

	/** Compose source validation and local recovery persistence without reading destination canonical. */
	private forceReplacementDependencies(): ForceReplacementDependencies {
		const getSettings = () => this.settings;
		const dependencies: ForceReplacementDependencies = {
			client: this.yandexClient,
			isCancelled: () => this.unloaded,
			getRecovery: () => this.forceRecovery,
			adapter: this.vaultAdapter,
			index: this.indexManager,
			get settings() {
				return getSettings();
			},
			persist: async (state) => {
				const previous = this.forceRecovery;
				const previousTransition = this.encryptionTransition;
				this.forceRecovery = state;
				if (state) {
					this.encryptionTransition = null;
				}
				try {
					await this.persistPluginData();
				} catch (error) {
					this.forceRecovery = previous;
					this.encryptionTransition = previousTransition;
					throw error;
				}
				this.forceBlockReason =
					state && !state.direct ? t("force.recovery_pending") : null;
				this.presentStartupBlock(
					"force",
					this.forceBlockReason,
					undefined,
					false,
				);
				if (!state) {
					await this.initEncryption();
					this.setMigrationBlock(null);
					this.setHistoricalBlock(null);
					this.setAuthenticationBlock(null);
					this.setEncryptionBlock(null);
				}
			},
			password: (create) =>
				new Promise((resolve) =>
					new ConnectEncryptedVaultModal(
						this.app,
						resolve,
						t(
							create
								? "force.password_create"
								: "modal.encryption_connect_title",
						),
						t("force.password_description"),
						t("modal.encryption_connect_button"),
						create,
					).open(),
				),
			watcherCutoff: () =>
				this.fileWatcher
					.getDeferredEvents()
					.flatMap((event) => (event.id ? [event.id] : [])),
			retireWatcherEvents: (cutoff) =>
				this.fileWatcher.settleForceReplacement(cutoff),
		};
		this.syncEngine.setForceReplacementPorts(dependencies);
		return dependencies;
	}

	/** Prepare only the selected readable source; stale destination state cannot veto Force. */
	private async prepareForceSync(
		direction: ForceDirection,
		preparation: ForcePreparationContext,
	): Promise<{
		canonical: ForceBackupProof["canonical"];
		migration: boolean;
		replacement?: NonNullable<SyncRunOptions["forceReplacement"]>;
	} | null> {
		if (!this.settings.yandexTokenSecret) {
			throw new Error(t("notice.token_missing"));
		}
		this.restoreLocalStateOnce();
		this.registerSyncLifecycleOnce();
		const dependencies = this.forceReplacementDependencies();
		const plan = await prepareForceReplacement(
			{
				...dependencies,
				password: (create, invalid) =>
					preparation.password(create, invalid),
				isCancelled: () => this.unloaded || preparation.isCancelled(),
				sourceProgress: (completed, total) =>
					preparation.progress(completed, total),
			},
			direction,
			true,
		);
		return plan
			? {
					canonical: { state: "absent" },
					migration: false,
					replacement: {
						plan,
						backupMode: "without-backup",
					},
				}
			: null;
	}

	private async captureForceSnapshot(
		direction: ForceDirection,
	): Promise<string> {
		return direction === "from_local"
			? await captureRemoteRawDigest(
					this.yandexClient,
					this.settings.remotePath,
					this.vaultAdapter.vault.configDir,
				)
			: await captureLogicalVaultDigest(this.vaultAdapter, true);
	}

	/** Open presentation before the controller starts read-only preparation. */
	private openForceSyncModal(direction: ForceDirection): ForceSyncModal {
		const modal = new ForceSyncModal(
			this.app,
			direction,
			this.settings.remotePath,
			() => {
				this.forceSyncController?.cancel();
			},
		);
		modal.open();
		return modal;
	}

	/** Compose the shared Force workflow; the controller owns its lifetime. */
	getForceSyncController(): ForceSyncController {
		if (!this.forceSyncController) {
			let replacementResult: SyncResult | null = null;
			let modal: ForceSyncModal | null = null;
			this.forceSyncController = new ForceSyncController({
				open: (direction) => {
					modal?.close();
					modal = this.openForceSyncModal(direction);
				},
				close: () => modal?.close(),
				password: (create, invalid) =>
					modal?.requestPassword(create, invalid) ??
					Promise.resolve(null),
				retryPreparation: (failure) =>
					modal?.retryPreparation(failure) ?? Promise.resolve(false),
				isSyncBusy: () => this.isForceSyncUnavailable(),
				preflight: (direction, preparation) =>
					this.prepareForceSync(direction, preparation),
				confirm: (
					_direction,
					_migration,
					replacement,
					prepareArchive,
				) =>
					modal?.confirm(replacement?.plan, prepareArchive) ??
					Promise.resolve("cancel"),
				captureProtectedSnapshot: (direction) =>
					this.captureForceSnapshot(direction),
				readyForBackup: async (_migration, replacement) => {
					if (replacement) {
						await ensureForceRoot(
							this.forceReplacementDependencies(),
							replacement.plan,
						);
					}
					return true;
				},
				backupFailure: (replacement) =>
					!replacement
						? Promise.resolve("cancel" as const)
						: new Promise((resolve) =>
								new DecisionModal<
									"retry" | "without-backup" | "cancel"
								>(
									this.app,
									t("force.backup_failed_title"),
									t("force.backup_failed_description"),
									[
										{
											label: t("force.retry"),
											value: "retry" as const,
										},
										{
											label: t(
												"modal.continue_without_backup",
											),
											value: "without-backup" as const,
										},
										{
											label: t("modal.cancel_button"),
											value: "cancel" as const,
										},
									],
									"cancel",
									resolve,
								).open(),
							),
				backup: async (direction, progress, replacement) => {
					const create = () =>
						direction === "from_local"
							? this.backupManager.createRemoteSnapshotBackup(
									replacement?.plan.password ?? undefined,
									progress,
									true,
								)
							: this.backupManager.createBackup(
									replacement?.plan.password ?? undefined,
									progress,
									true,
								);
					return replacement
						? await this.indexManager.withForceScope(
								replacement.plan.recovery,
								create,
							)
						: await create();
				},
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
				run: async (direction, options) => {
					replacementResult = null;
					const result =
						direction === "from_local"
							? await this.syncEngine.forceSyncFromLocal(options)
							: await this.syncEngine.forceSyncFromRemote(
									options,
								);
					if (options.forceReplacement && result.success) {
						replacementResult = result;
					}
					return result;
				},
				persist: async (result) => {
					this.updateLastSyncStats(result);
					await this.persistPluginData();
				},
				replacementCommitted: () => {
					this.setMigrationBlock(null);
					if (replacementResult) {
						this.setEncryptionBlock(null);
						this.setHistoricalBlock(null);
						this.setAuthenticationBlock(null);
						this.automationReady = true;
					}

					this.remoteStateValidated = false;
				},
				reconcile: async (onActivity) => {
					if (replacementResult && this.syncEngine.isSyncPaused()) {
						this.automationReady = true;
						return replacementResult;
					}
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
						this.automationReady = true;
						this.startAutomationIfReady();
					}
					return result;
				},
				hasPendingRecovery: () => this.forceRecovery !== null,
				hasPendingCleanup: () =>
					this.indexManager.getPendingPhysicalActions().length > 0 ||
					this.indexManager.getMaintenance() !== undefined,
				reportError: (error) =>
					logger.error("Force workflow failed", { error }),
			});
			this.forceSyncController.subscribe((state) => {
				modal?.render(state);
				this.renderForceProgress(state);
				this.startAutomationIfReady();
			});
		}
		return this.forceSyncController;
	}

	isForceSyncBusy(): boolean {
		return this.forceSyncController?.isBusy() ?? false;
	}

	isForceSyncUnavailable(): boolean {
		return Boolean(
			this.configurationUpdatePending ||
			this.isForceSyncBusy() ||
			this.foregroundOperation ||
			this.persistence.failed ||
			this.unloaded,
		);
	}

	/** Subscribe without exposing synchronization internals to settings. */
	onSyncActivityChange(callback: () => void): () => void {
		this.manualActivityListeners.add(callback);
		const unsubscribe = this.syncEngine.onStateChange(callback);
		const unsubscribeForce =
			this.getForceSyncController().subscribe(callback);
		return () => {
			unsubscribe();
			unsubscribeForce();
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
		invocation?: StartupInvocation,
	): Promise<void> {
		if (!invocation) {
			return await this.getStartup().runInvocation((owned) =>
				this.startSync(startup, remoteReady, owned),
			);
		}
		if (
			this.isConfigurationBusy() ||
			this.unloaded ||
			this.persistence.failed ||
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
			(await this.refreshRemoteStartupState(true, true, invocation)) !==
				"ready"
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
			false,
			invocation,
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
		this.automationReady = true;
		this.startAutomationIfReady();
		logger.info("[Main] Synchronization started");
		if (!this.backupSweepScheduled) {
			this.backupSweepScheduled = true;
			void this.syncEngine
				.runExclusiveMaintenance(async () => {
					if (!this.unloaded && !this.syncEngine.isSyncPaused()) {
						const lifetime =
							this.indexManager.createCanonicalReadSession(
								this.syncEngine.createReadLifetimeGuard(),
							);
						await this.vaultAdapter.cleanupOldBackups(30, () =>
							lifetime.assertCurrent(),
						);
					}
				})
				.catch((error) =>
					logger.warn("Overwritten-file backup cleanup failed:", {
						error,
					}),
				);
		}
	}

	/**
	 * Load settings
	 */
	async loadSettings(): Promise<void> {
		await this.persistence.load((loaded) => {
			const data = loaded.data;
			this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
			if (data?.lastSyncStats) {
				this.lastSyncStats = data.lastSyncStats;
			}
			this.encryptionTransition = data?.encryptionTransition ?? null;
			this.forceRecovery = data?.forceRecovery ?? null;

			// Automatically determine path with vault name
			const vaultName = this.app.vault.getName();
			const saved = data?.settings;

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
					data.encryptionTransition ||
					data.forceRecovery
				) {
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
		});
		try {
			globalThis.localStorage?.setItem(
				`yandex-disk-sync:device-id:${this.getVaultStorageScope()}`,
				this.settings.deviceId,
			);
		} catch {
			// Plugin data remains the durable causal snapshot.
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
	private configurationSyncPending = false;
	private connectionIssue?: { kind: string; message: string };
	private connectionPreviousFailure?: FailureSummary;
	private connectionRetry?: RetryProgress;
	private foregroundOperation:
		"encryption" | "encryption-password" | "backup" | null = null;
	private unloaded = false;
	private storageBinding!: StorageBindingController;

	/** Suppress presentation after the plugin lifecycle has ended. */
	isPluginUnloaded(): boolean {
		return this.unloaded;
	}

	/** Save user drafts through the same persistence owner as internal transitions. */
	async applySettingsPatch(patch: UserSettingsPatch): Promise<void> {
		await applyUserSettingsPatch(
			{
				getSettings: () => this.settings,
				persistenceFailed: () => this.persistence.failed,
				persistenceRecoveryGeneration: () =>
					this.persistence.recoveryGeneration,
				completePersistenceRecovery: (generation) =>
					this.persistence.completeRecovery(generation),
				isConfigurationBusy: () => this.isConfigurationBusy(),
				hasTransition: () => this.encryptionTransition !== null,
				hasDurableConfigurationWork: () =>
					this.hasDurableConfigurationWork(),
				isUnloaded: () => this.isPluginUnloaded(),
				isLayoutReady: () => this.app.workspace.layoutReady,
				setUpdating: (updating, synchronizing = false) => {
					if (
						updating &&
						synchronizing &&
						!this.configurationSyncPending
					) {
						this.beginConnectionCheck();
					}
					this.configurationUpdatePending = updating;
					this.configurationSyncPending = updating && synchronizing;
					if (
						!updating &&
						!this.unloaded &&
						!this.blockingNotice &&
						this.authenticationBlockReason
					) {
						this.showBlockingNotice(
							"authentication",
							this.authenticationBlockReason,
						);
					}
					this.notifyManualActivity();
				},
				stopRegularSync: () => this.stopRegularSync(),
				startAutomation: () => {
					this.automationReady = true;
					this.startAutomationIfReady();
				},
				refreshAutomation: () => this.startAutomationIfReady(true),
				settingsSaveRejected: (error, stage) => {
					this.remoteStateValidated = false;
					if (!this.persistence.failed) {
						const failure = createSyncFailure(error, {
							stage,
							action: "unknown",
						}).summary;
						this.showBlockingNotice(
							"settings-update",
							formatOperationFailure(failure),
						);
					}
				},
				persistPluginData: async (draft) => {
					await this.persistPluginData(draft);
					if (draft.yandexTokenSecret && !this.unloaded) {
						this.clearBlockingNotice("authentication");
					}
				},
				runStartupInvocation: (action) =>
					this.getStartup().runInvocation(action),
				refreshRemoteStartupState: (prompt, recovery, invocation) =>
					this.refreshRemoteStartupState(
						prompt,
						recovery,
						invocation,
					),
				reconcile: (invocation) =>
					this.runFullSync(undefined, false, true, invocation),
				watcher: this.fileWatcher,
				engine: this.syncEngine,
			},
			patch,
		);
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

	private beginConnectionCheck(): void {
		this.connectionIssue = undefined;
		this.connectionRetry = undefined;
		this.connectionPreviousFailure = this.syncEngine?.getState?.().failure;
	}

	/** Present this invocation's admission, without clearing any owning safety block. */
	getConnectionActivity():
		{ errorMessage?: string; retry?: RetryProgress } | undefined {
		const state = this.syncEngine?.getState?.();
		if (
			this.unloaded ||
			(!this.configurationSyncPending && !this.activeFullRuns) ||
			state?.status === "paused" ||
			state?.sessionKind ||
			state?.status === "syncing"
		) {
			return undefined;
		}
		return {
			errorMessage:
				this.connectionIssue?.message ??
				(state?.failure &&
				state.failure !== this.connectionPreviousFailure
					? state.errorMessage
					: undefined),
			retry: this.connectionRetry,
		};
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

	/** Expose the existing foreground owner for settings progress presentation. */
	getForegroundOperation(): "encryption" | "backup" | null {
		return this.foregroundOperation === "encryption-password"
			? "encryption"
			: this.foregroundOperation;
	}

	/** Identify the initiating encryption control when settings are reopened. */
	isEncryptionPasswordChangeInProgress(): boolean {
		return this.foregroundOperation === "encryption-password";
	}

	/** Reserve manual preflight through completion without nesting coordinator sessions. */
	private async withForegroundOperation<T>(
		kind: "encryption" | "encryption-password" | "backup",
		operation: () => Promise<T>,
	): Promise<T> {
		this.assertForceIdle();
		if (
			this.isConfigurationBusy() ||
			this.unloaded ||
			this.persistence.failed
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
			this.startAutomationIfReady();
		}
	}

	async saveSettings(): Promise<void> {
		this.persistence.requireLoaded();
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
				buildId: SYNC_BUILD_ID,
				deviceId: shortenDiagnosticValue(this.settings.deviceId),
			},
		});

		// Update components
		if (this.yandexClient) {
			this.yandexClient.setReadConcurrency(this.settings.maxConcurrency);
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
		return await this.encryptionWorkflow.initEncryption();
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
			this.beginSyncNotice(
				t("notice.encryption_syncing"),
				true,
				t("notice.encryption_replacement_warning"),
			);
			try {
				await this.syncEngine.runExclusiveMaintenance(async () => {
					await this.encryptionWorkflow.enableEncryptionNow(
						password,
						choice,
					);
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
			this.beginSyncNotice(
				t("notice.encryption_disabling"),
				true,
				options?.reuploadPlaintext
					? t("notice.encryption_replacement_warning")
					: undefined,
			);
			try {
				const result = await this.syncEngine.runExclusiveMaintenance(
					async () =>
						this.encryptionWorkflow.disableEncryptionNow(
							options,
							choice,
						),
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

	/**
	 * Rotate the encryption password and re-upload all files with a new key.
	 */
	async rotateEncryptionPassword(newPassword: string): Promise<void> {
		return await this.withForegroundOperation(
			"encryption-password",
			async () => {
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
				this.beginSyncNotice(
					t("notice.encryption_password_rotating"),
					true,
					t("notice.encryption_replacement_warning"),
				);
				try {
					await this.syncEngine.runExclusiveMaintenance(async () => {
						await this.encryptionWorkflow.rotateEncryptionPasswordNow(
							newPassword,
							choice,
						);
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
			},
		);
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
		this.automationReady = true;
		this.startAutomationIfReady();
	}

	private async connectToRemoteEncryptionForSync(
		password: string,
		manifest?: RemoteEncryptionManifest,
	): Promise<void> {
		return await this.encryptionWorkflow.connectForSync(password, manifest);
	}

	/** Return whether the remote still requires explicit migration. */
	isStableMigrationPending(): boolean {
		return Boolean(this.migrationBlockReason);
	}

	/** Ask for an existing vault password without changing domain state. */
	private requestEncryptionPassword(
		mode: EncryptionPromptMode,
	): Promise<string | null> {
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
		return new Promise((resolve) => {
			new ConnectEncryptedVaultModal(
				this.app,
				resolve,
				title,
				body,
				t("modal.encryption_connect_button"),
			).open();
		});
	}

	private async tryRecoverRemoteTargetTransition(
		reads?: StartupReadSession,
	): Promise<boolean> {
		return await this.encryptionWorkflow.recovery.tryRecoverRemoteTargetTransition(
			reads,
		);
	}

	private async ensureEncryptionReady(
		options: EncryptionReadyOptions,
		knownManifest?: { manifest: RemoteEncryptionManifest | null },
	): Promise<boolean> {
		return await this.encryptionWorkflow.admission.ensureEncryptionReady(
			options,
			knownManifest,
		);
	}

	/**
	 * Verify a candidate encryption password against the currently initialized
	 * encryption service. Returns false if encryption is not active or the
	 * password does not derive the same key.
	 */
	async verifyEncryptionPassword(password: string): Promise<boolean> {
		return await this.encryptionWorkflow.verifyEncryptionPassword(password);
	}

	private confirmOperationBackup(): Promise<OperationBackupChoice> {
		return new Promise((resolve) =>
			new OperationBackupModal(this.app, resolve).open(),
		);
	}

	private async recoverEncryptionTransition(): Promise<void> {
		return await this.encryptionWorkflow.recovery.recoverEncryptionTransition();
	}

	private setEncryptionBlock(reason: string | null, showNotice = true): void {
		const changed = this.encryptionBlockReason !== reason;
		this.encryptionBlockReason = reason;
		this.presentStartupBlock(
			"encryption",
			reason,
			undefined,
			showNotice &&
				(changed || this.blockingNotice?.code !== "encryption-state"),
		);
	}
	private setMigrationBlock(reason: string | null): void {
		this.migrationBlockReason = reason;
		this.presentStartupBlock("migration", reason);
	}
	private setHistoricalBlock(reason: string | null): void {
		this.historicalBlockReason = reason;
		this.presentStartupBlock("historical", reason);
	}
	private setAuthenticationBlock(
		reason: string | null,
		failure?: FailureSummary,
	): void {
		this.authenticationBlockReason = reason;
		this.presentStartupBlock("authentication", reason, failure);
	}

	/** Present typed engine decisions without reimplementing their priority or admission. */
	private presentStartupBlock(
		kind: StartupBlockKind,
		reason: string | null,
		failure?: FailureSummary,
		showNotice = true,
	): void {
		if (this.configurationSyncPending || this.activeFullRuns) {
			if (reason) {
				this.connectionIssue = { kind, message: reason };
			} else if (this.connectionIssue?.kind === kind) {
				this.connectionIssue = undefined;
			}
		}
		this.syncEngine?.setExternalBlock(kind, reason, failure);
		const codes: Record<StartupBlockKind, string> = {
			force: "force-recovery-pending",
			encryption: "encryption-state",
			migration: "migration-required",
			historical: "unsupported-historical",
			authentication: "authentication",
		};
		const code = codes[kind];
		if (reason) {
			this.stopRegularSync();
			if (showNotice) {
				this.showBlockingNotice(code, reason);
			}
		} else {
			this.clearBlockingNotice(code);
		}
	}

	/** Start listeners only after durable reconciliation and all owning flows have settled. */
	private startAutomationIfReady(refresh = false): void {
		if (this.forceRecovery?.direct) {
			if (
				!this.unloaded &&
				!this.persistence.failed &&
				this.persistence.recoveryGeneration === undefined &&
				!this.isConfigurationBusy() &&
				this.app.workspace?.layoutReady &&
				!this.syncEngine.isSyncPaused() &&
				this.settings.yandexTokenSecret
			) {
				this.syncScheduler?.start();
			}
			return;
		}
		if (
			!this.automationReady ||
			(this.regularSyncStarted && !refresh) ||
			this.unloaded ||
			this.persistence.failed ||
			this.persistence.recoveryGeneration !== undefined ||
			this.isConfigurationBusy() ||
			!this.app.workspace?.layoutReady ||
			this.syncEngine.isSyncPaused() ||
			this.forceRecovery ||
			this.encryptionTransition ||
			this.forceBlockReason ||
			this.migrationBlockReason ||
			this.historicalBlockReason ||
			this.authenticationBlockReason ||
			this.encryptionBlockReason
		) {
			return;
		}
		if (
			this.indexManager?.getMaintenance() ||
			this.indexManager
				?.getPendingPhysicalActions()
				.some((action) => action.type === "guarded-cleanup")
		) {
			return;
		}
		this.fileWatcher.start();
		this.syncScheduler.start();
		this.regularSyncStarted = true;
	}

	private stopRegularSync(): void {
		this.automationReady = false;
		this.fileWatcher?.stop();
		this.syncScheduler?.stop();
		this.regularSyncStarted = false;
	}

	/** Token or remote-path changes invalidate every cached startup decision. */
	private invalidateRemoteStateClassification(): void {
		this.remoteStateValidated = false;
	}

	private async requireCanonicalMaintenanceCleanupComplete(): Promise<void> {
		return await this.encryptionWorkflow.maintenance.requireCanonicalMaintenanceCleanupComplete();
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
				this.persistence.current?.localState ??
				null,
			pendingMutations:
				this.indexManager?.getPendingMutations() ??
				this.persistence.current?.pendingMutations ??
				[],
			pendingPhysicalActions:
				this.indexManager?.getPendingPhysicalActions() ??
				this.persistence.current?.pendingPhysicalActions ??
				[],
			pendingWatcherEvents:
				this.fileWatcher?.getDeferredEvents() ??
				this.persistence.current?.pendingWatcherEvents ??
				[],
			encryptionTransition: this.encryptionTransition,
			forceRecovery: this.forceRecovery,
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

	/** Route every internal and user save through the same coherent queue. */
	private async persistPluginData(patch?: UserSettingsPatch): Promise<void> {
		await this.persistence.persist(patch);
	}

	private assertForceIdle(): void {
		if (this.isForceSyncBusy()) {
			throw new Error(t("notice.force_busy"));
		}
	}
}
