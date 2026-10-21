import { NetworkRequestError, type FailureSummary } from "../src/errors";
import type { App } from "obsidian";
import { SyncCoordinator } from "../src/sync/coordinator";
import assert from "node:assert/strict";
import test from "node:test";
import { lifecyclePlugin } from "./helpers/lifecycle-fixtures";
import { DEFAULT_SETTINGS } from "../src/types";
import type { SyncResult } from "../src/types";
import type { SyncRunOptions } from "../src/sync/engine";
import { YandexApiError } from "../src/api/yandex-client";
import { StorageScopeError } from "../src/sync/local/storage-scope";

function createBlockedLifecycleHarness(
	classification: "migration" | "blocked",
) {
	const plugin = lifecyclePlugin();
	const registrations: string[] = [];
	const restores: string[] = [];
	plugin["localStateRestored"] = false;
	plugin["syncLifecycleRegistered"] = false;
	Object.assign(plugin, {
		loadedPluginData: {
			localState: null,
			pendingMutations: [],
			pendingPhysicalActions: [],
			pendingWatcherEvents: [],
			lastSyncStats: {
				uploaded: 0,
				downloaded: 0,
				deleted: 0,
				errors: 0,
			},
		},
		indexManager: {
			loadPendingMutations: () => restores.push("mutations"),
			loadPendingPhysicalActions: () => restores.push("actions"),
		},
		fileWatcher: {
			loadDeferredEvents: () => restores.push("watcher"),
			prepareForSync: async () => {},
			pauseForSync: async () => {},
			settleAfterReconciliation: async () => {},
			resumeAfterSync: async () => {},
			start: () => restores.push("watcher-start"),
		},
		syncScheduler: {
			start: () => restores.push("scheduler-start"),
		},
		syncEngine: {
			hasPendingWork: () => false,
			onSyncPrepare: () => registrations.push("prepare"),
			onSyncPause: () => registrations.push("pause"),
			onSyncFinalize: () => registrations.push("finalize"),
			onSyncResume: () => registrations.push("resume"),
			resume: () => restores.push("engine-resume"),
		},
	});
	plugin["refreshRemoteStartupState"] = async () => classification;
	return { plugin, registrations, restores };
}

test("missing or replaced token does not skip lifecycle initialization", async () => {
	for (const classification of ["blocked", "migration"] as const) {
		const { plugin, registrations, restores } =
			createBlockedLifecycleHarness(classification);
		await plugin["onLayoutReady"]();
		await plugin["onLayoutReady"]();
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
	assert.equal(await plugin["resumeSyncIfReady"](), false);
	assert.deepEqual(restores, []);
});

/** Isolate startup classification from unrelated UI and lifecycle setup. */
function createStartupPlugin() {
	const plugin = lifecyclePlugin();
	plugin.settings = {
		...DEFAULT_SETTINGS,
		yandexTokenSecret: "configured-placeholder",
	};
	plugin["remoteStateValidated"] = false;
	plugin["migrationBlockReason"] = null;
	plugin["historicalBlockReason"] = null;
	plugin["authenticationBlockReason"] = null;
	plugin["encryptionBlockReason"] = null;
	plugin["encryptionTransition"] = null;
	plugin["blockingNotice"] = null;
	plugin["regularSyncStarted"] = false;
	Object.assign(plugin, {
		syncEngine: {
			setExternalBlock: () => {},
			isSyncInProgress: () => false,
			hasPendingWork: () => false,
		},
		fileWatcher: { stop: () => {} },
	});
	Object.assign(plugin, { syncScheduler: { stop: () => {} } });
	plugin["tryRecoverRemoteTargetTransition"] = async () => false;
	plugin["ensureEncryptionReady"] = async () => true;
	Object.assign(plugin, { storageBinding: { ensure: async () => true } });
	return plugin;
}

test("storage admission classifies startup failures and recovers after connection repair", async () => {
	for (const error of [
		new YandexApiError("synthetic unauthorized", 401),
		new YandexApiError("synthetic forbidden", 403),
		new NetworkRequestError(new Error("synthetic offline")),
		new Error("synthetic unknown"),
		new StorageScopeError("synthetic root mismatch"),
		null,
	]) {
		const plugin = createStartupPlugin();
		const blocks = new Map<string, string>();
		let summary: FailureSummary | undefined;
		plugin["syncEngine"].setExternalBlock = (
			kind: unknown,
			reason: unknown,
			failure?: unknown,
		) => {
			if (reason) {
				summary = failure as FailureSummary | undefined;
			}
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
		Object.assign(plugin, {
			indexManager: {
				downloadEncryptionManifest: async () => {
					remoteReads++;
					return null;
				},
				inspectRemoteCanonicalFormat: async () => "current",
			},
		});
		assert.equal(
			await plugin["refreshRemoteStartupState"](false),
			"blocked",
		);
		assert.equal(remoteReads, 0);
		const scopeFailure =
			error === null || error instanceof StorageScopeError;
		assert.equal(blocks.has("local-state"), scopeFailure);
		assert.equal(
			plugin["authenticationBlockReason"] !== null,
			!scopeFailure,
		);
		if (error) {
			assert.equal(
				summary?.category,
				error instanceof YandexApiError
					? "access"
					: error instanceof NetworkRequestError
						? "unavailable"
						: error instanceof StorageScopeError
							? "safety"
							: "unknown",
			);
			assert.equal(
				summary?.stage,
				scopeFailure ? "storage-admission" : "startup",
			);
		}
		repaired = true;
		assert.equal(await plugin["refreshRemoteStartupState"](false), "ready");
		assert.equal(blocks.size, 0);
		assert.equal(plugin["authenticationBlockReason"], null);
	}
});

test("foreign device revalidates a stale legacy migration block", async () => {
	const plugin = createStartupPlugin();
	let canonicalReads = 0;
	plugin["remoteStateValidated"] = true;
	plugin["migrationBlockReason"] = "legacy migration required";
	Object.assign(plugin, {
		indexManager: {
			downloadEncryptionManifest: async () => null,
			inspectRemoteCanonicalFormat: async () => {
				canonicalReads++;
				return "current";
			},
		},
	});
	assert.equal(await plugin["refreshRemoteStartupState"](false), "ready");
	assert.equal(canonicalReads, 1);
	assert.equal(plugin["migrationBlockReason"], null);
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
	Object.assign(plugin, {
		indexManager: {
			downloadEncryptionManifest: async () => null,
			inspectRemoteCanonicalFormat: async () => "legacy",
		},
	});
	assert.equal(await plugin["refreshRemoteStartupState"](false), "blocked");
	assert.equal(plugin["migrationBlockReason"], null);
	assert.notEqual(plugin["historicalBlockReason"], null);
});

test("post-commit Force failure resumes cleanup without repeating migration", async () => {
	const plugin = lifecyclePlugin();
	let cleanupStarts = 0;
	let migrationReason: string | null = "migration required";
	plugin["remoteStateValidated"] = true;
	plugin["prepareForceSync"] = async () => ({
		canonical: { state: "absent" },
		migration: true,
	});
	Object.assign(plugin, {
		indexManager: {
			getPendingPhysicalActions: () => [],
			getMaintenance: () => undefined,
		},
	});
	plugin["confirmForceSync"] = async () => "with-backup";
	Object.assign(plugin, {
		backupManager: {
			createRemoteSnapshotBackup: async () => ({
				success: true,
				backupName: "verified.zip",
				sha256: "backup-sha",
				snapshotDigest: "snapshot-sha",
				fileCount: 1,
				totalSize: 10,
			}),
		},
	});
	plugin["recheckLegacyMigrationSafety"] = async () => true;
	plugin["ensureEncryptionReady"] = async () => true;
	plugin["captureForceSnapshot"] = async () => "snapshot-sha";
	plugin["renderForceProgress"] = () => {};
	plugin["updateLastSyncStats"] = () => {};
	plugin["persistPluginData"] = async () => {};
	plugin["setMigrationBlock"] = (reason) => {
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
	Object.assign(plugin, {
		syncEngine: {
			isSyncInProgress: () => false,
			hasPendingWork: () => false,
			isSyncPaused: () => false,
			forceSyncFromLocal: async (options: SyncRunOptions) => {
				await options.beforeForceMutation?.();
				return result;
			},
		},
	});
	plugin.runFullSync = async (options, notice, owned) => {
		assert.equal(notice, false);
		assert.equal(owned, true);
		assert.equal(typeof options?.onActivity, "function");
		cleanupStarts++;
		return { ...result, success: true, errors: [] };
	};
	Object.assign(plugin, { fileWatcher: { start() {} } });
	Object.assign(plugin, { syncScheduler: { start() {} } });
	await plugin["getForceSyncController"]().run("from_local");
	assert.equal(migrationReason, null);
	assert.equal(plugin["remoteStateValidated"], false);
	assert.equal(cleanupStarts, 1);
	assert.equal(
		plugin["getForceSyncController"]().getState()?.outcome,
		"success",
	);
});

test("full preflight prevents Force from stealing foreground operation ownership", async () => {
	for (const visible of [true, false]) {
		let release = () => {};
		const pending = new Promise<void>((done) => {
			release = done;
		});
		const plugin = lifecyclePlugin();
		plugin.settings = {
			...DEFAULT_SETTINGS,
			yandexTokenSecret: "configured",
		};
		Object.assign(plugin, {
			syncEngine: {
				isSyncInProgress: () => false,
				hasPendingWork: () => false,
			},
		});
		plugin["restoreLocalStateOnce"] = () => {};
		plugin["registerSyncLifecycleOnce"] = () => {};
		plugin["refreshRemoteStartupState"] = async () => {
			await pending;
			return "blocked";
		};
		plugin["prepareForceSync"] = async () => {
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
	const plugin = lifecyclePlugin();
	let authenticated = 0;
	let maintenance = 0;
	plugin.isForceSyncBusy = () => true;
	plugin["connectToRemoteEncryptionNow"] = async () => {
		authenticated++;
	};
	Object.assign(plugin, {
		syncEngine: {
			runExclusiveMaintenance: async (task: () => Promise<void>) => {
				maintenance++;
				await task();
			},
		},
	});
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
	await plugin["connectToRemoteEncryptionForSync"]("test-password");
	assert.equal(authenticated, 1);
	assert.equal(maintenance, 1);
});

test("legacy plugin exposure requires a different OAuth token before Force", () => {
	const plugin = lifecyclePlugin();
	plugin.app = {
		vault: {
			adapter: { getBasePath: () => "/test/vault" },
			getName: () => "vault",
		},
	} as unknown as App;
	plugin.settings = {
		...DEFAULT_SETTINGS,
		yandexTokenSecret: "exposed-token-placeholder",
	};
	plugin["legacyExposureRemediationPending"] = false;
	plugin["legacyExposedTokenInSession"] = null;

	plugin["markLegacyExposureRemediationRequired"]();
	assert.equal(plugin["legacyExposureRemediationPending"], true);

	plugin["updateLegacyExposureAfterTokenChange"](false);
	assert.equal(plugin["legacyExposureRemediationPending"], true);
	plugin.settings.yandexTokenSecret = "replacement-token-placeholder";
	plugin["updateLegacyExposureAfterTokenChange"](true);
	assert.equal(plugin["legacyExposureRemediationPending"], false);

	plugin.settings.yandexTokenSecret = "exposed-token-placeholder";
	plugin["updateLegacyExposureAfterTokenChange"](true);
	assert.equal(plugin["legacyExposureRemediationPending"], true);
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
	const plugin = lifecyclePlugin();
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
	const plugin = lifecyclePlugin();
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
