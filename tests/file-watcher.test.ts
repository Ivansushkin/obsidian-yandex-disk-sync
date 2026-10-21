import assert from "node:assert/strict";
import test from "node:test";
import { TFile } from "obsidian";
import type { RealtimeFileEvent } from "../src/sync/realtime/rules";
import { type DeferredWatcherEvent } from "../src/sync/realtime/watcher";
import {
	createWatcher,
	eventIds,
	fileEvent,
	renameEvent,
} from "./helpers/realtime-fixtures";

test("legacy watcher file events receive durable causal metadata", () => {
	const { watcher } = createWatcher();
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
	assert.equal("baseRevision" in loaded ? loaded.baseRevision : undefined, 7);
	assert.equal(
		"createdAt" in loaded && typeof loaded.createdAt === "number",
		true,
	);
});

test("child rename ignores a newer unrelated folder event", () => {
	const { watcher, access } = createWatcher();

	access.deferEvent({
		id: "parent-a",
		action: "rename",
		path: "A",
		targetPath: "B",
		kind: "folder",
		epoch: "epoch-a",
		baseRevision: 7,
		createdAt: 1,
	});
	access.deferEvent({
		id: "unrelated",
		action: "rename",
		path: "X",
		targetPath: "Y",
		kind: "folder",
		epoch: "epoch-a",
		baseRevision: 7,
		createdAt: 2,
	});
	const retained = access.deferEvent(
		renameEvent("child", "A/note.md", "B/note.md", { createdAt: 3 }),
	);

	assert.equal(retained, false);
	assert.deepEqual(eventIds(watcher), ["parent-a", "unrelated"]);
});

test("running rename keeps successor and safely rebases a missing target", async () => {
	const { watcher, access } = createWatcher();

	access.deferEvent(renameEvent("rename-a", "A.md", "B.md"));
	access.submittedWatcherEventIds.add("rename-a");
	access.deferEvent(
		renameEvent("rename-b", "B.md", "deep/C.md", { createdAt: 2 }),
	);

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
	const { watcher, access } = createWatcher();

	const first: DeferredWatcherEvent = renameEvent("rename-a", "A.md", "B.md");
	access.deferEvent(first);
	access.submittedWatcherEventIds.add("rename-a");
	access.deferEvent(
		renameEvent("rename-b", "B.md", "C.md", { createdAt: 2 }),
	);

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
	const { watcher, access } = createWatcher();

	access.deferEvent(renameEvent("rename-a", "A.md", "B.md"));

	assert.equal(
		access.deferEvent(fileEvent("modify-b", "B.md", { createdAt: 2 })),
		false,
	);
	assert.equal(
		access.deferEvent(fileEvent("recreate-a", "A.md", { createdAt: 3 })),
		true,
	);
	assert.deepEqual(eventIds(watcher), ["rename-a", "recreate-a"]);
});

test("submitted upload is acknowledged only by coordinator settlement", () => {
	const { watcher, access } = createWatcher();
	const event: RealtimeFileEvent = fileEvent("upload-a", "A.md");
	watcher.loadDeferredEvents([event]);

	access.submittedFileEvents.set(event.id, event);

	access.cancelPendingSync("A.md");

	assert.equal(event.superseded, true);
	assert.equal(watcher.getDeferredEvents().length, 1);
});

test("file rename durably links the newest submitted source upload", () => {
	const { watcher, access } = createWatcher();
	watcher.loadDeferredEvents([
		fileEvent("upload-old", "A.md"),
		fileEvent("upload-current", "A.md", { createdAt: 2 }),
	]);

	for (const event of access.deferredEvents) {
		if (event.action === "upload") {
			access.submittedFileEvents.set(event.id, event);
		}
	}
	const target = new TFile();
	(target as TFile & { path: string }).path = "deep/B.md";

	access.handleFileRename(target, "A.md");

	const rename = watcher
		.getDeferredEvents()
		.find((event) => event.action === "rename");
	assert.ok(rename?.action === "rename" && rename.kind === "file");
	assert.equal(rename.predecessorUploadId, "upload-current");
	assert.equal(
		access.submittedFileEvents.get("upload-current")?.supersededByRenameId,
		rename.id,
	);
	access.drainPendingFileEvents();
});

test("accepted submitted upload advances its rename before acknowledgement", async () => {
	const { watcher, access } = createWatcher();
	watcher.loadDeferredEvents([
		fileEvent("upload-a", "A.md", {
			mutationId: "device-a:1",
			mutationSeq: 1,
			snapshotSha256: "sha-a",
			superseded: true,
			supersededByRenameId: "rename-a",
		}),
		renameEvent("rename-a", "A.md", "deep/C.md", {
			createdAt: 2,
			predecessorUploadId: "upload-a",
		}),
	]);
	const persistedQueues: DeferredWatcherEvent[][] = [];
	watcher.setPersistCallback(async () => {
		persistedQueues.push(structuredClone(watcher.getDeferredEvents()));
	});

	access.applyBatchResult({
		completed: ["upload-a"],
		superseded: [],
		retry: [],
		uploadReceipts: [
			{
				eventId: "upload-a",
				path: "A.md",
				status: "accepted-put",
				reason: "accepted-put",
				epoch: "epoch-a",
				canonicalRevision: 8,
				mutationId: "device-a:1",
				mutationSeq: 1,
				sha256: "sha-a",
			},
		],
	});
	await Promise.resolve();

	const [rename] = watcher.getDeferredEvents();
	assert.ok(rename?.action === "rename" && rename.kind === "file");
	assert.equal(rename.baseRevision, 8);
	assert.equal(rename.predecessorUploadId, undefined);
	assert.equal(persistedQueues.at(-1)?.length, 1);
});

test("pending submitted upload leaves its put for rename retarget", () => {
	const { watcher, access } = createWatcher();
	watcher.loadDeferredEvents([
		fileEvent("upload-a", "A.md"),
		renameEvent("rename-a", "A.md", "B.md", {
			createdAt: 2,
			predecessorUploadId: "upload-a",
		}),
	]);

	access.applyBatchResult({
		completed: [],
		superseded: ["upload-a"],
		retry: [],
		uploadReceipts: [
			{
				eventId: "upload-a",
				path: "A.md",
				status: "pending-put",
				reason: "coalesced",
				epoch: "epoch-a",
				canonicalRevision: null,
				mutationId: "device-a:1",
				mutationSeq: 1,
				sha256: "sha-a",
			},
		],
	});

	const [rename] = watcher.getDeferredEvents();
	assert.ok(rename?.action === "rename" && rename.kind === "file");
	assert.equal(rename.baseRevision, 7);
	assert.equal(rename.predecessorUploadId, undefined);
});

test("accepted upload advances a later queued edit of the same path", () => {
	const { watcher, access } = createWatcher();
	watcher.loadDeferredEvents([
		fileEvent("upload-previous", "note.md", {
			baseRevision: 35,
			mutationId: "device-a:7",
			mutationSeq: 7,
			snapshotSha256: "previous",
			superseded: true,
		}),
		fileEvent("upload-latest", "note.md", {
			baseRevision: 35,
			createdAt: 2,
			mutationId: "device-a:8",
			mutationSeq: 8,
			snapshotSha256: "latest",
		}),
	]);

	access.applyBatchResult({
		completed: ["upload-previous"],
		superseded: [],
		retry: [],
		uploadReceipts: [
			{
				eventId: "upload-previous",
				path: "note.md",
				status: "accepted-put",
				reason: "accepted-put",
				epoch: "epoch-a",
				canonicalRevision: 36,
				mutationId: "device-a:7",
				mutationSeq: 7,
				sha256: "previous",
			},
		],
	});

	const [successor] = watcher.getDeferredEvents();
	assert.equal(successor?.action, "upload");
	assert.equal(successor?.baseRevision, 36);
	assert.equal(successor?.mutationSeq, 8);
});

test("full barrier settles captured uploads only after success and retains later work", () => {
	for (const success of [true, false]) {
		const { watcher, access } = createWatcher();

		const context = { epoch: "epoch-a", baseRevision: 7, createdAt: 1 };
		watcher.loadDeferredEvents([
			{
				...context,
				id: "covered-upload",
				action: "upload",
				path: "covered.md",
			},
			{
				...context,
				id: "delete-event",
				action: "delete",
				path: "deleted.md",
			},
			{
				...context,
				id: "rename-event",
				action: "rename",
				path: "A.md",
				targetPath: "B.md",
				kind: "file",
			},
		]);
		access.captureFullSyncBarrier({ sessionId: "full-1", kind: "full" });
		access.deferEvent({
			...context,
			id: "during-full-upload",
			action: "upload",
			path: "during.md",
		});
		access.completeFullSyncBarrier({
			sessionId: "full-1",
			kind: "full",
			success,
		});
		assert.deepEqual(
			eventIds(watcher),
			[
				...(success ? [] : ["covered-upload"]),
				"delete-event",
				"rename-event",
				"during-full-upload",
			],
			`success=${success}`,
		);
	}
});

test("session resume replays only new paused events after success", async () => {
	for (const success of [true, false]) {
		const { watcher, access } = createWatcher();

		access.isEnabled = true;
		const context = { epoch: "epoch-a", baseRevision: 7, createdAt: 1 };
		watcher.loadDeferredEvents([
			{
				...context,
				id: "old-rename",
				action: "rename",
				path: "A.md",
				targetPath: "B.md",
				kind: "file",
			},
		]);
		const replayed: string[][] = [];
		access.flushDeferredEvents = async (onlyIds) => {
			replayed.push([...(onlyIds ?? [])]);
		};
		const session = {
			sessionId: "maintenance-1",
			kind: "maintenance" as const,
		};
		await watcher.pauseForSync(session);
		access.deferEvent({
			...context,
			id: "new-upload",
			action: "upload",
			path: "new.md",
		});
		await watcher.resumeAfterSync({ ...session, success });
		assert.deepEqual(
			replayed,
			success ? [["new-upload"]] : [],
			`success=${success}`,
		);
		if (!success) {
			assert.equal(watcher.getDeferredEvents().length, 2);
		}
	}
});

test("full barrier acknowledgement is persisted before resume completes", async () => {
	for (const enabled of [true, false]) {
		const { watcher, access } = createWatcher();
		watcher.loadDeferredEvents([fileEvent("covered-upload", "covered.md")]);
		const persistedQueues: string[][] = [];
		watcher.setPersistCallback(async () => {
			persistedQueues.push(eventIds(watcher));
		});

		access.isEnabled = enabled;
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
	}
});

test("failed full sync postpones watcher replay", async () => {
	let fileBatchCalls = 0;
	const { watcher, access } = createWatcher({
		syncFileBatch: async () => {
			fileBatchCalls++;
			return {
				completed: [],
				superseded: [],
				retry: ["covered-upload"],
				uploadReceipts: [],
			};
		},
	});

	watcher.loadDeferredEvents([fileEvent("covered-upload", "covered.md")]);

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
	assert.deepEqual(eventIds(watcher), ["covered-upload"]);
});

test("realtime epoch replacement requests one full and keeps the event durable", async () => {
	let epochSignal = true;
	let fullRequests = 0;
	const { watcher, access } = createWatcher({
		syncFileBatch: async (events: RealtimeFileEvent[]) => ({
			completed: [],
			superseded: [],
			retry: events.map((event) => event.id),
			uploadReceipts: [],
		}),
		consumeEpochReplacementRequest: () => {
			const current = epochSignal;
			epochSignal = false;
			return current;
		},
	});

	watcher.setFullSyncRequestCallback(async () => {
		fullRequests++;
	});
	watcher.loadDeferredEvents([fileEvent("old-epoch-upload", "note.md")]);

	await access.flushDeferredEventsNow();
	await Promise.resolve();

	assert.equal(fullRequests, 1);
	assert.equal(watcher.getDeferredEvents().length, 1);
});

test("startup blocks before reconciliation when an upload rename chain is unresolved", async () => {
	const { watcher, access } = createWatcher({
		showFullQueueWaitPhase: () => undefined,
		syncFileBatch: async () => ({
			completed: [],
			superseded: [],
			retry: ["upload-a"],
			uploadReceipts: [],
		}),
	});

	watcher.loadDeferredEvents([
		fileEvent("upload-a", "A.md"),
		renameEvent("rename-a", "A.md", "B.md", {
			createdAt: 2,
			predecessorUploadId: "upload-a",
		}),
	]);

	access.isEnabled = true;

	await assert.rejects(
		watcher.prepareForSync({
			sessionId: "full-startup",
			kind: "full",
			startup: true,
		}),
		/Pre-full watcher drain left 2 unresolved event/,
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
	const { watcher, access } = createWatcher({
		showFullQueueWaitPhase: () => undefined,
		renameFile: async (
			_oldPath: string,
			_newPath: string,
			_context: unknown,
			settle: (outcome: typeof retryOutcome) => Promise<void>,
		) => {
			await settle(retryOutcome);
			return retryOutcome;
		},
	});

	access.isEnabled = true;
	watcher.loadDeferredEvents([renameEvent("rename-a", "A.md", "B.md")]);

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

test("missing-target rename without remote work is deferred to normal full", async () => {
	const retryOutcome = {
		status: "retry" as const,
		canonicalRevision: null,
		epoch: "epoch-a",
		reason: "target-missing-before-remote",
		remoteStarted: false,
	};
	const { watcher, access } = createWatcher({
		showFullQueueWaitPhase: () => undefined,
		renameFile: async (
			_oldPath: string,
			_newPath: string,
			_context: unknown,
			settle: (outcome: typeof retryOutcome) => Promise<void>,
		) => {
			await settle(retryOutcome);
			return retryOutcome;
		},
	});

	access.isEnabled = true;
	watcher.loadDeferredEvents([renameEvent("rename-a", "A.md", "B.md")]);

	await watcher.prepareForSync({ sessionId: "full-1", kind: "full" });

	assert.equal(watcher.getDeferredEvents().length, 1);
});

test("ambiguous rename failure does not execute its successor", async () => {
	let renameCalls = 0;
	const { watcher, access } = createWatcher({
		renameFile: async () => {
			renameCalls++;
			throw new Error("ambiguous canonical transaction");
		},
	});

	watcher.loadDeferredEvents([
		renameEvent("rename-a", "A.md", "B.md"),
		renameEvent("rename-b", "B.md", "C.md", { createdAt: 2 }),
	]);

	await access.flushDeferredEventsNow();

	assert.equal(renameCalls, 1);
	assert.equal(watcher.getDeferredEvents().length, 2);
});

test("quick file rename chain coalesces to the final target", () => {
	const { watcher, access } = createWatcher();

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
