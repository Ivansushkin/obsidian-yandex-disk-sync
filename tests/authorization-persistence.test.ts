import assert from "node:assert/strict";
import test from "node:test";
import { persistenceHarness } from "./helpers/lifecycle-fixtures";
import { deferred } from "./helpers/deferred";
import { logger } from "../src/utils/logger";
import type { PluginData } from "../src/plugin-persistence";

test("authorization defaults preserve existing manual connections and incomplete setup", async () => {
	const seed = persistenceHarness();
	await seed.plugin.loadSettings();
	for (const previous of ["fresh", "token", "client"] as const) {
		const data = structuredClone(seed.writes.at(-1)) as PluginData;
		Reflect.deleteProperty(data.settings, "authMethod");
		Reflect.deleteProperty(data.settings, "oauthAuthorization");
		data.settings.yandexTokenSecret =
			previous === "token" ? "synthetic-old" : "";
		data.settings.clientId =
			previous === "client" ? "synthetic-client" : "";
		data.settings.manualSyncRequired = false;
		const { plugin } = persistenceHarness(
			previous === "fresh" ? null : data,
		);
		await plugin.loadSettings();
		assert.equal(
			plugin.settings.authMethod,
			previous === "fresh" ? "oauth" : "manual",
		);
		assert.equal(plugin.settings.oauthAuthorization, null);
		assert.equal(plugin.settings.manualSyncRequired, previous === "fresh");
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

test("accepted authorization survives unload publication revocation and later snapshot writes", async () => {
	const { plugin, persistence, writes } = persistenceHarness();
	await plugin.loadSettings();
	const entered = deferred();
	const release = deferred();
	plugin.saveData = async (data) => {
		writes.push(structuredClone(data));
		entered.resolve();
		await release.promise;
	};
	const update = persistence.persistAuthentication(
		{
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
	assert.equal(plugin.settings.yandexTokenSecret, "");
	const stored = (writes.at(-1) as PluginData).settings;
	assert.equal(stored.yandexTokenSecret, "synthetic-new");
	assert.equal(stored.authMethod, "oauth");
	assert.equal(stored.oauthAuthorization?.grantId, "grant");
	assert.equal(stored.manualSyncRequired, true);
	const restored = persistenceHarness(writes.at(-1));
	await restored.plugin.loadSettings();
	assert.equal(restored.plugin.settings.oauthAuthorization?.grantId, "grant");
	assert.equal(restored.plugin.settings.manualSyncRequired, true);
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
	await plugin.applySettingsPatch({ yandexTokenSecret: "synthetic-manual" });
	assert.equal(plugin.settings.authMethod, "manual");
	assert.equal(plugin.settings.oauthAuthorization, null);
	assert.equal(
		persistence.current?.settings.yandexTokenSecret,
		"synthetic-manual",
	);
	assert.equal(persistence.current?.settings.manualSyncRequired, true);
});
