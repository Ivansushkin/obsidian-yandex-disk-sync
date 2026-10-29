import { RemoteReadTimeoutError, YandexApiError } from "../src/errors";
import { createSyncFailure } from "../src/sync/errors";
import assert from "node:assert/strict";
import test from "node:test";
import {
	MobileSyncRecovery,
	mobileRecoveryOutcome,
	type MobileRecoveryContext,
	type MobileRecoveryOutcome,
} from "../src/sync/mobile-recovery";
import { deferred } from "./helpers/deferred";

/** Advance controller deadlines without depending on real timer scheduling. */
class Clock {
	now = 1000;
	private next = 0;
	private timers = new Map<number, { at: number; run: () => void }>();
	setTimeout = (run: () => void, delay: number) => {
		const id = ++this.next;
		this.timers.set(id, { at: this.now + delay, run });
		return id;
	};
	clearTimeout = (id: number) => {
		this.timers.delete(id);
	};
	async advance(ms: number) {
		for (let i = 0; i < 8; i++) {
			await Promise.resolve();
		}
		const end = this.now + ms;
		for (;;) {
			const next = [...this.timers]
				.filter(([, timer]) => timer.at <= end)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) {
				break;
			}
			this.now = Math.max(this.now, next[1].at);
			this.timers.delete(next[0]);
			next[1].run();
			for (let i = 0; i < 8; i++) {
				await Promise.resolve();
			}
		}
		this.now = end;
	}
}
function harness(run: () => Promise<MobileRecoveryOutcome>) {
	const clock = new Clock();
	const context: MobileRecoveryContext = {
		generation: 0,
		enabled: true,
		visible: true,
		busy: false,
		blocked: false,
		native: { reads: 0, writes: 0, oldestStartedAt: null },
	};
	const recovery = new MobileSyncRecovery({
		read: () => context,
		run,
		changed: () => {},
		clock: {
			now: () => clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
		},
	});
	return { clock, context, recovery };
}

test("mobile return waits for old host and native settlement and coalesces duplicate signals", async () => {
	const entered = deferred<MobileRecoveryOutcome>();
	let runs = 0;
	const h = harness(async () => {
		runs++;
		return entered.promise;
	});
	try {
		const oldFull = h.recovery.beginFull();
		h.context.visible = false;
		h.recovery.notifyActivityChanged();
		assert.equal(h.recovery.canStartAutomatic(), false);
		h.context.busy = true;
		h.context.visible = true;
		h.recovery.notifyActivityChanged();
		h.recovery.request("online");
		h.recovery.request("resume");
		h.recovery.completeFull(oldFull, true);
		await h.clock.advance(500);
		assert.equal(runs, 0);
		h.context.busy = false;
		h.context.native.writes = 1;
		h.context.native.oldestStartedAt = h.clock.now;
		h.recovery.notifyActivityChanged();
		await h.clock.advance(61000);
		assert.equal(runs, 0);
		assert.equal(h.recovery.getPresentation()?.phase, "waiting-native");
		h.context.native.writes = 0;
		h.context.native.oldestStartedAt = null;
		h.recovery.notifyActivityChanged();
		await h.clock.advance(500);
		assert.equal(runs, 1);
		h.recovery.request("online");
		await h.clock.advance(1000);
		assert.equal(runs, 1);
		entered.resolve("success");
		await h.clock.advance(0);
		assert.equal(h.recovery.canStartAutomatic(), true);
	} finally {
		h.recovery.dispose();
	}
});

test("mobile recovery backoff is bounded and noisy activity does not reset its budget", async () => {
	const starts: number[] = [];
	const h = harness(async () => {
		starts.push(h.clock.now);
		const failure =
			starts.length % 2 === 0
				? new YandexApiError("synthetic transient failure", 503)
				: new RemoteReadTimeoutError(60000, "synthetic read");
		return mobileRecoveryOutcome(
			null,
			createSyncFailure(failure, { stage: "sync", action: "read" })
				.summary,
		);
	});
	try {
		h.recovery.request("online");
		await h.clock.advance(500);
		for (const delay of [5000, 15000, 60000]) {
			h.recovery.request("online");
			h.recovery.notifyActivityChanged();
			await h.clock.advance(delay - 1);
			assert.equal(
				starts.length,
				[5000, 15000, 60000].indexOf(delay) + 1,
			);
			await h.clock.advance(1);
		}
		assert.deepEqual(starts, [1500, 6500, 21500, 81500]);
		await h.clock.advance(120000);
		assert.equal(starts.length, 4);
		h.recovery.request("online");
		await h.clock.advance(500);
		assert.equal(starts.length, 5);
	} finally {
		h.recovery.dispose();
	}
});

test("mobile recovery revocation ignores an old completion across connection ABA and new return", async () => {
	const gate = deferred<MobileRecoveryOutcome>();
	let runs = 0;
	const h = harness(async () => {
		runs++;
		return runs === 1 ? gate.promise : "success";
	});
	try {
		h.recovery.request("online");
		await h.clock.advance(500);
		h.context.generation++;
		h.recovery.notifyActivityChanged();
		h.context.enabled = false;
		h.recovery.notifyActivityChanged();
		h.context.generation++;
		h.context.enabled = true;
		h.recovery.notifyActivityChanged();
		assert.equal(h.recovery.canStartAutomatic(), true);
		h.context.visible = false;
		h.recovery.notifyActivityChanged();
		h.context.visible = true;
		h.recovery.notifyActivityChanged();
		gate.resolve("success");
		await h.clock.advance(500);
		assert.equal(runs, 2);
		assert.equal(h.recovery.canStartAutomatic(), true);
	} finally {
		h.recovery.dispose();
	}
});

import {
	MemoryDisk,
	bytes,
	codecFor,
	managedDevices,
} from "./helpers/sync-flow";
import { SyncScheduler } from "../src/sync/scheduler";

test("mobile admission preserves hidden edits and a fresh full converges two devices", async (t) => {
	for (const encrypted of [false, true]) {
		const make = managedDevices(t);
		const disk = new MemoryDisk();
		const a = make(disk, "mobile-a", await codecFor(encrypted));
		const b = make(disk, "mobile-b", await codecFor(encrypted));
		await a.full();
		await b.full();
		a.start();
		let allowed = false;
		a.watcher.setAutomaticAdmission(() => allowed);
		a.vault.put("Phone.md", bytes("offline phone edit"));
		await a.watcher.waitForPendingPersistence();
		assert.equal(a.lastSaved().pendingWatcherEvents.length, 1);
		assert.equal((await a.canonical()).files["Phone.md"], undefined);
		b.vault.put("Other.md", bytes("other device"));
		await b.full();
		const scheduler = new SyncScheduler(a.engine, a.settings);
		scheduler.setAutomaticAdmission(() => allowed);
		await scheduler["runScheduledSync"]();
		assert.equal(a.vault.files.has("Other.md"), false);
		// Recovery full is explicit and must retain access to its watcher preparation barrier.
		await a.full();
		allowed = true;
		a.watcher.notifyAutomaticAdmissionChanged();
		await a.drain();
		await b.full();
		await a.assertSettled({
			"Phone.md": "offline phone edit",
			"Other.md": "other device",
		});
		await b.assertSettled({
			"Phone.md": "offline phone edit",
			"Other.md": "other device",
		});
		const noOp = await a.full();
		assert.deepEqual(
			[noOp.uploaded, noOp.downloaded, noOp.deleted, noOp.conflicts],
			[0, 0, 0, 0],
		);
	}
});

import { Platform } from "obsidian";
import { persistenceHarness } from "./helpers/lifecycle-fixtures";

test("mobile host waits for a real old full then uses a new invocation and saves completion", async (t) => {
	for (const source of ["host", "scheduler", "cold-hidden"] as const) {
		const make = managedDevices(t);
		const a = make(new MemoryDisk(), "mobile-host", null);
		await a.full();
		const { plugin } = persistenceHarness();
		await plugin.loadSettings();
		const doc = Object.assign(new EventTarget(), {
			visibilityState: "visible",
			defaultView: new EventTarget(),
		});
		const cleanups: (() => void)[] = [];
		let preflights = 0;
		const previousMobile = Platform.isMobileApp;
		Platform.isMobileApp = true;
		Object.assign(plugin, {
			settings: { ...a.settings, yandexTokenSecret: "synthetic" },
			app: {
				vault: a.vault,
				workspace: {
					layoutReady: true,
					containerEl: { ownerDocument: doc },
				},
			},
			yandexClient: a.client,
			vaultAdapter: a.adapter,
			indexManager: a.index,
			syncEngine: a.engine,
			fileWatcher: a.watcher,
			syncScheduler: new SyncScheduler(a.engine, a.settings),
			localStateRestored: true,
			syncLifecycleRegistered: true,
			automationReady: true,
			regularSyncStarted: true,
			refreshRemoteStartupState: async () => {
				preflights++;
				return "ready";
			},
			register: (cleanup: () => void) => cleanups.push(cleanup),
			registerDomEvent: (
				target: EventTarget,
				event: string,
				listener: EventListener,
			) => {
				target.addEventListener(event, listener);
				cleanups.push(() =>
					target.removeEventListener(event, listener),
				);
			},
		});
		const entered = deferred();
		const release = deferred();
		let sessions = 0;
		a.engine.onSyncPause(async () => {
			if (++sessions === 1) {
				entered.resolve();
				await release.promise;
			}
		});
		plugin["initializeMobileRecovery"]();
		try {
			if (source === "cold-hidden") {
				doc.visibilityState = "hidden";
				doc.dispatchEvent(new Event("visibilitychange"));
				await plugin["onLayoutReady"]();
				assert.equal(
					preflights,
					0,
					"Hidden startup must not begin remote classification or maintenance",
				);
				release.resolve();
				doc.visibilityState = "visible";
				doc.dispatchEvent(new Event("visibilitychange"));
				await new Promise((resolve) => setTimeout(resolve, 650));
				assert.equal(sessions, 1);
				assert.equal(
					plugin["mobileRecovery"]!.canStartAutomatic(),
					true,
				);
				continue;
			}
			const old =
				source === "host"
					? plugin.runFullSync({ trigger: "automatic" }, false)
					: a.engine.fullSync({ trigger: "automatic" });
			await entered.promise;
			doc.visibilityState = "hidden";
			doc.dispatchEvent(new Event("visibilitychange"));
			a.start();
			a.vault.put("Edit.md", bytes("edit during suspension"));
			doc.visibilityState = "visible";
			doc.dispatchEvent(new Event("visibilitychange"));
			assert.equal(plugin["mobileRecovery"]!.canStartAutomatic(), false);
			const joined =
				source === "scheduler"
					? plugin.runFullSync(undefined, false)
					: undefined;
			await new Promise((resolve) => setTimeout(resolve, 0));
			release.resolve();
			await old;
			await joined;
			await new Promise((resolve) => setTimeout(resolve, 650));
			assert.equal(
				sessions,
				2,
				"A coalesced old engine full cannot satisfy the return request",
			);
			assert.equal(plugin["mobileRecovery"]!.canStartAutomatic(), true);
			assert.equal(plugin["activeFullPromise"], null);
			assert.equal(
				plugin["persistence"].current!.pendingWatcherEvents.length,
				0,
			);
			await a.assertSettled({ "Edit.md": "edit during suspension" });
		} finally {
			release.resolve();
			plugin["mobileRecovery"]?.dispose();
			for (const cleanup of cleanups.reverse()) {
				cleanup();
			}
			Platform.isMobileApp = previousMobile;
			await a.stop();
		}
	}
});

test("mobile recovery respects manual-only mode and a new persisted full covers the pending request", async () => {
	let runs = 0;
	const h = harness(async () => {
		runs++;
		return "success";
	});
	try {
		h.context.enabled = false;
		h.recovery.notifyActivityChanged();
		h.recovery.request("online");
		await h.clock.advance(1000);
		assert.equal(runs, 0);
		h.context.enabled = true;
		h.recovery.notifyActivityChanged();
		h.recovery.request("online");
		const fresh = h.recovery.beginFull();
		h.recovery.completeFull(fresh, true);
		await h.clock.advance(1000);
		assert.equal(runs, 0);
		assert.equal(h.recovery.canStartAutomatic(), true);
		// Missing visibility events are recovered by an execution gap, without extending old budgets.
		h.clock.now += 35000;
		await h.clock.advance(0);
		await h.clock.advance(500);
		assert.equal(runs, 1);
	} finally {
		h.recovery.dispose();
	}
});

test("mobile hidden drain preserves a newer recreate ahead of its stale delete debounce", async (t) => {
	const a = managedDevices(t)(new MemoryDisk(), "reordered-mobile", null);
	a.vault.put("A.md", bytes("original"));
	await a.full();
	a.start();
	const before = (await a.canonical()).appliedMutationSeq[
		"reordered-mobile"
	]!;
	let allowed = true;
	a.watcher.setAutomaticAdmission(() => allowed);
	a.vault.remove("A.md");
	allowed = false;
	a.vault.put("A.md", bytes("recreated before visibility callback"));
	const current = a.watcher.getDeferredEvents();
	assert.equal(current[0]?.action, "upload");
	a.watcher.notifyAutomaticAdmissionChanged();
	assert.deepEqual(a.watcher.getDeferredEvents(), current);
	await a.full();
	assert.equal(
		(await a.canonical()).appliedMutationSeq["reordered-mobile"],
		before + 1,
	);
	await a.assertSettled({ "A.md": "recreated before visibility callback" });
});
