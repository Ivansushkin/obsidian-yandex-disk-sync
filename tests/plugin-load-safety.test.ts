import assert from "node:assert/strict";
import test from "node:test";
import type { App, PluginManifest } from "obsidian";
import YandexDiskSyncPlugin from "../src/main";
import { UnsupportedHistoricalDataError } from "../src/compatibility-errors";
import { logger } from "../src/utils/logger";
import stableFixture from "./fixtures/stable-1.1/plugin-data-filled.json";

logger.configure({ consoleEnabled: false, fileEnabled: false });

interface PersistenceAccess {
	persistPluginData(): Promise<void>;
	pluginDataPersistenceTail: Promise<void>;
	completeStableLocalCutover(): Promise<void>;
}

function harness() {
	const app = { vault: { getName: () => "test-vault" } } as unknown as App;
	const manifest = { version: "2.0.0" } as PluginManifest;
	const plugin = new YandexDiskSyncPlugin(app, manifest);
	Object.assign(plugin, { app, manifest });
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
	Object.assign(globalThis, { window: { localStorage: { getItem: () => "en" } } });
	try {
		for (const failure of ["historical", "read"] as const) {
			const { plugin, persistence, writes } = harness();
			plugin.loadData = async () => {
				if (failure === "read") throw new Error("storage read failed");
				return { settings: {}, localIndex: null, lastSyncStats: {} };
			};
			await assert.rejects(plugin.onload(), failure === "historical"
				? UnsupportedHistoricalDataError : /storage read failed/);
			plugin.onunload();
			await persistence.pluginDataPersistenceTail;
			assert.deepEqual(writes, []);
			await assert.rejects(plugin.saveSettings(), /not successfully loaded/);
			await assert.rejects(persistence.persistPluginData(), /not successfully loaded/);
			assert.deepEqual(writes, []);
		}
	} finally {
		Object.assign(globalThis, { window: oldWindow });
	}
});

test("stable fractional timestamps survive load save and unload without cutover", async () => {
	const { plugin, persistence, writes } = harness();
	const source = structuredClone(stableFixture);
	source.localIndex.files["note.md"].mtime += 0.375;
	plugin.loadData = async () => source;
	await plugin.loadSettings();
	assert.deepEqual(writes, []);
	await plugin.saveSettings();
	plugin.onunload();
	await persistence.pluginDataPersistenceTail;
	assert.equal(writes.length, 2);
	for (const written of writes) {
		assert.deepEqual(JSON.parse(JSON.stringify(written)), source);
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

test("stable cutover writes current data accepted by the next plugin instance", async () => {
	const { plugin, persistence, writes } = harness();
	const source = structuredClone(stableFixture);
	source.localIndex.files["note.md"].mtime += 0.375;
	plugin.loadData = async () => source;
	await plugin.loadSettings();
	await persistence.completeStableLocalCutover();
	assert.equal(writes.length, 1);
	const current = JSON.parse(JSON.stringify(writes[0])) as Record<string, unknown>;
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
	persistence.pluginDataPersistenceTail = new Promise<void>((resolve) => { release = resolve; });
	const staleSave = assert.rejects(persistence.persistPluginData(), /not successfully loaded|superseded/);
	plugin.loadData = async () => ({ unsupported: true });
	const reload = assert.rejects(plugin.loadSettings(), UnsupportedHistoricalDataError);
	release();
	await Promise.all([staleSave, reload]);
	plugin.onunload();
	await persistence.pluginDataPersistenceTail;
	assert.deepEqual(writes, []);
	await assert.rejects(persistence.completeStableLocalCutover(), /not successfully loaded/);
});
