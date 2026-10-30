import assert from "node:assert/strict";
import test from "node:test";
import { applyAuthenticationUpdate } from "../src/settings-workflow";
import { AuthorizationError } from "../src/auth/yandex-authorization";
import { persistenceHarness } from "./helpers/lifecycle-fixtures";
import type { RemoteStorageScope } from "../src/types";

async function host() {
	const { plugin, persistence } = persistenceHarness();
	await plugin.loadSettings();
	await plugin.applySettingsPatch({ yandexTokenSecret: "synthetic-old" });
	await persistence.completeManualSync(() => {});
	const expected = {
		remotePath: plugin.settings.remotePath,
		rootResourceId: "root",
	};
	const listeners = new Set<() => void>();
	let busy = false;
	let nativeWrites = 0;
	let root: RemoteStorageScope | null = expected;
	const deps = {
		getSettings: () => plugin.settings,
		getExpectedScope: () => expected,
		hasHistory: () => true,
		isBusy: () => busy,
		isUnloaded: () => plugin.isPluginUnloaded(),
		nativeWrites: () => nativeWrites,
		subscribeActivity: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		setUpdating: (value: boolean) => {
			busy = value;
		},
		waitForWatcherPersistence: async () => {},
		readCandidateRoot: async () => root,
		persist: persistence.persistAuthentication.bind(persistence),
	};
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
	const attempt = {
		assertCurrent: () => {},
		accept: () => {},
		phase: () => {},
	};
	return {
		plugin,
		persistence,
		deps,
		candidate,
		attempt,
		setRoot: (value: RemoteStorageScope | null) => {
			root = value;
		},
		setNativeWrites: (value: number) => {
			nativeWrites = value;
			for (const listener of listeners) {
				listener();
			}
		},
	};
}

test("authorization adoption waits for native writes and owns its reservation without blocking itself", async () => {
	const h = await host();
	h.setNativeWrites(1);
	const adopted = applyAuthenticationUpdate(h.deps, h.candidate, h.attempt);
	assert.equal(h.plugin.settings.yandexTokenSecret, "synthetic-old");
	h.setNativeWrites(0);
	await adopted;
	assert.equal(h.plugin.settings.yandexTokenSecret, "synthetic-new");
	assert.equal(h.plugin.settings.manualSyncRequired, true);
	assert.equal(h.deps.isBusy(), false);
});

test("candidate root rejection preserves the old admitted connection and releases its gate", async () => {
	for (const root of [
		null,
		{ remotePath: "other", rootResourceId: "wrong" },
	]) {
		const h = await host();
		h.setRoot(root);
		await assert.rejects(
			applyAuthenticationUpdate(h.deps, h.candidate, h.attempt),
			(error) =>
				error instanceof AuthorizationError &&
				(error.code === "root-mismatch" ||
					error.code === "root-unavailable"),
		);
		assert.equal(h.plugin.settings.yandexTokenSecret, "synthetic-old");
		assert.equal(h.plugin.settings.manualSyncRequired, false);
		assert.equal(h.persistence.current?.settings.authMethod, "manual");
		assert.equal(h.deps.isBusy(), false);
	}
});
