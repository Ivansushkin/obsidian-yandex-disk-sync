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
import { SyncScheduler } from "../src/sync/scheduler";

/** Replace only native registration, browser opening and token HTTP for the real host workflow. */
function wireAuthorization(
	t: TestContext,
	plugin: Awaited<ReturnType<typeof settingsHost>>["plugin"],
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
	const oldClient = SHARED_YANDEX_OAUTH.clientId;
	SHARED_YANDEX_OAUTH.clientId = "public-test-client";
	const transport = globalThis as unknown as {
		__obsidianRequestUrl: (params: RequestUrlParam) => Promise<unknown>;
	};
	const previousRequest = transport.__obsidianRequestUrl;
	let tokenResponder = async (_params: RequestUrlParam) => ({
		status: 200,
		json: {
			access_token: "synthetic-oauth",
			refresh_token: "synthetic-initial-refresh",
			token_type: "bearer",
			expires_in: 3600,
		},
	});
	transport.__obsidianRequestUrl = async (params) =>
		params.url === "https://oauth.yandex.ru/token"
			? tokenResponder(params)
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
		transport.__obsidianRequestUrl = previousRequest;
		globalThis.window = oldWindow;
	});
	plugin["initializeAuthorization"]();
	return {
		setTokenResponder: (responder: typeof tokenResponder) => {
			tokenResponder = responder;
		},
		callback: (params: Record<string, string>) => protocolHandler(params),
		browserUrl: () => new URL(browserUrl),
		submit: (code: string) =>
			plugin["authorization"]!.acceptCallback({
				state: new URL(browserUrl).searchParams.get("state")!,
				code,
			}),
	};
}

test("OAuth full renews before expiry and resumes after HTTP 401", async (t) => {
	const { plugin, a } = await settingsHost(t);
	a.index.getLocalIndex().remoteScope = await readRemoteStorageScope(
		a.client,
		"vault",
	);
	const browser = wireAuthorization(t, plugin);
	await plugin.beginAuthorization();
	await browser.submit("synthetic-code");
	assert.equal(
		plugin.settings.oauthAuthorization?.refreshToken,
		"synthetic-initial-refresh",
	);
	let refreshes = 0;
	browser.setTokenResponder(async (params) => {
		assert.equal(typeof params.body, "string");
		const body = new URLSearchParams(params.body as string);
		assert.equal(body.get("grant_type"), "refresh_token");
		assert.equal(
			body.get("client_secret"),
			SHARED_YANDEX_OAUTH.clientSecret,
		);
		refreshes++;
		return {
			status: 200,
			json: {
				access_token: "renewed-1",
				refresh_token: `rotated-${refreshes}`,
				token_type: "bearer",
				expires_in: 3600,
			},
		};
	});
	plugin.settings.oauthAuthorization.expiresAt = Date.now() + 1000;
	assert.equal((await plugin.runFullSync())?.success, true);
	assert.equal(refreshes, 1);
	assert.equal(plugin.settings.oauthAuthorization?.refreshToken, "rotated-1");
	const transport = globalThis as unknown as {
		__obsidianRequestUrl: (params: RequestUrlParam) => Promise<unknown>;
	};
	const previous = transport.__obsidianRequestUrl;
	let rejectOnce = true;
	transport.__obsidianRequestUrl = async (params) => {
		if (rejectOnce && params.url.includes("/v1/disk/resources")) {
			rejectOnce = false;
			return {
				status: 401,
				json: { error: "unauthorized" },
				arrayBuffer: new ArrayBuffer(0),
				text: "",
				headers: {},
			};
		}
		return previous(params);
	};
	try {
		assert.equal((await plugin.runFullSync())?.success, true);
		assert.equal(refreshes, 2);
		assert.equal(
			plugin.settings.oauthAuthorization?.refreshToken,
			"rotated-2",
		);
	} finally {
		transport.__obsidianRequestUrl = previous;
	}
});

test("paused OAuth sync refreshes an expiring grant before resuming once", async (t) => {
	const { plugin, a, scheduler } = await settingsHost(t);
	a.index.getLocalIndex().remoteScope = await readRemoteStorageScope(
		a.client,
		"vault",
	);
	const browser = wireAuthorization(t, plugin);
	await plugin.beginAuthorization();
	await browser.submit("synthetic-code");
	await plugin.runFullSync();
	let refreshes = 0;
	browser.setTokenResponder(async () => {
		refreshes++;
		return {
			status: 200,
			json: {
				access_token: "renewed-resume",
				refresh_token: "rotated-resume",
				token_type: "bearer",
				expires_in: 3600,
			},
		};
	});
	plugin.settings.oauthAuthorization!.expiresAt = Date.now() + 1000;
	a.engine.pause();
	plugin["stopRegularSync"]();
	const [first, second] = await Promise.all([
		plugin["resumeSyncIfReady"](),
		plugin["resumeSyncIfReady"](),
	]);
	assert.equal(first, true);
	assert.equal(second, true);
	assert.equal(refreshes, 1);
	assert.equal(a.engine.isSyncPaused(), false);
	assert.equal(a.watcher["isEnabled"], true);
	assert.equal(scheduler["isRunning"], true);

	const entered = deferred();
	const release = deferred();
	browser.setTokenResponder(async () => {
		entered.resolve();
		await release.promise;
		return {
			status: 200,
			json: {
				access_token: "stale-resume",
				refresh_token: "stale-rotation",
				token_type: "bearer",
				expires_in: 3600,
			},
		};
	});
	plugin.settings.oauthAuthorization!.expiresAt = Date.now() + 1000;
	a.engine.pause();
	plugin["stopRegularSync"]();
	const revoked = plugin["resumeSyncIfReady"]();
	await entered.promise;
	a.engine.resume();
	a.engine.pause();
	release.resolve();
	assert.equal(await revoked, false);
	assert.equal(
		plugin.settings.oauthAuthorization?.refreshToken,
		"rotated-resume",
	);
	assert.equal(a.engine.isSyncPaused(), true);
	assert.equal(a.watcher["isEnabled"], false);
});

test("temporary OAuth refresh preserves automation and a later full", async (t) => {
	const { plugin, a, disk, scheduler } = await settingsHost(t);
	a.index.getLocalIndex().remoteScope = await readRemoteStorageScope(
		a.client,
		"vault",
	);
	const previousNow = Date.now;
	let now = previousNow();
	Date.now = () => now;
	afterTest(t, () => {
		Date.now = previousNow;
	});
	const browser = wireAuthorization(t, plugin);
	await plugin.beginAuthorization();
	await browser.submit("synthetic-code");
	await plugin.runFullSync();
	let refreshes = 0;
	browser.setTokenResponder(async () => {
		refreshes++;
		if (refreshes === 1) {
			throw new Error("synthetic offline");
		}
		return {
			status: 200,
			json: {
				access_token: "renewed-retry",
				refresh_token: "rotated-retry",
				token_type: "bearer",
				expires_in: 3600,
			},
		};
	});
	plugin.settings.oauthAuthorization!.expiresAt = now + 1000;
	a.vault.put("recover.md", bytes("offline edit"));
	assert.equal(
		await plugin.runFullSync({ trigger: "automatic" }, false),
		null,
	);
	assert.equal(refreshes, 1);
	assert.equal(a.watcher["isEnabled"], true);
	assert.equal(scheduler["isRunning"], true);
	assert.equal(plugin["authenticationBlockReason"], null);
	assert.equal(plugin["isConfigurationBusy"](), false);
	assert.equal(plugin.isAuthorizationPending(), false);
	now += 30_001;
	assert.equal(
		(await plugin.runFullSync({ trigger: "automatic" }, false))?.success,
		true,
	);
	assert.equal(refreshes, 2);
	assert.equal(
		new TextDecoder().decode(disk.files.get("vault/recover.md")),
		"offline edit",
	);
	assert.equal(a.watcher["isEnabled"], true);
	assert.equal(scheduler["isRunning"], true);
});

test("cold startup refreshes before Disk access and again after a 401", async (t) => {
	const { plugin, a, disk, scheduler } = await settingsHost(t);
	a.index.getLocalIndex().remoteScope = await readRemoteStorageScope(
		a.client,
		"vault",
	);
	const browser = wireAuthorization(t, plugin);
	await plugin.beginAuthorization();
	await browser.submit("synthetic-code");
	await plugin.runFullSync();
	let refreshes = 0;
	browser.setTokenResponder(async () => {
		refreshes++;
		return {
			status: 200,
			json: {
				access_token: "startup-renewed",
				refresh_token: "startup-rotated",
				token_type: "bearer",
				expires_in: 3600,
			},
		};
	});
	const transport = globalThis as unknown as {
		__obsidianRequestUrl: (params: RequestUrlParam) => Promise<unknown>;
	};
	const previous = transport.__obsidianRequestUrl;
	let rejected = false;
	let refreshesBeforeDisk = -1;
	transport.__obsidianRequestUrl = async (params) => {
		if (!rejected && params.url.includes("/v1/disk/resources")) {
			rejected = true;
			refreshesBeforeDisk = refreshes;
			return {
				status: 401,
				json: { error: "unauthorized" },
				arrayBuffer: new ArrayBuffer(0),
				text: "",
				headers: {},
			};
		}
		return previous(params);
	};
	afterTest(t, () => {
		transport.__obsidianRequestUrl = previous;
	});
	plugin["remoteStateValidated"] = false;
	plugin["regularSyncStarted"] = false;
	plugin["automationReady"] = false;
	plugin.settings.oauthAuthorization!.expiresAt = Date.now() + 1000;
	a.watcher.stop();
	scheduler.stop();
	a.vault.put("startup-401.md", bytes("startup edit"));
	await plugin["onLayoutReady"]();
	assert.equal(rejected, true);
	assert.equal(refreshesBeforeDisk, 1);
	assert.equal(refreshes, 2);
	assert.equal(a.watcher["isEnabled"], true);
	assert.equal(
		new TextDecoder().decode(disk.files.get("vault/startup-401.md")),
		"startup edit",
	);
});

test("cold startup with manual admission does not refresh OAuth", async (t) => {
	const { plugin, a } = await settingsHost(t);
	a.index.getLocalIndex().remoteScope = await readRemoteStorageScope(
		a.client,
		"vault",
	);
	const browser = wireAuthorization(t, plugin);
	await plugin.beginAuthorization();
	await browser.submit("synthetic-code");
	let refreshes = 0;
	browser.setTokenResponder(async () => {
		refreshes++;
		throw new Error("unexpected refresh");
	});
	plugin.settings.manualSyncRequired = true;
	plugin.settings.oauthAuthorization!.expiresAt = Date.now() + 1000;
	await plugin["onLayoutReady"]();
	assert.equal(refreshes, 0);
});

test("scheduled full refreshes OAuth before Disk access", async (t) => {
	const { plugin, a, disk } = await settingsHost(t);
	a.index.getLocalIndex().remoteScope = await readRemoteStorageScope(
		a.client,
		"vault",
	);
	const browser = wireAuthorization(t, plugin);
	await plugin.beginAuthorization();
	await browser.submit("synthetic-code");
	await plugin.runFullSync();
	let refreshes = 0;
	browser.setTokenResponder(async () => {
		refreshes++;
		return {
			status: 200,
			json: {
				access_token: "scheduler-renewed",
				refresh_token: "scheduler-rotated",
				token_type: "bearer",
				expires_in: 3600,
			},
		};
	});
	plugin.settings.oauthAuthorization!.expiresAt = Date.now() + 1000;
	a.vault.put("scheduled.md", bytes("scheduled edit"));
	const scheduler = new SyncScheduler(a.engine, plugin.settings, () =>
		plugin.runFullSync({ trigger: "automatic" }, false),
	);
	await scheduler["runScheduledSync"]();
	assert.equal(refreshes, 1);
	assert.equal(
		new TextDecoder().decode(disk.files.get("vault/scheduled.md")),
		"scheduled edit",
	);
});

test("mobile recovery refreshes before Disk access and again after a 401", async (t) => {
	const { plugin, a, disk } = await settingsHost(t);
	a.index.getLocalIndex().remoteScope = await readRemoteStorageScope(
		a.client,
		"vault",
	);
	const browser = wireAuthorization(t, plugin);
	await plugin.beginAuthorization();
	await browser.submit("synthetic-code");
	await plugin.runFullSync();
	let refreshes = 0;
	browser.setTokenResponder(async () => {
		refreshes++;
		return {
			status: 200,
			json: {
				access_token: "mobile-renewed",
				refresh_token: "mobile-rotated",
				token_type: "bearer",
				expires_in: 3600,
			},
		};
	});
	const transport = globalThis as unknown as {
		__obsidianRequestUrl: (params: RequestUrlParam) => Promise<unknown>;
	};
	const previous = transport.__obsidianRequestUrl;
	let rejected = false;
	let refreshesBeforeDisk = -1;
	transport.__obsidianRequestUrl = async (params) => {
		if (!rejected && params.url.includes("/v1/disk/resources")) {
			rejected = true;
			refreshesBeforeDisk = refreshes;
			return {
				status: 401,
				json: { error: "unauthorized" },
				arrayBuffer: new ArrayBuffer(0),
				text: "",
				headers: {},
			};
		}
		return previous(params);
	};
	const previousMobile = Platform.isMobileApp;
	Platform.isMobileApp = true;
	const doc = Object.assign(new EventTarget(), {
		visibilityState: "visible",
		defaultView: new EventTarget(),
	});
	plugin.app.workspace.containerEl = { ownerDocument: doc } as HTMLElement;
	plugin.registerDomEvent = ((
		target: EventTarget,
		event: string,
		listener: EventListener,
	) => {
		target.addEventListener(event, listener);
	}) as typeof plugin.registerDomEvent;
	afterTest(t, () => {
		transport.__obsidianRequestUrl = previous;
		Platform.isMobileApp = previousMobile;
		plugin["mobileRecovery"]?.dispose();
	});
	plugin["initializeMobileRecovery"]();
	plugin.settings.oauthAuthorization!.expiresAt = Date.now() + 1000;
	a.vault.put("mobile-401.md", bytes("mobile edit"));
	plugin["mobileRecovery"]!.request("schedule");
	for (
		let attempt = 0;
		attempt < 100 &&
		(!disk.files.has("vault/mobile-401.md") ||
			plugin["mobileRecovery"]!["pending"]);
		attempt++
	) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(rejected, true);
	assert.equal(refreshesBeforeDisk, 1);
	assert.equal(refreshes, 2);
	assert.equal(plugin["mobileRecovery"]!["pending"], false);
	assert.equal(
		new TextDecoder().decode(disk.files.get("vault/mobile-401.md")),
		"mobile edit",
	);
});

test("hidden mobile automatic full does not refresh OAuth", async (t) => {
	const { plugin, a } = await settingsHost(t);
	a.index.getLocalIndex().remoteScope = await readRemoteStorageScope(
		a.client,
		"vault",
	);
	const browser = wireAuthorization(t, plugin);
	await plugin.beginAuthorization();
	await browser.submit("synthetic-code");
	let refreshes = 0;
	browser.setTokenResponder(async () => {
		refreshes++;
		throw new Error("unexpected hidden refresh");
	});
	const previousMobile = Platform.isMobileApp;
	Platform.isMobileApp = true;
	const doc = Object.assign(new EventTarget(), {
		visibilityState: "hidden",
		defaultView: new EventTarget(),
	});
	plugin.app.workspace.containerEl = { ownerDocument: doc } as HTMLElement;
	plugin.registerDomEvent = ((
		target: EventTarget,
		event: string,
		listener: EventListener,
	) => {
		target.addEventListener(event, listener);
	}) as typeof plugin.registerDomEvent;
	afterTest(t, () => {
		Platform.isMobileApp = previousMobile;
		plugin["mobileRecovery"]?.dispose();
	});
	plugin["initializeMobileRecovery"]();
	plugin.settings.oauthAuthorization!.expiresAt = Date.now() + 1000;
	assert.equal(
		await plugin.runFullSync({ trigger: "automatic" }, false),
		null,
	);
	assert.equal(refreshes, 0);
});

for (const method of ["manual", "legacy-oauth"] as const) {
	test(`HTTP 401 does not replay full without refresh token: ${method}`, async (t) => {
		const { plugin } = await settingsHost(t);
		if (method === "legacy-oauth") {
			plugin.settings.authMethod = "oauth";
			plugin.settings.oauthAuthorization = {
				clientId: SHARED_YANDEX_OAUTH.clientId,
				grantId: "saved-old-grant",
				refreshToken: null,
				expiresAt: null,
			};
		}
		const transport = globalThis as unknown as {
			__obsidianRequestUrl: (params: RequestUrlParam) => Promise<unknown>;
		};
		const previous = transport.__obsidianRequestUrl;
		let rejected = 0;
		transport.__obsidianRequestUrl = async () => {
			rejected++;
			return {
				status: 401,
				json: { error: "unauthorized" },
				arrayBuffer: new ArrayBuffer(0),
				text: "",
				headers: {},
			};
		};
		try {
			assert.equal((await plugin.runFullSync())?.success ?? false, false);
			assert.equal(rejected, 1);
		} finally {
			transport.__obsidianRequestUrl = previous;
		}
	});
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
			const browser = wireAuthorization(t, plugin);
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
			assert.equal(
				new URL(browser.browserUrl().searchParams.get("redirect_uri")!)
					.protocol,
				"obsidian:",
			);
			let unsubscribe = () => {};
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await new Promise<void>((resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error("authorization did not finish")),
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
						state: browser.browserUrl().searchParams.get("state")!,
						code: "synthetic-code",
					});
				});
			} finally {
				unsubscribe();
				clearTimeout(timer);
			}
			assert.equal(plugin.getAuthorizationState().phase, "connected");
			assert.equal(plugin.settings.authMethod, "oauth");
			assert.equal(plugin.settings.manualSyncRequired, true);
			assert.equal((await plugin.runFullSync())?.success, true);
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
			const browser = wireAuthorization(t, plugin);
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
			const result = browser.submit("synthetic-code");
			const accepted = result;
			await entered.promise;
			if (timing !== "before") {
				a.engine.pause();
			}
			if (timing === "pause-resume") {
				a.engine.resume();
			}
			release.resolve();
			await accepted;
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
		const browser = wireAuthorization(t, plugin);
		await plugin.beginAuthorization();
		await browser.submit("synthetic-code");
		await plugin.runFullSync();
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
		assert.equal(plugin.settings.authMethod, "oauth");
	},
);

test("logout removes credentials durably without contacting Disk or losing offline history", async (t) => {
	for (const method of ["manual", "oauth"] as const) {
		const { plugin, persistence, a, disk } = await settingsHost(t);
		a.index.getLocalIndex().remoteScope = await readRemoteStorageScope(
			a.client,
			"vault",
		);
		await plugin.applySettingsPatch({
			clientId: "synthetic-manual-client",
		});
		const browser = wireAuthorization(t, plugin);
		if (method === "oauth") {
			await plugin.beginAuthorization();
			await browser.submit("synthetic-code");
		}
		a.watcher.setPersistCallback(() => plugin["persistPluginData"]());
		a.engine.pause();
		a.vault.put("offline.md", bytes("offline edit"));
		await a.watcher.waitForPendingPersistence();
		const before = structuredClone(persistence.current!);
		assert.equal(before.pendingWatcherEvents.length, 1);
		const remote = structuredClone(disk.files);
		disk.beforeRequest = async () => {
			throw new Error("Logout must not contact Disk");
		};
		await plugin.logoutAuthorization();
		const after = persistence.current!;
		assert.equal(after.settings.yandexTokenSecret, "");
		assert.equal(after.settings.oauthAuthorization, null);
		assert.equal(after.settings.authMethod, method);
		assert.equal(after.settings.clientId, "");
		assert.equal(after.settings.manualSyncRequired, true);
		assert.deepEqual({ ...after, settings: before.settings }, before);
		assert.deepEqual(
			{
				...after.settings,
				clientId: before.settings.clientId,
				yandexTokenSecret: before.settings.yandexTokenSecret,
				oauthAuthorization: before.settings.oauthAuthorization,
				manualSyncRequired: before.settings.manualSyncRequired,
				manualAuthorizationConfirmed:
					before.settings.manualAuthorizationConfirmed,
			},
			before.settings,
		);
		assert.deepEqual(disk.files, remote);
		assert.equal(plugin.getAuthorizationState().phase, "idle");
		assert.equal(plugin["regularSyncStarted"], false);
		assert.equal(a.engine.isSyncPaused(), true);
		assert.equal(a.vault.entries.has("offline.md"), true);
		const { persistenceHarness } =
			await import("./helpers/lifecycle-fixtures");
		const restored = persistenceHarness(after);
		await restored.plugin.loadSettings();
		assert.equal(restored.plugin.settings.yandexTokenSecret, "");
		assert.equal(restored.plugin.settings.oauthAuthorization, null);
		disk.beforeRequest = undefined;
		a.engine.resume();
		await plugin.beginAuthorization();
		await browser.submit("synthetic-code");
		assert.equal(plugin.getAuthorizationState().phase, "connected");
		assert.equal(plugin.settings.manualSyncRequired, true);
		await plugin.runFullSync();
		assert.equal(disk.files.has("vault/offline.md"), true);
		assert.equal(persistence.current?.pendingWatcherEvents.length, 0);
	}
});

test("logout waits for secret-bearing recovery to finish", async (t) => {
	const { plugin, persistence } = await settingsHost(t);
	const before = structuredClone(persistence.current);
	Object.assign(plugin, {
		encryptionTransition: { source: { password: "synthetic-password" } },
	});
	await assert.rejects(plugin.logoutAuthorization(), /recovery/i);
	assert.deepEqual(persistence.current, before);
});

test("encrypted logout requires the vault password after reauthorization", async (t) => {
	const { plugin, persistence, a, flow } = await settingsHost(t, true);
	plugin["encryptionService"] = flow.context.getService();
	flow.context.getSettings = () => plugin.settings;
	flow.context.getService = () => plugin["encryptionService"];
	let passwordRequests = 0;
	flow.context.ui.requestPassword = async () => {
		passwordRequests++;
		return null;
	};
	await plugin.logoutAuthorization();
	assert.equal(persistence.current?.settings.encryptionPassword, null);
	assert.equal(plugin.settings.encryptionPassword, null);
	assert.equal(plugin["encryptionService"], null);
	assert.equal(a.client.hasEncryptionService(), false);
	await plugin.applySettingsPatch({ yandexTokenSecret: "synthetic-return" });
	assert.equal(
		await flow.workflow.admission.ensureEncryptionReady({ prompt: true }),
		false,
	);
	assert.equal(passwordRequests, 1);
});

test("failed logout keeps the saved grant and blocks automation until a durable retry", async (t) => {
	const { plugin, persistence, a } = await settingsHost(t);
	a.index.getLocalIndex().remoteScope = await readRemoteStorageScope(
		a.client,
		"vault",
	);
	const browser = wireAuthorization(t, plugin);
	await plugin.beginAuthorization();
	await browser.submit("synthetic-code");
	const previous = structuredClone(plugin.settings);
	const save = plugin.saveData.bind(plugin);
	plugin.saveData = async () => {
		throw new Error("synthetic logout storage failure");
	};
	await assert.rejects(plugin.logoutAuthorization(), /storage failure/);
	assert.deepEqual(plugin.settings, previous);
	assert.equal(persistence.failed, true);
	assert.equal(plugin["regularSyncStarted"], false);
	plugin.saveData = save;
	await plugin.logoutAuthorization();
	assert.equal(persistence.current?.settings.yandexTokenSecret, "");
	assert.equal(persistence.current?.settings.oauthAuthorization, null);
	assert.equal(persistence.failed, false);
});

test("starting shared sign-in durably clears manual credentials and cancellation cannot restore them", async (t) => {
	const { plugin, persistence, a } = await settingsHost(t);
	a.index.getLocalIndex().remoteScope = await readRemoteStorageScope(
		a.client,
		"vault",
	);
	await plugin.applySettingsPatch({ clientId: "synthetic-manual-client" });
	const before = structuredClone(a.index.getLocalIndex());
	const browser = wireAuthorization(t, plugin);
	await plugin.beginAuthorization();
	assert.equal(browser.browserUrl().hostname, "oauth.yandex.ru");
	assert.equal(plugin.settings.authMethod, "oauth");
	assert.equal(plugin.settings.clientId, "");
	assert.equal(plugin.settings.yandexTokenSecret, "");
	assert.equal(persistence.current?.settings.clientId, "");
	assert.equal(persistence.current?.settings.yandexTokenSecret, "");
	plugin.cancelAuthorization();
	await plugin.saveSettings();
	assert.equal(persistence.current?.settings.clientId, "");
	assert.equal(persistence.current?.settings.yandexTokenSecret, "");
	assert.equal(plugin.settings.manualSyncRequired, true);
	assert.deepEqual(a.index.getLocalIndex(), before);
});
