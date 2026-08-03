import assert from "node:assert/strict";
import test from "node:test";
import type { FileMetadata, FolderTombstone } from "../src/types";
import {
	classifyFileMutation,
	classifyIndexVersion,
	canApplyDestructiveFolderMutation,
	collectFolderDeleteTargets,
	findFolderTombstone,
	isPathInsideFolder,
	isStableLockStale,
	mergeFileMutation,
	shouldApplyFileMutation,
	shouldPreserveConcurrentFolderChild,
	advanceMutationSequence,
} from "../src/sync/index-rules";

function file(
	path: string,
	options?: {
		sha256?: string;
		deleted?: boolean;
		changedRevision?: number;
		deletedByFolder?: string;
		lastModifiedBy?: string;
		mutationSeq?: number;
	},
): FileMetadata {
	return {
		path,
		sha256: options?.sha256 ?? "hash",
		size: 1,
		mtime: 1,
		syncedAt: 1,
		deleted: options?.deleted,
		changedRevision: options?.changedRevision,
		deletedByFolder: options?.deletedByFolder,
		lastModifiedBy: options?.lastModifiedBy,
		mutationSeq: options?.mutationSeq,
	};
}

function tombstone(
	path: string,
	changedRevision: number,
): FolderTombstone {
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

	const deepFolder = Array.from({ length: 100 }, (_, i) => `d${i}`).join(
		"/",
	);
	assert.equal(
		isPathInsideFolder(`${deepFolder}/file.md`, deepFolder),
		true,
	);
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

test("v1 through v3 are legacy while v4 is current", () => {
	assert.equal(classifyIndexVersion(1), "legacy");
	assert.equal(classifyIndexVersion(2), "legacy");
	assert.equal(classifyIndexVersion(3), "legacy");
	assert.equal(classifyIndexVersion(4), "current");
	assert.equal(classifyIndexVersion(5), "unsupported");
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
		history[`unrelated-${index}`] = tombstone(
			`unrelated-${index}`,
			index,
		);
	}
	history["a/b"] = tombstone("a/b", 10_001);
	let reads = 0;
	const observed = new Proxy(history, {
		get(target, property, receiver) {
			void receiver;
			if (typeof property !== "string") return undefined;
			reads++;
			return target[property];
		},
	});

	assert.equal(
		findFolderTombstone("a/b/c/file.md", observed)?.path,
		"a/b",
	);
	assert.equal(reads, 3);
});

test("exact deletion wins over a concurrent put", () => {
	const currentDelete = file("note.md", {
		deleted: true,
		changedRevision: 6,
	});
	assert.equal(
		shouldApplyFileMutation(currentDelete, file("note.md"), 5),
		false,
	);
});

test("put after observing deletion restores the file", () => {
	const currentDelete = file("note.md", {
		deleted: true,
		changedRevision: 6,
	});
	assert.equal(
		shouldApplyFileMutation(currentDelete, file("note.md"), 6),
		true,
	);
});

test("concurrent live puts with different hashes do not overwrite each other", () => {
	const current = file("note.md", {
		sha256: "device-a",
		changedRevision: 5,
	});
	const incoming = file("note.md", { sha256: "device-b" });
	assert.equal(
		shouldApplyFileMutation(current, incoming, 4),
		false,
	);
	assert.equal(
		shouldApplyFileMutation(current, incoming, 5),
		true,
	);
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
		shouldApplyFileMutation(
			currentDelete,
			file("folder/note.md"),
			5,
		),
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
	assert.equal(
		shouldApplyFileMutation(currentPut, folderDelete, 5),
		false,
	);
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

test("unsequenced prerelease v4 child requires an exact observed baseline", () => {
	const current = file("folder/note.md", {
		changedRevision: 7,
		lastModifiedBy: "device-a",
	});
	assert.equal(
		canApplyDestructiveFolderMutation(
			current,
			{ ...current },
			7,
			"device-a",
			4,
		),
		true,
	);
	assert.equal(
		canApplyDestructiveFolderMutation(
			current,
			{ ...current, sha256: "different" },
			7,
			"device-a",
			4,
		),
		false,
	);
	assert.equal(
		canApplyDestructiveFolderMutation(
			current,
			undefined,
			7,
			"device-a",
			4,
		),
		false,
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

test("continuous same-device edit ignores an older base revision", () => {
	const current = file("note.md", {
		sha256: "previous",
		changedRevision: 36,
		lastModifiedBy: "device-a",
		mutationSeq: 7,
	});
	const incoming = file("note.md", {
		sha256: "latest",
		lastModifiedBy: "device-a",
		mutationSeq: 8,
	});
	assert.equal(
		classifyFileMutation(current, incoming, 35, {
			currentWatermark: 7,
			desiredWatermark: 8,
		}),
		"apply",
	);
	assert.equal(
		mergeFileMutation(current, incoming, 35, 37, "device-a", {
			currentWatermark: 7,
			desiredWatermark: 8,
		})?.sha256,
		"latest",
	);
});

test("same-device replay is idempotent or stale but never a conflict", () => {
	const current = file("note.md", {
		sha256: "latest",
		changedRevision: 37,
		lastModifiedBy: "device-a",
		mutationSeq: 8,
	});
	assert.equal(
		classifyFileMutation(
			current,
			{ ...current },
			35,
			{ currentWatermark: 8, desiredWatermark: 8 },
		),
		"idempotent",
	);
	assert.equal(
		classifyFileMutation(
			current,
			file("note.md", {
				sha256: "old",
				lastModifiedBy: "device-a",
				mutationSeq: 7,
			}),
			35,
			{ currentWatermark: 8, desiredWatermark: 8 },
		),
		"stale-same-device",
	);
});

test("same-device stale delete cannot remove a newer put", () => {
	const current = file("note.md", {
		sha256: "latest",
		changedRevision: 37,
		lastModifiedBy: "device-a",
		mutationSeq: 8,
	});
	assert.equal(
		classifyFileMutation(
			current,
			file("note.md", {
				deleted: true,
				lastModifiedBy: "device-a",
				mutationSeq: 7,
			}),
			35,
			{ currentWatermark: 8, desiredWatermark: 8 },
		),
		"stale-same-device",
	);
});

test("same-device put after its own exact delete restores the path", () => {
	const current = file("note.md", {
		deleted: true,
		changedRevision: 36,
		lastModifiedBy: "device-a",
		mutationSeq: 7,
	});
	assert.equal(
		classifyFileMutation(
			current,
			file("note.md", {
				sha256: "restored",
				lastModifiedBy: "device-a",
				mutationSeq: 8,
			}),
			35,
			{ currentWatermark: 7, desiredWatermark: 8 },
		),
		"apply",
	);
});

test("equal divergent sequence and FIFO gap fail closed", () => {
	const current = file("note.md", {
		sha256: "canonical",
		changedRevision: 37,
		lastModifiedBy: "device-a",
		mutationSeq: 8,
	});
	assert.equal(
		classifyFileMutation(
			current,
			file("note.md", {
				sha256: "different",
				lastModifiedBy: "device-a",
				mutationSeq: 8,
			}),
			35,
			{ currentWatermark: 8, desiredWatermark: 8 },
		),
		"invalid-sequence",
	);
	assert.equal(
		classifyFileMutation(
			current,
			file("note.md", {
				sha256: "future",
				lastModifiedBy: "device-a",
				mutationSeq: 10,
			}),
			35,
			{ currentWatermark: 8, desiredWatermark: 8 },
		),
		"fifo-gap",
	);
});

test("foreign edit keeps base-revision conflict rules", () => {
	const current = file("note.md", {
		sha256: "device-b",
		changedRevision: 36,
		lastModifiedBy: "device-b",
		mutationSeq: 3,
	});
	assert.equal(
		classifyFileMutation(
			current,
			file("note.md", {
				sha256: "device-a",
				lastModifiedBy: "device-a",
				mutationSeq: 8,
			}),
			35,
			{ currentWatermark: 7, desiredWatermark: 8 },
		),
		"concurrent-foreign",
	);
});

test("force snapshot is followed by sequence one in the same epoch", () => {
	const current = file("note.md", {
		sha256: "snapshot",
		changedRevision: 1,
		lastModifiedBy: "device-a",
		mutationSeq: 0,
	});
	assert.equal(
		classifyFileMutation(
			current,
			file("note.md", {
				sha256: "edited",
				lastModifiedBy: "device-a",
				mutationSeq: 1,
			}),
			1,
			{ currentWatermark: 0, desiredWatermark: 1 },
		),
		"apply",
	);
});

test("deletion always replaces a concurrent present state", () => {
	assert.equal(
		shouldApplyFileMutation(
			file("note.md", { changedRevision: 8 }),
			file("note.md", { deleted: true }),
			5,
		),
		true,
	);
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
