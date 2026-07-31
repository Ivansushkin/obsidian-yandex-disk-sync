import assert from "node:assert/strict";
import test from "node:test";
import {
	createEmptyIndex,
	type PendingPhysicalAction,
	type YandexResource,
} from "../src/types";
import {
	classifyPhysicalDeleteFingerprint,
	classifyPhysicalDeleteResource,
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

test("remote deletion requires an exact expected fingerprint", () => {
	assert.equal(
		classifyPhysicalDeleteFingerprint("expected", "expected"),
		"match",
	);
	assert.equal(
		classifyPhysicalDeleteFingerprint(undefined, "current"),
		"missing-expected",
	);
	assert.equal(
		classifyPhysicalDeleteFingerprint("expected", undefined),
		"missing-current",
	);
	assert.equal(
		classifyPhysicalDeleteFingerprint("expected", "changed"),
		"mismatch",
	);
});

test("beta.7 physical actions accept every current server identity", () => {
	const resource: YandexResource = {
		path: "disk:/vault/note.md",
		name: "note.md",
		type: "file",
		created: "2026-07-31T00:00:00Z",
		modified: "2026-07-31T00:00:01Z",
		size: 3,
		sha256: "sha",
		md5: "md5",
		resource_id: "resource-id",
	};
	for (const expected of ["sha", "md5", "resource-id", resource.modified]) {
		assert.equal(
			classifyPhysicalDeleteResource(expected, resource),
			"match",
		);
	}
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

test("retargeted upload cleanup requires the accepted target put", () => {
	const canonical = createEmptyIndex("device", "epoch");
	const cleanup = {
		...action("epoch", "rejected-upload"),
		targetPath: "renamed.md",
		baselineSha256: "target",
	};
	assert.equal(isPhysicalDeleteAuthorized(cleanup, canonical), false);

	canonical.files["renamed.md"] = {
		path: "renamed.md",
		sha256: "target",
		size: 3,
		mtime: 1,
		syncedAt: 1,
		changedRevision: 3,
	};
	assert.equal(isPhysicalDeleteAuthorized(cleanup, canonical), true);

	canonical.files["note.md"] = {
		path: "note.md",
		sha256: "concurrent",
		size: 3,
		mtime: 1,
		syncedAt: 1,
		changedRevision: 4,
	};
	assert.equal(isPhysicalDeleteAuthorized(cleanup, canonical), false);
});

test("unknown or changed local content requires backup before deletion", () => {
	assert.equal(shouldBackupLocalDelete("current", undefined), true);
	assert.equal(shouldBackupLocalDelete("current", "baseline"), true);
	assert.equal(shouldBackupLocalDelete("same", "same"), false);
});
