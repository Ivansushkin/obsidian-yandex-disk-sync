import assert from "node:assert/strict";
import test from "node:test";
import type { VaultAdapter } from "../src/api/vault-adapter";
import type { YandexDiskClient } from "../src/api/yandex-client";
import type { IndexManager } from "../src/sync/canonical/manager";
import { SyncEngine } from "../src/sync/engine";
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
