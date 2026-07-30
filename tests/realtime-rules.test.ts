import assert from "node:assert/strict";
import test from "node:test";
import {
	isMissingUploadSuperseded,
	selectFileRenamePlan,
	shouldRetainQueuedFileEvent,
	wasPendingPutAccepted,
	wasRenameSourceCausallyLive,
	type RealtimeFileEvent,
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
