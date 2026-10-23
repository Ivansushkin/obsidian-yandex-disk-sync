import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyIndexMoveRecovery,
	rollbackRawIndexSnapshot,
	shouldRetryIndexTransaction,
} from "../src/sync/canonical/transaction";

test("canonical move recovery classifies authority and retry eligibility", () => {
	for (const [canonical, lock, matches, outcome] of [
		[true, false, true, "committed"],
		[false, true, true, "retry-move"],
		[true, false, false, "concurrent"],
		[true, true, true, "ambiguous"],
	] as const) {
		const actual = classifyIndexMoveRecovery({
			canonicalExists: canonical,
			lockExists: lock,
			canonicalReadable: canonical,
			lockReadable: lock,
			canonicalMatchesExpected: canonical && matches,
			lockMatchesExpected: lock && matches,
		});
		assert.equal(
			actual,
			outcome,
			JSON.stringify({ canonical, lock, matches }),
		);
	}
	for (const outcome of ["committed", "concurrent", "ambiguous"] as const) {
		assert.equal(shouldRetryIndexTransaction(outcome), false, outcome);
	}
	assert.equal(shouldRetryIndexTransaction("rolled-back"), true);
	assert.equal(shouldRetryIndexTransaction("concurrent", true), true);
});

function createRawBackend(
	initial: Record<string, readonly number[]>,
	throwAfterMove = false,
	throwAfterWrite = false,
) {
	const files = new Map(
		Object.entries(initial).map(([path, bytes]) => [
			path,
			new Uint8Array(bytes).buffer,
		]),
	);
	return {
		files,
		backend: {
			async exists(path: string): Promise<boolean> {
				return files.has(path);
			},
			async readRaw(path: string): Promise<ArrayBuffer> {
				const value = files.get(path);
				if (!value) {
					throw new Error(`Missing ${path}`);
				}
				return value.slice(0);
			},
			async writeRaw(path: string, raw: ArrayBuffer): Promise<void> {
				files.set(path, raw.slice(0));
				if (throwAfterWrite) {
					throw new Error("lost upload response");
				}
			},
			async moveExclusive(
				fromPath: string,
				toPath: string,
			): Promise<void> {
				if (files.has(toPath)) {
					throw new Error("target exists");
				}
				const value = files.get(fromPath);
				if (!value) {
					throw new Error("source missing");
				}
				files.set(toPath, value);
				files.delete(fromPath);
				if (throwAfterMove) {
					throw new Error("lost response");
				}
			},
		},
	};
}

test("raw rollback preserves exact bytes across lost responses and ambiguous ownership", async () => {
	const original = new Uint8Array([31, 8, 240, 17]).buffer;
	for (const [fault, initial, expected] of [
		["none", { lock: [9, 9, 9] }, "rolled-back"],
		["move", { lock: [4, 5] }, "rolled-back"],
		["write", { lock: [4, 5] }, "rolled-back"],
		["ambiguous", { lock: [7], canonical: [8] }, "ambiguous"],
	] as const) {
		const fake = createRawBackend(
			initial,
			fault === "move",
			fault === "write",
		);
		const outcome = await rollbackRawIndexSnapshot(
			fake.backend,
			"lock",
			"canonical",
			original,
			async (raw) =>
				assert.equal(raw.byteLength, original.byteLength, fault),
		);
		assert.equal(outcome, expected, fault);
		const contents = Object.fromEntries(
			[...fake.files].map(([path, bytes]) => [
				path,
				[...new Uint8Array(bytes)],
			]),
		);
		assert.deepEqual(
			contents,
			expected === "ambiguous"
				? initial
				: { canonical: [...new Uint8Array(original)] },
			fault,
		);
	}
});
