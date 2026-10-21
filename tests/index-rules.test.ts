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
	isPathInsideFolder,
	isStableLockStale,
	mergeFileMutation,
	shouldApplyFileMutation,
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

test("folder matching respects segment boundaries and deep paths", () => {
	assert.equal(isPathInsideFolder("a/b/file.md", "a/b"), true);
	assert.equal(isPathInsideFolder("a/b", "a/b"), true);
	assert.equal(isPathInsideFolder("a/bb/file.md", "a/b"), false);

	const deepFolder = Array.from({ length: 100 }, (_, i) => `d${i}`).join("/");
	assert.equal(isPathInsideFolder(`${deepFolder}/file.md`, deepFolder), true);
});

test("folder delete targets skip a historical rename tombstone", () => {
	const targets = collectFolderDeleteTargets(
		{
			"folder/Без названия.md": file("folder/Без названия.md", {
				deleted: true,
				changedRevision: 6,
			}),
			"folder/Чо как.md": file("folder/Чо как.md", {
				changedRevision: 7,
			}),
		},
		"folder",
	);

	assert.deepEqual(targets, {
		knownDescendants: 2,
		livePaths: ["folder/Чо как.md"],
		historicalTombstonesSkipped: 1,
	});
});

test("folder delete with only tombstones has no live targets", () => {
	const targets = collectFolderDeleteTargets(
		{
			"folder/old.md": file("folder/old.md", { deleted: true }),
		},
		"folder",
	);

	assert.equal(targets.knownDescendants, 1);
	assert.deepEqual(targets.livePaths, []);
	assert.equal(targets.historicalTombstonesSkipped, 1);
});

test("folder delete targets deep descendants without matching siblings", () => {
	const targets = collectFolderDeleteTargets(
		{
			"folder/deep/note.md": file("folder/deep/note.md"),
			"folder/deep/old.md": file("folder/deep/old.md", {
				deleted: true,
			}),
			"folder-copy/note.md": file("folder-copy/note.md"),
		},
		"folder/",
	);

	assert.deepEqual(targets.livePaths, ["folder/deep/note.md"]);
	assert.equal(targets.knownDescendants, 2);
	assert.equal(targets.historicalTombstonesSkipped, 1);
});

test("folder delete target planning handles ten thousand descendants", () => {
	const files: Record<string, FileMetadata> = {};
	for (let index = 0; index < 10_000; index++) {
		files[`folder/deep/${index}.md`] = file(`folder/deep/${index}.md`);
		files[`sibling/${index}.md`] = file(`sibling/${index}.md`);
	}
	const targets = collectFolderDeleteTargets(files, "folder");
	assert.equal(targets.livePaths.length, 10_000);
	assert.equal(targets.knownDescendants, 10_000);
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

test("newest containing folder tombstone is selected", () => {
	const tombstones = {
		a: tombstone("a", 3),
		"a/b": tombstone("a/b", 7),
	};
	assert.equal(
		findFolderTombstone("a/b/file.md", tombstones)?.changedRevision,
		7,
	);
	assert.equal(findFolderTombstone("other/file.md", tombstones), null);
});

test("folder tombstone lookup scales with path depth, not history size", () => {
	const history: Record<string, FolderTombstone> = {};
	for (let index = 0; index < 10_000; index++) {
		history[`unrelated-${index}`] = tombstone(`unrelated-${index}`, index);
	}
	history["a/b"] = tombstone("a/b", 10_001);
	let reads = 0;
	const observed = new Proxy(history, {
		get(target, property, receiver) {
			void receiver;
			if (typeof property !== "string") {
				return undefined;
			}
			reads++;
			return target[property];
		},
	});

	assert.equal(findFolderTombstone("a/b/c/file.md", observed)?.path, "a/b");
	assert.equal(reads, 3);
});

test("exact deletion wins concurrent puts but permits causally later restoration", () => {
	const deleted = file("note.md", { deleted: true, changedRevision: 6 });
	const cases = [
		{
			label: "stale put",
			current: deleted,
			incoming: file("note.md"),
			base: 5,
			expected: false,
		},
		{
			label: "observed deletion",
			current: deleted,
			incoming: file("note.md"),
			base: 6,
			expected: true,
		},
		{
			label: "concurrent delete",
			current: file("note.md", { changedRevision: 8 }),
			incoming: file("note.md", { deleted: true }),
			base: 5,
			expected: true,
		},
	];
	for (const { label, current, incoming, base, expected } of cases) {
		assert.equal(
			shouldApplyFileMutation(current, incoming, base),
			expected,
			label,
		);
	}
});

test("concurrent live puts with different hashes do not overwrite each other", () => {
	const current = file("note.md", {
		sha256: "device-a",
		changedRevision: 5,
	});
	const incoming = file("note.md", { sha256: "device-b" });
	assert.equal(shouldApplyFileMutation(current, incoming, 4), false);
	assert.equal(shouldApplyFileMutation(current, incoming, 5), true);
});

test("modified descendant wins over a concurrent folder deletion", () => {
	const currentDelete = file("folder/note.md", {
		deleted: true,
		changedRevision: 6,
		deletedByFolder: "folder",
	});
	assert.equal(
		shouldApplyFileMutation(
			currentDelete,
			{ ...file("folder/note.md"), sha256: "changed" },
			5,
		),
		true,
	);
});

test("an explicit same-content put survives a concurrent folder deletion", () => {
	const currentDelete = file("folder/note.md", {
		deleted: true,
		changedRevision: 6,
		deletedByFolder: "folder",
	});
	assert.equal(
		shouldApplyFileMutation(currentDelete, file("folder/note.md"), 5),
		true,
	);
});

test("folder deletion does not overwrite a concurrently modified descendant", () => {
	const currentPut = {
		...file("folder/note.md", { changedRevision: 7 }),
		sha256: "changed",
	};
	const folderDelete = file("folder/note.md", {
		deleted: true,
		deletedByFolder: "folder",
	});
	assert.equal(shouldApplyFileMutation(currentPut, folderDelete, 5), false);
});

test("child created after folder baseline is preserved", () => {
	assert.equal(
		shouldPreserveConcurrentFolderChild(
			file("folder/new.md", { changedRevision: 7 }),
			5,
		),
		true,
	);
	assert.equal(
		shouldPreserveConcurrentFolderChild(
			file("folder/old.md", { changedRevision: 5 }),
			5,
		),
		false,
	);
});

test("same-device predecessor is deleted despite a newer canonical revision", () => {
	const current = file("folder/note.md", {
		changedRevision: 20,
		lastModifiedBy: "device-a",
		mutationSeq: 3,
	});
	const incoming = file("folder/note.md", {
		deleted: true,
		deletedByFolder: "folder",
		lastModifiedBy: "device-a",
		mutationSeq: 4,
	});
	assert.equal(shouldApplyFileMutation(current, incoming, 12), true);
	assert.equal(
		shouldPreserveConcurrentFolderChild(current, 12, "device-a", 4),
		false,
	);
});

test("foreign newer and unsequenced children are never destructively inferred", () => {
	const foreign = file("folder/foreign.md", {
		changedRevision: 20,
		lastModifiedBy: "device-b",
		mutationSeq: 1,
	});
	const unknown = file("folder/unknown.md", {
		changedRevision: 20,
		lastModifiedBy: "device-a",
	});
	assert.equal(
		shouldPreserveConcurrentFolderChild(foreign, 12, "device-a", 4),
		true,
	);
	assert.equal(
		shouldPreserveConcurrentFolderChild(unknown, 12, "device-a", 4),
		true,
	);
});

test("unsequenced current child never authorizes a destructive folder mutation", () => {
	const current = file("folder/note.md", {
		changedRevision: 7,
		lastModifiedBy: "device-a",
	});
	assert.equal(
		canApplyDestructiveFolderMutation(current, 7, "device-a", 4),
		false,
	);
	current.mutationSeq = 4;
	assert.equal(
		canApplyDestructiveFolderMutation(current, 7, "device-a", 4),
		true,
	);
});

test("accepted merge stamps base and changed revisions", () => {
	const merged = mergeFileMutation(
		file("note.md", { changedRevision: 4 }),
		{
			...file("note.md"),
			sha256: "new",
			lastModifiedBy: "device-a",
			mutationSeq: 9,
		},
		4,
		5,
		"device-b",
	);
	assert.equal(merged?.baseRevision, 4);
	assert.equal(merged?.changedRevision, 5);
	assert.equal(merged?.lastModifiedBy, "device-a");
	assert.equal(merged?.mutationSeq, 9);
});

/** Build causally attributed versions without repeating unrelated file metadata. */
function version(
	sha256: string,
	mutationSeq: number,
	changedRevision?: number,
	lastModifiedBy = "device-a",
) {
	return file("note.md", {
		sha256,
		mutationSeq,
		changedRevision,
		lastModifiedBy,
	});
}

const latest = version("latest", 8, 37);
const predecessor = version("previous", 7, 36);
for (const {
	name,
	current,
	incoming,
	expected,
	watermark = 8,
	desired = 8,
	base = 35,
} of [
	{
		name: "same-device replay is idempotent or stale but never a conflict",
		current: latest,
		incoming: { ...latest },
		expected: "idempotent",
	},
	{
		name: "same-device stale delete cannot remove a newer put",
		current: latest,
		incoming: { ...version("old", 7), deleted: true },
		expected: "stale-same-device",
	},
	{
		name: "same-device put after its own exact delete restores the path",
		current: { ...predecessor, deleted: true },
		incoming: version("restored", 8),
		watermark: 7,
		expected: "apply",
	},
	{
		name: "foreign edit keeps base-revision conflict rules",
		current: version("device-b", 3, 36, "device-b"),
		incoming: version("device-a", 8),
		watermark: 7,
		expected: "concurrent-foreign",
	},
	{
		name: "force snapshot is followed by sequence one in the same epoch",
		current: version("snapshot", 0, 1),
		incoming: version("edited", 1),
		watermark: 0,
		desired: 1,
		base: 1,
		expected: "apply",
	},
]) {
	test(name, () => {
		assert.equal(
			classifyFileMutation(current, incoming, base, {
				currentWatermark: watermark,
				desiredWatermark: desired,
			}),
			expected,
		);
		if (expected === "idempotent") {
			assert.equal(
				classifyFileMutation(current, version("old", 7), base, {
					currentWatermark: 8,
					desiredWatermark: 8,
				}),
				"stale-same-device",
			);
		}
	});
}

test("continuous same-device edit ignores an older base revision", () => {
	const incoming = version("latest", 8);
	const sequence = { currentWatermark: 7, desiredWatermark: 8 };
	assert.equal(
		classifyFileMutation(predecessor, incoming, 35, sequence),
		"apply",
	);
	assert.equal(
		mergeFileMutation(predecessor, incoming, 35, 37, "device-a", sequence)
			?.sha256,
		"latest",
	);
});

test("equal divergent sequence and FIFO gap fail closed", () => {
	for (const [seq, sha, expected] of [
		[8, "different", "invalid-sequence"],
		[10, "future", "fifo-gap"],
	] as const) {
		assert.equal(
			classifyFileMutation(
				version("canonical", 8, 37),
				version(sha, seq),
				35,
				{ currentWatermark: 8, desiredWatermark: 8 },
			),
			expected,
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
