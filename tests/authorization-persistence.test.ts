import assert from "node:assert/strict";
import test from "node:test";
import { persistenceHarness } from "./helpers/lifecycle-fixtures";
import { deferred } from "./helpers/deferred";
import { logger } from "../src/utils/logger";
import type { PluginData } from "../src/plugin-persistence";

test("authorization defaults preserve existing manual connections and incomplete setup", async () => {
	const seed = persistenceHarness();
	await seed.plugin.loadSettings();
	for (const previous of ["fresh", "token", "client", "oauth"] as const) {
		const data = structuredClone(seed.writes.at(-1)) as PluginData;
		Reflect.deleteProperty(data.settings, "authMethod");
		Reflect.deleteProperty(data.settings, "oauthAuthorization");
		Reflect.deleteProperty(data.settings, "manualAuthorizationConfirmed");
		data.settings.yandexTokenSecret =
			previous === "token" || previous === "oauth" ? "synthetic-old" : "";
		data.settings.clientId =
			previous === "client" || previous === "oauth"
				? "synthetic-client"
				: "";
		if (previous === "oauth") {
			data.settings.authMethod = "oauth";
			data.settings.oauthAuthorization = {
				clientId: "shared-client",
				grantId: "saved-grant",
				refreshToken: null,
				expiresAt: null,
			};
		}
		data.settings.manualSyncRequired = false;
		const { plugin, persistence } = persistenceHarness(
			previous === "fresh" ? null : data,
		);
		await plugin.loadSettings();
		assert.equal(
			plugin.settings.authMethod,
			previous === "fresh" || previous === "oauth" ? "oauth" : "manual",
		);
		assert.deepEqual(
			plugin.settings.oauthAuthorization,
			data.settings.oauthAuthorization ?? null,
		);
		assert.equal(
			persistence.current?.settings.clientId,
			previous === "client" ? "synthetic-client" : "",
		);
		assert.equal(plugin.settings.manualSyncRequired, previous === "fresh");
		const confirmed = plugin.settings.manualAuthorizationConfirmed;
		assert.equal(confirmed, previous === "token");
		assert.equal(
			plugin.settings.yandexTokenSecret,
			data.settings.yandexTokenSecret,
		);
	}
	for (const patch of [
		{ authMethod: null },
		{ authMethod: "oauth", yandexTokenSecret: "synthetic-partial" },
		{
			authMethod: "manual",
			oauthAuthorization: {
				clientId: "client",
				grantId: "grant",
				refreshToken: null,
				expiresAt: null,
			},
		},
		{
			authMethod: "oauth",
			yandexTokenSecret: "synthetic-access",
			oauthAuthorization: {
				clientId: "client",
				grantId: "grant",
				refreshToken: null,
				expiresAt: -1,
			},
		},
	]) {
		const invalid = structuredClone(seed.writes.at(-1)) as PluginData;
		Object.assign(invalid.settings, patch);
		await assert.rejects(
			persistenceHarness(invalid).plugin.loadSettings(),
			/authorization state/,
		);
	}
});

test("logout clears encryption password from durable data and later snapshots", async () => {
	const { plugin, persistence, writes } = persistenceHarness();
	await plugin.loadSettings();
	Object.assign(plugin.settings, {
		authMethod: "manual",
		yandexTokenSecret: "synthetic-token",
		enableEncryption: true,
		encryptionSalt: "synthetic-salt",
		encryptionPassword: "synthetic-password",
		encryptionRevision: 1,
		encryptionProfileId: "hardened",
	});
	await plugin.saveSettings();
	await persistence.persistAuthentication({ kind: "logout" }, () => {});
	assert.equal(persistence.current?.settings.encryptionPassword, null);
	assert.equal(plugin.settings.encryptionPassword, null);
	plugin.settings.encryptionPassword = "stale-password";
	await plugin.saveSettings();
	assert.equal(persistence.current?.settings.encryptionPassword, null);
	const restored = persistenceHarness(writes.at(-1));
	await restored.plugin.loadSettings();
	assert.equal(restored.plugin.settings.encryptionPassword, null);
});

test("loading a previously signed-out profile removes its orphaned encryption password", async () => {
	const seed = persistenceHarness();
	await seed.plugin.loadSettings();
	const oldData = structuredClone(seed.writes.at(-1)) as PluginData;
	Object.assign(oldData.settings, {
		authMethod: "oauth",
		yandexTokenSecret: "",
		enableEncryption: true,
		encryptionSalt: "synthetic-salt",
		encryptionPassword: "synthetic-old-password",
		encryptionRevision: 1,
		encryptionProfileId: "hardened",
	});
	const { plugin, persistence, writes } = persistenceHarness(oldData);
	await plugin.loadSettings();
	assert.equal(plugin.settings.encryptionPassword, null);
	assert.equal(persistence.current?.settings.encryptionPassword, null);
	assert.equal(
		(writes.at(-1) as PluginData).settings.encryptionPassword,
		null,
	);
	assert.equal(plugin.settings.encryptionSalt, "synthetic-salt");
	assert.equal(plugin.settings.encryptionProfileId, "hardened");
	plugin.settings.encryptionPassword = "stale-password";
	await plugin.saveSettings();
	assert.equal(persistence.current?.settings.encryptionPassword, null);
});

test("accepted authorization survives unload publication revocation and later snapshot writes", async () => {
	for (const logout of [false, true]) {
		const { plugin, persistence, writes } = persistenceHarness();
		await plugin.loadSettings();
		if (logout) {
			await persistence.persistAuthentication(
				{
					kind: "interactive",
					token: "synthetic-old",
					authorization: {
						clientId: "public-client",
						grantId: "old-grant",
						refreshToken: null,
						expiresAt: null,
					},
				},
				() => {},
			);
			Object.assign(plugin.settings, {
				enableEncryption: true,
				encryptionSalt: "synthetic-salt",
				encryptionPassword: "synthetic-password",
				encryptionRevision: 1,
				encryptionProfileId: "hardened",
			});
			await plugin.saveSettings();
		}
		plugin.settings.clientId = "stale-manual-client";
		const entered = deferred();
		const release = deferred();
		plugin.saveData = async (data) => {
			writes.push(structuredClone(data));
			entered.resolve();
			await release.promise;
		};
		const update = persistence.persistAuthentication(
			logout
				? { kind: "logout" }
				: {
						kind: "interactive",
						token: "synthetic-new",
						authorization: {
							clientId: "public-client",
							grantId: "grant",
							refreshToken: null,
							expiresAt: null,
						},
					},
			() => {},
		);
		const rejected = assert.rejects(update, /unloaded/);
		await entered.promise;
		logger.configure({ consoleEnabled: false, fileEnabled: false });
		plugin.onunload();
		release.resolve();
		await rejected;
		await persistence.idle();
		assert.equal(
			plugin.settings.yandexTokenSecret,
			logout ? "synthetic-old" : "",
		);
		const stored = (writes.at(-1) as PluginData).settings;
		assert.equal(stored.yandexTokenSecret, logout ? "" : "synthetic-new");
		assert.equal(stored.authMethod, "oauth");
		assert.equal(stored.clientId, "");
		assert.equal(
			stored.oauthAuthorization?.grantId,
			logout ? undefined : "grant",
		);
		assert.equal(stored.manualSyncRequired, true);
		assert.equal(stored.encryptionPassword, null);
		const restored = persistenceHarness(writes.at(-1));
		await restored.plugin.loadSettings();
		assert.equal(
			restored.plugin.settings.oauthAuthorization?.grantId,
			logout ? undefined : "grant",
		);
		assert.equal(restored.plugin.settings.manualSyncRequired, true);
		assert.equal(restored.plugin.settings.encryptionPassword, null);
	}
});

test("authorization guard and failed persistence cannot publish a candidate or acknowledge activation", async () => {
	const { plugin, persistence } = persistenceHarness();
	await plugin.loadSettings();
	const candidate = {
		kind: "interactive" as const,
		token: "synthetic-new",
		authorization: {
			clientId: "public-client",
			grantId: "grant",
			refreshToken: null,
			expiresAt: null,
		},
	};
	await assert.rejects(
		persistence.persistAuthentication(candidate, () => {
			throw new Error("revoked attempt");
		}),
		/revoked attempt/,
	);
	plugin.saveData = async () => {
		throw new Error("synthetic storage failure");
	};
	await assert.rejects(
		persistence.persistAuthentication(candidate, () => {}),
		/storage failure/,
	);
	assert.equal(plugin.settings.yandexTokenSecret, "");
	assert.equal(plugin.settings.oauthAuthorization, null);
	assert.equal(persistence.failed, true);
});

test("refresh retains activation and manual credentials retire the managed grant atomically", async () => {
	for (const route of ["client-first", "token-only"]) {
		const { plugin, persistence } = persistenceHarness();
		await plugin.loadSettings();
		const authorization = {
			clientId: "public-client",
			grantId: "grant",
			refreshToken: "synthetic-refresh",
			expiresAt: null,
		};
		await persistence.persistAuthentication(
			{ kind: "interactive", token: "synthetic-access", authorization },
			() => {},
		);
		await persistence.completeManualSync(() => {});
		await persistence.persistAuthentication(
			{ kind: "refresh", token: "synthetic-renewed", authorization },
			() => {},
		);
		assert.equal(plugin.settings.manualSyncRequired, false);
		if (route === "client-first") {
			await plugin.applySettingsPatch({ clientId: "own-client" });
			assert.equal(plugin.settings.authMethod, "manual");
			assert.equal(plugin.settings.yandexTokenSecret, "");
			assert.equal(plugin.settings.oauthAuthorization, null);
			assert.equal(persistence.current?.settings.clientId, "own-client");
			assert.equal(persistence.current?.settings.yandexTokenSecret, "");
			assert.equal(
				persistence.current?.settings.oauthAuthorization,
				null,
			);
		}
		await plugin.applySettingsPatch({
			yandexTokenSecret: "synthetic-manual",
		});
		assert.equal(plugin.settings.authMethod, "manual");
		assert.equal(plugin.settings.oauthAuthorization, null);
		assert.equal(
			persistence.current?.settings.yandexTokenSecret,
			"synthetic-manual",
		);
		assert.equal(persistence.current?.settings.manualSyncRequired, true);
		await plugin.saveSettings();
		const restored = persistenceHarness(persistence.current);
		await restored.plugin.loadSettings();
		assert.equal(restored.plugin.settings.authMethod, "manual");
		assert.equal(restored.plugin.settings.oauthAuthorization, null);
		assert.equal(
			restored.plugin.settings.yandexTokenSecret,
			"synthetic-manual",
		);
		assert.equal(
			restored.plugin.settings.clientId,
			route === "client-first" ? "own-client" : "",
		);
	}
});
