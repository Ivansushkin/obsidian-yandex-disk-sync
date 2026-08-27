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
			profileId: "hardened",
		},
		target: {
			enabled: true,
			salt: "new-salt",
			password: "new-password",
			revision: 2,
			profileId: "hardened",
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

test("target manifest is published after claim and before target writes", async () => {
	const calls: string[] = [];
	const indexManager = {
		setIndexTransitionServices: () => calls.push("set-codecs"),
		clearIndexTransitionServices: () => calls.push("clear-codecs"),
	} as unknown as IndexManager;
	const syncEngine = {
		showMaintenanceCleanupPhase: () => undefined,
		reencodeRemoteFiles: async (options: {
			beforeIndexCommit(): Promise<void>;
		}) => {
			calls.push("copy-target");
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
		claim: async () => {
			calls.push("claim");
		},
		applyTarget: async () => {
			calls.push("apply-target");
			return null;
		},
		resolveTargetPaths: async () => {
			calls.push("resolve-target");
		},
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
		recover: async () => undefined,
		clearBlock: () => undefined,
		createSyncFailure: () => new Error("sync failed"),
	};
	const controller = new EncryptionTransitionController(
		indexManager,
		syncEngine,
		lifecycle,
	);
	await controller.execute({
		transition: createTransition(),
		sourceService: null,
		beforeApplyTarget: async () => {
			calls.push("publish-target-manifest");
		},
	});
	assert.ok(
		calls.indexOf("claim") < calls.indexOf("publish-target-manifest"),
	);
	assert.ok(
		calls.indexOf("publish-target-manifest") < calls.indexOf("apply-target"),
	);
	assert.ok(calls.indexOf("apply-target") < calls.indexOf("copy-target"));
});

test("cleanup proof is committed atomically with target canonical state", async () => {
	const transition = createTransition();
	let stagedCleanup: Array<{
		path: string;
		expectedFingerprint: string;
	}> = [];
	const indexManager = {
		setIndexTransitionServices: () => undefined,
		clearIndexTransitionServices: () => undefined,
	} as unknown as IndexManager;
	const syncEngine = {
		showMaintenanceCleanupPhase: () => undefined,
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
		stageMaintenance: async (
			_unusedTransition: LocalEncryptionTransition,
			phase: string,
			cleanup?: typeof stagedCleanup,
		) => {
			if (phase === "index-committed") stagedCleanup = cleanup ?? [];
		},
		commitMaintenance: async () => undefined,
		publishStable: async () => undefined,
		prepareCleanup: async () => undefined,
		deletePaths: async () => undefined,
		deleteFolders: async () => undefined,
		finishMaintenance: async () => undefined,
		clearLocalTransition: async () => undefined,
		recover: async () => undefined,
		clearBlock: () => undefined,
		createSyncFailure: () => new Error("sync failed"),
	};
	await new EncryptionTransitionController(
		indexManager,
		syncEngine,
		lifecycle,
	).execute({ transition, sourceService: null });
	assert.deepEqual(stagedCleanup, [
		{ path: "old-file", expectedFingerprint: "old-fingerprint" },
	]);
});

test("transition fault matrix always invokes deterministic recovery", async () => {
	for (const fault of [
		"claim",
		"manifest",
		"apply-target",
		"copy-target",
		"before-commit",
		"after-commit",
		"cleanup",
	] as const) {
		const calls: string[] = [];
		const failAt = (point: typeof fault): void => {
			if (point === fault) throw new Error(`fault:${fault}`);
		};
		const indexManager = {
			setIndexTransitionServices: () => calls.push("set-codecs"),
			clearIndexTransitionServices: () => calls.push("clear-codecs"),
		} as unknown as IndexManager;
		const syncEngine = {
			showMaintenanceCleanupPhase: () => undefined,
			reencodeRemoteFiles: async (options: {
				beforeIndexCommit(): Promise<void>;
			}) => {
				failAt("copy-target");
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
			claim: async () => failAt("claim"),
			applyTarget: async () => {
				failAt("apply-target");
				return null;
			},
			resolveTargetPaths: async () => undefined,
			assertSourceUnchanged: async () => failAt("before-commit"),
			captureTargetFingerprints: async () => undefined,
			setPhase: async () => undefined,
			stageMaintenance: async () => undefined,
			commitMaintenance: async () => failAt("cleanup"),
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
				beforeApplyTarget: async () => failAt("manifest"),
				publishIndexCommitted: async () => failAt("after-commit"),
			}),
			new RegExp(`fault:${fault}`),
		);
		assert.equal(calls.filter((call) => call === "recover").length, 1);
		assert.equal(
			calls.includes("set-codecs"),
			calls.includes("clear-codecs"),
			`codec scope leaked at ${fault}`,
		);
	}
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
