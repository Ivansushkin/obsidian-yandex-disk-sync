import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import type { VaultAdapter } from "../src/api/vault-adapter";
import type { YandexDiskClient } from "../src/api/yandex-client";
import {
	IndexEpochMismatchError,
	RemoteIndexRolledBackError,
	type IndexManager,
} from "../src/sync/canonical/manager";
import { SyncEngine } from "../src/sync/engine";
import { classifySyncError } from "../src/sync/errors";
import { FileWatcher } from "../src/sync/realtime/watcher";
import {
	DEFAULT_SETTINGS,
	type FileMetadata,
	type IndexMaintenance,
	type PendingMutation,
} from "../src/types";
import {
	fileEvent,
	fileMetadata,
	MemoryIndex,
	renameEvent,
} from "./helpers/realtime-fixtures";

class FullSyncIndexFake extends MemoryIndex {
	readonly localFiles = new Map<string, FileMetadata>();

	readonly remoteFiles = new Map<string, FileMetadata>();

	onBuildLocalIndex: (() => void) | null = null;

	maintenance: IndexMaintenance | undefined = undefined;

	async remotePathExists() {
		return true;
	}

	async loadRemoteIndex() {
		return structuredClone(this.index);
	}

	getMaintenance() {
		return this.maintenance;
	}

	async buildLocalIndex() {
		this.onBuildLocalIndex?.();
		return new Map(this.localFiles);
	}

	async getRemoteFiles() {
		return new Map(this.remoteFiles);
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

	cleanupDeletedFiles() {
		return false;
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
	const watcher = new FileWatcher({} as App, engine, DEFAULT_SETTINGS);
	(watcher as unknown as WatcherAccess).isEnabled = true;
	watcher.setPersistCallback(async () => {});
	engine.onSyncPrepare(
		async (context) => await watcher.prepareForSync(context),
	);
	engine.onSyncPause(async (context) => await watcher.pauseForSync(context));
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

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";

	test(`${mode} no-op full consumes a stale watcher upload without remote write`, async () => {
		const { engine, index, watcher, getFolderCacheClearCount } =
			createHarness(encrypted);
		watcher.loadDeferredEvents([fileEvent("stale-upload", "missing.md")]);

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
		const pending = index.enqueuePut("missing.md", "obsolete-local-sha");

		const result = await engine.fullSync();

		assert.equal(result.success, true);
		assert.equal(index.remoteSaveCount, 1);
		assert.equal(index.index.files["missing.md"], undefined);
		assert.equal(index.index.appliedMutationSeq["device-a"], pending.seq);
		assert.deepEqual(index.store.getMutations(), []);
	});

	test(`${mode} full supersedes a stale rename after both paths settle`, async () => {
		const { engine, index, watcher } = createHarness(encrypted);
		watcher.loadDeferredEvents([
			renameEvent("stale-rename", "A.md", "B.md"),
		]);

		const result = await engine.fullSync();

		assert.equal(result.success, true);
		assert.equal(index.remoteSaveCount, 0);
		assert.deepEqual(watcher.getDeferredEvents(), []);
	});
}

test("encryption preflight rejects active canonical maintenance before filesystem work", async () => {
	const { engine, index } = createHarness(false);
	let scannedLocal = false;
	index.onBuildLocalIndex = () => {
		scannedLocal = true;
	};
	index.maintenance = {
		id: "stale-owned-transition",
		kind: "enable",
		phase: "prepared",
		initiatedBy: "device-a",
		sourceRevision: 7,
		targetRevision: null,
		source: {
			enabled: false,
			revision: null,
			salt: null,
			verifier: null,
		},
		target: {
			enabled: true,
			revision: 1,
			salt: "target-salt",
			verifier: "target-verifier",
		},
		cleanup: [],
	};

	const result = await engine.fullSync({
		skipMaintenanceGuard: true,
		requireStableCanonical: true,
	});

	assert.equal(result.success, false);
	assert.equal(scannedLocal, false);
	assert.equal(index.remoteSaveCount, 0);
	assert.match(
		result.errors[0]?.message ?? "",
		/requires a stable canonical/,
	);
});

test("owned encryption preflight revalidates remote state through its local block", async () => {
	const accepted = createHarness(false);
	let acceptedGuardCalls = 0;
	accepted.engine.setExternalBlockReason("local transition is active");
	accepted.engine.setSyncGuardCallback(() => {
		acceptedGuardCalls++;
		return { blockReason: null, validationToken: "stable-manifest" };
	});
	const acceptedResult = await accepted.engine.fullSync({
		skipMaintenanceGuard: true,
		requireStableCanonical: true,
		validateThroughExternalEncryptionBlock: true,
	});
	assert.equal(acceptedResult.success, true);
	assert.equal(acceptedGuardCalls, 1);

	const rejected = createHarness(false);
	let scannedLocal = false;
	rejected.index.onBuildLocalIndex = () => {
		scannedLocal = true;
	};
	rejected.engine.setExternalBlockReason("local transition is active");
	rejected.engine.setSyncGuardCallback(() => ({
		blockReason: "remote manifest is incoherent",
	}));
	const rejectedResult = await rejected.engine.fullSync({
		skipMaintenanceGuard: true,
		requireStableCanonical: true,
		validateThroughExternalEncryptionBlock: true,
	});
	assert.equal(rejectedResult.success, false);
	assert.equal(scannedLocal, false);
	assert.match(
		rejectedResult.errors[0]?.message ?? "",
		/remote manifest is incoherent/,
	);
});

test("stable 1.1 startup exposes Force without enabling normal sync", async () => {
	const { engine, index } = createHarness(false);
	engine.setExternalBlock("migration", "migration required");

	const normal = await engine.fullSync();
	assert.equal(normal.success, false);
	assert.equal(normal.errors[0]?.code, "migration-required");
	assert.equal(engine.getState().status, "migration-required");
	assert.equal(index.remoteSaveCount, 0);
	engine.pause();
	engine.resume();
	assert.equal(engine.getState().status, "migration-required");

	const force = await engine.forceSyncFromLocal();
	assert.equal(force.success, false);
	assert.equal(force.errors[0]?.code, "force-backup-stale");
	assert.notEqual(force.errors[0]?.code, "migration-required");
});

test("historical and authentication blocks reject Force before backup work", async () => {
	for (const [kind, code] of [
		["historical", "unsupported-historical"],
		["authentication", "authentication"],
	] as const) {
		const { engine, index } = createHarness(false);
		engine.setExternalBlock(kind, `${kind} blocked`);
		const result = await engine.forceSyncFromLocal();
		assert.equal(result.success, false);
		assert.equal(result.errors[0]?.code, code);
		assert.equal(index.remoteSaveCount, 0);
	}
});

test("a full sync accepts a replacement epoch without Force ping-pong", async () => {
	const { engine, index, watcher } = createHarness(false);
	const baseline = fileMetadata("same.md", "same");
	index.local.files[baseline.path] = { ...baseline };
	index.localFiles.set(baseline.path, { ...baseline });
	index.remoteFiles.set(baseline.path, { ...baseline });
	index.index.files[baseline.path] = { ...baseline };
	index.enqueuePut("obsolete.md", "obsolete");
	index.index.epoch = "epoch-b";
	watcher.loadDeferredEvents([
		renameEvent("old-epoch-rename", "A.md", "B.md"),
	]);

	const result = await engine.fullSync();

	assert.equal(result.success, true);
	assert.equal(result.epochAdopted, true);
	assert.equal(index.local.observedEpoch, "epoch-b");
	assert.deepEqual(index.store.getMutations(), []);
	assert.equal(index.remoteSaveCount, 0);
	assert.deepEqual(watcher.getDeferredEvents(), []);
});

test("recursive transaction cause keeps the epoch replacement classification", () => {
	const error = new RemoteIndexRolledBackError(
		"rolled back",
		"acquired",
		new IndexEpochMismatchError("epoch-a", "epoch-b"),
	);
	assert.equal(classifySyncError(error), "epoch-replaced-during-sync");
});

test("full leaves an ambiguous causal rename durable and reports an error", async () => {
	const { engine, index, watcher, vaultFiles } = createHarness(false);
	const source = fileMetadata("A.md", "source-sha", { changedRevision: 7 });
	index.index.files["A.md"] = { ...source };
	index.local.files["A.md"] = { ...source };
	index.localFiles.set("A.md", { ...source });
	index.remoteFiles.set("A.md", { ...source });
	vaultFiles.add("A.md");
	watcher.loadDeferredEvents([
		renameEvent("ambiguous-rename", "A.md", "B.md"),
	]);

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
	const target = fileMetadata("B.md", "target-sha", {
		changedRevision: 7,
		remoteFingerprint: "target-fingerprint",
	});
	index.index.files["B.md"] = { ...target };
	index.local.files["B.md"] = { ...target };
	index.localFiles.set("B.md", { ...target });
	index.remoteFiles.set("B.md", { ...target });
	index.onBuildLocalIndex = () => vaultFiles.add("B.md");
	watcher.loadDeferredEvents([renameEvent("applied-rename", "A.md", "B.md")]);

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
	watcher.loadDeferredEvents([renameEvent("stale-rename", "A.md", "B.md")]);

	const result = await engine.fullSync();

	assert.equal(result.success, true);
	assert.equal(index.local.observedRevision, 8);
	assert.equal(
		persisted.some(
			(snapshot) =>
				snapshot.pendingEvents === 0 && snapshot.observedRevision === 7,
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

test("full sync rejects an ambiguous remote tree before applying any file", async () => {
	for (const paths of [
		["Foo/a.md", "foo/b.md"],
		["folder", "folder/note.md"],
	]) {
		const { engine, index, vaultFiles } = createHarness(false);
		for (const path of paths) {
			index.remoteFiles.set(path, fileMetadata(path, "remote"));
		}
		const baseline = structuredClone(index.local);
		const canonical = structuredClone(index.index);
		const result = await engine.fullSync();
		assert.equal(result.success, false);
		assert.equal(result.errors[0]?.code, "portable-path-collision");
		assert.equal(result.downloaded, 0);
		assert.deepEqual(index.local, baseline);
		assert.deepEqual(index.index, canonical);
		assert.equal(index.remoteSaveCount, 0);
		assert.deepEqual([...vaultFiles], []);
	}
});
