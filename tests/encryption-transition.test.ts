import assert from "node:assert/strict";
import test from "node:test";
import {
	decideEncryptionRecovery,
	EncryptionTransitionController,
	createRemoteTargetRecoveryPlan,
	createTargetRawMapping,
	hasPendingEncryptionCleanup,
	type LocalEncryptionTransition,
} from "../src/crypto/encryption-transition";
import type { IndexManager } from "../src/sync/index-manager";
import type { SyncEngine } from "../src/sync/sync-engine";
import type { IndexMaintenance, RemoteEncryptionManifest } from "../src/types";

type TransitionLifecycle = ConstructorParameters<typeof EncryptionTransitionController>[2];

/** Supply inert boundaries; each scenario overrides the phase it exercises. */
function createLifecycle(overrides: Partial<TransitionLifecycle> = {}): TransitionLifecycle {
	return {
		claim: async () => undefined,
		applyTarget: async () => null,
		resolveTargetPaths: async () => undefined,
		assertSourceUnchanged: async () => undefined,
		verifyTargetUpload: async () => ({ remoteFingerprint: "target" }),
		setPhase: async () => undefined,
		stageMaintenance: async () => undefined,
		commitMaintenance: async () => undefined,
		publishStable: async () => undefined,
		prepareCleanup: async () => undefined,
		deletePaths: async () => undefined,
		deleteFolders: async () => undefined,
		finishMaintenance: async () => true,
		clearLocalTransition: async () => undefined,
		recover: async () => undefined,
		clearBlock: () => undefined,
		createSyncFailure: () => new Error("sync failed"),
		...overrides,
	};
}

test("encryption recovery follows canonical authority across the commit boundary", () => {
	const cases = [
		["prepared", false, true, "rollback-source"],
		["files-copied", false, true, "rollback-source"],
		["files-copied", true, false, "finish-target"],
		["index-committed", false, true, "finish-target"],
		["stable", false, true, "finish-target"],
		["cleanup", false, true, "finish-target"],
		["prepared", false, false, "blocked"],
	] as const;
	for (const [phase, targetReadable, sourceReadable, expected] of cases) {
		assert.equal(decideEncryptionRecovery(phase, targetReadable, sourceReadable), expected, phase);
	}
});

test("unrelated guarded cleanup does not block encryption recovery", () => {
	const action = {
		id: "cleanup-1",
		type: "guarded-cleanup" as const,
		epoch: "epoch-a",
		origin: "rejected-upload" as const,
		path: "raw-file",
		canonicalRevision: 4,
		createdAt: 1,
	};
	assert.equal(hasPendingEncryptionCleanup([action], "epoch-a"), false);
	assert.equal(
		hasPendingEncryptionCleanup(
			[{ ...action, origin: "encryption-cleanup" }],
			"epoch-a",
		),
		true,
	);
	assert.equal(
		hasPendingEncryptionCleanup(
			[{ ...action, origin: "encryption-cleanup", epoch: "epoch-b" }],
			"epoch-a",
		),
		false,
	);
});

test("transition target mapping rejects raw collisions before upload", () => {
	assert.deepEqual(
		createTargetRawMapping(
			[
				["one.md", "raw-one"],
				["__proto__", "raw-prototype"],
			],
			["source-one"],
		),
		Object.fromEntries([
			["one.md", "raw-one"],
			["__proto__", "raw-prototype"],
		]),
	);
	assert.throws(() =>
		createTargetRawMapping(
			[
				["one.md", "same"],
				["two.md", "same"],
			],
			[],
		),
	);
	assert.throws(() =>
		createTargetRawMapping([["one.md", "source-one"]], ["source-one"]),
	);
	assert.throws(() =>
		createTargetRawMapping([["one.md", "source-one/child"]], ["source-one"]),
	);
	assert.throws(() =>
		createTargetRawMapping(
			[
				["one.md", "target"],
				["two.md", "target/child"],
			],
			[],
		),
	);
	assert.throws(() =>
		createTargetRawMapping([["one.md", ".backup/object"]], []),
	);
	assert.throws(() =>
		createTargetRawMapping([["one.md", "target"]], [".backup/source"]),
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
		targetRawByLogicalPath: {},
		sourceFingerprints: { "old-file": "old-fingerprint" },
		targetFingerprints: {},
		sourceCanonicalRevision: 4,
		backupProof: {
			path: ".backup/transition.enc.zip",
			sha256: "backup-sha",
			epoch: "epoch-a",
			canonicalRevision: 4,
			localSnapshotDigest: "snapshot-sha",
			createdAt: 1,
		},
	};
}

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
	const lifecycle = createLifecycle({
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
	});
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
	const lifecycle = createLifecycle({
		stageMaintenance: async (
			_unusedTransition: LocalEncryptionTransition,
			phase: string,
			cleanup?: typeof stagedCleanup,
		) => {
			if (phase === "index-committed") stagedCleanup = cleanup ?? [];
		},
	});
	await new EncryptionTransitionController(
		indexManager,
		syncEngine,
		lifecycle,
	).execute({ transition, sourceService: null });
	assert.deepEqual(stagedCleanup, [
		{ path: "old-file", expectedFingerprint: "old-fingerprint" },
	]);
});

test("missing source fingerprint blocks transition before canonical commit", async () => {
	const transition = createTransition();
	transition.sourceRawPaths = ["constructor"];
	transition.sourceFingerprints = {};
	let canonicalCommitted = false;
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
			canonicalCommitted = true;
			throw new Error("unexpected commit");
		},
	} as unknown as SyncEngine;
	const lifecycle = createLifecycle();

	await assert.rejects(
		new EncryptionTransitionController(
			indexManager,
			syncEngine,
			lifecycle,
		).execute({ transition, sourceService: null }),
		/Missing cleanup fingerprint/,
	);
	assert.equal(canonicalCommitted, false);
});

test("each rewritten target is proven before the canonical commit", async () => {
	const calls: string[] = [];
	const transition = createTransition();
	transition.targetRawByLogicalPath = { "note.md": "new-file" };
	const indexManager = {
		setIndexTransitionServices: () => undefined,
		clearIndexTransitionServices: () => undefined,
	} as unknown as IndexManager;
	const syncEngine = {
		showMaintenanceCleanupPhase: () => undefined,
		reencodeRemoteFiles: async (options: {
			verifyPhysicalRewriteUpload(
				path: string,
				sha256: string,
			): Promise<{ remoteFingerprint: string }>;
			beforeIndexCommit(): Promise<void>;
		}) => {
			calls.push("upload");
			await options.verifyPhysicalRewriteUpload("note.md", "plain-sha");
			calls.push("proof-returned");
			await options.beforeIndexCommit();
			calls.push("canonical-commit");
			return {
				success: true,
				uploaded: 1,
				downloaded: 0,
				deleted: 0,
				errors: [],
			};
		},
	} as unknown as SyncEngine;
	const lifecycle = createLifecycle({
		verifyTargetUpload: async (
			_received: LocalEncryptionTransition,
			path: string,
			sha256: string,
		) => {
			assert.equal(path, "note.md");
			assert.equal(sha256, "plain-sha");
			calls.push("stable-readback-proof");
			return { remoteFingerprint: "sha256:target" };
		},
	});
	await new EncryptionTransitionController(
		indexManager,
		syncEngine,
		lifecycle,
	).execute({ transition, sourceService: null });
	assert.ok(
		calls.indexOf("stable-readback-proof") < calls.indexOf("canonical-commit"),
	);
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
		const lifecycle = createLifecycle({
			claim: async () => failAt("claim"),
			applyTarget: async () => {
				failAt("apply-target");
				return null;
			},
			assertSourceUnchanged: async () => failAt("before-commit"),
			commitMaintenance: async () => failAt("cleanup"),
			recover: async () => {
				calls.push("recover");
			},
		});
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
		if (calls.includes("set-codecs")) {
			assert.ok(calls.indexOf("clear-codecs") < calls.indexOf("recover"), fault);
		}
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
		const lifecycle = createLifecycle({
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
				return true;
			},
			clearLocalTransition: async () => {
				calls.push("clear-local");
			},
			recover: async () => {
				calls.push("recover");
			},
			clearBlock: () => calls.push("clear-block"),
		});
		const controller = new EncryptionTransitionController(
			indexManager,
			syncEngine,
			lifecycle,
		);

		await controller.execute({ transition, sourceService: null });
		assert.deepEqual(calls, [
			"cleanup-phase",
			"publish-stable",
			"commit-cleanup",
			"prepare-cleanup",
			"delete-paths",
			"delete-folders",
			"finish-maintenance",
			"clear-local",
			"clear-block",
		]);
	}
});

test("incomplete cleanup keeps the transition blocked and local state durable", async () => {
	let clearedLocal = false;
	let clearedBlock = false;
	const indexManager = {} as IndexManager;
	const syncEngine = {
		showMaintenanceCleanupPhase: () => undefined,
	} as unknown as SyncEngine;
	const lifecycle = createLifecycle({
		finishMaintenance: async () => false,
		clearLocalTransition: async () => {
			clearedLocal = true;
		},
		clearBlock: () => {
			clearedBlock = true;
		},
	});

	await assert.rejects(
		new EncryptionTransitionController(
			indexManager,
			syncEngine,
			lifecycle,
		).completeTarget(createTransition()),
		/cleanup is incomplete/,
	);
	assert.equal(clearedLocal, false);
	assert.equal(clearedBlock, false);
});

test("foreign encrypted target recovery requires one matching committed authority", () => {
	for (const kind of ["enable", "rotate"] as const) {
		const source = kind === "enable"
			? { enabled: false, revision: null, salt: null, verifier: null }
			: {
					enabled: true,
					revision: 1,
					salt: "source-salt",
					verifier: "source-verifier",
				};
		const target = {
			enabled: true,
			revision: 2,
			salt: "target-salt",
			verifier: "target-verifier",
		};
		const maintenance: IndexMaintenance = {
			id: `${kind}-transition`,
			kind,
			phase: "index-committed",
			initiatedBy: "device-a",
			sourceRevision: 4,
			targetRevision: 5,
			source,
			target,
			cleanup: [],
		};
		const manifest = createTransitionManifest(
			kind === "enable" ? "enabling" : "rotating",
			maintenance,
		);
		assert.equal(
			createRemoteTargetRecoveryPlan(manifest, maintenance).passwordMode,
			"target",
		);
		assert.throws(() =>
			createRemoteTargetRecoveryPlan(manifest, {
				...maintenance,
				target: { ...target, verifier: "different" },
			}),
		);
		assert.throws(() =>
			createRemoteTargetRecoveryPlan(manifest, {
				...maintenance,
				targetRevision: null,
			}),
		);
		assert.throws(() =>
			createRemoteTargetRecoveryPlan(
				{
					...manifest,
					transition: {
						...manifest.transition!,
						phase: "files-copied",
					},
				},
				maintenance,
			),
		);
		assert.throws(() =>
			createRemoteTargetRecoveryPlan(
				{ ...manifest, updatedBy: "different-device" },
				maintenance,
			),
		);
	}
});

test("foreign disable recovery verifies source but adopts plaintext target", () => {
	const maintenance: IndexMaintenance = {
		id: "disable-transition",
		kind: "disable",
		phase: "cleanup",
		initiatedBy: "device-a",
		sourceRevision: 4,
		targetRevision: 5,
		source: {
			enabled: true,
			revision: 2,
			salt: "source-salt",
			verifier: "source-verifier",
		},
		target: { enabled: false, revision: null, salt: null, verifier: null },
		cleanup: [],
	};
	assert.equal(
		createRemoteTargetRecoveryPlan(
			createTransitionManifest("disabling", maintenance),
			maintenance,
		).passwordMode,
		"source",
	);
	assert.equal(
		createRemoteTargetRecoveryPlan(null, maintenance).passwordMode,
		"none",
	);
	assert.throws(() =>
		createRemoteTargetRecoveryPlan(null, {
			...maintenance,
			phase: "files-copied",
			targetRevision: null,
		}),
	);
});

test("local recovery requires matching manifest canonical and transition authority", async () => {
	const controller = new EncryptionTransitionController(
		{} as IndexManager,
		{} as SyncEngine,
		{} as never,
	);
	const transition = createTransition();
	const maintenance: IndexMaintenance = {
		id: transition.id,
		kind: "rotate",
		phase: "prepared",
		initiatedBy: "device-a",
		sourceRevision: transition.sourceCanonicalRevision,
		targetRevision: null,
		source: {
			enabled: true,
			revision: 1,
			salt: "old-salt",
			verifier: "source-verifier",
		},
		target: {
			enabled: true,
			revision: 2,
			salt: "new-salt",
			verifier: "target-verifier",
		},
		cleanup: [],
	};
	const manifest = createTransitionManifest("rotating", maintenance);
	const sourceService = {
		verifyVerifier: async (verifier: string) => verifier === "source-verifier",
	} as never;
	await assert.doesNotReject(
		controller.assertLocalRecoveryCoherence({
			transition,
			manifest,
			maintenance,
			deviceId: "device-a",
			authority: "source",
			authoritativeService: sourceService,
		}),
	);
	await assert.rejects(
		controller.assertLocalRecoveryCoherence({
			transition,
			manifest,
			maintenance: { ...maintenance, id: "different-transition" },
			deviceId: "device-a",
			authority: "source",
			authoritativeService: sourceService,
		}),
		/does not match canonical maintenance/,
	);

	transition.phase = "files-copied";
	const aheadManifest = {
		...manifest,
		transition: { ...manifest.transition!, phase: "index-committed" as const },
	};
	await assert.doesNotReject(
		controller.assertLocalRecoveryCoherence({
			transition,
			manifest: aheadManifest,
			maintenance,
			deviceId: "device-a",
			authority: "source",
			authoritativeService: sourceService,
		}),
	);
	await assert.rejects(
		controller.assertLocalRecoveryCoherence({
			transition,
			manifest: null,
			maintenance: undefined,
			deviceId: "device-a",
			authority: "target",
			authoritativeService: null,
		}),
		/no committed local or canonical phase/,
	);
	await assert.rejects(
		controller.assertLocalRecoveryCoherence({
			transition: { ...transition, phase: "prepared" },
			manifest,
			maintenance,
			deviceId: "device-a",
			authority: "source",
			authoritativeService: {
				verifyVerifier: async () => false,
			} as never,
		}),
		/maintenance verifier does not match/,
	);
});

test("stable manifest coherence accepts a fresh authenticated verifier IV", async () => {
	const controller = new EncryptionTransitionController(
		{} as IndexManager,
		{} as SyncEngine,
		{} as never,
	);
	const target = {
		enabled: true,
		revision: 2,
		salt: "target-salt",
		verifier: "maintenance-verifier",
	};
	const maintenance: IndexMaintenance = {
		id: "rotate-transition",
		kind: "rotate",
		phase: "index-committed",
		initiatedBy: "device-a",
		sourceRevision: 4,
		targetRevision: 5,
		source: {
			enabled: true,
			revision: 1,
			salt: "source-salt",
			verifier: "source-verifier",
		},
		target,
		cleanup: [],
	};
	const stableManifest: RemoteEncryptionManifest = {
		...createTransitionManifest("rotating", maintenance),
		state: "enabled",
		verifier: "fresh-randomized-verifier",
		transition: undefined,
	};
	const targetService = {
		verifyVerifier: async (verifier: string) =>
			verifier === "maintenance-verifier",
	} as never;
	await assert.doesNotReject(
		controller.assertStableManifestTarget(
			stableManifest,
			maintenance,
			targetService,
		),
	);
	await assert.rejects(
		controller.assertStableManifestTarget(
			{ ...stableManifest, salt: "different-salt" },
			maintenance,
			targetService,
		),
	);
	await assert.rejects(
		controller.assertStableManifestTarget(
			stableManifest,
			maintenance,
			{ verifyVerifier: async () => false } as never,
		),
		/does not match maintenance target/,
	);
});

function createTransitionManifest(
	state: "enabling" | "rotating" | "disabling",
	maintenance: IndexMaintenance,
): RemoteEncryptionManifest {
	const manifestMode = state === "disabling"
		? maintenance.source
		: maintenance.target;
	return {
		format: "encryption-manifest",
		profileId: "hardened",
		state,
		revision: manifestMode.revision!,
		salt: manifestMode.salt!,
		verifier: manifestMode.verifier!,
		kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600_000 },
		keySchedule: { name: "HKDF", hash: "SHA-256" },
		cipher: { name: "AES-GCM", keyLength: 256, ivLength: 12 },
		filenameCipher: {
			name: "AES-SIV",
			keyLength: 512,
			encoding: "base64url",
			aad: "obsidian-yandex-disk-sync:filename",
		},
		updatedAt: 1,
		updatedBy: "device-a",
		transition: {
			id: maintenance.id,
			phase: maintenance.phase,
			sourceRevision: maintenance.source.revision,
			targetRevision: maintenance.target.revision,
			initiatedBy: maintenance.initiatedBy,
			source: maintenance.source,
			target: maintenance.target,
			sourceProfileId: maintenance.source.enabled ? "hardened" : null,
			targetProfileId: maintenance.target.enabled ? "hardened" : null,
		},
	};
}
