import type { App, PluginManifest } from "obsidian";
import YandexDiskSyncPlugin from "../../src/main";
import { logger } from "../../src/utils/logger";

/** Expose the real plugin lifecycle while replacing only external services. */
export function lifecyclePlugin() {
	const app = { vault: { getName: () => "test-vault" } } as unknown as App;
	const manifest = { version: "2.0.0" } as PluginManifest;
	const plugin = new YandexDiskSyncPlugin(app, manifest);
	// The test Obsidian base class has no constructor side effects.
	plugin.app = app;
	plugin.manifest = manifest;
	return plugin;
}

/** Exercise real initialization and persistence against isolated synthetic storage. */
export function persistenceHarness(source: unknown = null) {
	const plugin = lifecyclePlugin();
	const writes: unknown[] = [];
	plugin.loadData = async () => source;
	plugin.saveData = async (value: unknown) => {
		logger.configure({ consoleEnabled: false, fileEnabled: false });
		writes.push(value);
	};
	return { plugin, persistence: plugin["persistence"], writes };
}
