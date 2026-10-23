import { fileMetadata } from "./helpers/metadata";
import assert from "node:assert/strict";
import test from "node:test";
import type { FileMetadata, FolderTombstone } from "../src/types";
import { ConflictResolver } from "../src/sync/reconciliation/conflicts";

function file(
	sha256: string,
	options: Partial<FileMetadata> = {},
): FileMetadata {
	return fileMetadata("folder/note.md", { sha256, ...options });
}

const path = "folder/note.md";
const baseline = file("base", {
	changedRevision: 3,
	remoteFingerprint: "old",
	remoteMtime: 10_000,
});
const deleted = { ...baseline, deleted: true, changedRevision: 5 };

test("folder tombstones delete only unchanged known descendants", () => {
	const folder: Record<string, FolderTombstone> = {
		folder: {
			path: "folder",
			deletedAt: 1,
			changedRevision: 4,
			baseRevision: 3,
			lastModifiedBy: "device-a",
		},
	};
	for (const { label, local, remote, known, expected } of [
		{
			label: "first-sync local child",
			local: file("new"),
			expected: "upload",
		},
		{
			label: "unchanged known child",
			local: baseline,
			known: baseline,
			expected: "delete_local",
		},
		{
			label: "new remote child",
			remote: file("remote", { remoteMtime: 10 }),
			expected: "download",
		},
		{
			label: "external remote edit",
			remote: { ...baseline, remoteFingerprint: "new" },
			known: baseline,
			expected: "download",
		},
	]) {
		const operations = new ConflictResolver().determineOperations(
			new Map(local ? [[path, local]] : []),
			new Map(remote ? [[path, remote]] : []),
			local && known ? { [path]: known } : {},
			known ? { [path]: known } : {},
			1,
			folder,
		);
		assert.deepEqual(
			operations.map(({ action }) => action),
			[expected],
			label,
		);
	}
});

test("file reconciliation preserves exact deletions and detects logical or physical conflicts", () => {
	type Case = {
		label: string;
		local?: FileMetadata;
		remote?: FileMetadata;
		previous?: FileMetadata;
		canonical?: FileMetadata;
		pendingDelete?: boolean;
		expected: string;
	};
	const physical = file("stale", { remoteMtime: 20 });
	const cases: Case[] = [
		{
			label: "exact deletion beats local edit",
			local: file("edited"),
			remote: physical,
			previous: baseline,
			canonical: deleted,
			expected: "delete_local",
		},
		{
			label: "stale local deletion has no authority",
			previous: { ...deleted, changedRevision: 2 },
			canonical: baseline,
			expected: "none",
		},
		{
			label: "pending physical deletion resumes",
			local: baseline,
			previous: deleted,
			canonical: deleted,
			pendingDelete: true,
			expected: "delete_local",
		},
		{
			label: "fingerprint detects edit within old mtime tolerance",
			local: baseline,
			remote: file("ciphertext", {
				remoteMtime: 10_001,
				remoteFingerprint: "new",
			}),
			previous: baseline,
			canonical: baseline,
			expected: "download",
		},
		{
			label: "two devices edit a shared baseline",
			local: file("local-edit"),
			remote: file("ciphertext", { remoteFingerprint: "new" }),
			previous: baseline,
			canonical: file("remote-edit", {
				changedRevision: 4,
				remoteFingerprint: "new",
			}),
			expected: "conflict",
		},
		{
			label: "first sync has different plaintext",
			local: file("local"),
			remote: file("remote", { remoteFingerprint: "remote" }),
			canonical: file("remote", {
				changedRevision: 1,
				remoteFingerprint: "remote",
			}),
			expected: "conflict",
		},
		{
			label: "encrypted first sync has equal plaintext",
			local: file("plain"),
			remote: file("ciphertext", { remoteFingerprint: "ciphertext" }),
			canonical: file("plain", {
				changedRevision: 1,
				remoteFingerprint: "ciphertext",
			}),
			expected: "none",
		},
	];
	for (const {
		label,
		local,
		remote,
		previous,
		canonical,
		pendingDelete,
		expected,
	} of cases) {
		const operation = new ConflictResolver().resolveAction(
			path,
			local ?? null,
			remote ?? null,
			previous ?? null,
			canonical ?? null,
			undefined,
			pendingDelete,
		);
		assert.equal(operation.action, expected, label);
		if (remote === physical) {
			assert.equal(operation.remoteMeta, physical, label);
		}
	}
});

test("epoch adoption reapplies offline edits while preserving canonical and physical changes", () => {
	type Case = [
		label: string,
		local: FileMetadata | null,
		canonical: FileMetadata | null,
		expected: string,
		previous?: FileMetadata | null,
		physical?: FileMetadata,
	];
	const forceRemoved = {
		...baseline,
		deleted: true,
		mutationSeq: 0,
		changedRevision: 1,
	};
	const cases: Case[] = [
		["local edit", file("local"), baseline, "upload"],
		["remote-only edit", baseline, file("remote"), "download"],
		["local delete", null, baseline, "delete_remote"],
		["remote delete", baseline, null, "delete_local"],
		["edit restores remote deletion", file("local"), null, "upload"],
		["two live edits", file("local"), file("remote"), "conflict"],
		["unknown remote child", null, file("remote"), "download", null],
		[
			"external physical edit",
			baseline,
			baseline,
			"download",
			baseline,
			file("ciphertext", { remoteFingerprint: "new" }),
		],
		[
			"unchanged Force-removed file",
			baseline,
			forceRemoved,
			"delete_local",
			baseline,
			baseline,
		],
		[
			"offline edit after Force removal",
			file("offline-edit"),
			forceRemoved,
			"upload",
			baseline,
			baseline,
		],
	];
	for (const [
		label,
		local,
		canonical,
		expected,
		previous = baseline,
		physical = canonical,
	] of cases) {
		const operations =
			new ConflictResolver().determineEpochAdoptionOperations(
				new Map(local ? [[path, local]] : []),
				new Map(physical ? [[path, physical]] : []),
				previous ? { [path]: previous } : {},
				canonical ? { [path]: canonical } : {},
			);
		assert.deepEqual(
			operations.map(({ action }) => action),
			[expected],
			label,
		);
	}
});
