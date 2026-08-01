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
	type SyncPhase,
	type SyncProgress,
} from "../src/types";

class FullSyncIndexFake {
	readonly index = createEmptyIndex("device-a", "epoch-a");
	readonly local = createEmptyLocalState("device-a");
	readonly store = new LocalOperationStore("device-a");
	readonly localFiles = new Map<string, FileMetadata>();
	readonly remoteFiles = new Map<string, FileMetadata>();
	remoteSaveCount = 0;
	onBuildLocalIndex: (() => void) | null = null;

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
		this.onBuildLocalIndex?.();
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
	const vaultFiles = new Set<string>();
	let folderCacheClearCount = 0;
	const yandexClient = {
		clearFolderCache: () => {
			folderCacheClearCount++;
		},
	};
	const engine = new SyncEngine(
		yandexClient as unknown as YandexDiskClient,
		{
			shouldSync: () => true,
			fileExists: (path: string) => vaultFiles.has(path),
		} as unknown as VaultAdapter,
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
	engine.onSyncPrepare(
		async (context) => await watcher.prepareForSync(context),
	);
	engine.onSyncPause(
		async (context) => await watcher.pauseForSync(context),
	);
	engine.onSyncFinalize(
		async (context, result) =>
			await watcher.settleAfterReconciliation(context, result),
	);
	engine.onSyncResume(
		async (outcome) => await watcher.resumeAfterSync(outcome),
	);
	return {
		engine,
		index,
		watcher,
		vaultFiles,
		getFolderCacheClearCount: () => folderCacheClearCount,
	};
}

function renameEvent(id: string): DeferredWatcherEvent {
	return {
		id,
		action: "rename",
		path: "A.md",
		targetPath: "B.md",
		kind: "file",
		epoch: "epoch-a",
		baseRevision: 7,
		createdAt: 1,
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

	test(`${mode} full supersedes a stale rename after both paths settle`, async () => {
		const { engine, index, watcher } = createHarness(encrypted);
		watcher.loadDeferredEvents([renameEvent("stale-rename")]);

		const result = await engine.fullSync();

		assert.equal(result.success, true);
		assert.equal(index.remoteSaveCount, 0);
		assert.deepEqual(watcher.getDeferredEvents(), []);
	});
}

test("full leaves an ambiguous causal rename durable and reports an error", async () => {
	const { engine, index, watcher, vaultFiles } = createHarness(false);
	const source = {
		path: "A.md",
		sha256: "source-sha",
		size: 1,
		mtime: 1,
		syncedAt: 1,
		changedRevision: 7,
	};
	index.index.files["A.md"] = { ...source };
	index.local.files["A.md"] = { ...source };
	index.localFiles.set("A.md", { ...source });
	index.remoteFiles.set("A.md", { ...source });
	vaultFiles.add("A.md");
	watcher.loadDeferredEvents([renameEvent("ambiguous-rename")]);

	const result = await engine.fullSync();

	assert.equal(result.success, false);
	assert.equal(
		result.errors.some(
			(error) => error.code === "watcher-rename-unresolved",
		),
		true,
	);
	assert.equal(watcher.getDeferredEvents().length, 1);
	assert.equal(index.local.observedRevision, 7);
});

test("full acknowledges an already applied rename target without remote write", async () => {
	const { engine, index, watcher, vaultFiles } = createHarness(false);
	const target = {
		path: "B.md",
		sha256: "target-sha",
		size: 1,
		mtime: 1,
		syncedAt: 1,
		changedRevision: 7,
		remoteFingerprint: "target-fingerprint",
	};
	index.index.files["B.md"] = { ...target };
	index.local.files["B.md"] = { ...target };
	index.localFiles.set("B.md", { ...target });
	index.remoteFiles.set("B.md", { ...target });
	index.onBuildLocalIndex = () => vaultFiles.add("B.md");
	watcher.loadDeferredEvents([renameEvent("applied-rename")]);

	const result = await engine.fullSync();

	assert.equal(result.success, true);
	assert.equal(index.remoteSaveCount, 0);
	assert.deepEqual(watcher.getDeferredEvents(), []);
});

test("post-full rename acknowledgement persists before observed revision advances", async () => {
	const { engine, index, watcher } = createHarness(false);
	index.index.revision = 8;
	const persisted: Array<{
		pendingEvents: number;
		observedRevision: number;
	}> = [];
	watcher.setPersistCallback(async () => {
		persisted.push({
			pendingEvents: watcher.getDeferredEvents().length,
			observedRevision: index.local.observedRevision,
		});
	});
	watcher.loadDeferredEvents([renameEvent("stale-rename")]);

	const result = await engine.fullSync();

	assert.equal(result.success, true);
	assert.equal(index.local.observedRevision, 8);
	assert.equal(
		persisted.some(
			(snapshot) =>
				snapshot.pendingEvents === 0 &&
				snapshot.observedRevision === 7,
		),
		true,
	);
});

test("strict no-op validates encryption only once", async () => {
	const { engine } = createHarness(true);
	const calls: Array<string | undefined> = [];
	let pausedBeforeGuard = false;
	engine.onSyncPause(() => {
		pausedBeforeGuard = true;
	});
	engine.setSyncGuardCallback((validationToken) => {
		assert.equal(pausedBeforeGuard, true);
		calls.push(validationToken);
		return {
			blockReason: null,
			validationToken: validationToken ?? "manifest-v1",
		};
	});

	const result = await engine.fullSync();

	assert.equal(result.success, true);
	assert.deepEqual(calls, [undefined]);
});

test("dirty full validates the manifest token before commit", async () => {
	const { engine, index } = createHarness(true);
	index.enqueuePut("missing.md", "obsolete-local-sha");
	const calls: Array<string | undefined> = [];
	engine.setSyncGuardCallback((validationToken) => {
		calls.push(validationToken);
		return {
			blockReason: null,
			validationToken: validationToken ?? "manifest-v1",
		};
	});

	const result = await engine.fullSync();

	assert.equal(result.success, true);
	assert.deepEqual(calls, [undefined, "manifest-v1"]);
});

test("full UI activity starts before watcher preparation", async () => {
	const { engine } = createHarness(false);
	const phases: Array<SyncPhase | undefined> = [];
	let stateDuringPreparation = engine.getState();
	engine.onStateChange((state) => phases.push(state.phase));
	engine.onSyncPrepare(() => {
		stateDuringPreparation = engine.getState();
	});

	const result = await engine.fullSync();

	assert.equal(result.success, true);
	assert.equal(phases.includes("preparing-local"), true);
	assert.equal(stateDuringPreparation.status, "syncing");
	assert.equal(stateDuringPreparation.sessionKind, "full");
	assert.equal(stateDuringPreparation.phase, "queued");
});

test("changing sync phase clears progress from the previous phase", () => {
	const { engine } = createHarness(false);
	const access = engine as unknown as {
		setSyncPhase(
			phase: SyncPhase,
			operation?: string,
			progress?: SyncProgress,
		): void;
	};

	access.setSyncPhase("applying", "Applying", {
		completed: 3,
		total: 3,
	});
	assert.deepEqual(engine.getState().progress, {
		completed: 3,
		total: 3,
	});

	access.setSyncPhase("saving-index", "Saving index");
	assert.equal(engine.getState().progress, undefined);
});
