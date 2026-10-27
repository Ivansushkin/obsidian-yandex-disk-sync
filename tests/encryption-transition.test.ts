import { fileMetadata } from "./helpers/metadata";
import {
	encryptedMode,
	plaintextMode,
	localTransition,
	maintenance as createMaintenance,
	transitionManifest,
} from "./helpers/crypto-fixtures";
import { DEFAULT_SETTINGS, createEmptyIndex } from "../src/types";
import type { YandexDiskClient } from "../src/api/yandex-client";
import type { VaultAdapter } from "../src/api/vault-adapter";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { YandexDiskClient as Client } from "../src/api/yandex-client";
import { MemoryDisk, bytes, codecFor } from "./helpers/sync-flow";
import {
	decideEncryptionRecovery,
	EncryptionTransitionController,
	createRemoteTargetRecoveryPlan,
	createTargetRawMapping,
	hasPendingEncryptionCleanup,
	verifyTransitionTargetObject,
	type LocalEncryptionTransition,
} from "../src/crypto/encryption-transition";
import { IndexManager } from "../src/sync/canonical/manager";
import type { SyncEngine } from "../src/sync/engine";
import type { IndexMaintenance, RemoteEncryptionManifest } from "../src/types";

const rewriteSuccess = {
	success: true,
	uploaded: 1,
	downloaded: 0,
	deleted: 0,
	errors: [],
};
type RewriteOptions = NonNullable<
	Parameters<SyncEngine["reencodeRemoteFiles"]>[0]
>;

type TransitionLifecycle = ConstructorParameters<
	typeof EncryptionTransitionController
>[2];

/** Supply inert boundaries; each scenario overrides the phase it exercises. */
function createLifecycle(
	overrides: Partial<TransitionLifecycle> = {},
): TransitionLifecycle {
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

/** Keep phase hooks explicit while sharing the inert controller boundaries. */
function createController(
	lifecycle: Partial<TransitionLifecycle> = {},
	engine: Partial<SyncEngine> = {},
	index: Partial<IndexManager> = {},
): EncryptionTransitionController {
	return new EncryptionTransitionController(
		{
			setIndexTransitionServices: () => undefined,
			clearIndexTransitionServices: () => undefined,
			...index,
		} as IndexManager,
		{
			showMaintenanceCleanupPhase: () => undefined,
			reencodeRemoteFiles: async (options) => {
				await options?.beforeIndexCommit?.();
				return rewriteSuccess;
			},
			...engine,
		} as SyncEngine,
		createLifecycle(lifecycle),
	);
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
		assert.equal(
			decideEncryptionRecovery(phase, targetReadable, sourceReadable),
			expected,
			phase,
		);
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
	const collisions: Array<[Array<[string, string]>, string[]]> = [
		[
			[
				["one.md", "same"],
				["two.md", "same"],
			],
			[],
		],
		[[["one.md", "source-one"]], ["source-one"]],
		[[["one.md", "source-one/child"]], ["source-one"]],
		[
			[
				["one.md", "target"],
				["two.md", "target/child"],
			],
			[],
		],
		[[["one.md", ".backup/object"]], []],
		[[["one.md", "target"]], [".backup/source"]],
	];
	for (const [targets, sources] of collisions) {
		assert.throws(() => createTargetRawMapping(targets, sources));
	}
});

test("target read-back separates physical file stamps from strict cleanup proofs", async () => {
	const codec = await codecFor(true);
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk();
		disk.install();
		const client = new Client({ token: "synthetic", maxRetries: 0 });
		client.setRemotePath("vault");
		client.setEncryptionService(encrypted ? codec : null);
		const content = bytes("preserved target");
		await client.uploadFile("vault/note.md", content);
		const physicalPath = await client.getPhysicalPath("vault/note.md");
		const rawPath = physicalPath.slice("vault/".length);
		const sha = createHash("sha256")
			.update(Buffer.from(disk.files.get(physicalPath)!))
			.digest("hex");
		const resource = disk.resource.bind(disk);
		const modified = "2026-01-01T00:00:00Z";
		for (const variant of [
			{
				metadata: { sha256: sha },
				physical: sha,
				strict: `sha256:${sha}`,
			},
			{
				metadata: { sha256: undefined, md5: "server-md5" },
				physical: "server-md5",
				strict: "md5:server-md5",
			},
			{
				metadata: { sha256: undefined, resource_id: "server-id" },
				physical: "server-id",
				strict: `modified:${modified}:size:${disk.files.get(physicalPath)!.byteLength}`,
			},
			{
				metadata: { sha256: undefined, resource_id: undefined },
				physical: modified,
				strict: `modified:${modified}:size:${disk.files.get(physicalPath)!.byteLength}`,
			},
		]) {
			disk.resource = async (path) => {
				const result = await resource(path);
				return result && path === physicalPath
					? { ...result, ...variant.metadata }
					: result;
			};
			const transition = localTransition();
			transition.target.enabled = encrypted;
			transition.targetRawByLogicalPath = { "note.md": rawPath };
			let persisted: Record<string, string> = {};
			const proof = await verifyTransitionTargetObject(
				{
					client,
					remotePath: "vault",
					persist: async () => {
						persisted = structuredClone(
							transition.targetFingerprints,
						);
					},
				},
				transition,
				"note.md",
				createHash("sha256").update(Buffer.from(content)).digest("hex"),
				encrypted ? codec : null,
				false,
			);
			assert.equal(proof?.remoteFingerprint, variant.physical);
			assert.equal(proof?.remoteMtime, Date.parse(modified));
			assert.equal(persisted[rawPath], variant.strict);
		}
	}
});

test("target read-back cannot return a stamp without matching bytes and durable proof", async () => {
	const disk = new MemoryDisk();
	disk.install();
	const client = new Client({ token: "synthetic", maxRetries: 0 });
	client.setRemotePath("vault");
	const content = bytes("preserved target");
	await client.uploadFile("vault/note.md", content);
	const sha = createHash("sha256").update(Buffer.from(content)).digest("hex");
	for (const failure of [
		"content",
		"path",
		"mode",
		"persist",
		"missing",
	] as const) {
		const transition = localTransition();
		transition.target.enabled = failure === "mode";
		transition.targetRawByLogicalPath = {
			"note.md": failure === "path" ? "other.md" : "note.md",
		};
		transition.targetFingerprints = { "note.md": "old-proof" };
		if (failure === "path") {
			await client.uploadFile("vault/other.md", content);
		}
		if (failure === "missing") {
			disk.files.delete("vault/note.md");
		}
		let persisted: Record<string, string> | undefined;
		const io = {
			client,
			remotePath: "vault",
			persist: async () => {
				if (failure === "persist") {
					throw new Error("synthetic persistence failure");
				}
				persisted = structuredClone(transition.targetFingerprints);
			},
		};
		if (failure === "missing") {
			assert.equal(
				await verifyTransitionTargetObject(
					io,
					transition,
					"note.md",
					sha,
					null,
					true,
				),
				null,
			);
			assert.equal(persisted, undefined);
			assert.deepEqual(transition.targetFingerprints, {
				"note.md": "old-proof",
			});
			await assert.rejects(
				verifyTransitionTargetObject(
					io,
					transition,
					"note.md",
					sha,
					null,
					false,
				),
				/disappeared/,
			);
		} else {
			await assert.rejects(
				verifyTransitionTargetObject(
					io,
					transition,
					"note.md",
					failure === "content" ? "wrong" : sha,
					null,
					false,
				),
			);
			assert.equal(persisted, undefined);
		}
	}
});

test("target manifest is published after claim and before target writes", async () => {
	const calls: string[] = [];
	const indexManager = {
		setIndexTransitionServices: () => calls.push("set-codecs"),
		clearIndexTransitionServices: () => calls.push("clear-codecs"),
	} as unknown as IndexManager;
	const syncEngine = {
		showMaintenanceCleanupPhase: () => undefined,
		reencodeRemoteFiles: async (options: RewriteOptions) => {
			calls.push("copy-target");
			await options.beforeIndexCommit!();
			return rewriteSuccess;
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
	const controller = createController(lifecycle, syncEngine, indexManager);
	await controller.execute({
		transition: localTransition(),
		sourceService: null,
		beforeApplyTarget: async () => {
			calls.push("publish-target-manifest");
		},
	});
	assert.ok(
		calls.indexOf("claim") < calls.indexOf("publish-target-manifest"),
	);
	assert.ok(
		calls.indexOf("publish-target-manifest") <
			calls.indexOf("apply-target"),
	);
	assert.ok(calls.indexOf("apply-target") < calls.indexOf("copy-target"));
});

test("cleanup proof is committed atomically with target canonical state", async () => {
	const transition = localTransition();
	let stagedCleanup: Array<{
		path: string;
		expectedFingerprint: string;
	}> = [];
	const lifecycle = createLifecycle({
		stageMaintenance: async (
			_unusedTransition: LocalEncryptionTransition,
			phase: string,
			cleanup?: typeof stagedCleanup,
		) => {
			if (phase === "index-committed") {
				stagedCleanup = cleanup ?? [];
			}
		},
	});
	await createController(lifecycle).execute({
		transition,
		sourceService: null,
	});
	assert.deepEqual(stagedCleanup, [
		{ path: "old-file", expectedFingerprint: "old-fingerprint" },
	]);
});

test("missing source fingerprint blocks transition before canonical commit", async () => {
	const transition = localTransition();
	transition.sourceRawPaths = ["constructor"];
	transition.sourceFingerprints = {};
	let canonicalCommitted = false;
	const syncEngine = {
		showMaintenanceCleanupPhase: () => undefined,
		reencodeRemoteFiles: async (options: RewriteOptions) => {
			await options.beforeIndexCommit!();
			canonicalCommitted = true;
			throw new Error("unexpected commit");
		},
	} as unknown as SyncEngine;
	const lifecycle = createLifecycle();

	await assert.rejects(
		createController(lifecycle, syncEngine).execute({
			transition,
			sourceService: null,
		}),
		/Missing cleanup fingerprint/,
	);
	assert.equal(canonicalCommitted, false);
});

test("each rewritten target is proven before the canonical commit", async () => {
	const calls: string[] = [];
	const transition = localTransition();
	transition.targetRawByLogicalPath = { "note.md": "new-file" };
	const syncEngine = {
		showMaintenanceCleanupPhase: () => undefined,
		reencodeRemoteFiles: async (options: RewriteOptions) => {
			calls.push("upload");
			await options.verifyPhysicalRewriteUpload!("note.md", "plain-sha");
			calls.push("proof-returned");
			await options.beforeIndexCommit!();
			calls.push("canonical-commit");
			return rewriteSuccess;
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
	await createController(lifecycle, syncEngine).execute({
		transition,
		sourceService: null,
	});
	assert.ok(
		calls.indexOf("stable-readback-proof") <
			calls.indexOf("canonical-commit"),
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
			if (point === fault) {
				throw new Error(`fault:${fault}`);
			}
		};
		const indexManager = {
			setIndexTransitionServices: () => calls.push("set-codecs"),
			clearIndexTransitionServices: () => calls.push("clear-codecs"),
		} as unknown as IndexManager;
		const syncEngine = {
			showMaintenanceCleanupPhase: () => undefined,
			reencodeRemoteFiles: async (options: RewriteOptions) => {
				failAt("copy-target");
				await options.beforeIndexCommit!();
				return rewriteSuccess;
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
		const controller = createController(
			lifecycle,
			syncEngine,
			indexManager,
		);
		await assert.rejects(
			controller.execute({
				transition: localTransition(),
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
			assert.ok(
				calls.indexOf("clear-codecs") < calls.indexOf("recover"),
				fault,
			);
		}
	}
});

test("all rewrite modes use the same post-commit cleanup", async () => {
	for (const kind of ["enable", "disable", "rotate"] as const) {
		const calls: string[] = [];
		const transition = localTransition();
		transition.kind = kind;
		const syncEngine = {
			showMaintenanceCleanupPhase: () => calls.push("cleanup-phase"),
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
		const controller = createController(lifecycle, syncEngine);

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
		createController(lifecycle).completeTarget(localTransition()),
		/cleanup is incomplete/,
	);
	assert.equal(clearedLocal, false);
	assert.equal(clearedBlock, false);
});

test("foreign encrypted target recovery requires one matching committed authority", () => {
	for (const kind of ["enable", "rotate"] as const) {
		const source = kind === "enable" ? plaintextMode() : encryptedMode();
		const target = encryptedMode(2, "target-salt", "target-verifier");
		const maintenance: IndexMaintenance = createMaintenance({
			id: `${kind}-transition`,
			kind,
			source,
			target,
		});
		const manifest = transitionManifest(
			kind === "enable" ? "enabling" : "rotating",
			maintenance,
		);
		assert.equal(
			createRemoteTargetRecoveryPlan(manifest, maintenance).passwordMode,
			"target",
		);
		assert.equal(
			createRemoteTargetRecoveryPlan(manifest, {
				...maintenance,
				phase: "cleanup",
			}).maintenance.id,
			maintenance.id,
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
	const maintenance: IndexMaintenance = createMaintenance({
		id: "disable-transition",
		kind: "disable",
		phase: "cleanup",
		source: encryptedMode(2, "source-salt", "source-verifier"),
		target: plaintextMode(),
	});
	assert.equal(
		createRemoteTargetRecoveryPlan(
			transitionManifest("disabling", maintenance),
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
	const controller = createController();
	const transition = localTransition();
	const maintenance: IndexMaintenance = createMaintenance({
		id: transition.id,
		phase: "prepared",
		sourceRevision: transition.sourceCanonicalRevision,
		targetRevision: null,
		source: encryptedMode(1, "old-salt", "source-verifier"),
		target: encryptedMode(2, "new-salt", "target-verifier"),
	});
	const manifest = transitionManifest("rotating", maintenance);
	const sourceService = {
		verifyVerifier: async (verifier: string) =>
			verifier === "source-verifier",
	} as never;
	const recovery = {
		transition,
		manifest,
		maintenance,
		deviceId: "device-a",
		authority: "source" as const,
		authoritativeService: sourceService,
	};
	await assert.doesNotReject(
		controller.assertLocalRecoveryCoherence(recovery),
	);
	await assert.rejects(
		controller.assertLocalRecoveryCoherence({
			...recovery,
			maintenance: { ...maintenance, id: "different-transition" },
		}),
		/does not match canonical maintenance/,
	);

	transition.phase = "files-copied";
	const aheadManifest = {
		...manifest,
		transition: {
			...manifest.transition!,
			phase: "index-committed" as const,
		},
	};
	await assert.doesNotReject(
		controller.assertLocalRecoveryCoherence({
			...recovery,
			manifest: aheadManifest,
		}),
	);
	await assert.rejects(
		controller.assertLocalRecoveryCoherence({
			...recovery,
			manifest: null,
			maintenance: undefined,
			authority: "target",
			authoritativeService: null,
		}),
		/no committed local or canonical phase/,
	);
	await assert.rejects(
		controller.assertLocalRecoveryCoherence({
			...recovery,
			transition: { ...transition, phase: "prepared" },
			authoritativeService: {
				verifyVerifier: async () => false,
			} as never,
		}),
		/maintenance verifier does not match/,
	);
});

test("stable manifest coherence accepts a fresh authenticated verifier IV", async () => {
	const controller = createController();
	const target = encryptedMode(2, "target-salt", "maintenance-verifier");
	const maintenance: IndexMaintenance = createMaintenance({
		id: "rotate-transition",
		target,
	});
	const stableManifest: RemoteEncryptionManifest = {
		...transitionManifest("rotating", maintenance),
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
		controller.assertStableManifestTarget(stableManifest, maintenance, {
			verifyVerifier: async () => false,
		} as never),
		/does not match maintenance target/,
	);
});

test("cleanup rechecks canonical ownership and retains ambiguous deletion for recovery", async () => {
	for (const mode of [
		"revoked",
		"changed",
		"missing-proof",
		"remaining",
		"lost-response",
		"guard-absent",
	] as const) {
		const manager = new IndexManager(
			{} as YandexDiskClient,
			{} as VaultAdapter,
			{ ...DEFAULT_SETTINGS },
		);
		const index = manager.getRemoteIndex();
		index.epoch = "E1";
		index.maintenance = createMaintenance(
			createMaintenance({
				id: "enable-A",
				kind: "enable",
				phase: "cleanup",
				initiatedBy: "A",
				sourceRevision: 1,
				targetRevision: 2,
				source: plaintextMode(),
				target: encryptedMode(1, "salt", "verifier"),
				cleanup: [
					{ path: "note.md", expectedFingerprint: "unchanged" },
				],
			}),
		);
		let canonical = structuredClone(index);
		const read = async () => structuredClone(canonical);
		manager.readCanonicalIndex = read;
		manager.createCanonicalReadSession = (assertCurrent = () => {}) =>
			Object.assign(read, {
				load: read,
				assertCurrent,
				close: () => {},
			});
		let present = true;
		let deletes = 0;
		let completed = false;
		let inDeleteAttempt = false;
		const client = {
			getReadConfigurationVersion: () => 0,
			withWriteGuard: async (
				_assertCurrent: () => void,
				action: () => Promise<void>,
			) => await action(),
			getPhysicalPath: async (path: string) => path,
			getResource: async () => {
				if (mode === "guard-absent" && inDeleteAttempt) {
					present = false;
					throw new Error("synthetic guard rejected");
				}
				if (mode === "revoked") {
					canonical = createEmptyIndex("B", "E1");
					canonical.files["note.md"] = fileMetadata("note.md", {
						sha256: "unchanged",
					});
				}
				return present
					? { sha256: mode === "changed" ? "new bytes" : "unchanged" }
					: null;
			},
			deleteResource: async (
				_path: string,
				_permanent: boolean,
				_raw: boolean,
				guard: () => Promise<void>,
			) => {
				inDeleteAttempt = true;
				try {
					await guard();
				} finally {
					inDeleteAttempt = false;
				}
				deletes++;
				if (mode === "lost-response") {
					present = false;
				}
				throw new Error("timeout");
			},
		} as unknown as YandexDiskClient;
		const controller = new EncryptionTransitionController(
			manager,
			{ createReadLifetimeGuard: () => () => {} } as SyncEngine,
			createLifecycle(),
			{
				client,
				getRemotePath: () => "vault",
				getConcurrency: () => 1,
				completeAction: () => {
					completed = true;
				},
				persist: async () => {},
			},
		);
		const run = controller.cleanupRawPaths(
			["note.md"],
			mode === "missing-proof" ? {} : { "note.md": "unchanged" },
		);
		if (mode === "lost-response") {
			await run;
		} else {
			await assert.rejects(
				run,
				/authority changed|timeout|target changed|no longer authorized|guard rejected/,
			);
		}
		assert.equal(completed, mode === "lost-response");
		assert.equal(
			present,
			mode !== "lost-response" && mode !== "guard-absent",
		);
		assert.equal(
			deletes,
			mode === "remaining" || mode === "lost-response" ? 1 : 0,
		);
	}
});
