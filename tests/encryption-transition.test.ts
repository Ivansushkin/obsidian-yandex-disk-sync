import assert from "node:assert/strict";
import test from "node:test";
import {
	decideEncryptionRecovery,
	EncryptionTransitionController,
	type LocalEncryptionTransition,
} from "../src/crypto/encryption-transition";
import type { IndexManager } from "../src/sync/index-manager";
import type { SyncEngine } from "../src/sync/sync-engine";

test("pre-commit transition rolls back only when source is authoritative", () => {
	assert.equal(
		decideEncryptionRecovery("prepared", false, true),
		"rollback-source",
	);
	assert.equal(
		decideEncryptionRecovery("files-copied", false, true),
		"rollback-source",
	);
});

test("target-readable canonical index completes a transition around commit", () => {
	assert.equal(
		decideEncryptionRecovery("files-copied", true, false),
		"finish-target",
	);
});

test("post-commit phases never roll back", () => {
	for (const phase of ["index-committed", "stable", "cleanup"] as const) {
		assert.equal(
			decideEncryptionRecovery(phase, false, true),
			"finish-target",
		);
	}
});

test("unreadable canonical state blocks automatic recovery", () => {
	assert.equal(
		decideEncryptionRecovery("prepared", false, false),
		"blocked",
	);
});

function createTransition(): LocalEncryptionTransition {
	return {
		id: "device:rotate:1",
		kind: "rotate",
		phase: "prepared",
		source: {
			enabled: true,
			salt: "old-salt",
			password: "old-password",
			revision: 1,
		},
		target: {
			enabled: true,
			salt: "new-salt",
			password: "new-password",
			revision: 2,
		},
		sourceRawPaths: ["old-file"],
		targetRawPaths: [],
		sourceFingerprints: { "old-file": "old-fingerprint" },
		targetFingerprints: {},
		sourceCanonicalRevision: 4,
	};
}

test("transition services are cleared after a failed re-encode", async () => {
	const calls: string[] = [];
	const indexManager = {
		setIndexTransitionServices: () => calls.push("set-codecs"),
		clearIndexTransitionServices: () => calls.push("clear-codecs"),
	} as unknown as IndexManager;
	const syncEngine = {
		reencodeRemoteFiles: async () => {
			calls.push("reencode");
			throw new Error("upload failed");
		},
	} as unknown as SyncEngine;
	const lifecycle = {
		claim: async () => undefined,
		applyTarget: async () => null,
		resolveTargetPaths: async () => undefined,
		assertSourceUnchanged: async () => undefined,
		captureTargetFingerprints: async () => undefined,
		setPhase: async () => undefined,
		stageMaintenance: async () => undefined,
		commitMaintenance: async () => undefined,
		publishStable: async () => undefined,
		prepareCleanup: async () => undefined,
		deletePaths: async () => undefined,
		deleteFolders: async () => undefined,
		finishMaintenance: async () => undefined,
		clearLocalTransition: async () => undefined,
		recover: async () => {
			calls.push("recover");
		},
		clearBlock: () => undefined,
		createSyncFailure: () => new Error("sync failed"),
	};
	const controller = new EncryptionTransitionController(
		indexManager,
		syncEngine,
		lifecycle,
	);

	await assert.rejects(
		controller.execute({
			transition: createTransition(),
			sourceService: null,
		}),
		/upload failed/,
	);
	assert.deepEqual(calls, [
		"set-codecs",
		"reencode",
		"clear-codecs",
		"recover",
	]);
});

test("all rewrite modes use the same post-commit cleanup", async () => {
	for (const kind of ["enable", "disable", "rotate"] as const) {
		const calls: string[] = [];
		const transition = createTransition();
		transition.kind = kind;
		const indexManager = {
			setIndexTransitionServices: () => undefined,
			clearIndexTransitionServices: () => undefined,
		} as unknown as IndexManager;
		const syncEngine = {
			showMaintenanceCleanupPhase: () => calls.push("cleanup-phase"),
			reencodeRemoteFiles: async (options: {
				beforeIndexCommit(): Promise<void>;
			}) => {
				await options.beforeIndexCommit();
				return {
					success: true,
					uploaded: 1,
					downloaded: 0,
					deleted: 0,
					errors: [],
				};
			},
		} as unknown as SyncEngine;
		const lifecycle = {
			claim: async () => undefined,
			applyTarget: async () => null,
			resolveTargetPaths: async () => undefined,
			assertSourceUnchanged: async () => undefined,
			captureTargetFingerprints: async () => undefined,
			setPhase: async () => undefined,
			stageMaintenance: async () => undefined,
			commitMaintenance: async () => {
				calls.push("commit-cleanup");
			},
			publishStable: async () => {
				calls.push("publish-stable");
			},
			prepareCleanup: async () => {
				calls.push("prepare-cleanup");
			},
			deletePaths: async () => {
				calls.push("delete-paths");
			},
			deleteFolders: async () => {
				calls.push("delete-folders");
			},
			finishMaintenance: async () => {
				calls.push("finish-maintenance");
			},
			clearLocalTransition: async () => {
				calls.push("clear-local");
			},
			recover: async () => {
				calls.push("recover");
			},
			clearBlock: () => calls.push("clear-block"),
			createSyncFailure: () => new Error("sync failed"),
		};
		const controller = new EncryptionTransitionController(
			indexManager,
			syncEngine,
			lifecycle,
		);

		await controller.execute({ transition, sourceService: null });
		assert.deepEqual(calls, [
			"cleanup-phase",
			"commit-cleanup",
			"publish-stable",
			"prepare-cleanup",
			"delete-paths",
			"delete-folders",
			"finish-maintenance",
			"clear-local",
			"clear-block",
		]);
	}
});
