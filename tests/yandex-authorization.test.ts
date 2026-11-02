import assert from "node:assert/strict";
import test from "node:test";
import {
	YandexAuthorization,
	AuthorizationError,
	type OAuthResponse,
} from "../src/auth/yandex-authorization";
import { persistenceHarness } from "./helpers/lifecycle-fixtures";
import { deferred } from "./helpers/deferred";
import { afterTest } from "./helpers/test-context";

const tokenResponse = (token: string): OAuthResponse => ({
	status: 200,
	json: { access_token: token, token_type: "bearer", expires_in: 3600 },
});

async function authorization(
	request: (body: URLSearchParams) => Promise<OAuthResponse>,
) {
	const { plugin, persistence } = persistenceHarness();
	await plugin.loadSettings();
	let revision = 0;
	const controller = new YandexAuthorization({
		clientId: "public-test-client",
		clientSecret: "synthetic-client-secret",
		vaultName: () => "test vault",
		deviceId: () => plugin.settings.deviceId,
		request,
		captureContext: () => {
			const captured = revision;
			return {
				assertCurrent: () => {
					if (captured !== revision) {
						throw new Error("context changed");
					}
				},
				assertContinuation: () => {},
			};
		},
		adopt: async (update, attempt) => {
			attempt.assertCurrent();
			await persistence.persistAuthentication(update, () => {
				attempt.assertCurrent();
				attempt.accept();
			});
		},
		synchronize: () => persistence.completeManualSync(() => {}),
	});
	return {
		controller,
		plugin,
		persistence,
		revoke: () => {
			revision++;
		},
	};
}

test("PKCE authorization ignores foreign callbacks and activates one persisted grant", async (t) => {
	let authUrl: URL;
	let requests = 0;
	const h = await authorization(async (body) => {
		requests++;
		const challenge = Buffer.from(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(body.get("code_verifier")!),
			),
		).toString("base64url");
		assert.equal(challenge, authUrl.searchParams.get("code_challenge"));
		assert.equal(body.has("client_secret"), false);
		return tokenResponse("synthetic-access");
	});
	afterTest(t, () => h.controller.dispose());
	authUrl = new URL(await h.controller.begin());
	assert.equal(
		new URL(authUrl.searchParams.get("redirect_uri")!).searchParams.get(
			"vault",
		),
		"test vault",
	);
	assert.equal(
		await h.controller.acceptCallback({
			state: "foreign",
			code: "synthetic-code",
		}),
		false,
	);
	assert.equal(h.controller.getState().phase, "waiting-browser");
	const callback = {
		state: authUrl.searchParams.get("state")!,
		code: "synthetic-code",
	};
	await h.controller.acceptCallback(callback);
	assert.equal(await h.controller.acceptCallback(callback), false);
	assert.equal(requests, 1);
	assert.equal(h.plugin.settings.yandexTokenSecret, "synthetic-access");
	assert.equal(h.plugin.settings.authMethod, "oauth");
	assert.equal(h.plugin.settings.manualSyncRequired, false);
});

test("refresh saves rotated credentials once and preserves the grant", async (t) => {
	const bodies: URLSearchParams[] = [];
	const h = await authorization(async (body) => {
		bodies.push(body);
		if (body.get("grant_type") === "authorization_code") {
			return {
				status: 200,
				json: {
					access_token: "initial-access",
					refresh_token: "initial-refresh",
					token_type: "bearer",
					expires_in: 3600,
				},
			};
		}
		return {
			status: 200,
			json: {
				access_token: "initial-access",
				refresh_token: "rotated-refresh",
				token_type: "bearer",
				expires_in: 7200,
			},
		};
	});
	afterTest(t, () => h.controller.dispose());
	const url = new URL(await h.controller.begin());
	await h.controller.acceptCallback({
		state: url.searchParams.get("state")!,
		code: "synthetic-code",
	});
	const initial = h.plugin.settings.oauthAuthorization;
	assert.ok(initial);
	assert.equal(initial.refreshToken, "initial-refresh");
	const current = {
		token: h.plugin.settings.yandexTokenSecret,
		authorization: initial,
	};
	const adopt = (
		update: Parameters<typeof h.persistence.persistAuthentication>[0],
		guard: () => void,
	) => h.persistence.persistAuthentication(update, guard);
	await Promise.all([
		h.controller.refresh(current, () => {}, adopt),
		h.controller.refresh(current, () => {}, adopt),
	]);
	assert.equal(bodies.length, 2);
	assert.equal(bodies[0]?.has("client_secret"), false);
	assert.equal(bodies[1]?.get("client_secret"), "synthetic-client-secret");
	assert.equal(bodies[1]?.get("refresh_token"), "initial-refresh");
	assert.equal(h.plugin.settings.yandexTokenSecret, "initial-access");
	assert.equal(
		h.plugin.settings.oauthAuthorization?.refreshToken,
		"rotated-refresh",
	);
	assert.equal(
		h.plugin.settings.oauthAuthorization?.grantId,
		initial.grantId,
	);
	assert.equal(h.plugin.settings.manualSyncRequired, false);
});

test("failed refresh and failed credential save retain the prior grant", async (t) => {
	let refreshRequests = 0;
	let refreshResponse: OAuthResponse | Error = {
		status: 400,
		json: {
			error: "invalid_grant",
			error_description: "private-provider-text",
		},
	};
	const h = await authorization(async (body) => {
		if (body.get("grant_type") === "authorization_code") {
			return {
				status: 200,
				json: {
					access_token: "initial-access",
					refresh_token: "initial-refresh",
					token_type: "bearer",
					expires_in: 3600,
				},
			};
		}
		refreshRequests++;
		if (refreshResponse instanceof Error) {
			throw refreshResponse;
		}
		return refreshResponse;
	});
	afterTest(t, () => h.controller.dispose());
	const url = new URL(await h.controller.begin());
	await h.controller.acceptCallback({
		state: url.searchParams.get("state")!,
		code: "synthetic-code",
	});
	const initial = h.plugin.settings.oauthAuthorization;
	assert.ok(initial);
	const current = {
		token: h.plugin.settings.yandexTokenSecret,
		authorization: initial,
	};
	const adopt = (
		update: Parameters<typeof h.persistence.persistAuthentication>[0],
		guard: () => void,
	) => h.persistence.persistAuthentication(update, guard);
	assert.equal(
		await h.controller.ensureFresh(current, true, () => {}, adopt),
		"reauthorize",
	);
	assert.equal(
		await h.controller.ensureFresh(current, true, () => {}, adopt),
		"reauthorize",
	);
	assert.equal(refreshRequests, 1);
	h.controller.resetRefreshState();
	for (const refusal of [
		{ status: 403, json: null },
		{
			status: 200,
			json: {
				access_token: "limited-access",
				refresh_token: "limited-refresh",
				token_type: "bearer",
				expires_in: 3600,
				scope: "cloud_api:disk.read",
			},
		},
	]) {
		refreshResponse = refusal;
		const before: number = refreshRequests;
		assert.equal(
			await h.controller.ensureFresh(current, true, () => {}, adopt),
			"reauthorize",
		);
		assert.equal(
			await h.controller.ensureFresh(current, true, () => {}, adopt),
			"reauthorize",
		);
		assert.equal(refreshRequests, before + 1);
		h.controller.resetRefreshState();
	}
	refreshResponse = new Error("private-network-details");
	assert.equal(
		await h.controller.ensureFresh(current, true, () => {}, adopt),
		"temporary",
	);
	assert.equal(
		await h.controller.ensureFresh(current, true, () => {}, adopt),
		"cooldown",
	);
	assert.equal(refreshRequests, 4);
	h.controller.resetRefreshState();
	refreshResponse = {
		status: 200,
		json: {
			access_token: "new-access",
			refresh_token: "new-refresh",
			token_type: "bearer",
			expires_in: 3600,
		},
	};
	h.plugin.saveData = async () => {
		throw new Error("private-storage-details");
	};
	assert.deepEqual(
		await h.controller.ensureFresh(current, true, () => {}, adopt),
		{ kind: "failed", reason: "storage" },
	);
	assert.equal(h.plugin.settings.yandexTokenSecret, "initial-access");
	assert.equal(
		h.plugin.settings.oauthAuthorization?.refreshToken,
		"initial-refresh",
	);
});

test("revoked refresh response cannot replace saved credentials", async (t) => {
	const refreshResponse = deferred<OAuthResponse>();
	const entered = deferred();
	const h = await authorization(async (body) => {
		if (body.get("grant_type") === "refresh_token") {
			entered.resolve();
			return refreshResponse.promise;
		}
		return {
			status: 200,
			json: {
				access_token: "initial-access",
				refresh_token: "initial-refresh",
				token_type: "bearer",
				expires_in: 3600,
			},
		};
	});
	afterTest(t, () => h.controller.dispose());
	const url = new URL(await h.controller.begin());
	await h.controller.acceptCallback({
		state: url.searchParams.get("state")!,
		code: "synthetic-code",
	});
	const savedAuthorization = h.plugin.settings.oauthAuthorization;
	assert.ok(savedAuthorization);
	let current = true;
	const refresh = h.controller.refresh(
		{
			token: h.plugin.settings.yandexTokenSecret,
			authorization: savedAuthorization,
		},
		() => {
			if (!current) {
				throw new AuthorizationError("revoked");
			}
		},
		(update, guard) => h.persistence.persistAuthentication(update, guard),
	);
	await entered.promise;
	current = false;
	refreshResponse.resolve({
		status: 200,
		json: {
			access_token: "late-access",
			refresh_token: "late-refresh",
			token_type: "bearer",
			expires_in: 3600,
		},
	});
	await assert.rejects(
		refresh,
		(error) =>
			error instanceof AuthorizationError && error.code === "revoked",
	);
	assert.equal(h.plugin.settings.yandexTokenSecret, "initial-access");
	assert.equal(
		h.plugin.settings.oauthAuthorization?.refreshToken,
		"initial-refresh",
	);
});

test("revoked native exchanges cannot publish or admit another POST before real settlement", async (t) => {
	const oldResponse = deferred<OAuthResponse>();
	const firstEntered = deferred();
	let requests = 0;
	const h = await authorization(async () => {
		requests++;
		if (requests === 1) {
			firstEntered.resolve();
			return oldResponse.promise;
		}
		return tokenResponse("synthetic-current");
	});
	afterTest(t, () => h.controller.dispose());
	const first = new URL(await h.controller.begin());
	const old = h.controller.acceptCallback({
		state: first.searchParams.get("state")!,
		code: "first",
	});
	const rejected = assert.rejects(
		old,
		(error) =>
			error instanceof AuthorizationError && error.code === "revoked",
	);
	await firstEntered.promise;
	h.controller.cancel();
	await rejected;
	const second = new URL(await h.controller.begin());
	const current = h.controller.acceptCallback({
		state: second.searchParams.get("state")!,
		code: "second",
	});
	assert.equal(requests, 1);
	oldResponse.resolve(tokenResponse("synthetic-stale"));
	await current;
	assert.equal(requests, 2);
	assert.equal(h.plugin.settings.yandexTokenSecret, "synthetic-current");
});

test("callback rejects stale contexts and provider errors without exposing response data", async (t) => {
	const response = deferred<OAuthResponse>();
	const entered = deferred();
	const h = await authorization(async () => {
		entered.resolve();
		return response.promise;
	});
	afterTest(t, () => h.controller.dispose());
	const url = new URL(await h.controller.begin());
	assert.equal(
		new URL(url.searchParams.get("redirect_uri")!).protocol,
		"obsidian:",
	);
	const stale = h.controller.acceptCallback({
		state: url.searchParams.get("state")!,
		code: "synthetic-code",
	});
	const rejected = assert.rejects(
		stale,
		(error) =>
			error instanceof AuthorizationError && error.code === "revoked",
	);
	await entered.promise;
	h.revoke();
	response.resolve(tokenResponse("synthetic-revoked"));
	await rejected;
	assert.equal(h.plugin.settings.yandexTokenSecret, "");
	const denied = await authorization(async () => ({
		status: 400,
		json: { error: "invalid_grant", error_description: "private-sentinel" },
	}));
	afterTest(t, () => denied.controller.dispose());
	const deniedUrl = new URL(await denied.controller.begin());
	await assert.rejects(
		denied.controller.acceptCallback({
			state: deniedUrl.searchParams.get("state")!,
			code: "bad",
		}),
		(error) =>
			error instanceof AuthorizationError &&
			error.code === "invalid-code" &&
			!error.message.includes("private-sentinel"),
	);
	assert.equal(denied.plugin.settings.yandexTokenSecret, "");
});

test("failed accepted credential save releases authorization admission without publishing a grant", async (t) => {
	const h = await authorization(async () =>
		tokenResponse("synthetic-access"),
	);
	afterTest(t, () => h.controller.dispose());
	h.plugin.saveData = async () => {
		throw new Error("synthetic storage failure");
	};
	const url = new URL(await h.controller.begin());
	await assert.rejects(
		h.controller.acceptCallback({
			state: url.searchParams.get("state")!,
			code: "synthetic-code",
		}),
		(error) =>
			error instanceof AuthorizationError && error.code === "storage",
	);
	assert.equal(h.controller.blocksOperations, false);
	assert.equal(h.controller.getState().phase, "error");
	assert.equal(h.plugin.settings.yandexTokenSecret, "");
});
