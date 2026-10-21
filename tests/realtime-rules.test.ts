import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyPostFullRename,
	isMissingUploadSuperseded,
	selectFolderRenameParent,
	wasRenameSourceCausallyLive,
} from "../src/sync/realtime/rules";
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
