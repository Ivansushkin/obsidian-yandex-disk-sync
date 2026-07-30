import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyIndex } from "../src/types";
import {
	collectPaginatedItems,
	collectStablePaginatedItems,
	didCanonicalChangeBeforeMaintenanceClaim,
	isOrphanIndexAmbiguous,
	stableSerialize,
	UnstablePaginationError,
} from "../src/sync/index-transaction-rules";

test("remote root pagination reads objects after the first 1000 entries", async () => {
	const source = Array.from({ length: 1001 }, (_, index) => index);
	const offsets: number[] = [];
	const items = await collectPaginatedItems(async (limit, offset) => {
		offsets.push(offset);
		return {
			items: source.slice(offset, offset + limit),
			total: source.length,
		};
	});

	assert.equal(items.length, 1001);
	assert.deepEqual(offsets, [0, 1000]);
	assert.equal(items[1000], 1000);
});

test("same-revision orphan with different state is ambiguous", () => {
	const canonical = createEmptyIndex("device-a");
	canonical.revision = 4;
	const orphan = structuredClone(canonical);
	orphan.deviceId = "device-b";

	assert.equal(isOrphanIndexAmbiguous(canonical, orphan), true);
	assert.equal(
		isOrphanIndexAmbiguous(canonical, structuredClone(canonical)),
		false,
	);
});

test("newer orphan is ambiguous while an older orphan is obsolete", () => {
	const canonical = createEmptyIndex("device-a");
	canonical.revision = 4;
	const newer = createEmptyIndex("device-b");
	newer.revision = 5;
	const older = createEmptyIndex("device-b");
	older.revision = 3;

	assert.equal(isOrphanIndexAmbiguous(canonical, newer), true);
	assert.equal(isOrphanIndexAmbiguous(canonical, older), false);
});

test("semantic index comparison ignores object insertion order", () => {
	assert.equal(
		stableSerialize({ files: { b: 2, a: 1 }, revision: 3 }),
		stableSerialize({ revision: 3, files: { a: 1, b: 2 } }),
	);
});

test("stable pagination requires two equal deduplicated snapshots", async () => {
	let snapshot = 0;
	const pages = [
		[
			{ path: "a", revision: "1" },
			{ path: "a", revision: "1" },
		],
		[{ path: "a", revision: "2" }],
		[{ path: "a", revision: "2" }],
	];
	const items = await collectStablePaginatedItems(
		async () => ({
			items: pages[snapshot++] ?? pages.at(-1)!,
			total: pages[Math.min(snapshot - 1, pages.length - 1)]!.length,
		}),
		(item) => item.path,
		(item) => item.revision,
	);
	assert.deepEqual(items, [{ path: "a", revision: "2" }]);
});

test("changing pagination fails closed", async () => {
	let revision = 0;
	await assert.rejects(
		collectStablePaginatedItems(
			async () => ({
				items: [{ path: "a", revision: String(revision++) }],
				total: 1,
			}),
			(item) => item.path,
			(item) => item.revision,
			3,
		),
		UnstablePaginationError,
	);
});

test("maintenance claim is rejected after a concurrent canonical revision", () => {
	assert.equal(
		didCanonicalChangeBeforeMaintenanceClaim(7, 8),
		true,
	);
	assert.equal(
		didCanonicalChangeBeforeMaintenanceClaim(7, 7),
		false,
	);
});
