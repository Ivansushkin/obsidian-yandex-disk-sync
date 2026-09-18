import assert from "node:assert/strict";
import test from "node:test";
import YandexDiskSyncPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/types";
import { captureLogicalVaultSnapshot } from "../src/backup/backup-snapshot";
import type { Stable1xPluginData } from "../src/compatibility/stable-1x";
import type { SyncResult } from "../src/types";
import type { SyncRunOptions } from "../src/sync/sync-engine";

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
	const plugin = Object.create(
		YandexDiskSyncPlugin.prototype,
	) as MainAccess;
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
		assert.deepEqual(registrations, ["prepare", "pause", "finalize", "resume"]);
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
		stableCutoverPending: boolean;
		indexManager: Record<string, (...args: unknown[]) => unknown>;
		syncEngine: Record<string, (...args: unknown[]) => unknown>;
		fileWatcher: Record<string, (...args: unknown[]) => unknown>;
		syncScheduler: Record<string, (...args: unknown[]) => unknown>;
		tryRecoverRemoteTargetTransition(): Promise<void>;
		ensureEncryptionReady(): Promise<boolean>;
		blockingNotice: null;
		regularSyncStarted: boolean;
	};
	plugin.settings = { ...DEFAULT_SETTINGS, yandexTokenSecret: "configured-placeholder" };
	plugin.remoteStateValidated = false;
	plugin.migrationBlockReason = null;
	plugin.historicalBlockReason = null;
	plugin.authenticationBlockReason = null;
	plugin.encryptionBlockReason = null;
	plugin.encryptionTransition = null;
	plugin.stableCutoverPending = false;
	plugin.blockingNotice = null;
	plugin.regularSyncStarted = false;
	plugin.syncEngine = {
		setExternalBlock: () => {},
		isSyncInProgress: () => false,
	};
	plugin.fileWatcher = { stop: () => {} };
	plugin.syncScheduler = { stop: () => {} };
	plugin.tryRecoverRemoteTargetTransition = async () => {};
	plugin.ensureEncryptionReady = async () => true;
	return plugin;
}

test("foreign device revalidates a stale legacy migration block", async () => {
	const plugin = createStartupPlugin();
	let canonicalReads = 0;
	plugin.remoteStateValidated = true;
	plugin.migrationBlockReason = "legacy migration required";
	plugin.indexManager = {
		downloadEncryptionManifest: async () => null,
		inspectRemoteCanonicalFormat: async () => { canonicalReads++; return "current"; },
	};
	assert.equal(await plugin.refreshRemoteStartupState(false), "ready");
	assert.equal(canonicalReads, 1);
	assert.equal(plugin.migrationBlockReason, null);
});

test("encrypted current local state cannot Force a plaintext stable migration", async () => {
	const plugin = createStartupPlugin();
	Object.assign(plugin.settings, {
		enableEncryption: true, encryptionSalt: "current-salt",
		encryptionPassword: "password-placeholder", encryptionRevision: 1,
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

test("foreign current canonical requires verified local backup before stable cutover", async () => {
	const plugin = Object.create(YandexDiskSyncPlugin.prototype) as unknown as {
		refreshRemoteStartupState(prompt: boolean): Promise<string>;
		completeStableCurrentAdoption(): Promise<boolean>;
		settings: typeof DEFAULT_SETTINGS;
		remoteStateValidated: boolean;
		migrationBlockReason: string | null;
		historicalBlockReason: string | null;
		authenticationBlockReason: string | null;
		encryptionBlockReason: string | null;
		encryptionTransition: null;
		stableCutoverPending: boolean;
		stablePluginDataSnapshot: Stable1xPluginData;
		pluginDataPersistenceTail: Promise<void>;
		pluginDataLoaded: boolean;
		pluginDataLoadGeneration: number;
		indexManager: Record<string, (...args: unknown[]) => unknown>;
		backupManager: Record<string, (...args: unknown[]) => unknown>;
		vaultAdapter: Record<string, (...args: unknown[]) => unknown>;
		syncEngine: Record<string, (...args: unknown[]) => unknown>;
		fileWatcher: Record<string, (...args: unknown[]) => unknown>;
		syncScheduler: Record<string, (...args: unknown[]) => unknown>;
		tryRecoverRemoteTargetTransition(): Promise<void>;
		ensureEncryptionReady(): Promise<boolean>;
		buildPluginData(): Record<string, unknown>;
		saveData(data: unknown): Promise<void>;
		blockingNotice: null;
		regularSyncStarted: boolean;
	};
	const bytes = new TextEncoder().encode("stable-local").buffer;
	const snapshot = await captureLogicalVaultSnapshot({
		getAllSyncableFiles: () => [{ path: "note.md" }],
		readFile: async () => bytes,
	} as never);
	const stableSnapshot = {
		settings: {
			...DEFAULT_SETTINGS,
			deviceId: "stable-device",
		},
		localIndex: null,
		lastSyncStats: { uploaded: 0, downloaded: 0, deleted: 0, errors: 0 },
	} satisfies Stable1xPluginData;
	let saved: unknown = null;
	let canonicalReads = 0;
	let recoveryRuns = 0;
	plugin.settings = { ...DEFAULT_SETTINGS, yandexTokenSecret: "configured" };
	plugin.remoteStateValidated = false;
	plugin.migrationBlockReason = null;
	plugin.historicalBlockReason = null;
	plugin.authenticationBlockReason = null;
	plugin.encryptionBlockReason = null;
	plugin.encryptionTransition = null;
	plugin.stableCutoverPending = true;
	plugin.stablePluginDataSnapshot = stableSnapshot;
	plugin.pluginDataPersistenceTail = Promise.resolve();
	plugin.pluginDataLoaded = true;
	plugin.pluginDataLoadGeneration = 0;
	plugin.blockingNotice = null;
	plugin.regularSyncStarted = false;
	plugin.indexManager = {
		downloadEncryptionManifest: async () => null,
		inspectRemoteCanonicalFormat: async () => "current",
		captureForceCanonicalProof: async () => {
			canonicalReads++;
			return { state: "present", rawSha256: "canonical-sha" };
		},
	};
	plugin.backupManager = {
		createBackup: async () => ({
			success: true,
			backupName: "verified.zip",
			sha256: "backup-sha",
			snapshotDigest: snapshot.digest,
		}),
	};
	plugin.vaultAdapter = {
		getAllSyncableFiles: () => [{ path: "note.md" }],
		readFile: async () => bytes,
	};
	plugin.syncEngine = {
		setExternalBlock: () => {},
		isSyncInProgress: () => false,
	};
	plugin.fileWatcher = { stop: () => {} };
	plugin.syncScheduler = { stop: () => {} };
	plugin.tryRecoverRemoteTargetTransition = async () => {
		recoveryRuns++;
	};
	plugin.ensureEncryptionReady = async () => true;
	plugin.buildPluginData = () => ({ format: "plugin-data" });
	plugin.saveData = async (data) => {
		saved = data;
	};

	assert.equal(await plugin.refreshRemoteStartupState(false), "adoption");
	assert.equal(plugin.stableCutoverPending, true);
	assert.equal(saved, null);
	assert.equal(recoveryRuns, 0);
	assert.equal(await plugin.completeStableCurrentAdoption(), true);
	assert.equal(plugin.stableCutoverPending, false);
	assert.deepEqual(saved, { format: "plugin-data" });
	assert.equal(canonicalReads, 2);
});

test("queued stable persistence cannot cross the verified cutover boundary", async () => {
	const plugin = Object.create(YandexDiskSyncPlugin.prototype) as unknown as {
		persistPluginData(): Promise<void>;
		completeStableLocalCutover(): Promise<void>;
		settings: typeof DEFAULT_SETTINGS;
		stableCutoverPending: boolean;
		stablePluginDataSnapshot: Stable1xPluginData;
		pluginDataPersistenceTail: Promise<void>;
		pluginDataLoaded: boolean;
		pluginDataLoadGeneration: number;
		loadedPluginData: unknown;
		buildPluginData(): Record<string, unknown>;
		saveData(data: unknown): Promise<void>;
	};
	const stableSnapshot = {
		settings: {
			...DEFAULT_SETTINGS,
			deviceId: "stable-device",
		},
		localIndex: null,
		lastSyncStats: { uploaded: 0, downloaded: 0, deleted: 0, errors: 0 },
	} satisfies Stable1xPluginData;
	let releaseTail = () => {};
	plugin.pluginDataLoaded = true;
	plugin.pluginDataLoadGeneration = 0;
	plugin.pluginDataPersistenceTail = new Promise<void>((resolve) => {
		releaseTail = resolve;
	});
	plugin.settings = { ...DEFAULT_SETTINGS, deviceId: "current-device" };
	plugin.stableCutoverPending = true;
	plugin.stablePluginDataSnapshot = stableSnapshot;
	plugin.loadedPluginData = null;
	plugin.buildPluginData = () => ({ format: "plugin-data" });
	const formats: string[] = [];
	plugin.saveData = async (data) => {
		formats.push(
			typeof data === "object" && data !== null && "format" in data
				? String((data as { format: unknown }).format)
				: "stable-1x",
		);
	};

	const legacySave = plugin.persistPluginData();
	const cutover = plugin.completeStableLocalCutover();
	releaseTail();
	await Promise.all([legacySave, cutover]);
	assert.deepEqual(formats, ["stable-1x", "plugin-data"]);
	assert.equal(plugin.stableCutoverPending, false);
});

test("post-commit Force failure resumes cleanup without repeating migration", async () => {
	const plugin = Object.create(YandexDiskSyncPlugin.prototype) as unknown as {
		getForceSyncController(): import("../src/sync/force-sync-controller").ForceSyncController;
		prepareForceSync(): Promise<unknown>;
		confirmForceSync(): Promise<boolean>;
		recheckLegacyMigrationSafety(): Promise<boolean>;
		ensureEncryptionReady(): Promise<boolean>;
		completeStableLocalCutover(): Promise<void>;
		renderForceProgress(): void;
		updateLastSyncStats(): void;
		persistPluginData(): Promise<void>;
		setMigrationBlock(reason: string | null): void;
		runFullSync(options: SyncRunOptions, notice: boolean, owned: boolean): Promise<SyncResult>;
		remoteStateValidated: boolean;
		indexManager: Record<string, (...args: unknown[]) => unknown>;
		syncEngine: { isSyncInProgress(): boolean; forceSyncFromLocal(options: SyncRunOptions): Promise<SyncResult> };
		backupManager: { createRemoteSnapshotBackup(): Promise<unknown> };
		fileWatcher: { start(): void };
		syncScheduler: { start(): void };
	};
	let cleanupStarts = 0;
	let migrationReason: string | null = "migration required";
	plugin.remoteStateValidated = true;
	plugin.prepareForceSync = async () => ({ canonical: { state: "absent" }, migration: true });
	plugin.indexManager = { getPendingPhysicalActions: () => [], getMaintenance: () => undefined };
	plugin.confirmForceSync = async () => true;
	plugin.backupManager = { createRemoteSnapshotBackup: async () => ({
		success: true, backupName: "verified.zip", sha256: "backup-sha",
		snapshotDigest: "snapshot-sha", fileCount: 1, totalSize: 10,
	}) };
	plugin.recheckLegacyMigrationSafety = async () => true;
	plugin.ensureEncryptionReady = async () => true;
	plugin.completeStableLocalCutover = async () => {};
	plugin.renderForceProgress = () => {};
	plugin.updateLastSyncStats = () => {};
	plugin.persistPluginData = async () => {};
	plugin.setMigrationBlock = (reason) => { migrationReason = reason; };
	const result: SyncResult = {
		success: false, replacementCommitted: true, uploaded: 1, downloaded: 0,
		deleted: 0, conflicts: 0, startTime: 1, endTime: 2,
		errors: [{ path: "old.md", operation: "delete_remote", message: "cleanup interrupted" }],
	};
	plugin.syncEngine = {
		isSyncInProgress: () => false,
		forceSyncFromLocal: async (options) => {
			await options.beforeForceMutation?.();
			return result;
		},
	};
	plugin.runFullSync = async (options, notice, owned) => {
		assert.equal(notice, false); assert.equal(owned, true);
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
	assert.equal(plugin.getForceSyncController().getState()?.outcome, "success");
});

test("manual full preflight prevents Force from stealing foreground operation ownership", async () => {
	let release = () => {};
	const pending = new Promise<void>((done) => { release = done; });
	const plugin = Object.create(YandexDiskSyncPlugin.prototype) as unknown as {
		settings: typeof DEFAULT_SETTINGS;
		syncEngine: { isSyncInProgress(): boolean };
		restoreLocalStateOnce(): void;
		registerSyncLifecycleOnce(): void;
		refreshRemoteStartupState(): Promise<string>;
		prepareForceSync(): Promise<never>;
		runFullSync(): Promise<SyncResult | null>;
		runForceSyncFromLocal(): Promise<void>;
		isForceSyncUnavailable(): boolean;
	};
	plugin.settings = { ...DEFAULT_SETTINGS, yandexTokenSecret: "configured" };
	plugin.syncEngine = { isSyncInProgress: () => false };
	plugin.restoreLocalStateOnce = () => {};
	plugin.registerSyncLifecycleOnce = () => {};
	plugin.refreshRemoteStartupState = async () => { await pending; return "blocked"; };
	plugin.prepareForceSync = async () => { throw new Error("Force must not start"); };
	const full = plugin.runFullSync();
	assert.equal(plugin.isForceSyncUnavailable(), true);
	await plugin.runForceSyncFromLocal();
	release(); await full;
	assert.equal(plugin.isForceSyncUnavailable(), false);
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
		syncEngine: { runExclusiveMaintenance(task: () => Promise<void>): Promise<void> };
	};
	let authenticated = 0;
	let maintenance = 0;
	plugin.isForceSyncBusy = () => true;
	plugin.connectToRemoteEncryptionNow = async () => { authenticated++; };
	plugin.syncEngine = { runExclusiveMaintenance: async (task) => { maintenance++; await task(); } };
	await assert.rejects(plugin.connectToRemoteEncryption("test-password"), /already in progress/);
	await assert.rejects(plugin.enableEncryption("test-password"), /already in progress/);
	await assert.rejects(plugin.rotateEncryptionPassword("test-password"), /already in progress/);
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
