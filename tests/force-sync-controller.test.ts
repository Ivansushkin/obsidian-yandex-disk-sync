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

test("Force cancellation and blocked preflight never create a backup", async () => {
	for (const overrides of [
		{ confirm: async () => "cancel" as const },
		{ preflight: async () => null },
	]) {
		const h = harness(overrides);
		await h.controller.run("from_local");
		assert.equal(h.controller.isBusy(), false);
		assert.ok(!h.calls.includes("backup"));
		assert.ok(!h.calls.includes("force"));
	}
	const h = harness({ isSyncBusy: () => true });
	await h.controller.run("from_local");
	assert.deepEqual(h.calls, []);
});

test("Force backup failure or exception cannot start destructive synchronization", async () => {
	for (const throws of [false, true]) {
		const h = harness({
			backup: async () => {
				if (throws) {
					throw new Error("offline");
				}
				return { success: false, fileCount: 0, totalSize: 0 };
			},
		});
		await h.controller.run("from_remote");
		assert.equal(h.controller.getState()?.outcome, "backup-failed");
		assert.equal(h.controller.isBusy(), false);
		assert.ok(!h.calls.includes("force"));
	}
});

test("Force stale proof and source drift never announce migration success", async () => {
	for (const code of ["force-backup-stale", "force-source-changed"]) {
		const h = harness({
			run: async () =>
				result({
					success: false,
					replacementCommitted: false,
					errors: [
						{ code, message: code, path: "", operation: "upload" },
					],
				}),
		});
		await h.controller.run("from_local");
		assert.equal(h.controller.getState()?.outcome, "failed");
		assert.equal(h.controller.getState()?.errorCode, code);
		assert.ok(!h.calls.includes("reconcile"));
	}
});

test("Force success requires verified commit persistence full and completed cleanup", async () => {
	for (const overrides of [
		{ run: async () => result({ replacementCommitted: false }) },
		{ reconcile: async () => null },
		{ reconcile: async () => result({ success: false }) },
		{ hasPendingCleanup: () => true },
	]) {
		const h = harness(overrides);
		await h.controller.run("from_local");
		assert.notEqual(h.controller.getState()?.outcome, "success");
	}
	const h = harness({
		run: async () =>
			result({
				success: false,
				errors: [
					{
						message: "interrupted cleanup",
						path: "old.md",
						operation: "delete_remote",
					},
				],
			}),
	});
	await h.controller.run("from_local");
	assert.equal(h.controller.getState()?.outcome, "success");
	assert.equal(h.calls.filter((call) => call === "reconcile").length, 1);
	assert.ok(h.calls.indexOf("committed") < h.calls.indexOf("persist"));
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

test("Force without an archive retains preflight and owns final settlement", async () => {
	for (const direction of ["from_local", "from_remote"] as const) {
		const h = harness({
			confirm: async () => "without-backup",
			run: async (_, options) => {
				assert.equal(
					options.forcePreflightProof?.snapshotDigest,
					"snapshot",
				);
				assert.equal(options.forcePreflightProof?.backup, null);
				return result();
			},
		});
		await h.controller.run(direction);
		assert.equal(h.controller.getState()?.outcome, "success");
		assert.ok(!h.calls.includes("backup"));
		assert.ok(h.calls.includes("persist") && h.calls.includes("reconcile"));
		assert.ok(!h.states.some((state) => state.phase.includes("backup")));
	}
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
