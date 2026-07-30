import assert from "node:assert/strict";
import test from "node:test";
import {
	createEmptyIndex,
	type PendingPhysicalAction,
} from "../src/types";
import {
	isPhysicalDeleteAuthorized,
	shouldBackupLocalDelete,
} from "../src/sync/physical-action-rules";

function action(
	epoch: string,
	origin: PendingPhysicalAction["origin"] = "exact-delete",
): PendingPhysicalAction {
	return {
		id: "action",
		type: "delete-remote",
		epoch,
		origin,
		path: "note.md",
		canonicalRevision: 2,
		createdAt: 1,
	};
}

test("a newer live canonical state cancels an old physical delete", () => {
	const canonical = createEmptyIndex("device", "epoch");
	canonical.files["note.md"] = {
		path: "note.md",
		sha256: "new",
		size: 3,
		mtime: 1,
		syncedAt: 1,
		changedRevision: 3,
	};
	assert.equal(
		isPhysicalDeleteAuthorized(action("epoch"), canonical),
		false,
	);
});

test("canonical tombstone authorizes exact and folder physical deletion", () => {
	const canonical = createEmptyIndex("device", "epoch");
	canonical.files["note.md"] = {
		path: "note.md",
		sha256: "old",
		size: 3,
		mtime: 1,
		syncedAt: 1,
		deleted: true,
		changedRevision: 3,
	};
	assert.equal(
		isPhysicalDeleteAuthorized(action("epoch"), canonical),
		true,
	);
	assert.equal(
		isPhysicalDeleteAuthorized(
			action("epoch", "folder-delete"),
			canonical,
		),
		true,
	);
});

test("force cleanup is authorized only by absence in the replacement epoch", () => {
	const canonical = createEmptyIndex("device", "new-epoch");
	assert.equal(
		isPhysicalDeleteAuthorized(
			action("new-epoch", "force-reset"),
			canonical,
		),
		true,
	);
	assert.equal(
		isPhysicalDeleteAuthorized(
			action("old-epoch", "force-reset"),
			canonical,
		),
		false,
	);
});

test("unknown or changed local content requires backup before deletion", () => {
	assert.equal(shouldBackupLocalDelete("current", undefined), true);
	assert.equal(shouldBackupLocalDelete("current", "baseline"), true);
	assert.equal(shouldBackupLocalDelete("same", "same"), false);
});
