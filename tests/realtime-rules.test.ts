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

test("folder parent selection uses deepest ancestry and rejects equal-time ambiguity", () => {
	const first = folderRenameEvent("first", "A", "B");
	const second = {
		...folderRenameEvent("second", "A", "C"),
		createdAt: first.createdAt,
	};
	for (const { label, parents, path, parent, ambiguous } of [
		{
			label: "deepest matching ancestor",
			parents: [
				folderRenameEvent("inner", "A/deep", "B/deep"),
				folderRenameEvent("unrelated", "X", "Y"),
				folderRenameEvent("outer", "A", "B"),
			],
			path: "A/deep/note.md",
			parent: "inner",
			ambiguous: false,
		},
		{
			label: "equally specific unordered parents",
			parents: [first, second],
			path: "A/note.md",
			parent: undefined,
			ambiguous: true,
		},
	]) {
		const selection = selectFolderRenameParent(parents, path);
		assert.equal(selection.ambiguous, ambiguous, label);
		if (!ambiguous) {
			assert.equal(selection.parent?.id, parent, label);
		}
	}
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

test("queue absorption follows rename targets without swallowing unrelated source work", () => {
	const rename = renameEvent("rename-a", "A.md", "B.md");
	const parent = folderRenameEvent("parent-a", "A", "B");
	const unrelated = {
		...folderRenameEvent("unrelated", "X", "Y"),
		createdAt: 2,
	};
	for (const { label, existing, incoming, disposition, ids } of [
		{
			label: "child notification ignores newer unrelated folder",
			existing: [parent, unrelated],
			incoming: renameEvent("child", "A/note.md", "B/note.md", {
				createdAt: 3,
			}),
			disposition: "absorbed",
			ids: ["parent-a", "unrelated"],
		},
		{
			label: "target modify",
			existing: [rename],
			incoming: fileEvent("modify-b", "B.md", { createdAt: 2 }),
			disposition: "absorbed",
			ids: ["rename-a"],
		},
		{
			label: "source recreated after rename",
			existing: [rename],
			incoming: fileEvent("recreate-a", "A.md", { createdAt: 3 }),
			disposition: "queued",
			ids: ["rename-a", "recreate-a"],
		},
	]) {
		const reduction = reduceWatcherQueue(existing, incoming, queueContext);
		assert.equal(reduction.disposition, disposition, label);
		assert.deepEqual(
			reduction.events.map(({ id }) => id),
			ids,
			label,
		);
	}
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

test("upload receipts release pending rename predecessors and advance accepted edit baselines", () => {
	for (const status of ["pending-put", "accepted-put"] as const) {
		const pending = status === "pending-put";
		const upload = fileEvent("upload", "A.md", {
			baseRevision: 35,
			mutationId: "device-a:7",
			mutationSeq: 7,
			snapshotSha256: "previous",
			superseded: !pending,
		});
		const successor = pending
			? renameEvent("successor", "A.md", "B.md", {
					createdAt: 2,
					predecessorUploadId: "upload",
				})
			: fileEvent("successor", "A.md", {
					baseRevision: 35,
					createdAt: 2,
					mutationId: "device-a:8",
					mutationSeq: 8,
					snapshotSha256: "latest",
				});
		const reduction = reduceUploadCausalReceipts([upload, successor], {
			completed: pending ? [] : [upload.id],
			superseded: pending ? [upload.id] : [],
			uploadReceipts: [
				{
					eventId: upload.id,
					path: upload.path,
					status,
					reason: pending ? "coalesced" : "accepted-put",
					epoch: "epoch-a",
					canonicalRevision: pending ? null : 36,
					mutationId: upload.mutationId,
					mutationSeq: upload.mutationSeq,
					sha256: "previous",
				},
			],
		});
		const result = reduction.events.find(({ id }) => id === successor.id);
		assert.equal(result?.action, successor.action, status);
		assert.equal(result?.baseRevision, pending ? 7 : 36, status);
		if (pending) {
			assert.ok(result?.action === "rename" && result.kind === "file");
			assert.equal(result.predecessorUploadId, undefined, status);
		} else {
			assert.equal(result?.mutationSeq, 8, status);
		}
	}
});
