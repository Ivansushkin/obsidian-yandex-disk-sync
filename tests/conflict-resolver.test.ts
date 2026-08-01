import assert from "node:assert/strict";
import test from "node:test";
import type {
	FileMetadata,
	FolderTombstone,
} from "../src/types";
import { ConflictResolver } from "../src/sync/conflict-resolver";

function file(
	path: string,
	sha256: string,
	options?: {
		deleted?: boolean;
		changedRevision?: number;
		remoteMtime?: number;
		remoteFingerprint?: string;
	},
): FileMetadata {
	return {
		path,
		sha256,
		size: 1,
		mtime: 1,
		remoteMtime: options?.remoteMtime,
		remoteFingerprint: options?.remoteFingerprint,
		syncedAt: 1,
		deleted: options?.deleted,
		changedRevision: options?.changedRevision,
	};
}

function folderDelete(
	path: string,
	changedRevision: number,
): Record<string, FolderTombstone> {
	return {
		[path]: {
			path,
			deletedAt: 1,
			changedRevision,
			baseRevision: changedRevision - 1,
			lastModifiedBy: "device-a",
		},
	};
}

test("first-sync local descendant survives a folder tombstone", () => {
	const resolver = new ConflictResolver();
	const operations = resolver.determineOperations(
		new Map([["deep/folder/new.md", file("deep/folder/new.md", "new")]]),
		new Map(),
		{},
		{},
		1,
		folderDelete("deep", 4),
	);
	assert.equal(operations[0]?.action, "upload");
});

test("unchanged descendant is deleted by a folder tombstone", () => {
	const resolver = new ConflictResolver();
	const baseline = file("deep/folder/note.md", "same", {
		changedRevision: 3,
	});
	const operations = resolver.determineOperations(
		new Map([["deep/folder/note.md", { ...baseline }]]),
		new Map(),
		{ "deep/folder/note.md": { ...baseline } },
		{ "deep/folder/note.md": { ...baseline } },
		1,
		folderDelete("deep", 4),
	);
	assert.equal(operations[0]?.action, "delete_local");
});

test("new remote descendant survives a folder tombstone", () => {
	const resolver = new ConflictResolver();
	const remote = file("deep/new.md", "remote", {
		remoteMtime: 10,
	});
	const operations = resolver.determineOperations(
		new Map(),
		new Map([["deep/new.md", remote]]),
		{},
		{},
		1,
		folderDelete("deep", 4),
	);
	assert.equal(operations[0]?.action, "download");
});

test("remote fingerprint change survives a folder tombstone", () => {
	const resolver = new ConflictResolver();
	const baseline = file("deep/note.md", "plain", {
		changedRevision: 3,
		remoteMtime: 10,
		remoteFingerprint: "old",
	});
	const remote = {
		...baseline,
		remoteFingerprint: "new",
	};
	const operations = resolver.determineOperations(
		new Map(),
		new Map([["deep/note.md", remote]]),
		{},
		{ "deep/note.md": baseline },
		1,
		folderDelete("deep", 4),
	);
	assert.equal(operations[0]?.action, "download");
});

test("exact remote deletion wins over a local edit and retains remote cleanup", () => {
	const resolver = new ConflictResolver();
	const local = file("note.md", "edited");
	const baseline = file("note.md", "old");
	const remotePhysical = file("note.md", "stale", {
		remoteMtime: 20,
	});
	const remoteDelete = {
		...baseline,
		deleted: true,
		changedRevision: 5,
	};
	const operation = resolver.resolveAction(
		"note.md",
		local,
		remotePhysical,
		baseline,
		remoteDelete,
	);
	assert.equal(operation.action, "delete_local");
	assert.equal(operation.remoteMeta, remotePhysical);
});

test("stale local deletion without a pending mutation cannot delete canonical state", () => {
	const resolver = new ConflictResolver();
	const localDelete = {
		...file("note.md", "old"),
		deleted: true,
		changedRevision: 2,
	};
	const operation = resolver.resolveAction(
		"note.md",
		null,
		null,
		localDelete,
		file("note.md", "old"),
	);
	assert.equal(operation.action, "none");
});

test("pending physical local deletion is resumed instead of restored", () => {
	const resolver = new ConflictResolver();
	const deleted = {
		...file("note.md", "same"),
		deleted: true,
		changedRevision: 5,
	};
	const operation = resolver.resolveAction(
		"note.md",
		file("note.md", "same"),
		null,
		deleted,
		deleted,
		undefined,
		true,
	);
	assert.equal(operation.action, "delete_local");
});

test("fingerprint detects a remote edit inside the old mtime tolerance", () => {
	const resolver = new ConflictResolver();
	const baseline = file("note.md", "local", {
		remoteMtime: 10_000,
		remoteFingerprint: "old",
	});
	const operation = resolver.resolveAction(
		"note.md",
		file("note.md", "local"),
		file("note.md", "encrypted", {
			remoteMtime: 10_001,
			remoteFingerprint: "new",
		}),
		baseline,
		baseline,
	);
	assert.equal(operation.action, "download");
});

test("two devices editing from the same baseline produce a conflict", () => {
	const resolver = new ConflictResolver();
	const baseline = file("note.md", "base", {
		changedRevision: 3,
		remoteFingerprint: "base-physical",
	});
	const canonical = file("note.md", "remote-edit", {
		changedRevision: 4,
		remoteFingerprint: "remote-physical",
	});
	const operation = resolver.resolveAction(
		"note.md",
		file("note.md", "local-edit"),
		file("note.md", "remote-ciphertext", {
			remoteFingerprint: "remote-physical",
		}),
		baseline,
		canonical,
	);
	assert.equal(operation.action, "conflict");
});

test("first sync with different content at the same path produces a conflict", () => {
	const resolver = new ConflictResolver();
	const operation = resolver.resolveAction(
		"note.md",
		file("note.md", "local"),
		file("note.md", "remote", {
			remoteFingerprint: "remote",
		}),
		null,
		file("note.md", "remote", {
			changedRevision: 1,
			remoteFingerprint: "remote",
		}),
	);
	assert.equal(operation.action, "conflict");
});

test("same plaintext hash on encrypted first sync creates a baseline without upload", () => {
	const resolver = new ConflictResolver();
	const operation = resolver.resolveAction(
		"note.md",
		file("note.md", "plain"),
		file("note.md", "ciphertext", {
			remoteFingerprint: "ciphertext",
		}),
		null,
		file("note.md", "plain", {
			changedRevision: 1,
			remoteFingerprint: "ciphertext",
		}),
	);
	assert.equal(operation.action, "none");
});

test("epoch adoption reapplies local changes and accepts remote-only changes", () => {
	const resolver = new ConflictResolver();
	const baseline = {
		"local-edit.md": file("local-edit.md", "base"),
		"remote-edit.md": file("remote-edit.md", "base"),
		"local-delete.md": file("local-delete.md", "base"),
		"remote-delete.md": file("remote-delete.md", "base"),
	};
	const canonical = {
		"local-edit.md": file("local-edit.md", "base"),
		"remote-edit.md": file("remote-edit.md", "remote"),
		"local-delete.md": file("local-delete.md", "base"),
	};
	const remote = new Map(
		Object.entries(canonical).map(([path, metadata]) => [path, metadata]),
	);
	const operations = resolver.determineEpochAdoptionOperations(
		new Map([
			["local-edit.md", file("local-edit.md", "local")],
			["remote-edit.md", file("remote-edit.md", "base")],
			["remote-delete.md", file("remote-delete.md", "base")],
		]),
		remote,
		baseline,
		canonical,
	);
	assert.deepEqual(
		Object.fromEntries(operations.map((operation) => [operation.path, operation.action])),
		{
			"local-edit.md": "upload",
			"remote-edit.md": "download",
			"local-delete.md": "delete_remote",
			"remote-delete.md": "delete_local",
		},
	);
});

test("epoch adoption restores a remote deletion and conflicts on two live edits", () => {
	const resolver = new ConflictResolver();
	const baseline = {
		"restore.md": file("restore.md", "base"),
		"conflict.md": file("conflict.md", "base"),
	};
	const canonical = {
		"conflict.md": file("conflict.md", "remote"),
	};
	const operations = resolver.determineEpochAdoptionOperations(
		new Map([
			["restore.md", file("restore.md", "local")],
			["conflict.md", file("conflict.md", "local")],
		]),
		new Map([["conflict.md", canonical["conflict.md"]]]),
		baseline,
		canonical,
	);
	assert.deepEqual(
		Object.fromEntries(operations.map((operation) => [operation.path, operation.action])),
		{ "restore.md": "upload", "conflict.md": "conflict" },
	);
});

test("unknown remote child survives an old device folder deletion", () => {
	const resolver = new ConflictResolver();
	const child = file("folder/new-child.md", "remote");
	const operations = resolver.determineEpochAdoptionOperations(
		new Map(),
		new Map([[child.path, child]]),
		{},
		{ [child.path]: child },
	);
	assert.equal(operations[0]?.action, "download");
});

test("epoch adoption still detects external physical remote edits", () => {
	const resolver = new ConflictResolver();
	const baseline = file("note.md", "base", {
		remoteFingerprint: "old-physical",
	});
	const canonical = { ...baseline };
	const physical = file("note.md", "ciphertext", {
		remoteFingerprint: "new-physical",
	});
	const operations = resolver.determineEpochAdoptionOperations(
		new Map([["note.md", { ...baseline }]]),
		new Map([["note.md", physical]]),
		{ "note.md": baseline },
		{ "note.md": canonical },
	);
	assert.equal(operations[0]?.action, "download");
});
