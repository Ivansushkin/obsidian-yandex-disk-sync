import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { persistenceHarness } from "./helpers/lifecycle-fixtures";
import { MemoryDisk, bytes, device } from "./helpers/sync-flow";
import { deferred } from "./helpers/deferred";
import { afterTest } from "./helpers/test-context";
import { encryptionFlow } from "./helpers/encryption-flow";
import { transition } from "./helpers/encryption-scenarios";
import { SyncScheduler } from "../src/sync/scheduler";

/** Combine real settings publication and sync algorithms over synthetic storage. */
async function settingsHost(t: TestContext, encrypted = false) {
	const disk = new MemoryDisk();
	const a = device(disk, "settings-device", null);
	a.vault.put("note.md", bytes("unchanged"));
	await a.full();
	const flow = encryptionFlow(a);
	if (encrypted) {
		await transition(a, flow, "enable", "synthetic-password");
	}
	const { plugin, persistence } = persistenceHarness();
	await plugin.loadSettings();
	plugin.settings = { ...a.settings, yandexTokenSecret: "synthetic" };
	const scheduler = new SyncScheduler(a.engine, plugin.settings);
	Object.assign(plugin, {
		app: { ...plugin.app, workspace: { layoutReady: true } },
		yandexClient: a.client,
		vaultAdapter: a.adapter,
		indexManager: a.index,
		syncEngine: a.engine,
		fileWatcher: a.watcher,
		syncScheduler: scheduler,
		encryptionWorkflow: flow.workflow,
		storageBinding: {
			ensure: async () => {
				await a.index.assertRemoteScope();
				return true;
			},
		},
		configuredToken: "synthetic",
		configuredRemotePath: "vault",
		localStateRestored: true,
		syncLifecycleRegistered: true,
		automationReady: true,
		regularSyncStarted: true,
	});
	plugin["remoteStateValidated"] = true;
	a.watcher.start();
	scheduler.start();
	afterTest(t, async () => {
		disk.beforeRequest = undefined;
		scheduler.stop();
		await a.stop();
	});
	const update = plugin.applySettingsPatch.bind(plugin);
	return { plugin, persistence, a, disk, scheduler, update };
}

test("runtime settings preserve admitted storage and durable state without remote reclassification", async (t) => {
	for (const encrypted of [false, true]) {
		const { plugin, a, disk, scheduler, update } = await settingsHost(
			t,
			encrypted,
		);
		const remote = structuredClone(disk.files);
		const local = a.index.captureLocalCausalState();
		const timer = scheduler["intervalId"];
		disk.beforeRequest = async () => {
			throw new Error("Unexpected remote check for runtime settings");
		};
		for (const patch of [
			{ maxConcurrency: 7 },
			{ debounceDelay: 4000 },
			{ clientId: "new-client" },
		]) {
			await update(patch);
			assert.equal(plugin["remoteStateValidated"], true);
			assert.equal(plugin["authenticationBlockReason"], null);
			assert.equal(a.watcher["isEnabled"], true);
			assert.equal(scheduler["intervalId"], timer);
			assert.equal(a.engine.getState().status, "idle");
		}

		assert.equal(plugin.settings.maxConcurrency, 7);
		assert.deepEqual(disk.files, remote);
		assert.deepEqual(a.index.captureLocalCausalState(), local);
		disk.beforeRequest = undefined;
		const entered = deferred();
		const release = deferred();
		disk.beforeRequest = async () => {
			entered.resolve();
			await release.promise;
		};
		const syncing = a.full();
		await entered.promise;
		try {
			assert.equal(plugin.isConfigurationBusy(), true);
			await update({ enableDebugLogging: true });
			assert.equal(scheduler["intervalId"], timer);
		} finally {
			disk.beforeRequest = undefined;
			release.resolve();
		}
		await syncing;
		assert.equal(plugin.settings.enableDebugLogging, true);
		plugin["setHistoricalBlock"]("synthetic existing block");
		await update({ maxConcurrency: 8 });
		assert.equal(
			plugin["historicalBlockReason"],
			"synthetic existing block",
		);
		assert.equal(a.watcher["isEnabled"], false);
		assert.equal(scheduler["isRunning"], false);
	}
});

test("realtime settings retain queued events across disable and restart without stopping the scheduler", async (t) => {
	const { a, scheduler, disk, update } = await settingsHost(t);
	await update({ debounceDelay: 10000 });
	a.vault.put("note.md", bytes("offline edit"));
	a.watcher["scheduleSync"]("note.md", "upload");
	await a.watcher.waitForPendingPersistence();
	const events = a.watcher.getDeferredEvents();
	const timer = scheduler["intervalId"];
	await update({ enableRealtimeSync: false });
	assert.equal(a.watcher["isEnabled"], false);
	assert.equal(scheduler["intervalId"], timer);
	assert.deepEqual(a.watcher.getDeferredEvents(), events);
	const saved = await a.saved();
	const restarted = device(disk, "settings-device", null, a.vault, saved);
	afterTest(t, () => restarted.stop());
	restarted.start();
	await new Promise((resolve) => setTimeout(resolve, 150));
	await restarted.watcher.waitForPendingPersistence();
	assert.deepEqual(disk.files.get("vault/note.md"), bytes("offline edit"));
	await restarted.full();
	await restarted.assertSettled({ "note.md": "offline edit" });
});

test("scheduler reconfiguration disables zero intervals and ignores retired timer callbacks", async (t) => {
	const { scheduler, a, update } = await settingsHost(t);
	const originalSet = globalThis.setInterval;
	const originalClear = globalThis.clearInterval;
	const callbacks: (() => void)[] = [];
	const active = new Set<number>();
	afterTest(t, () => {
		scheduler.stop();
		Object.assign(globalThis, {
			setInterval: originalSet,
			clearInterval: originalClear,
		});
	});
	scheduler.stop();
	Object.assign(globalThis, {
		setInterval: (callback: () => void) => {
			callbacks.push(callback);
			active.add(callbacks.length);
			return callbacks.length;
		},
		clearInterval: (id: number) => {
			active.delete(id);
		},
	});
	scheduler.start();
	await update({ syncInterval: 0 });
	assert.equal(active.size, 0);
	callbacks[0]!();
	assert.equal(a.engine.hasPendingWork(), false);
	await update({ syncInterval: 2 });
	assert.equal(active.size, 1);
	const current = scheduler["intervalId"];
	await update({ syncInterval: 2 });
	assert.equal(scheduler["intervalId"], current);
	callbacks[0]!();
	assert.equal(a.engine.hasPendingWork(), false);
	assert.equal(a.watcher["isEnabled"], true);
});

test("local save failures retain their cause until explicit persistence repair and reconciliation", async (t) => {
	const { plugin, a, persistence, scheduler, update } = await settingsHost(t);
	const previous = plugin.settings;
	const save = plugin.saveData.bind(plugin);
	plugin.saveData = async () => {
		throw new Error("synthetic disk unavailable");
	};
	await assert.rejects(
		update({ enableDebugLogging: true }),
		/disk unavailable/,
	);
	assert.equal(plugin.settings, previous);
	assert.equal(persistence.failed, true);
	assert.equal(a.engine.getState().failure?.code, "local-persistence");
	assert.equal(a.engine.getState().failure?.category, "local");
	assert.match(a.engine.getState().failure!.message, /disk unavailable/);
	assert.equal(plugin["authenticationBlockReason"], null);
	assert.equal(await plugin["refreshRemoteStartupState"](false), "blocked");
	assert.equal(a.engine.getState().failure?.code, "local-persistence");
	plugin.saveData = save;
	Object.assign(plugin, { storageBinding: { ensure: async () => true } });
	await update({ enableDebugLogging: false });
	assert.equal(persistence.failed, false);
	assert.equal(a.engine.getState().failure, undefined);
	assert.equal(a.watcher["isEnabled"], true);
	assert.equal(scheduler["isRunning"], true);
	await a.assertSettled({ "note.md": "unchanged" });
	a.watcher.setPersistCallback(() => plugin.saveSettings());
	plugin.saveData = async () => {
		throw new Error("synthetic watcher save failure");
	};
	a.watcher["scheduleSync"]("note.md", "upload");
	await assert.rejects(
		a.watcher.waitForPendingPersistence(),
		/watcher save failure/,
	);
	const pending = a.watcher.getDeferredEvents();
	plugin.saveData = save;
	await update({ maxConcurrency: plugin.settings.maxConcurrency });
	assert.equal(persistence.failed, false);
	assert.equal(plugin["authenticationBlockReason"], null);
	assert.equal(a.engine.getState().failure, undefined);
	assert.ok(pending.length > 0);
	await a.assertSettled({ "note.md": "unchanged" });
});

test("settings drain errors preserve the rejected draft and allow a normal full retry", async (t) => {
	const { plugin, a, disk, update } = await settingsHost(t);
	const previous = plugin.settings;
	const remote = structuredClone(disk.files);
	const wait = a.watcher.waitForPendingPersistence.bind(a.watcher);
	const failure = new Error("synthetic watcher drain failure");
	a.watcher.waitForPendingPersistence = async () => {
		throw failure;
	};
	await assert.rejects(
		update({ yandexTokenSecret: "synthetic-replacement" }),
		(error) => error === failure,
	);
	assert.equal(plugin.settings, previous);
	assert.equal(plugin["authenticationBlockReason"], null);
	assert.equal(plugin["blockingNotice"]?.code, "settings-update");
	assert.deepEqual(disk.files, remote);
	a.watcher.waitForPendingPersistence = wait;
	assert.equal((await plugin.runFullSync(undefined, false))?.success, true);
	assert.equal(plugin["blockingNotice"], null);
	const failures: string[] = [];
	const unsubscribe = a.engine.onStateChange((state) => {
		if (state.status === "error") {
			failures.push(state.errorMessage ?? "");
		}
	});
	afterTest(t, unsubscribe);
	await update({ yandexTokenSecret: "synthetic-replacement" });
	assert.deepEqual(failures, []);
	assert.equal(plugin["remoteStateValidated"], true);
	assert.equal(plugin["blockingNotice"], null);
	assert.equal(a.watcher["isEnabled"], true);
});

test("unload rejects a late settings publication without recreating notices or automation", async (t) => {
	const { promise: gate, resolve: release } = deferred();
	const { promise: waiting, resolve: entered } = deferred();
	afterTest(t, release);
	const { plugin, a, persistence, scheduler, update } = await settingsHost(t);
	const previous = plugin.settings;
	plugin.saveData = async () => {
		entered();
		await gate;
	};
	const rejected = assert.rejects(update({ maxConcurrency: 7 }), /unloaded/);
	await waiting;
	plugin.onunload();
	release();
	await rejected;
	await persistence.idle();
	assert.equal(plugin.settings, previous);
	assert.equal(plugin["blockingNotice"], null);
	assert.equal(a.watcher["isEnabled"], false);
	assert.equal(scheduler["isRunning"], false);
});

test("a settings save queued before an internal failure still completes persistence recovery", async (t) => {
	const { promise: gate, resolve: release } = deferred();
	const { promise: waiting, resolve: entered } = deferred();
	afterTest(t, release);
	const { plugin, a, persistence, scheduler, update } = await settingsHost(t);
	const save = plugin.saveData.bind(plugin);
	let attempts = 0;
	plugin.saveData = async (value) => {
		attempts++;
		if (attempts === 1) {
			entered();
			await gate;
			throw new Error("synthetic queued internal save failure");
		}
		await save(value);
	};
	const internal = assert.rejects(
		plugin.saveSettings(),
		/queued internal save failure/,
	);
	await waiting;
	const accepted = update({ enableDebugLogging: true });
	release();
	await internal;
	await accepted;
	assert.equal(persistence.failed, false);
	assert.equal(a.engine["externalBlocks"].has("persistence"), false);
	assert.equal(a.watcher["isEnabled"], true);
	assert.equal(scheduler["isRunning"], true);
	const saved = attempts;
	await update({ maxConcurrency: plugin.settings.maxConcurrency });
	assert.equal(attempts, saved);
	await a.assertSettled({ "note.md": "unchanged" });
});
