import assert from "node:assert/strict";
import test from "node:test";
import type { App, PluginManifest } from "obsidian";
import YandexDiskSyncPlugin from "../src/main";
import { UnsupportedHistoricalDataError } from "../src/compatibility-errors";
import { logger } from "../src/utils/logger";
import stableFixture from "./fixtures/stable-1.1/plugin-data-filled.json";
import { DEFAULT_SETTINGS, createEmptyLocalState } from "../src/types";

logger.configure({ consoleEnabled: false, fileEnabled: false });

interface PersistenceAccess {
	persistPluginData(): Promise<void>;
	pluginDataPersistenceTail: Promise<void>;
}

test("user settings publish only after persistence and retain queues saved ahead of the draft", async () => {
	const { plugin, persistence, writes } = harness();
	plugin.loadData = async () => null;
	await plugin.loadSettings();
	plugin.settings = { ...plugin.settings, logToFile: false };
	const old = plugin.settings;
	let release = () => {};
	persistence.pluginDataPersistenceTail = new Promise<void>((resolve) => {
		release = resolve;
	});
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
	release();
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
	plugin.loadData = async () => null;
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
	const internal = persistence.persistPluginData();
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
		plugin.loadData = async () => null;
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
			assert.equal(
				await (
					plugin as unknown as {
						resumeSyncIfReady(): Promise<boolean>;
					}
				).resumeSyncIfReady(),
				true,
			);
			assert.ok(order.indexOf("full") < order.indexOf("watcher-start"));
		}
	}
});

function harness() {
	const app = { vault: { getName: () => "test-vault" } } as unknown as App;
	const manifest = { version: "2.0.0" } as PluginManifest;
	const plugin = new YandexDiskSyncPlugin(app, manifest);
	Object.assign(plugin, {
		app,
		manifest,
		getInstallationDeviceId: () => "test-installation",
	});
	const writes: unknown[] = [];
	plugin.saveData = async (value: unknown) => {
		logger.configure({ consoleEnabled: false, fileEnabled: false });
		writes.push(value);
	};
	return {
		plugin,
		persistence: plugin as unknown as PersistenceAccess,
		writes,
	};
}

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
			await persistence.pluginDataPersistenceTail;
			assert.deepEqual(writes, []);
			await assert.rejects(
				plugin.saveSettings(),
				/not successfully loaded/,
			);
			await assert.rejects(
				persistence.persistPluginData(),
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
	await persistence.pluginDataPersistenceTail;
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
});

test("fresh nullish plugin storage permits persistence after successful load", async () => {
	for (const source of [null, undefined]) {
		const { plugin, writes } = harness();
		plugin.loadData = async () => source;
		await plugin.loadSettings();
		assert.equal(writes.length, 1);
		assert.equal((writes[0] as { format: string }).format, "plugin-data");
	}
});

test("immediate stable migration writes current data accepted by restart", async () => {
	const { plugin, writes } = harness();
	const source = structuredClone(stableFixture);
	source.localIndex.files["note.md"].mtime += 0.375;
	plugin.loadData = async () => source;
	await plugin.loadSettings();
	assert.equal(writes.length, 1);
	const current = JSON.parse(JSON.stringify(writes[0])) as Record<
		string,
		unknown
	>;
	assert.equal(current.format, "plugin-data");
	const restarted = harness();
	restarted.plugin.loadData = async () => current;
	await restarted.plugin.loadSettings();
	await restarted.persistence.persistPluginData();
	assert.deepEqual(JSON.parse(JSON.stringify(restarted.writes[0])), current);
});

test("failed initial persistence cannot be retried by unload", async () => {
	const { plugin, persistence } = harness();
	let attempts = 0;
	plugin.loadData = async () => null;
	plugin.saveData = async () => {
		logger.configure({ consoleEnabled: false, fileEnabled: false });
		attempts++;
		throw new Error("disk unavailable");
	};
	await assert.rejects(plugin.loadSettings(), /disk unavailable/);
	plugin.onunload();
	await persistence.pluginDataPersistenceTail;
	assert.equal(attempts, 1);
	await assert.rejects(plugin.saveSettings(), /not successfully loaded/);
});

test("reload invalidates queued saves before reading storage", async () => {
	const { plugin, persistence, writes } = harness();
	plugin.loadData = async () => structuredClone(stableFixture);
	await plugin.loadSettings();
	let release = () => {};
	persistence.pluginDataPersistenceTail = new Promise<void>((resolve) => {
		release = resolve;
	});
	const staleSave = assert.rejects(
		persistence.persistPluginData(),
		/not successfully loaded|superseded/,
	);
	plugin.loadData = async () => ({ unsupported: true });
	const reload = assert.rejects(
		plugin.loadSettings(),
		UnsupportedHistoricalDataError,
	);
	release();
	await Promise.all([staleSave, reload]);
	plugin.onunload();
	await persistence.pluginDataPersistenceTail;
	assert.equal(writes.length, 1);
	await assert.rejects(
		persistence.persistPluginData(),
		/not successfully loaded/,
	);
});

test("persisted actor and queue survive missing installation cache but reject a known foreign owner", async () => {
	const previous = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage",
	);
	try {
		for (const cached of [null, "unavailable", "foreign"] as const) {
			const { plugin, writes } = harness();
			Reflect.deleteProperty(plugin, "getInstallationDeviceId");
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
		Reflect.deleteProperty(fresh.plugin, "getInstallationDeviceId");
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
