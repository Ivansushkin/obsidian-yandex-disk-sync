import { confirmForceReplacementPlan } from "../src/sync/workflows/force-replacement";
import { encryptionFlow } from "./helpers/encryption-flow";
import assert from "node:assert/strict";
import test from "node:test";
import {
	captureLogicalVaultSnapshot,
	captureRemoteRawSnapshot,
} from "../src/backup/backup-snapshot";
import { BackupManager } from "../src/backup/backup-manager";
import { createEmptyIndex } from "../src/types";
import type { ForcePreflightProof } from "../src/sync/contracts";
import { MemoryDisk, bytes, codecFor, device } from "./helpers/sync-flow";
import YandexDiskSyncPlugin from "../src/main";
import type { ForceSyncController } from "../src/sync/workflows/force-controller";
import type { CanonicalRecovery } from "../src/sync/canonical/recovery";
import { isRemoteReadTimeout, OperationFailure } from "../src/errors";
import { logger } from "../src/utils/logger";

/** Keep plugin admission/controller wiring while replacing only presentation and host persistence. */
function forceUi(a: ReturnType<typeof device>) {
	const settings = { ...a.settings, yandexTokenSecret: "synthetic" };
	const encryption = encryptionFlow(a, { getSettings: () => settings });
	return Object.assign(
		Object.create(YandexDiskSyncPlugin.prototype) as object,
		{
			settings,
			encryptionWorkflow: encryption.workflow,
			indexManager: a.index,
			yandexClient: a.client,
			vaultAdapter: a.adapter,
			syncEngine: a.engine,
			fileWatcher: a.watcher,
			syncScheduler: { stop: () => {}, start: () => {} },
			storageBinding: { ensure: async () => true },
			remoteStateValidated: false,
			encryptionTransition: null,
			forceRecovery: null,
			localStateRestored: true,
			syncLifecycleRegistered: true,
			confirmForceSync: async () => "without-backup",
			renderForceProgress: () => {},
			isForceSyncUnavailable: () => false,
			persistPluginData: async () => {
				await a.saved();
			},
			runFullSync: async () => await a.engine.fullSync(),
		},
	) as unknown as {
		settings: typeof a.settings;
		prepareForceSync(direction: "from_local" | "from_remote"): Promise<{
			canonical: ForcePreflightProof["canonical"];
			replacement: NonNullable<
				import("../src/sync/contracts").SyncRunOptions["forceReplacement"]
			>;
		} | null>;
		getForceSyncController(): ForceSyncController;
	};
}

/** Exercise the same preflight and optional archive as the UI without mocking sync. */
async function forceProof(
	a: ReturnType<typeof device>,
	direction: "from_local" | "from_remote",
	withBackup = false,
): Promise<ForcePreflightProof> {
	const canonical = await a.index.captureForceCanonicalProof();
	await a.index.assertLegacyMigrationPathsSafe();
	const snapshot =
		direction === "from_local"
			? await captureRemoteRawSnapshot(a.client, "vault")
			: await captureLogicalVaultSnapshot(a.adapter);
	const proof: ForcePreflightProof = {
		direction,
		canonical,
		snapshotDigest: snapshot.digest,
		backup: null,
	};
	if (withBackup) {
		const backup = new BackupManager(
			a.client,
			a.adapter,
			a.settings,
			"2.0.0",
		);
		const result =
			direction === "from_local"
				? await backup.createRemoteSnapshotBackup()
				: await backup.createBackup();
		assert.equal(result.success, true, result.error);
		proof.backup = {
			backupName: result.backupName!,
			backupSha256: result.sha256!,
		};
	}
	return proof;
}

test("stale lock codec fallback reuses stable bytes and stops unresolved reads", async () => {
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "device-a", codec);
		const recovery = (a.index as unknown as { recovery: CanonicalRecovery })
			.recovery;
		const lockPath = "vault/.obsidian-sync-index.lock.interrupted";
		const canonicalPath = "vault/.obsidian-sync-index.json";
		const content = bytes(JSON.stringify(createEmptyIndex("device-b")));
		const raw = codec ? await codec.encrypt(content) : content;
		disk.files.set(lockPath, raw);
		const resource = await a.client.getResource(lockPath, 1, 0, true);
		assert.ok(resource);
		const local = a.index.captureLocalCausalState();
		const originalNow = Date.now;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let complete!: () => void;
		const lateReply = new Promise<void>((resolve) => {
			complete = resolve;
		});
		let downloads = 0;
		try {
			await recovery.recoverStaleLock([resource]);
			Date.now = () => originalNow() + 121000;
			disk.beforeRequest = async (_method, endpoint, path) => {
				if (endpoint === "/download" && path === lockPath) {
					downloads++;
					await gate;
				}
			};
			disk.afterRequest = async (_method, endpoint, path) => {
				if (endpoint === "/download" && path === lockPath) {
					complete();
				}
			};
			const readStable = a.client.downloadStableRawFile.bind(a.client);
			a.client.downloadStableRawFile = (path, expected, budget) =>
				readStable(
					path,
					expected,
					path === lockPath
						? { deadline: Date.now() + 15, timeoutMs: 15 }
						: budget,
				);
			try {
				await assert.rejects(
					recovery.recoverStaleLock([resource]),
					(error) => {
						const failure = new OperationFailure(error, {
							stage: "stale-lock",
							action: "read",
						});
						assert.equal(
							failure.summary.code,
							"remote-read-timeout",
						);
						assert.equal(
							failure.summary.requestState,
							"unresolved",
						);
						return isRemoteReadTimeout(error);
					},
				);
			} finally {
				a.client.downloadStableRawFile = readStable;
			}
			assert.equal(downloads, 1);
			release();
			await lateReply;
			assert.deepEqual(disk.files.get(lockPath), raw);
			assert.equal(disk.files.has(canonicalPath), false);
			assert.deepEqual(a.index.captureLocalCausalState(), local);
			disk.afterRequest = undefined;
			downloads = 0;
			disk.beforeRequest = async (_method, endpoint, path) => {
				if (endpoint === "/download" && path === lockPath) {
					downloads++;
				}
			};
			// The other mode cannot decode these bytes; target must use the same raw read.
			a.index.setIndexTransitionServices(
				encrypted ? null : await codecFor(true),
				codec,
			);
			await recovery.recoverStaleLock([resource]);
			assert.equal(downloads, 1);
			assert.deepEqual(disk.files.get(canonicalPath), raw);
			assert.equal(disk.files.has(lockPath), false);
			assert.deepEqual(a.index.captureLocalCausalState(), local);
		} finally {
			release();
			Date.now = originalNow;
			disk.beforeRequest = undefined;
			disk.afterRequest = undefined;
			await a.stop();
		}
	}
});

test("stale recovery resets renewed lock leases before read move and retry", async () => {
	for (const boundary of ["before-read", "after-read", "retry"] as const) {
		const disk = new MemoryDisk();
		const codec = await codecFor(boundary === "after-read");
		const a = device(disk, "reader", codec, undefined, undefined, {
			maxRetries: 1,
		});
		const recovery = (a.index as unknown as { recovery: CanonicalRecovery })
			.recovery;
		const lockPath = "vault/.obsidian-sync-index.lock.owner.attempt";
		const canonicalPath = "vault/.obsidian-sync-index.json";
		const index = createEmptyIndex("owner");
		const raw = bytes(JSON.stringify(index));
		const next = bytes(JSON.stringify({ ...index, revision: 1 }));
		const initial = codec ? await codec.encrypt(raw) : raw;
		const renewed = codec ? await codec.encrypt(next) : next;
		disk.files.set(lockPath, initial);
		disk.files.set("vault/note.md", bytes("preserved"));
		const local = a.index.captureLocalCausalState();
		const resource = await a.client.getResource(lockPath, 1, 0, true);
		assert.ok(resource);
		const originalNow = Date.now;
		const originalWarn = logger.warn.bind(logger);
		let now = originalNow();
		let downloaded = false;
		let changed = false;
		let recovered = false;
		Date.now = () => now;
		logger.warn = (message) => {
			recovered ||= message.startsWith("Recovered stale index lock");
		};
		try {
			await recovery.recoverStaleLock([resource]);
			now += 121000;
			disk.beforeRequest = async (_method, endpoint, path) => {
				if (
					boundary === "before-read" &&
					!changed &&
					path === lockPath
				) {
					disk.files.set(lockPath, renewed);
					changed = true;
				}
				if (endpoint === "/download" && path === lockPath) {
					downloaded = true;
				}
			};
			disk.afterRequest = async (_method, endpoint, path) => {
				if (
					boundary === "after-read" &&
					!changed &&
					downloaded &&
					path === lockPath &&
					endpoint.endsWith("/resources")
				) {
					disk.files.set(lockPath, renewed);
					changed = true;
				}
			};
			const request = disk.request.bind(disk);
			disk.request = async (params) => {
				if (
					boundary === "retry" &&
					!changed &&
					new URL(params.url).pathname.endsWith("/resources/move")
				) {
					disk.files.set(lockPath, renewed);
					changed = true;
					return {
						status: 503,
						json: {},
						text: "",
						arrayBuffer: new ArrayBuffer(0),
						headers: {},
					};
				}
				return request(params);
			};
			await recovery.recoverStaleLock([resource]);
			assert.equal(changed, true, boundary);
			assert.equal(disk.files.has(canonicalPath), false, boundary);
			assert.deepEqual(disk.files.get(lockPath), renewed, boundary);
			assert.equal(recovered, false, boundary);
			const fresh = await a.client.getResource(lockPath, 1, 0, true);
			assert.ok(fresh);
			now += 1000;
			await recovery.recoverStaleLock([fresh]);
			assert.equal(
				disk.files.has(canonicalPath),
				false,
				"renewal needs its own full lease",
			);
			now += 120000;
			await recovery.recoverStaleLock([fresh]);
			assert.deepEqual(disk.files.get(canonicalPath), renewed);
			assert.equal(disk.files.has(lockPath), false);
			assert.deepEqual(
				disk.files.get("vault/note.md"),
				bytes("preserved"),
			);
			assert.deepEqual(a.index.captureLocalCausalState(), local);
		} finally {
			Date.now = originalNow;
			logger.warn = originalWarn;
			await a.stop();
		}
	}
});

test("stale recovery verifies lost move replies and rejects competing publication", async () => {
	for (const outcome of [
		"lost-reply",
		"changed-canonical",
		"second-lock",
		"renewed-at-server",
	] as const) {
		const disk = new MemoryDisk();
		const codec = await codecFor(outcome === "lost-reply");
		const a = device(disk, "reader", codec);
		a.index.setIndexTransitionServices(codec, null);
		const recovery = (a.index as unknown as { recovery: CanonicalRecovery })
			.recovery;
		const lockPath = "vault/.obsidian-sync-index.lock.owner.attempt";
		const otherPath = "vault/.obsidian-sync-index.lock.other.attempt";
		const canonicalPath = "vault/.obsidian-sync-index.json";
		const index = createEmptyIndex("owner");
		const content = bytes(JSON.stringify(index));
		const raw = codec ? await codec.encrypt(content) : content;
		const foreign = bytes(
			JSON.stringify(
				outcome === "renewed-at-server"
					? { ...index, revision: 1 }
					: createEmptyIndex("other"),
			),
		);
		if (outcome === "lost-reply") {
			const resource = disk.resource.bind(disk);
			disk.resource = async (path) => {
				const metadata = await resource(path);
				if (metadata) {
					delete metadata.sha256;
				}
				return metadata;
			};
		}
		disk.files.set(lockPath, raw);
		const resource = await a.client.getResource(lockPath, 1, 0, true);
		assert.ok(resource);
		const originalNow = Date.now;
		const originalWarn = logger.warn.bind(logger);
		let recovered = false;
		logger.warn = (message) => {
			recovered ||= message.startsWith("Recovered stale index lock");
		};
		try {
			await recovery.recoverStaleLock([resource]);
			Date.now = () => originalNow() + 121000;
			disk.beforeRequest = async (_method, endpoint) => {
				if (
					outcome === "renewed-at-server" &&
					endpoint.endsWith("/resources/move") &&
					disk.files.has(lockPath)
				) {
					disk.files.set(lockPath, foreign);
				}
			};
			disk.afterRequest = async (_method, endpoint, path) => {
				if (
					outcome === "second-lock" &&
					endpoint === "/download" &&
					path === lockPath
				) {
					disk.files.set(otherPath, foreign);
				}
				if (endpoint.endsWith("/resources/move")) {
					if (outcome === "renewed-at-server") {
						return;
					}
					if (
						outcome === "changed-canonical" &&
						path === canonicalPath
					) {
						disk.files.set(canonicalPath, foreign);
						return;
					}
					if (path === canonicalPath) {
						throw new Error("synthetic lost move reply");
					}
				}
			};
			if (outcome === "renewed-at-server") {
				await recovery.recoverStaleLock([resource]);
				assert.equal(disk.files.has(canonicalPath), false);
				assert.deepEqual(disk.files.get(lockPath), foreign);
				assert.equal(disk.files.size, 1);
				assert.equal(recovered, false);
			} else if (outcome === "lost-reply") {
				await recovery.recoverStaleLock([resource]);
				assert.deepEqual(disk.files.get(canonicalPath), raw);
				assert.equal(disk.files.has(lockPath), false);
				assert.equal(recovered, true);
			} else {
				await assert.rejects(recovery.recoverStaleLock([resource]));
				assert.equal(recovered, false);
				assert.deepEqual(
					disk.files.get(
						outcome === "second-lock" ? lockPath : canonicalPath,
					),
					outcome === "second-lock" ? raw : foreign,
				);
				if (outcome === "second-lock") {
					assert.deepEqual(disk.files.get(otherPath), foreign);
					assert.equal(disk.files.has(canonicalPath), false);
				}
			}
		} finally {
			Date.now = originalNow;
			logger.warn = originalWarn;
			await a.stop();
		}
	}
});

test("stale recovery claims survive restart and preserve a resurrected owner lock", async () => {
	for (const fault of ["restart", "resurrected-owner"] as const) {
		const disk = new MemoryDisk();
		const codec = await codecFor(true);
		const a = device(disk, "reader", codec);
		const recovery = (a.index as unknown as { recovery: CanonicalRecovery })
			.recovery;
		const lockPath = "vault/.obsidian-sync-index.lock.owner.attempt";
		const canonicalPath = "vault/.obsidian-sync-index.json";
		const index = createEmptyIndex("owner");
		const raw = await codec!.encrypt(bytes(JSON.stringify(index)));
		const renewed = await codec!.encrypt(
			bytes(JSON.stringify({ ...index, revision: 1 })),
		);
		disk.files.set(lockPath, raw);
		const resource = await a.client.getResource(lockPath, 1, 0, true);
		assert.ok(resource);
		const originalNow = Date.now;
		let now = originalNow();
		let claimPath = "";
		Date.now = () => now;
		try {
			await recovery.recoverStaleLock([resource]);
			now += 121000;
			disk.beforeRequest = async (_method, endpoint, path) => {
				if (
					fault === "restart" &&
					endpoint === "/download" &&
					path !== lockPath
				) {
					throw new Error("synthetic interrupted claim read");
				}
			};
			disk.afterRequest = async (_method, endpoint, path) => {
				if (
					endpoint.endsWith("/resources/move") &&
					path !== canonicalPath
				) {
					claimPath = path;
					if (fault === "resurrected-owner") {
						disk.files.set(lockPath, renewed);
					}
				}
			};
			await assert.rejects(recovery.recoverStaleLock([resource]));
			assert.equal(disk.files.has(canonicalPath), false);
			assert.deepEqual(disk.files.get(claimPath), raw);
			if (fault === "resurrected-owner") {
				assert.deepEqual(disk.files.get(lockPath), renewed);
				continue;
			}
			disk.beforeRequest = undefined;
			disk.afterRequest = undefined;
			const b = device(disk, "restarted-reader", codec);
			try {
				const restarted = (
					b.index as unknown as { recovery: CanonicalRecovery }
				).recovery;
				await restarted.recoverStaleLock();
				assert.equal(
					disk.files.has(canonicalPath),
					false,
					"restart starts a fresh lease",
				);
				now += 121000;
				await restarted.recoverStaleLock();
				assert.deepEqual(disk.files.get(canonicalPath), raw);
				assert.equal(disk.files.size, 1);
			} finally {
				await b.stop();
			}
		} finally {
			Date.now = originalNow;
			await a.stop();
		}
	}
});

test("Force local rebuilds a cleared disk and another device adopts it", async () => {
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "device-a", codec);
		const b = device(disk, "device-b", codec);
		try {
			a.vault.put("Note.md", bytes("kept"));
			await a.full();
			await b.full();
			const previousEpoch = (await a.canonical()).epoch;
			b.vault.put("Note.md", bytes("offline edit"));
			disk.files.clear();
			const canonical = await a.index.captureForceCanonicalProof();
			await a.index.assertLegacyMigrationPathsSafe();
			const snapshot = await captureRemoteRawSnapshot(a.client, "vault");
			const result = await a.engine.forceSyncFromLocal({
				forcePreflightProof: {
					direction: "from_local",
					canonical,
					snapshotDigest: snapshot.digest,
					backup: null,
				},
			});
			assert.equal(result.success, true, JSON.stringify(result.errors));
			assert.notEqual((await a.canonical()).epoch, previousEpoch);
			assert.equal((await a.canonical()).deviceId, "device-a");
			const blocked = await b.engine.fullSync();
			assert.equal(blocked.errors[0]?.code, "epoch-decision-required");
			const adopted = await b.engine.fullSync({
				epochAdoption: {
					epoch: (await a.canonical()).epoch,
					decision: "preserve",
				},
			});
			assert.equal(adopted.success, true, JSON.stringify(adopted.errors));
			await a.full();
			await a.assertSettled({ "Note.md": "offline edit" });
			await b.assertSettled({ "Note.md": "offline edit" });
			const settled = disk.files
				.get("vault/.obsidian-sync-index.json")!
				.slice(0);
			const again = await a.full();
			assert.equal(again.uploaded + again.downloaded + again.deleted, 0);
			assert.deepEqual(
				disk.files.get("vault/.obsidian-sync-index.json"),
				settled,
			);
		} finally {
			await a.stop();
			await b.stop();
		}
	}
});

test("confirmed Force replaces abandoned bootstrap locks without weakening current validation", async () => {
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "device-a", codec);
		try {
			a.vault.put("Note.md", bytes("kept"));
			const seed = bytes(JSON.stringify(createEmptyIndex("")));
			const raw = codec ? await codec.encrypt(seed) : seed;
			for (const id of ["old-a", "old-b"]) {
				disk.files.set(
					`vault/.obsidian-sync-index.lock.${id}.attempt`,
					raw.slice(0),
				);
			}
			const proof = await forceProof(a, "from_local", true);
			const result = await a.engine.forceSyncFromLocal({
				forcePreflightProof: proof,
			});
			assert.equal(result.success, true, JSON.stringify(result.errors));
			await a.assertSettled({ "Note.md": "kept" });
			await a.index.assertLegacyMigrationPathsSafe();
			disk.files.set("vault/.obsidian-sync-index.json", raw);
			await assert.rejects(
				a.index.captureForceCanonicalProof(),
				/deviceId is required/,
			);
		} finally {
			await a.stop();
		}
	}
});

test("Force proof rejects canonical or lock drift before transfers and replacement commit", async () => {
	for (const timing of [
		"before-apply",
		"before-commit",
		"canonical-before-commit",
	] as const) {
		const disk = new MemoryDisk();
		const a = device(disk, "device-a", null);
		const path =
			timing === "canonical-before-commit"
				? "vault/.obsidian-sync-index.json"
				: "vault/.obsidian-sync-index.lock.device-b.attempt";
		try {
			a.vault.put("Note.md", bytes("kept"));
			const proof = await forceProof(a, "from_local");
			const foreign = bytes(JSON.stringify(createEmptyIndex("device-b")));
			if (timing === "before-apply") {
				disk.files.set(path, foreign);
			}
			const result = await a.engine.forceSyncFromLocal({
				forcePreflightProof: proof,
				beforeIndexCommit:
					timing !== "before-apply"
						? () => {
								disk.files.set(path, foreign);
							}
						: undefined,
			});
			assert.equal(result.success, false);
			assert.deepEqual(disk.files.get(path), foreign);
			assert.equal(
				disk.files.has("vault/.obsidian-sync-index.json"),
				timing === "canonical-before-commit",
			);
			assert.equal(a.index.getObservedEpoch(), null);
			if (timing === "before-apply") {
				assert.equal(disk.files.has("vault/Note.md"), false);
			}
		} finally {
			await a.stop();
		}
	}
});

test("empty Force sources create a readable canonical in both directions", async () => {
	for (const encrypted of [false, true]) {
		for (const direction of ["from_local", "from_remote"] as const) {
			const disk = new MemoryDisk();
			const a = device(disk, "device-a", await codecFor(encrypted));
			try {
				const proof = await forceProof(a, direction);
				const options = { forcePreflightProof: proof };
				const result =
					direction === "from_local"
						? await a.engine.forceSyncFromLocal(options)
						: await a.engine.forceSyncFromRemote(options);
				assert.equal(
					result.success,
					true,
					JSON.stringify(result.errors),
				);
				await a.assertSettled({});
				assert.equal((await a.canonical()).deviceId, "device-a");
			} finally {
				await a.stop();
			}
		}
	}
});

test("a lost seed upload response is verified and a competing seed is preserved", async () => {
	for (const outcome of ["lost", "lost-race", "exclusive-race"] as const) {
		const collision = outcome !== "lost";
		const disk = new MemoryDisk();
		const a = device(disk, "device-a", null);
		const canonicalPath = "vault/.obsidian-sync-index.json";
		const foreign = bytes(
			JSON.stringify(createEmptyIndex("device-b", "foreign-epoch")),
		);
		let intercepted = false;
		try {
			disk.beforeRequest = async (method, endpoint, path) => {
				if (
					outcome === "exclusive-race" &&
					!intercepted &&
					method === "PUT" &&
					endpoint === "/upload" &&
					path === canonicalPath
				) {
					intercepted = true;
					disk.files.set(path, foreign);
				}
			};
			disk.afterRequest = async (method, endpoint, path) => {
				if (
					!intercepted &&
					method === "PUT" &&
					endpoint === "/upload" &&
					path === canonicalPath
				) {
					intercepted = true;
					if (collision) {
						disk.files.set(path, foreign);
					}
					throw new TypeError("synthetic lost upload response");
				}
			};
			const index = await a.index.loadRemoteIndex();
			assert.equal(index.deviceId, collision ? "device-b" : "device-a");
			if (collision) {
				assert.deepEqual(disk.files.get(canonicalPath), foreign);
			}
		} finally {
			disk.beforeRequest = undefined;
			disk.afterRequest = undefined;
			await a.stop();
		}
	}
});

test("orphan recovery preserves malformed and state-bearing old bootstrap locks", async () => {
	for (const stateBearing of [false, true]) {
		const disk = new MemoryDisk();
		const a = device(disk, "device-a", null);
		const now = Date.now;
		const path = "vault/.obsidian-sync-index.lock.old.attempt";
		try {
			a.vault.put("Note.md", bytes("kept"));
			await a.full();
			const canonical = disk.files
				.get("vault/.obsidian-sync-index.json")!
				.slice(0);
			const seed = createEmptyIndex("");
			if (stateBearing) {
				seed.files["Uncommitted.md"] = {
					path: "Uncommitted.md",
					sha256: "uncommitted",
					size: 1,
					mtime: 0,
					syncedAt: 0,
				};
			} else {
				Object.assign(seed, { unexpected: true });
			}
			const raw = bytes(JSON.stringify(seed));
			disk.files.set(path, raw);
			await a.index.readCanonicalIndex();
			Date.now = () => now() + 120_001;
			await assert.rejects(
				a.index.readCanonicalIndex(),
				/Current remote sync index is invalid/,
			);
			assert.deepEqual(disk.files.get(path), raw);
			assert.deepEqual(
				disk.files.get("vault/.obsidian-sync-index.json"),
				canonical,
			);
		} finally {
			Date.now = now;
			await a.stop();
		}
	}
});

test("committed Force cleanup resumes after restart without another Force or archive", async () => {
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		let a = device(disk, "device-a", codec);
		const now = Date.now;
		try {
			a.vault.put("Note.md", bytes("kept"));
			const seed = bytes(JSON.stringify(createEmptyIndex("")));
			const raw = codec ? await codec.encrypt(seed) : seed;
			for (const id of ["old-a", "old-b"]) {
				disk.files.set(
					`vault/.obsidian-sync-index.lock.${id}.attempt`,
					raw.slice(0),
				);
			}
			const proof = await forceProof(a, "from_local");
			disk.beforeRequest = async (method, _endpoint, path) => {
				if (
					method === "DELETE" &&
					path.includes(".obsidian-sync-index.lock.")
				) {
					throw new TypeError("synthetic cleanup failure");
				}
			};
			const result = await a.engine.forceSyncFromLocal({
				forcePreflightProof: proof,
			});
			assert.equal(result.success, false);
			assert.equal(result.replacementCommitted, true);
			const committed = disk.files
				.get("vault/.obsidian-sync-index.json")!
				.slice(0);
			const epoch = a.index.getRemoteIndex().epoch;
			assert.equal(a.index.getObservedEpoch(), epoch);
			const saved = await a.saved();
			await a.stop();
			disk.beforeRequest = undefined;
			a = device(disk, "device-a", codec, a.vault, saved);
			await a.engine.fullSync();
			Date.now = () => now() + 120_001;
			await a.full();
			await a.assertSettled({ "Note.md": "kept" });
			assert.deepEqual(
				disk.files.get("vault/.obsidian-sync-index.json"),
				committed,
			);
			assert.equal(
				[...disk.files.keys()].some((path) =>
					path.startsWith("vault/.backup/"),
				),
				false,
			);
		} finally {
			Date.now = now;
			disk.beforeRequest = undefined;
			await a.stop();
		}
	}
});

test("a lock changed after replacement commit is preserved and reported", async () => {
	const disk = new MemoryDisk();
	const a = device(disk, "device-a", null);
	const path = "vault/.obsidian-sync-index.lock.old.attempt";
	try {
		a.vault.put("Note.md", bytes("kept"));
		disk.files.set(path, bytes(JSON.stringify(createEmptyIndex(""))));
		const proof = await forceProof(a, "from_local");
		const changed = bytes(
			JSON.stringify(createEmptyIndex("device-b", "new-foreign-epoch")),
		);
		disk.afterRequest = async (method, endpoint, target) => {
			if (
				method === "POST" &&
				endpoint.endsWith("/resources/move") &&
				target === "vault/.obsidian-sync-index.json"
			) {
				disk.files.set(path, changed);
			}
		};
		const result = await a.engine.forceSyncFromLocal({
			forcePreflightProof: proof,
		});
		assert.equal(result.success, false);
		assert.equal(result.replacementCommitted, true);
		assert.deepEqual(disk.files.get(path), changed);
		assert.equal(
			a.index.getObservedEpoch(),
			a.index.getRemoteIndex().epoch,
		);
		assert.equal(disk.files.has("vault/.obsidian-sync-index.json"), true);
	} finally {
		disk.afterRequest = undefined;
		await a.stop();
	}
});

test("Force cannot replace a competing canonical created after its absent preflight", async () => {
	const disk = new MemoryDisk();
	const a = device(disk, "device-a", null);
	const path = "vault/.obsidian-sync-index.json";
	const foreign = bytes(
		JSON.stringify(createEmptyIndex("device-b", "foreign-epoch")),
	);
	let replaced = false;
	try {
		a.vault.put("Note.md", bytes("kept"));
		const proof = await forceProof(a, "from_local");
		disk.afterRequest = async (method, endpoint, target) => {
			if (
				!replaced &&
				method === "PUT" &&
				endpoint === "/upload" &&
				target === path
			) {
				replaced = true;
				disk.files.set(path, foreign);
			}
		};
		const result = await a.engine.forceSyncFromLocal({
			forcePreflightProof: proof,
		});
		assert.equal(result.success, false);
		assert.deepEqual(disk.files.get(path), foreign);
		assert.equal(a.index.getObservedEpoch(), null);
		assert.equal(
			[...disk.files.keys()].some((name) => name.includes(".lock.")),
			false,
		);
	} finally {
		disk.afterRequest = undefined;
		await a.stop();
	}
});

test("Force UI preflight after restart does not attempt normal orphan recovery", async () => {
	const disk = new MemoryDisk();
	const a = device(disk, "device-a", null);
	try {
		const raw = bytes(JSON.stringify(createEmptyIndex("")));
		for (const id of ["old-a", "old-b"]) {
			disk.files.set(
				`vault/.obsidian-sync-index.lock.${id}.attempt`,
				raw.slice(0),
			);
		}
		const before = await captureRemoteRawSnapshot(a.client, "vault");
		const plugin = forceUi(a);
		const prepared = await plugin.prepareForceSync("from_local");
		assert.equal(prepared?.canonical.state, "absent");
		assert.equal(
			(await captureRemoteRawSnapshot(a.client, "vault")).digest,
			before.digest,
		);
		confirmForceReplacementPlan(prepared.replacement.plan);
		const result = await a.engine.forceSyncFromLocal({
			forceReplacement: prepared.replacement,
		});
		assert.equal(result.success, true, JSON.stringify(result.errors));
		await a.assertSettled({});
	} finally {
		await a.stop();
	}
});

test("Force UI never reports success while a changed orphan survives its final full", async () => {
	const disk = new MemoryDisk();
	const a = device(disk, "device-a", null);
	const path = "vault/.obsidian-sync-index.lock.old.attempt";
	try {
		a.vault.put("Note.md", bytes("kept"));
		disk.files.set(path, bytes(JSON.stringify(createEmptyIndex(""))));
		const changed = bytes(
			JSON.stringify(createEmptyIndex("device-b", "foreign-epoch")),
		);
		disk.afterRequest = async (method, endpoint, target) => {
			if (
				method === "POST" &&
				endpoint.endsWith("/resources/move") &&
				target === "vault/.obsidian-sync-index.json"
			) {
				disk.files.set(path, changed);
			}
		};
		const controller = forceUi(a).getForceSyncController();
		await controller.run("from_local");
		assert.equal(controller.getState()?.outcome, "cleanup-pending");
		assert.deepEqual(disk.files.get(path), changed);
		assert.equal(a.index.getObservedEpoch(), null);
	} finally {
		disk.afterRequest = undefined;
		await a.stop();
	}
});

test("directional Force admission ignores destination maintenance without implicit recovery", async () => {
	const disk = new MemoryDisk();
	const a = device(disk, "device-a", null);
	try {
		const index = createEmptyIndex("device-b", "maintenance-epoch");
		index.revision = 2;
		index.maintenance = {
			id: "disable-transition",
			kind: "disable",
			phase: "cleanup",
			initiatedBy: "device-b",
			sourceRevision: 0,
			targetRevision: 1,
			source: {
				enabled: true,
				revision: 1,
				salt: "synthetic-salt",
				verifier: "synthetic-verifier",
			},
			target: {
				enabled: false,
				revision: null,
				salt: null,
				verifier: null,
			},
			cleanup: [],
		};
		const raw = bytes(JSON.stringify(index));
		disk.files.set("vault/.obsidian-sync-index.json", raw);
		const plugin = forceUi(a);
		plugin.settings.enableEncryption = true;
		plugin.settings.encryptionPassword = "synthetic-password";
		assert.ok(await plugin.prepareForceSync("from_local"));
		assert.deepEqual(
			disk.files.get("vault/.obsidian-sync-index.json"),
			raw,
		);
		await assert.rejects(
			a.index.captureForceCanonicalProof(),
			/maintenance/i,
		);
	} finally {
		await a.stop();
	}
});

test("failed first Force lock write restores a valid seed and a fresh Force converges", async () => {
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk();
		const a = device(disk, "device-a", await codecFor(encrypted));
		try {
			a.vault.put("Note.md", bytes("kept"));
			await a.full();
			const oldEpoch = a.index.getObservedEpoch();
			disk.files.clear();
			const proof = await forceProof(a, "from_local");
			let corrupted = false;
			disk.afterRequest = async (method, endpoint, path) => {
				if (
					!corrupted &&
					method === "PUT" &&
					endpoint === "/upload" &&
					path.includes(".obsidian-sync-index.lock.")
				) {
					corrupted = true;
					const content = new Uint8Array(
						disk.files.get(path)!.slice(0),
					);
					content[0] = (content[0] ?? 0) ^ 1;
					disk.files.set(path, content.buffer);
				}
			};
			const failed = await a.engine.forceSyncFromLocal({
				forcePreflightProof: proof,
			});
			assert.equal(failed.success, false);
			assert.equal(a.index.getObservedEpoch(), oldEpoch);
			disk.afterRequest = undefined;
			assert.equal(
				(await a.index.readCanonicalIndex()).deviceId,
				"device-a",
			);
			const retry = await a.engine.forceSyncFromLocal({
				forcePreflightProof: await forceProof(a, "from_local"),
			});
			assert.equal(retry.success, true, JSON.stringify(retry.errors));
			await a.assertSettled({ "Note.md": "kept" });
		} finally {
			disk.afterRequest = undefined;
			await a.stop();
		}
	}
});
