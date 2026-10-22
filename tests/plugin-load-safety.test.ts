import assert from "node:assert/strict";
import test from "node:test";
import { UnsupportedHistoricalDataError } from "../src/compatibility-errors";
import { logger } from "../src/utils/logger";
import stableFixture from "./fixtures/stable-1.1/plugin-data-filled.json";
import { DEFAULT_SETTINGS, createEmptyLocalState } from "../src/types";
import { persistenceHarness as harness } from "./helpers/lifecycle-fixtures";

logger.configure({ consoleEnabled: false, fileEnabled: false });

test("user settings publish only after persistence and retain queues saved ahead of the draft", async () => {
	const { plugin, writes } = harness();
	await plugin.loadSettings();
	plugin.settings = { ...plugin.settings, logToFile: false };
	const old = plugin.settings;
	const draft = plugin.applySettingsPatch({ enableDebugLogging: true });
	assert.equal(plugin.settings, old);
	const mutation = { id: "synthetic-pending" };
	Object.assign(plugin, {
		indexManager: {
			getPendingMutations: () => [mutation],
			getLocalIndexData: () => null,
			getPendingPhysicalActions: () => [],
			updateSettings: () => {},
		},
	});
	await draft;
	assert.equal(plugin.settings.enableDebugLogging, true);
	assert.deepEqual(
		(writes.at(-1) as { pendingMutations: unknown[] }).pendingMutations,
		[mutation],
	);
	plugin.saveData = async () => {
		throw new Error("storage unavailable");
	};
	await assert.rejects(
		plugin.applySettingsPatch({ enableDebugLogging: false }),
		/storage unavailable/,
	);
	assert.equal(plugin.settings.enableDebugLogging, true);
	await assert.rejects(
		plugin.applySettingsPatch({ deviceId: "foreign" } as never),
		/Unsupported user setting/,
	);
});

test("logging persistence does not replace an internal encryption update queued during the save", async () => {
	const { plugin, persistence, writes } = harness();
	await plugin.loadSettings();
	plugin.settings = { ...plugin.settings, logToFile: false };
	let release = () => {};
	let entered = () => {};
	const waiting = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	plugin.saveData = async (value: unknown) => {
		writes.push(value);
		entered();
		await blocked;
	};
	const draft = plugin.applySettingsPatch({ enableDebugLogging: true });
	await waiting;
	plugin.settings.enableEncryption = true;
	const internal = persistence.persist();
	release();
	await Promise.all([draft, internal]);
	assert.equal(plugin.settings.enableEncryption, true);
	assert.equal(plugin.settings.enableDebugLogging, true);
	const saved = (writes.at(-1) as { settings: typeof DEFAULT_SETTINGS })
		.settings;
	assert.equal(saved.enableEncryption, true);
	assert.equal(saved.enableDebugLogging, true);
});

test("accepted connection settings reconcile before automation and preserve a user pause", async () => {
	for (let paused of [false, true]) {
		const { plugin, writes } = harness();
		await plugin.loadSettings();
		plugin.settings = { ...plugin.settings, logToFile: false };
		const order: string[] = [];
		Object.assign(plugin, {
			app: { ...plugin.app, workspace: { layoutReady: true } },
			localStateRestored: true,
			syncLifecycleRegistered: true,
			fileWatcher: {
				stop: () => order.push("stop"),
				updateSettings: () => {},
				waitForPendingPersistence: async () => {
					// Watcher persistence awaits the same queue as the settings draft.
					await plugin.saveSettings();
					order.push("watcher-saved");
				},
				getDeferredEvents: () => [],
				start: () => order.push("watcher-start"),
			},
			syncScheduler: {
				stop: () => {},
				updateSettings: () => {},
				start: () => order.push("scheduler-start"),
			},
			syncEngine: {
				hasPendingWork: () => false,
				isSyncPaused: () => paused,
				resume: () => {
					paused = false;
				},
				setExternalBlock: () => {},
				updateSettings: () => {},
				fullSync: async () => {
					assert.equal(
						plugin.settings.yandexTokenSecret,
						"synthetic",
					);
					order.push("full");
					return {
						success: true,
						errors: [],
						uploaded: 0,
						downloaded: 0,
						deleted: 0,
						conflicts: 0,
						startTime: 1,
						endTime: 2,
					};
				},
			},
			refreshRemoteStartupState: async () => {
				order.push("recheck");
				plugin["authenticationBlockReason"] = null;
				return "ready";
			},
		});
		await plugin.applySettingsPatch({ yandexTokenSecret: "synthetic" });
		assert.equal(
			(writes.at(-1) as { settings: typeof DEFAULT_SETTINGS }).settings
				.yandexTokenSecret,
			"synthetic",
		);
		assert.ok(order.indexOf("watcher-saved") < order.indexOf("recheck"));
		assert.equal(order.includes("full"), !paused);
		if (paused) {
			assert.equal(order.includes("watcher-start"), false);
		} else {
			assert.ok(order.indexOf("full") < order.indexOf("watcher-start"));
		}
		assert.equal(plugin.isConfigurationBusy(), false);
		if (paused) {
			assert.equal(await plugin["resumeSyncIfReady"](), true);
			assert.ok(order.indexOf("full") < order.indexOf("watcher-start"));
		}
	}
});

test("failed plugin load never overwrites storage on save or unload", async () => {
	const oldWindow = globalThis.window;
	Object.assign(globalThis, {
		window: { localStorage: { getItem: () => "en" } },
	});
	try {
		for (const failure of ["historical", "read"] as const) {
			const { plugin, persistence, writes } = harness();
			plugin.loadData = async () => {
				if (failure === "read") {
					throw new Error("storage read failed");
				}
				return { settings: {}, localIndex: null, lastSyncStats: {} };
			};
			await assert.rejects(
				plugin.onload(),
				failure === "historical"
					? UnsupportedHistoricalDataError
					: /storage read failed/,
			);
			plugin.onunload();
			await persistence.idle();
			assert.deepEqual(writes, []);
			await assert.rejects(
				plugin.saveSettings(),
				/not successfully loaded/,
			);
			await assert.rejects(
				persistence.persist(),
				/not successfully loaded/,
			);
			assert.deepEqual(writes, []);
		}
	} finally {
		Object.assign(globalThis, { window: oldWindow });
	}
});

test("stable fractional timestamps survive immediate current migration and unload", async () => {
	const { plugin, persistence, writes } = harness();
	const source = structuredClone(stableFixture);
	source.localIndex.files["note.md"].mtime += 0.375;
	plugin.loadData = async () => source;
	await plugin.loadSettings();
	assert.equal(writes.length, 1);
	await plugin.saveSettings();
	plugin.onunload();
	await persistence.idle();
	assert.equal(writes.length, 3);
	for (const written of writes) {
		const current = written as {
			format: string;
			localState: { files: typeof source.localIndex.files };
		};
		assert.equal(current.format, "plugin-data");
		assert.equal(
			current.localState.files["note.md"].mtime,
			source.localIndex.files["note.md"].mtime,
		);
	}
	const current = JSON.parse(JSON.stringify(writes.at(-1))) as Record<
		string,
		unknown
	>;
	const restarted = harness(current);
	await restarted.plugin.loadSettings();
	await restarted.persistence.persist();
	assert.deepEqual(JSON.parse(JSON.stringify(restarted.writes[0])), current);
});

test("failed initial persistence cannot be retried by unload", async () => {
	const { plugin, persistence } = harness();
	let attempts = 0;
	plugin.saveData = async () => {
		logger.configure({ consoleEnabled: false, fileEnabled: false });
		attempts++;
		throw new Error("disk unavailable");
	};
	await assert.rejects(plugin.loadSettings(), /disk unavailable/);
	plugin.onunload();
	await persistence.idle();
	assert.equal(attempts, 1);
	await assert.rejects(plugin.saveSettings(), /not successfully loaded/);
});

test("reload invalidates queued saves before reading storage", async () => {
	const { plugin, persistence, writes } = harness();
	plugin.loadData = async () => structuredClone(stableFixture);
	await plugin.loadSettings();
	const staleSave = assert.rejects(
		persistence.persist(),
		/not successfully loaded|superseded/,
	);
	plugin.loadData = async () => ({ unsupported: true });
	const reload = assert.rejects(
		plugin.loadSettings(),
		UnsupportedHistoricalDataError,
	);
	await Promise.all([staleSave, reload]);
	plugin.onunload();
	await persistence.idle();
	assert.equal(writes.length, 1);
	await assert.rejects(persistence.persist(), /not successfully loaded/);
});

test("persisted actor and queue survive missing installation cache but reject a known foreign owner", async () => {
	const previous = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage",
	);
	try {
		for (const cached of [null, "unavailable", "foreign"] as const) {
			const { plugin, writes } = harness();
			Object.defineProperty(globalThis, "localStorage", {
				configurable: true,
				value: {
					getItem: () => {
						if (cached === "unavailable") {
							throw new Error("synthetic unavailable cache");
						}
						return cached;
					},
					setItem: () => {},
				},
			});
			const localState = createEmptyLocalState("persisted-actor");
			localState.observedEpoch = "epoch-a";
			localState.nextMutationSeq = 2;
			const pendingMutations = [
				{
					id: "persisted-actor:1",
					seq: 1,
					epoch: "epoch-a",
					type: "put",
					baseRevision: 0,
					path: "note.md",
					sha256: "abc",
					createdAt: 1,
				},
			];
			const source = {
				format: "plugin-data",
				settings: {
					...DEFAULT_SETTINGS,
					remotePath: "vault",
					deviceId: "persisted-actor",
				},
				localState,
				pendingMutations,
				pendingPhysicalActions: [],
				pendingWatcherEvents: [],
				encryptionTransition: null,
				lastSyncStats: {
					uploaded: 0,
					downloaded: 0,
					deleted: 0,
					errors: 0,
				},
			};
			plugin.loadData = async () => structuredClone(source);
			if (cached === "foreign") {
				await assert.rejects(
					plugin.loadSettings(),
					/another installation/,
				);
				assert.deepEqual(writes, []);
			} else {
				await plugin.loadSettings();
				assert.equal(plugin.settings.deviceId, "persisted-actor");
				assert.deepEqual(
					(writes[0] as { pendingMutations: unknown[] })
						.pendingMutations,
					pendingMutations,
				);
			}
		}
		const fresh = harness();
		fresh.plugin.loadData = async () => null;
		await fresh.plugin.loadSettings();
		assert.notEqual(fresh.plugin.settings.deviceId, "foreign");
		assert.notEqual(fresh.plugin.settings.deviceId, "persisted-actor");
	} finally {
		if (previous) {
			Object.defineProperty(globalThis, "localStorage", previous);
		} else {
			Reflect.deleteProperty(globalThis, "localStorage");
		}
	}
});

test("failed settings save is not retried by unload", async () => {
	for (const unloadDuringSave of [false, true]) {
		const { plugin, persistence } = harness();
		await plugin.loadSettings();
		let attempts = 0;
		let release = () => {};
		let entered = () => {};
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		plugin.saveData = async () => {
			attempts++;
			entered();
			await blocked;
			throw new Error("synthetic failed save");
		};
		const rejected = assert.rejects(
			plugin.applySettingsPatch({ enableDebugLogging: true }),
			/synthetic failed save/,
		);
		await waiting;
		if (unloadDuringSave) {
			plugin.onunload();
		}
		release();
		await rejected;
		if (!unloadDuringSave) {
			plugin.onunload();
		}
		await persistence.idle();
		assert.equal(attempts, 1);
		assert.equal(plugin.settings.enableDebugLogging, false);
	}
});

test("reload rejects publication of an in-flight settings draft", async () => {
	const { plugin, persistence } = harness();
	await plugin.loadSettings();
	let release = () => {};
	let entered = () => {};
	const waiting = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	plugin.saveData = async () => {
		entered();
		await blocked;
	};
	const draft = plugin.applySettingsPatch({ enableDebugLogging: true });
	await waiting;
	const rejected = assert.rejects(
		draft,
		/superseded|not successfully loaded/,
	);
	plugin.loadData = async () => ({ unsupported: true });
	const reload = assert.rejects(
		plugin.loadSettings(),
		UnsupportedHistoricalDataError,
	);
	release();
	await Promise.all([rejected, reload]);
	await persistence.idle();
	assert.equal(plugin.settings.enableDebugLogging, false);
});

test("manual full retry restores automation after startup or settings failure", async () => {
	for (const [entry, boundary] of [
		["startup", "ready"],
		["settings", "ready"],
		["startup", "pause"],
		["settings", "save"],
		["startup", "unload"],
		["settings", "overlap"],
		["startup", "block-after-success"],
	] as const) {
		const { plugin } = harness();
		await plugin.loadSettings();
		plugin.settings = {
			...plugin.settings,
			yandexTokenSecret: entry === "settings" ? "" : "synthetic",
			logToFile: false,
		};
		let calls = 0,
			paused = false;
		let entered!: () => void, release!: () => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const starts: string[] = [];
		Object.assign(plugin, {
			app: { ...plugin.app, workspace: { layoutReady: true } },
			localStateRestored: true,
			syncLifecycleRegistered: true,
			fileWatcher: {
				getDeferredEvents: () => [],
				waitForPendingPersistence: async () => {},
				start: () => starts.push("watcher"),
				stop: () => {},
				updateSettings: () => {},
			},
			syncScheduler: {
				start: () => starts.push("scheduler"),
				stop: () => {},
				updateSettings: () => {},
			},
			indexManager: {
				getPendingMutations: () => [],
				getPendingPhysicalActions: () => [],
				getMaintenance: () => undefined,
				getLocalIndexData: () => null,
				updateSettings: () => {},
			},
			syncEngine: {
				setExternalBlock: () => {},
				hasPendingWork: () => false,
				isSyncPaused: () => paused,
				updateSettings: () => {},
				fullSync: async () => {
					calls++;
					if (
						calls > 1 &&
						(boundary === "unload" || boundary === "overlap")
					) {
						entered();
						await gate;
					}
					return {
						success: calls > 1,
						errors:
							calls > 1
								? []
								: [
										{
											path: "",
											operation: "none",
											message: "temporary failure",
										},
									],
						uploaded: 0,
						downloaded: 0,
						deleted: 0,
						conflicts: 0,
						startTime: 1,
						endTime: 2,
					};
				},
			},
			refreshRemoteStartupState: async () => {
				plugin["authenticationBlockReason"] = null;
				return "ready";
			},
		});
		if (entry === "settings") {
			await plugin.applySettingsPatch({ yandexTokenSecret: "synthetic" });
		} else {
			await plugin["startSync"](true, true);
		}
		assert.deepEqual(starts, []);
		if (boundary === "pause") {
			paused = true;
		}
		if (boundary === "save") {
			plugin.saveData = async () => {
				throw new Error("retry save failure");
			};
		}
		const retry = plugin.runFullSync(undefined, false);
		let concurrent: ReturnType<typeof plugin.runFullSync> | undefined;
		if (boundary === "unload" || boundary === "overlap") {
			await waiting;
			if (boundary === "unload") {
				plugin["unloaded"] = true;
			} else {
				concurrent = plugin.runFullSync(undefined, false);
			}
			release();
		}
		const result = await retry;
		if (concurrent) {
			await concurrent;
			assert.equal(calls, 2);
		}
		if (
			boundary === "pause" ||
			boundary === "save" ||
			boundary === "unload"
		) {
			assert.deepEqual(starts, []);
			if (boundary === "save") {
				assert.equal(result, null);
				assert.equal(plugin["persistence"].failed, true);
			}
			continue;
		}
		assert.equal(result?.success, true);
		assert.deepEqual(starts, ["watcher", "scheduler"]);
		if (boundary === "block-after-success") {
			Object.assign(plugin["syncEngine"], {
				fullSync: async () => ({
					success: false,
					errors: [
						{
							path: "",
							operation: "none",
							message: "invalid remote index",
							code: "invalid-index",
						},
					],
					uploaded: 0,
					downloaded: 0,
					deleted: 0,
					conflicts: 0,
					startTime: 1,
					endTime: 2,
				}),
			});
			await plugin.runFullSync(undefined, false);
			assert.equal(plugin["regularSyncStarted"], false);
			assert.deepEqual(starts, ["watcher", "scheduler"]);
			continue;
		}
		await plugin.runFullSync(undefined, false);
		assert.deepEqual(starts, ["watcher", "scheduler"]);
	}
});
