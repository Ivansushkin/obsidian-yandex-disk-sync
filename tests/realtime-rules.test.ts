import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyPostFullRename,
	isMissingUploadSuperseded,
	reduceQueuedFileRename,
	reduceQueuedFolderRename,
	reduceFolderChildRename,
	selectFolderRenameParent,
	selectFileRenamePlan,
	shouldRetainQueuedFileEvent,
	wasPendingPutAccepted,
	wasRenameSourceCausallyLive,
	type RealtimeFileEvent,
	type DurableFileRenameEvent,
	type DurableFolderRenameEvent,
} from "../src/sync/realtime-rules";
import type {
	FileMetadata,
	IndexMove,
	PendingMutation,
} from "../src/types";

function metadata(
	path: string,
	options?: { deleted?: boolean; changedRevision?: number; sha256?: string },
): FileMetadata {
	return {
		path,
		sha256: options?.sha256 ?? `sha:${path}`,
		size: 1,
		mtime: 1,
		syncedAt: 1,
		deleted: options?.deleted,
		changedRevision: options?.changedRevision,
	};
}

function folderRenameEvent(
	id: string,
	path: string,
	targetPath: string,
): DurableFolderRenameEvent {
	return {
		id,
		action: "rename",
		path,
		targetPath,
		kind: "folder",
		epoch: "epoch-a",
		baseRevision: 12,
		createdAt: 1,
	};
}

function renameEvent(
	id: string,
	path: string,
	targetPath: string,
): DurableFileRenameEvent {
	return {
		id,
		action: "rename",
		path,
		targetPath,
		kind: "file",
		epoch: "epoch-a",
		baseRevision: 7,
		createdAt: 1,
	};
}

function event(
	id: string,
	path: string,
	action: "upload" | "delete" = "upload",
): RealtimeFileEvent {
	return {
		id,
		path,
		action,
		epoch: "epoch-a",
		baseRevision: 7,
		createdAt: 1,
	};
}

function pendingPut(): PendingMutation {
	return {
		id: "device-a:4",
		seq: 4,
		epoch: "epoch-a",
		type: "put",
		baseRevision: 7,
		path: "A.md",
		sha256: "sha:A",
		createdAt: 1,
	};
}

function move(): IndexMove {
	return {
		id: "device-a:5",
		fromPath: "A.md",
		toPath: "B.md",
		kind: "file",
		baseRevision: 7,
		changedRevision: 8,
		pending: true,
		lastModifiedBy: "device-a",
	};
}

test("rename source must belong to the event causal baseline", () => {
	assert.equal(
		wasRenameSourceCausallyLive(
			metadata("A.md", { changedRevision: 7 }),
			metadata("A.md", { changedRevision: 7 }),
			7,
		),
		true,
	);
	assert.equal(
		wasRenameSourceCausallyLive(
			metadata("A.md", { changedRevision: 7 }),
			metadata("A.md", { changedRevision: 8 }),
			7,
		),
		false,
	);
	assert.equal(
		wasRenameSourceCausallyLive(
			undefined,
			metadata("A.md", { changedRevision: 1 }),
			null,
		),
		false,
	);
	assert.equal(
		wasRenameSourceCausallyLive(
			undefined,
			metadata("A.md", { changedRevision: 7 }),
			7,
		),
		false,
	);
});

test("pending put becomes a causal rename source only after its watermark", () => {
	const put = pendingPut();
	const source = metadata("A.md", { changedRevision: 8 });

	assert.equal(wasPendingPutAccepted(put, { "device-a": 3 }, source), false);
	assert.equal(wasPendingPutAccepted(put, { "device-a": 4 }, source), true);
	assert.equal(
		wasPendingPutAccepted(
			put,
			{ "device-a": 4 },
			metadata("A.md", { deleted: true }),
		),
		false,
	);
});

test("rename planner distinguishes target put, move, and materialization", () => {
	assert.equal(
		selectFileRenamePlan(false, metadata("A.md"), "sha:A.md"),
		"put-target",
	);
	assert.equal(
		selectFileRenamePlan(true, metadata("A.md"), "sha:A.md"),
		"remote-move",
	);
	assert.equal(
		selectFileRenamePlan(true, metadata("A.md"), "changed"),
		"materialize-target",
	);
});

test("post-full rename settles absent paths and confirmed targets", () => {
	const event = renameEvent("rename-a", "A.md", "B.md");
	const absent = classifyPostFullRename(event, {
		canonicalEpoch: "epoch-a",
		canonicalRevision: 8,
		targetExists: false,
		hasPendingWork: false,
	});
	assert.equal(absent.status, "superseded");
	assert.equal(absent.reason, "source-and-target-settled-by-full");

	const target = metadata("B.md", {
		changedRevision: 8,
		sha256: "target-sha",
	});
	const applied = classifyPostFullRename(event, {
		canonicalEpoch: "epoch-a",
		canonicalRevision: 8,
		canonicalSource: metadata("A.md", {
			deleted: true,
			changedRevision: 8,
		}),
		canonicalTarget: target,
		localTarget: { ...target },
		targetExists: true,
		hasPendingWork: false,
	});
	assert.equal(applied.status, "completed");
	assert.equal(applied.plan, "already-applied");
});

test("post-full rename preserves newer sources and blocks causal ambiguity", () => {
	const event = renameEvent("rename-a", "A.md", "B.md");
	const newerSource = classifyPostFullRename(event, {
		canonicalEpoch: "epoch-a",
		canonicalRevision: 9,
		canonicalSource: metadata("A.md", { changedRevision: 9 }),
		targetExists: false,
		hasPendingWork: false,
	});
	assert.equal(newerSource.status, "superseded");
	assert.equal(newerSource.reason, "concurrent-source-preserved");

	const causalSource = classifyPostFullRename(event, {
		canonicalEpoch: "epoch-a",
		canonicalRevision: 8,
		canonicalSource: metadata("A.md", { changedRevision: 7 }),
		targetExists: false,
		hasPendingWork: false,
	});
	assert.equal(causalSource.status, "retry");
	assert.equal(causalSource.reason, "post-full-rename-ambiguous");

	const pending = classifyPostFullRename(event, {
		canonicalEpoch: "epoch-a",
		canonicalRevision: 8,
		targetExists: false,
		hasPendingWork: true,
	});
	assert.equal(pending.status, "retry");
	assert.equal(pending.reason, "related-causal-work-pending");
});

test("post-full rename from a replaced epoch is superseded", () => {
	const outcome = classifyPostFullRename(
		renameEvent("rename-a", "A.md", "B.md"),
		{
			canonicalEpoch: "epoch-b",
			canonicalRevision: 1,
			canonicalSource: metadata("A.md", { changedRevision: 1 }),
			targetExists: false,
			hasPendingWork: true,
		},
	);
	assert.equal(outcome.status, "superseded");
	assert.equal(outcome.reason, "epoch-replaced-by-full");
});

test("missing old upload is superseded only by durable causal evidence", () => {
	const upload = event("event-a", "A.md");

	assert.equal(isMissingUploadSuperseded(upload, undefined, {}), false);
	assert.equal(
		isMissingUploadSuperseded(
			upload,
			metadata("A.md", { deleted: true }),
			{},
		),
		true,
	);
	assert.equal(
		isMissingUploadSuperseded(upload, undefined, { move: move() }),
		true,
	);
	assert.equal(
		isMissingUploadSuperseded({ ...upload, superseded: true }, undefined, {}),
		true,
	);
});

test("queued modify replaces an older event but not submitted work", () => {
	const existing = event("event-a", "A.md");
	const incoming = event("event-b", "A.md");

	assert.equal(
		shouldRetainQueuedFileEvent(existing, incoming, new Set()),
		false,
	);
	assert.equal(
		shouldRetainQueuedFileEvent(
			existing,
			incoming,
			new Set(["event-a"]),
		),
		true,
	);
	assert.equal(
		shouldRetainQueuedFileEvent(
			existing,
			event("event-c", "B.md"),
			new Set(),
		),
		true,
	);
});

test("queued rename chain reduces to its final target", () => {
	const first = renameEvent("rename-a", "A.md", "B.md");
	const reduction = reduceQueuedFileRename(
		[first],
		renameEvent("rename-b", "B.md", "deep/C.md"),
		new Set(),
	);

	assert.equal(reduction.disposition, "rebased");
	assert.deepEqual(reduction.events, [
		{ ...first, targetPath: "deep/C.md" },
	]);
});

test("running rename keeps its successor as separate causal work", () => {
	const first = renameEvent("rename-a", "A.md", "B.md");
	const second = renameEvent("rename-b", "B.md", "deep/C.md");
	const reduction = reduceQueuedFileRename(
		[first],
		second,
		new Set([first.id]),
	);

	assert.equal(reduction.disposition, "running");
	assert.deepEqual(reduction.events, [first, second]);
});

test("queued folder rename chains reduce to one final target", () => {
	const first = folderRenameEvent("folder-a-b", "A", "B");
	const second = folderRenameEvent("folder-b-c", "B", "C");
	const result = reduceQueuedFolderRename([first], second, new Set());
	assert.equal(result.disposition, "rebased");
	assert.equal(result.events.length, 1);
	assert.equal(result.events[0]?.path, "A");
	assert.equal(result.events[0]?.targetPath, "C");
});

test("mechanical child rename is absorbed by its parent folder move", () => {
	const parent = folderRenameEvent("folder-a-b", "A", "B");
	const mechanical = renameEvent("child", "A/note.md", "B/note.md");
	assert.equal(
		reduceFolderChildRename(parent, mechanical).disposition,
		"absorbed",
	);
});

test("user child rename is rebased relative to the folder target", () => {
	const parent = folderRenameEvent("folder-a-b", "A", "B");
	const changed = renameEvent("child", "A/note.md", "B/renamed.md");
	const result = reduceFolderChildRename(parent, changed);
	assert.equal(result.disposition, "successor");
	assert.equal(result.event?.path, "B/note.md");
	assert.equal(result.event?.targetPath, "B/renamed.md");
	assert.equal(result.event?.predecessorFolderEventId, parent.id);
});

test("child rename selects the deepest matching folder parent", () => {
	const unrelated = folderRenameEvent("unrelated", "X", "Y");
	const outer = folderRenameEvent("outer", "A", "B");
	const inner = folderRenameEvent("inner", "A/deep", "B/deep");
	const selection = selectFolderRenameParent(
		[inner, unrelated, outer],
		"A/deep/note.md",
	);
	assert.equal(selection.parent?.id, "inner");
	assert.equal(selection.ambiguous, false);
});

test("equally specific unordered folder parents are ambiguous", () => {
	const first = folderRenameEvent("first", "A", "B");
	const second = folderRenameEvent("second", "A", "C");
	second.createdAt = first.createdAt;
	const selection = selectFolderRenameParent(
		[first, second],
		"A/note.md",
	);
	assert.equal(selection.ambiguous, true);
});
