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
	managedDevices,
} from "./helpers/sync-flow";

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
	const saved = await phone.saved();
	assert.equal(saved.localState.lastSyncTime, 0);
	assert.equal(saved.pendingPhysicalActions.length, 1);
	phone.assertLocal("deleted.md", "old");
	await phone.stop();
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
		const saved = await phone.saved();
		assert.equal(saved.localState.lastSyncTime, 0);
		assert.equal(saved.localState.observedRevision, 0);
		assert.deepEqual(saved.pendingMutations, []);
		await phone.stop();
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
			const persist = async () => {
				if (
					failure === "save" &&
					phone.index.getLocalIndex().lastSyncTime > 0
				) {
					throw new Error("synthetic save failure");
				}
			};
			phone.engine.setIndexSaveCallback(persist);
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
			const saved = await b.saved();
			release();
			await new Promise((resolve) => setTimeout(resolve, 5));
			b.assertLocal("a.md", "base");
			assert.deepEqual(b.index.getLocalIndex().files, before);
			await b.stop();
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
		const saved = await b.saved();
		await b.stop();
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
			0,
			"Conflict is not complete while winner transfer is pending",
		);
		const copies = [...b.vault.files.keys()].filter((path) =>
			path.includes("_conflict_"),
		);
		assert.equal(copies.length, 1);
		const saved = await b.saved();
		await b.stop();
		disk.beforeRequest = undefined;
		restarted = device(disk, "b", codec, b.vault, saved);
		await restarted.full();
		await restarted.assertSettled({
			"note.md": "remote edit",
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
		const saved = await b.saved();
		const copy = saved.pendingMutations.find((mutation) =>
			mutation.path.includes("_conflict_"),
		)!.path;
		assert.equal(
			saved.pendingMutations.filter((mutation) => mutation.path === copy)
				.length,
			1,
		);
		await b.stop();
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
