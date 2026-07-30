import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import type { YandexDiskClient } from "../src/api/yandex-client";
import type { VaultAdapter } from "../src/api/vault-adapter";
import { FileWatcher, type DeferredWatcherEvent } from "../src/sync/file-watcher";
import type { IndexManager } from "../src/sync/index-manager";
import { LocalOperationStore } from "../src/sync/local-operation-store";
import { SyncEngine } from "../src/sync/sync-engine";
import {
	createEmptyIndex,
	createEmptyLocalState,
	DEFAULT_SETTINGS,
	type FileMetadata,
	type PendingMutation,
} from "../src/types";

class FullSyncIndexFake {
	readonly index = createEmptyIndex("device-a", "epoch-a");
	readonly local = createEmptyLocalState("device-a");
	readonly store = new LocalOperationStore("device-a");
	readonly localFiles = new Map<string, FileMetadata>();
	readonly remoteFiles = new Map<string, FileMetadata>();
	remoteSaveCount = 0;

	constructor() {
		this.index.revision = 7;
		this.local.observedEpoch = "epoch-a";
		this.local.observedRevision = 7;
		this.store.loadMutations(undefined, 1);
	}

	async remotePathExists() {
		return true;
	}

	async loadRemoteIndex() {}

	replayPendingMutations() {
		const before = this.store.getMutations().length;
		this.store.confirmAppliedMutations(this.index.appliedMutationSeq);
		return before !== this.store.getMutations().length;
	}

	getRemoteIndex() {
		return this.index;
	}

	getLocalIndex() {
		return this.local;
	}

	getMaintenance() {
		return undefined;
	}

	getPendingMutations() {
		return this.store.getMutations();
	}

	getPendingPhysicalActions() {
		return [];
	}

	getPendingLocalDeletePaths() {
		return new Set<string>();
	}

	async buildLocalIndex() {
		return new Map(this.localFiles);
	}

	async getRemoteFiles() {
		return new Map(this.remoteFiles);
	}

	updateLocalFile(path: string, metadata: FileMetadata) {
		this.local.files[path] = { ...metadata };
	}

	updateRemoteFile(path: string, metadata: FileMetadata) {
		this.index.files[path] = { ...metadata };
	}

	replacePendingPutWithNoop(id: string) {
		return this.store.replacePutWithNoop(id);
	}

	stagePendingMutations() {
		this.store.stagePendingMutations(this.index.appliedMutationSeq);
	}

	confirmAppliedMutations() {
		this.store.confirmAppliedMutations(this.index.appliedMutationSeq);
	}

	enqueuePut(path: string, sha256: string): PendingMutation {
		return this.store.enqueueMutation(
			"put",
			path,
			"epoch-a",
			this.local.observedRevision,
			{ sha256 },
		);
	}

	async saveRemoteIndex() {
		this.remoteSaveCount++;
		this.index.revision++;
	}

	consumeRejectedPuts() {
		return [];
	}

	cleanupDeletedFiles() {
		return false;
	}

	updateSyncTime() {
		this.index.lastSyncTime = Date.now();
	}

	markRemoteObserved() {
		this.local.observedEpoch = this.index.epoch;
		this.local.observedRevision = this.index.revision;
	}
}

interface WatcherAccess {
	isEnabled: boolean;
}

function createHarness(encrypted: boolean) {
	const index = new FullSyncIndexFake();
	let folderCacheClearCount = 0;
	const yandexClient = {
		clearFolderCache: () => {
			folderCacheClearCount++;
		},
	};
	const engine = new SyncEngine(
		yandexClient as unknown as YandexDiskClient,
		{} as VaultAdapter,
		index as unknown as IndexManager,
		{
			...DEFAULT_SETTINGS,
			deviceId: "device-a",
			remotePath: "remote",
			enableEncryption: encrypted,
		},
	);
	const watcher = new FileWatcher(
		{} as App,
		engine,
		DEFAULT_SETTINGS,
	);
	(watcher as unknown as WatcherAccess).isEnabled = true;
	watcher.setPersistCallback(async () => {});
	engine.onSyncPause(
		async (context) => await watcher.pauseForSync(context),
	);
	engine.onSyncResume(
		async (outcome) => await watcher.resumeAfterSync(outcome),
	);
	return {
		engine,
		index,
		watcher,
		getFolderCacheClearCount: () => folderCacheClearCount,
	};
}

function uploadEvent(id: string, path: string): DeferredWatcherEvent {
	return {
		id,
		action: "upload",
		path,
		epoch: "epoch-a",
		baseRevision: 7,
		createdAt: 1,
	};
}

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";

	test(`${mode} no-op full consumes a stale watcher upload without remote write`, async () => {
		const {
			engine,
			index,
			watcher,
			getFolderCacheClearCount,
		} = createHarness(encrypted);
		watcher.loadDeferredEvents([
			uploadEvent("stale-upload", "missing.md"),
		]);

		const result = await engine.fullSync();

		assert.equal(result.success, true);
		assert.equal(result.uploaded, 0);
		assert.equal(result.downloaded, 0);
		assert.equal(result.deleted, 0);
		assert.equal(index.remoteSaveCount, 0);
		assert.equal(getFolderCacheClearCount(), 1);
		assert.deepEqual(watcher.getDeferredEvents(), []);
	});

	test(`${mode} full settles an uncommitted put with one watermark commit`, async () => {
		const { engine, index } = createHarness(encrypted);
		const pending = index.enqueuePut(
			"missing.md",
			"obsolete-local-sha",
		);

		const result = await engine.fullSync();

		assert.equal(result.success, true);
		assert.equal(index.remoteSaveCount, 1);
		assert.equal(index.index.files["missing.md"], undefined);
		assert.equal(
			index.index.appliedMutationSeq["device-a"],
			pending.seq,
		);
		assert.deepEqual(index.store.getMutations(), []);
	});
}
