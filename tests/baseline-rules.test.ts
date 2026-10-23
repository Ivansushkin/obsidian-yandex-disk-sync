import { fileMetadata } from "./helpers/metadata";
import assert from "node:assert/strict";
import test from "node:test";
import type { FileMetadata } from "../src/types";
import {
	createConfirmedBaseline,
	mergePhysicalMetadata,
} from "../src/sync/local/baseline-rules";

function metadata(path: string, sha256: string): FileMetadata {
	return fileMetadata(path, { sha256, size: 10, mtime: 100, syncedAt: 100 });
}

test("confirmed baseline combines physical identity with canonical causal metadata", () => {
	const local = metadata("note.md", "same");
	const remote = {
		...local,
		remoteMtime: 200,
		remoteFingerprint: "server-fingerprint",
	};
	const causal = {
		changedRevision: 8,
		baseRevision: 7,
		lastModifiedBy: "device-b",
		mutationSeq: 11,
	};
	for (const canonical of [undefined, { ...local, ...causal }]) {
		const label = canonical ? "canonical confirmation" : "initial receive";
		const baseline = createConfirmedBaseline(local, remote, canonical);
		assert.equal(baseline.sha256, "same", label);
		assert.equal(baseline.remoteMtime, 200, label);
		assert.equal(baseline.remoteFingerprint, "server-fingerprint", label);
		assert.equal(baseline.deleted, false, label);
		if (canonical) {
			for (const key of Object.keys(causal) as (keyof typeof causal)[]) {
				assert.equal(baseline[key], causal[key], `${label}: ${key}`);
			}
		}
	}
});

test("physical rewrites preserve causality and reject concurrent logical edits", () => {
	const baseline = {
		...metadata("note.md", "plain"),
		changedRevision: 8,
		baseRevision: 7,
		remoteFingerprint: "old-ciphertext",
	};
	const physical = {
		...baseline,
		remoteFingerprint: "new-ciphertext",
		remoteMtime: 300,
	};
	for (const [sha256, expected] of [
		[
			"plain",
			{
				...baseline,
				remoteFingerprint: "new-ciphertext",
				remoteMtime: 300,
			},
		],
		["concurrent", null],
	] as const) {
		assert.deepEqual(
			mergePhysicalMetadata({ ...baseline, sha256 }, baseline, physical),
			expected,
			sha256,
		);
	}
});
