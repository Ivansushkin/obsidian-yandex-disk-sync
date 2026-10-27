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
import { logger } from "../src/utils/logger";
import { findErrorCause } from "../src/utils/error-utils";
import {
	FileWatcher,
	type DeferredWatcherEvent,
} from "../src/sync/realtime/watcher";
import {
	DEFAULT_SETTINGS,
	type FileMetadata,
	type IndexMaintenance,
	type PendingMutation,
	type SyncIndex,
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
		// Model the independent reducer baseline captured by a verified load.
		(
			this as unknown as { loadedRemoteIndex: SyncIndex }
		).loadedRemoteIndex = structuredClone(this.index);
		return structuredClone(this.index);
	}

	override createCanonicalReadSession(assertActive: () => void = () => {}) {
		const read = async () => {
			assertActive();
			return await this.readCanonicalIndex();
		};
		return Object.assign(read, {
			close: () => {},
			assertCurrent: assertActive,
			load: async () => {
				assertActive();
				return await this.loadRemoteIndex();
			},
		});
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
		interruptReads: () => {},
		async withWriteGuard<T>(
			assertCurrent: () => void,
			action: () => Promise<T>,
		): Promise<T> {
			assertCurrent();
			const result = await action();
			assertCurrent();
			return result;
		},
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

test("full settles stale watcher work and FIFO puts with only required canonical commits", async () => {
	for (const work of ["upload", "rename", "put"] as const) {
		const { engine, index, watcher, getFolderCacheClearCount } =
			createHarness(false);
		if (work === "put") {
			index.enqueuePut("missing.md", "obsolete-local-sha");
		} else {
			watcher.loadDeferredEvents(
				work === "upload"
					? [fileEvent("stale-upload", "missing.md")]
					: [renameEvent("stale-rename", "A.md", "B.md")],
			);
		}
		let paused = false;
		engine.onSyncPause(() => {
			paused = true;
		});
		const tokens: Array<string | undefined> = [];
		engine.setSyncGuardCallback((token) => {
			assert.equal(paused, true, work);
			tokens.push(token);
			return {
				blockReason: null,
				validationToken: token ?? "manifest-v1",
			};
		});
		const result = await engine.fullSync();
		assert.equal(result.success, true, work);
		assert.deepEqual(
			[result.uploaded, result.downloaded, result.deleted],
			[0, 0, 0],
			work,
		);
		assert.equal(index.remoteSaveCount, work === "put" ? 1 : 0, work);
		assert.equal(getFolderCacheClearCount(), 1, work);
		assert.deepEqual(watcher.getDeferredEvents(), [], work);
		assert.deepEqual(index.store.getMutations(), [], work);
		assert.deepEqual(
			tokens,
			work === "put" ? [undefined, "manifest-v1"] : [undefined],
			work,
		);
		if (work === "put") {
			assert.equal(index.index.files["missing.md"], undefined);
			assert.equal(index.index.appliedMutationSeq["device-a"], 1);
		}
	}
});

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

test("an explicit epoch choice accepts replacement without Force ping-pong", async () => {
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

	const blocked = await engine.fullSync();
	assert.equal(blocked.errors[0]?.code, "epoch-decision-required");
	const result = await engine.fullSync({
		epochAdoption: { epoch: "epoch-b", decision: "preserve" },
	});

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

test("full retains ambiguous rename sources and acknowledges materialized targets", async () => {
	for (const applied of [false, true]) {
		const { engine, index, watcher, vaultFiles } = createHarness(false);
		const path = applied ? "B.md" : "A.md";
		const metadata = fileMetadata(path, "content", {
			changedRevision: 7,
			remoteFingerprint: "fingerprint",
		});
		index.index.files[path] = { ...metadata };
		index.local.files[path] = { ...metadata };
		index.localFiles.set(path, { ...metadata });
		index.remoteFiles.set(path, { ...metadata });
		index.onBuildLocalIndex = () => vaultFiles.add(path);
		watcher.loadDeferredEvents([renameEvent("rename", "A.md", "B.md")]);
		const result = await engine.fullSync();
		assert.equal(result.success, applied);
		assert.equal(index.remoteSaveCount, 0);
		assert.equal(watcher.getDeferredEvents().length, applied ? 0 : 1);
		if (!applied) {
			assert.ok(
				result.errors.some(
					(error) => error.code === "watcher-rename-unresolved",
				),
			);
			assert.equal(index.local.observedRevision, 7);
		}
	}
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

test("failed full upload acknowledgement cannot report success and remains replayable after restart", async () => {
	const { engine, index, watcher } = createHarness(false);
	const original = fileEvent("covered-upload", "missing.md");
	watcher.loadDeferredEvents([original]);
	const loaded = watcher.getDeferredEvents();
	const failure = new Error("Synthetic full ACK persistence failure");
	let durable = watcher.getDeferredEvents();
	watcher.setPersistCallback(async () => {
		const events = watcher.getDeferredEvents();
		if (events.length === 0) {
			throw failure;
		}
		durable = JSON.parse(JSON.stringify(events)) as DeferredWatcherEvent[];
	});
	const successes: string[] = [];
	const info = logger.info.bind(logger);
	logger.info = (message, ...args) => {
		if (message.startsWith("Full reconciliation completed:")) {
			successes.push(message);
		}
		info(message, ...args);
	};
	let result;
	try {
		result = await engine.fullSync();
	} finally {
		logger.info = info;
	}
	assert.equal(result.success, false);
	assert.equal(
		findErrorCause(result.failureCause, (cause) => cause === failure),
		failure,
	);
	assert.equal(engine.getState().status, "error");
	assert.deepEqual(successes, []);
	assert.deepEqual(durable, [original]);
	assert.equal(index.remoteSaveCount, 0);
	assert.deepEqual(index.getPendingMutations(), []);
	const restarted = createHarness(false);
	restarted.watcher.loadDeferredEvents(
		JSON.parse(JSON.stringify(durable)) as DeferredWatcherEvent[],
	);
	assert.deepEqual(restarted.watcher.getDeferredEvents(), loaded);
	assert.equal((await restarted.engine.fullSync()).success, true);
	assert.deepEqual(restarted.watcher.getDeferredEvents(), []);
	assert.equal(restarted.index.remoteSaveCount, 0);
});

test("failed pause durability blocks full reconciliation before canonical work", async () => {
	const { engine, index, watcher } = createHarness(false);
	const event = fileEvent("covered-upload", "missing.md");
	watcher.loadDeferredEvents([event]);
	const loaded = watcher.getDeferredEvents();
	const failure = new Error("Synthetic pause persistence failure");
	engine.onSyncPause(async () => {
		throw failure;
	});
	let scanned = false;
	index.onBuildLocalIndex = () => {
		scanned = true;
	};
	const result = await engine.fullSync();
	assert.equal(result.success, false);
	assert.equal(
		findErrorCause(result.failureCause, (cause) => cause === failure),
		failure,
	);
	assert.equal(scanned, false);
	assert.deepEqual(watcher.getDeferredEvents(), loaded);
	assert.equal(index.local.observedRevision, 7);
	assert.equal(index.remoteSaveCount, 0);
});

test("failed epoch rebase save retains late watcher identity across restart without success", async () => {
	const { engine, index, watcher } = createHarness(false);
	watcher.stop();
	index.index.epoch = "epoch-b";
	let inserted = false;
	index.onBuildLocalIndex = () => {
		if (!inserted) {
			inserted = true;
			watcher.loadDeferredEvents([fileEvent("late-upload", "late.md")]);
		}
	};
	let durable: DeferredWatcherEvent[] = [];
	const failure = new Error("Synthetic epoch rebase save failure");
	watcher.setPersistCallback(async () => {
		const events = watcher.getDeferredEvents();
		if (events.some((event) => event.epoch === "epoch-b")) {
			throw failure;
		}
		durable = JSON.parse(JSON.stringify(events)) as DeferredWatcherEvent[];
	});

	const result = await engine.fullSync({
		epochAdoption: { epoch: "epoch-b", decision: "accept" },
	});

	assert.equal(result.success, false);
	assert.equal(result.epochAdopted, false);
	assert.equal(
		findErrorCause(result.failureCause, (cause) => cause === failure),
		failure,
	);
	assert.equal(index.getObservedEpoch(), "epoch-a");
	assert.equal(index.remoteSaveCount, 0);
	assert.deepEqual(durable, [fileEvent("late-upload", "late.md")]);
	const restarted = createHarness(false);
	restarted.index.index.epoch = "epoch-b";
	restarted.watcher.loadDeferredEvents(
		JSON.parse(JSON.stringify(durable)) as DeferredWatcherEvent[],
	);
	assert.equal(restarted.watcher.getDeferredEvents()[0]?.id, "late-upload");
	assert.equal((await restarted.engine.fullSync()).success, true);
	assert.deepEqual(restarted.watcher.getDeferredEvents(), []);
	assert.equal(restarted.index.remoteSaveCount, 0);
});
