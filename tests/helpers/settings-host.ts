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
	const { plugin, persistence } = persistenceHarness();
	const a = device(
		disk,
		"settings-device",
		null,
		undefined,
		undefined,
		{},
		undefined,
		() => plugin["unloaded"] || persistence.failed,
	);
	if (!remote) {
		a.vault.put("note.md", bytes("unchanged"));
		await a.full();
	}
	const flow = encryptionFlow(a);
	if (encrypted) {
		await transition(a, flow, "enable", "synthetic-password");
	}
	await plugin.loadSettings();
	plugin.settings = {
		...a.settings,
		authMethod: "manual",
		yandexTokenSecret: remote ? "" : "synthetic",
	};
	const scheduler = new SyncScheduler(a.engine, plugin.settings, () =>
		plugin.runFullSync({ trigger: "automatic" }, false),
	);
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
	let disposal: Promise<void> | undefined;
	/** Revoke the host before joining work that could otherwise restart automation. */
	const dispose = (): Promise<void> => {
		if (disposal) {
			return disposal;
		}
		disk.beforeRequest = undefined;
		const failures: unknown[] = [];
		try {
			if (!plugin["unloaded"]) {
				plugin.onunload();
			}
		} catch (error) {
			failures.push(error);
		}
		disposal = (async () => {
			const results = await Promise.allSettled([
				plugin["firstManualFullPromise"],
				plugin["activeFullPromise"],
				plugin["activeManualFullPromise"],
				plugin["activeResumePromise"],
			]);
			for (const result of results) {
				if (result.status === "rejected") {
					failures.push(result.reason);
				}
			}
			for (const cleanup of [
				() => scheduler.stop(),
				() => a.stop(),
				() => persistence.idle(),
			]) {
				try {
					await Promise.resolve().then(cleanup);
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length > 0) {
				throw failures[0];
			}
		})();
		return disposal;
	};
	afterTest(t, dispose);
	const update = plugin.applySettingsPatch.bind(plugin);
	return { plugin, persistence, a, disk, scheduler, update, flow, dispose };
}
