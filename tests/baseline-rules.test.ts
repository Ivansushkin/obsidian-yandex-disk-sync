import assert from "node:assert/strict";
import test from "node:test";
import type { FileMetadata } from "../src/types";
import {
	createConfirmedBaseline,
	mergePhysicalMetadata,
} from "../src/sync/baseline-rules";

function metadata(
	path: string,
	sha256: string,
): FileMetadata {
	return {
		path,
		sha256,
		size: 10,
		mtime: 100,
		syncedAt: 100,
	};
}

test("empty-operation first sync still creates a complete local baseline", () => {
	const local = metadata("folder/note.md", "same");
	const remote = {
		...metadata("folder/note.md", "same"),
		remoteMtime: 200,
		remoteFingerprint: "server-fingerprint",
	};
	const baseline = createConfirmedBaseline(local, remote);

	assert.equal(baseline.sha256, "same");
	assert.equal(baseline.remoteMtime, 200);
	assert.equal(baseline.remoteFingerprint, "server-fingerprint");
	assert.equal(baseline.deleted, false);
});

test("confirmed baseline retains canonical causal metadata", () => {
	const local = metadata("note.md", "same");
	const remote = {
		...metadata("note.md", "same"),
		remoteMtime: 200,
	};
	const canonical = {
		...metadata("note.md", "same"),
		changedRevision: 8,
		baseRevision: 7,
		lastModifiedBy: "device-b",
	};
	const baseline = createConfirmedBaseline(local, remote, canonical);

	assert.equal(baseline.changedRevision, 8);
	assert.equal(baseline.baseRevision, 7);
	assert.equal(baseline.lastModifiedBy, "device-b");
});

test("encryption rewrite changes fingerprints without changing causal revision", () => {
	const baseline = {
		...metadata("note.md", "plain"),
		changedRevision: 8,
		baseRevision: 7,
		remoteFingerprint: "old-ciphertext",
	};
	const rewritten = mergePhysicalMetadata(
		{ ...baseline },
		baseline,
		{
			...baseline,
			remoteFingerprint: "new-ciphertext",
			remoteMtime: 300,
		},
	);
	assert.equal(rewritten?.changedRevision, 8);
	assert.equal(rewritten?.baseRevision, 7);
	assert.equal(rewritten?.remoteFingerprint, "new-ciphertext");
});

test("encryption rewrite rejects a concurrent logical edit", () => {
	const baseline = {
		...metadata("note.md", "plain"),
		changedRevision: 8,
	};
	assert.equal(
		mergePhysicalMetadata(
			{ ...baseline, sha256: "concurrent" },
			baseline,
			{ ...baseline, remoteFingerprint: "target" },
		),
		null,
	);
});
