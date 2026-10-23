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
	watcherAccess,
} from "./helpers/realtime-fixtures";
import {
	bytes,
	device,
	MemoryDisk,
	type SavedDevice,
} from "./helpers/sync-flow";

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

test("running rename settlement rebases missing targets and advances completed successors", async () => {
	for (const completed of [false, true]) {
		const { watcher, access } = createWatcher();
		const first = renameEvent("rename-a", "A.md", "B.md");
		access.deferEvent(first);
		access.submittedWatcherEventIds.add(first.id);
		access.deferEvent(
			renameEvent("rename-b", "B.md", "deep/C.md", { createdAt: 2 }),
		);
		await access.settlement.settleRenameEvent(first, {
			status: completed ? "completed" : "retry",
			canonicalRevision: completed ? 9 : null,
			epoch: "epoch-a",
			reason: completed ? undefined : "target-missing-before-remote",
			remoteStarted: completed,
		});
		const [next] = watcher.getDeferredEvents();
		assert.ok(next?.action === "rename");
		assert.equal(next.path, completed ? "B.md" : "A.md");
		assert.equal(next.targetPath, "deep/C.md");
		assert.equal(next.baseRevision, completed ? 9 : 7);
		assert.equal(watcher.getDeferredEvents().length, 1);
	}
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

	for (const event of watcher.getDeferredEvents()) {
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
	for (const kind of ["maintenance", "full"] as const) {
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
				kind,
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

test("pre-full rename admission distinguishes maintenance from a missing local target", async () => {
	for (const reason of [
		"maintenance-active",
		"target-missing-before-remote",
	] as const) {
		const outcome = {
			status: "retry" as const,
			canonicalRevision: null,
			epoch: "epoch-a",
			reason,
			remoteStarted: false,
		};
		const { watcher, access } = createWatcher({
			showFullQueueWaitPhase: () => undefined,
			renameFile: async (_old, _new, _context, settle) => {
				await settle?.(outcome, {
					sessionId: "rename",
					kind: "realtime",
				});
				return outcome;
			},
		});
		access.isEnabled = true;
		watcher.loadDeferredEvents([renameEvent("rename", "A.md", "B.md")]);
		const prepare = watcher.prepareForSync({
			sessionId: "full-1",
			kind: "full",
		});
		if (reason === "maintenance-active") {
			await assert.rejects(prepare, /left 1 unresolved event/, reason);
		} else {
			await prepare;
		}
		await watcher.prepareForSync({
			sessionId: "startup",
			kind: "full",
			startup: true,
		});
		assert.equal(watcher.getDeferredEvents().length, 1, reason);
	}
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

test("watcher save generations retain storm arrivals and failed durability across restart", async () => {
	const disk = new MemoryDisk();
	const a = device(disk, "device-a", null);
	const b = device(disk, "device-b", null);
	const gates = Array.from({ length: 4 }, () => {
		let entered!: () => void;
		let release!: () => void;
		let reject!: (error: Error) => void;
		return {
			started: new Promise<void>((resolve) => {
				entered = resolve;
			}),
			write: new Promise<void>((resolve, fail) => {
				release = resolve;
				reject = fail;
			}),
			entered: () => entered(),
			release: () => release(),
			reject: (error: Error) => reject(error),
		};
	});
	let restarted: ReturnType<typeof device> | undefined;
	let durable: SavedDevice;
	const snapshots: SavedDevice[] = [];
	try {
		a.vault.put("note.md", bytes("baseline"));
		await a.full();
		await b.full();
		durable = a.lastSaved();
		const remoteBefore = structuredClone(disk.files);
		a.start();
		await a.watcher.pauseForSync({
			sessionId: "collect",
			kind: "maintenance",
		});
		a.watcher.setPersistCallback(async () => {
			const snapshot = structuredClone({
				localState: a.index.getLocalIndexData(),
				pendingMutations: a.index.getPendingMutations(),
				pendingPhysicalActions: a.index.getPendingPhysicalActions(),
				pendingWatcherEvents: a.watcher.getDeferredEvents(),
			});
			const gate = gates[snapshots.length];
			snapshots.push(snapshot);
			gate?.entered();
			await gate?.write;
			durable = snapshot;
		});
		a.vault.put("note.md", bytes("before save"));
		a.vault.put("extra.md", bytes("extra before"));
		await gates[0]!.started;
		a.vault.put("note.md", bytes("during save"));
		a.vault.put("extra.md", bytes("extra latest"));
		a.vault.put("third.md", bytes("third"));
		let saved = false;
		const waiting = a.watcher.waitForPendingPersistence().then(() => {
			saved = true;
		});
		gates[0]!.release();
		await gates[1]!.started;
		assert.equal(saved, false);
		assert.deepEqual(
			durable.pendingWatcherEvents,
			snapshots[0]!.pendingWatcherEvents,
		);
		assert.notDeepEqual(
			durable.pendingWatcherEvents,
			a.watcher.getDeferredEvents(),
		);
		gates[1]!.release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(
			snapshots.length,
			2,
			"storm needs one running write and one latest snapshot",
		);
		await waiting;
		assert.deepEqual(
			durable.pendingWatcherEvents,
			a.watcher.getDeferredEvents(),
		);

		a.vault.put("note.md", bytes("failed version"));
		await gates[2]!.started;
		const failed = /Synthetic watcher save failure/;
		const beforeArrival = assert.rejects(
			a.watcher.waitForPendingPersistence(),
			failed,
		);
		a.vault.put("note.md", bytes("latest version"));
		const afterArrival = assert.rejects(
			a.watcher.waitForPendingPersistence(),
			failed,
		);
		const remoteBlocked = assert.rejects(
			watcherAccess(a.watcher).flushDeferredEventsNow(),
			failed,
		);
		gates[2]!.reject(new Error("Synthetic watcher save failure"));
		await Promise.all([beforeArrival, afterArrival, remoteBlocked]);
		await assert.rejects(a.watcher.waitForPendingPersistence(), failed);
		assert.deepEqual(
			disk.files,
			remoteBefore,
			"failed durability cannot start remote work",
		);
		assert.deepEqual(
			durable.pendingWatcherEvents,
			snapshots[1]!.pendingWatcherEvents,
		);
		const restored = createWatcher().watcher;
		restored.loadDeferredEvents(
			JSON.parse(
				JSON.stringify(durable.pendingWatcherEvents),
			) as DeferredWatcherEvent[],
		);
		assert.deepEqual(
			restored.getDeferredEvents(),
			durable.pendingWatcherEvents,
		);

		const cutoff = durable.pendingWatcherEvents.flatMap((event) =>
			event.path === "note.md" && event.id ? [event.id] : [],
		);
		a.watcher.stop();
		let repaired = false;
		const repair = a.watcher.settleForceReplacement(cutoff).then(() => {
			repaired = true;
		});
		await gates[3]!.started;
		await Promise.resolve();
		assert.equal(repaired, false);
		gates[3]!.release();
		await repair;
		assert.deepEqual(
			disk.files,
			remoteBefore,
			"stopped settlement cannot replay",
		);
		assert.deepEqual(
			durable.pendingWatcherEvents,
			a.watcher.getDeferredEvents(),
		);
		await a.stop();
		restarted = device(
			disk,
			"device-a",
			null,
			a.vault,
			JSON.parse(JSON.stringify(durable)) as SavedDevice,
		);
		assert.deepEqual(
			restarted.watcher.getDeferredEvents(),
			durable.pendingWatcherEvents,
		);
		await restarted.full();
		await b.full();
		const expected = {
			"note.md": "latest version",
			"extra.md": "extra latest",
			"third.md": "third",
		};
		await restarted.assertSettled(expected);
		await b.assertSettled(expected);

		const completion = createWatcher();
		let completedSnapshot: DeferredWatcherEvent[] = [];
		let arrivalScheduled = false;
		completion.watcher.setPersistCallback(async () => {
			completedSnapshot = completion.watcher.getDeferredEvents();
			if (!arrivalScheduled) {
				arrivalScheduled = true;
				void Promise.resolve()
					.then(() => undefined)
					.then(() => {
						completion.access.deferEvent(
							fileEvent("completion-arrival", "late.md"),
						);
					});
			}
		});
		completion.access.deferEvent(
			fileEvent("before-completion", "before.md"),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(
			completedSnapshot,
			completion.watcher.getDeferredEvents(),
			"an arrival between callback completion and runner release must also become durable",
		);
		await completion.watcher.waitForPendingPersistence();
	} finally {
		for (const gate of gates) {
			gate.release();
		}
		await a.stop();
		await restarted?.stop();
		await b.stop();
	}
});
