import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import { FileWatcher, type DeferredWatcherEvent } from "../src/sync/file-watcher";
import type { SyncEngine } from "../src/sync/sync-engine";
import type { RealtimeFileEvent } from "../src/sync/realtime-rules";
import { DEFAULT_SETTINGS } from "../src/types";

interface FileWatcherTestAccess {
	isEnabled: boolean;
	submittedFileEvents: Map<string, {
		id: string;
		path: string;
		action: "upload" | "delete";
		epoch: string | null;
		baseRevision: number | null;
		createdAt: number;
		superseded?: boolean;
	}>;
	submittedWatcherEventIds: Set<string>;
	deferEvent(event: DeferredWatcherEvent): boolean;
	flushDeferredEventsNow(): Promise<void>;
	settleRenameEvent(
		event: DeferredWatcherEvent,
		outcome: {
			status: "completed" | "superseded" | "retry";
			canonicalRevision: number | null;
			epoch: string | null;
			reason?: string;
			remoteStarted: boolean;
		},
	): Promise<void>;
	cancelPendingSync(path: string): void;
	captureFullSyncBarrier(context: {
		sessionId: string;
		kind: "full";
	}): void;
	completeFullSyncBarrier(outcome: {
		sessionId: string;
		kind: "full";
		success: boolean;
	}): void;
}

function createWatcher(): FileWatcher {
	const syncEngine = {
		getWatcherCausalContext: () => ({
			epoch: "epoch-a",
			baseRevision: 7,
		}),
	} as unknown as SyncEngine;
	return new FileWatcher(
		{} as App,
		syncEngine,
		DEFAULT_SETTINGS,
	);
}

test("legacy watcher file events receive durable causal metadata", () => {
	const watcher = createWatcher();
	watcher.loadDeferredEvents([
		{
			action: "upload",
			path: "A.md",
		} as DeferredWatcherEvent,
	]);

	const [loaded] = watcher.getDeferredEvents();
	assert.ok(loaded);
	assert.equal(loaded.action, "upload");
	assert.equal("id" in loaded, true);
	assert.equal("epoch" in loaded ? loaded.epoch : undefined, "epoch-a");
	assert.equal(
		"baseRevision" in loaded ? loaded.baseRevision : undefined,
		7,
	);
	assert.equal(
		"createdAt" in loaded && typeof loaded.createdAt === "number",
		true,
	);
});

test("quick file rename chain coalesces to the final target", () => {
	const watcher = createWatcher();
	watcher.loadDeferredEvents([]);
	const access = watcher as unknown as FileWatcherTestAccess;

	access.deferEvent({
		action: "rename",
		path: "A.md",
		targetPath: "B.md",
		kind: "file",
	});
	access.deferEvent({
		action: "rename",
		path: "B.md",
		targetPath: "deep/С.md",
		kind: "file",
	});

	assert.deepEqual(
		watcher.getDeferredEvents().map((event) => ({
			action: event.action,
			path: event.path,
			targetPath:
				event.action === "rename" ? event.targetPath : undefined,
		})),
		[
			{
				action: "rename",
				path: "A.md",
				targetPath: "deep/С.md",
			},
		],
	);
});

test("new file at the old path survives a queued rename", () => {
	const watcher = createWatcher();
	watcher.loadDeferredEvents([]);
	const access = watcher as unknown as FileWatcherTestAccess;

	access.deferEvent({
		action: "rename",
		path: "A.md",
		targetPath: "B.md",
		kind: "file",
	});
	access.deferEvent({
		id: "new-a",
		action: "upload",
		path: "A.md",
		epoch: "epoch-a",
		baseRevision: 7,
		createdAt: 2,
	});

	assert.deepEqual(
		watcher.getDeferredEvents().map((event) => event.action),
		["rename", "upload"],
	);
});

test("running rename keeps successor and safely rebases a missing target", async () => {
	const watcher = createWatcher();
	watcher.loadDeferredEvents([]);
	const access = watcher as unknown as FileWatcherTestAccess;

	access.deferEvent({
		id: "rename-a",
		action: "rename",
		path: "A.md",
		targetPath: "B.md",
		kind: "file",
		epoch: "epoch-a",
		baseRevision: 7,
		createdAt: 1,
	});
	access.submittedWatcherEventIds.add("rename-a");
	access.deferEvent({
		id: "rename-b",
		action: "rename",
		path: "B.md",
		targetPath: "deep/C.md",
		kind: "file",
		epoch: "epoch-a",
		baseRevision: 7,
		createdAt: 2,
	});

	const [predecessor] = watcher.getDeferredEvents();
	assert.ok(predecessor);
	await access.settleRenameEvent(predecessor, {
		status: "retry",
		canonicalRevision: null,
		epoch: "epoch-a",
		reason: "target-missing-before-remote",
		remoteStarted: false,
	});

	assert.deepEqual(
		watcher.getDeferredEvents().map((event) => ({
			path: event.path,
			targetPath:
				event.action === "rename" ? event.targetPath : undefined,
		})),
		[{ path: "A.md", targetPath: "deep/C.md" }],
	);
});

test("completed running rename advances successor causal revision", async () => {
	const watcher = createWatcher();
	watcher.loadDeferredEvents([]);
	const access = watcher as unknown as FileWatcherTestAccess;
	const first: DeferredWatcherEvent = {
		id: "rename-a",
		action: "rename",
		path: "A.md",
		targetPath: "B.md",
		kind: "file",
		epoch: "epoch-a",
		baseRevision: 7,
		createdAt: 1,
	};
	access.deferEvent(first);
	access.submittedWatcherEventIds.add("rename-a");
	access.deferEvent({
		id: "rename-b",
		action: "rename",
		path: "B.md",
		targetPath: "C.md",
		kind: "file",
		epoch: "epoch-a",
		baseRevision: 7,
		createdAt: 2,
	});

	await access.settleRenameEvent(first, {
		status: "completed",
		canonicalRevision: 9,
		epoch: "epoch-a",
		remoteStarted: true,
	});

	const [successor] = watcher.getDeferredEvents();
	assert.ok(successor && "baseRevision" in successor);
	assert.equal(successor.baseRevision, 9);
});

test("queued target modify is absorbed but recreate of source remains", () => {
	const watcher = createWatcher();
	watcher.loadDeferredEvents([]);
	const access = watcher as unknown as FileWatcherTestAccess;
	access.deferEvent({
		id: "rename-a",
		action: "rename",
		path: "A.md",
		targetPath: "B.md",
		kind: "file",
		epoch: "epoch-a",
		baseRevision: 7,
		createdAt: 1,
	});

	assert.equal(
		access.deferEvent({
			id: "modify-b",
			action: "upload",
			path: "B.md",
			epoch: "epoch-a",
			baseRevision: 7,
			createdAt: 2,
		}),
		false,
	);
	assert.equal(
		access.deferEvent({
			id: "recreate-a",
			action: "upload",
			path: "A.md",
			epoch: "epoch-a",
			baseRevision: 7,
			createdAt: 3,
		}),
		true,
	);
	assert.deepEqual(
		watcher.getDeferredEvents().map((event) =>
			"id" in event ? event.id : null,
		),
		["rename-a", "recreate-a"],
	);
});

test("submitted upload is acknowledged only by coordinator settlement", () => {
	const watcher = createWatcher();
	const event: RealtimeFileEvent = {
		id: "upload-a",
		action: "upload" as const,
		path: "A.md",
		epoch: "epoch-a",
		baseRevision: 7,
		createdAt: 1,
	};
	watcher.loadDeferredEvents([event]);
	const access = watcher as unknown as FileWatcherTestAccess;
	access.submittedFileEvents.set(event.id, event);

	access.cancelPendingSync("A.md");

	assert.equal(event.superseded, true);
	assert.equal(watcher.getDeferredEvents().length, 1);
});

test("queued rename followed by delete reduces to source deletion", () => {
	const watcher = createWatcher();
	watcher.loadDeferredEvents([]);
	const access = watcher as unknown as FileWatcherTestAccess;
	access.deferEvent({
		id: "rename-a",
		action: "rename",
		path: "A.md",
		targetPath: "B.md",
		kind: "file",
		epoch: "epoch-a",
		baseRevision: 7,
		createdAt: 1,
	});
	access.deferEvent({
		id: "delete-b",
		action: "delete",
		path: "B.md",
		epoch: "epoch-a",
		baseRevision: 7,
		createdAt: 2,
	});

	assert.deepEqual(
		watcher.getDeferredEvents().map((event) => ({
			action: event.action,
			path: event.path,
		})),
		[{ action: "delete", path: "A.md" }],
	);
});

test("successful full barrier acknowledges only pre-full uploads", () => {
	const watcher = createWatcher();
	watcher.loadDeferredEvents([
		{
			id: "covered-upload",
			action: "upload",
			path: "covered.md",
			epoch: "epoch-a",
			baseRevision: 7,
			createdAt: 1,
		},
		{
			id: "delete-event",
			action: "delete",
			path: "deleted.md",
			epoch: "epoch-a",
			baseRevision: 7,
			createdAt: 2,
		},
		{
			id: "rename-event",
			action: "rename",
			path: "A.md",
			targetPath: "B.md",
			kind: "file",
			epoch: "epoch-a",
			baseRevision: 7,
			createdAt: 3,
		},
	]);
	const access = watcher as unknown as FileWatcherTestAccess;

	access.captureFullSyncBarrier({
		sessionId: "full-1",
		kind: "full",
	});
	access.deferEvent({
		id: "during-full-upload",
		action: "upload",
		path: "during.md",
		epoch: "epoch-a",
		baseRevision: 7,
		createdAt: 4,
	});
	access.completeFullSyncBarrier({
		sessionId: "full-1",
		kind: "full",
		success: true,
	});

	assert.deepEqual(
		watcher.getDeferredEvents().map((event) =>
			"id" in event ? event.id : event.path,
		),
		["delete-event", "rename-event", "during-full-upload"],
	);
});

test("failed full barrier retains every captured upload", () => {
	const watcher = createWatcher();
	watcher.loadDeferredEvents([
		{
			id: "covered-upload",
			action: "upload",
			path: "covered.md",
			epoch: "epoch-a",
			baseRevision: 7,
			createdAt: 1,
		},
	]);
	const access = watcher as unknown as FileWatcherTestAccess;

	access.captureFullSyncBarrier({
		sessionId: "full-1",
		kind: "full",
	});
	access.completeFullSyncBarrier({
		sessionId: "full-1",
		kind: "full",
		success: false,
	});

	assert.deepEqual(
		watcher.getDeferredEvents().map((event) =>
			"id" in event ? event.id : event.path,
		),
		["covered-upload"],
	);
});

test("full barrier acknowledgement is persisted before resume completes", async () => {
	const watcher = createWatcher();
	watcher.loadDeferredEvents([
		{
			id: "covered-upload",
			action: "upload",
			path: "covered.md",
			epoch: "epoch-a",
			baseRevision: 7,
			createdAt: 1,
		},
	]);
	const persistedQueues: string[][] = [];
	watcher.setPersistCallback(async () => {
		persistedQueues.push(
			watcher.getDeferredEvents().map((event) =>
				"id" in event && event.id ? event.id : event.path,
			),
		);
	});
	const access = watcher as unknown as FileWatcherTestAccess;
	access.isEnabled = true;
	access.captureFullSyncBarrier({
		sessionId: "full-1",
		kind: "full",
	});

	await watcher.resumeAfterSync({
		sessionId: "full-1",
		kind: "full",
		success: true,
	});

	assert.deepEqual(persistedQueues, [[]]);
	assert.deepEqual(watcher.getDeferredEvents(), []);
});

test("failed full sync postpones watcher replay", async () => {
	let fileBatchCalls = 0;
	const syncEngine = {
		getWatcherCausalContext: () => ({
			epoch: "epoch-a",
			baseRevision: 7,
		}),
		syncFileBatch: async () => {
			fileBatchCalls++;
			return {
				completed: [],
				superseded: [],
				retry: ["covered-upload"],
			};
		},
	} as unknown as SyncEngine;
	const watcher = new FileWatcher(
		{} as App,
		syncEngine,
		DEFAULT_SETTINGS,
	);
	watcher.loadDeferredEvents([
		{
			id: "covered-upload",
			action: "upload",
			path: "covered.md",
			epoch: "epoch-a",
			baseRevision: 7,
			createdAt: 1,
		},
	]);
	const access = watcher as unknown as FileWatcherTestAccess;
	access.isEnabled = true;
	access.captureFullSyncBarrier({
		sessionId: "full-1",
		kind: "full",
	});

	await watcher.resumeAfterSync({
		sessionId: "full-1",
		kind: "full",
		success: false,
	});
	await Promise.resolve();

	assert.equal(fileBatchCalls, 0);
	assert.deepEqual(
		watcher.getDeferredEvents().map((event) =>
			"id" in event ? event.id : event.path,
		),
		["covered-upload"],
	);
});

test("structured watcher retry remains durable without throwing", async () => {
	const syncEngine = {
		getWatcherCausalContext: () => ({
			epoch: "epoch-a",
			baseRevision: 7,
		}),
		syncFileBatch: async () => ({
			completed: [],
			superseded: [],
			retry: ["retry-upload"],
		}),
	} as unknown as SyncEngine;
	const watcher = new FileWatcher(
		{} as App,
		syncEngine,
		DEFAULT_SETTINGS,
	);
	watcher.loadDeferredEvents([
		{
			id: "retry-upload",
			action: "upload",
			path: "retry.md",
			epoch: "epoch-a",
			baseRevision: 7,
			createdAt: 1,
		},
	]);

	await (
		watcher as unknown as FileWatcherTestAccess
	).flushDeferredEventsNow();

	assert.deepEqual(
		watcher.getDeferredEvents().map((event) =>
			"id" in event ? event.id : event.path,
		),
		["retry-upload"],
	);
});

test("unresolved pre-full rename blocks normal full but not startup classification", async () => {
	const retryOutcome = {
		status: "retry" as const,
		canonicalRevision: null,
		epoch: "epoch-a",
		reason: "maintenance-active",
		remoteStarted: false,
	};
	const syncEngine = {
		getWatcherCausalContext: () => ({
			epoch: "epoch-a",
			baseRevision: 7,
		}),
		renameFile: async (
			_oldPath: string,
			_newPath: string,
			_context: unknown,
			settle: (outcome: typeof retryOutcome) => Promise<void>,
		) => {
			await settle(retryOutcome);
			return retryOutcome;
		},
	} as unknown as SyncEngine;
	const watcher = new FileWatcher({} as App, syncEngine, DEFAULT_SETTINGS);
	const access = watcher as unknown as FileWatcherTestAccess;
	access.isEnabled = true;
	watcher.loadDeferredEvents([
		{
			id: "rename-a",
			action: "rename",
			path: "A.md",
			targetPath: "B.md",
			kind: "file",
			epoch: "epoch-a",
			baseRevision: 7,
			createdAt: 1,
		},
	]);

	await assert.rejects(
		watcher.prepareForSync({ sessionId: "full-1", kind: "full" }),
		/left 1 unresolved event/,
	);
	await watcher.prepareForSync({
		sessionId: "full-2",
		kind: "full",
		startup: true,
	});
	assert.equal(watcher.getDeferredEvents().length, 1);
});

test("ambiguous rename failure does not execute its successor", async () => {
	let renameCalls = 0;
	const syncEngine = {
		getWatcherCausalContext: () => ({
			epoch: "epoch-a",
			baseRevision: 7,
		}),
		renameFile: async () => {
			renameCalls++;
			throw new Error("ambiguous canonical transaction");
		},
	} as unknown as SyncEngine;
	const watcher = new FileWatcher({} as App, syncEngine, DEFAULT_SETTINGS);
	watcher.loadDeferredEvents([
		{
			id: "rename-a",
			action: "rename",
			path: "A.md",
			targetPath: "B.md",
			kind: "file",
			epoch: "epoch-a",
			baseRevision: 7,
			createdAt: 1,
		},
		{
			id: "rename-b",
			action: "rename",
			path: "B.md",
			targetPath: "C.md",
			kind: "file",
			epoch: "epoch-a",
			baseRevision: 7,
			createdAt: 2,
		},
	]);

	await (
		watcher as unknown as FileWatcherTestAccess
	).flushDeferredEventsNow();

	assert.equal(renameCalls, 1);
	assert.equal(watcher.getDeferredEvents().length, 2);
});
