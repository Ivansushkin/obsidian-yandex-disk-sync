import type { App, PluginManifest } from "obsidian";
import YandexDiskSyncPlugin from "../../src/main";
import { logger } from "../../src/utils/logger";

/** Expose the real plugin lifecycle while replacing only external services. */
export function lifecyclePlugin() {
	return Object.create(
		YandexDiskSyncPlugin.prototype,
	) as YandexDiskSyncPlugin;
}

/** Exercise real initialization and persistence against isolated synthetic storage. */
export function persistenceHarness(source: unknown = null) {
	const app = { vault: { getName: () => "test-vault" } } as unknown as App;
	const manifest = { version: "2.0.0" } as PluginManifest;
	const plugin = new YandexDiskSyncPlugin(
		app,
		manifest,
	) as unknown as YandexDiskSyncPlugin;
	Object.assign(plugin, {
		app,
		manifest,
		getInstallationDeviceId: () => "test-installation",
	});
	const writes: unknown[] = [];
	plugin.loadData = async () => source;
	plugin.saveData = async (value: unknown) => {
		logger.configure({ consoleEnabled: false, fileEnabled: false });
		writes.push(value);
	};
	return { plugin, persistence: plugin, writes };
}
