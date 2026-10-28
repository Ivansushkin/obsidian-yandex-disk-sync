import assert from "node:assert/strict";
import test from "node:test";
import {
	OperationFailure,
	YandexApiError,
	NetworkRequestError,
	RemoteReadTimeoutError,
	decideRecovery,
	withFailureContext,
} from "../src/errors";
import { setLanguagePreference } from "../src/i18n";
import { translations } from "../src/i18n/translations";
import { createSyncFailure, formatOperationFailure } from "../src/sync/errors";
import {
	AmbiguousRemoteIndexStateError,
	RemoteIndexRolledBackError,
	ForceSourceChangedError,
} from "../src/sync/canonical/manager";

test("recovery policy preserves read write and polling limits and refuses unresolved or unknown retries", () => {
	for (const [error, kind, retry, confirm] of [
		[new YandexApiError("server", 500), "read", true, false],
		[new YandexApiError("server", 500), "put", false, false],
		[new YandexApiError("busy", 503), "put", true, true],
		[new YandexApiError("locked", 409), "poll", true, false],
		[new NetworkRequestError(new Error("socket")), "put", true, true],
		[new RemoteReadTimeoutError(10, "read"), "read", false, false],
		[new Error("unknown"), "write", false, false],
	] as const) {
		if (error instanceof RemoteReadTimeoutError) {
			withFailureContext(error, {
				stage: "upload-verification",
				action: "put",
				requestState: "completed",
			});
		}
		const failure = new OperationFailure(error, {
			stage: "transfer",
			action: kind,
		});
		if (error instanceof RemoteReadTimeoutError) {
			assert.equal(failure.summary.requestState, "unresolved");
		}
		assert.deepEqual(
			decideRecovery(failure, { attemptsRemaining: 1, remainingMs: 100 }),
			{ retry, confirm },
		);
		assert.equal(
			decideRecovery(failure, { attemptsRemaining: 0, remainingMs: 0 })
				.retry,
			false,
		);
	}
});

test("domain safety outranks nested transport failures and diagnostics exclude provider data", () => {
	const privateBody =
		"password=private OAuth abcdefghijklmn https://signed.example/file?secret=hidden";
	const provider = new YandexApiError(privateBody, 503, "ServiceUnavailable");
	const changed = new ForceSourceChangedError();
	Object.assign(changed, { cause: provider });
	const cases = [
		[changed, "force-source-changed"],
		[
			new OperationFailure(
				new NetworkRequestError(new Error("socket failed")),
				{ stage: "protective-backup", action: "local" },
				{ category: "safety", code: "mandatory-backup-failed" },
			),
			"mandatory-backup-failed",
		],
		[
			new AmbiguousRemoteIndexStateError(
				"Canonical recovery required",
				"acquired",
				provider,
			),
			"ambiguous-index-state",
		],
	] as const;
	for (const [error, code] of cases) {
		const failure = createSyncFailure(error, {
			stage: "canonical",
			action: "write",
		});
		assert.equal(failure.summary.category, "safety", code);
		assert.equal(failure.summary.code, code);
		assert.deepEqual(
			decideRecovery(failure, { attemptsRemaining: 3, remainingMs: 100 }),
			{ retry: false, confirm: false },
			code,
		);
		if (error === changed) {
			assert.equal(failure.cause, changed);
			const before = structuredClone(failure.summary);
			try {
				for (const language of [
					"en",
					"ru",
					"kk",
					"be",
					"uz",
				] as const) {
					setLanguagePreference(language);
					assert.ok(
						formatOperationFailure(failure.summary).includes(
							translations[language][
								"notice.force_source_changed"
							]!,
						),
					);
					assert.deepEqual(failure.summary, before);
					assert.equal(failure.cause, changed);
					assert.deepEqual(
						decideRecovery(failure, {
							attemptsRemaining: 3,
							remainingMs: 100,
						}),
						{ retry: false, confirm: false },
					);
				}
			} finally {
				setLanguagePreference("system");
			}
		}
	}
	for (const cause of [
		provider,
		new RemoteIndexRolledBackError(provider.message, "acquired", provider),
	]) {
		const failure = createSyncFailure(cause, {
			stage: "download",
			path: "note.md",
			action: "read",
		});
		const serialized = JSON.stringify(failure.summary);
		for (const secret of [
			"private",
			"abcdefghijklmn",
			"signed.example",
			"hidden",
			'"cause"',
		]) {
			assert.equal(serialized.includes(secret), false, secret);
		}
		assert.equal(failure.summary.httpStatus, 503);
	}
});
