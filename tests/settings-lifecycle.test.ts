import assert from "node:assert/strict";
import { getActiveLanguage, setLanguagePreference } from "../src/i18n";
import type { UserSettingsPatch } from "../src/settings-workflow";
import type { PluginData } from "../src/plugin-persistence";
import test, { type TestContext } from "node:test";
import { persistenceHarness } from "./helpers/lifecycle-fixtures";
import { MemoryDisk, bytes, device } from "./helpers/sync-flow";
import { deferred } from "./helpers/deferred";
import { afterTest } from "./helpers/test-context";
import { encryptionFlow, startupFlow } from "./helpers/encryption-flow";
import { transition } from "./helpers/encryption-scenarios";
import { SyncScheduler } from "../src/sync/scheduler";

/** Combine real settings publication and sync algorithms over synthetic storage. */
async function settingsHost(
	t: TestContext,
	encrypted = false,
	remote?: MemoryDisk,
) {
	const disk = remote ?? new MemoryDisk();
	const a = device(disk, "settings-device", null);
	if (!remote) {
		a.vault.put("note.md", bytes("unchanged"));
		await a.full();
	}
	const flow = encryptionFlow(a);
	if (encrypted) {
		await transition(a, flow, "enable", "synthetic-password");
	}
	const { plugin, persistence } = persistenceHarness();
	await plugin.loadSettings();
	plugin.settings = {
		...a.settings,
		yandexTokenSecret: remote ? "" : "synthetic",
	};
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
		configuredToken: remote ? "" : "synthetic",
		configuredRemotePath: "vault",
		localStateRestored: true,
		syncLifecycleRegistered: true,
		automationReady: !remote,
		regularSyncStarted: !remote,
	});
	plugin["remoteStateValidated"] = !remote;
	if (!remote) {
		a.watcher.start();
		scheduler.start();
	}
	afterTest(t, async () => {
		disk.beforeRequest = undefined;
		scheduler.stop();
		await a.stop();
	});
	const update = plugin.applySettingsPatch.bind(plugin);
	return { plugin, persistence, a, disk, scheduler, update, flow };
}

test(
	"host activity opens a rotated password after full settlement and revokes an open prompt on save failure",
	{ timeout: 10_000 },
	async (t) => {
		const { plugin, a, disk, flow, persistence, scheduler } =
			await settingsHost(t, true);
		const source = device(disk, "rotating-source", null);
		afterTest(t, () => source.stop());
		const remote = encryptionFlow(source);
		await remote.workflow.connectForSync("synthetic-password");
		await source.full();
		flow.context.getSettings = () => plugin.settings;
		flow.context.persist = () => plugin.saveSettings();
		flow.context.ui.setBlock = (reason, notice) =>
			plugin["setEncryptionBlock"](reason, notice);
		const install = flow.context.setService.bind(flow.context);
		flow.context.setService = (service) => {
			install(service);
			plugin["encryptionService"] = service;
		};
		startupFlow(a, flow);
		afterTest(t, plugin["bindAutomaticPasswordRequests"]());
		let shown = 0;
		let fulls = 0;
		const full = a.engine.fullSync.bind(a.engine);
		a.engine.fullSync = (...args) => {
			fulls++;
			return full(...args);
		};
		let answer = deferred<string>();
		let entered = deferred();
		flow.context.ui.requestPassword = () => {
			assert.equal(a.engine.hasPendingWork(), false);
			assert.equal(plugin.isFullSyncInProgress(), false);
			assert.equal(plugin.isEncryptionPasswordChangeInProgress(), true);
			shown++;
			entered.resolve();
			return answer.promise;
		};
		const oldWindow = globalThis.window;
		Object.assign(globalThis, { window: globalThis });
		try {
			await transition(source, remote, "rotate", "new-password");
			assert.equal(
				(await plugin.runFullSync({ trigger: "automatic" }, false))
					?.success,
				false,
			);
			await entered.promise;
			assert.equal(shown, 1);
			assert.equal(fulls, 1);
			answer.resolve("new-password");
			await Promise.all([
				flow.workflow.admission.flushAutomaticPasswordRequest(),
				flow.workflow.admission.flushAutomaticPasswordRequest(),
			]);
			assert.equal(shown, 1);
			assert.equal(fulls, 2);
			assert.equal(plugin.isEncryptionPasswordChangeInProgress(), false);
			assert.equal(plugin.settings.encryptionPassword, "new-password");
			assert.equal(scheduler["isRunning"], true);
			await a.assertSettled({ "note.md": "unchanged" });

			answer = deferred<string>();
			entered = deferred();
			await transition(source, remote, "rotate", "next-password");
			await plugin.runFullSync({ trigger: "automatic" }, false);
			await entered.promise;
			assert.equal(shown, 2);
			plugin.saveData = async () => {
				throw new Error("synthetic save failure");
			};
			await assert.rejects(
				plugin.saveSettings(),
				/synthetic save failure/,
			);
			assert.equal(persistence.failed, true);
			answer.resolve("next-password");
			await flow.workflow.admission.flushAutomaticPasswordRequest();
			assert.equal(plugin.settings.encryptionPassword, "new-password");
			assert.equal(fulls, 3);
			assert.equal(scheduler["isRunning"], false);
		} finally {
			answer.resolve("next-password");
			await flow.workflow.admission.flushAutomaticPasswordRequest();
			Object.assign(globalThis, { window: oldWindow });
		}
	},
);

test("connection settings wait across restart for manual plaintext or encrypted full sync", async (t) => {
	for (const outcome of [
		"plaintext",
		"connect",
		"path",
		"cancel",
		"wrong",
		"save-failure",
		"paused",
	] as const) {
		const disk = new MemoryDisk();
		const source = device(disk, "source", null);
		afterTest(t, () => source.stop());
		source.vault.put("remote.md", bytes("remote content"));
		await source.full();
		if (outcome !== "plaintext") {
			await transition(
				source,
				encryptionFlow(source),
				"enable",
				"password",
			);
		}
		const { plugin, a, flow, update, scheduler } = await settingsHost(
			t,
			false,
			disk,
		);
		flow.context.getSettings = () => plugin.settings;
		flow.context.persist = () => plugin.saveSettings();
		flow.context.ui.setBlock = (reason, notice) =>
			plugin["setEncryptionBlock"](reason, notice);
		const install = flow.context.setService.bind(flow.context);
		flow.context.setService = (service) => {
			install(service);
			plugin["encryptionService"] = service;
		};
		a.vault.put("offline.md", bytes("offline addition"));
		const local = a.index.captureLocalCausalState();
		const remote = structuredClone(disk.files);
		let prompts = 0;
		flow.context.ui.requestPassword = async () => {
			prompts++;
			assert.equal(plugin.isConfigurationBusy(), true);
			await assert.rejects(update({ yandexTokenSecret: "second-token" }));
			return outcome === "cancel"
				? null
				: outcome === "wrong"
					? "wrong"
					: "password";
		};
		if (outcome === "paused") {
			a.engine.pause();
		}
		if (outcome === "save-failure") {
			plugin.saveData = async () => {
				throw new Error("synthetic save failure");
			};
			await assert.rejects(
				update({ yandexTokenSecret: "new-token" }),
				/save failure/,
			);
			assert.equal(plugin.settings.yandexTokenSecret, "");
		} else if (outcome === "path") {
			plugin.settings.remotePath = "previous-vault";
			plugin.settings.yandexTokenSecret = "new-token";
			await plugin.saveSettings();
			await update({ remotePath: "vault" });
		} else {
			await update({ yandexTokenSecret: "new-token" });
		}
		assert.equal(prompts, 0, outcome);
		assert.equal(plugin.isConfigurationBusy(), false);
		assert.equal(scheduler["isRunning"], false, outcome);
		assert.equal(a.watcher["isEnabled"], false, outcome);
		assert.deepEqual(disk.files, remote);
		assert.deepEqual(a.index.captureLocalCausalState(), local);
		if (outcome === "save-failure") {
			continue;
		}
		assert.equal(plugin.settings.manualSyncRequired, true);
		await update({ excludePatterns: ["ignored/**"] });
		assert.equal(prompts, 0);
		const saved = structuredClone(plugin["persistence"].current);
		plugin.loadData = async () => saved;
		await plugin.loadSettings();
		assert.equal(plugin.settings.manualSyncRequired, true);
		let automaticReads = 0;
		disk.beforeRequest = async () => {
			automaticReads++;
			throw new Error("Remote access before manual synchronization");
		};
		await plugin["onLayoutReady"]();
		await plugin["startSync"](true);
		assert.equal(
			await plugin.runFullSync({ trigger: "automatic" }, false),
			null,
		);
		plugin["startAutomationIfReady"](true);
		assert.equal(scheduler["isRunning"], false);
		assert.equal(a.watcher["isEnabled"], false);
		assert.equal(prompts, 0);
		assert.equal(automaticReads, 0);
		assert.deepEqual(disk.files, remote);
		disk.beforeRequest = undefined;
		const oldWindow = globalThis.window;
		Object.assign(globalThis, { window: globalThis });
		try {
			if (outcome === "paused") {
				assert.equal(a.engine.isSyncPaused(), true);
				assert.equal(await plugin["resumeSyncIfReady"](), true);
			}
			const result = await plugin.runFullSync(undefined, false);
			assert.equal(
				result?.success === true,
				outcome !== "cancel" && outcome !== "wrong",
			);
		} finally {
			Object.assign(globalThis, { window: oldWindow });
		}
		assert.equal(prompts, outcome === "plaintext" ? 0 : 1);
		const connected =
			outcome === "connect" ||
			outcome === "path" ||
			outcome === "plaintext" ||
			outcome === "paused";
		assert.equal(plugin.settings.manualSyncRequired, !connected);
		assert.equal(
			plugin["persistence"].current?.settings.manualSyncRequired,
			!connected,
		);
		assert.equal(scheduler["isRunning"], connected, outcome);
		assert.equal(a.watcher["isEnabled"], connected, outcome);
		if (connected) {
			assert.equal(
				plugin.settings.enableEncryption,
				outcome !== "plaintext",
			);
			assert.equal(plugin["encryptionBlockReason"], null);
			await a.assertSettled({
				"remote.md": "remote content",
				"offline.md": "offline addition",
			});
			if (outcome === "plaintext" || outcome === "connect") {
				const restarted = device(
					disk,
					"settings-device",
					null,
					a.vault,
					await a.saved(),
				);
				afterTest(t, () => restarted.stop());
				Object.assign(restarted.settings, plugin.settings);
				await encryptionFlow(restarted).workflow.initEncryption();
				restarted.vault.put(
					"offline.md",
					bytes("offline after restart"),
				);
				await restarted.full();
				await restarted.assertSettled({
					"remote.md": "remote content",
					"offline.md": "offline after restart",
				});
			}
		} else {
			assert.equal(flow.context.getService(), null);
			assert.equal(Boolean(plugin.settings.encryptionPassword), false);
			assert.deepEqual(disk.files, remote);
			assert.deepEqual(a.index.captureLocalCausalState(), local);
			assert.equal(
				a.vault.getAbstractFileByPath("remote.md") !== null,
				false,
			);
			if (outcome === "cancel" || outcome === "wrong") {
				await update({ maxConcurrency: 7 });
				await update({ excludePatterns: ["ignored/**"] });
				await update({ yandexTokenSecret: "new-token" });
				assert.equal(prompts, 1);
				assert.deepEqual(disk.files, remote);
				flow.context.ui.requestPassword = async () => {
					prompts++;
					return "password";
				};
				const oldWindow = globalThis.window;
				Object.assign(globalThis, { window: globalThis });
				try {
					assert.equal((await plugin.runFullSync())?.success, true);
				} finally {
					Object.assign(globalThis, { window: oldWindow });
				}
				assert.equal(prompts, 2);
				await a.assertSettled({
					"remote.md": "remote content",
					"offline.md": "offline addition",
				});
			}
		}
	}
});

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

test("language preference is durable without activating a pending connection or publishing a failed save", async (t) => {
	const { plugin, persistence, a, disk, update } = await settingsHost(t);
	plugin.settings.manualSyncRequired = true;
	const remote = structuredClone(disk.files);
	const local = a.index.captureLocalCausalState();
	disk.beforeRequest = async () => {
		throw new Error("Language change must not access Disk");
	};
	afterTest(t, () => {
		setLanguagePreference("system");
	});
	await assert.rejects(
		update({ language: "unsupported" } as unknown as UserSettingsPatch),
		/Invalid language/,
	);
	await update({ language: "kk" });
	assert.equal(getActiveLanguage(), "kk");
	assert.equal(plugin.settings.language, "kk");
	assert.equal(plugin.settings.manualSyncRequired, true);
	assert.deepEqual(disk.files, remote);
	assert.deepEqual(a.index.captureLocalCausalState(), local);
	const restored = persistenceHarness(persistence.current);
	await restored.plugin.loadSettings();
	assert.equal(restored.plugin.settings.language, "kk");
	assert.equal(restored.plugin.settings.manualSyncRequired, true);
	const previous = plugin.settings;
	plugin.saveData = async () => {
		throw new Error("synthetic language save failure");
	};
	await assert.rejects(update({ language: "be" }), /language save failure/);
	assert.equal(plugin.settings, previous);
	assert.equal(getActiveLanguage(), "kk");
	assert.equal(persistence.current!.settings.language, "kk");
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
	assert.equal(plugin["operationIssue"]?.code, "settings-update");
	assert.match(
		plugin["getSyncIndicatorContext"]().operationError ?? "",
		/synthetic watcher drain failure/,
	);
	assert.deepEqual(disk.files, remote);
	a.watcher.waitForPendingPersistence = wait;
	assert.equal((await plugin.runFullSync(undefined, false))?.success, true);
	assert.equal(plugin["operationIssue"], undefined);
	const failures: string[] = [];
	const unsubscribe = a.engine.onStateChange((state) => {
		if (state.status === "error") {
			failures.push(state.errorMessage ?? "");
		}
	});
	afterTest(t, unsubscribe);
	plugin["setAuthenticationBlock"]("synthetic missing token");
	assert.equal(a.engine.getState().status, "error");
	assert.equal(a.engine.getState().errorMessage, "synthetic missing token");
	const entered = deferred();
	const release = deferred();
	afterTest(t, release.resolve);
	disk.beforeRequest = async () => {
		entered.resolve();
		await release.promise;
	};
	await update({ yandexTokenSecret: "synthetic-replacement" });
	assert.equal(plugin.getConnectionActivity(), undefined);
	const reconnecting = plugin.runFullSync(undefined, false);
	await entered.promise;
	try {
		assert.ok(plugin.getConnectionActivity());
		assert.equal(plugin.getConnectionActivity()?.errorMessage, undefined);
		assert.equal(plugin.isFullSyncInProgress(), true);
		assert.equal(plugin["authenticationBlockReason"], null);
		assert.equal(plugin["operationIssue"], undefined);
		assert.equal(a.watcher["isEnabled"], false);
		await assert.rejects(
			update({ remotePath: "another-vault" }),
			/pending/,
		);
	} finally {
		disk.beforeRequest = undefined;
		release.resolve();
		await reconnecting;
	}
	assert.equal(plugin.getConnectionActivity(), undefined);
	assert.deepEqual(
		failures.filter((message) => message !== "synthetic missing token"),
		[],
	);
	assert.equal(plugin["remoteStateValidated"], true);
	assert.equal(plugin["operationIssue"], undefined);
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
	assert.equal(plugin["operationIssue"], undefined);
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

test("manual connection activation remains pending after failed save or pause", async (t) => {
	for (const failure of ["save", "pause"] as const) {
		const { plugin, a, persistence, scheduler, update } =
			await settingsHost(t);
		await update({ yandexTokenSecret: "replacement" });
		const save = plugin.saveData.bind(plugin);
		plugin.saveData = async (data: PluginData) => {
			if (!data.settings.manualSyncRequired) {
				if (failure === "save") {
					throw new Error("synthetic activation save failure");
				}
				a.engine.pause();
			}
			await save(data);
		};
		assert.equal(await plugin.runFullSync(undefined, false), null);
		assert.equal(plugin.settings.manualSyncRequired, true);
		assert.equal(persistence.current?.settings.manualSyncRequired, true);
		assert.equal(persistence.failed, failure === "save");
		assert.equal(a.watcher["isEnabled"], false);
		assert.equal(scheduler["isRunning"], false);
		const saved = structuredClone(persistence.current);
		assert.equal(saved?.settings.manualSyncRequired, true);
		plugin.saveData = save;
		await update({ yandexTokenSecret: "replacement" });
		assert.equal(plugin.settings.manualSyncRequired, true);
		assert.equal(scheduler["isRunning"], false);
		a.engine.resume();
		assert.equal(
			(await plugin.runFullSync(undefined, false))?.success,
			true,
		);
		assert.equal(plugin.settings.manualSyncRequired, false);
		assert.equal(persistence.current?.settings.manualSyncRequired, false);
		await a.assertSettled({ "note.md": "unchanged" });
	}
});

test("connection changes revoke queued manual epoch retries across token ABA", async (t) => {
	const { plugin, disk, scheduler, update } = await settingsHost(t);
	const oldWindow = globalThis.window;
	let retry = () => {};
	Object.assign(globalThis, {
		window: {
			setTimeout: (callback: () => void) => {
				retry = callback;
				return 1;
			},
			clearTimeout: () => {},
		},
	});
	afterTest(t, () => {
		Object.assign(globalThis, { window: oldWindow });
	});
	plugin["queueEpochRecoveryFull"]({ trigger: "manual" });
	await update({ yandexTokenSecret: "replacement" });
	await update({ yandexTokenSecret: "synthetic" });
	let reads = 0;
	disk.beforeRequest = async () => {
		reads++;
	};
	retry();
	await plugin["activeFullPromise"];
	assert.equal(reads, 0);
	assert.equal(plugin.settings.manualSyncRequired, true);
	assert.equal(scheduler["isRunning"], false);
});
