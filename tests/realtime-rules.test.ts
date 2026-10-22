import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyPostFullRename,
	isMissingUploadSuperseded,
	selectFolderRenameParent,
	wasRenameSourceCausallyLive,
} from "../src/sync/realtime/rules";
import {
	reduceWatcherQueue,
	reduceUploadCausalReceipts,
	type WatcherQueueEvent,
	type WatcherQueueContext,
} from "../src/sync/realtime/queue-rules";
import type { FileMetadata, IndexMove } from "../src/types";
import {
	fileEvent,
	fileMetadata,
	folderRenameEvent,
	renameEvent,
} from "./helpers/realtime-fixtures";

function metadata(
	path: string,
	options?: { deleted?: boolean; changedRevision?: number; sha256?: string },
): FileMetadata {
	return fileMetadata(path, options?.sha256 ?? `sha:${path}`, {
		deleted: options?.deleted,
		changedRevision: options?.changedRevision,
	});
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
	for (const [localRevision, remoteRevision, baseRevision, expected] of [
		[7, 7, 7, true],
		[7, 8, 7, false],
		[null, 1, null, false],
		[null, 7, 7, false],
	] as const) {
		const local =
			localRevision === null
				? undefined
				: metadata("A.md", { changedRevision: localRevision });
		const remote = metadata("A.md", { changedRevision: remoteRevision });
		assert.equal(
			wasRenameSourceCausallyLive(local, remote, baseRevision),
			expected,
		);
	}
});

test("missing old upload is superseded only by durable causal evidence", () => {
	const upload = fileEvent("event-a", "A.md");

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
		isMissingUploadSuperseded(
			{ ...upload, superseded: true },
			undefined,
			{},
		),
		true,
	);
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
	const selection = selectFolderRenameParent([first, second], "A/note.md");
	assert.equal(selection.ambiguous, true);
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

const queueContext: WatcherQueueContext = {
	submittedFileIds: new Set(),
	submittedWatcherIds: new Set(),
};

test("child rename ignores a newer unrelated folder event", () => {
	const existing = [
		{ ...folderRenameEvent("parent-a", "A", "B"), baseRevision: 7 },
		{
			...folderRenameEvent("unrelated", "X", "Y"),
			baseRevision: 7,
			createdAt: 2,
		},
	];
	const reduction = reduceWatcherQueue(
		existing,
		renameEvent("child", "A/note.md", "B/note.md", { createdAt: 3 }),
		queueContext,
	);

	assert.equal(reduction.disposition, "absorbed");
	assert.deepEqual(
		reduction.events.map((event) => event.id),
		["parent-a", "unrelated"],
	);
});

test("queued target modify is absorbed but recreate of source remains", () => {
	const rename = renameEvent("rename-a", "A.md", "B.md");
	const modified = reduceWatcherQueue(
		[rename],
		fileEvent("modify-b", "B.md", { createdAt: 2 }),
		queueContext,
	);
	assert.equal(modified.disposition, "absorbed");
	const recreated = reduceWatcherQueue(
		modified.events,
		fileEvent("recreate-a", "A.md", { createdAt: 3 }),
		queueContext,
	);
	assert.equal(recreated.disposition, "queued");
	assert.deepEqual(
		recreated.events.map((event) => event.id),
		["rename-a", "recreate-a"],
	);
});

test("file and folder chains retain running identities across JSON restart", () => {
	for (const kind of ["file", "folder"] as const) {
		const first = {
			...renameEvent("first", "A", "B", {
				mutationId: "device-a:11",
				mutationSeq: 11,
			}),
			kind,
		};
		const second = { ...renameEvent("second", "B", "deep/C"), kind };
		const queued = reduceWatcherQueue(
			[Object.freeze(first)],
			Object.freeze(second),
			queueContext,
		);
		assert.deepEqual(
			queued.events.map((event) => ({
				action: event.action,
				path: event.path,
				targetPath:
					event.action === "rename" ? event.targetPath : undefined,
			})),
			[{ action: "rename", path: "A", targetPath: "deep/C" }],
		);
		const restored = JSON.parse(
			JSON.stringify(queued.events),
		) as WatcherQueueEvent[];
		assert.equal(restored[0]?.id, "first");
		assert.equal(restored[0]?.mutationId, "device-a:11");
		assert.equal(restored[0]?.mutationSeq, 11);
		const successor = {
			...renameEvent("third", "deep/C", "D", {
				epoch: "foreign-epoch",
				mutationId: "device-a:21",
				mutationSeq: 21,
			}),
			kind,
		};
		const running = reduceWatcherQueue(restored, successor, {
			...queueContext,
			submittedWatcherIds: new Set(["first"]),
		});
		assert.equal(running.chain?.disposition, "running");
		const restarted = JSON.parse(
			JSON.stringify(running.events),
		) as WatcherQueueEvent[];
		assert.deepEqual(restarted[0], restored[0]);
		assert.deepEqual(
			restarted.map((event) => [
				event.id,
				event.epoch,
				event.mutationSeq,
			]),
			[
				["first", "epoch-a", 11],
				["third", "foreign-epoch", 21],
			],
		);
	}
});

test("folder notifications preserve submitted child rename snapshots", () => {
	for (const targetPath of ["B/note.md", "Elsewhere/note.md"]) {
		const child = Object.freeze(
			renameEvent("running-child", "A/note.md", targetPath, {
				mutationId: "device-a:11",
				mutationSeq: 11,
				predecessorUploadId: "upload-a",
			}),
		);
		const reduction = reduceWatcherQueue(
			[child],
			folderRenameEvent("parent", "A", "B"),
			{ ...queueContext, submittedWatcherIds: new Set([child.id]) },
		);
		assert.deepEqual(reduction.events[0], child);
		assert.equal(reduction.events.length, 2);
	}
});

test("pending submitted upload leaves its put for rename retarget", () => {
	const existing: WatcherQueueEvent[] = [
		fileEvent("upload-a", "A.md"),
		renameEvent("rename-a", "A.md", "B.md", {
			createdAt: 2,
			predecessorUploadId: "upload-a",
		}),
	];

	const reduction = reduceUploadCausalReceipts(existing, {
		completed: [],
		superseded: ["upload-a"],
		uploadReceipts: [
			{
				eventId: "upload-a",
				path: "A.md",
				status: "pending-put",
				reason: "coalesced",
				epoch: "epoch-a",
				canonicalRevision: null,
				mutationId: "device-a:1",
				mutationSeq: 1,
				sha256: "sha-a",
			},
		],
	});

	const rename = reduction.events.find((event) => event.id === "rename-a");
	assert.ok(rename?.action === "rename" && rename.kind === "file");
	assert.equal(rename.baseRevision, 7);
	assert.equal(rename.predecessorUploadId, undefined);
});

test("accepted upload advances a later queued edit of the same path", () => {
	const existing: WatcherQueueEvent[] = [
		fileEvent("upload-previous", "note.md", {
			baseRevision: 35,
			mutationId: "device-a:7",
			mutationSeq: 7,
			snapshotSha256: "previous",
			superseded: true,
		}),
		fileEvent("upload-latest", "note.md", {
			baseRevision: 35,
			createdAt: 2,
			mutationId: "device-a:8",
			mutationSeq: 8,
			snapshotSha256: "latest",
		}),
	];

	const reduction = reduceUploadCausalReceipts(existing, {
		completed: ["upload-previous"],
		superseded: [],
		uploadReceipts: [
			{
				eventId: "upload-previous",
				path: "note.md",
				status: "accepted-put",
				reason: "accepted-put",
				epoch: "epoch-a",
				canonicalRevision: 36,
				mutationId: "device-a:7",
				mutationSeq: 7,
				sha256: "previous",
			},
		],
	});

	const successor = reduction.events.find(
		(event) => event.id === "upload-latest",
	);
	assert.equal(successor?.action, "upload");
	assert.equal(successor?.baseRevision, 36);
	assert.equal(successor?.mutationSeq, 8);
});
