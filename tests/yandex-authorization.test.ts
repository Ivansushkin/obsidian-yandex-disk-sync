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
		callbackSupported: true,
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
	authUrl = new URL(await h.controller.begin("callback"));
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
	const first = new URL(await h.controller.begin("callback"));
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
	const second = new URL(await h.controller.begin("callback"));
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

test("manual-code fallback rejects stale contexts and provider errors without exposing response data", async (t) => {
	const response = deferred<OAuthResponse>();
	const entered = deferred();
	const h = await authorization(async () => {
		entered.resolve();
		return response.promise;
	});
	afterTest(t, () => h.controller.dispose());
	const url = new URL(await h.controller.begin("code"));
	assert.equal(
		url.searchParams.get("redirect_uri"),
		"https://oauth.yandex.ru/verification_code",
	);
	const stale = h.controller.submitCode("synthetic-code");
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
	await denied.controller.begin("code");
	await assert.rejects(
		denied.controller.submitCode("bad"),
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
	await h.controller.begin("code");
	await assert.rejects(
		h.controller.submitCode("synthetic-code"),
		(error) =>
			error instanceof AuthorizationError && error.code === "storage",
	);
	assert.equal(h.controller.blocksOperations, false);
	assert.equal(h.controller.getState().phase, "error");
	assert.equal(h.plugin.settings.yandexTokenSecret, "");
});
