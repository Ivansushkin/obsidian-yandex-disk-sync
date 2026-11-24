import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	StorageBindingController,
	type StorageBindingChoice,
} from "../src/sync/local/storage-binding";
import { repairMissingAcceptedUploads } from "../src/sync/reconciliation/accepted-uploads";
import { type Dependencies } from "../src/sync/reconciliation/context";
import type { SyncIndex } from "../src/types";
import { computeSha256 } from "../src/utils/hash-utils";
import { deferred } from "./helpers/deferred";
import { afterTest } from "./helpers/test-context";
import { reconciliationDependencies } from "./helpers/realtime-fixtures";
import {
	MemoryDisk,
	bytes,
	codecFor,
	type device as createDevice,
	managedDevices,
} from "./helpers/sync-flow";

/** Interrupt one canonical write after its lock body is uploaded. */
function failNextCanonicalReadback(disk: MemoryDisk): () => void {
	const resource = disk.resource.bind(disk);
	let writtenLock: string | undefined;
	let failed = false;
	disk.afterRequest = async (method, endpoint, path) => {
		if (
			method === "PUT" &&
			endpoint === "/upload" &&
			path.includes(".lock.")
		) {
			writtenLock = path;
		}
	};
	disk.resource = async (path) => {
		const value = await resource(path);
		if (value && path === writtenLock && !failed) {
			failed = true;
			return { ...value, sha256: "0".repeat(64) };
		}
		return value;
	};
	return () => {
		disk.resource = resource;
		disk.afterRequest = undefined;
		assert.equal(failed, true);
	};
}

/** Leave the exact delete durable while the ordinary canonical transaction rolls back. */
async function interruptDeletion(
	disk: MemoryDisk,
	device: ReturnType<typeof createDevice>,
	path: string,
) {
	device.vault.remove(path);
	const restore = failNextCanonicalReadback(disk);
	try {
		assert.equal((await device.engine.fullSync()).success, false);
	} finally {
		restore();
	}
}

/** Return a stale file body once while leaving resource metadata current. */
function returnStaleDownloadOnce(
	disk: MemoryDisk,
	path: string,
	raw: ArrayBuffer,
): () => boolean {
	const request = disk.request.bind(disk);
	let returned = false;
	disk.request = async (params, accepted) => {
		const response = await request(params, accepted);
		const url = new URL(params.url);
		if (
			!returned &&
			url.pathname === "/download" &&
			url.searchParams.get("path") === path
		) {
			returned = true;
			return { ...response, arrayBuffer: raw };
		}
		return response;
	};
	return () => returned;
}

test("storage confirmation preserves queued work and rolls back a failed save", async (t) => {
	const device = managedDevices(t);
	const disk = new MemoryDisk();
	const a = device(disk, "a", null);

	a.vault.put("note.md", bytes("kept"));
	await a.full();
	const mutation = a.index.enqueueMutation("put", "pending.md", {
		sha256: "pending",
	});
	let choice: StorageBindingChoice = "cancel";
	let failSave = true;
	const controller = new StorageBindingController({
		client: a.client,
		index: a.index,
		getSettings: () => a.settings,
		hasPendingWork: () => a.index.getPendingMutations().length > 0,
		hasTransition: () => false,
		isUnloaded: () => false,
		confirm: async () => choice,
		persist: async () => {
			if (failSave) {
				throw new Error("synthetic persistence failure");
			}
		},
	});
	const remote = [...disk.files];
	assert.equal(await controller.ensure(true), false);
	choice = "new";
	await assert.rejects(controller.ensure(true), /pending work/);
	choice = "same";
	await assert.rejects(controller.ensure(true), /persistence failure/);
	assert.equal(a.index.getLocalIndex().remoteScope, null);
	assert.deepEqual(a.index.getPendingMutations(), [mutation]);
	assert.deepEqual([...disk.files], remote);
	failSave = false;
	assert.equal(await controller.ensure(true), true);
	assert.equal(
		a.index.getLocalIndex().remoteScope?.rootResourceId,
		`${disk.identity}:vault`,
	);
	assert.deepEqual(a.index.getPendingMutations(), [mutation]);
});

test("explicit new storage creates its root without carrying previous history", async (t) => {
	const device = managedDevices(t);
	const disk = new MemoryDisk();
	const a = device(disk, "a", null);

	a.vault.put("note.md", bytes("kept"));
	await a.full();
	a.index.getLocalIndex().remoteScope = {
		remotePath: "vault",
		rootResourceId: `${disk.identity}:vault`,
	};
	a.settings.remotePath = "other";
	a.client.setRemotePath("other");
	const controller = new StorageBindingController({
		client: a.client,
		index: a.index,
		getSettings: () => a.settings,
		hasPendingWork: () => false,
		hasTransition: () => false,
		isUnloaded: () => false,
		confirm: async () => "new",
		persist: async () => {},
	});
	assert.equal(await controller.ensure(true), true);
	assert.equal(a.index.getLocalIndex().remoteScope?.remotePath, "other");
	assert.deepEqual(a.index.getLocalIndex().files, {});
	a.assertLocal("note.md", "kept");
	assert.deepEqual(
		await a.client.downloadFile("vault/note.md"),
		bytes("kept"),
	);
});

test("initial receive respects excluded paths without blocking or overwriting local data", async (t) => {
	const device = managedDevices(t);
	for (const exists of [false, true]) {
		const disk = new MemoryDisk();
		const desktop = device(disk, "desktop", null);
		const phone = device(disk, "phone", null);

		desktop.vault.put("private/note.md", bytes("private cloud"));
		await desktop.full();
		phone.settings.excludePatterns = ["private/**"];
		if (exists) {
			phone.vault.put("private/note.md", bytes("private local"));
		}
		const before = structuredClone([...disk.files]);
		await phone.full();
		assert.deepEqual(
			phone.vault.files.get("private/note.md"),
			exists ? bytes("private local") : undefined,
		);
		assert.deepEqual([...disk.files], before);
	}
});

test("initial exact deletion resumes its durable action after restart", async (t) => {
	const device = managedDevices(t);
	const disk = new MemoryDisk();
	const desktop = device(disk, "desktop", null);
	const phone = device(disk, "phone", null);
	let restarted: ReturnType<typeof device> | undefined;

	desktop.vault.put("deleted.md", bytes("old"));
	await desktop.full();
	desktop.vault.remove("deleted.md");
	await desktop.full();
	phone.vault.put("deleted.md", bytes("old"));
	phone.adapter.deleteFile = async () => {
		throw new Error("synthetic interrupted trash");
	};
	const before = structuredClone([...disk.files]);
	assert.equal((await phone.engine.fullSync()).success, false);
	const saved = phone.crash();
	assert.equal(saved.localState.lastSyncTime, 0);
	assert.equal(saved.pendingPhysicalActions.length, 1);
	phone.assertLocal("deleted.md", "old");
	restarted = device(disk, "phone", null, phone.vault, saved);
	await restarted.full();
	assert.equal(restarted.vault.files.has("deleted.md"), false);
	assert.deepEqual(restarted.index.getPendingPhysicalActions(), []);
	assert.deepEqual([...disk.files], before);
	assert.ok(
		[...phone.vault.files].some(
			([path, content]) =>
				path.includes("/overwritten/") &&
				new TextDecoder().decode(content) === "old",
		),
	);
});

test("restart preserves a late edit behind a legacy queued folder deletion", async (t) => {
	const device = managedDevices(t);
	const disk = new MemoryDisk();
	const a = device(disk, "a", null);
	const b = device(disk, "b", null);
	const path = "folder/note.md";
	a.vault.put(path, bytes("base"));
	await a.full();
	await b.full();
	a.vault.remove("folder");
	a.index.enqueueMutation("delete-folder", "folder");
	await a.full();
	b.adapter.deleteFile = async () => {
		throw new Error("interrupted trash");
	};
	assert.equal((await b.engine.fullSync()).success, false);
	const saved = b.crash();
	assert.equal(saved.pendingPhysicalActions.length, 1);
	const action = saved.pendingPhysicalActions[0]!;
	assert.equal(action.type, "delete-local");
	assert.equal(action.path, path);
	// Older clients persisted this folder-derived action as an exact delete.
	action.origin = "exact-delete";
	b.vault.put(path, bytes("edited after enqueue"));
	const restarted = device(disk, "b", null, b.vault, saved);
	const read = restarted.adapter.readFile.bind(restarted.adapter);
	restarted.adapter.readFile = async () => {
		throw new Error("interrupted read");
	};
	assert.equal((await restarted.engine.fullSync()).success, false);
	assert.deepEqual(
		restarted.index.getPendingPhysicalActions().map((item) => item.id),
		[action.id],
	);
	restarted.assertLocal(path, "edited after enqueue");
	restarted.adapter.readFile = read;
	await restarted.full();
	await a.full();
	for (const peer of [a, restarted]) {
		await peer.assertSettled({ [path]: "edited after enqueue" });
	}
});

for (const encrypted of [false, true]) {
	test(`${encrypted ? "encrypted" : "plain"} accepted metadata overlaps and revoked reads cannot repair`, async (t) => {
		const createDevice = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = createDevice(disk, "a", codec);
		const expected = Object.fromEntries(
			Array.from({ length: 6 }, (_, i) => [
				`Note${i}.md`,
				`reference${i}`,
			]),
		);
		for (const [path, content] of Object.entries(expected)) {
			a.vault.put(path, bytes(content));
		}
		await a.full();
		a.settings.maxConcurrency = 4;
		const get = a.client.getLogicalResource.bind(a.client);
		const paths = Object.keys(expected);
		for (const interruption of [
			"healthy",
			"lifetime",
			"canonical",
		] as const) {
			const revoke = interruption !== "healthy";
			const entered = deferred();
			const release = deferred();
			afterTest(t, () => release.resolve());
			let active = 0;
			let peak = 0;
			let writes = 0;
			const before = structuredClone(a.index.captureLocalCausalState());
			const canonicalBytes = disk.files.get(
				"vault/.obsidian-sync-index.json",
			)!;
			a.client.getLogicalResource = async (...args) => {
				active++;
				peak = Math.max(peak, active);
				entered.resolve();
				try {
					await release.promise;
					return interruption === "lifetime"
						? null
						: await get(...args);
				} finally {
					active--;
				}
			};
			disk.beforeRequest = async (method) => {
				writes += Number(method !== "GET");
			};
			const operation = repairMissingAcceptedUploads(
				reconciliationDependencies(a.engine),
				paths,
			);
			const outcome = revoke ? assert.rejects(operation) : operation;
			await Promise.race([
				entered.promise,
				operation.then(() => {
					throw new Error("No accepted metadata reads");
				}),
			]);
			await new Promise((resolve) => setTimeout(resolve, 0));
			const observedPeak = peak;
			if (interruption === "canonical") {
				const latest = await a.canonical();
				latest.revision++;
				latest.files[paths[0]!]!.sha256 = await computeSha256(
					bytes("new winner"),
				);
				latest.files[paths[0]!]!.changedRevision = latest.revision;
				const content = bytes(JSON.stringify(latest));
				disk.files.set(
					"vault/.obsidian-sync-index.json",
					codec ? await codec.encrypt(content) : content,
				);
			} else if (revoke) {
				if (encrypted) {
					a.client.setEncryptionService(null);
					a.client.setEncryptionService(codec);
				} else {
					a.engine.pause();
					a.engine.resume();
				}
			}
			release.resolve();
			await outcome;
			assert.equal(observedPeak, 4);
			assert.ok(peak <= 4);
			assert.equal(writes, 0);
			assert.deepEqual(a.index.captureLocalCausalState(), before);
			a.client.getLogicalResource = get;
			disk.beforeRequest = undefined;
			disk.files.set("vault/.obsidian-sync-index.json", canonicalBytes);
		}
		await a.assertSettled(expected);
	});

	const mode = encrypted ? "encrypted" : "plaintext";

	test(`${mode} new device receives cloud versions before uploading local-only files`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const desktop = device(disk, "desktop", codec);
		const phone = device(disk, "phone", codec);

		desktop.vault.put("note.md", bytes("old copy"));
		desktop.vault.put("deleted.md", bytes("deleted copy"));
		desktop.vault.put("same.md", bytes("same"));
		await desktop.full();
		phone.vault.put("note.md", bytes("old copy"));
		phone.vault.put("deleted.md", bytes("deleted copy"));
		phone.vault.put("same.md", bytes("same"));
		phone.vault.put("local.md", bytes("local only"));
		desktop.vault.put("note.md", bytes("cloud update"));
		desktop.vault.remove("deleted.md");
		await desktop.full();
		let localUploadAfterAdoption = false;
		const samePath = await phone.client.getPhysicalPath("vault/same.md");
		let identicalTransfers = 0;
		disk.beforeRequest = async (method, endpoint, path) => {
			if (endpoint === "/download" && path === samePath) {
				identicalTransfers++;
			}
			if (method === "PUT" && endpoint === "/upload") {
				localUploadAfterAdoption =
					phone.index.getLocalIndex().lastSyncTime > 0;
			}
		};
		const result = await phone.full();
		assert.equal(result.conflicts, 0);
		assert.equal(identicalTransfers, 0);
		assert.equal(localUploadAfterAdoption, true);
		assert.equal(phone.vault.files.has("deleted.md"), false);
		const protectedBytes = [...phone.vault.files]
			.filter(([path]) => path.includes("/overwritten/"))
			.map(([, content]) => new TextDecoder().decode(content))
			.sort();
		assert.deepEqual(protectedBytes, ["deleted copy", "old copy"]);
		await phone.assertSettled({
			"note.md": "cloud update",
			"same.md": "same",
			"local.md": "local only",
		});
	});

	test(`${mode} initial download failure resumes after restart without cloud writes`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const desktop = device(disk, "desktop", codec);
		const phone = device(disk, "phone", codec, undefined, undefined, {
			readTimeoutMs: 1000,
		});
		let restarted: ReturnType<typeof device> | undefined;

		desktop.vault.put("a.md", bytes("cloud a"));
		desktop.vault.put("b.md", bytes("cloud b"));
		await desktop.full();
		phone.settings.maxConcurrency = 2;
		phone.vault.put("a.md", bytes("old a"));
		phone.vault.put("b.md", bytes("old b"));
		phone.vault.put("local.md", bytes("local"));
		const blocked = await phone.client.getPhysicalPath("vault/b.md");
		const before = structuredClone([...disk.files]);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		disk.beforeRequest = async (_method, endpoint, path) => {
			if (endpoint === "/download" && path === blocked) {
				await gate;
			}
		};
		const result = await phone.engine.fullSync().finally(() => release());
		assert.equal(result.success, false);
		assert.equal(result.errors[0]?.code, "remote-read-timeout");
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.deepEqual([...disk.files], before);
		phone.assertLocal("a.md", "cloud a");
		phone.assertLocal("b.md", "old b");
		const saved = phone.crash();
		assert.equal(saved.localState.lastSyncTime, 0);
		assert.equal(saved.localState.observedRevision, 0);
		assert.deepEqual(saved.pendingMutations, []);
		disk.beforeRequest = undefined;
		restarted = device(disk, "phone", codec, phone.vault, saved);
		restarted.start();
		restarted.vault.remove("a.md");
		await restarted.drain();
		assert.deepEqual(
			[...disk.files],
			before,
			"Watcher must not publish a deletion during unfinished receive",
		);
		assert.equal((await restarted.full()).conflicts, 0);
		await restarted.assertSettled({
			"a.md": "cloud a",
			"b.md": "cloud b",
			"local.md": "local",
		});
	});

	test(`${mode} initial receive preserves bytes and unobserved state when authority or protection fails`, async (t) => {
		const device = managedDevices(t);
		for (const failure of [
			"local-edit",
			"backup",
			"save",
			"canonical",
			"codec",
			"root",
		] as const) {
			const disk = new MemoryDisk();
			const codec = await codecFor(encrypted);
			const desktop = device(disk, "desktop", codec);
			const phone = device(disk, "phone", codec);

			desktop.vault.put("note.md", bytes("cloud"));
			await desktop.full();
			phone.vault.put("note.md", bytes("old"));
			phone.index.getLocalIndex().remoteScope = {
				remotePath: "vault",
				rootResourceId: `${disk.identity}:vault`,
			};
			let changed = false;
			phone.engine.setSyncGuardCallback(() => ({
				blockReason:
					failure === "codec" && changed
						? "synthetic codec changed"
						: null,
			}));
			const backup = phone.adapter.backupOverwrittenFile.bind(
				phone.adapter,
			);
			phone.adapter.backupOverwrittenFile = async (...args) => {
				if (failure === "backup") {
					throw new Error("synthetic backup failure");
				}
				const path = await backup(...args);
				if (failure === "local-edit") {
					phone.vault.put("note.md", bytes("late edit"));
				}
				return path;
			};
			phone.engine.setIndexSaveCallback(async (observation) => {
				if (failure === "save" && observation) {
					throw new Error("synthetic save failure");
				}
				await phone.saved(observation);
			});
			const physical =
				await phone.client.getPhysicalPath("vault/note.md");
			const canonical = await desktop.canonical();
			const resource = disk.resource.bind(disk);
			disk.resource = async (path) => {
				const result = await resource(path);
				return failure === "root" && changed && path === "vault"
					? { ...result, resource_id: "other-root" }
					: result;
			};
			disk.afterRequest = async (_method, endpoint, path) => {
				if (endpoint === "/download" && path === physical && !changed) {
					changed = true;
					if (failure === "canonical") {
						canonical.epoch = crypto.randomUUID();
						const raw = bytes(JSON.stringify(canonical));
						disk.files.set(
							"vault/.obsidian-sync-index.json",
							codec ? await codec.encrypt(raw) : raw,
						);
					}
				}
			};
			assert.equal(
				(await phone.engine.fullSync()).success,
				false,
				failure,
			);
			phone.assertLocal(
				"note.md",
				failure === "save"
					? "cloud"
					: failure === "local-edit"
						? "late edit"
						: "old",
			);
			assert.equal(phone.index.getLocalIndex().lastSyncTime, 0);
			assert.equal(phone.index.getObservedRevision(), 0);
			assert.deepEqual(phone.index.getPendingMutations(), []);
			if (failure === "canonical") {
				disk.afterRequest = undefined;
				await phone.full();
				phone.assertLocal("note.md", "cloud");
			}
		}
	});

	test(`${mode} download write guard preserves root and late local changes`, async (t) => {
		const device = managedDevices(t);
		for (const timing of ["download", "write", "local-edit"] as const) {
			const disk = new MemoryDisk();
			const codec = await codecFor(encrypted);
			const a = device(disk, "a", codec);
			const b = device(disk, "b", codec);

			a.vault.put("note.md", bytes("original"));
			await a.full();
			await b.full();
			b.vault.put("note.md", bytes("remote edit"));
			await b.full();
			a.index.getLocalIndex().remoteScope = {
				remotePath: "vault",
				rootResourceId: `${disk.identity}:vault`,
			};
			const baseline = structuredClone(a.index.getLocalIndex());
			let replaced = false;
			const resource = disk.resource.bind(disk);
			disk.resource = async (path) => {
				const result = await resource(path);
				return result && replaced && path === "vault"
					? { ...result, resource_id: "replacement-root" }
					: result;
			};
			const physicalPath =
				await a.client.getPhysicalPath("vault/note.md");
			disk.beforeRequest = async (_method, endpoint, path) => {
				if (
					timing === "download" &&
					endpoint === "/download" &&
					path === physicalPath
				) {
					replaced = true;
				}
			};
			const write = a.adapter.writeFile.bind(a.adapter);
			let preparingWrite = false;
			const assertScope = a.index.assertRemoteScope.bind(a.index);
			a.index.assertRemoteScope = async () => {
				await assertScope();
				if (timing === "local-edit" && preparingWrite) {
					a.vault.put("note.md", bytes("late edit"));
				}
			};
			a.adapter.writeFile = async (...args) => {
				preparingWrite = true;
				if (timing === "write") {
					replaced = true;
				}
				return await write(...args);
			};
			assert.equal((await a.engine.fullSync()).success, false);
			assert.equal(replaced, timing !== "local-edit");
			a.assertLocal(
				"note.md",
				timing === "local-edit" ? "late edit" : "original",
			);
			assert.deepEqual(a.index.getLocalIndex(), baseline);
		}
	});

	test(`${mode} lost PUT response is confirmed without abandoning its mutation`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);

		a.vault.put("note.md", bytes("original"));
		await a.full();
		const nextSequence = a.index.getLocalIndexData().nextMutationSeq;
		a.vault.put("note.md", bytes("new bytes"));
		const physicalPath = await a.client.getPhysicalPath("vault/note.md");
		let lost = false;
		disk.afterRequest = async (method, endpoint, path) => {
			if (
				!lost &&
				method === "PUT" &&
				endpoint === "/upload" &&
				path === physicalPath
			) {
				lost = true;
				throw new Error("synthetic lost PUT response");
			}
		};
		await a.full();
		assert.equal(lost, true);
		await a.assertSettled({ "note.md": "new bytes" });
		assert.equal(
			(await a.canonical()).files["note.md"]!.mutationSeq,
			nextSequence,
		);
	});

	test(`${mode} ambiguous PUT never confirms revoked authority`, async (t) => {
		const device = managedDevices(t);
		for (const change of [
			"winner",
			"tombstone",
			"epoch",
			"codec",
		] as const) {
			const disk = new MemoryDisk();
			const codec = await codecFor(encrypted);
			const a = device(disk, "a", codec);
			const b = device(disk, "b", codec);

			a.vault.put("note.md", bytes("original"));
			await a.full();
			await b.full();
			let authority = "initial";
			a.engine.setSyncGuardCallback((token) => ({
				blockReason:
					token !== undefined && token !== authority
						? "synthetic codec changed"
						: null,
				validationToken: authority,
			}));
			a.vault.put("note.md", bytes("local edit"));
			const physical = await a.client.getPhysicalPath("vault/note.md");
			let lost = false;
			disk.afterRequest = async (method, endpoint, path) => {
				if (
					lost ||
					method !== "PUT" ||
					endpoint !== "/upload" ||
					path !== physical
				) {
					return;
				}
				lost = true;
				if (change === "winner") {
					b.vault.put("note.md", bytes("foreign winner"));
					await b.engine.uploadFile("note.md");
					const mutation = b.index.enqueueMutation("put", "note.md", {
						sha256: await computeSha256(bytes("foreign winner")),
					});
					b.index.getRemoteIndex().files["note.md"]!.mutationSeq =
						mutation.seq;
					b.index.stageMutation(mutation);
					await b.index.saveRemoteIndex();
				} else if (change === "tombstone") {
					b.vault.remove("note.md");
					await b.full();
				} else if (change === "epoch") {
					const canonical = await b.canonical();
					canonical.epoch = "replacement-epoch";
					const content = bytes(JSON.stringify(canonical));
					disk.files.set(
						"vault/.obsidian-sync-index.json",
						codec ? await codec.encrypt(content) : content,
					);
				} else {
					authority = "replacement";
				}
				throw new Error("synthetic lost PUT response");
			};
			const failed = await a.engine.fullSync();
			assert.equal(failed.success, false, change);
			assert.equal(failed.failure?.outcome, "write-unconfirmed", change);
			assert.equal(lost, true);
			assert.equal(a.index.getPendingMutations().length, 1);
			a.assertLocal("note.md", "local edit");
			if (change === "winner") {
				assert.deepEqual(
					await b.client.downloadFile("vault/note.md"),
					bytes("foreign winner"),
				);
			} else if (change === "tombstone") {
				assert.equal(
					(await b.canonical()).files["note.md"]!.deleted,
					true,
				);
				assert.equal(disk.files.has(physical), false);
			}
		}
	});

	test(`${mode} corrective PUT confirms a lost response with its retained copy`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);

		a.vault.put("note.md", bytes("accepted"));
		await a.full();
		await a.client.uploadFile("vault/note.md", bytes("external version"));
		const physical = await a.client.getPhysicalPath("vault/note.md");
		Object.assign(a.client, { maxRetries: 1 });
		let lost = false;
		disk.afterRequest = async (method, endpoint, path) => {
			if (
				!lost &&
				method === "PUT" &&
				endpoint === "/upload" &&
				path === physical
			) {
				lost = true;
				throw new Error("synthetic lost corrective response");
			}
		};
		const access = a.engine as unknown as {
			syncReconciliationDependencies(): Dependencies;
		};
		await repairMissingAcceptedUploads(
			access.syncReconciliationDependencies(),
			["note.md"],
		);
		assert.equal(lost, true);
		assert.equal(
			(await a.canonical()).files["note.md"]!.remoteFingerprint,
			(await a.client.getLogicalResource("vault/note.md"))!.sha256,
		);
		const copy = [...a.vault.files.keys()].find((name) =>
			name.includes("_conflict_"),
		)!;
		await a.full();
		await a.assertSettled({
			"note.md": "accepted",
			[copy]: "external version",
		});
	});

	test(`${mode} partial upload retains unresolved FIFO across restart`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		let restarted: ReturnType<typeof device> | undefined;

		a.vault.put("first.md", bytes("first old"));
		a.vault.put("second.md", bytes("second old"));
		a.vault.put("delete.md", bytes("delete later"));
		a.vault.put("conflict.md", bytes("base"));
		await a.full();
		const before = await a.canonical();
		a.vault.put("first.md", bytes("first new"));
		a.vault.put("second.md", bytes("second new"));
		a.vault.remove("delete.md");
		a.vault.put("conflict.md", bytes("local conflict"));
		await a.client.uploadFile(
			"vault/conflict.md",
			bytes("remote conflict"),
		);
		await a.client.uploadFile("vault/download.md", bytes("download later"));
		const second = await a.client.getPhysicalPath("vault/second.md");
		let lost = false;
		disk.afterRequest = async (method, endpoint, path) => {
			if (
				!lost &&
				method === "PUT" &&
				endpoint === "/upload" &&
				path === second
			) {
				lost = true;
				throw new Error("synthetic lost PUT response");
			}
		};
		disk.beforeRequest = async (_method, endpoint, path) => {
			if (lost && endpoint === "/download" && path === second) {
				throw new Error("synthetic unavailable read-back");
			}
		};
		const failed = await a.engine.fullSync();
		assert.deepEqual(a.engine.getState().failure, failed.failure);
		assert.equal(failed.failure?.category, "unavailable");
		assert.equal(failed.failure?.path, "second.md");
		assert.equal(JSON.stringify(failed.failure).includes('"cause"'), false);

		assert.equal(failed.success, false);
		assert.match(
			a.engine.getState().errorMessage ?? "",
			/synthetic unavailable read-back/,
		);
		assert.equal(failed.downloaded + failed.deleted + failed.conflicts, 0);
		assert.equal(a.vault.files.has("download.md"), false);
		assert.deepEqual(
			await a.client.downloadFile("vault/delete.md"),
			bytes("delete later"),
		);
		assert.deepEqual(
			[...a.vault.files.keys()].filter((path) =>
				path.includes("_conflict_"),
			),
			[],
		);
		a.assertLocal("conflict.md", "local conflict");
		const saved = a.lastSaved();
		assert.equal(saved.pendingMutations.length, 2);
		assert.equal(
			saved.localState.files["first.md"]!.sha256,
			await computeSha256(bytes("first new")),
		);
		assert.equal(
			(await a.canonical()).appliedMutationSeq.a,
			before.appliedMutationSeq.a,
		);
		await a.stop();
		disk.beforeRequest = undefined;
		disk.afterRequest = undefined;
		restarted = device(disk, "a", codec, a.vault, saved);
		assert.deepEqual(
			restarted.index.getPendingMutations(),
			saved.pendingMutations,
		);
		await restarted.full();
		const copy = [...a.vault.files.keys()].find((path) =>
			path.startsWith("conflict_conflict_"),
		)!;
		await restarted.assertSettled({
			"first.md": "first new",
			"second.md": "second new",
			"download.md": "download later",
			"conflict.md": "remote conflict",
			[copy]: "local conflict",
		});
	});

	test(`${mode} returning state cannot carry deletions to another storage`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);

		a.vault.put("note.md", bytes("old storage"));
		await a.full();
		const root = await a.client.getResource("vault", 1, 0, true);
		Object.assign(a.index.getLocalIndex(), {
			remoteScope: {
				remotePath: "vault",
				rootResourceId: root!.resource_id,
			},
		});
		a.vault.remove("note.md");
		b.settings.remotePath = "other";
		b.client.setRemotePath("other");
		b.vault.put("note.md", bytes("other storage"));
		await b.full();
		a.settings.remotePath = "other";
		a.client.setRemotePath("other");
		assert.equal((await a.engine.fullSync()).success, false);
		assert.deepEqual(
			await b.client.downloadFile("other/note.md"),
			bytes("other storage"),
		);
	});

	test(`${mode} restored actor counter cannot report a stale canonical as success`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		let restarted: ReturnType<typeof device> | undefined;

		a.vault.put("note.md", bytes("first"));
		await a.full();
		a.vault.put("note.md", bytes("second"));
		await a.full();
		await a.stop();
		restarted = device(disk, "a", codec, a.vault);
		await restarted.full();
		restarted.vault.put("note.md", bytes("after restart"));
		assert.equal((await restarted.full()).conflicts, 0);
		await restarted.assertSettled({ "note.md": "after restart" });
	});

	test(`${mode} aborted full sync does not turn a local edit into a conflict`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		a.vault.put("note.md", bytes("base"));
		await a.full();
		const initial = await a.canonical();
		assert.equal(initial.files["note.md"]?.deleted, undefined);

		a.vault.put("earlier.md", bytes("uploaded before rollback"));
		const restore = failNextCanonicalReadback(disk);
		try {
			const aborted = await a.engine.fullSync();
			assert.equal(aborted.deferred, true);
			assert.equal(aborted.uploaded, 1);
		} finally {
			restore();
		}
		assert.deepEqual(await a.canonical(), initial);
		const saved = a.lastSaved();
		assert.equal(saved.localState.files["note.md"]?.deleted, false);
		assert.deepEqual(
			saved.pendingMutations.map(({ path }) => path),
			["earlier.md"],
		);
		await a.stop();

		a.vault.put("note.md", bytes("journal edit"), false);
		const restarted = device(disk, "a", codec, a.vault, saved);
		const result = await restarted.full();
		assert.equal(result.conflicts, 0);
		const expected = {
			"note.md": "journal edit",
			"earlier.md": "uploaded before rollback",
		};
		await restarted.assertSettled(expected);
		const settled = await restarted.canonical();
		assert.equal((await restarted.full()).conflicts, 0);
		assert.deepEqual(await restarted.canonical(), settled);
	});

	test(`${mode} full settles absent deletion predecessors before a conflict`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		a.vault.put("note.md", bytes("base"));
		a.vault.put("gone.md", bytes("exact deletion"));
		a.vault.put("folder/child.md", bytes("folder deletion"));
		a.vault.put("folder/exact.md", bytes("both deletion intents"));
		await a.full();
		await b.full();
		a.vault.put("note.md", bytes("remote edit"));
		await a.full();

		b.vault.remove("gone.md");
		b.vault.remove("folder");
		const exact = b.index.enqueueMutation("delete-file", "gone.md");
		const firstFolder = b.index.enqueueMutation("delete-folder", "folder");
		const folder = b.index.enqueueMutation("delete-folder", "folder");
		const exactChild = b.index.enqueueMutation(
			"delete-file",
			"folder/exact.md",
		);
		for (const path of ["gone.md", "folder/child.md", "folder/exact.md"]) {
			disk.files.delete(await b.client.getPhysicalPath(`vault/${path}`));
		}
		b.vault.put("note.md", bytes("offline edit"));
		await b.stop();
		const restarted = device(disk, "b", codec, b.vault, b.lastSaved());
		assert.equal((await restarted.full()).conflicts, 1);
		const canonical = await restarted.canonical();
		const copy = Object.keys(canonical.files).find((path) =>
			path.startsWith("note_conflict_"),
		);
		assert.ok(copy);
		assert.equal(canonical.files["gone.md"]?.deleted, true);
		assert.equal(canonical.files["gone.md"]?.mutationSeq, exact.seq);
		assert.equal(
			canonical.folderTombstones.folder?.mutationSeq,
			folder.seq,
		);
		assert.equal(
			canonical.files["folder/child.md"]?.deletedByFolder,
			"folder",
		);
		assert.equal(
			canonical.files["folder/child.md"]?.mutationSeq,
			firstFolder.seq,
		);
		assert.equal(canonical.files["folder/exact.md"]?.deleted, true);
		assert.equal(
			canonical.files["folder/exact.md"]?.deletedByFolder,
			undefined,
		);
		assert.equal(
			canonical.files["folder/exact.md"]?.mutationSeq,
			exactChild.seq,
		);
		assert.equal(canonical.appliedMutationSeq.b, exactChild.seq + 1);
		assert.equal(canonical.files[copy]?.mutationSeq, exactChild.seq + 1);
		await restarted.assertSettled({
			"note.md": "remote edit",
			[copy]: "offline edit",
		});
		assert.equal((await restarted.full()).conflicts, 0);
		assert.deepEqual(await restarted.canonical(), canonical);
	});

	test(`${mode} offline edit survives a published folder deletion`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		const changed = "folder/changed.md";
		const unchanged = "folder/unchanged.md";
		const created = "folder/new.md";
		a.vault.put(changed, bytes("base"));
		a.vault.put(unchanged, bytes("remove"));
		await a.full();
		await b.full();
		const offline = await b.saved();
		await b.stop();
		b.vault.put(changed, bytes("offline edit"));
		b.vault.put(created, bytes("offline creation"));
		a.vault.remove("folder");
		a.index.enqueueMutation("delete-folder", "folder");
		await a.full();
		const published = await a.canonical();
		assert.equal(published.files[changed]?.deletedByFolder, "folder");
		assert.ok(published.folderTombstones.folder);
		assert.equal(
			published.files[changed]?.changedRevision,
			published.folderTombstones.folder.changedRevision,
		);
		assert.equal(
			await a.client.getLogicalResource(`vault/${changed}`),
			null,
		);

		const returned = device(disk, "b", codec, b.vault, offline);
		await returned.full();
		returned.assertLocal(changed, "offline edit");
		await a.full();
		const expected = {
			[changed]: "offline edit",
			[created]: "offline creation",
		};
		const settled = await a.canonical();
		for (const peer of [a, returned]) {
			await peer.assertSettled(expected);
			const restarted = device(
				disk,
				peer.settings.deviceId,
				codec,
				peer.vault,
				peer.crash(),
			);
			const repeat = await restarted.full();
			assert.deepEqual(
				[repeat.uploaded, repeat.downloaded, repeat.conflicts],
				[0, 0, 0],
			);
			await restarted.assertSettled(expected);
			assert.deepEqual(await restarted.canonical(), settled);
		}
	});

	test(`${mode} physical edits after folder deletion converge with a returning device`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		const both = "folder/both.md";
		const external = "folder/external.md";
		const restored = "folder/restored.md";
		const absent = "folder/absent.md";
		const unchanged = "folder/unchanged.md";
		for (const path of [both, external, restored, absent, unchanged]) {
			a.vault.put(path, bytes("base"));
		}
		await a.full();
		await b.full();
		b.vault.put(both, bytes("offline"));
		b.vault.put(restored, bytes("offline"));
		b.vault.remove(absent);
		a.vault.remove("folder");
		a.index.enqueueMutation("delete-folder", "folder");
		await a.full();
		for (const path of [both, external]) {
			await a.client.uploadFile(`vault/${path}`, bytes("external"));
		}

		for (const path of [restored, absent, unchanged]) {
			await a.client.uploadFile(`vault/${path}`, bytes("base"));
		}
		assert.equal((await b.full()).conflicts, 1);
		const live = await b.canonical();
		const copy = Object.keys(live.files).find((path) =>
			path.startsWith("folder/both_conflict_"),
		);
		assert.ok(copy);
		const expected = {
			[both]: "external",
			[external]: "external",
			[restored]: "offline",
			[copy]: "offline",
		};
		await a.full();
		await b.assertSettled(expected);
		await a.assertSettled(expected);
		assert.equal((await b.full()).conflicts, 0);
	});

	test(`${mode} full preserves concurrent children during offline folder deletion`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		a.vault.put("note.md", bytes("base"));
		a.vault.put("folder/changed.md", bytes("before"));
		a.vault.put("folder/recreated.md", bytes("before recreation"));
		a.vault.put("folder/unchanged.md", bytes("remove this child"));
		await a.full();
		await b.full();
		b.vault.remove("folder");
		const deletion = b.index.enqueueMutation("delete-folder", "folder");
		b.vault.put("note.md", bytes("offline edit"));
		b.vault.put("folder/recreated.md", bytes("offline recreation"));
		await b.stop();
		a.vault.put("folder/changed.md", bytes("remote child edit"));
		a.vault.put("folder/recreated.md", bytes("remote child version"));
		a.vault.put("folder/new.md", bytes("new child"));
		a.vault.put("note.md", bytes("remote edit"));
		await a.full();
		a.vault.put("extra.md", bytes("later unrelated revision"));
		await a.full();

		const restarted = device(disk, "b", codec, b.vault, b.lastSaved());
		assert.equal((await restarted.full()).conflicts, 2);
		const canonical = await restarted.canonical();
		const copy = Object.keys(canonical.files).find((path) =>
			path.startsWith("note_conflict_"),
		);
		assert.ok(copy);
		const recreatedCopy = Object.keys(canonical.files).find((path) =>
			path.startsWith("folder/recreated_conflict_"),
		);
		assert.ok(recreatedCopy);
		assert.equal(canonical.files["folder/changed.md"]?.lastModifiedBy, "a");
		assert.equal(
			canonical.files["folder/unchanged.md"]?.deletedByFolder,
			"folder",
		);
		assert.equal(
			canonical.folderTombstones.folder?.mutationSeq,
			deletion.seq,
		);
		assert.equal(canonical.appliedMutationSeq.b, deletion.seq + 2);
		assert.equal(
			await restarted.client.getLogicalResource(
				"vault/folder/unchanged.md",
			),
			null,
		);
		await restarted.assertSettled({
			"extra.md": "later unrelated revision",
			"folder/changed.md": "remote child edit",
			"folder/new.md": "new child",
			"folder/recreated.md": "remote child version",
			[recreatedCopy]: "offline recreation",
			"note.md": "remote edit",
			[copy]: "offline edit",
		});
		assert.equal((await restarted.full()).conflicts, 0);
		assert.deepEqual(await restarted.canonical(), canonical);
	});

	test(`${mode} full preserves unpublished remote bytes during offline folder deletion`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		a.vault.put("folder/child.md", bytes("canonical child"));
		await a.full();
		await b.full();
		const before = await b.canonical();
		const path = await a.client.getPhysicalPath("vault/folder/child.md");
		const oldRaw = disk.files.get(path)!;
		b.vault.remove("folder");
		const deletion = b.index.enqueueMutation("delete-folder", "folder");
		await b.stop();
		await a.client.uploadFile(
			"vault/folder/child.md",
			bytes("remote bytes before commit"),
		);

		const sentStale = returnStaleDownloadOnce(disk, path, oldRaw);
		const interrupted = device(disk, "b", codec, b.vault, b.lastSaved());
		assert.equal((await interrupted.engine.fullSync()).success, false);
		assert.equal(sentStale(), true);
		assert.deepEqual(await interrupted.canonical(), before);
		interrupted.assertLocal("folder/child.md");
		assert.deepEqual(
			interrupted.lastSaved().pendingMutations.map(({ id }) => id),
			[deletion.id],
		);
		const saved = interrupted.crash();
		await a.client.uploadFile(
			"vault/folder/new.md",
			bytes("new physical child"),
		);
		const restarted = device(disk, "b", codec, b.vault, saved);
		await restarted.full();
		await restarted.assertSettled({
			"folder/child.md": "remote bytes before commit",
			"folder/new.md": "new physical child",
		});
		const canonical = await restarted.canonical();
		assert.equal(
			canonical.folderTombstones.folder?.mutationSeq,
			deletion.seq,
		);
		assert.equal(canonical.appliedMutationSeq.b, deletion.seq + 2);
		await restarted.full();
		assert.deepEqual(await restarted.canonical(), canonical);
	});

	for (const md5Only of [false, true]) {
		test(`${mode} full verifies a published folder survivor with ${md5Only ? "MD5" : "SHA-256"} metadata`, async (t) => {
			const device = managedDevices(t);
			const disk = new MemoryDisk();
			const codec = await codecFor(encrypted);
			const a = device(disk, "a", codec);
			const b = device(disk, "b", codec);
			const child = "folder/child.md";
			const rawPath = await a.client.getPhysicalPath(`vault/${child}`);
			if (md5Only) {
				const resource = disk.resource.bind(disk);
				disk.resource = async (path) => {
					const observed = await resource(path);
					return path === rawPath && observed?.type === "file"
						? {
								...observed,
								sha256: undefined,
								md5: createHash("md5")
									.update(Buffer.from(disk.files.get(path)!))
									.digest("hex"),
							}
						: observed;
				};
			}
			a.vault.put(child, bytes("old child"));
			await a.full();
			await b.full();
			const oldRaw = disk.files.get(rawPath)!;
			const oldResource = await disk.resource(rawPath);
			assert.ok(oldResource);
			b.vault.remove("folder");
			const deletion = b.index.enqueueMutation("delete-folder", "folder");
			await b.stop();
			a.vault.put(child, bytes("published edit"));
			await a.full();
			const before = await a.canonical();
			const publishedRaw = disk.files.get(rawPath)!;
			const pending = b.lastSaved().pendingMutations;
			assert.equal(pending[0]?.id, deletion.id);
			const interrupted = device(
				disk,
				"b",
				codec,
				b.vault,
				b.lastSaved(),
			);
			const request = disk.request.bind(disk);
			for (const staleMetadata of [false, true]) {
				let staleMetadataReads = 0;
				disk.request = async (params, accepted) => {
					const response = await request(params, accepted);
					const url = new URL(params.url);
					if (
						staleMetadata &&
						url.pathname.endsWith("/resources") &&
						url.searchParams
							.get("path")
							?.replace(/^disk:\//, "") === rawPath
					) {
						staleMetadataReads++;
						return { ...response, json: oldResource };
					}
					return response;
				};
				const sentStale = returnStaleDownloadOnce(
					disk,
					rawPath,
					oldRaw,
				);
				try {
					const result = await interrupted.engine.fullSync();
					assert.equal(sentStale(), true);
					assert.equal(staleMetadataReads, staleMetadata ? 2 : 0);
					assert.equal(result.success, false);
					assert.deepEqual(await interrupted.canonical(), before);
					assert.deepEqual(disk.files.get(rawPath), publishedRaw);
					interrupted.assertLocal(child);
					assert.deepEqual(
						interrupted.lastSaved().pendingMutations,
						pending,
					);
				} finally {
					disk.request = request;
				}
			}
			const saved = interrupted.crash();

			const restarted = device(disk, "b", codec, b.vault, saved);
			if (md5Only) {
				await a.client.uploadFile(
					`vault/${child}`,
					bytes("unpublished remote edit"),
				);
				const latestRaw = disk.files.get(rawPath)!;
				const sentCanonicalBytes = returnStaleDownloadOnce(
					disk,
					rawPath,
					publishedRaw,
				);
				assert.equal(
					(await restarted.engine.fullSync()).success,
					false,
				);
				assert.equal(sentCanonicalBytes(), true);
				restarted.assertLocal(child);
				assert.deepEqual(await restarted.canonical(), before);
				assert.deepEqual(
					restarted.lastSaved().pendingMutations,
					pending,
				);
				assert.deepEqual(disk.files.get(rawPath), latestRaw);
				disk.files.set(rawPath, publishedRaw);
			}

			await restarted.full();
			await restarted.assertSettled({ [child]: "published edit" });
			assert.equal(
				(await restarted.canonical()).files[child]?.sha256,
				before.files[child]?.sha256,
			);
			assert.deepEqual(disk.files.get(rawPath), publishedRaw);
		});
	}

	test(`${mode} full settles a recreation after a published folder deletion`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		a.vault.put("folder/recreated.md", bytes("old child"));
		a.vault.put("note.md", bytes("note base"));
		await a.full();
		await b.full();
		b.vault.remove("folder/recreated.md");
		const restore = failNextCanonicalReadback(disk);
		try {
			assert.equal((await b.engine.fullSync()).success, false);
		} finally {
			restore();
		}
		const deletion = b.index.getPendingMutations()[0];
		assert.equal(deletion?.type, "delete-file");
		b.vault.put("note.md", bytes("offline edit"));
		const saved = b.crash();
		a.vault.remove("folder");
		a.index.enqueueMutation("delete-folder", "folder");
		a.vault.put("note.md", bytes("remote edit"));
		await a.full();
		assert.equal(
			(await a.canonical()).files["folder/recreated.md"]?.deletedByFolder,
			"folder",
		);
		b.vault.put("folder/recreated.md", bytes("recreated offline"));

		const restarted = device(disk, "b", codec, b.vault, saved);
		assert.equal((await restarted.full()).conflicts, 1);
		const canonical = await restarted.canonical();
		const copy = Object.keys(canonical.files).find((path) =>
			path.startsWith("note_conflict_"),
		);
		assert.ok(copy);
		assert.equal(
			canonical.files["folder/recreated.md"]?.mutationSeq,
			deletion.seq + 1,
		);
		assert.equal(canonical.appliedMutationSeq.b, deletion.seq + 2);
		await restarted.assertSettled({
			"folder/recreated.md": "recreated offline",
			"note.md": "remote edit",
			[copy]: "offline edit",
		});
		assert.equal((await restarted.full()).conflicts, 0);
		assert.deepEqual(await restarted.canonical(), canonical);
	});

	for (const foreignEdit of [false, true]) {
		test(`${mode} unpublished recreation recovers after ${foreignEdit ? "a foreign edit" : "a remote ABA"}`, async (t) => {
			const device = managedDevices(t);
			const disk = new MemoryDisk();
			const codec = await codecFor(encrypted);
			const a = device(disk, "a", codec);
			const b = device(disk, "b", codec);
			const path = "recreated.md";
			a.vault.put(path, bytes("base"));
			a.vault.put("note.md", bytes("base note"));
			await a.full();
			await b.full();

			await interruptDeletion(disk, b, path);
			const savedDelete = b.crash();
			const deletion = savedDelete.pendingMutations[0]!;
			assert.equal(deletion.type, "delete-file");
			b.vault.put(path, bytes("local recreation"));
			b.vault.put("note.md", bytes("local note"));
			a.vault.put("note.md", bytes("remote note"));
			await a.full();

			const returning = device(disk, "b", codec, b.vault, savedDelete);
			const physical = await b.client.getPhysicalPath(`vault/${path}`);
			let admittedOriginal = false;
			let published = false;
			disk.beforeRequest = async (method, endpoint, target) => {
				if (
					method === "PUT" &&
					endpoint === "/upload" &&
					target === physical
				) {
					admittedOriginal = true;
				}
				if (
					endpoint.endsWith("/resources/move") &&
					target.includes(".lock.")
				) {
					disk.beforeRequest = undefined;
					a.vault.put(path, bytes("remote edit"));
					await a.full();
					if (!foreignEdit) {
						a.vault.put(path, bytes("base"));
						await a.full();
					}
					published = true;
				}
			};
			const interrupted = await returning.engine.fullSync();
			assert.equal(published, true);
			assert.equal(
				admittedOriginal,
				false,
				"recreation wrote before canonical arbitration",
			);
			assert.equal(interrupted.success, false);
			const saved = returning.crash();
			assert.deepEqual(
				saved.pendingMutations.map(({ seq, type }) => [seq, type]),
				[
					[deletion.seq, "delete-file"],
					[deletion.seq + 1, "put"],
				],
			);
			const restarted = device(disk, "b", codec, b.vault, saved);
			const result = await restarted.full();
			assert.equal(result.conflicts, foreignEdit ? 2 : 1);
			const canonical = await restarted.canonical();
			const noteCopy = Object.keys(canonical.files).find((key) =>
				key.startsWith("note_conflict_"),
			);
			assert.ok(noteCopy);
			const expected = {
				[path]: foreignEdit ? "remote edit" : "local recreation",
				"note.md": "remote note",
				[noteCopy]: "local note",
			};
			if (foreignEdit) {
				const copy = Object.keys(canonical.files).find((key) =>
					key.startsWith("recreated_conflict_"),
				);
				assert.ok(copy);
				expected[copy] = "local recreation";
			}
			await restarted.assertSettled(expected);
			assert.equal((await restarted.full()).conflicts, 0);
			assert.deepEqual(await restarted.canonical(), canonical);
			await a.full();
			await a.assertSettled(expected);
		});
	}

	test(`${mode} a late foreign edit waits for the locked recreation transfer`, async (t) => {
		const make = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = make(disk, "a", codec),
			b = make(disk, "b", codec);
		const path = "recreated.md";
		a.vault.put(path, bytes("base"));
		await a.full();
		await b.full();
		await interruptDeletion(disk, b, path);
		b.vault.put(path, bytes("local recreation"));
		const physical = await b.client.getPhysicalPath(`vault/${path}`);
		const admitted = deferred();
		const release = deferred();
		const waiting = deferred();
		let blocked = false;
		disk.beforeRequest = async (method, endpoint, target) => {
			if (
				method === "PUT" &&
				endpoint === "/upload" &&
				target === physical &&
				!blocked
			) {
				blocked = true;
				admitted.resolve();
				await release.promise;
			} else if (blocked && method === "GET") {
				waiting.resolve();
			}
		};
		const recreating = b.engine.fullSync();
		await admitted.promise;
		a.vault.put(path, bytes("late foreign"));
		const competing = a.engine.fullSync();
		try {
			await waiting.promise;
			assert.equal(
				disk.files.has("vault/.obsidian-sync-index.json"),
				false,
			);
		} finally {
			release.resolve();
		}
		assert.equal((await recreating).success, true);
		await competing;
		disk.beforeRequest = undefined;
		await a.full();
		const canonical = await a.canonical();
		const copy = Object.keys(canonical.files).find((key) =>
			key.startsWith("recreated_conflict_"),
		);
		assert.ok(copy);
		await b.full();
		const expected = { [path]: "local recreation", [copy]: "late foreign" };
		await a.assertSettled(expected);
		await b.assertSettled(expected);
	});

	test(`${mode} legacy recreation waits for the actual published winner bytes`, async (t) => {
		const make = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = make(disk, "a", codec),
			b = make(disk, "b", codec);
		const path = "recreated.md";
		a.vault.put(path, bytes("base"));
		await a.full();
		await b.full();
		await interruptDeletion(disk, b, path);
		b.vault.put(path, bytes("recreation"));
		a.vault.put(path, bytes("foreign winner"));
		await a.full();
		const winner = await a.canonical();
		// A pre-upgrade transfer left the physically present bytes different from canonical.
		await b.client.uploadFile(`vault/${path}`, bytes("recreation"));
		assert.equal((await b.engine.fullSync()).success, false);
		const saved = b.crash();
		const restarted = make(disk, "b", codec, b.vault, saved);
		assert.equal((await restarted.engine.fullSync()).success, false);
		assert.deepEqual(
			restarted.lastSaved().pendingMutations,
			saved.pendingMutations,
		);
		assert.deepEqual(
			saved.pendingMutations.map(({ type }) => type),
			["delete-file", "put"],
		);
		assert.deepEqual(await a.canonical(), winner);
		restarted.assertLocal(path, "recreation");
		const original = await a.adapter.readFile(path);
		await a.full();
		a.vault.put(path, original);
		await a.full();
		assert.equal((await restarted.full()).conflicts, 1);
		const canonical = await a.canonical();
		const copy = Object.keys(canonical.files).find((key) =>
			key.startsWith("recreated_conflict_"),
		);
		assert.ok(copy);
		await a.full();
		await a.assertSettled({
			[path]: "foreign winner",
			[copy]: "recreation",
		});
	});

	test(`${mode} partial recreation preserves a later local edit after a lost PUT response`, async (t) => {
		const make = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const b = make(disk, "b", codec);
		const path = "recreate.md";
		b.vault.put(path, bytes("base"));
		await b.full();
		await interruptDeletion(disk, b, path);
		b.vault.put(path, bytes("first recreation"));
		const physical = await b.client.getPhysicalPath(`vault/${path}`);
		disk.afterRequest = async (method, endpoint, target) => {
			if (
				method === "PUT" &&
				endpoint === "/upload" &&
				target === physical
			) {
				disk.afterRequest = undefined;
				b.vault.put(path, bytes("later recreation"));
				throw new Error("lost upload response");
			}
		};
		assert.equal((await b.engine.fullSync()).success, false);
		const saved = b.crash();
		assert.deepEqual(
			saved.pendingMutations.map(({ type }) => type),
			["delete-file", "put"],
		);
		b.assertLocal(path, "later recreation");
		const restarted = make(disk, "b", codec, b.vault, saved);
		await restarted.full();
		await restarted.assertSettled({ [path]: "later recreation" });
	});

	test(`${mode} a lost canonical lock cannot confirm an already admitted recreation PUT`, async (t) => {
		const make = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = make(disk, "a", codec),
			b = make(disk, "b", codec);
		const path = "recreate.md";
		a.vault.put(path, bytes("base"));
		await a.full();
		await b.full();
		await interruptDeletion(disk, b, path);
		b.vault.put(path, bytes("recreation"));
		const physical = await b.client.getPhysicalPath(`vault/${path}`);
		const canonicalPath = "vault/.obsidian-sync-index.json";
		disk.beforeRequest = async (method, endpoint, target) => {
			if (
				method === "PUT" &&
				endpoint === "/upload" &&
				target === physical
			) {
				disk.beforeRequest = undefined;
				const lock = [...disk.files.keys()].find((key) =>
					key.includes(".lock."),
				);
				assert.ok(lock);
				// Another owner has recovered the lock while the native request was in flight.
				await a.client.moveResourceExclusive(lock, canonicalPath);
				a.vault.put(path, bytes("foreign winner"));
				await a.full();
			}
		};
		assert.equal((await b.engine.fullSync()).success, false);
		const saved = b.crash();
		assert.deepEqual(
			saved.pendingMutations.map(({ type }) => type),
			["delete-file", "put"],
		);
		const restarted = make(disk, "b", codec, b.vault, saved);
		assert.equal((await restarted.engine.fullSync()).success, false);
		a.assertLocal(path, "foreign winner");
		restarted.assertLocal(path, "recreation");
		const original = await a.adapter.readFile(path);
		await a.full();
		assert.ok(
			[...a.vault.files].some(
				([key, content]) =>
					key.includes("/yandex-disk-sync/overwritten/") &&
					Buffer.from(content).equals(Buffer.from(original)),
			),
		);
		a.vault.put(path, original);
		await a.full();
		assert.equal((await restarted.full()).conflicts, 1);
		const published = await a.canonical();
		const copy = Object.keys(published.files).find((key) =>
			key.startsWith("recreate_conflict_"),
		);
		assert.ok(copy);
		await a.full();
		await a.assertSettled({
			[path]: "foreign winner",
			[copy]: "recreation",
		});
	});

	test(`${mode} full supersedes only a verified own interrupted upload`, async (t) => {
		const device = managedDevices(t);
		for (const scenario of [
			"own-sha",
			"own-md5",
			"foreign-md5",
			"stale-download",
			"missing-hash",
		]) {
			const disk = new MemoryDisk();
			const codec = await codecFor(encrypted);
			const a = device(disk, "a", codec);
			a.vault.put("note.md", bytes("base"));
			await a.full();
			const initial = await a.canonical();
			a.vault.put("note.md", bytes("interrupted edit"));
			const restore = failNextCanonicalReadback(disk);
			try {
				const aborted = await a.engine.fullSync();
				assert.equal(aborted.success, false);
				assert.equal(aborted.uploaded, 1);
			} finally {
				restore();
			}
			assert.deepEqual(await a.canonical(), initial);
			const saved = a.lastSaved();
			const predecessor = saved.pendingMutations[0]!;
			assert.equal(
				saved.localState.files["note.md"]?.mutationSeq,
				predecessor.seq,
			);
			assert.deepEqual(
				await a.client.downloadFile("vault/note.md"),
				bytes("interrupted edit"),
			);
			await a.stop();
			const foreignEdit =
				scenario === "foreign-md5" || scenario === "stale-download";
			const path = await a.client.getPhysicalPath("vault/note.md");
			const interruptedRaw = disk.files.get(path)!;
			if (foreignEdit) {
				const b = device(disk, "b", codec);
				await b.client.uploadFile(
					"vault/note.md",
					bytes("foreign edit"),
				);
			}
			let sentStale = () => false;
			const resource = disk.resource.bind(disk);
			if (scenario !== "own-sha") {
				disk.resource = async (candidate) => {
					const metadata = await resource(candidate);
					return metadata && candidate === path
						? {
								...metadata,
								sha256: undefined,
								md5:
									scenario === "missing-hash"
										? undefined
										: createHash("md5")
												.update(
													Buffer.from(
														disk.files.get(path)!,
													),
												)
												.digest("hex"),
							}
						: metadata;
				};
			}
			if (scenario === "stale-download") {
				sentStale = returnStaleDownloadOnce(disk, path, interruptedRaw);
			}
			a.vault.put("note.md", bytes("latest edit"), false);
			const restarted = device(disk, "a", codec, a.vault, saved);
			if (scenario === "stale-download" || scenario === "missing-hash") {
				const physical = disk.files.get(path)!;
				assert.equal(
					(await restarted.engine.fullSync()).success,
					false,
				);
				restarted.assertLocal("note.md", "latest edit");
				assert.deepEqual(await restarted.canonical(), initial);
				assert.deepEqual(disk.files.get(path), physical);
				assert.deepEqual(
					restarted.index.getPendingMutations(),
					saved.pendingMutations,
				);
				if (scenario === "missing-hash") {
					disk.resource = resource;
				}
			}
			assert.equal(
				(await restarted.full()).conflicts,
				Number(foreignEdit),
			);
			assert.equal(sentStale(), scenario === "stale-download");
			const canonical = await restarted.canonical();
			if (foreignEdit) {
				const copy = Object.keys(canonical.files).find((path) =>
					path.startsWith("note_conflict_"),
				);
				assert.ok(copy);
				assert.equal(
					canonical.files[copy]?.mutationSeq,
					predecessor.seq + 1,
				);
				assert.equal(
					canonical.appliedMutationSeq.a,
					predecessor.seq + 2,
				);
				await restarted.assertSettled({
					"note.md": "foreign edit",
					[copy]: "latest edit",
				});
			} else {
				assert.equal(
					canonical.appliedMutationSeq.a,
					predecessor.seq + 1,
				);
				await restarted.assertSettled({ "note.md": "latest edit" });
			}
			assert.equal((await restarted.full()).conflicts, 0);
			assert.deepEqual(await restarted.canonical(), canonical);
		}
	});

	test(`${mode} watcher replays rename with a queued put before full conflict`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		a.vault.put("before.md", bytes("rename base"));
		a.vault.put("note.md", bytes("note base"));
		await a.full();
		await b.full();
		a.vault.put("note.md", bytes("remote edit"));
		await a.full();
		const before = await b.canonical();

		b.vault.put("note.md", bytes("offline edit"), false);
		const edited = bytes("renamed edit");
		b.vault.put("before.md", edited, false);
		const put = b.index.enqueueMutation("put", "before.md", {
			sha256: await computeSha256(edited),
		});
		b.start();
		disk.beforeRequest = async (method, endpoint, path) => {
			if (
				method === "PUT" &&
				endpoint === "/upload" &&
				path.includes(".lock.")
			) {
				throw new Error("synthetic interrupted rename commit");
			}
		};
		try {
			b.vault.rename("before.md", "after.md");
			await b.drain();
		} finally {
			disk.beforeRequest = undefined;
		}
		const saved = b.crash();
		assert.equal(saved.pendingMutations[0]?.id, put.id);
		assert.ok(
			saved.pendingWatcherEvents.some(
				({ action }) => action === "rename",
			),
		);
		assert.deepEqual(await b.canonical(), before);

		const restarted = device(disk, "b", codec, b.vault, saved);
		restarted.start();
		await restarted.drain();
		assert.equal((await restarted.full()).conflicts, 1);
		const canonical = await restarted.canonical();
		const copy = Object.keys(canonical.files).find((path) =>
			path.startsWith("note_conflict_"),
		);
		assert.ok(copy);
		assert.equal(canonical.files["before.md"]?.deleted, true);
		assert.ok(canonical.files["after.md"]!.mutationSeq! > put.seq);
		assert.equal(
			canonical.appliedMutationSeq.b,
			canonical.files[copy]?.mutationSeq,
		);
		await restarted.assertSettled({
			"after.md": "renamed edit",
			"note.md": "remote edit",
			[copy]: "offline edit",
		});
		assert.equal((await restarted.full()).conflicts, 0);
		assert.deepEqual(await restarted.canonical(), canonical);
	});

	test(`${mode} first failed conflict stops later publication until restart`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		for (const path of ["first.md", "second.md"]) {
			a.vault.put(path, bytes("base"));
		}
		await a.full();
		await b.full();
		for (const path of ["first.md", "second.md"]) {
			a.vault.put(path, bytes(`remote ${path}`));
			b.vault.put(path, bytes(`offline ${path}`));
		}
		await a.full();
		const before = await a.canonical();
		const restore = failNextCanonicalReadback(disk);
		try {
			const aborted = await b.engine.fullSync();
			assert.equal(aborted.success, false);
			assert.equal(aborted.conflicts, 0);
		} finally {
			restore();
		}
		assert.deepEqual(await b.canonical(), before);
		b.assertLocal("first.md", "offline first.md");
		b.assertLocal("second.md", "offline second.md");
		const copies = [...b.vault.files.keys()].filter((path) =>
			path.includes("_conflict_"),
		);
		assert.equal(copies.length, 1);
		const interruptedCopy = copies[0]!;
		assert.deepEqual(
			b.lastSaved().pendingMutations.map(({ path }) => path),
			[interruptedCopy],
		);
		assert.ok(
			await b.client.getLogicalResource(`vault/${interruptedCopy}`),
		);
		const restarted = device(disk, "b", codec, b.vault, b.crash());
		assert.equal((await restarted.full()).conflicts, 2);
		const canonical = await restarted.canonical();
		const firstCopy = Object.keys(canonical.files).find((path) =>
			path.startsWith("first_conflict_"),
		);
		const secondCopy = Object.keys(canonical.files).find((path) =>
			path.startsWith("second_conflict_"),
		);
		assert.ok(firstCopy && secondCopy);
		assert.ok([firstCopy, secondCopy].includes(interruptedCopy));
		await restarted.assertSettled({
			"first.md": "remote first.md",
			"second.md": "remote second.md",
			[firstCopy]: "offline first.md",
			[secondCopy]: "offline second.md",
		});
		assert.equal((await restarted.full()).conflicts, 0);
		assert.deepEqual(await restarted.canonical(), canonical);
	});

	test(`${mode} full conflict settles verified predecessors before preserving a copy`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		a.vault.put("note.md", bytes("base"));
		await a.full();
		await b.full();
		a.vault.put("note.md", bytes("remote edit"));
		await a.full();
		b.vault.put("note.md", bytes("offline edit"));
		b.vault.put("extra.md", bytes("ordinary upload"));

		const result = await b.full();
		assert.equal(result.uploaded, 1);
		assert.equal(result.conflicts, 1);
		const canonical = await b.canonical();
		const copy = Object.keys(canonical.files).find((path) =>
			path.startsWith("note_conflict_"),
		);
		assert.ok(copy);
		assert.equal(
			canonical.appliedMutationSeq.b,
			canonical.files[copy]?.mutationSeq,
		);
		const expected = {
			"note.md": "remote edit",
			"extra.md": "ordinary upload",
			[copy]: "offline edit",
		};
		await b.assertSettled(expected);
		assert.equal((await b.full()).conflicts, 0);
		await a.full();
		await a.assertSettled(expected);
	});

	test(`${mode} full conflict waits for an unresolved move across restart`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		a.vault.put("note.md", bytes("base"));
		a.vault.put("before.md", bytes("renamed file"));
		a.vault.put("delete.md", bytes("deleted file"));
		await a.full();
		await b.full();
		a.vault.put("note.md", bytes("remote edit"));
		await a.full();
		const before = await b.canonical();
		const beforePhysical = [...disk.files.keys()];
		const move = b.index.enqueueMutation("move", "before.md", {
			targetPath: "after.md",
			resourceKind: "file",
		});
		b.vault.put("note.md", bytes("offline edit"));
		b.vault.put("extra.md", bytes("ordinary upload"));
		b.vault.remove("delete.md");

		const result = await b.engine.fullSync();
		assert.equal(result.deferred, true);
		assert.equal(result.success, false);
		assert.equal(result.conflicts, 0);
		assert.deepEqual(await b.canonical(), before);
		assert.deepEqual(
			[...disk.files.keys()].sort(),
			[
				...beforePhysical,
				await b.client.getPhysicalPath("vault/extra.md"),
			].sort(),
		);
		b.assertLocal("note.md", "offline edit");
		assert.equal(
			[...b.vault.files.keys()].some((path) =>
				path.includes("_conflict_"),
			),
			false,
		);
		const saved = b.lastSaved();
		assert.deepEqual(
			saved.pendingMutations.map(({ id, type, path }) => ({
				id,
				type,
				path,
			})),
			[
				{ id: move.id, type: "move", path: "before.md" },
				{ id: `b:${move.seq + 1}`, type: "put", path: "extra.md" },
			],
		);
		await b.stop();
		const restarted = device(disk, "b", codec, b.vault, saved);
		restarted.vault.rename("before.md", "after.md");
		await restarted.engine.renameFile("before.md", "after.md", {
			epoch: move.epoch,
			baseRevision: move.baseRevision,
		});
		assert.equal(
			(await restarted.canonical()).appliedMutationSeq.b,
			move.seq,
		);
		assert.deepEqual(
			restarted.index.getPendingMutations(),
			saved.pendingMutations.slice(1),
		);
		restarted.index.enqueueMutation("delete-file", "delete.md");
		assert.equal((await restarted.full()).conflicts, 1);
		const canonical = await restarted.canonical();
		const copy = Object.keys(canonical.files).find((path) =>
			path.startsWith("note_conflict_"),
		);
		assert.ok(copy);
		await restarted.assertSettled({
			"note.md": "remote edit",
			"after.md": "renamed file",
			"extra.md": "ordinary upload",
			[copy]: "offline edit",
		});
		assert.equal(
			await restarted.client.getLogicalResource("vault/delete.md"),
			null,
		);
	});

	test(`${mode} full compares content before preserving a conflict`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);

		a.vault.put("note.md", bytes("base"));
		await a.full();
		await b.full();
		b.vault.put("note.md", bytes("same edit"));
		a.vault.put("note.md", bytes("same edit"));
		await a.full();
		assert.equal((await b.full()).conflicts, 0);
		await b.assertSettled({ "note.md": "same edit" });

		await a.full();
		a.vault.put("note.md", bytes("temporary edit"));
		await a.full();
		a.vault.put("note.md", bytes("same edit"));
		await a.full();
		b.vault.put("note.md", bytes("useful edit"));
		assert.equal((await b.full()).conflicts, 0);
		await b.assertSettled({ "note.md": "useful edit" });

		await a.full();
		a.vault.put("folder/old.md", bytes("old child"));
		await a.full();
		await b.full();
		a.vault.remove("folder");
		await a.engine.deleteFolder("folder");
		await a.client.uploadFile(
			"vault/folder/new.md",
			bytes("same survivor"),
		);
		b.vault.put("folder/new.md", bytes("same survivor"));
		assert.equal((await b.full()).conflicts, 0);
		await b.assertSettled({
			"note.md": "useful edit",
			"folder/new.md": "same survivor",
		});
	});

	test(`${mode} changed fingerprint representation does not imply changed content`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const resource = disk.resource.bind(disk);
		let useSha = false;
		disk.resource = async (path) => {
			const result = await resource(path);
			if (
				result?.type === "file" &&
				!path.includes(".obsidian-sync-index") &&
				!useSha
			) {
				return {
					...result,
					sha256: undefined,
					md5: createHash("md5")
						.update(Buffer.from(disk.files.get(path)!))
						.digest("hex"),
				};
			}
			return result;
		};
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);

		a.vault.put("note.md", bytes("base"));
		await a.full();
		await b.full();
		useSha = true;
		b.vault.put("note.md", bytes("useful edit"));
		assert.equal((await b.full()).conflicts, 0);
		await b.assertSettled({ "note.md": "useful edit" });
		await a.client.uploadFile("vault/note.md", bytes("useful edit"));
		b.vault.put("note.md", bytes("next edit"));
		assert.equal((await b.full()).conflicts, 0);
		await b.assertSettled({ "note.md": "next edit" });
	});

	test(`${mode} timed out download stops queued work and ignores late bytes across restart`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec, undefined, undefined, {
			readTimeoutMs: 15,
		});
		b.settings.maxConcurrency = 1;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let restarted: ReturnType<typeof device> | undefined;
		let safetyTimer: ReturnType<typeof setTimeout> | undefined;
		let running: ReturnType<typeof b.engine.fullSync> | undefined;
		try {
			for (const path of ["a.md", "b.md", "c.md", "delete.md"]) {
				a.vault.put(path, bytes("base"));
			}
			await a.full();
			await b.full();
			for (const path of ["a.md", "b.md", "c.md"]) {
				a.vault.put(path, bytes("remote edit"));
			}
			a.vault.remove("delete.md");
			await a.full();
			const before = structuredClone(b.index.getLocalIndex().files);
			const userPaths = new Set(
				await Promise.all(
					["a.md", "b.md", "c.md"].map((path) =>
						b.client.getPhysicalPath(`vault/${path}`),
					),
				),
			);
			let userRequests = 0;
			disk.beforeRequest = async (_method, endpoint, path) => {
				if (endpoint === "/download" && userPaths.has(path)) {
					userRequests++;
					await gate;
				}
			};
			let sawInitialProgress = false;
			let sawEarlyError = false;
			b.engine.onStateChange((state) => {
				sawInitialProgress ||=
					state.phase === "applying" &&
					state.progress?.total === 4 &&
					state.progress.completed === 0;
				sawEarlyError ||=
					state.status === "syncing" &&
					/Remote read timed out/.test(state.errorMessage ?? "");
			});
			const failed = await Promise.race([
				(running = b.engine.fullSync()),
				new Promise<never>((_, reject) => {
					safetyTimer = setTimeout(
						() => reject(new Error("test safety deadline")),
						350,
					);
				}),
			]);
			assert.equal(failed.success, false);
			assert.equal(
				failed.downloaded + failed.deleted + failed.conflicts,
				0,
			);
			assert.equal(sawInitialProgress, true);
			assert.equal(sawEarlyError, true);
			assert.equal(
				userRequests,
				1,
				"Queued downloads must not start after timeout",
			);
			assert.deepEqual(b.index.getLocalIndex().files, before);
			const saved = b.crash();
			release();
			await new Promise((resolve) => setTimeout(resolve, 5));
			b.assertLocal("a.md", "base");
			assert.deepEqual(b.index.getLocalIndex().files, before);
			disk.beforeRequest = undefined;
			restarted = device(disk, "b", codec, b.vault, saved);
			assert.equal((await restarted.full()).conflicts, 0);
			await restarted.assertSettled({
				"a.md": "remote edit",
				"b.md": "remote edit",
				"c.md": "remote edit",
			});
		} finally {
			clearTimeout(safetyTimer);
			release();
			await running;
			disk.beforeRequest = undefined;
			await a.stop();
			await b.stop();
			await restarted?.stop();
		}
	});

	test(`${mode} failed download preserves baseline across restart without a false conflict`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		let restarted: ReturnType<typeof device> | undefined;

		a.vault.put("note.md", bytes("base"));
		await a.full();
		await b.full();
		a.vault.put("note.md", bytes("remote edit"));
		await a.full();
		const before = structuredClone(
			b.index.getLocalIndex().files["note.md"],
		);
		const original = await b.client.getPhysicalPath("vault/note.md");
		disk.beforeRequest = async (_method, endpoint, path) => {
			if (endpoint === "/download" && path === original) {
				throw new Error(
					"Request Failed. SocketException Software caused connection abort",
				);
			}
		};
		const failed = await b.engine.fullSync();
		assert.equal(failed.success, false);
		assert.equal(failed.downloaded, 0);
		b.assertLocal("note.md", "base");
		assert.deepEqual(b.index.getLocalIndex().files["note.md"], before);
		const saved = b.crash();
		disk.beforeRequest = undefined;
		restarted = device(disk, "b", codec, b.vault, saved);
		assert.equal((await restarted.full()).conflicts, 0);
		await restarted.assertSettled({ "note.md": "remote edit" });
	});

	test(`${mode} conflict retry preserves one copy across restart`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		let restarted: ReturnType<typeof device> | undefined;

		a.vault.put("note.md", bytes("base"));
		await a.full();
		await b.full();
		a.vault.put("note.md", bytes("remote edit"));
		await a.full();
		b.vault.put("note.md", bytes("local edit"));
		b.vault.put("extra.md", bytes("ordinary upload"));
		const original = await b.client.getPhysicalPath("vault/note.md");
		let progressDuringTransfer: number | undefined;
		disk.beforeRequest = async (_method, endpoint, path) => {
			if (
				endpoint === "/download" &&
				path === original &&
				[...b.vault.files.keys()].some((name) =>
					name.includes("_conflict_"),
				)
			) {
				progressDuringTransfer =
					b.engine.getState().progress?.completed;
				throw new Error("synthetic interrupted winner download");
			}
		};
		assert.equal((await b.engine.fullSync()).success, false);
		assert.equal(
			progressDuringTransfer,
			1,
			"Conflict is not complete while winner transfer is pending",
		);
		b.assertLocal("note.md", "local edit");
		const copies = [...b.vault.files.keys()].filter((path) =>
			path.includes("_conflict_"),
		);
		assert.equal(copies.length, 1);
		const saved = b.crash();
		disk.beforeRequest = undefined;
		restarted = device(disk, "b", codec, b.vault, saved);
		await restarted.full();
		await restarted.assertSettled({
			"note.md": "remote edit",
			"extra.md": "ordinary upload",
			[copies[0]!]: "local edit",
		});
	});
	test(`${mode} rejected copy commit cannot authorize replacing the original`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		let injected = false;

		a.vault.put("note.md", bytes("base"));
		await a.full();
		await b.full();
		a.vault.put("note.md", bytes("remote edit"));
		await a.full();
		b.vault.put("note.md", bytes("local edit"));
		disk.beforeRequest = async (_method, endpoint, path) => {
			const copy = [...b.vault.files.keys()].find((name) =>
				name.includes("_conflict_"),
			);
			if (
				injected ||
				!copy ||
				!endpoint.endsWith("/resources/move") ||
				!path.includes(".lock.")
			) {
				return;
			}
			injected = true;
			const canonical = await a.canonical();
			canonical.revision++;
			canonical.files[copy] = {
				path: copy,
				sha256: "tombstone",
				size: 0,
				mtime: 1,
				syncedAt: 1,
				deleted: true,
				deletedAt: 1,
				changedRevision: canonical.revision,
				baseRevision: canonical.revision - 1,
				lastModifiedBy: "c",
				mutationSeq: 1,
			};
			canonical.appliedMutationSeq.c = 1;
			const content = bytes(JSON.stringify(canonical));
			disk.files.set(
				"vault/.obsidian-sync-index.json",
				codec ? await codec.encrypt(content) : content,
			);
		};
		const result = await b.engine.fullSync();
		assert.equal(injected, true);
		assert.equal(result.success, false);
		b.assertLocal("note.md", "local edit");
		disk.beforeRequest = undefined;
		await b.full();
		const copies = [...b.vault.files.keys()].filter((name) =>
			name.startsWith("note_conflict_"),
		);
		assert.equal(copies.length, 1);
		await b.assertSettled({
			"note.md": "remote edit",
			[copies[0]!]: "local edit",
		});
	});

	test(`${mode} untracked-file conflict copy keeps its pending identity across restart`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		let restarted: ReturnType<typeof device> | undefined;

		await b.full();
		a.vault.put("note.md", bytes("remote edit"));
		await a.full();
		b.vault.put("note.md", bytes("local edit"));
		disk.beforeRequest = async (_method, endpoint, path) => {
			if (
				endpoint.endsWith("/resources/move") &&
				path.includes(".lock.") &&
				[...b.vault.files.keys()].some((name) =>
					name.includes("_conflict_"),
				)
			) {
				throw new Error("synthetic interrupted copy commit");
			}
		};
		assert.equal((await b.engine.fullSync()).success, false);
		const saved = b.crash();
		const copy = saved.pendingMutations.find((mutation) =>
			mutation.path.includes("_conflict_"),
		)!.path;
		assert.equal(
			saved.pendingMutations.filter((mutation) => mutation.path === copy)
				.length,
			1,
		);
		disk.beforeRequest = undefined;
		restarted = device(disk, "b", codec, b.vault, saved);
		assert.deepEqual(
			restarted.index.getPendingMutations(),
			saved.pendingMutations,
		);
		await restarted.full();
		await restarted.assertSettled({
			"note.md": "remote edit",
			[copy]: "local edit",
		});
	});

	test(`${mode} corrective upload stops when a newer winner arrives after copy commit`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		let injected = false;

		a.vault.put("note.md", bytes("accepted"));
		await a.full();
		await a.client.uploadFile("vault/note.md", bytes("external version"));
		const original = await a.client.getPhysicalPath("vault/note.md");
		disk.beforeRequest = async (_method, endpoint, path) => {
			if (
				injected ||
				!endpoint.endsWith("/resources/upload") ||
				path !== original ||
				![...a.vault.files.keys()].some((name) =>
					name.includes("_conflict_"),
				)
			) {
				return;
			}
			injected = true;
			const canonical: SyncIndex = await a.canonical();
			canonical.revision++;
			const content = bytes("new winner");
			await a.client.uploadFile("vault/note.md", content);
			const physical = await a.client.getLogicalResource("vault/note.md");
			canonical.files["note.md"] = {
				...canonical.files["note.md"]!,
				sha256: await computeSha256(content),
				remoteFingerprint: physical!.sha256,
				changedRevision: canonical.revision,
				lastModifiedBy: "c",
				mutationSeq: 1,
			};
			canonical.appliedMutationSeq.c = 1;
			const indexContent = bytes(JSON.stringify(canonical));
			disk.files.set(
				"vault/.obsidian-sync-index.json",
				codec ? await codec.encrypt(indexContent) : indexContent,
			);
		};
		const access = a.engine as unknown as {
			syncReconciliationDependencies(): Dependencies;
		};
		await assert.rejects(
			repairMissingAcceptedUploads(
				access.syncReconciliationDependencies(),
				["note.md"],
			),
		);
		assert.equal(injected, true);
		assert.deepEqual(
			await a.client.downloadFile("vault/note.md"),
			bytes("new winner"),
		);
		const copy = [...a.vault.files.keys()].find((name) =>
			name.includes("_conflict_"),
		)!;
		assert.deepEqual(
			await a.client.downloadFile(`vault/${copy}`),
			bytes("external version"),
		);
	});
}
