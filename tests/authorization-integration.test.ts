import assert from "node:assert/strict";
import test from "node:test";
import type { RequestUrlParam } from "obsidian";
import { SHARED_YANDEX_OAUTH } from "../src/auth/configuration";
import { readRemoteStorageScope } from "../src/sync/local/storage-scope";
import { settingsHost } from "./helpers/settings-host";
import { bytes, device } from "./helpers/sync-flow";
import { encryptionFlow } from "./helpers/encryption-flow";
import { afterTest } from "./helpers/test-context";

for (const encrypted of [false, true]) {
	test(
		`OAuth migration preserves offline history through actual ${encrypted ? "encrypted" : "plaintext"} full sync`,
		{ timeout: 10_000 },
		async (t) => {
			const { plugin, persistence, a, disk, flow } = await settingsHost(
				t,
				encrypted,
			);
			const peer = device(disk, "offline-peer", null);
			afterTest(t, () => peer.stop());
			if (encrypted) {
				await encryptionFlow(peer).workflow.connectForSync(
					"synthetic-password",
				);
			}
			await peer.full();
			const before = await a.canonical();
			a.index.getLocalIndex().remoteScope = await readRemoteStorageScope(
				a.client,
				"vault",
			);
			flow.context.getSettings = () => plugin.settings;
			flow.context.persist = () => plugin.saveSettings();
			plugin["encryptionService"] = flow.context.getService();
			await plugin.saveSettings();
			a.watcher.setPersistCallback(() => plugin["persistPluginData"]());
			const cleanups: (() => void)[] = [];
			plugin.register = (cleanup) => {
				cleanups.push(cleanup);
			};
			plugin.registerObsidianProtocolHandler = () => {};
			const oldClient = SHARED_YANDEX_OAUTH.clientId;
			SHARED_YANDEX_OAUTH.clientId = "public-test-client";
			const transport = globalThis as unknown as {
				__obsidianRequestUrl: (
					params: RequestUrlParam,
				) => Promise<unknown>;
			};
			const previousRequest = transport.__obsidianRequestUrl;
			transport.__obsidianRequestUrl = async (params) =>
				params.url === "https://oauth.yandex.ru/token"
					? {
							status: 200,
							json: {
								access_token: "synthetic-oauth",
								token_type: "bearer",
							},
						}
					: previousRequest(params);
			const oldWindow = globalThis.window;
			globalThis.window = {
				...oldWindow,
				open: () => null,
			} as unknown as Window & typeof globalThis;
			afterTest(t, () => {
				for (const cleanup of cleanups.reverse()) {
					cleanup();
				}
				SHARED_YANDEX_OAUTH.clientId = oldClient;
				transport.__obsidianRequestUrl = previousRequest;
				globalThis.window = oldWindow;
			});
			plugin["initializeAuthorization"]();
			await plugin.beginAuthorization();
			assert.equal(plugin.isAuthorizationPending(), true);
			const actor = plugin.settings.deviceId;
			a.vault.put("local.md", bytes("local offline"));
			a.watcher.notifyAutomaticAdmissionChanged();
			await a.watcher.waitForPendingPersistence();
			assert.equal(persistence.current?.pendingWatcherEvents.length, 1);
			assert.equal(disk.files.has("vault/local.md"), false);
			peer.vault.put("remote.md", bytes("peer offline"));
			await peer.full();
			await plugin.submitAuthorizationCode("synthetic-code");
			assert.equal(plugin.getAuthorizationState().phase, "connected");
			assert.equal(plugin.settings.authMethod, "oauth");
			assert.equal(plugin.settings.manualSyncRequired, false);
			assert.equal(plugin.settings.deviceId, actor);
			assert.equal(
				persistence.current?.settings.yandexTokenSecret,
				"synthetic-oauth",
			);
			assert.equal(persistence.current?.pendingWatcherEvents.length, 0);
			await peer.full();
			await a.assertSettled({
				"note.md": "unchanged",
				"local.md": "local offline",
				"remote.md": "peer offline",
			});
			await peer.assertSettled({
				"note.md": "unchanged",
				"local.md": "local offline",
				"remote.md": "peer offline",
			});
			assert.equal((await a.canonical()).epoch, before.epoch);
		},
	);
}
