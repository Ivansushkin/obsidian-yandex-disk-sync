import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyIndexMoveRecovery,
	rawBuffersEqual,
	rollbackRawIndexSnapshot,
	shouldRetryIndexTransaction,
} from "../src/sync/index-transaction";

test("successful but timed out canonical move is classified as committed", () => {
	assert.equal(
		classifyIndexMoveRecovery({
			canonicalExists: true,
			lockExists: false,
			canonicalReadable: true,
			lockReadable: false,
			canonicalMatchesExpected: true,
			lockMatchesExpected: false,
		}),
		"committed",
	);
});

test("verified lock without canonical retries only the final move", () => {
	assert.equal(
		classifyIndexMoveRecovery({
			canonicalExists: false,
			lockExists: true,
			canonicalReadable: false,
			lockReadable: true,
			canonicalMatchesExpected: false,
			lockMatchesExpected: true,
		}),
		"retry-move",
	);
});

test("different canonical is concurrent and dual state is ambiguous", () => {
	assert.equal(
		classifyIndexMoveRecovery({
			canonicalExists: true,
			lockExists: false,
			canonicalReadable: true,
			lockReadable: false,
			canonicalMatchesExpected: false,
			lockMatchesExpected: false,
		}),
		"concurrent",
	);
	assert.equal(
		classifyIndexMoveRecovery({
			canonicalExists: true,
			lockExists: true,
			canonicalReadable: true,
			lockReadable: true,
			canonicalMatchesExpected: true,
			lockMatchesExpected: true,
		}),
		"ambiguous",
	);
});

test("transaction retry requires rollback or ordinary contention", () => {
	assert.equal(shouldRetryIndexTransaction("rolled-back"), true);
	assert.equal(shouldRetryIndexTransaction("concurrent"), false);
	assert.equal(shouldRetryIndexTransaction("ambiguous"), false);
	assert.equal(shouldRetryIndexTransaction("concurrent", true), true);
});

test("raw rollback comparison is byte exact", () => {
	assert.equal(
		rawBuffersEqual(
			new Uint8Array([1, 2, 3]).buffer,
			new Uint8Array([1, 2, 3]).buffer,
		),
		true,
	);
	assert.equal(
		rawBuffersEqual(
			new Uint8Array([1, 2, 3]).buffer,
			new Uint8Array([1, 2, 4]).buffer,
		),
		false,
	);
});

function createRawBackend(
	initial: Record<string, number[]>,
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
				if (!value) throw new Error(`Missing ${path}`);
				return value.slice(0);
			},
			async writeRaw(path: string, raw: ArrayBuffer): Promise<void> {
				files.set(path, raw.slice(0));
				if (throwAfterWrite) throw new Error("lost upload response");
			},
			async moveExclusive(
				fromPath: string,
				toPath: string,
			): Promise<void> {
				if (files.has(toPath)) throw new Error("target exists");
				const value = files.get(fromPath);
				if (!value) throw new Error("source missing");
				files.set(toPath, value);
				files.delete(fromPath);
				if (throwAfterMove) throw new Error("lost response");
			},
		},
	};
}

test("modified encrypted lock rolls back byte-for-byte", async () => {
	const fake = createRawBackend({ lock: [9, 9, 9] });
	const original = new Uint8Array([31, 8, 240, 17]).buffer;
	const outcome = await rollbackRawIndexSnapshot(
		fake.backend,
		"lock",
		"canonical",
		original,
		async (raw) => assert.equal(raw.byteLength, 4),
	);

	assert.equal(outcome, "rolled-back");
	assert.equal(fake.files.has("lock"), false);
	assert.equal(
		rawBuffersEqual(fake.files.get("canonical")!, original),
		true,
	);
});

test("rollback recognizes a successful move with a lost response", async () => {
	const fake = createRawBackend({ lock: [4, 5] }, true);
	const original = new Uint8Array([1, 2, 3]).buffer;
	const outcome = await rollbackRawIndexSnapshot(
		fake.backend,
		"lock",
		"canonical",
		original,
		async () => undefined,
	);

	assert.equal(outcome, "rolled-back");
	assert.equal(fake.files.has("lock"), false);
});

test("rollback recognizes a successful raw restore with a lost response", async () => {
	const fake = createRawBackend({ lock: [4, 5] }, false, true);
	const original = new Uint8Array([1, 2, 3]).buffer;
	const outcome = await rollbackRawIndexSnapshot(
		fake.backend,
		"lock",
		"canonical",
		original,
		async () => undefined,
	);

	assert.equal(outcome, "rolled-back");
	assert.equal(
		rawBuffersEqual(fake.files.get("canonical")!, original),
		true,
	);
});

test("rollback preserves ambiguous canonical and lock", async () => {
	const fake = createRawBackend({
		lock: [7],
		canonical: [8],
	});
	const outcome = await rollbackRawIndexSnapshot(
		fake.backend,
		"lock",
		"canonical",
		new Uint8Array([1]).buffer,
		async () => undefined,
	);

	assert.equal(outcome, "ambiguous");
	assert.deepEqual([...fake.files.keys()].sort(), ["canonical", "lock"]);
});
