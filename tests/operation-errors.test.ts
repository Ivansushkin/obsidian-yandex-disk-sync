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
import { createSyncFailure } from "../src/sync/errors";
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

test("domain safety retains priority and summaries exclude credentials and signed links", () => {
	const guard = new ForceSourceChangedError();
	Object.assign(guard, {
		cause: new YandexApiError(
			"password=private OAuth abcdefghijklmn https://signed.example/file?secret=hidden",
			403,
		),
	});
	const failure = createSyncFailure(guard, {
		stage: "preflight",
		action: "write",
	});
	assert.equal(failure.summary.category, "safety");
	assert.equal(failure.summary.code, "force-source-changed");
	assert.equal(failure.cause, guard);
	const transport = new OperationFailure(
		(guard as Error & { cause: Error }).cause,
		{ stage: "download", path: "note.md", action: "read" },
	);
	const serialized = JSON.stringify(transport.summary);
	for (const secret of [
		"private",
		"abcdefghijklmn",
		"signed.example",
		"hidden",
	]) {
		assert.equal(serialized.includes(secret), false);
	}
	assert.equal(serialized.includes('"cause"'), false);
});

test("mandatory backup failure outranks a nested transport error without retry", () => {
	const failure = new OperationFailure(
		new NetworkRequestError(new Error("socket failed")),
		{ stage: "protective-backup", action: "local" },
		{ category: "safety", code: "mandatory-backup-failed" },
	);
	const adapted = createSyncFailure(failure, {
		stage: "download",
		action: "read",
	});
	assert.equal(adapted.summary.code, "mandatory-backup-failed");
	assert.equal(adapted.summary.category, "safety");
	assert.deepEqual(
		decideRecovery(adapted, { attemptsRemaining: 3, remainingMs: 100 }),
		{ retry: false, confirm: false },
	);
});

test("canonical ambiguity outranks transport and rollback wrappers do not expose provider bodies", () => {
	const provider = new YandexApiError(
		"provider-private-body",
		503,
		"ServiceUnavailable",
	);
	const ambiguous = createSyncFailure(
		new AmbiguousRemoteIndexStateError(
			"Canonical recovery required",
			"acquired",
			provider,
		),
		{ stage: "canonical", action: "write" },
	);
	assert.equal(ambiguous.summary.category, "safety");
	assert.equal(ambiguous.summary.code, "ambiguous-index-state");
	assert.deepEqual(
		decideRecovery(ambiguous, { attemptsRemaining: 3, remainingMs: 100 }),
		{ retry: false, confirm: false },
	);
	const rollback = createSyncFailure(
		new RemoteIndexRolledBackError(provider.message, "acquired", provider),
		{ stage: "canonical", action: "write" },
	);
	assert.equal(
		JSON.stringify(rollback.summary).includes("provider-private-body"),
		false,
	);
	assert.equal(rollback.summary.httpStatus, 503);
});
