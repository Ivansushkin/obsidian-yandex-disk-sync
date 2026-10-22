import assert from "node:assert/strict";
import test from "node:test";
import type { VaultAdapter } from "../src/api/vault-adapter";
import type { YandexDiskClient } from "../src/api/yandex-client";
import type { IndexManager } from "../src/sync/canonical/manager";
import { SyncEngine } from "../src/sync/engine";
import { prepareFullUploadMutations } from "../src/sync/workflows/full";
import * as syncReconciliation from "../src/sync/reconciliation/commits";

import {
	DEFAULT_SETTINGS,
	type FileMetadata,
	type SyncOperation,
} from "../src/types";
import {
	fileMetadata,
	MemoryIndex,
	reconciliationDependencies,
	syncResult,
} from "./helpers/realtime-fixtures";

function metadata(path: string): FileMetadata {
	return fileMetadata(path, "hash", {
		size: 4,
		changedRevision: 7,
		baseRevision: 6,
		lastModifiedBy: "device-a",
		mutationSeq: 1,
		remoteFingerprint: "fingerprint",
	});
}

class FullDeleteIndexFake extends MemoryIndex {
	constructor() {
		super();
		this.index.appliedMutationSeq["device-a"] = 1;
		this.store.loadMutations(undefined, 2);
	}
}

function createEngine(index: FullDeleteIndexFake): SyncEngine {
	return new SyncEngine(
		{} as YandexDiskClient,
		{} as VaultAdapter,
		index as unknown as IndexManager,
		{ ...DEFAULT_SETTINGS, deviceId: "device-a" },
	);
}

test("full-discovered logical delete receives and confirms a FIFO sequence", async () => {
	const index = new FullDeleteIndexFake();
	index.index.files["note.md"] = metadata("note.md");
	index.local.files["note.md"] = metadata("note.md");
	const operation: SyncOperation = {
		action: "delete_remote",
		path: "note.md",
		reason: "File deleted locally",
		remoteMeta: metadata("note.md"),
		causalOrigin: "new-local-operation",
	};
	const deps = reconciliationDependencies(createEngine(index));

	assert.ok(
		await syncReconciliation.commitDeletionIntents(
			deps,
			[operation],
			syncResult(),
		),
	);
	assert.equal(index.index.files["note.md"]?.deleted, true);
	assert.equal(index.index.files["note.md"]?.mutationSeq, 2);
	assert.equal(index.index.appliedMutationSeq["device-a"], 2);
	assert.deepEqual(index.store.getMutations(), []);
});

test("applying a canonical tombstone preserves foreign causal attribution", async () => {
	const index = new FullDeleteIndexFake();
	index.index.files["note.md"] = {
		...metadata("note.md"),
		deleted: true,
		lastModifiedBy: "device-b",
		mutationSeq: 9,
	};
	const operation: SyncOperation = {
		action: "delete_local",
		path: "note.md",
		reason: "Exact-file remote deletion wins",
		causalOrigin: "apply-canonical",
	};
	const deps = reconciliationDependencies(createEngine(index));

	assert.ok(
		await syncReconciliation.commitDeletionIntents(
			deps,
			[operation],
			syncResult(),
		),
	);
	assert.equal(index.index.files["note.md"]?.lastModifiedBy, "device-b");
	assert.equal(index.index.files["note.md"]?.mutationSeq, 9);
	assert.deepEqual(index.store.getMutations(), []);
});

test("full upload planning preserves latest matching FIFO identities across repeated paths", () => {
	const index = new MemoryIndex();
	const first = index.enqueueMutation("put", "__proto__", {
		sha256: "same",
		baselineSha256: "old",
		epoch: "old-epoch",
	});
	const latestMatch = index.enqueueMutation("put", "__proto__", {
		sha256: "same",
		epoch: "epoch-a",
	});
	const different = index.enqueueMutation("put", "__proto__", {
		sha256: "other",
		baselineSha256: "different",
		epoch: "epoch-a",
	});
	const missingSha = index.enqueueMutation("put", "constructor", {
		epoch: "epoch-a",
	});
	const planned = prepareFullUploadMutations(
		{ indexManager: index },
		[
			["__proto__", "same"],
			["new/note.md", "fresh"],
			["new/note.md", "fresh"],
			["__proto__", "other"],
		].map(([path, sha256]) => ({
			action: "upload",
			path: path!,
			reason: "local content",
			localMeta: { ...metadata(path!), sha256: sha256! },
		})),
	);
	assert.deepEqual(
		planned.map((mutation) => mutation.id),
		[latestMatch.id, "device-a:5", "device-a:5", different.id],
	);
	assert.equal(planned[0]?.baselineSha256, undefined);
	assert.equal(planned[0]?.epoch, "epoch-a");
	assert.equal(index.getPendingMutations().length, 5);
	assert.equal(
		index.findPendingMatchingPut("__proto__", "same", "first")?.id,
		first.id,
	);
	const observed = index.findPendingMatchingPut("__proto__", "same", "last")!;
	assert.equal(observed.id, latestMatch.id);
	observed.path = "changed-copy";
	assert.equal(
		index.findPendingMatchingPut("__proto__", "same", "last")?.id,
		latestMatch.id,
	);
	assert.equal(
		index.findPendingMatchingPut("constructor", undefined, "last")?.id,
		missingSha.id,
	);
	assert.equal(
		index.findPendingMatchingPut("missing", undefined, "last"),
		undefined,
	);
});
