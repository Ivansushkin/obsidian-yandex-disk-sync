import assert from "node:assert/strict";
import test from "node:test";
import {
	ForceSyncController,
	type ForceSyncDependencies,
	type ForceFlowState,
	type ForceDirection,
} from "../src/sync/workflows/force-controller";
import type { SyncResult, SyncState } from "../src/types";
import { prepareForceReplacement } from "../src/sync/workflows/force-replacement";
import { managedDevices, MemoryDisk } from "./helpers/sync-flow";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function result(overrides: Partial<SyncResult> = {}): SyncResult {
	return {
		success: true,
		replacementCommitted: true,
		uploaded: 2,
		downloaded: 0,
		deleted: 0,
		conflicts: 0,
		errors: [],
		startTime: 1,
		endTime: 2,
		...overrides,
	};
}

function harness(
	context: Parameters<typeof managedDevices>[0],
	overrides: Partial<ForceSyncDependencies> = {},
) {
	const owner = managedDevices(context)(
		new MemoryDisk(),
		"controller-fixture",
		null,
	);
	const calls: string[] = [];
	const states: ForceFlowState[] = [];
	const deps: ForceSyncDependencies = {
		isSyncBusy: () => false,
		preflight: (direction) => {
			calls.push("preflight");
			return prepareForceReplacement(
				{
					...owner,
					persist: async () => {},
					password: async () => null,
				},
				direction,
				true,
			);
		},
		confirm: async () => {
			calls.push("confirm");
			return "with-backup";
		},
		captureProtectedSnapshot: async () => "snapshot",
		readyForBackup: async () => true,
		backup: async (_, progress) => {
			calls.push("backup");
			progress("uploading-backup");
			progress("verifying-backup");
			return {
				success: true,
				backupName: "backup.zip",
				sha256: "verified",
				snapshotDigest: "snapshot",
				fileCount: 2,
				totalSize: 20,
			};
		},
		run: async () => {
			calls.push("force");
			return result();
		},
		persist: async () => {
			calls.push("persist");
		},
		replacementCommitted: () => {
			calls.push("committed");
		},

		hasPendingRecovery: () => false,
		reportError: () => {},
		...overrides,
	};
	const controller = new ForceSyncController(deps);
	controller.subscribe((state) => states.push(state));
	return { controller, deps, calls, states };
}

test("Force owns busy state from first click through archive and durable completion", async (context) => {
	for (const direction of ["from_local", "from_remote"] as ForceDirection[]) {
		for (const boundary of [
			"preflight",
			"confirm",
			"backup",
			"run",
			"persist",
		] as const) {
			const entered = deferred();
			const release = deferred();
			const h = harness(context);
			const original = h.deps[boundary] as (
				...args: unknown[]
			) => Promise<unknown>;
			Object.assign(h.deps, {
				[boundary]: async (...args: unknown[]) => {
					entered.resolve();
					await release.promise;
					return original(...args);
				},
			});
			const pending = h.controller.run(direction);
			assert.equal(h.controller.isBusy(), true);
			await entered.promise;
			assert.equal(h.controller.run(direction), pending);
			assert.equal(
				h.controller.run(
					direction === "from_local" ? "from_remote" : "from_local",
				),
				pending,
			);
			assert.equal(h.controller.isBusy(), true);
			release.resolve();
			await pending;
			assert.equal(h.controller.isBusy(), false);
			assert.equal(h.calls.filter((call) => call === "backup").length, 1);
			assert.equal(h.calls.filter((call) => call === "force").length, 1);
			assert.equal(h.controller.getState()?.outcome, "success");
			assert.ok(
				h.states.findIndex((s) => s.phase === "creating-backup") <
					h.states.findIndex((s) => s.phase === "syncing"),
			);
			assert.ok(
				h.states.some(
					(s) => s.phase === "verifying-backup" && s.active,
				),
			);
		}
	}
});

test("Force admission and completion honor cancellation, archive and durable success", async (context) => {
	for (const direction of ["from_local", "from_remote"] as const) {
		for (const [name, overrides, outcome] of [
			["cancel", { confirm: async () => "cancel" }, "cancelled"],
			["blocked", { preflight: async () => null }, "blocked"],
			["busy", { isSyncBusy: () => true }, undefined],
			[
				"backup rejected",
				{
					backup: async () => ({
						success: false,
						fileCount: 0,
						totalSize: 0,
					}),
				},
				"failed",
			],
			[
				"uncommitted",
				{ run: async () => result({ replacementCommitted: false }) },
				"failed",
			],
			[
				"partial",
				{ run: async () => result({ success: false, deferred: true }) },
				"recovery-pending",
			],
			[
				"without archive",
				{ confirm: async () => "without-backup" },
				"success",
			],
		] satisfies [
			string,
			Partial<ForceSyncDependencies>,
			ForceFlowState["outcome"],
		][]) {
			const h = harness(context, overrides);
			await h.controller.run(direction);
			assert.equal(h.controller.isBusy(), false, name);
			assert.equal(h.controller.getState()?.outcome, outcome, name);
			if (outcome !== "success") {
				assert.ok(!h.calls.includes("committed"), name);
			}
			if (name === "busy") {
				assert.deepEqual(h.calls, []);
			}
			if (name === "without archive") {
				assert.ok(!h.calls.includes("backup"));
				assert.ok(
					h.calls.indexOf("persist") < h.calls.indexOf("committed"),
				);
			}
			if (
				["cancel", "blocked", "busy", "backup rejected"].includes(name)
			) {
				assert.ok(!h.calls.includes("force"), name);
			}
		}
	}
});

test("Force late activity from a completed operation cannot overwrite its successor", async (context) => {
	let previousActivity: ((state: SyncState) => void) | undefined;
	const h = harness(context, {
		run: async (_, options) => {
			previousActivity = options.onActivity;
			return result();
		},
	});
	await h.controller.run("from_local");
	const oldCallback = previousActivity!;
	const entered = deferred();
	const release = deferred();
	h.deps.confirm = async () => {
		entered.resolve();
		await release.promise;
		return "cancel";
	};
	const second = h.controller.run("from_remote");
	await entered.promise;
	oldCallback({ status: "syncing", currentOperation: "obsolete" });
	assert.equal(h.controller.getState()?.activity, undefined);
	release.resolve();
	await second;
});

test("Force retains the failing boundary and committed outcome without starting preflight mutations", async (context) => {
	for (const [boundary, stage] of [
		["preflight", "preflight"],
		["confirm", "confirming"],
		["readyForBackup", "confirming"],
		["captureProtectedSnapshot", "confirming"],
		["run", "syncing"],
		["persist", "persisting"],
	] as const) {
		const cause = new Error("connection failed");
		const h = harness(context, {
			[boundary]: async () => {
				throw cause;
			},
		});
		await h.controller.run("from_local");
		const state = h.controller.getState()!;
		assert.equal(h.controller.isBusy(), false);
		assert.equal(
			state.outcome,
			boundary === "persist" ? "cleanup-pending" : "failed",
		);
		assert.equal(state.failure?.message, cause.message);
		assert.equal(state.failure?.stage, stage);
		if (boundary === "captureProtectedSnapshot") {
			assert.ok(
				h.states.some((state) => state.phase === "protected-snapshot"),
			);
		}
		if (
			boundary === "preflight" ||
			boundary === "captureProtectedSnapshot"
		) {
			assert.equal(h.calls.includes("force"), false);
		}
	}
});

test("Force presentation errors cannot interrupt commit or keep buttons busy", async (context) => {
	const h = harness(context);
	h.controller.subscribe(() => {
		throw new Error("detached UI");
	});
	await h.controller.run("from_local");
	assert.equal(h.controller.getState()?.outcome, "success");
	assert.equal(h.controller.isBusy(), false);
});

test("Force opens before source reads and cancellation joins preparation before releasing its reservation", async (context) => {
	const entered = deferred();
	const release = deferred();
	let attempts = 0;
	let published = false;
	const h = harness(context, {
		open: () => {
			h.calls.push("open");
		},
		retryPreparation: async () => {
			const state = h.controller.getState();
			published = !!state?.failure && !state.sourceProgress;
			return true;
		},
		preflight: async (_direction, preparation) => {
			if (++attempts === 1) {
				preparation.progress(0, 91);
				throw new Error("Synthetic unreadable source");
			}
			entered.resolve();
			assert.deepEqual(h.calls, ["open"]);
			await release.promise;
			assert.equal(preparation.isCancelled(), true);
			return null;
		},
	});
	const pending = h.controller.run("from_remote");
	await entered.promise;
	assert.equal(h.controller.cancel(), true);
	assert.equal(h.controller.isBusy(), true);
	release.resolve();
	await pending;
	assert.equal(h.controller.getState()?.outcome, "cancelled");
	assert.deepEqual(h.calls, ["open"]);
	assert.equal(
		published,
		true,
		"Preparation failure must replace stale source progress",
	);
});
