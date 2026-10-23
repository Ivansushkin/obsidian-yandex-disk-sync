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
} from "../src/sync/canonical/transaction-rules";

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

test("orphan authority and semantic identity retain meaningful JSON differences", () => {
	const canonical = createEmptyIndex("device-a");
	canonical.revision = 4;
	for (const [revision, deviceId, ambiguous] of [
		[4, "device-b", true],
		[4, "device-a", false],
		[5, "device-b", true],
		[3, "device-b", false],
	] as const) {
		assert.equal(
			didCanonicalChangeBeforeMaintenanceClaim(
				canonical.revision,
				revision,
			),
			revision !== canonical.revision,
			`claim after revision ${revision}`,
		);
		assert.equal(
			isOrphanIndexAmbiguous(canonical, {
				...canonical,
				revision,
				deviceId,
			}),
			ambiguous,
			`${deviceId}@${revision}`,
		);
	}
	for (const [label, left, right, equal] of [
		[
			"insertion order",
			{ files: { b: 2, a: 1 }, revision: 3 },
			{ revision: 3, files: { a: 1, b: 2 } },
			true,
		],
		[
			"omitted optional property",
			{ revision: 3, maintenance: undefined },
			{ revision: 3 },
			true,
		],
		["array undefined", [1, undefined, 3], [1, null, 3], true],
		[
			"explicit null",
			{ revision: 3, maintenance: null },
			{ revision: 3 },
			false,
		],
		[
			"nested value",
			{ files: [{ size: 1 }] },
			{ files: [{ size: 2 }] },
			false,
		],
	] as const) {
		assert.equal(
			stableSerialize(left) === stableSerialize(right),
			equal,
			label,
		);
	}
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

test("stable pagination includes the root state in its snapshot identity", async () => {
	const states = ["missing", "exists", "exists"];
	let snapshot = -1;
	let rootState = "missing";
	const items = await collectStablePaginatedItems(
		async () => {
			rootState = states[++snapshot] ?? "exists";
			return { items: [], total: 0 };
		},
		(item: { path: string }) => item.path,
		() => "",
		4,
		() => rootState,
	);
	assert.deepEqual(items, []);
	assert.equal(snapshot, 2);
});
