import assert from "node:assert/strict";
import test from "node:test";
import { runWithConcurrencySettled } from "../src/utils/semaphore";

test("stopped batch drains started work and preserves queued failures", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let fail!: () => void;
	const failureGate = new Promise<void>((resolve) => {
		fail = resolve;
	});
	let observedError!: () => void;
	const errorSeen = new Promise<void>((resolve) => {
		observedError = resolve;
	});
	const timeout = new Error("synthetic read deadline");
	const started: number[] = [];
	const progress: number[] = [];
	let settled = false;
	const batch = runWithConcurrencySettled(
		[
			async () => {
				started.push(1);
				await failureGate;
				throw timeout;
			},
			async () => {
				started.push(2);
				await gate;
				return "completed";
			},
			async () => {
				started.push(3);
				return "must not start";
			},
		],
		2,
		(completed) => progress.push(completed),
		{
			stopOnError: (error) => error === timeout,
			onError: () => observedError(),
		},
	).then((result) => {
		settled = true;
		return result;
	});
	fail();
	try {
		await errorSeen;
		assert.equal(
			settled,
			false,
			"The started second task still owns the session",
		);
		assert.deepEqual(started, [1, 2]);
	} finally {
		release();
	}
	const outcomes = await batch;
	assert.deepEqual(outcomes, [
		{ status: "rejected", reason: timeout },
		{ status: "fulfilled", value: "completed" },
		{ status: "rejected", reason: timeout },
	]);
	assert.deepEqual(started, [1, 2]);
	assert.deepEqual(progress, [1, 2]);
});
