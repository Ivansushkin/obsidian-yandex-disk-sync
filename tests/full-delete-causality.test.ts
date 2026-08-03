import assert from "node:assert/strict";
import test from "node:test";
import type { YandexDiskClient } from "../src/api/yandex-client";
import type { VaultAdapter } from "../src/api/vault-adapter";
import type { IndexManager } from "../src/sync/index-manager";
import { LocalOperationStore } from "../src/sync/local-operation-store";
import { SyncEngine } from "../src/sync/sync-engine";
import {
	createEmptyIndex,
	createEmptyLocalState,
	DEFAULT_SETTINGS,
	type FileMetadata,
	type PendingMutation,
	type SyncOperation,
	type SyncResult,
} from "../src/types";

function metadata(path: string): FileMetadata {
	return {
		path,
		sha256: "hash",
		size: 4,
		mtime: 1,
		syncedAt: 1,
		changedRevision: 7,
		baseRevision: 6,
		lastModifiedBy: "device-a",
		mutationSeq: 1,
		remoteFingerprint: "fingerprint",
	};
}

class FullDeleteIndexFake {
	readonly index = createEmptyIndex("device-a", "epoch-a");
	readonly local = createEmptyLocalState("device-a");
	readonly store = new LocalOperationStore("device-a");
	physicalActions = 0;

	constructor() {
		this.index.revision = 7;
		this.index.appliedMutationSeq["device-a"] = 1;
		this.local.observedEpoch = "epoch-a";
		this.local.observedRevision = 7;
		this.store.loadMutations(undefined, 2);
	}

	getRemoteIndex() { return this.index; }
	getLocalIndex() { return this.local; }
	getPendingMutations() { return this.store.getMutations(); }

	enqueueMutation(
		type: "delete-file",
		path: string,
		options?: { baselineSha256?: string },
	): PendingMutation {
		return this.store.enqueueMutation(
			type,
			path,
			this.local.observedEpoch,
			this.local.observedRevision,
			options,
		);
	}

	stageMutation(mutation: PendingMutation) {
		this.store.stageMutation(this.index.appliedMutationSeq, mutation);
	}

	stagePendingMutations() {
		this.store.stagePendingMutations(this.index.appliedMutationSeq);
	}

	confirmAppliedMutations() {
		this.store.confirmAppliedMutations(this.index.appliedMutationSeq);
	}

	markRemoteFileDeleted(
		path: string,
		_deletedByFolder: string | undefined,
		baseRevision: number,
		mutationSeq: number,
	) {
		this.index.files[path] = {
			...this.index.files[path]!,
			deleted: true,
			baseRevision,
			lastModifiedBy: "device-a",
			mutationSeq,
		};
	}

	markRemoteFileDeletedByCanonicalFolder() {
		throw new Error("not expected");
	}

	markLocalFileDeleted(path: string, _folder: string | undefined, mutationSeq: number) {
		this.local.files[path] = {
			...this.local.files[path]!,
			deleted: true,
			lastModifiedBy: "device-a",
			mutationSeq,
		};
	}

	enqueuePhysicalAction() {
		this.physicalActions++;
		return { id: `action-${this.physicalActions}` };
	}

	updateSyncTime() {}
	consumeRejectedPuts() { return []; }

	async saveRemoteIndex() {
		this.index.revision++;
	}
}

function createResult(): SyncResult {
	return {
		success: true,
		uploaded: 0,
		downloaded: 0,
		deleted: 0,
		conflicts: 0,
		errors: [],
		startTime: 1,
		endTime: 0,
	};
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
	const access = createEngine(index) as unknown as {
		commitDeletionIntents(
			operations: SyncOperation[],
			result: SyncResult,
		): Promise<boolean>;
	};

	assert.equal(await access.commitDeletionIntents([operation], createResult()), true);
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
	const access = createEngine(index) as unknown as {
		commitDeletionIntents(
			operations: SyncOperation[],
			result: SyncResult,
		): Promise<boolean>;
	};

	assert.equal(await access.commitDeletionIntents([operation], createResult()), true);
	assert.equal(index.index.files["note.md"]?.lastModifiedBy, "device-b");
	assert.equal(index.index.files["note.md"]?.mutationSeq, 9);
	assert.deepEqual(index.store.getMutations(), []);
});
