import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Platform, type RequestUrlParam } from "obsidian";
import { SHARED_YANDEX_OAUTH } from "../src/auth/configuration";
import { readRemoteStorageScope } from "../src/sync/local/storage-scope";
import { settingsHost } from "./helpers/settings-host";
import { MemoryDisk, bytes, device } from "./helpers/sync-flow";
import { encryptionFlow } from "./helpers/encryption-flow";
import { afterTest } from "./helpers/test-context";
import { deferred } from "./helpers/deferred";
import { StorageBindingController } from "../src/sync/local/storage-binding";

/** Replace only native registration, browser opening and token HTTP for the real host workflow. */
function wireAuthorization(
	t: TestContext,
	plugin: Awaited<ReturnType<typeof settingsHost>>["plugin"],
	callbackSupported = false,
) {
	const cleanups: (() => void)[] = [];
	plugin.register = (cleanup) => {
		cleanups.push(cleanup);
	};
	let protocolHandler: (params: Record<string, string>) => void = () => {
		throw new Error("handler not registered");
	};
	plugin.registerObsidianProtocolHandler = (_action, handler) => {
		protocolHandler = (params) => {
			handler({ ...params, action: "yandex-disk-sync-auth" });
		};
	};
	const oldPlatforms = SHARED_YANDEX_OAUTH.callbackPlatforms;
	SHARED_YANDEX_OAUTH.callbackPlatforms = callbackSupported
		? ["desktop"]
		: [];
	const oldClient = SHARED_YANDEX_OAUTH.clientId;
	SHARED_YANDEX_OAUTH.clientId = "public-test-client";
	const transport = globalThis as unknown as {
		__obsidianRequestUrl: (params: RequestUrlParam) => Promise<unknown>;
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
	let browserUrl = "";
	globalThis.window = {
		...oldWindow,
		open: (url?: string | URL) => {
			browserUrl = String(url ?? "");
			return null;
		},
	} as unknown as Window & typeof globalThis;
	afterTest(t, () => {
		for (const cleanup of cleanups.reverse()) {
			cleanup();
		}
		SHARED_YANDEX_OAUTH.clientId = oldClient;
		SHARED_YANDEX_OAUTH.callbackPlatforms = oldPlatforms;
		transport.__obsidianRequestUrl = previousRequest;
		globalThis.window = oldWindow;
	});
	plugin["initializeAuthorization"]();
	return {
		callback: (params: Record<string, string>) => protocolHandler(params),
		browserUrl: () => new URL(browserUrl),
	};
}

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
			const browser = wireAuthorization(t, plugin, !encrypted);
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
			if (encrypted) {
				await plugin.submitAuthorizationCode("synthetic-code");
			} else {
				assert.equal(
					new URL(
						browser.browserUrl().searchParams.get("redirect_uri")!,
					).protocol,
					"obsidian:",
				);
				let unsubscribe = () => {};
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await new Promise<void>((resolve, reject) => {
						timer = setTimeout(
							() =>
								reject(
									new Error("authorization did not finish"),
								),
							5000,
						);
						unsubscribe = plugin.onAuthorizationStateChange(() => {
							const state = plugin.getAuthorizationState();
							if (state.phase === "connected") {
								resolve();
							}
							if (state.phase === "error") {
								reject(new Error("authorization failed"));
							}
						});
						browser.callback({
							state: browser
								.browserUrl()
								.searchParams.get("state")!,
							code: "synthetic-code",
						});
					});
				} finally {
					unsubscribe();
					clearTimeout(timer);
				}
			}
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

test(
	"Pause during accepted OAuth save preserves credentials without starting storage preflight",
	{ timeout: 10_000 },
	async (t) => {
		for (const timing of ["before", "during", "pause-resume"] as const) {
			const { plugin, a, disk, persistence, update } = await settingsHost(
				t,
				false,
				new MemoryDisk(),
			);
			await update({ remotePath: "fresh-vault" });
			plugin["storageBinding"] = new StorageBindingController({
				client: a.client,
				index: a.index,
				getSettings: () => plugin.settings,
				hasPendingWork: () => false,
				hasTransition: () => false,
				isUnloaded: () => plugin.isPluginUnloaded(),
				persist: () => plugin.saveSettings(),
				confirm: async () => "new",
			});
			wireAuthorization(t, plugin);
			const entered = deferred();
			const release = deferred();
			plugin.saveData = async () => {
				entered.resolve();
				await release.promise;
			};
			if (timing === "before") {
				a.engine.pause();
			}
			await plugin.beginAuthorization();
			const result = plugin.submitAuthorizationCode("synthetic-code");
			const rejected = assert.rejects(result);
			await entered.promise;
			if (timing !== "before") {
				a.engine.pause();
			}
			if (timing === "pause-resume") {
				a.engine.resume();
			}
			release.resolve();
			await rejected;
			assert.equal(plugin.settings.authMethod, "oauth");
			assert.equal(
				persistence.current?.settings.manualSyncRequired,
				true,
			);
			assert.equal(disk.folders.has("fresh-vault"), false);
			assert.equal(disk.files.size, 0);
		}
	},
);

test(
	"Resume during browser authorization leaves the old connection paused",
	{ timeout: 10_000 },
	async (t) => {
		const { plugin, a, disk } = await settingsHost(t);
		a.index.getLocalIndex().remoteScope = await readRemoteStorageScope(
			a.client,
			"vault",
		);
		await plugin.saveSettings();
		a.engine.pause();
		wireAuthorization(t, plugin);
		await plugin.beginAuthorization();
		const before = structuredClone(disk.files);
		assert.equal(await plugin["resumeSyncIfReady"](), false);
		assert.equal(a.engine.isSyncPaused(), true);
		assert.deepEqual(disk.files, before);
		plugin.cancelAuthorization();
	},
);

test(
	"Mobile browser return waits through authorization cancellation before actual recovery",
	{ timeout: 10_000 },
	async (t) => {
		const { plugin, a } = await settingsHost(t);
		a.index.getLocalIndex().remoteScope = await readRemoteStorageScope(
			a.client,
			"vault",
		);
		await plugin.saveSettings();
		wireAuthorization(t, plugin);
		const doc = Object.assign(new EventTarget(), {
			visibilityState: "visible",
			defaultView: new EventTarget(),
		});
		Object.assign(plugin.app.workspace, {
			containerEl: { ownerDocument: doc },
		});
		plugin.registerDomEvent = () => {};
		const previousPlatform = Platform.isMobileApp;
		Object.assign(Platform, { isMobileApp: true });
		afterTest(t, () => {
			Object.assign(Platform, { isMobileApp: previousPlatform });
		});
		plugin["initializeMobileRecovery"]();
		await plugin.beginAuthorization();
		const recovery = plugin["mobileRecovery"]!;
		recovery.request("visible");
		await new Promise((resolve) => setTimeout(resolve, 550));
		plugin.cancelAuthorization();
		const settled = deferred();
		const full = a.engine.fullSync.bind(a.engine);
		a.engine.fullSync = async (...args) => {
			const result = await full(...args);
			settled.resolve();
			return result;
		};
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				settled.promise,
				new Promise<void>((_, reject) => {
					timeout = setTimeout(
						() => reject(new Error("recovery did not resume")),
						5000,
					);
				}),
			]);
		} finally {
			clearTimeout(timeout);
		}
		while (plugin.isFullSyncInProgress()) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal(recovery.canStartAutomatic(), true);
		assert.equal(plugin.settings.authMethod, "manual");
	},
);
