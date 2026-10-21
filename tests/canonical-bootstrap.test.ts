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

/** Keep plugin admission/controller wiring while replacing only presentation and host persistence. */
function forceUi(a: ReturnType<typeof device>) {
	return Object.assign(
		Object.create(YandexDiskSyncPlugin.prototype) as object,
		{
			settings: { ...a.settings, yandexTokenSecret: "synthetic" },
			indexManager: a.index,
			yandexClient: a.client,
			vaultAdapter: a.adapter,
			syncEngine: a.engine,
			fileWatcher: a.watcher,
			syncScheduler: { stop: () => {}, start: () => {} },
			storageBinding: { ensure: async () => true },
			remoteStateValidated: false,
			encryptionTransition: null,
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
		prepareForceSync(): Promise<{
			canonical: ForcePreflightProof["canonical"];
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
			await b.full();
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
		const prepared = await plugin.prepareForceSync();
		assert.equal(prepared?.canonical.state, "absent");
		assert.equal(
			(await captureRemoteRawSnapshot(a.client, "vault")).digest,
			before.digest,
		);
		const proof = await forceProof(a, "from_local");
		const result = await a.engine.forceSyncFromLocal({
			forcePreflightProof: { ...proof, canonical: prepared.canonical },
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
		assert.equal(
			a.index.getObservedEpoch(),
			a.index.getRemoteIndex().epoch,
		);
	} finally {
		disk.afterRequest = undefined;
		await a.stop();
	}
});

test("Force admission cannot start implicit encryption recovery or replace maintenance", async () => {
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
		Object.assign(plugin, {
			encryptionTransitionController: {
				createRemoteTargetRecoveryPlan: () => ({}),
			},
			recoverRemotePlaintextTargetTransition: async () => {},
		});
		assert.equal(await plugin.prepareForceSync(), null);
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
