import JSZip from "jszip";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BackupManager } from "../src/backup/backup-manager";
import { EncryptionManager } from "../src/crypto/encryption-manager";
import { EncryptionService } from "../src/crypto/encryption";
import {
	captureLogicalVaultSnapshot,
	captureRemoteRawSnapshot,
} from "../src/backup/backup-snapshot";
import { UnreadableRemoteIndexError } from "../src/sync/canonical/manager";
import { SyncEngine } from "../src/sync/engine";
import type { ForcePreflightProof } from "../src/sync/contracts";
import { computeSha256 } from "../src/utils/hash-utils";
import {
	MemoryDisk,
	bytes,
	codecFor,
	managedDevices,
	type device,
} from "./helpers/sync-flow";

/** Exercise scope and manifest-token admission without unrelated startup UI. */
function bindInitialReadGuards(phone: ReturnType<typeof device>): void {
	phone.engine.setSyncGuardCallback(async (token, observation) => {
		await phone.index.assertRemoteScope(observation);
		if (token !== undefined) {
			return {
				blockReason:
					(await phone.index.isEncryptionManifestTokenCurrent(
						token,
						observation,
					))
						? null
						: "synthetic manifest changed",
				validationToken: token,
			};
		}
		const manifest = await phone.index.downloadEncryptionManifestForGuard();
		return { blockReason: null, validationToken: manifest.validationToken };
	});
}

test("ordinary full reuses verified service bytes and avoids healthy repair reads across two devices", async (t) => {
	const device = managedDevices(t);
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk();
		const desktopCodec = await codecFor(encrypted);
		const desktop = device(disk, "desktop", desktopCodec);
		const phone = device(disk, "phone", await codecFor(encrypted));
		const expected: Record<string, string> = {};
		for (let n = 0; n < 42; n++) {
			const path = `note-${n}.md`;
			expected[path] = `original-${n}`;
			desktop.vault.put(path, bytes(expected[path]));
		}
		expected["kept/branch/note.md"] = "untouched";
		desktop.vault.put("kept/branch/note.md", bytes("untouched"));
		await desktop.full();
		await phone.full();
		if (desktopCodec) {
			const manifest = await new EncryptionManager().createManifest({
				service: desktopCodec,
				salt: EncryptionService.bytesToBase64(
					new Uint8Array(16).fill(12),
				),
				state: "enabled",
				revision: 1,
				deviceId: "desktop",
			});
			disk.files.set(
				"vault/.obsidian-encrypt.json",
				bytes(JSON.stringify(manifest)),
			);
		}
		// A pre-existing stamp gap must be refreshed even when it is not an upload.
		const pages = new Map<string, number>();
		await phone.index.getRemoteFiles(pages);
		const missing = ["note-0.md", "note-1.md", "kept/branch/note.md"];
		for (const path of missing) {
			delete phone.index.getRemoteIndex().files[path]!.remoteMtime;
		}
		const unchangedBytes = structuredClone([...disk.files]);
		const savedBeforeStamp = await phone.saved();
		const stampRequests: string[] = [];
		disk.beforeRequest = async (_method, endpoint, path) => {
			assert.equal(endpoint, "/v1/disk/resources");
			stampRequests.push(path);
		};
		const stamps = await phone.index.refreshMissingServerMetadata(
			new Map([["vault", pages.get("vault")!]]),
		);
		disk.beforeRequest = undefined;
		assert.equal(stamps.size, 3);
		assert.equal(phone.index.applyServerMtimes(stamps), true);
		assert.deepEqual(
			stampRequests.sort(),
			[
				"vault",
				await phone.client.getPhysicalPath("vault/kept/branch/note.md"),
			].sort(),
		);
		for (const path of missing) {
			assert.ok(
				Number.isFinite(
					phone.index.getRemoteIndex().files[path]!.remoteMtime,
				),
			);
		}
		assert.deepEqual([...disk.files], unchangedBytes);
		assert.deepEqual(await phone.saved(), savedBeforeStamp);
		bindInitialReadGuards(phone);
		for (const path of Object.keys(expected).filter((path) =>
			path.startsWith("note-"),
		)) {
			expected[path] = `edited:${path}`;
			phone.vault.put(path, bytes(expected[path]));
		}
		let canonicalBodies = 0;
		let manifestBodies = 0;
		let repairReads = 0;
		let unaffectedListings = 0;
		const unaffected =
			await phone.client.getPhysicalPath("vault/kept/branch");
		const readLocal = phone.vault.readBinary.bind(phone.vault);
		phone.vault.readBinary = async (file) => {
			if (phone.engine.getState().phase === "saving-index") {
				repairReads++;
			}
			return await readLocal(file);
		};
		disk.beforeRequest = async (_method, endpoint, path) => {
			if (endpoint === "/v1/disk/resources" && path === unaffected) {
				unaffectedListings++;
			}
			if (endpoint === "/download") {
				canonicalBodies += Number(
					path === "vault/.obsidian-sync-index.json",
				);
				manifestBodies += Number(
					path === "vault/.obsidian-encrypt.json",
				);
			}
		};
		assert.equal((await phone.full()).uploaded, 42);
		assert.equal(
			unaffectedListings,
			1,
			"Post-upload stamps must not recurse into unaffected branches",
		);
		disk.beforeRequest = undefined;
		await phone.assertSettled(expected);
		await desktop.full();
		await desktop.assertSettled(expected);
		assert.ok(canonicalBodies <= 2, `canonical bodies: ${canonicalBodies}`);
		assert.equal(manifestBodies, encrypted ? 1 : 0);
		assert.equal(
			repairReads,
			0,
			"Healthy accepted uploads need no local repair bytes",
		);
		assert.equal((await phone.full()).uploaded, 0);
		assert.equal((await phone.saved()).pendingMutations.length, 0);
	}
});

test("ordinary reception keeps canonical read-only but commits pending FIFO acknowledgements", async (t) => {
	const device = managedDevices(t);
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const desktop = device(disk, "desktop", codec);
		const phone = device(disk, "phone", await codecFor(encrypted));
		desktop.vault.put("note.md", bytes("original"));
		await desktop.full();
		await phone.full();
		if (codec) {
			const manifest = await new EncryptionManager().createManifest({
				service: codec,
				salt: EncryptionService.bytesToBase64(
					new Uint8Array(16).fill(12),
				),
				state: "enabled",
				revision: 1,
				deviceId: "desktop",
			});
			disk.files.set(
				"vault/.obsidian-encrypt.json",
				bytes(JSON.stringify(manifest)),
			);
		}
		bindInitialReadGuards(phone);
		desktop.vault.put("note.md", bytes("published successor"));
		await desktop.full();
		const canonical = await desktop.canonical();
		const remoteBytes = structuredClone([...disk.files]);
		let moves = 0;
		disk.beforeRequest = async (method, endpoint) => {
			moves += Number(
				method === "POST" && endpoint.endsWith("/resources/move"),
			);
		};
		const received = await phone.full();
		assert.equal(received.downloaded, 1);
		assert.equal(
			moves,
			0,
			"Reception of published bytes must not lock canonical",
		);
		assert.deepEqual([...disk.files], remoteBytes);
		assert.equal(
			phone.lastSaved().localState.observedRevision,
			canonical.revision,
		);
		assert.equal(
			phone.lastSaved().localState.files["note.md"]?.sha256,
			canonical.files["note.md"]?.sha256,
		);
		assert.deepEqual(phone.lastSaved().pendingMutations, []);
		await phone.assertSettled({ "note.md": "published successor" });

		const mutation = phone.index.enqueueMutation("put", "note.md", {
			sha256: canonical.files["note.md"]!.sha256,
			baselineSha256: canonical.files["note.md"]!.sha256,
		});
		await phone.saved();
		const acknowledged = await phone.full();
		assert.equal(acknowledged.uploaded, 0);
		assert.equal(acknowledged.downloaded, 0);
		assert.equal(
			moves,
			2,
			"A matching pending put still requires its FIFO watermark commit",
		);
		const committed = await phone.canonical();
		assert.equal(committed.appliedMutationSeq.phone, mutation.seq);
		assert.equal(committed.revision, canonical.revision + 1);
		assert.equal(
			committed.files["note.md"]?.sha256,
			canonical.files["note.md"]?.sha256,
		);
		assert.deepEqual(phone.lastSaved().pendingMutations, []);
		assert.equal(
			phone.lastSaved().localState.observedRevision,
			committed.revision,
		);
		disk.beforeRequest = undefined;
		await desktop.full();
		await desktop.assertSettled({ "note.md": "published successor" });
		await phone.assertSettled({ "note.md": "published successor" });
	}
});

test("published rename reception applies a durable local tombstone without canonical writes after restart", async (t) => {
	const makeDevice = managedDevices(t);
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const desktop = makeDevice(disk, "desktop", codec);
		let phone = makeDevice(disk, "phone", await codecFor(encrypted));
		desktop.vault.put("Old.md", bytes("original"));
		await desktop.full();
		await phone.full();
		const saved = await phone.saved();
		await phone.stop();
		desktop.vault.rename("Old.md", "New.md");
		desktop.vault.put("New.md", bytes("renamed and edited"));
		let targetReads = 0;
		const target = await desktop.client.getPhysicalPath("vault/New.md");
		disk.beforeRequest = async (_method, endpoint, path) => {
			if (endpoint === "/download" && path === target) {
				targetReads++;
			}
		};
		await desktop.engine.renameFile("Old.md", "New.md");
		assert.equal(
			targetReads,
			1,
			"Stable target proof is reused only under fresh matching hashes",
		);
		disk.beforeRequest = undefined;
		const remote = structuredClone([...disk.files]);
		phone = makeDevice(
			disk,
			"phone",
			await codecFor(encrypted),
			phone.vault,
			saved,
		);
		bindInitialReadGuards(phone);
		let writes = 0;
		disk.beforeRequest = async (method) => {
			writes += Number(method !== "GET");
		};
		const received = await phone.full();
		assert.deepEqual([received.downloaded, received.deleted], [1, 1]);
		assert.equal(
			writes,
			0,
			"Published tombstones require no canonical transaction",
		);
		assert.deepEqual([...disk.files], remote);
		await phone.assertSettled({ "New.md": "renamed and edited" });
		const noop = await phone.full();
		assert.deepEqual(
			[noop.uploaded, noop.downloaded, noop.deleted],
			[0, 0, 0],
		);
		assert.equal(writes, 0);
		disk.beforeRequest = undefined;
	}
});

test("rename cleanup preserves a physical source edited while canonical authority is in flight", async (t) => {
	const makeDevice = managedDevices(t);
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = makeDevice(disk, "desktop", codec);
		a.vault.put("Old.md", bytes("original"));
		await a.full();
		a.vault.rename("Old.md", "New.md");
		a.vault.put("New.md", bytes("renamed"));
		const source = await a.client.getPhysicalPath("vault/Old.md");
		const foreign = codec
			? await codec.encrypt(bytes("foreign physical edit"))
			: bytes("foreign physical edit");
		const read = a.index.readCanonicalIndex.bind(a.index);
		let moveReads = 0;
		a.index.readCanonicalIndex = async () => {
			const canonical = await read();
			if (
				a.index.hasPendingPhysicalAction("move-remote", "Old.md") &&
				++moveReads === 2
			) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				disk.files.set(source, foreign);
			}
			return canonical;
		};
		await a.engine.renameFile("Old.md", "New.md").catch(() => undefined);
		assert.ok(moveReads >= 2);
		assert.ok(
			disk.files.has(source),
			"A delayed authority read cannot authorize deletion of later physical bytes",
		);
		assert.deepEqual(
			await a.client.downloadFile("vault/Old.md"),
			bytes("foreign physical edit"),
		);
		a.assertLocal("New.md", "renamed");
		assert.equal(
			a.index.hasPendingPhysicalAction("move-remote", "Old.md"),
			true,
		);
	}
});

test("stable logical verification rejects bytes that do not match the physical ciphertext hash", async (t) => {
	const makeDevice = managedDevices(t);
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = makeDevice(disk, "a", codec);
		a.vault.put("Note.md", bytes("foreign"));
		await a.full();
		const path = await a.client.getPhysicalPath("vault/Note.md");
		const original = disk.files.get(path)!;
		const transient = codec
			? await codec.encrypt(bytes("expected"))
			: bytes("expected");
		disk.beforeRequest = async (_method, endpoint, target) => {
			if (endpoint === "/download" && target === path) {
				disk.files.set(path, transient);
			}
		};
		disk.afterRequest = async (_method, endpoint, target) => {
			if (endpoint === "/download" && target === path) {
				disk.files.set(path, original);
			}
		};
		await assert.rejects(
			a.client.downloadStableLogicalFile("vault/Note.md"),
			/content hash/,
		);
		disk.beforeRequest = undefined;
		disk.afterRequest = undefined;
		assert.deepEqual(
			await a.client.downloadFile("vault/Note.md"),
			bytes("foreign"),
		);
	}
});

test("published local tombstones retain protection and durable recovery after save or backup failure", async (t) => {
	const makeDevice = managedDevices(t);
	for (const encrypted of [false, true]) {
		for (const failure of ["save", "backup"] as const) {
			const disk = new MemoryDisk();
			const desktop = makeDevice(
				disk,
				"desktop",
				await codecFor(encrypted),
			);
			let phone = makeDevice(disk, "phone", await codecFor(encrypted));
			desktop.vault.put("Old.md", bytes("original"));
			await desktop.full();
			await phone.full();
			const observed = phone.index.getObservedRevision();
			desktop.vault.rename("Old.md", "New.md");
			desktop.vault.put("New.md", bytes("published"));
			await desktop.engine.renameFile("Old.md", "New.md");
			const remote = structuredClone([...disk.files]);
			if (failure === "save") {
				phone.engine.setIndexSaveCallback(async () => {
					await phone.saved();
					if (
						phone.index.hasPendingPhysicalAction(
							"delete-local",
							"Old.md",
						)
					) {
						throw new Error("Synthetic durable save failure");
					}
				});
			} else {
				phone.vault.put("Old.md", bytes("offline edit"));
				phone.adapter.backupOverwrittenFile = async () => {
					throw new Error("Synthetic mandatory backup failure");
				};
			}
			assert.equal(
				(await phone.engine.fullSync()).success,
				false,
				failure,
			);
			phone.assertLocal(
				"Old.md",
				failure === "save" ? "original" : "offline edit",
			);
			assert.equal(phone.index.getObservedRevision(), observed);
			const saved = await phone.saved();
			assert.ok(
				saved.pendingPhysicalActions.some(
					(action) =>
						action.type === "delete-local" &&
						action.path === "Old.md",
				),
			);
			assert.deepEqual([...disk.files], remote);
			await phone.stop();
			phone = makeDevice(
				disk,
				"phone",
				await codecFor(encrypted),
				phone.vault,
				saved,
			);
			await phone.full();
			await phone.assertSettled({ "New.md": "published" });
			assert.deepEqual([...disk.files], remote);
		}
	}
});

test("unchanged realtime notifications preserve FIFO and retain a genuinely later edit", async (t) => {
	const makeDevice = managedDevices(t);
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk();
		const a = makeDevice(disk, "desktop", await codecFor(encrypted));
		a.vault.put("Old.md", bytes("old"));
		await a.full();
		a.vault.rename("Old.md", "New.md");
		a.vault.put("New.md", bytes("renamed"));
		await a.engine.renameFile("Old.md", "New.md");
		const before = await a.canonical();
		const sequence = a.index.getLocalIndexData().nextMutationSeq;
		let writes = 0;
		disk.beforeRequest = async (method) => {
			writes += Number(method !== "GET");
		};
		a.start();
		a.vault.put("New.md", bytes("renamed"));
		await a.drain();
		assert.equal(
			writes,
			0,
			"A confirmed snapshot needs no put or canonical write",
		);
		assert.equal(a.index.getLocalIndexData().nextMutationSeq, sequence);
		assert.deepEqual(await a.canonical(), before);
		assert.deepEqual(a.watcher.getDeferredEvents(), []);
		disk.beforeRequest = undefined;
		const b = makeDevice(disk, "foreign", await codecFor(encrypted));
		await b.full();
		b.vault.put("New.md", bytes("foreign intermediate edit"));
		await b.full();
		b.vault.put("New.md", bytes("renamed"));
		await b.full();
		let unchangedReceipt = false;
		const batch = a.engine.syncFileBatch.bind(a.engine);
		a.engine.syncFileBatch = async (...args) => {
			const result = await batch(...args);
			unchangedReceipt ||= result.uploadReceipts.some(
				(receipt) => receipt.status === "confirmed-unchanged",
			);
			return result;
		};
		a.vault.put("New.md", bytes("renamed"));
		await a.drain();
		assert.equal(a.index.getLocalIndexData().nextMutationSeq, sequence + 1);
		assert.equal(
			unchangedReceipt,
			false,
			"Same SHA does not erase a foreign causal successor",
		);
		const physical = await a.client.getPhysicalPath("vault/New.md");
		let lateEdit = false;
		disk.beforeRequest = async (_method, endpoint, path) => {
			if (
				!lateEdit &&
				endpoint.endsWith("/resources") &&
				path === physical
			) {
				lateEdit = true;
				a.vault.put("New.md", bytes("real successor"));
			}
		};
		a.vault.put("New.md", bytes("renamed"));
		await a.drain();
		await a.drain();
		assert.equal(lateEdit, true);
		disk.beforeRequest = undefined;
		await a.full();
		await a.assertSettled({ "New.md": "real successor" });
	}
});

test("startup services overlap raw reads without accepting encrypted canonical before authentication", async (t) => {
	const makeDevice = managedDevices(t);
	const disk = new MemoryDisk();
	const codec = (await codecFor(true))!;
	const a = makeDevice(disk, "a", codec);
	a.vault.put("Note.md", bytes("encrypted"));
	await a.full();
	const manifest = await new EncryptionManager().createManifest({
		service: codec,
		salt: EncryptionService.bytesToBase64(new Uint8Array(16).fill(12)),
		state: "enabled",
		revision: 1,
		deviceId: "a",
	});
	disk.files.set(
		"vault/.obsidian-encrypt.json",
		bytes(JSON.stringify(manifest)),
	);
	const b = makeDevice(disk, "b", null);
	let started = 0;
	let expired = false;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const timeout = setTimeout(() => {
		expired = true;
		release();
	}, 1000);
	disk.beforeRequest = async (_method, endpoint, path) => {
		if (
			endpoint === "/download" &&
			(path.endsWith(".obsidian-sync-index.json") ||
				path.endsWith(".obsidian-encrypt.json"))
		) {
			started++;
			if (started === 2) {
				release();
			}
			await gate;
		}
	};
	const session = b.index.createStartupReadSession();
	try {
		const read = await session.inspectServices();
		assert.equal(started, 2);
		assert.equal(
			expired,
			false,
			"Both bodies start before either completes",
		);
		assert.equal(read.manifest?.format, "encryption-manifest");
		assert.equal(b.index.getRemoteIndex().revision, 0);
		const canonical = await session.readWithCodecIfPresent(codec);
		assert.ok(canonical?.files["Note.md"]?.sha256);
		assert.equal(Boolean(canonical?.files["Note.md"]?.deleted), false);
		assert.equal(
			started,
			2,
			"Authenticated decoding reuses private pinned raw bytes",
		);
	} finally {
		clearTimeout(timeout);
		release();
		session.close();
		disk.beforeRequest = undefined;
	}
});

test("ordinary full overlaps local and remote scans before analysis", async (t) => {
	const makeDevice = managedDevices(t);
	const disk = new MemoryDisk();
	const a = makeDevice(disk, "a", null);
	a.vault.put("Note.md", bytes("unchanged"));
	await a.full();
	const original = a.index.buildLocalIndex.bind(a.index);
	let scanning = false;
	let overlapped = false;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const timeout = setTimeout(release, 250);
	a.index.buildLocalIndex = async () => {
		scanning = true;
		await gate;
		const files = await original();
		scanning = false;
		return files;
	};
	const remote = a.index.getRemoteFiles.bind(a.index);
	a.index.getRemoteFiles = async (...args) => {
		overlapped = scanning;
		release();
		return await remote(...args);
	};
	const result = await a.full();
	clearTimeout(timeout);
	assert.equal(overlapped, true);
	assert.deepEqual(
		[result.uploaded, result.downloaded, result.deleted],
		[0, 0, 0],
	);
	await a.assertSettled({ "Note.md": "unchanged" });
});

test("ordinary reception preserves partial baselines on final drift and rejects failed saves across restart", async (t) => {
	const device = managedDevices(t);
	for (const encrypted of [false, true]) {
		for (const failure of [
			"canonical",
			"save",
			"manifest",
			"connection",
		] as const) {
			const disk = new MemoryDisk();
			const codec = await codecFor(encrypted);
			const desktop = device(disk, "desktop", codec);
			let phone = device(disk, "phone", await codecFor(encrypted));
			desktop.vault.put("note.md", bytes("original"));
			await desktop.full();
			await phone.full();
			if (codec) {
				const manifest = await new EncryptionManager().createManifest({
					service: codec,
					salt: EncryptionService.bytesToBase64(
						new Uint8Array(16).fill(12),
					),
					state: "enabled",
					revision: 1,
					deviceId: "desktop",
				});
				disk.files.set(
					"vault/.obsidian-encrypt.json",
					bytes(JSON.stringify(manifest)),
				);
			}
			bindInitialReadGuards(phone);
			const manifestBytes = disk.files.get(
				"vault/.obsidian-encrypt.json",
			);
			const before = phone.lastSaved();
			desktop.vault.put("note.md", bytes("published successor"));
			await desktop.full();
			let injected = false;
			let moves = 0;
			disk.beforeRequest = async (method, endpoint) => {
				moves += Number(
					method === "POST" && endpoint.endsWith("/resources/move"),
				);
				if (
					!injected &&
					failure !== "save" &&
					phone.engine.getState().phase === "saving-index"
				) {
					injected = true;
					if (failure === "canonical") {
						desktop.vault.put("note.md", bytes("later successor"));
						await desktop.full();
					} else if (failure === "manifest") {
						disk.files.set(
							"vault/.obsidian-encrypt.json",
							bytes("{}"),
						);
					} else {
						phone.client.setToken("other-synthetic");
						phone.client.setToken("synthetic");
					}
				}
			};
			if (failure === "save") {
				phone.engine.setIndexSaveCallback(async () => {
					if (phone.engine.getState().phase === "saving-index") {
						injected = true;
						throw new Error("synthetic baseline save failure");
					}
				});
			}
			const failed = await phone.engine.fullSync();
			assert.equal(injected, true);
			assert.equal(failed.success, false);
			assert.equal(failed.downloaded, 1);
			phone.assertLocal("note.md", "published successor");
			assert.equal(
				phone.index.getObservedRevision(),
				before.localState.observedRevision,
			);
			assert.equal(
				phone.index.getLocalIndex().lastSyncTime,
				before.localState.lastSyncTime,
			);
			const saved = phone.lastSaved();
			assert.equal(
				saved.localState.observedRevision,
				before.localState.observedRevision,
			);
			assert.equal(
				saved.localState.lastSyncTime,
				before.localState.lastSyncTime,
			);
			assert.deepEqual(saved.pendingMutations, before.pendingMutations);
			assert.deepEqual(
				saved.pendingPhysicalActions,
				before.pendingPhysicalActions,
			);
			assert.deepEqual(
				saved.pendingWatcherEvents,
				before.pendingWatcherEvents,
			);
			if (failure !== "save") {
				assert.equal(
					saved.localState.files["note.md"]?.sha256,
					await computeSha256(bytes("published successor")),
					"Durable partial baseline must prevent a false conflict after drift/restart",
				);
				assert.equal(
					moves,
					failure === "canonical" ? 2 : 0,
					"Only the independent desktop successor may commit",
				);
			} else {
				assert.equal(moves, 0);
			}
			disk.beforeRequest = undefined;
			if (manifestBytes) {
				disk.files.set("vault/.obsidian-encrypt.json", manifestBytes);
			} else {
				disk.files.delete("vault/.obsidian-encrypt.json");
			}
			phone = device(
				disk,
				"phone",
				await codecFor(encrypted),
				phone.vault,
				saved,
			);
			const recovered = await phone.full();
			assert.equal(recovered.conflicts, 0);
			const expected = {
				"note.md":
					failure === "canonical"
						? "later successor"
						: "published successor",
			};
			await phone.assertSettled(expected);
			await desktop.full();
			await desktop.assertSettled(expected);
		}
	}
});

test("initial receive reuses canonical bytes when all 42 local files already match", async (t) => {
	const device = managedDevices(t);
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const desktop = device(disk, "desktop", codec);
		for (let n = 0; n < 42; n++) {
			desktop.vault.put(`note-${n}.md`, bytes(`content-${n}`));
		}
		await desktop.full();
		const remote = structuredClone([...disk.files]);
		for (const limit of [1, 20, 40]) {
			const phone = device(disk, `phone-${limit}`, codec);
			phone.settings.maxConcurrency = limit;
			const physicalPaths = new Set<string>();
			for (const [path, content] of desktop.vault.files) {
				phone.vault.put(path, content.slice(0));
				physicalPaths.add(
					await phone.client.getPhysicalPath(`vault/${path}`),
				);
			}
			phone.index.getLocalIndex().remoteScope = {
				remotePath: "vault",
				rootResourceId: `${disk.identity}:vault`,
			};
			bindInitialReadGuards(phone);
			let canonicalDownloads = 0;
			let active = 0;
			let peak = 0;
			disk.beforeRequest = async (method, endpoint, path) => {
				assert.equal(
					method,
					"GET",
					"Matching files cannot cause a remote write",
				);
				if (
					endpoint === "/v1/disk/resources" &&
					physicalPaths.has(path)
				) {
					active++;
					peak = Math.max(peak, active);
					await new Promise((resolve) => setTimeout(resolve, 2));
				}
				if (endpoint !== "/download") {
					return;
				}
				assert.equal(
					path,
					"vault/.obsidian-sync-index.json",
					"Matching user bytes cannot be downloaded",
				);
				canonicalDownloads++;
				if (canonicalDownloads > 2) {
					throw new Error(
						"Repeated canonical transfer is unavailable",
					);
				}
			};
			disk.afterRequest = async (_method, endpoint, path) => {
				if (
					endpoint === "/v1/disk/resources" &&
					physicalPaths.has(path)
				) {
					active--;
				}
			};
			const before = phone.client.getApiReadMetrics();
			const result = await phone.engine.fullSync();
			const after = phone.client.getApiReadMetrics();
			const reads = Object.fromEntries(
				Object.entries(after).map(([key, count]) => [
					key,
					count - before[key as keyof typeof before],
				]),
			);
			assert.equal(result.success, true, result.errors[0]?.message);
			assert.equal(result.downloaded, 0);
			assert.ok(
				reads.root! <= 30,
				`Root reads must be bounded per receive, got ${reads.root}`,
			);
			assert.ok(
				reads.manifest! <= 6,
				`Manifest reads must be bounded per receive, got ${reads.manifest}`,
			);
			assert.ok(
				Object.values(reads).reduce((sum, count) => sum + count, 0) <=
					85,
			);
			assert.equal(active, 0);
			assert.equal(
				peak,
				0,
				"Fresh root observations replace individual file metadata GETs",
			);
			assert.ok(canonicalDownloads <= 2);
			assert.equal(phone.index.getObservedRevision(), 1);
			assert.equal(
				Object.keys(phone.index.getLocalIndex().files).length,
				42,
			);
			assert.deepEqual([...disk.files], remote);
			for (let n = 0; n < 42; n++) {
				phone.assertLocal(`note-${n}.md`, `content-${n}`);
			}
			assert.deepEqual(phone.index.getPendingMutations(), []);
			assert.deepEqual(phone.index.getPendingPhysicalActions(), []);
			disk.beforeRequest = undefined;
			disk.afterRequest = undefined;
		}
	}
});

test("initial fingerprint fallback finishes within its original budget before later metadata", async (t) => {
	const device = managedDevices(t);
	const disk = new MemoryDisk();
	const desktop = device(disk, "desktop", null);
	const phone = device(disk, "phone", null);
	phone.settings.maxConcurrency = 1;
	for (const path of ["folder/a.md", "folder/b.md"]) {
		desktop.vault.put(path, bytes("kept"));
		phone.vault.put(path, bytes("kept"));
	}
	await desktop.full();
	const canonical = await desktop.canonical();
	canonical.files = {
		"folder/a.md": canonical.files["folder/a.md"]!,
		"folder/b.md": canonical.files["folder/b.md"]!,
	};
	canonical.files["folder/a.md"]!.remoteFingerprint = "stale-metadata";
	disk.files.set(
		"vault/.obsidian-sync-index.json",
		bytes(JSON.stringify(canonical)),
	);
	bindInitialReadGuards(phone);
	let metadataBudget: Parameters<typeof phone.client.getLogicalResource>[1];
	const read = phone.client.getLogicalResource.bind(phone.client);
	phone.client.getLogicalResource = async (path, budget) => {
		if (path === "vault/folder/a.md" && budget) {
			budget.deadline = Math.min(budget.deadline, Date.now() + 100);
			metadataBudget ??= budget;
		}
		return read(path, budget);
	};
	let fallbackChecked = false;
	const download = phone.client.downloadStableLogicalFile.bind(phone.client);
	phone.client.downloadStableLogicalFile = async (path, resource, budget) => {
		if (path === "vault/folder/a.md" && !fallbackChecked) {
			fallbackChecked = true;
			assert.equal(
				budget,
				metadataBudget,
				"Fallback must keep the original metadata deadline",
			);
			assert.ok(
				budget && Date.now() < budget.deadline,
				"Fallback starts before later metadata can exhaust its budget",
			);
		}
		return await download(path, resource, budget);
	};
	const originalNow = Date.now;
	let now = originalNow();
	Date.now = () => now;
	disk.beforeRequest = async (_method, endpoint, path) => {
		if (endpoint === "/v1/disk/resources" && path === "vault/folder/b.md") {
			now += 150;
		}
	};
	try {
		const result = await phone.engine.fullSync();
		assert.equal(result.success, true, result.errors[0]?.message);
		assert.equal(result.downloaded, 1);
		assert.equal(fallbackChecked, true);
		phone.assertLocal("folder/a.md", "kept");
		phone.assertLocal("folder/b.md", "kept");
		assert.ok(phone.index.getObservedRevision() > 0);
		assert.deepEqual(phone.index.getPendingPhysicalActions(), []);
	} finally {
		Date.now = originalNow;
		disk.beforeRequest = undefined;
	}
});

test("initial matching batch rejects drift and failed observations without acknowledging success across restart", async (t) => {
	const device = managedDevices(t);
	for (const encrypted of [false, true]) {
		const codec = await codecFor(encrypted);
		for (const failure of [
			"pause",
			"canonical",
			"manifest",
			"root",
			"lock",
			"connection",
			"local-edit",
			"physical",
			"save",
			"timeout",
		] as const) {
			const disk = new MemoryDisk();
			const desktop = device(disk, "desktop", codec);
			const phone = device(disk, "phone", codec, undefined, undefined, {
				readTimeoutMs: 1000,
			});
			for (const path of ["a.md", "b.md", "c.md"]) {
				desktop.vault.put(path, bytes("kept"));
				phone.vault.put(path, bytes("kept"));
			}
			phone.vault.put("local-only.md", bytes("local"));
			const stopBatch = failure === "pause" || failure === "connection";
			if (stopBatch) {
				phone.settings.maxConcurrency = 1;
			}
			await desktop.full();
			const canonical = await desktop.canonical();
			if (stopBatch) {
				// Parallel uploads do not promise a.md is the first canonical entry.
				canonical.files = Object.fromEntries(
					["c.md", "b.md", "a.md"].map((path) => [
						path,
						canonical.files[path]!,
					]),
				);
				const raw = bytes(JSON.stringify(canonical));
				disk.files.set(
					"vault/.obsidian-sync-index.json",
					codec ? await codec.encrypt(raw) : raw,
				);
			}
			phone.index.getLocalIndex().remoteScope = {
				remotePath: "vault",
				rootResourceId: `${disk.identity}:vault`,
			};
			bindInitialReadGuards(phone);
			let observingInitialMetadata = false;
			const buildLocal = phone.index.buildLocalIndex.bind(phone.index);
			phone.index.buildLocalIndex = async () => {
				const result = await buildLocal();
				observingInitialMetadata = true;
				return result;
			};
			const original = structuredClone([...disk.files]);
			const physical = await phone.client.getPhysicalPath("vault/a.md");

			const resource = disk.resource.bind(disk);
			let changed = false;
			let finishObservation!: () => void;
			const observationFinished = new Promise<void>((resolve) => {
				finishObservation = resolve;
			});
			let userMetadataReads = 0;
			let userMetadataReadsAtStop = 0;
			let userMetadataReadsAfterStop = 0;
			let firstUserMetadataPath: string | undefined;
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			disk.resource = async (path) => {
				const meta = await resource(path);
				return failure === "root" && changed && path === "vault"
					? { ...meta, resource_id: "replaced-root" }
					: meta;
			};
			if (failure === "save") {
				phone.engine.setIndexSaveCallback(async () => {
					if (
						Object.keys(phone.index.getLocalIndex().files).length >
						0
					) {
						throw new Error("synthetic batch save failed");
					}
				});
			}
			disk.beforeRequest = async (method, endpoint, path) => {
				if (
					observingInitialMetadata &&
					endpoint === "/v1/disk/resources" &&
					path === "vault"
				) {
					userMetadataReads++;
					firstUserMetadataPath ??= path;
					if (stopBatch && changed) {
						userMetadataReadsAfterStop++;
					}
				}
				assert.equal(
					method,
					"GET",
					"An incomplete initial batch cannot publish local-only files",
				);
				if (
					failure === "physical" &&
					endpoint === "/v1/disk/resources" &&
					observingInitialMetadata &&
					path === "vault" &&
					!changed
				) {
					changed = true;
					disk.files.set(
						physical,
						codec
							? await codec.encrypt(bytes("foreign"))
							: bytes("foreign"),
					);
				}
				if (
					failure === "timeout" &&
					endpoint === "/v1/disk/resources" &&
					observingInitialMetadata &&
					path === "vault"
				) {
					await gate;
				}
			};
			disk.afterRequest = async (_method, endpoint, path) => {
				if (
					changed ||
					endpoint !== "/v1/disk/resources" ||
					!observingInitialMetadata ||
					path !== firstUserMetadataPath
				) {
					return;
				}
				changed = true;
				if (stopBatch) {
					userMetadataReadsAtStop = userMetadataReads;
				}
				if (failure === "pause") {
					phone.engine.pause();
				}
				if (failure === "canonical") {
					canonical.epoch = crypto.randomUUID();
					const raw = bytes(JSON.stringify(canonical));
					disk.files.set(
						"vault/.obsidian-sync-index.json",
						codec ? await codec.encrypt(raw) : raw,
					);
				}
				if (failure === "manifest") {
					disk.files.set("vault/.obsidian-encrypt.json", bytes("{}"));
				}
				if (failure === "lock") {
					for (const id of ["a", "b"]) {
						disk.files.set(
							`vault/.obsidian-sync-index.lock.${id}.1`,
							original.find(
								([path]) =>
									path === "vault/.obsidian-sync-index.json",
							)![1],
						);
					}
				}
				if (failure === "connection") {
					phone.client.setToken("other-synthetic");
					phone.client.setToken("synthetic");
				}
				if (failure === "local-edit") {
					phone.vault.put("a.md", bytes("late edit"));
				}
				finishObservation();
			};
			const result = await phone.engine.fullSync().finally(release);
			if (failure === "timeout") {
				await observationFinished;
			}
			assert.equal(
				changed,
				true,
				`Initial injection did not settle: ${encrypted}/${failure}`,
			);
			if (stopBatch) {
				assert.deepEqual(
					Object.keys(phone.index.getRemoteIndex().files),
					["c.md", "b.md", "a.md"],
				);
				assert.equal(userMetadataReadsAtStop, 1);
				assert.equal(userMetadataReadsAfterStop, 0);
				assert.equal(
					userMetadataReads,
					1,
					`A stopped batch cannot start queued metadata reads: ${encrypted}/${failure}`,
				);
			}
			assert.equal(result.success, false, `${encrypted}/${failure}`);
			const saved = await phone.saved();
			assert.equal(saved.localState.observedRevision, 0, failure);
			assert.equal(saved.localState.lastSyncTime, 0, failure);
			assert.deepEqual(saved.pendingMutations, []);
			assert.deepEqual(saved.pendingPhysicalActions, []);
			phone.assertLocal(
				"a.md",
				failure === "local-edit" ? "late edit" : "kept",
			);
			phone.assertLocal("b.md", "kept");
			phone.assertLocal("c.md", "kept");
			phone.assertLocal("local-only.md", "local");
			assert.ok(!disk.files.has("vault/local-only.md"));
			if (failure === "save" || stopBatch) {
				assert.deepEqual(saved.localState.files, {});
			}
			disk.beforeRequest = undefined;
			disk.afterRequest = undefined;
			disk.resource = resource;
			disk.files = new Map(original);
			await phone.stop();
			const restarted = device(
				disk,
				"phone",
				codec,
				phone.vault,
				JSON.parse(JSON.stringify(saved)) as typeof saved,
			);
			bindInitialReadGuards(restarted);
			await restarted.full();
			assert.ok(restarted.index.getObservedRevision() > 0);
			for (const path of ["a.md", "b.md", "c.md"]) {
				restarted.assertLocal(path, "kept");
			}
			restarted.assertLocal("local-only.md", "local");
		}
	}
});

test("canonical read sessions revalidate hashes and locks without sharing mutable or cross-session state", async (t) => {
	const device = managedDevices(t);
	for (const encrypted of [false, true]) {
		const codec = await codecFor(encrypted);
		for (const hash of ["sha256", "md5", "none"] as const) {
			const disk = new MemoryDisk();
			const desktop = device(disk, "desktop", codec);
			const phone = device(disk, "phone", codec);
			desktop.vault.put("note.md", bytes("original"));
			await desktop.full();
			const path = "vault/.obsidian-sync-index.json";
			const resource = disk.resource.bind(disk);
			disk.resource = async (name) => {
				const meta = await resource(name);
				if (meta && name === path && hash !== "sha256") {
					delete meta.sha256;
					if (hash === "md5") {
						meta.md5 = createHash("md5")
							.update(new Uint8Array(disk.files.get(path)!))
							.digest("hex");
					}
				}
				return meta;
			};
			let downloads = 0;
			disk.beforeRequest = async (_method, endpoint, name) => {
				if (endpoint === "/download" && name === path) {
					downloads++;
				}
			};
			let decryptions = 0;
			const decrypt = codec?.decrypt.bind(codec);
			if (codec) {
				codec.decrypt = async (content) => {
					decryptions++;
					return await decrypt!(content);
				};
			}
			const read = phone.index.createCanonicalReadSession();
			const canonical = await read.load(true);
			const originalSha = canonical.files["note.md"]!.sha256;
			canonical.files["note.md"]!.sha256 = "caller mutation";
			phone.index.getRemoteIndex().files["note.md"]!.sha256 =
				"desired mutation";
			assert.equal((await read()).files["note.md"]!.sha256, originalSha);
			assert.equal(downloads, hash === "none" ? 2 : 1);
			if (encrypted && hash === "sha256") {
				let validations = 0;
				let guardMetadata = 0;
				const observe = disk.beforeRequest;
				disk.beforeRequest = async (method, endpoint, name) => {
					await observe?.(method, endpoint, name);
					guardMetadata += Number(endpoint === "/v1/disk/resources");
				};
				const guarded = await Promise.all(
					Array.from({ length: 84 }, () =>
						read(async () => {
							validations++;
						}),
					),
				);
				assert.equal(validations, 84);
				assert.equal(
					guardMetadata,
					168,
					"each cached read still observes a fresh stable root pair",
				);
				disk.beforeRequest = observe;
				assert.ok(
					guarded.every(
						(index) =>
							index.files["note.md"]!.sha256 === originalSha,
					),
				);
				assert.equal(downloads, 1);
			}
			if (encrypted) {
				assert.equal(
					decryptions,
					hash === "none" ? 2 : 1,
					"unchanged decode context must reuse the parsed canonical after fresh guards",
				);
			}
			if (hash === "sha256") {
				const { validationToken } =
					await phone.index.downloadEncryptionManifestForGuard();
				let checked = false;
				let metadata = 0;
				let expired: Parameters<
					typeof phone.index.assertRemoteScope
				>[0];
				const observe = disk.beforeRequest;
				disk.beforeRequest = async (method, endpoint, path) => {
					await observe?.(method, endpoint, path);
					metadata += Number(endpoint === "/v1/disk/resources");
				};
				await read(async (observation) => {
					checked = true;
					expired = observation;
					await phone.index.assertRemoteScope(observation);
					assert.equal(
						await phone.index.isEncryptionManifestTokenCurrent(
							validationToken,
							observation,
						),
						true,
					);
				});
				assert.equal(
					checked,
					true,
					"Authority validators must run inside the fresh observation",
				);
				assert.equal(
					metadata,
					2,
					"One authority evaluation needs exactly one stable root pair",
				);
				await assert.rejects(
					phone.index.assertRemoteScope(expired),
					/observation/,
				);
				disk.beforeRequest = observe;
			}
			const concurrent = await Promise.all([read(), read()]);
			assert.ok(
				concurrent.every(
					(index) => index.files["note.md"]!.sha256 === originalSha,
				),
			);
			assert.equal(downloads, hash === "none" ? 4 : 1);
			assert.equal(
				phone.index.getRemoteIndex().files["note.md"]!.sha256,
				"desired mutation",
			);
			await phone.index.readCanonicalIndex();
			assert.equal(
				downloads,
				hash === "none" ? 5 : 2,
				"Independent reads must transfer their own snapshot",
			);
			if (codec && hash === "sha256") {
				const contexts = phone.index.createStartupReadSession();
				const before = decryptions;
				assert.equal(
					(await contexts()).files["note.md"]!.sha256,
					originalSha,
				);
				await contexts.readWithCodecIfPresent(codec);
				await contexts.readWithCodecIfPresent(codec);
				assert.equal(
					decryptions,
					before + 2,
					"active and explicit codec contexts authenticate independently, then reuse",
				);
				const other = (await codecFor(true))!;
				const decryptOther = other.decrypt.bind(other);
				let candidateDecryptions = 0;
				other.decrypt = async (content) => {
					candidateDecryptions++;
					return await decryptOther(content);
				};
				assert.equal(
					(await contexts.readWithCodecIfPresent(other))!.files[
						"note.md"
					]!.sha256,
					originalSha,
				);
				await contexts.readWithCodecIfPresent(other);
				assert.equal(
					candidateDecryptions,
					1,
					"a different valid candidate must authenticate the cached raw once",
				);
				await contexts();
				assert.equal(
					decryptions,
					before + 3,
					"returning to active context requires its own authentication",
				);
				contexts.close();
				const wrong = new EncryptionService(
					new Uint8Array(16).fill(12),
				);
				await wrong.initializeKey("different-password");
				for (const rejected of [null, wrong]) {
					const denied = phone.index.createStartupReadSession();
					await denied();
					await assert.rejects(
						denied.readWithCodecIfPresent(rejected),
						UnreadableRemoteIndexError,
					);
					await assert.rejects(
						denied(),
						"a rejected candidate must poison the session",
					);
					denied.close();
				}
			}
			const readResource = disk.resource.bind(disk);
			disk.resource = resource;
			desktop.vault.put("note.md", bytes("foreign update"));
			await desktop.full();
			disk.resource = readResource;
			assert.equal(
				(await read()).files["note.md"]!.sha256,
				await computeSha256(bytes("foreign update")),
			);
			assert.equal(phone.index.getObservedRevision(), 0);
			assert.deepEqual(phone.index.getPendingMutations(), []);
			const raw = disk.files.get(path)!.slice(0);
			for (const id of ["a", "b"]) {
				disk.files.set(`vault/.obsidian-sync-index.lock.${id}.1`, raw);
			}
			await assert.rejects(read(), /Multiple orphan index locks/);
			assert.deepEqual(disk.files.get(path), raw);
			desktop.assertLocal("note.md", "foreign update");
			disk.beforeRequest = undefined;
			if (codec) {
				codec.decrypt = decrypt!;
			}
		}
	}
});

test("canonical observations reject paginated root replacement and incomplete listings", async (t) => {
	const device = managedDevices(t);
	for (const failure of [
		"root",
		"incomplete",
		"unknown-root",
		"canonical",
		"manifest",
		"lock",
	] as const) {
		const disk = new MemoryDisk();
		const desktop = device(disk, "desktop", null);
		const phone = device(disk, "phone", null);
		desktop.vault.put("note.md", bytes("kept"));
		await desktop.full();
		for (let i = 0; i < 1001; i++) {
			disk.folders.add(`vault/folder-${i}`);
		}
		if (failure === "manifest" || failure === "lock") {
			disk.files.set(
				failure === "manifest"
					? "vault/.obsidian-encrypt.json"
					: "vault/.obsidian-sync-index.lock.reader.1",
				disk.files.get("vault/.obsidian-sync-index.json")!.slice(0),
			);
		}
		phone.index.getLocalIndex().remoteScope = {
			remotePath: "vault",
			rootResourceId: `${disk.identity}:vault`,
		};
		const remote = structuredClone([...disk.files]);
		const state = phone.index.captureLocalCausalState();
		const request = disk.request.bind(disk);
		let pages = 0;
		let passes = 0;
		disk.request = async (params, accepted) => {
			const response = await request(params, accepted);
			const url = new URL(params.url);
			if (
				url.pathname.endsWith("/resources") &&
				url.searchParams.get("path") === "vault"
			) {
				pages++;
				if (
					Number(url.searchParams.get("limit")) === 1000 &&
					Number(url.searchParams.get("offset")) === 0
				) {
					passes++;
					const name =
						failure === "canonical"
							? ".obsidian-sync-index.json"
							: failure === "manifest"
								? ".obsidian-encrypt.json"
								: failure === "lock"
									? ".obsidian-sync-index.lock.reader.1"
									: null;
					const items = (
						response.json._embedded as {
							items: Array<Record<string, unknown>>;
						}
					).items;
					const service = items.find((item) => item.name === name);
					if (service) {
						service.sha256 = `drift-${passes % 2}`;
					}
				}
				if (failure === "root" && pages > 1) {
					response.json.resource_id = "replaced-root";
				}
				if (failure === "unknown-root") {
					delete response.json.resource_id;
				}
				if (
					failure === "incomplete" &&
					Number(url.searchParams.get("offset")) > 0
				) {
					(response.json._embedded as { items: unknown[] }).items =
						[];
				}
			}
			return response;
		};
		const read = phone.index.createCanonicalReadSession();
		await assert.rejects(read.load(true), failure);
		await assert.rejects(
			read(),
			"Rejected observation must poison queued reads",
		);
		assert.deepEqual(phone.index.captureLocalCausalState(), state);
		assert.deepEqual([...disk.files], remote);
		assert.equal(phone.vault.files.has("note.md"), false);
		desktop.assertLocal("note.md", "kept");
	}
});

test("initial canonical timeout stops queued authority reads and recovers after restart", async (t) => {
	const device = managedDevices(t);
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const desktop = device(disk, "desktop", codec);
		const phone = device(disk, "phone", codec, undefined, undefined, {
			readTimeoutMs: 1000,
		});
		for (const path of ["a.md", "b.md", "c.md"]) {
			desktop.vault.put(path, bytes("kept"));
			phone.vault.put(path, bytes("kept"));
		}
		await desktop.full();
		const remote = structuredClone([...disk.files]);
		// Without a server hash the fresh initial guard must download again.
		const resource = disk.resource.bind(disk);
		disk.resource = async (path) => {
			const value = await resource(path);
			if (path === "vault/.obsidian-sync-index.json" && value) {
				delete value.sha256;
			}
			return value;
		};
		let downloads = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		disk.beforeRequest = async (_method, endpoint, path) => {
			if (
				endpoint === "/download" &&
				path === "vault/.obsidian-sync-index.json"
			) {
				downloads++;
				if (downloads === 2) {
					await gate;
				}
			}
		};
		const result = await phone.engine.fullSync().finally(() => release());
		assert.equal(result.success, false);
		assert.ok(result.errors.length > 0);
		assert.ok(
			result.errors.every(
				(error) => error.code === "remote-read-timeout",
			),
		);
		assert.equal(
			downloads,
			2,
			"Queued guards cannot retry an unresolved canonical read",
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		const saved = await phone.saved();
		assert.equal(saved.localState.observedRevision, 0);
		assert.equal(saved.localState.lastSyncTime, 0);
		assert.deepEqual(saved.localState.files, {});
		assert.deepEqual([...disk.files], remote);
		for (const path of ["a.md", "b.md", "c.md"]) {
			phone.assertLocal(path, "kept");
		}
		await phone.stop();
		disk.beforeRequest = undefined;
		const restarted = device(disk, "phone", codec, phone.vault, saved);
		assert.equal((await restarted.full()).downloaded, 0);
		assert.equal(restarted.index.getObservedRevision(), 1);
		assert.deepEqual([...disk.files], remote);
		assert.deepEqual(restarted.index.getPendingMutations(), []);
		assert.deepEqual(restarted.index.getPendingPhysicalActions(), []);
	}
});

test("canonical read sessions reject connection changes before and during cached observations", async (t) => {
	const device = managedDevices(t);
	for (const encrypted of [false, true]) {
		const codec = await codecFor(encrypted);
		const otherCodec = await codecFor(!encrypted);
		const disk = new MemoryDisk();
		const desktop = device(disk, "desktop", codec);
		const phone = device(disk, "phone", codec);
		desktop.vault.put("note.md", bytes("kept"));
		await desktop.full();
		const remote = structuredClone([...disk.files]);
		for (const kind of ["token", "path", "codec", "transition"] as const) {
			for (const boundary of [
				"before-read",
				"cached-read",
				"load-body",
			] as const) {
				const read = phone.index.createCanonicalReadSession();
				const priorDesired = structuredClone(
					phone.index.getRemoteIndex(),
				);
				if (boundary !== "load-body") {
					await read.load(true);
				}
				const change = () => {
					if (kind === "token") {
						phone.client.setToken("changed synthetic");
						phone.client.setToken("synthetic");
					} else if (kind === "path") {
						phone.client.setRemotePath("other");
						phone.client.setRemotePath("vault");
					} else if (kind === "transition") {
						phone.index.setIndexTransitionServices(
							codec,
							otherCodec,
						);
						phone.index.clearIndexTransitionServices();
					} else {
						phone.client.setEncryptionService(otherCodec);
						phone.client.setEncryptionService(codec);
					}
				};
				if (boundary !== "before-read") {
					disk.afterRequest = async (_method, endpoint) => {
						if (
							boundary === "load-body" &&
							endpoint !== "/download"
						) {
							return;
						}
						disk.afterRequest = undefined;
						change();
					};
				} else {
					change();
				}
				await assert.rejects(
					boundary === "load-body" ? read.load(true) : read(),
					/Canonical read configuration changed/,
				);
				await assert.rejects(
					read(),
					/Canonical read configuration changed/,
				);
				if (boundary === "load-body") {
					assert.deepEqual(
						phone.index.getRemoteIndex(),
						priorDesired,
					);
				}
				assert.equal(phone.index.getObservedRevision(), 0);
				assert.deepEqual([...disk.files], remote);
				disk.afterRequest = undefined;
			}
		}
	}
});

test("ordinary full rejects a late canonical load after pause or host stop without acknowledging state", async (t) => {
	const device = managedDevices(t);
	for (const encrypted of [false, true]) {
		for (const interruption of ["pause", "host-stop"] as const) {
			const disk = new MemoryDisk();
			const codec = await codecFor(encrypted);
			const desktop = device(disk, "desktop", codec);
			const phone = device(disk, "phone", await codecFor(encrypted));
			let stopped = false;
			const engine = new SyncEngine(
				phone.client,
				phone.adapter,
				phone.index,
				phone.settings,
				() => stopped,
			);
			desktop.vault.put("note.md", bytes("remote"));
			await desktop.full();
			phone.vault.put("note.md", bytes("local"));
			const remote = structuredClone([...disk.files]);
			const before = structuredClone(phone.index.getRemoteIndex());
			disk.afterRequest = async (_method, endpoint, path) => {
				if (
					endpoint === "/download" &&
					path === "vault/.obsidian-sync-index.json"
				) {
					disk.afterRequest = undefined;
					if (interruption === "pause") {
						engine.pause();
						engine.resume();
					} else {
						stopped = true;
					}
				}
			};
			const result = await engine.fullSync();
			assert.equal(result.success, false);
			assert.match(result.errors[0]!.message, /session interrupted/);
			assert.deepEqual(phone.index.getRemoteIndex(), before);
			assert.deepEqual([...disk.files], remote);
			phone.assertLocal("note.md", "local");
			const saved = await phone.saved();
			assert.equal(saved.localState.observedRevision, 0);
			assert.equal(saved.localState.lastSyncTime, 0);
			assert.deepEqual(saved.pendingMutations, []);
			assert.deepEqual(saved.pendingPhysicalActions, []);
		}
	}

	for (const encrypted of [false, true]) {
		for (const interruption of ["pause", "host-stop"] as const) {
			const disk = new MemoryDisk();
			const codec = await codecFor(encrypted);
			const phone = device(disk, "phone", codec);
			phone.vault.put("note.md", bytes("before"));
			await phone.full();
			if (codec) {
				const manifest = await new EncryptionManager().createManifest({
					service: codec,
					salt: EncryptionService.bytesToBase64(
						new Uint8Array(16).fill(12),
					),
					state: "enabled",
					revision: 1,
					deviceId: "phone",
				});
				disk.files.set(
					"vault/.obsidian-encrypt.json",
					bytes(JSON.stringify(manifest)),
				);
			}
			const before = await phone.saved();
			const remote = structuredClone([...disk.files]);
			phone.vault.put("note.md", bytes("after"));
			let stopped = false;
			const engine = new SyncEngine(
				phone.client,
				phone.adapter,
				phone.index,
				phone.settings,
				() => stopped,
			);
			engine.setIndexSaveCallback(async () => {
				await phone.saved();
			});
			bindInitialReadGuards({ ...phone, engine });
			let armed = false;
			let interrupted = false;
			let writesAfterStop = 0;
			disk.beforeRequest = async (method, endpoint, path) => {
				if (
					method === "GET" &&
					endpoint.endsWith("/resources/upload") &&
					!path.includes(".obsidian-sync-index")
				) {
					armed = true;
				}
				if (interrupted && ["PUT", "POST", "DELETE"].includes(method)) {
					writesAfterStop++;
				}
			};
			phone.client.setWriteGuard(async () => {
				await phone.index.assertRemoteScope();
				if (armed && !interrupted) {
					// Expire after the async authority callback resolves, before native dispatch.
					queueMicrotask(() =>
						queueMicrotask(() => {
							interrupted = true;
							if (interruption === "pause") {
								engine.pause();
								engine.resume();
							} else {
								stopped = true;
							}
						}),
					);
				}
			});
			const result = await engine.fullSync();
			assert.equal(interrupted, true);
			assert.equal(result.success, false);
			assert.equal(writesAfterStop, 0);
			assert.deepEqual([...disk.files], remote);
			phone.assertLocal("note.md", "after");
			const saved = await phone.saved();
			assert.equal(
				saved.localState.observedRevision,
				before.localState.observedRevision,
			);
			assert.equal(
				saved.localState.lastSyncTime,
				before.localState.lastSyncTime,
			);
			assert.equal(saved.pendingMutations.length, 1);
			assert.equal(saved.pendingMutations[0]!.type, "put");
			disk.beforeRequest = undefined;
			const restarted = device(
				disk,
				"phone",
				await codecFor(encrypted),
				phone.vault,
				saved,
			);
			await restarted.full();
			await restarted.assertSettled({ "note.md": "after" });

			const peer = device(disk, "peer", await codecFor(encrypted));
			await peer.full();
			peer.vault.put("note.md", bytes("successor"));
			await peer.full();
			const beforeFinalize = await restarted.saved();
			stopped = false;
			const finalEngine = new SyncEngine(
				restarted.client,
				restarted.adapter,
				restarted.index,
				restarted.settings,
				() => stopped,
			);
			finalEngine.setIndexSaveCallback(async () => {
				await restarted.saved();
			});
			bindInitialReadGuards({ ...restarted, engine: finalEngine });
			finalEngine.onSyncFinalize(async () => {
				if (interruption === "pause") {
					finalEngine.pause();
					finalEngine.resume();
				} else {
					stopped = true;
				}
			});
			const finalResult = await finalEngine.fullSync();
			assert.equal(finalResult.success, false);
			restarted.assertLocal("note.md", "successor");
			const afterFinalize = await restarted.saved();
			assert.equal(
				afterFinalize.localState.observedRevision,
				beforeFinalize.localState.observedRevision,
			);
			assert.equal(
				afterFinalize.localState.lastSyncTime,
				beforeFinalize.localState.lastSyncTime,
			);
			assert.deepEqual(afterFinalize.pendingMutations, []);
			assert.deepEqual(afterFinalize.pendingPhysicalActions, []);
			await restarted.full();
			await restarted.assertSettled({ "note.md": "successor" });
		}
	}
});

test("canonical reads reuse stable root metadata without weakening snapshot checks", async (t) => {
	const device = managedDevices(t);
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "device-a", codec);
		const b = device(
			disk,
			"device-b",
			encrypted ? null : await codecFor(true),
		);
		const path = "vault/.obsidian-sync-index.json";

		a.vault.put("__proto__", bytes("kept"));
		await a.full();
		const raw = disk.files.get(path)!.slice(0);
		let requests = 0;
		disk.beforeRequest = async (method) => {
			assert.equal(method, "GET");
			requests++;
		};
		const canonical = await a.index.readCanonicalIndex();
		assert.equal(
			canonical.files["__proto__"]?.sha256,
			await computeSha256(bytes("kept")),
		);
		assert.equal(requests, 5);
		requests = 0;
		assert.deepEqual(
			await b.index.readCanonicalIndexWithCodecIfPresent(codec),
			canonical,
		);
		assert.equal(requests, 5);
		assert.deepEqual(disk.files.get(path), raw);

		// Change raw bytes after download, before the final metadata observation.
		disk.afterRequest = async (_method, endpoint, resourcePath) => {
			if (endpoint === "/download" && resourcePath === path) {
				const changed = new Uint8Array(raw.slice(0));
				changed[0] = (changed[0] ?? 0) ^ 1;
				disk.files.set(path, changed.buffer);
			}
		};
		await assert.rejects(
			a.index.readCanonicalIndex(),
			/changed while being read/,
		);
		disk.afterRequest = undefined;
		disk.files.set(path, raw);
		assert.deepEqual(await a.index.readCanonicalIndex(), canonical);

		const locks = [
			"vault/.obsidian-sync-index.lock.a.1",
			"vault/.obsidian-sync-index.lock.b.2",
		];
		for (const lock of locks) {
			disk.files.set(lock, raw);
		}
		await assert.rejects(
			a.index.readCanonicalIndex(),
			/Multiple orphan index locks/,
		);
		for (const lock of locks) {
			disk.files.delete(lock);
		}
		disk.files.delete(path);
		assert.equal(
			await b.index.readCanonicalIndexWithCodecIfPresent(codec),
			null,
		);
		await assert.rejects(
			a.index.readCanonicalIndex(),
			/Canonical index is missing/,
		);
		assert.equal(disk.files.has(path), false);
		disk.files.set(path, raw);
		a.assertLocal("__proto__", "kept");
		assert.deepEqual(a.index.getPendingMutations(), []);
		assert.deepEqual(a.index.getPendingPhysicalActions(), []);
	}
});

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";
	test(`${mode} absent foreign tombstones stay read-only across restart`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "device-a", codec);
		let b = device(disk, "device-b", codec);
		const known = "Папка/известный #?&+.md";
		const unknown = "Папка/📝 %2F/__proto__.md";
		const expected = { "Keep.md": "keep" };

		a.vault.put("Keep.md", bytes("keep"));
		a.vault.put(known, bytes("known"));
		await a.full();
		await b.full();
		b.vault.remove(known);
		a.vault.put(unknown, bytes("unseen"));
		await a.full();
		a.vault.remove(known);
		a.vault.remove(unknown);
		await a.full();
		const committed = disk.files
			.get("vault/.obsidian-sync-index.json")!
			.slice(0);
		let writes = 0;
		disk.beforeRequest = async (method) => {
			if (method !== "GET") {
				writes++;
			}
		};
		for (let pass = 0; pass < 2; pass++) {
			const result = await b.full();
			assert.equal(result.deleted, 0);
			assert.equal(writes, 0);
			assert.deepEqual(
				disk.files.get("vault/.obsidian-sync-index.json"),
				committed,
			);
			assert.equal(b.index.getLocalIndex().files[known]?.deleted, true);
			assert.equal(b.index.getLocalIndex().files[unknown], undefined);
			await b.assertSettled(expected);
			const saved = await b.saved();
			await b.stop();
			b = device(disk, "device-b", codec, b.vault, saved);
		}

		// A scan read failure and an existing folder are not proof of absence.
		b.vault.put(unknown, bytes("unreadable local file"));
		const read = b.vault.readBinary.bind(b.vault);
		b.vault.readBinary = async (file) => {
			if (file.path === unknown) {
				throw new Error("synthetic local read failure");
			}
			return await read(file);
		};
		assert.equal((await b.engine.fullSync()).success, false);
		b.assertLocal(unknown, "unreadable local file");
		assert.equal(writes, 0);
		b.vault.readBinary = read;
		b.vault.remove(unknown);
		b.vault.folder(unknown);
		assert.equal((await b.engine.fullSync()).success, false);
		assert.equal(b.adapter.folderExists(unknown), true);
		assert.equal(writes, 0);
		b.vault.remove(unknown);

		// A failed local save cannot turn a read-only reconciliation into success.
		b.engine.setIndexSaveCallback(async () => {
			throw new Error("synthetic persistence failure");
		});
		assert.equal((await b.engine.fullSync()).success, false);
		assert.equal(writes, 0);
		const saved = await b.saved();
		await b.stop();
		b = device(disk, "device-b", codec, b.vault, saved);

		// The local scan is already finished when the physical tree is requested.
		const list = b.index.getRemoteFiles.bind(b.index);
		b.index.getRemoteFiles = async () => {
			const files = await list();
			b.vault.put(unknown, bytes("late create"));
			return files;
		};
		const late = await b.engine.fullSync();
		assert.equal(late.success, false);
		assert.equal(late.deleted, 0);
		b.assertLocal(unknown, "late create");
		assert.equal(writes, 0);
		assert.deepEqual(b.index.getPendingPhysicalActions(), []);
		b.index.getRemoteFiles = list;
		disk.beforeRequest = undefined;
		await b.full();
		await a.full();
		await b.assertSettled({ ...expected, [unknown]: "late create" });
		await a.assertSettled({ ...expected, [unknown]: "late create" });
	});
	test(
		`${mode} real transactions drain rapid note and folder operations`,
		{ timeout: 30_000 },
		async (t) => {
			const device = managedDevices(t);
			const disk = new MemoryDisk();
			const a = device(disk, "device-a", await codecFor(encrypted));

			a.vault.put("Без названия.md", bytes("initial"));
			await a.full();
			a.start();
			a.vault.put("Без названия.md", bytes("edited while renaming"));
			a.vault.rename("Без названия.md", "Новая.md");
			await a.drain();
			await a.assertSettled({ "Новая.md": "edited while renaming" });
			a.vault.folder("Папка/Вложенная");
			a.vault.rename("Новая.md", "Папка/Вложенная/Новая.md");
			a.vault.put("Папка/Копия.md", bytes("copy"));
			a.vault.put(
				"Папка/Вложенная/Без названия.md",
				bytes("nested copy"),
			);
			a.vault.rename(
				"Папка/Вложенная/Без названия.md",
				"Папка/Вложенная/Копия.md",
			);
			await a.drain();
			await a.assertSettled({
				"Папка/Вложенная/Новая.md": "edited while renaming",
				"Папка/Копия.md": "copy",
				"Папка/Вложенная/Копия.md": "nested copy",
			});
			a.vault.rename("Папка", "Промежуточная");
			a.vault.rename("Промежуточная", "Итог");
			a.vault.rename(
				"Итог/Вложенная/Копия.md",
				"Итог/Вложенная/Другое имя.md",
			);
			a.vault.put("Итог/Копия.md", bytes("latest edit"));
			await a.drain();
			await a.assertSettled({
				"Итог/Вложенная/Новая.md": "edited while renaming",
				"Итог/Копия.md": "latest edit",
				"Итог/Вложенная/Другое имя.md": "nested copy",
			});
			a.vault.remove("Итог/Вложенная");
			a.vault.put("Черновик.md", bytes("never synchronized"));
			a.vault.rename("Черновик.md", "Итог/Удалить.md");
			a.vault.remove("Итог/Удалить.md");
			await a.drain();
			await a.assertSettled({ "Итог/Копия.md": "latest edit" });
			a.vault.put("Draft/Deep/A.md", bytes("pending copy"));
			a.vault.put("Draft/B.md", bytes("second copy"));
			a.vault.rename("Draft", "Moved");
			a.vault.rename("Moved/Deep/A.md", "Moved/Deep/Final.md");
			await a.drain();
			await a.assertSettled({
				"Итог/Копия.md": "latest edit",
				"Moved/Deep/Final.md": "pending copy",
				"Moved/B.md": "second copy",
			});
			a.vault.remove("Moved");
			await a.drain();
			const uploadingPath = await a.client.getPhysicalPath(
				"vault/InFlight/Note.md",
			);
			a.vault.put("InFlight/Note.md", bytes("tracked before upload"));
			await a.drain();
			let release!: () => void, entered!: () => void;
			const requestStarted = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const continueRequest = new Promise<void>((resolve) => {
				release = resolve;
			});
			disk.beforeRequest = async (method, endpoint, path) => {
				if (
					method === "PUT" &&
					endpoint === "/upload" &&
					path === uploadingPath
				) {
					disk.beforeRequest = undefined;
					entered();
					await continueRequest;
				}
			};
			a.vault.put("InFlight/Note.md", bytes("upload snapshot"));
			const running = a.drain();
			await requestStarted;
			a.vault.rename("InFlight/Note.md", "InFlight/Renamed.md");
			a.vault.rename("InFlight", "AfterFlight");
			a.vault.put(
				"AfterFlight/Renamed.md",
				bytes("edited during upload"),
			);
			a.vault.put("AfterFlight/Copy.md", bytes("copied during upload"));
			release();
			await running;
			await a.drain();
			await a.assertSettled({
				"Итог/Копия.md": "latest edit",
				"AfterFlight/Renamed.md": "edited during upload",
				"AfterFlight/Copy.md": "copied during upload",
			});
			const movedPath = await a.client.getPhysicalPath(
				"vault/AfterFlight/Final.md",
			);
			let lostResponse = false;
			disk.afterRequest = async (method, endpoint, path) => {
				if (
					method === "POST" &&
					endpoint.endsWith("/resources/move") &&
					path === movedPath
				) {
					disk.afterRequest = undefined;
					lostResponse = true;
					throw new Error(
						"Synthetic lost response after physical move",
					);
				}
			};
			a.vault.rename("AfterFlight/Renamed.md", "AfterFlight/Final.md");
			await a.drain();
			assert.equal(lostResponse, true);
			await a.assertSettled({
				"Итог/Копия.md": "latest edit",
				"AfterFlight/Final.md": "edited during upload",
				"AfterFlight/Copy.md": "copied during upload",
			});
			a.vault.remove("AfterFlight");
			await a.drain();
			const folderUploadPath = await a.client.getPhysicalPath(
				"vault/PendingFolder/One.md",
			);
			const folderRequestStarted = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const continueFolderRequest = new Promise<void>((resolve) => {
				release = resolve;
			});
			disk.beforeRequest = async (method, endpoint, path) => {
				if (
					method === "PUT" &&
					endpoint === "/upload" &&
					path === folderUploadPath
				) {
					disk.beforeRequest = undefined;
					entered();
					await continueFolderRequest;
				}
			};
			a.vault.put("PendingFolder/One.md", bytes("one"));
			a.vault.put("PendingFolder/Two.md", bytes("two"));
			const folderRunning = a.drain();
			await folderRequestStarted;
			a.vault.rename("PendingFolder", "Step");
			a.vault.rename("Step", "Ready");
			a.vault.rename("Ready/One.md", "Ready/Final.md");
			a.vault.remove("Ready/Two.md");
			a.vault.put("Ready/Three.md", bytes("three"));
			release();
			await folderRunning;
			await a.drain();
			await a.assertSettled({
				"Итог/Копия.md": "latest edit",
				"Ready/Final.md": "one",
				"Ready/Three.md": "three",
			});
			a.vault.remove("Ready");
			await a.drain();
			const b = device(disk, "device-b", await codecFor(encrypted));

			await b.full();
			await b.assertSettled({ "Итог/Копия.md": "latest edit" });
			b.vault.put("Итог/Копия.md", bytes("offline B edit"));
			a.vault.put("Итог/Копия.md", bytes("online A edit"));
			await a.drain();
			await b.full();
			await a.full();
			await b.full();
			const expected: Record<string, string> = {};
			for (const file of b.adapter.getAllSyncableFiles()) {
				expected[file.path] = new TextDecoder().decode(
					await b.adapter.readFile(file.path),
				);
			}
			assert.deepEqual(
				new Set(Object.values(expected)),
				new Set(["offline B edit", "online A edit"]),
			);
			await a.assertSettled(expected);
			await b.assertSettled(expected);
			a.vault.put("Restored.md", bytes("before deletion"));
			await a.drain();
			await b.full();
			a.vault.remove("Restored.md");
			await a.drain();
			await b.full();
			assert.equal(b.vault.files.has("Restored.md"), false);
			b.vault.put("Restored.md", bytes("explicitly restored"));
			await b.full();
			await a.full();
			expected["Restored.md"] = "explicitly restored";
			await a.assertSettled(expected);
			await b.assertSettled(expected);
			const backup = new BackupManager(
				a.client,
				a.adapter,
				{
					...a.settings,
					encryptionPassword: encrypted
						? "synthetic-flow-password"
						: null,
				},
				"2.0.0",
			);
			const created = await a.engine.runExclusiveMaintenance(() =>
				backup.createBackup(),
			);
			assert.equal(created.success, true, created.error);
			const zip = await JSZip.loadAsync(
				await backup.downloadBackup(
					`vault/.backup/${created.backupName}`,
				),
			);
			for (const [path, text] of Object.entries(expected)) {
				assert.equal(await zip.file(path)!.async("string"), text);
			}
		},
	);
}

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";
	test(
		`${mode} real transactions recover a failed rename and its blocked copies after restart`,
		{ timeout: 30_000 },
		async (t) => {
			const device = managedDevices(t);
			for (const {
				failBeforeBody,
				targetText,
				foreignCommit = false,
				foreignPhysical = false,
			} of [
				{ failBeforeBody: false, targetText: "new" },
				{ failBeforeBody: true, targetText: "new" },
				{ failBeforeBody: false, targetText: "old" },
				{
					failBeforeBody: false,
					targetText: "new",
					foreignCommit: true,
				},
				{
					failBeforeBody: false,
					targetText: "new",
					foreignPhysical: true,
				},
			]) {
				const disk = new MemoryDisk(),
					codec = await codecFor(encrypted);
				let a = device(disk, "device-a", codec);

				a.vault.put("Source.md", bytes("old"));
				await a.full();
				if (codec) {
					const manifest =
						await new EncryptionManager().createManifest({
							service: codec,
							salt: EncryptionService.bytesToBase64(
								new Uint8Array(16).fill(12),
							),
							state: "enabled",
							revision: 1,
							deviceId: "device-a",
						});
					disk.files.set(
						"vault/.obsidian-encrypt.json",
						bytes(JSON.stringify(manifest)),
					);
				}
				const peer = foreignCommit
					? device(disk, "peer", await codecFor(encrypted))
					: undefined;
				if (peer) {
					bindInitialReadGuards(peer);
					await peer.full();
				}
				bindInitialReadGuards(a);
				a.start();
				const uploadingSource =
					await a.client.getPhysicalPath("vault/Source.md");
				disk.beforeRequest = async (method, endpoint, path) => {
					if (
						method === "PUT" &&
						endpoint === "/upload" &&
						path === uploadingSource
					) {
						a.vault.rename("Source.md", "Renamed.md");
						a.vault.put("Renamed.md", bytes(targetText));
						if (failBeforeBody) {
							throw new Error(
								"Synthetic connection lost before user body",
							);
						}
					}
					if (
						method === "PUT" &&
						endpoint === "/upload" &&
						path.includes(".lock.")
					) {
						throw new Error(
							"Synthetic connection lost before commit",
						);
					}
				};
				a.vault.put("Source.md", bytes("submitted snapshot"));
				await a.drain();
				// Older builds accumulated these target puts on each failed rename retry.
				for (let retry = 0; retry < 2; retry++) {
					a.index.enqueueMutation("put", "Renamed.md", {
						sha256: await computeSha256(
							bytes("obsolete retry snapshot"),
						),
						...a.engine.getWatcherCausalContext(),
					});
				}
				a.vault.put("Folder/Deep/Copy.md", bytes("copy"));
				await a.stop();
				const saved = await a.saved();
				if (saved.pendingMutations.length !== 3) {
					throw new Error(
						"Failure must retain the original predecessor and both old retry puts",
					);
				}
				disk.beforeRequest = undefined;
				a = device(disk, "device-a", codec, a.vault, saved);
				bindInitialReadGuards(a);
				assert.deepEqual(
					a.index.getPendingMutations(),
					saved.pendingMutations,
				);
				a.start();
				{
					const physicalBefore = structuredClone([...disk.files]);
					let interrupted = false;
					let writesAfter = 0;
					let sourceRead = false;
					let sourceStable = false;
					disk.beforeRequest = async (method, endpoint, path) => {
						if (
							method === "GET" &&
							endpoint === "/download" &&
							path === uploadingSource
						) {
							sourceRead = true;
						}
						if (
							sourceRead &&
							method === "GET" &&
							endpoint.endsWith("/resources") &&
							path === uploadingSource
						) {
							sourceStable = true;
						}
						if (
							!interrupted &&
							method === "GET" &&
							(failBeforeBody || targetText === "old"
								? endpoint === "/download" &&
									path === uploadingSource
								: sourceStable &&
									endpoint.endsWith("/resources") &&
									path === "vault")
						) {
							interrupted = true;
							if (failBeforeBody) {
								a.engine.pause();
								a.engine.resume();
							} else {
								a.client.setToken("synthetic-changed");
								a.client.setToken("synthetic");
							}
							a.watcher.stop();
						}
						if (
							interrupted &&
							["PUT", "POST", "DELETE"].includes(method)
						) {
							writesAfter++;
						}
					};
					await a.drain();
					assert.equal(interrupted, true);
					assert.equal(writesAfter, 0);
					assert.deepEqual([...disk.files], physicalBefore);
					assert.deepEqual(
						a.index
							.getPendingMutations()
							.map(({ id, seq }) => ({ id, seq })),
						saved.pendingMutations.map(({ id, seq }) => ({
							id,
							seq,
						})),
					);
					assert.ok(
						a.watcher
							.getDeferredEvents()
							.some((event) => event.action === "rename"),
					);
					disk.beforeRequest = undefined;
					const blocked = await a.saved();
					a = device(disk, "device-a", codec, a.vault, blocked);
					bindInitialReadGuards(a);
					a.start();
				}
				if (foreignPhysical) {
					await a.client.uploadFile(
						"vault/Source.md",
						bytes("foreign physical"),
						true,
					);
				}
				let foreignPublished = false;
				if (peer) {
					disk.beforeRequest = async (method, endpoint, path) => {
						if (
							method === "POST" &&
							endpoint.endsWith("/resources/move") &&
							path.includes(".lock.")
						) {
							disk.beforeRequest = undefined;
							peer.vault.put(
								"Source.md",
								bytes("submitted snapshot"),
							);
							await peer.full();
							assert.equal(
								(await peer.canonical()).files["Source.md"]
									?.lastModifiedBy,
								"peer",
							);
							foreignPublished = true;
						}
					};
				}
				await a.drain();
				if (peer) {
					assert.equal(foreignPublished, true);
					const retained = await peer.canonical();
					assert.equal(
						Boolean(retained.files["Source.md"]?.deleted),
						false,
					);
					assert.equal(
						retained.files["Source.md"]?.lastModifiedBy,
						"peer",
					);
					assert.deepEqual(
						a.index
							.getPendingMutations()
							.map(({ id, seq }) => ({ id, seq })),
						saved.pendingMutations.map(({ id, seq }) => ({
							id,
							seq,
						})),
					);
					assert.ok(
						a.watcher
							.getDeferredEvents()
							.some((event) => event.action === "rename"),
					);
					await a.stop();
					a = device(
						disk,
						"device-a",
						await codecFor(encrypted),
						a.vault,
						await a.saved(),
					);
					bindInitialReadGuards(a);
					await a.full();
					await peer.full();
				}
				if (foreignPhysical) {
					await a.full();
				}
				const retainedSource: Record<string, string> = peer
					? { "Source.md": "submitted snapshot" }
					: foreignPhysical
						? { "Source.md": "foreign physical" }
						: {};
				await a.assertSettled({
					...retainedSource,
					"Renamed.md": targetText,
					"Folder/Deep/Copy.md": "copy",
				});
				const noop = await a.full();
				assert.deepEqual(
					[noop.uploaded, noop.downloaded, noop.deleted],
					[0, 0, 0],
				);
				await a.assertSettled({
					...retainedSource,
					"Renamed.md": targetText,
					"Folder/Deep/Copy.md": "copy",
				});
				await a.stop();
				const context = a.engine.getWatcherCausalContext();
				const b = device(disk, "device-b", await codecFor(encrypted));
				bindInitialReadGuards(b);

				await b.full();
				b.vault.put("Rejected.md", bytes(targetText));
				await b.full();
				b.vault.remove("Rejected.md");
				await b.full();
				a.vault.rename("Renamed.md", "Rejected.md");
				const writeBackup = a.vault.adapter.writeBinary;
				let raced = false;
				a.vault.adapter.writeBinary = async (path, content) => {
					await writeBackup(path, content);
					if (!raced) {
						raced = true;
						a.vault.put(
							"Rejected.md",
							bytes("late edit during rejected rename backup"),
						);
					}
				};
				const outcome = await a.engine.renameFile(
					"Renamed.md",
					"Rejected.md",
					context,
				);
				assert.equal(raced, true);
				assert.equal(
					new TextDecoder().decode(a.vault.files.get("Rejected.md")),
					"late edit during rejected rename backup",
				);
				assert.equal(outcome.status, "retry");
				assert.equal(
					(await a.canonical()).files["Rejected.md"]?.deleted,
					true,
				);
				assert.ok(
					a.index
						.getPendingPhysicalActions()
						.some(
							(action) =>
								action.type === "delete-local" &&
								action.path === "Rejected.md",
						),
				);
				await a.stop();
				a = device(disk, "device-a", codec, a.vault, await a.saved());
				await a.full();
				assert.ok(
					[...a.vault.files.values()].some(
						(content) =>
							new TextDecoder().decode(content) ===
							"late edit during rejected rename backup",
					),
					"Late bytes remain in a verified protective copy after recovery",
				);
				await a.assertSettled({
					...retainedSource,
					"Folder/Deep/Copy.md": "copy",
				});
			}
		},
	);
}

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";
	test(
		`${mode} real Force replacement and foreign adoption preserve offline edits`,
		{ timeout: 30_000 },
		async (t) => {
			const device = managedDevices(t);
			for (const withBackup of [false, true]) {
				const disk = new MemoryDisk();
				const a = device(disk, "device-a", await codecFor(encrypted));
				let b = device(disk, "device-b", await codecFor(encrypted));

				a.vault.put("Keep.md", bytes("initial"));
				await a.full();
				await b.full();
				b.vault.put("Keep.md", bytes("offline edit"));
				a.vault.remove("Keep.md");
				a.vault.put("Authoritative.md", bytes("force local"));
				const backup = new BackupManager(
					a.client,
					a.adapter,
					{
						...a.settings,
						encryptionPassword: encrypted
							? "synthetic-flow-password"
							: null,
					},
					"2.0.0",
				);
				for (const direction of [
					"from_local",
					"from_remote",
				] as const) {
					const canonical =
						await a.index.captureForceCanonicalProof();
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
						const archive =
							direction === "from_local"
								? await backup.createRemoteSnapshotBackup()
								: await backup.createBackup();
						assert.equal(archive.success, true, archive.error);
						assert.equal(
							archive.snapshotDigest,
							proof.snapshotDigest,
						);
						proof.backup = {
							backupName: archive.backupName!,
							backupSha256: archive.sha256!,
						};
					}
					const result =
						direction === "from_local"
							? await a.engine.forceSyncFromLocal({
									forcePreflightProof: proof,
								})
							: await a.engine.forceSyncFromRemote({
									forcePreflightProof: proof,
								});
					assert.equal(
						result.success,
						true,
						JSON.stringify(result.errors),
					);
					await a.full();
					if (direction === "from_local") {
						await a.assertSettled({
							"Authoritative.md": "force local",
						});
						if (!withBackup) {
							const before = await b.saved();
							disk.beforeRequest = async (
								method,
								endpoint,
								path,
							) => {
								if (
									method === "PUT" &&
									endpoint === "/upload" &&
									path.includes(".lock.")
								) {
									throw new Error(
										"Synthetic failed adoption commit",
									);
								}
							};
							assert.equal(
								(
									await b.engine.fullSync({
										epochAdoption: {
											epoch: (await a.canonical()).epoch,
											decision: "preserve",
										},
									})
								).success,
								false,
							);
							await b.stop();
							const failed = await b.saved();
							assert.deepEqual(
								failed.localState.files,
								before.localState.files,
							);
							assert.equal(
								failed.localState.observedEpoch,
								before.localState.observedEpoch,
							);
							assert.deepEqual(
								failed.pendingMutations,
								before.pendingMutations,
							);
							disk.beforeRequest = undefined;
							b = device(
								disk,
								"device-b",
								await codecFor(encrypted),
								b.vault,
								failed,
							);
						}
						const gated = await b.engine.fullSync();
						assert.equal(
							gated.errors[0]?.code,
							"epoch-decision-required",
						);
						b.engine.setEpochAdoptionDecisionCallback(
							async () => null,
						);
						disk.beforeRequest = async (
							method,
							_endpoint,
							path,
						) => {
							if (
								method === "GET" &&
								path === "vault/.obsidian-sync-index.json"
							) {
								b.engine.setEpochAdoptionDecisionCallback(
									async () => "preserve",
								);
							}
						};
						const accepted = await b.engine.fullSync();
						disk.beforeRequest = undefined;
						assert.equal(
							accepted.success,
							true,
							JSON.stringify(accepted.errors),
						);
						await a.full();
						await a.assertSettled({
							"Authoritative.md": "force local",
							"Keep.md": "offline edit",
						});
						a.vault.put(
							"Authoritative.md",
							bytes("discarded local edit"),
						);
						a.vault.put(
							"Discard.md",
							bytes("discarded local addition"),
						);
					} else {
						await a.assertSettled({
							"Authoritative.md": "force local",
							"Keep.md": "offline edit",
						});
						await b.full();
						await b.assertSettled({
							"Authoritative.md": "force local",
							"Keep.md": "offline edit",
						});
					}
				}
				for (const current of [a, b]) {
					const settled = await current.full();
					assert.deepEqual(
						[
							settled.uploaded,
							settled.downloaded,
							settled.deleted,
							settled.conflicts,
						],
						[0, 0, 0, 0],
					);
				}
			}
		},
	);
}
