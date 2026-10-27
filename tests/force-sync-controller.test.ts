import assert from "node:assert/strict";
import test from "node:test";
import {
	ForceSyncController,
	type ForceSyncDependencies,
	type ForceFlowState,
	type ForceDirection,
} from "../src/sync/workflows/force-controller";
import type { SyncResult, SyncState } from "../src/types";

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

function harness(overrides: Partial<ForceSyncDependencies> = {}) {
	const calls: string[] = [];
	const states: ForceFlowState[] = [];
	const deps: ForceSyncDependencies = {
		isSyncBusy: () => false,
		preflight: async () => {
			calls.push("preflight");
			return { migration: true, canonical: { state: "absent" } };
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
		beforeMutation: async () => {
			calls.push("cutover");
		},
		run: async (_, options) => {
			calls.push("force");
			await options.beforeForceMutation?.();
			return result();
		},
		persist: async () => {
			calls.push("persist");
		},
		replacementCommitted: () => {
			calls.push("committed");
		},
		reconcile: async () => {
			calls.push("reconcile");
			return result();
		},
		hasPendingCleanup: () => false,
		hasPendingRecovery: () => false,
		reportError: () => {},
		...overrides,
	};
	const controller = new ForceSyncController(deps);
	controller.subscribe((state) => states.push(state));
	return { controller, deps, calls, states };
}

test("Force owns busy state from first click through backup persistence and final full", async () => {
	for (const direction of ["from_local", "from_remote"] as ForceDirection[]) {
		for (const boundary of [
			"preflight",
			"confirm",
			"backup",
			"run",
			"persist",
			"reconcile",
		] as const) {
			const entered = deferred();
			const release = deferred();
			const h = harness();
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

test("Force admission and completion reject unverified work and honor the archive choice", async () => {
	const cleanupError = {
		message: "interrupted cleanup",
		path: "old.md",
		operation: "delete_remote" as const,
	};
	const cases: Array<{
		name: string;
		overrides: Partial<ForceSyncDependencies>;
		outcome?: ForceFlowState["outcome"];
		noForce?: boolean;
		noReconcile?: boolean;
		errorCode?: string;
		noBackup?: boolean;
	}> = [
		{
			name: "cancel",
			overrides: { confirm: async () => "cancel" },
			noForce: true,
			noBackup: true,
		},
		{
			name: "blocked",
			overrides: { preflight: async () => null },
			noForce: true,
			noBackup: true,
		},
		{
			name: "busy",
			overrides: { isSyncBusy: () => true },
			noForce: true,
			noBackup: true,
		},
		{
			name: "backup rejected",
			overrides: {
				backup: async () => ({
					success: false,
					fileCount: 0,
					totalSize: 0,
				}),
			},
			outcome: "backup-failed",
			noForce: true,
		},
		{
			name: "backup exception",
			overrides: {
				backup: async () => {
					throw new Error("offline");
				},
			},
			outcome: "backup-failed",
			noForce: true,
		},
		...["force-backup-stale", "force-source-changed"].map((code) => ({
			name: code,
			overrides: {
				run: async () =>
					result({
						success: false,
						replacementCommitted: false,
						errors: [
							{
								code,
								message: code,
								path: "",
								operation: "upload" as const,
							},
						],
					}),
			},
			outcome: "failed" as const,
			errorCode: code,
			noReconcile: true,
		})),
		{
			name: "uncommitted",
			overrides: {
				run: async () => result({ replacementCommitted: false }),
			},
		},
		{
			name: "no reconciliation",
			overrides: { reconcile: async () => null },
		},
		{
			name: "failed reconciliation",
			overrides: { reconcile: async () => result({ success: false }) },
		},
		{
			name: "pending cleanup",
			overrides: { hasPendingCleanup: () => true },
		},
		{
			name: "recovered cleanup",
			overrides: {
				run: async () =>
					result({ success: false, errors: [cleanupError] }),
			},
			outcome: "success",
		},
		{
			name: "without archive",
			overrides: {
				confirm: async () => "without-backup",
				run: async (_, options) => {
					assert.equal(
						options.forcePreflightProof?.snapshotDigest,
						"snapshot",
					);
					assert.equal(options.forcePreflightProof?.backup, null);
					return result();
				},
			},
			outcome: "success",
			noBackup: true,
		},
	];
	for (const direction of ["from_local", "from_remote"] as const) {
		for (const row of cases) {
			const h = harness(row.overrides);
			await h.controller.run(direction);
			assert.equal(h.controller.isBusy(), false, row.name);
			if (row.outcome) {
				assert.equal(
					h.controller.getState()?.outcome,
					row.outcome,
					row.name,
				);
			} else {
				assert.notEqual(
					h.controller.getState()?.outcome,
					"success",
					row.name,
				);
			}
			if (row.errorCode) {
				assert.equal(
					h.controller.getState()?.errorCode,
					row.errorCode,
					row.name,
				);
			}
			if (row.noForce) {
				assert.ok(!h.calls.includes("force"), row.name);
			}
			if (row.noReconcile) {
				assert.ok(!h.calls.includes("reconcile"), row.name);
			}
			if (row.noBackup) {
				assert.ok(!h.calls.includes("backup"), row.name);
			}
			if (row.name === "busy") {
				assert.deepEqual(h.calls, []);
			}
			if (row.outcome === "success") {
				assert.equal(
					h.calls.filter((call) => call === "reconcile").length,
					1,
					row.name,
				);
				assert.ok(
					h.calls.indexOf("committed") < h.calls.indexOf("persist"),
					row.name,
				);
			}
			if (row.name === "without archive") {
				assert.ok(
					!h.states.some((state) => state.phase.includes("backup")),
				);
			}
		}
	}
});

test("Force late activity from a completed operation cannot overwrite its successor", async () => {
	let previousActivity: ((state: SyncState) => void) | undefined;
	const h = harness({
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

test("Force retains the failing boundary and committed outcome without starting preflight mutations", async () => {
	for (const [boundary, stage] of [
		["preflight", "preflight"],
		["confirm", "confirming"],
		["readyForBackup", "confirming"],
		["captureProtectedSnapshot", "protected-snapshot"],
		["run", "syncing"],
		["persist", "persisting"],
		["reconcile", "reconciling"],
	] as const) {
		const cause = new Error("connection failed");
		const h = harness({
			[boundary]: async () => {
				throw cause;
			},
		});
		await h.controller.run("from_local");
		const state = h.controller.getState()!;
		assert.equal(h.controller.isBusy(), false);
		assert.equal(
			state.outcome,
			boundary === "persist" || boundary === "reconcile"
				? "cleanup-pending"
				: "failed",
		);
		assert.equal(state.failure?.message, cause.message);
		assert.equal(state.failure?.stage, stage);
		if (
			boundary === "preflight" ||
			boundary === "captureProtectedSnapshot"
		) {
			assert.equal(h.calls.includes("force"), false);
		}
	}
});

test("Force presentation errors cannot interrupt commit or keep buttons busy", async () => {
	const h = harness();
	h.controller.subscribe(() => {
		throw new Error("detached UI");
	});
	await h.controller.run("from_local");
	assert.equal(h.controller.getState()?.outcome, "success");
	assert.equal(h.controller.isBusy(), false);
});

test("Force opens before source reads and cancellation joins preparation before releasing its reservation", async () => {
	const entered = deferred();
	const release = deferred();
	let attempts = 0;
	let published = false;
	const h = harness({
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
			return { migration: false, canonical: { state: "absent" } };
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
