import type { TestContext } from "node:test";
import { persistenceHarness } from "./lifecycle-fixtures";
import { MemoryDisk, bytes, device } from "./sync-flow";
import { afterTest } from "./test-context";
import { encryptionFlow } from "./encryption-flow";
import { transition } from "./encryption-scenarios";
import { SyncScheduler } from "../../src/sync/scheduler";

/** Combine real settings publication and sync algorithms over synthetic storage. */
export async function settingsHost(
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
		authMethod: "manual",
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
