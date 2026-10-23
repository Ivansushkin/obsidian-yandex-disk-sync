import { fileMetadata } from "./helpers/metadata";
import assert from "node:assert/strict";
import test from "node:test";
import type { FileMetadata, FolderTombstone } from "../src/types";
import {
	classifyFileMutation,
	classifyIndexFormat,
	canApplyDestructiveFolderMutation,
	collectFolderDeleteTargets,
	findFolderTombstone,
	isStableLockStale,
	mergeFileMutation,
	shouldPreserveConcurrentFolderChild,
	advanceMutationSequence,
} from "../src/sync/canonical/mutation-rules";

const file = fileMetadata;

function tombstone(path: string, changedRevision: number): FolderTombstone {
	return {
		path,
		deletedAt: 1,
		changedRevision,
		baseRevision: changedRevision - 1,
		lastModifiedBy: "device",
	};
}

test("folder delete planning skips history, siblings and folder roots at any depth", () => {
	const deep = Array.from({ length: 100 }, (_, index) => `d${index}`).join(
		"/",
	);
	for (const { label, folder, live, deleted, unrelated = [] } of [
		{
			label: "rename history",
			folder: "folder",
			live: ["folder/Чо как.md"],
			deleted: ["folder/Без названия.md"],
		},
		{
			label: "only tombstones",
			folder: "folder",
			live: [],
			deleted: ["folder/old.md"],
		},
		{
			label: "segment boundary and trailing slash",
			folder: "folder/",
			live: ["folder/deep/note.md"],
			deleted: ["folder/deep/old.md"],
			unrelated: ["folder", "folder-copy/note.md"],
		},
		{
			label: "deep path",
			folder: deep,
			live: [`${deep}/note.md`],
			deleted: [],
		},
		{
			label: "large tree",
			folder: "folder",
			live: Array.from(
				{ length: 10_000 },
				(_, index) => `folder/deep/${index}.md`,
			),
			deleted: [],
			unrelated: Array.from(
				{ length: 10_000 },
				(_, index) => `sibling/${index}.md`,
			),
		},
	]) {
		const files = Object.fromEntries<FileMetadata>([
			...live.map((path) => [path, file(path)] as const),
			...deleted.map(
				(path) => [path, file(path, { deleted: true })] as const,
			),
			...unrelated.map((path) => [path, file(path)] as const),
		]);
		assert.deepEqual(
			collectFolderDeleteTargets(files, folder),
			{
				knownDescendants: live.length + deleted.length,
				livePaths: live,
				historicalTombstonesSkipped: deleted.length,
			},
			label,
		);
	}
});

test("only stable 1.x numeric indexes are legacy", () => {
	for (const version of [1, 2]) {
		assert.equal(
			classifyIndexFormat({
				version,
				lastSyncTime: 0,
				deviceId: "stable-device",
				files: {},
			}),
			"legacy",
		);
	}
	assert.equal(classifyIndexFormat({ version: 2, files: {} }), "unsupported");
	assert.equal(classifyIndexFormat({ format: "sync-index" }), "current");
	assert.equal(classifyIndexFormat({ version: 3 }), "unsupported");
	assert.equal(classifyIndexFormat({ version: 4 }), "unsupported");
	assert.equal(classifyIndexFormat({ format: "unknown" }), "unsupported");
});

test("folder tombstone lookup selects the newest ancestor in path-depth work", () => {
	const history: Record<string, FolderTombstone> = {};
	for (let index = 0; index < 10_000; index++) {
		history[`unrelated-${index}`] = tombstone(`unrelated-${index}`, index);
	}
	history.a = tombstone("a", 3);
	history["a/b"] = tombstone("a/b", 10_001);
	let reads = 0;
	const observed = new Proxy(history, {
		get(target, property) {
			if (typeof property !== "string") {
				return undefined;
			}
			reads++;
			return target[property];
		},
	});
	for (const [path, expected, expectedReads] of [
		["a/b/c/file.md", "a/b", 3],
		["other/file.md", undefined, 1],
	] as const) {
		reads = 0;
		assert.equal(findFolderTombstone(path, observed)?.path, expected, path);
		assert.equal(reads, expectedReads, path);
	}
});

test("canonical file mutations enforce deletion, causality and FIFO before stamping a merge", () => {
	type Case = [
		label: string,
		current: FileMetadata,
		incoming: FileMetadata,
		expected: string,
		base?: number,
		causal?: { currentWatermark: number; desiredWatermark: number },
	];
	const current = file("note.md", { changedRevision: 6 });
	const deleted = { ...current, deleted: true };
	const folderDeleted = { ...deleted, deletedByFolder: "folder" };
	const version = (
		sha256: string,
		mutationSeq: number,
		changedRevision?: number,
		lastModifiedBy = "device-a",
	) =>
		file("note.md", {
			sha256,
			mutationSeq,
			changedRevision,
			lastModifiedBy,
		});
	const latest = version("latest", 8, 37);
	const predecessor = version("previous", 7, 36);
	const sequence = { currentWatermark: 8, desiredWatermark: 8 };
	const cases: Case[] = [
		[
			"exact delete rejects stale put",
			deleted,
			file("note.md"),
			"rejected-by-delete",
		],
		[
			"observed delete permits restoration",
			deleted,
			file("note.md"),
			"apply",
			6,
		],
		["concurrent exact delete wins", current, deleted, "apply"],
		[
			"concurrent live puts conflict",
			{ ...current, sha256: "a" },
			file("note.md", { sha256: "b" }),
			"concurrent-foreign",
		],
		[
			"observed live put can be edited",
			{ ...current, sha256: "a" },
			file("note.md", { sha256: "b" }),
			"apply",
			6,
		],
		[
			"modified descendant survives folder deletion",
			folderDeleted,
			file("note.md", { sha256: "changed" }),
			"apply",
		],
		[
			"explicit same-content put survives folder deletion",
			folderDeleted,
			file("note.md"),
			"apply",
		],
		[
			"folder delete cannot overwrite concurrent descendant",
			{ ...current, sha256: "changed" },
			folderDeleted,
			"concurrent-foreign",
		],
		[
			"same-device predecessor ignores revision drift",
			version("old", 3, 20),
			{
				...version("old", 4),
				deleted: true,
				deletedByFolder: "folder",
			},
			"apply",
			12,
		],
		[
			"same-device replay",
			latest,
			{ ...latest },
			"idempotent",
			5,
			sequence,
		],
		[
			"same-device stale put",
			latest,
			version("old", 7),
			"stale-same-device",
			5,
			sequence,
		],
		[
			"same-device stale delete",
			latest,
			{ ...version("old", 7), deleted: true },
			"stale-same-device",
			5,
			sequence,
		],
		[
			"own exact delete permits next put",
			{ ...predecessor, deleted: true },
			version("restored", 8),
			"apply",
			5,
			{ ...sequence, currentWatermark: 7 },
		],
		[
			"foreign edit still uses base revision",
			version("foreign", 3, 36, "device-b"),
			version("local", 8),
			"concurrent-foreign",
			35,
			{ ...sequence, currentWatermark: 7 },
		],
		[
			"Force snapshot permits sequence one",
			version("snapshot", 0, 1),
			version("edited", 1),
			"apply",
			1,
			{ currentWatermark: 0, desiredWatermark: 1 },
		],
		[
			"continuous edit uses FIFO despite old base",
			predecessor,
			version("latest", 8),
			"apply",
			35,
			{ ...sequence, currentWatermark: 7 },
		],
		[
			"equal divergent sequence fails closed",
			latest,
			version("different", 8),
			"invalid-sequence",
			5,
			sequence,
		],
		[
			"FIFO gap fails closed",
			latest,
			version("future", 10),
			"fifo-gap",
			5,
			sequence,
		],
	];
	for (const [
		label,
		current,
		incoming,
		expected,
		base = 5,
		causal,
	] of cases) {
		assert.equal(
			classifyFileMutation(current, incoming, base, causal),
			expected,
			label,
		);
		assert.deepEqual(
			mergeFileMutation(
				current,
				incoming,
				base,
				40,
				"fallback-device",
				causal,
			),
			expected === "apply"
				? {
						...incoming,
						baseRevision: base,
						changedRevision: 40,
						lastModifiedBy:
							incoming.lastModifiedBy ?? "fallback-device",
					}
				: current,
			label,
		);
	}
});

test("folder deletion preserves foreign and unknown children but recognizes its own FIFO predecessor", () => {
	for (const { label, options, base = 12, preserve, authorize } of [
		{
			label: "newer child without actor",
			options: { changedRevision: 20 },
			preserve: true,
			authorize: false,
		},
		{
			label: "child at folder baseline",
			options: { changedRevision: 12, mutationSeq: 4 },
			preserve: false,
			authorize: true,
		},
		{
			label: "same-device predecessor",
			options: {
				changedRevision: 20,
				lastModifiedBy: "device-a",
				mutationSeq: 3,
			},
			preserve: false,
			authorize: true,
		},
		{
			label: "foreign newer child",
			options: {
				changedRevision: 20,
				lastModifiedBy: "device-b",
				mutationSeq: 1,
			},
			preserve: true,
			authorize: false,
		},
		{
			label: "same-device unsequenced newer child",
			options: { changedRevision: 20, lastModifiedBy: "device-a" },
			preserve: true,
			authorize: false,
		},
		{
			label: "unsequenced current child",
			options: { changedRevision: 7, lastModifiedBy: "device-a" },
			base: 7,
			preserve: false,
			authorize: false,
		},
		{
			label: "sequenced current child",
			options: {
				changedRevision: 7,
				lastModifiedBy: "device-a",
				mutationSeq: 4,
			},
			base: 7,
			preserve: false,
			authorize: true,
		},
	]) {
		const current = file("folder/note.md", options);
		assert.equal(
			shouldPreserveConcurrentFolderChild(current, base, "device-a", 4),
			preserve,
			label,
		);
		assert.equal(
			canApplyDestructiveFolderMutation(current, base, "device-a", 4),
			authorize,
			label,
		);
	}
});

test("mutation watermark advances only through a contiguous FIFO sequence", () => {
	const applied: Record<string, number> = {};
	assert.equal(advanceMutationSequence(applied, "device", 1), true);
	assert.equal(advanceMutationSequence(applied, "device", 3), false);
	assert.equal(advanceMutationSequence(applied, "device", 2), true);
	assert.equal(applied.device, 2);
});

test("unchanged lock becomes recoverable only after its lease", () => {
	assert.equal(isStableLockStale(1_000, 120_999, 120_000), false);
	assert.equal(isStableLockStale(1_000, 121_000, 120_000), true);
});
