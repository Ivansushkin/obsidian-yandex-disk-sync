import { SyncCoordinator } from "../src/sync/coordinator";
import assert from "node:assert/strict";
import test from "node:test";
import YandexDiskSyncPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/types";
import type { SyncResult } from "../src/types";
import type { SyncRunOptions } from "../src/sync/engine";
import { YandexApiError } from "../src/api/yandex-client";
import { StorageScopeError } from "../src/sync/local/storage-scope";

interface MainAccess {
	onLayoutReady(): Promise<void>;
	resumeSyncIfReady(): Promise<boolean>;
	loadedPluginData: {
		localState: null;
		pendingMutations: unknown[];
		pendingPhysicalActions: unknown[];
		pendingWatcherEvents: unknown[];
		lastSyncStats: {
			uploaded: number;
			downloaded: number;
			deleted: number;
			errors: number;
		};
	};
	localStateRestored: boolean;
	syncLifecycleRegistered: boolean;
	indexManager: Record<string, (...args: unknown[]) => unknown>;
	fileWatcher: Record<string, (...args: unknown[]) => unknown>;
	syncScheduler: Record<string, (...args: unknown[]) => unknown>;
	syncEngine: Record<string, (...args: unknown[]) => unknown>;
	refreshRemoteStartupState(): Promise<
		"ready" | "migration" | "adoption" | "blocked"
	>;
}

function createBlockedLifecycleHarness(
	classification: "migration" | "blocked",
): { plugin: MainAccess; registrations: string[]; restores: string[] } {
	const plugin = Object.create(YandexDiskSyncPlugin.prototype) as MainAccess;
	const registrations: string[] = [];
	const restores: string[] = [];
	plugin.localStateRestored = false;
	plugin.syncLifecycleRegistered = false;
	plugin.loadedPluginData = {
		localState: null,
		pendingMutations: [],
		pendingPhysicalActions: [],
		pendingWatcherEvents: [],
		lastSyncStats: { uploaded: 0, downloaded: 0, deleted: 0, errors: 0 },
	};
	plugin.indexManager = {
		loadPendingMutations: () => restores.push("mutations"),
		loadPendingPhysicalActions: () => restores.push("actions"),
	};
	plugin.fileWatcher = {
		loadDeferredEvents: () => restores.push("watcher"),
		prepareForSync: async () => {},
		pauseForSync: async () => {},
		settleAfterReconciliation: async () => {},
		resumeAfterSync: async () => {},
		start: () => restores.push("watcher-start"),
	};
	plugin.syncScheduler = {
		start: () => restores.push("scheduler-start"),
	};
	plugin.syncEngine = {
		hasPendingWork: () => false,
		onSyncPrepare: () => registrations.push("prepare"),
		onSyncPause: () => registrations.push("pause"),
		onSyncFinalize: () => registrations.push("finalize"),
		onSyncResume: () => registrations.push("resume"),
		resume: () => restores.push("engine-resume"),
	};
	plugin.refreshRemoteStartupState = async () => classification;
	return { plugin, registrations, restores };
}

test("missing or replaced token does not skip lifecycle initialization", async () => {
	for (const classification of ["blocked", "migration"] as const) {
		const { plugin, registrations, restores } =
			createBlockedLifecycleHarness(classification);
		await plugin.onLayoutReady();
		await plugin.onLayoutReady();
		assert.deepEqual(registrations, [
			"prepare",
			"pause",
			"finalize",
			"resume",
		]);
		assert.deepEqual(restores, ["mutations", "actions", "watcher"]);
	}
});

test("resume cannot start automation while legacy migration is required", async () => {
	const { plugin, restores } = createBlockedLifecycleHarness("migration");
	assert.equal(await plugin.resumeSyncIfReady(), false);
	assert.deepEqual(restores, []);
});

/** Isolate startup classification from unrelated UI and lifecycle setup. */
function createStartupPlugin() {
	const plugin = Object.create(YandexDiskSyncPlugin.prototype) as unknown as {
		refreshRemoteStartupState(prompt: boolean): Promise<string>;
		settings: typeof DEFAULT_SETTINGS;
		remoteStateValidated: boolean;
		migrationBlockReason: string | null;
		historicalBlockReason: string | null;
		authenticationBlockReason: string | null;
		encryptionBlockReason: string | null;
		encryptionTransition: null;
		indexManager: Record<string, (...args: unknown[]) => unknown>;
		syncEngine: Record<string, (...args: unknown[]) => unknown>;
		fileWatcher: Record<string, (...args: unknown[]) => unknown>;
		syncScheduler: Record<string, (...args: unknown[]) => unknown>;
		tryRecoverRemoteTargetTransition(): Promise<void>;
		ensureEncryptionReady(): Promise<boolean>;
		blockingNotice: null;
		regularSyncStarted: boolean;
	};
	plugin.settings = {
		...DEFAULT_SETTINGS,
		yandexTokenSecret: "configured-placeholder",
	};
	plugin.remoteStateValidated = false;
	plugin.migrationBlockReason = null;
	plugin.historicalBlockReason = null;
	plugin.authenticationBlockReason = null;
	plugin.encryptionBlockReason = null;
	plugin.encryptionTransition = null;
	plugin.blockingNotice = null;
	plugin.regularSyncStarted = false;
	plugin.syncEngine = {
		setExternalBlock: () => {},
		isSyncInProgress: () => false,
		hasPendingWork: () => false,
	};
	plugin.fileWatcher = { stop: () => {} };
	plugin.syncScheduler = { stop: () => {} };
	plugin.tryRecoverRemoteTargetTransition = async () => {};
	plugin.ensureEncryptionReady = async () => true;
	Object.assign(plugin, { storageBinding: { ensure: async () => true } });
	return plugin;
}

test("storage admission classifies startup failures and recovers after connection repair", async () => {
	for (const error of [
		new YandexApiError("synthetic unauthorized", 401),
		new YandexApiError("synthetic forbidden", 403),
		new Error("synthetic offline"),
		new StorageScopeError("synthetic root mismatch"),
		null,
	]) {
		const plugin = createStartupPlugin();
		const blocks = new Map<string, string>();
		plugin.syncEngine.setExternalBlock = (
			kind: unknown,
			reason: unknown,
		) => {
			if (typeof reason === "string") {
				blocks.set(String(kind), String(reason));
			} else {
				blocks.delete(String(kind));
			}
		};
		let repaired = false;
		let remoteReads = 0;
		Object.assign(plugin, {
			storageBinding: {
				ensure: async () => {
					if (!repaired && error) {
						throw error;
					}
					return repaired;
				},
			},
		});
		plugin.indexManager = {
			downloadEncryptionManifest: async () => {
				remoteReads++;
				return null;
			},
			inspectRemoteCanonicalFormat: async () => "current",
		};
		assert.equal(await plugin.refreshRemoteStartupState(false), "blocked");
		assert.equal(remoteReads, 0);
		const scopeFailure =
			error === null || error instanceof StorageScopeError;
		assert.equal(blocks.has("local-state"), scopeFailure);
		assert.equal(plugin.authenticationBlockReason !== null, !scopeFailure);
		repaired = true;
		assert.equal(await plugin.refreshRemoteStartupState(false), "ready");
		assert.equal(blocks.size, 0);
		assert.equal(plugin.authenticationBlockReason, null);
	}
});

test("foreign device revalidates a stale legacy migration block", async () => {
	const plugin = createStartupPlugin();
	let canonicalReads = 0;
	plugin.remoteStateValidated = true;
	plugin.migrationBlockReason = "legacy migration required";
	plugin.indexManager = {
		downloadEncryptionManifest: async () => null,
		inspectRemoteCanonicalFormat: async () => {
			canonicalReads++;
			return "current";
		},
	};
	assert.equal(await plugin.refreshRemoteStartupState(false), "ready");
	assert.equal(canonicalReads, 1);
	assert.equal(plugin.migrationBlockReason, null);
});

test("encrypted current local state cannot Force a plaintext stable migration", async () => {
	const plugin = createStartupPlugin();
	Object.assign(plugin.settings, {
		enableEncryption: true,
		encryptionSalt: "current-salt",
		encryptionPassword: "password-placeholder",
		encryptionRevision: 1,
		encryptionProfileId: "hardened",
	});
	plugin.indexManager = {
		downloadEncryptionManifest: async () => null,
		inspectRemoteCanonicalFormat: async () => "legacy",
	};
	assert.equal(await plugin.refreshRemoteStartupState(false), "blocked");
	assert.equal(plugin.migrationBlockReason, null);
	assert.notEqual(plugin.historicalBlockReason, null);
});

test("post-commit Force failure resumes cleanup without repeating migration", async () => {
	const plugin = Object.create(YandexDiskSyncPlugin.prototype) as unknown as {
		getForceSyncController(): import("../src/sync/workflows/force-controller").ForceSyncController;
		prepareForceSync(): Promise<unknown>;
		confirmForceSync(): Promise<"with-backup">;
		recheckLegacyMigrationSafety(): Promise<boolean>;
		ensureEncryptionReady(): Promise<boolean>;
		captureForceSnapshot(): Promise<string>;
		renderForceProgress(): void;
		updateLastSyncStats(): void;
		persistPluginData(): Promise<void>;
		setMigrationBlock(reason: string | null): void;
		runFullSync(
			options: SyncRunOptions,
			notice: boolean,
			owned: boolean,
		): Promise<SyncResult>;
		remoteStateValidated: boolean;
		indexManager: Record<string, (...args: unknown[]) => unknown>;
		syncEngine: {
			isSyncInProgress(): boolean;
			isSyncPaused(): boolean;
			hasPendingWork(): boolean;
			forceSyncFromLocal(options: SyncRunOptions): Promise<SyncResult>;
		};
		backupManager: { createRemoteSnapshotBackup(): Promise<unknown> };
		fileWatcher: { start(): void };
		syncScheduler: { start(): void };
	};
	let cleanupStarts = 0;
	let migrationReason: string | null = "migration required";
	plugin.remoteStateValidated = true;
	plugin.prepareForceSync = async () => ({
		canonical: { state: "absent" },
		migration: true,
	});
	plugin.indexManager = {
		getPendingPhysicalActions: () => [],
		getMaintenance: () => undefined,
	};
	plugin.confirmForceSync = async () => "with-backup";
	plugin.backupManager = {
		createRemoteSnapshotBackup: async () => ({
			success: true,
			backupName: "verified.zip",
			sha256: "backup-sha",
			snapshotDigest: "snapshot-sha",
			fileCount: 1,
			totalSize: 10,
		}),
	};
	plugin.recheckLegacyMigrationSafety = async () => true;
	plugin.ensureEncryptionReady = async () => true;
	plugin.captureForceSnapshot = async () => "snapshot-sha";
	plugin.renderForceProgress = () => {};
	plugin.updateLastSyncStats = () => {};
	plugin.persistPluginData = async () => {};
	plugin.setMigrationBlock = (reason) => {
		migrationReason = reason;
	};
	const result: SyncResult = {
		success: false,
		replacementCommitted: true,
		uploaded: 1,
		downloaded: 0,
		deleted: 0,
		conflicts: 0,
		startTime: 1,
		endTime: 2,
		errors: [
			{
				path: "old.md",
				operation: "delete_remote",
				message: "cleanup interrupted",
			},
		],
	};
	plugin.syncEngine = {
		isSyncInProgress: () => false,
		hasPendingWork: () => false,
		isSyncPaused: () => false,
		forceSyncFromLocal: async (options) => {
			await options.beforeForceMutation?.();
			return result;
		},
	};
	plugin.runFullSync = async (options, notice, owned) => {
		assert.equal(notice, false);
		assert.equal(owned, true);
		assert.equal(typeof options.onActivity, "function");
		cleanupStarts++;
		return { ...result, success: true, errors: [] };
	};
	plugin.fileWatcher = { start() {} };
	plugin.syncScheduler = { start() {} };
	await plugin.getForceSyncController().run("from_local");
	assert.equal(migrationReason, null);
	assert.equal(plugin.remoteStateValidated, false);
	assert.equal(cleanupStarts, 1);
	assert.equal(
		plugin.getForceSyncController().getState()?.outcome,
		"success",
	);
});

test("full preflight prevents Force from stealing foreground operation ownership", async () => {
	for (const visible of [true, false]) {
		let release = () => {};
		const pending = new Promise<void>((done) => {
			release = done;
		});
		const plugin = Object.create(
			YandexDiskSyncPlugin.prototype,
		) as unknown as {
			settings: typeof DEFAULT_SETTINGS;
			syncEngine: {
				isSyncInProgress(): boolean;
				hasPendingWork(): boolean;
			};
			restoreLocalStateOnce(): void;
			registerSyncLifecycleOnce(): void;
			refreshRemoteStartupState(): Promise<string>;
			prepareForceSync(): Promise<never>;
			runFullSync(
				options?: undefined,
				visible?: boolean,
			): Promise<SyncResult | null>;
			runForceSyncFromLocal(): Promise<void>;
			isForceSyncUnavailable(): boolean;
		};
		plugin.settings = {
			...DEFAULT_SETTINGS,
			yandexTokenSecret: "configured",
		};
		plugin.syncEngine = {
			isSyncInProgress: () => false,
			hasPendingWork: () => false,
		};
		plugin.restoreLocalStateOnce = () => {};
		plugin.registerSyncLifecycleOnce = () => {};
		plugin.refreshRemoteStartupState = async () => {
			await pending;
			return "blocked";
		};
		plugin.prepareForceSync = async () => {
			throw new Error("Force must not start");
		};
		const full = plugin.runFullSync(undefined, visible);
		assert.equal(plugin.isForceSyncUnavailable(), true);
		await plugin.runForceSyncFromLocal();
		release();
		await full;
		assert.equal(plugin.isForceSyncUnavailable(), false);
	}
});

test("encrypted Force permits owned authentication but blocks independent encryption actions", async () => {
	const plugin = Object.create(YandexDiskSyncPlugin.prototype) as unknown as {
		isForceSyncBusy(): boolean;
		connectToRemoteEncryption(password: string): Promise<void>;
		connectToRemoteEncryptionForSync(password: string): Promise<void>;
		connectToRemoteEncryptionNow(password: string): Promise<void>;
		enableEncryption(password: string): Promise<void>;
		disableEncryption(): Promise<unknown>;
		rotateEncryptionPassword(password: string): Promise<void>;
		syncEngine: {
			runExclusiveMaintenance(task: () => Promise<void>): Promise<void>;
		};
	};
	let authenticated = 0;
	let maintenance = 0;
	plugin.isForceSyncBusy = () => true;
	plugin.connectToRemoteEncryptionNow = async () => {
		authenticated++;
	};
	plugin.syncEngine = {
		runExclusiveMaintenance: async (task) => {
			maintenance++;
			await task();
		},
	};
	await assert.rejects(
		plugin.connectToRemoteEncryption("test-password"),
		/already in progress/,
	);
	await assert.rejects(
		plugin.enableEncryption("test-password"),
		/already in progress/,
	);
	await assert.rejects(
		plugin.rotateEncryptionPassword("test-password"),
		/already in progress/,
	);
	await assert.rejects(plugin.disableEncryption(), /already in progress/);
	assert.equal(authenticated, 0);
	await plugin.connectToRemoteEncryptionForSync("test-password");
	assert.equal(authenticated, 1);
	assert.equal(maintenance, 1);
});

test("remote path change invalidates the previous migration decision", () => {
	const plugin = Object.create(YandexDiskSyncPlugin.prototype) as unknown as {
		invalidateRemoteStateClassification(): void;
		remoteStateValidated: boolean;
		migrationBlockReason: string | null;
		historicalBlockReason: string | null;
		authenticationBlockReason: string | null;
		encryptionBlockReason: string | null;
		blockingNotice: null;
		regularSyncStarted: boolean;
		syncEngine: Record<string, (...args: unknown[]) => unknown>;
		fileWatcher: Record<string, (...args: unknown[]) => unknown>;
		syncScheduler: Record<string, (...args: unknown[]) => unknown>;
	};
	plugin.remoteStateValidated = true;
	plugin.migrationBlockReason = "old remote migration";
	plugin.historicalBlockReason = null;
	plugin.authenticationBlockReason = null;
	plugin.encryptionBlockReason = null;
	plugin.blockingNotice = null;
	plugin.regularSyncStarted = true;
	plugin.syncEngine = {
		setExternalBlock: () => {},
		isSyncInProgress: () => false,
		hasPendingWork: () => false,
	};
	plugin.fileWatcher = { stop: () => {} };
	plugin.syncScheduler = { stop: () => {} };

	plugin.invalidateRemoteStateClassification();
	assert.equal(plugin.remoteStateValidated, false);
	assert.equal(plugin.migrationBlockReason, null);
	assert.notEqual(plugin.authenticationBlockReason, null);
	assert.equal(plugin.regularSyncStarted, false);
});

test("legacy plugin exposure requires a different OAuth token before Force", () => {
	const plugin = Object.create(YandexDiskSyncPlugin.prototype) as unknown as {
		app: {
			vault: {
				adapter: { getBasePath(): string };
				getName(): string;
			};
		};
		settings: typeof DEFAULT_SETTINGS;
		legacyExposureRemediationPending: boolean;
		legacyExposedTokenInSession: string | null;
		markLegacyExposureRemediationRequired(): void;
		updateLegacyExposureAfterTokenChange(tokenChanged: boolean): void;
	};
	plugin.app = {
		vault: {
			adapter: { getBasePath: () => "/test/vault" },
			getName: () => "vault",
		},
	};
	plugin.settings = {
		...DEFAULT_SETTINGS,
		yandexTokenSecret: "exposed-token-placeholder",
	};
	plugin.legacyExposureRemediationPending = false;
	plugin.legacyExposedTokenInSession = null;

	plugin.markLegacyExposureRemediationRequired();
	assert.equal(plugin.legacyExposureRemediationPending, true);

	plugin.updateLegacyExposureAfterTokenChange(false);
	assert.equal(plugin.legacyExposureRemediationPending, true);
	plugin.settings.yandexTokenSecret = "replacement-token-placeholder";
	plugin.updateLegacyExposureAfterTokenChange(true);
	assert.equal(plugin.legacyExposureRemediationPending, false);

	plugin.settings.yandexTokenSecret = "exposed-token-placeholder";
	plugin.updateLegacyExposureAfterTokenChange(true);
	assert.equal(plugin.legacyExposureRemediationPending, true);
});

test("scope settings stay unchanged while coordinator work is preparing or queued", async () => {
	const coordinator = new SyncCoordinator();
	let release = () => {};
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const operation = coordinator.run("full", async () => {}, {
		prepare: () => barrier,
	});
	const plugin = Object.create(
		YandexDiskSyncPlugin.prototype,
	) as YandexDiskSyncPlugin;
	plugin.settings = { ...DEFAULT_SETTINGS, remotePath: "original" };
	Object.assign(plugin, {
		syncEngine: { hasPendingWork: () => coordinator.hasPendingWork() },
	});
	await assert.rejects(plugin.applySettingsPatch({ remotePath: "changed" }));
	assert.equal(plugin.settings.remotePath, "original");
	release();
	await operation;
	assert.equal(plugin.isConfigurationBusy(), false);
});

test("encryption choice reserves admission before awaits and cancellation releases it", async () => {
	let release!: (choice: "cancel") => void;
	const choice = new Promise<"cancel">((resolve) => {
		release = resolve;
	});
	const plugin = Object.create(
		YandexDiskSyncPlugin.prototype,
	) as YandexDiskSyncPlugin;
	plugin.settings = { ...DEFAULT_SETTINGS, remotePath: "original" };
	Object.assign(plugin, {
		syncEngine: { hasPendingWork: () => false },
		confirmOperationBackup: () => choice,
		ensureStorageBinding: async () => true,
	});
	const operation = plugin.disableEncryption({ reuploadPlaintext: true });
	assert.equal(plugin.isForceSyncUnavailable(), true);
	await assert.rejects(plugin.applySettingsPatch({ remotePath: "other" }));
	await assert.rejects(plugin.rotateEncryptionPassword("synthetic"));
	assert.equal(plugin.settings.remotePath, "original");
	release("cancel");
	assert.deepEqual(await operation, { hadErrors: false });
	assert.equal(plugin.isConfigurationBusy(), false);
});
