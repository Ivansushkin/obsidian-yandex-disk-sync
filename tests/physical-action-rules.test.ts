import { fileMetadata } from "./helpers/metadata";
import assert from "node:assert/strict";
import test from "node:test";
import {
	createEmptyIndex,
	type PendingPhysicalAction,
	type FileMetadata,
	type YandexResource,
} from "../src/types";
import {
	classifyPhysicalDeleteFingerprint,
	classifyPhysicalDeleteResource,
	isPhysicalDeleteAuthorized,
} from "../src/sync/files/action-rules";

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

test("physical cleanup requires current epoch and canonical deletion or accepted retarget authority", () => {
	const tombstone = fileMetadata("note.md", {
		sha256: "old",
		deleted: true,
		changedRevision: 3,
	});
	const restored = fileMetadata("note.md", {
		sha256: "new",
		changedRevision: 4,
	});
	const target = fileMetadata("renamed.md", {
		sha256: "target",
		changedRevision: 3,
	});
	const retarget = {
		...action("epoch", "rejected-upload"),
		targetPath: "renamed.md",
		baselineSha256: "target",
	};
	const cases: [string, PendingPhysicalAction, FileMetadata[], boolean][] = [
		["newer live source", action("epoch"), [restored], false],
		["exact tombstone", action("epoch"), [tombstone], true],
		[
			"folder tombstone",
			action("epoch", "folder-delete"),
			[tombstone],
			true,
		],
		["Force without initiator", action("epoch", "force-reset"), [], true],
		[
			"Force with tombstone",
			action("epoch", "force-reset"),
			[tombstone],
			true,
		],
		[
			"old Force epoch",
			action("old-epoch", "force-reset"),
			[tombstone],
			false,
		],
		["unaccepted retarget", retarget, [], false],
		["accepted retarget", retarget, [target], true],
		["restored source after retarget", retarget, [target, restored], false],
	];
	for (const [label, cleanup, files, expected] of cases) {
		const canonical = createEmptyIndex("device", "epoch");
		canonical.files = Object.fromEntries(
			files.map((file) => [file.path, file]),
		);
		assert.equal(
			isPhysicalDeleteAuthorized(cleanup, canonical),
			expected,
			label,
		);
	}
});

test("remote deletion requires an exact expected fingerprint", () => {
	for (const [expected, current, decision] of [
		["expected", "expected", "match"],
		[undefined, "current", "missing-expected"],
		["expected", undefined, "missing-current"],
		["expected", "changed", "mismatch"],
	] as const) {
		assert.equal(
			classifyPhysicalDeleteFingerprint(expected, current),
			decision,
			decision,
		);
	}
});

test("persisted physical actions accept every current server identity", () => {
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
