import { computeSha256 } from "../src/utils/hash-utils";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
	applyForceReplacement,
	confirmForceReplacementPlan,
	prepareForceReplacement,
	resumeForceReplacement,
} from "../src/sync/workflows/force-replacement";
import {
	assertForceRecovery,
	type ForceRecovery,
} from "../src/sync/workflows/force-state";
import {
	bytes,
	codecFor,
	managedDevices,
	MemoryDisk,
	seedForceEncryption,
	type SavedDevice,
} from "./helpers/sync-flow";
import { encryptionFlow } from "./helpers/encryption-flow";

test("Force blocks collisions with unindexed local objects and refuses unsafe saved purges", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "hidden-force", null);
	owner.vault.put("note.md", bytes("remote content"));
	await owner.full();
	const deps = {
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		persist: async () => {},
		password: async () => null,
	};
	owner.vault.remove("note.md");
	const plan = await prepareForceReplacement(deps, "from_remote");
	assert.ok(plan?.recovery.direct);
	const recovery = plan.recovery;
	recovery.phase = "applying";
	delete recovery.direct!.trashExcluded;
	const trash = { path: ".TRASH", kind: "dir", location: "local" } as const;
	recovery.direct!.pendingDeletes.push(trash);
	await assert.rejects(resumeForceReplacement(deps, recovery), {
		name: "ForceRecoveryPendingError",
	});
	assert.deepEqual(recovery.direct!.pendingDeletes, [trash]);

	const lookup = owner.vault.getAbstractFileByPath.bind(owner.vault);
	owner.vault.getAbstractFileByPath = (path) =>
		path === "note.md/.hidden" ? null : lookup(path);
	owner.vault.folder("note.md");
	await assert.rejects(
		owner.adapter.deleteForcePath("note.md", async () => {
			owner.vault.put(
				"note.md/.hidden",
				bytes("arrived after admission"),
			);
		}),
		{ name: "ForceScopeConflictError" },
	);
	await assert.rejects(prepareForceReplacement(deps, "from_remote"), {
		name: "ForceScopeConflictError",
	});
	owner.assertLocal("note.md/.hidden", "arrived after admission");
});

test("Force rejects invalid new passwords and preserves saved legacy credentials", async (context) => {
	const make = managedDevices(context);
	for (const savedPassword of [null, "x", "я".repeat(40)]) {
		const disk = new MemoryDisk();
		const owner = make(disk, "password-owner", null);
		owner.settings.enableEncryption = true;
		owner.settings.encryptionPassword = savedPassword;
		owner.vault.put("Заметка.md", bytes("preserved content"));
		const deps = {
			client: owner.client,
			adapter: owner.adapter,
			index: owner.index,
			settings: owner.settings,
			persist: async () => {},
			password: async () => "🔐".repeat(4),
		};
		if (savedPassword === null) {
			const remote = structuredClone(disk.files);
			const local = structuredClone(owner.vault.files);
			const settings = structuredClone(owner.settings);
			await assert.rejects(
				prepareForceReplacement(
					{ ...deps, password: async () => "🔐".repeat(31) },
					"from_local",
				),
				/4.*30/,
			);
			assert.deepEqual(disk.files, remote);
			assert.deepEqual(owner.vault.files, local);
			assert.deepEqual(owner.settings, settings);
		}
		const plan = await prepareForceReplacement(deps, "from_local");
		assert.ok(plan);
		await applyForceReplacement(deps, plan, "without-backup");
		await owner.assertSettled({ "Заметка.md": "preserved content" });
		if (savedPassword?.length === 40) {
			const restarted = make(
				disk,
				"password-owner",
				null,
				owner.vault,
				await owner.saved(),
			);
			Object.assign(restarted.settings, structuredClone(owner.settings));
			await encryptionFlow(restarted).workflow.initEncryption();
			await restarted.assertSettled({
				"Заметка.md": "preserved content",
			});
		}
	}
});

test("scoped Force rejects unreadable destination encryption instead of deleting unknown excluded paths", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "scoped-destination", null);
	owner.settings.syncPatterns = ["*.md"];
	owner.vault.put("note.md", bytes("new plaintext source"));
	disk.files.set("vault/unknown-ciphertext", bytes("keep"));
	disk.files.set("vault/.obsidian-encrypt.json", bytes("corrupt manifest"));
	const before = new Map(disk.files);
	await assert.rejects(
		prepareForceReplacement(
			{
				client: owner.client,
				adapter: owner.adapter,
				index: owner.index,
				settings: owner.settings,
				persist: async () => {},
				password: async () => null,
			},
			"from_local",
		),
	);
	assert.deepEqual(disk.files, before);
	owner.assertLocal("note.md", "new plaintext source");
});

for (const encrypted of [false, true]) {
	test(`Force replacement matrix ${encrypted ? "encrypted" : "plaintext"} uses actual source including empty sides`, async (context) => {
		const make = managedDevices(context);
		for (const direction of ["from_local", "from_remote"] as const) {
			for (const sourceEmpty of [false, true]) {
				for (const destinationEmpty of [false, true]) {
					const disk = new MemoryDisk();
					const owner = make(disk, "matrix-owner", null);
					owner.settings.enableEncryption = encrypted;
					owner.settings.encryptionPassword = encrypted
						? "matrix-password"
						: null;
					const deps = {
						client: owner.client,
						adapter: owner.adapter,
						index: owner.index,
						settings: owner.settings,
						persist: async () => {},
						password: async () => "matrix-password",
					};
					if (direction === "from_remote") {
						if (!sourceEmpty) {
							owner.vault.put(
								"source/Юникод.md",
								bytes("selected source"),
							);
						}
						const seed = await prepareForceReplacement(
							deps,
							"from_local",
						);
						assert.ok(seed);
						await applyForceReplacement(
							deps,
							seed,
							"without-backup",
						);
						for (const path of [...owner.vault.files.keys()]) {
							owner.vault.remove(path);
						}
						if (!destinationEmpty) {
							owner.vault.put(
								"extra.md",
								bytes("destination only"),
							);
						}
						// Deliberately lose local history; physical source must still be authoritative.
						owner.index.loadLocalIndexFromData(null);
					} else {
						if (!sourceEmpty) {
							owner.vault.put(
								"source/Юникод.md",
								bytes("selected source"),
							);
						}
						if (!destinationEmpty) {
							disk.files.set(
								"vault/extra.md",
								bytes("destination only"),
							);
						}
						disk.files.delete("vault/.obsidian-sync-index.json");
					}
					const plan = await prepareForceReplacement(deps, direction);
					assert.ok(plan);
					await applyForceReplacement(deps, plan, "without-backup");
					await owner.index.loadRemoteIndex();
					assert.deepEqual(
						Object.keys(owner.index.getRemoteIndex().files),
						sourceEmpty ? [] : ["source/Юникод.md"],
					);
					if (direction === "from_remote") {
						owner.assertLocal("extra.md");
						if (!sourceEmpty) {
							owner.assertLocal(
								"source/Юникод.md",
								"selected source",
							);
						}
					} else {
						assert.equal(disk.files.has("vault/extra.md"), false);
						if (!sourceEmpty) {
							assert.deepEqual(
								await owner.client.downloadFile(
									"vault/source/Юникод.md",
								),
								bytes("selected source"),
							);
						}
					}
					assert.equal(owner.settings.enableEncryption, encrypted);
					assert.equal(owner.index.getPendingMutations().length, 0);
					assert.equal(
						owner.index.getLocalIndex().observedEpoch,
						plan.recovery.epoch,
					);
				}
			}
		}
	});
}

for (const encrypted of [false, true]) {
	test(`Force ${encrypted ? "encrypted" : "plaintext"} resumes the same operation after coherent checkpoint failures`, async (context) => {
		const make = managedDevices(context);
		for (const boundary of ["applying", "cleanup", "final"] as const) {
			const disk = new MemoryDisk();
			let current = make(disk, "recovery-owner", null);
			current.settings.enableEncryption = encrypted;
			current.settings.encryptionPassword = encrypted
				? "recovery-password"
				: null;
			current.vault.put("note.md", bytes("durable source"));
			let saved: ForceRecovery | null = null;
			let failed = false;
			const persist = async (value: ForceRecovery | null) => {
				if (boundary === "final" && value === null && !failed) {
					failed = true;
					throw new Error("synthetic final save failure");
				}
				saved = JSON.parse(
					JSON.stringify(value),
				) as ForceRecovery | null;
				if (!failed && value?.phase === boundary) {
					failed = true;
					throw new Error("synthetic checkpoint failure");
				}
			};
			const dependencies = () => ({
				client: current.client,
				adapter: current.adapter,
				index: current.index,
				settings: current.settings,
				persist,
				password: async () => "recovery-password",
			});
			const plan = await prepareForceReplacement(
				dependencies(),
				"from_local",
			);
			assert.ok(plan);
			try {
				const partial = await applyForceReplacement(
					dependencies(),
					plan,
					"without-backup",
				);
				assert.ok(partial.errors.length > 0);
			} catch (error) {
				assert.match(String(error), /synthetic/);
			}
			assert.equal(failed, true);
			assert.ok(saved);
			const checkpoint = JSON.parse(
				JSON.stringify(saved),
			) as ForceRecovery;
			assertForceRecovery(checkpoint);
			const old = await current.saved();
			current = make(disk, "recovery-owner", null, current.vault, old);
			const { resumeForceReplacement } =
				await import("../src/sync/workflows/force-replacement");
			const resumed = await resumeForceReplacement(
				dependencies(),
				checkpoint,
			);
			await applyForceReplacement(
				dependencies(),
				resumed,
				"without-backup",
			);
			assert.equal(resumed.recovery.id, plan.recovery.id);
			assert.equal(current.index.getObservedEpoch(), plan.recovery.epoch);
			assert.equal(saved, null);
			current.assertLocal("note.md", "durable source");
			await current.full();
		}
	});
}

for (const encrypted of [false, true]) {
	test(`Force ${encrypted ? "encrypted" : "plaintext"} without archive replaces collisions while paused and gates offline return`, async (context) => {
		const disk = new MemoryDisk();
		const make = managedDevices(context);
		const owner = make(disk, "replacement-owner", null);
		owner.settings.enableEncryption = encrypted;
		owner.settings.encryptionPassword = encrypted ? "first-password" : null;
		owner.vault.put("shape/old.md", bytes("old destination"));
		owner.vault.put("note.md", bytes("base"));
		const dependencies = () => ({
			client: owner.client,
			adapter: owner.adapter,
			index: owner.index,
			settings: owner.settings,
			persist: async () => {},
			password: async () => "first-password",
			watcherCutoff: () =>
				owner.watcher
					.getDeferredEvents()
					.flatMap((event) => (event.id ? [event.id] : [])),
			retireWatcherEvents: (ids: string[]) =>
				owner.watcher.settleForceReplacement(ids),
		});
		const seed = await prepareForceReplacement(
			dependencies(),
			"from_local",
		);
		assert.ok(seed);
		await applyForceReplacement(dependencies(), seed, "without-backup");
		const offline = make(disk, "offline-device", seed.codec);
		await offline.full();
		offline.vault.put("offline.md", bytes("offline bytes"));
		owner.vault.remove("shape/old.md");
		owner.vault.put("shape", bytes("file replaces folder"));
		owner.vault.put("note.md", bytes("selected source"));
		owner.index.enqueueMutation("put", "obsolete.md", {
			sha256: "obsolete",
		});
		owner.watcher.loadDeferredEvents([
			{
				id: "old-delete",
				action: "delete",
				path: "note.md",
				epoch: seed.recovery.epoch,
				baseRevision: 1,
				createdAt: 1,
			},
		]);
		owner.settings.encryptionPassword = encrypted ? "first-password" : null;
		disk.files.set(
			"vault/.obsidian-sync-index.json",
			bytes("corrupt index"),
		);
		disk.files.set("vault/workspace.json", bytes("excluded workspace"));
		const excludedLongName = "ExcludedPlaintextIdentifierWithoutExtension";
		owner.settings.excludePatterns = [
			...owner.settings.excludePatterns,
			excludedLongName,
		];
		disk.files.set(
			`vault/${excludedLongName}`,
			bytes("excluded long name"),
		);
		const oldBytes = new Set(disk.files.values());
		disk.beforeRequest = async (_method, endpoint, path) => {
			if (
				endpoint === "/download" &&
				!path.endsWith("/.obsidian-encrypt.json") &&
				oldBytes.has(disk.files.get(path)!)
			) {
				throw new Error(
					"Force read old destination content without an archive",
				);
			}
		};
		owner.adapter.backupOverwrittenFile = async () => {
			throw new Error("Force made an unwanted protective copy");
		};
		owner.engine.pause();
		owner.engine.setExternalBlock(
			"encryption",
			"stale destination encryption",
		);
		const plan = await prepareForceReplacement(
			dependencies(),
			"from_local",
		);
		assert.ok(plan);
		owner.engine.setForceReplacementPorts(dependencies());
		confirmForceReplacementPlan(plan);
		const result = await owner.engine.forceSyncFromLocal({
			forceReplacement: {
				plan,
				backupMode: "without-backup",
			},
		});
		assert.equal(result.success, true, JSON.stringify(result.errors));
		assert.equal(owner.engine.isSyncPaused(), true);
		assert.equal(disk.files.has("vault/workspace.json"), true);
		assert.equal(disk.files.has("vault/" + excludedLongName), true);
		assert.deepEqual(owner.index.getPendingMutations(), []);
		assert.deepEqual(owner.watcher.getDeferredEvents(), []);
		disk.beforeRequest = undefined;
		offline.client.setEncryptionService(plan.codec);
		offline.settings.excludePatterns = [...owner.settings.excludePatterns];
		const before = await offline.saved();
		const canonical = await owner.canonical();
		const gated = await offline.engine.fullSync();
		assert.equal(gated.errors[0]?.code, "epoch-decision-required");
		assert.deepEqual((await offline.saved()).localState, before.localState);
		offline.assertLocal("offline.md", "offline bytes");
		assert.equal((await owner.canonical()).revision, canonical.revision);
		const adopted = await offline.engine.fullSync({
			epochAdoption: { epoch: plan.recovery.epoch, decision: "preserve" },
		});
		assert.equal(adopted.success, true, JSON.stringify(adopted.errors));
		owner.engine.setExternalBlock("encryption", null);
		owner.engine.resume();
		await owner.full();
		owner.assertLocal("offline.md", "offline bytes");
	});
}

for (const encrypted of [false, true]) {
	test(`Force remote ${encrypted ? "encrypted" : "plaintext"} validates physical source before replacing local data without copies`, async (context) => {
		const disk = new MemoryDisk();
		const make = managedDevices(context);
		const owner = make(disk, "source-owner", null);
		owner.settings.enableEncryption = encrypted;
		owner.settings.encryptionPassword = encrypted
			? "source-password"
			: null;
		owner.vault.put("shape", bytes("remote source"));
		owner.vault.put(".TRASH/never-upload.md", bytes("trash"));
		owner.vault.put(
			"project/.trash/ordinary.md",
			bytes("ordinary nested path"),
		);
		const seedDeps = {
			client: owner.client,
			adapter: owner.adapter,
			index: owner.index,
			settings: owner.settings,
			persist: async () => {},
			password: async () => "source-password",
		};
		const seedRemote = async () => {
			const plan = await prepareForceReplacement(seedDeps, "from_local");
			assert.ok(plan);
			assert.equal(
				(await applyForceReplacement(seedDeps, plan, "without-backup"))
					.completed,
				true,
			);
		};
		await seedRemote();
		await owner.client.uploadFile(
			"vault/.trash/remote.md",
			bytes("legacy trash"),
		);
		const trash = await owner.client.getPhysicalPath(
			"vault/.trash/remote.md",
		);
		const preserved = disk.files.get(trash);
		assert.ok(preserved);
		disk.files.set("vault/.trash/raw.md", bytes("raw trash"));
		await seedRemote();
		const receiving = make(disk, "new-installation", null);
		receiving.vault.put("shape/old.md", bytes("old local destination"));
		receiving.vault.put("extra.md", bytes("discard me"));
		receiving.vault.put("mixed/.hidden", bytes("hidden"));
		receiving.vault.put("mixed/visible.md", bytes("obsolete"));
		const lookup = receiving.vault.getAbstractFileByPath.bind(
			receiving.vault,
		);
		receiving.vault.getAbstractFileByPath = (path) =>
			path === "mixed/.hidden" ? null : lookup(path);
		const trashFile = receiving.vault.trashFile.bind(receiving.vault);
		receiving.vault.trashFile = async (entry) => {
			if (entry.path === "extra.md") {
				receiving.vault.put(".trash/extra.md", bytes("discard me"));
			}
			await trashFile(entry);
		};
		const old = new Set(receiving.vault.files.values());
		const read = receiving.adapter.readFile.bind(receiving.adapter);
		receiving.adapter.readFile = async (path) => {
			if (old.has(receiving.vault.files.get(path)!)) {
				throw new Error(
					"Force read old local bytes without an archive",
				);
			}
			return await read(path);
		};
		receiving.adapter.backupOverwrittenFile = async () => {
			throw new Error("Unexpected protective copy");
		};
		const deps = {
			client: receiving.client,
			adapter: receiving.adapter,
			index: receiving.index,
			settings: receiving.settings,
			persist: async () => {},
			password: async () => "source-password",
		};
		const plan = await prepareForceReplacement(deps, "from_remote");
		assert.ok(plan);
		receiving.engine.setForceReplacementPorts(deps);
		confirmForceReplacementPlan(plan);
		const result = await receiving.engine.forceSyncFromRemote({
			forceReplacement: {
				plan,
				backupMode: "without-backup",
			},
		});
		assert.equal(result.success, true, JSON.stringify(result.errors));
		receiving.assertLocal("shape", "remote source");
		receiving.assertLocal("extra.md");
		assert.equal(receiving.settings.enableEncryption, encrypted);
		receiving.assertLocal("mixed/.hidden", "hidden");
		receiving.assertLocal("mixed/visible.md");
		receiving.assertLocal(".trash/extra.md", "discard me");
		await receiving.full();
		receiving.start();
		receiving.vault.put(".trash/realtime.md", bytes("do not upload"));
		await receiving.drain();
		assert.deepEqual(
			Object.keys((await receiving.canonical()).files).sort(),
			["project/.trash/ordinary.md", "shape"],
		);
		assert.deepEqual(disk.files.get(trash), preserved);
		assert.deepEqual(
			disk.files.get("vault/.trash/raw.md"),
			bytes("raw trash"),
		);
		assert.equal(
			disk.files.has(
				await owner.client.getPhysicalPath("vault/.trash/realtime.md"),
			),
			false,
		);
	});
}

test("Force source failure cancellation and storage drift cannot clear the destination", async (context) => {
	const disk = new MemoryDisk();
	const make = managedDevices(context);
	const owner = make(disk, "source-guard", null);
	owner.vault.put("note.md", bytes("source"));
	const deps = {
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		persist: async () => {},
		password: async () => null,
	};
	const plan = await prepareForceReplacement(deps, "from_local");
	assert.ok(plan);
	disk.files.set("vault/keep.md", bytes("protected by failed source proof"));
	owner.vault.put("note.md", bytes("changed source"));
	assert.equal(
		(await applyForceReplacement(deps, plan, "without-backup")).completed,
		true,
	);
	assert.deepEqual(disk.files.get("vault/note.md"), bytes("changed source"));
	assert.equal(disk.files.has("vault/keep.md"), false);
	const fresh = await prepareForceReplacement(deps, "from_local");
	assert.ok(fresh);
	owner.settings.remotePath = "different-storage";
	await assert.rejects(
		applyForceReplacement(deps, fresh, "without-backup"),
		/connection changed/,
	);
	owner.settings.remotePath = "vault";
	disk.beforeRequest = async (_method, endpoint) => {
		if (endpoint === "/download") {
			throw new Error("synthetic source read failure");
		}
	};
	const local = structuredClone(owner.vault.files);
	await assert.rejects(
		prepareForceReplacement(deps, "from_remote"),
		/source read failure/,
	);
	assert.deepEqual(owner.vault.files, local);
	disk.beforeRequest = undefined;
	const request = disk.request.bind(disk);
	disk.request = async (params) => {
		const response = await request(params);
		if (response.json.type === "dir") {
			delete response.json._embedded;
		}
		return response;
	};
	await assert.rejects(
		prepareForceReplacement(deps, "from_remote"),
		/listing|unavailable/,
	);
	assert.deepEqual(owner.vault.files, local);
	disk.request = request;
	disk.folders.add("vault/nested");
	disk.files.set("vault/nested/note.md", bytes("remote nested source"));
	disk.beforeRequest = async (method, endpoint, path) => {
		if (
			method === "GET" &&
			endpoint.endsWith("/resources") &&
			path === "vault/nested"
		) {
			disk.folders.delete("vault/nested");
		}
	};
	await assert.rejects(
		prepareForceReplacement(deps, "from_remote"),
		/listing|unavailable/,
	);
	assert.deepEqual(owner.vault.files, local);
	disk.beforeRequest = undefined;
	owner.settings.enableEncryption = true;
	owner.settings.encryptionPassword = null;
	assert.equal(await prepareForceReplacement(deps, "from_local"), null);
	assert.deepEqual(disk.files.get("vault/note.md"), bytes("changed source"));
});

for (const encrypted of [false, true]) {
	test(`recreated ${encrypted ? "encrypted" : "plaintext"} root keeps offline history through explicit binding and failed persistence`, async (context) => {
		const { StorageBindingController } =
			await import("../src/sync/local/storage-binding");
		const { EncryptionManager } =
			await import("../src/crypto/encryption-manager");
		const { prepareForceEpochConnection } =
			await import("../src/sync/workflows/force-replacement");
		const encryption = new EncryptionManager();
		const disk = new MemoryDisk();
		const resource = disk.resource.bind(disk);
		let generation = 0;
		disk.resource = async (path) => {
			const current = await resource(path);
			return current && path === "vault"
				? { ...current, resource_id: `root-generation-${generation}` }
				: current;
		};
		const make = managedDevices(context);
		const owner = make(disk, "root-owner", null);
		owner.settings.enableEncryption = encrypted;
		owner.settings.encryptionPassword = encrypted ? "root-password" : null;
		owner.vault.put("note.md", bytes("source bytes"));
		const dependencies = (current: typeof owner) => ({
			client: current.client,
			adapter: current.adapter,
			index: current.index,
			settings: current.settings,
			persist: async () => {},
			password: async () => "root-password",
		});
		const seed = await prepareForceReplacement(
			dependencies(owner),
			"from_local",
		);
		assert.ok(seed);
		await applyForceReplacement(
			dependencies(owner),
			seed,
			"without-backup",
		);
		const offline = make(disk, "old-root-device", seed.codec);
		await offline.full();
		offline.index.getLocalIndex().remoteScope = structuredClone(
			owner.index.getLocalIndex().remoteScope,
		);
		offline.vault.put("offline.md", bytes("offline preserved"));
		offline.index.enqueueMutation("put", "offline.md", {
			sha256: "pending-offline",
		});
		const before = offline.index.captureLocalCausalState();
		disk.files.clear();
		disk.folders.delete("vault");
		generation++;
		const fresh = await prepareForceReplacement(
			dependencies(owner),
			"from_local",
		);
		assert.ok(fresh);
		await applyForceReplacement(
			dependencies(owner),
			fresh,
			"without-backup",
		);
		let fail = true;
		const binding = new StorageBindingController({
			client: offline.client,
			index: offline.index,
			getSettings: () => offline.settings,
			hasPendingWork: () => true,
			hasTransition: () => false,
			isUnloaded: () => false,
			confirm: async (_path, _same, replacement) => {
				assert.equal(replacement, true);
				return "replacement";
			},
			persist: async () => {
				if (fail) {
					throw new Error("synthetic binding save failure");
				}
			},
			verifyReplacement: async () => {
				const proof = await prepareForceEpochConnection(
					dependencies(offline),
				);
				const prior = encryption.captureSnapshot(offline.settings);
				const apply = async (snapshot: typeof prior) => {
					offline.client.setEncryptionService(
						await encryption.applySnapshot(
							offline.settings,
							snapshot,
						),
					);
				};
				return {
					epoch: proof.epoch,
					apply: () => apply(proof.snapshot),
					rollback: () => apply(prior),
				};
			},
		});
		await assert.rejects(binding.ensure(true), /persistence failure/);
		assert.deepEqual(offline.index.captureLocalCausalState(), before);
		fail = false;
		assert.equal(await binding.ensure(true), true);
		assert.deepEqual(offline.index.getPendingMutations(), before.mutations);
		const gated = await offline.engine.fullSync();
		assert.equal(gated.errors[0]?.code, "epoch-decision-required");
		offline.assertLocal("offline.md", "offline preserved");
		const adopted = await offline.engine.fullSync({
			epochAdoption: {
				epoch: fresh.recovery.epoch,
				decision: "preserve",
			},
		});
		assert.equal(adopted.success, true, JSON.stringify(adopted.errors));
		await owner.full();
		owner.assertLocal("offline.md", "offline preserved");
	});
}

test("Force source manifest controls decoding and password retry without changing the destination", async (context) => {
	const disk = new MemoryDisk();
	const make = managedDevices(context);
	const source = make(disk, "encrypted-source", null);
	source.settings.enableEncryption = true;
	source.settings.encryptionPassword = "x";
	source.vault.put("note.md", bytes("encrypted source"));
	const sourceDeps = {
		client: source.client,
		adapter: source.adapter,
		index: source.index,
		settings: source.settings,
		persist: async () => {},
		password: async () => "x",
	};
	const seed = await prepareForceReplacement(sourceDeps, "from_local");
	assert.ok(seed);
	await applyForceReplacement(sourceDeps, seed, "without-backup");
	const target = make(disk, "source-reader", null);
	target.vault.put("local.md", bytes("keep local"));
	target.settings.enableEncryption = true;
	target.settings.encryptionPassword = "incorrect-password";
	const deps = {
		client: target.client,
		adapter: target.adapter,
		index: target.index,
		settings: target.settings,
		persist: async () => {},
		password: async (): Promise<string | null> => null,
	};
	assert.equal(await prepareForceReplacement(deps, "from_remote"), null);
	let attempts = 0;
	deps.password = async () => (++attempts === 1 ? "wrong-again" : "x");
	const authenticated = await prepareForceReplacement(deps, "from_remote");
	assert.ok(authenticated?.codec);
	assert.equal(attempts, 2);
	assert.equal(authenticated.recovery.source[0]?.path, "note.md");
	target.assertLocal("local.md", "keep local");

	const manifestPath = "vault/.obsidian-encrypt.json";
	const manifestBytes = disk.files.get(manifestPath)!;
	disk.files.delete(manifestPath);
	deps.password = async () => {
		throw new Error("Plaintext must not ask for a password");
	};
	const plain = await prepareForceReplacement(deps, "from_remote");
	assert.ok(plain);
	assert.equal(plain.codec, null);
	assert.equal(plain.recovery.target.enabled, false);
	assert.equal(target.settings.enableEncryption, true);
	target.assertLocal("local.md", "keep local");

	disk.files.set(manifestPath, bytes("invalid JSON"));
	await assert.rejects(applyForceReplacement(deps, plain, "without-backup"));
	target.assertLocal("local.md", "keep local");
	await assert.rejects(prepareForceReplacement(deps, "from_remote"));
	const readManifest = target.index.downloadEncryptionManifest.bind(
		target.index,
	);
	const unavailable = new Error("Synthetic manifest transport unavailable");
	target.index.downloadEncryptionManifest = async () => {
		throw unavailable;
	};
	await assert.rejects(
		prepareForceReplacement(deps, "from_remote"),
		unavailable,
	);
	target.index.downloadEncryptionManifest = readManifest;
	target.assertLocal("local.md", "keep local");
	disk.files.clear();
	const empty = await prepareForceReplacement(deps, "from_remote");
	assert.ok(empty);
	assert.equal(empty.recovery.source.length, 0);
	assert.equal(empty.recovery.target.enabled, false);
	target.assertLocal("local.md", "keep local");
	disk.files.set(manifestPath, manifestBytes);
	disk.beforeRequest = async (_method, endpoint, path) => {
		if (endpoint.endsWith("/resources/download") && path === manifestPath) {
			disk.files.delete(manifestPath);
		}
	};
	await assert.rejects(prepareForceReplacement(deps, "from_remote"));
	target.assertLocal("local.md", "keep local");
});

test("Force refuses an unreadable local source before preparation and after confirmation", async (context) => {
	const make = managedDevices(context);
	for (const boundary of ["prepare", "apply"] as const) {
		const disk = new MemoryDisk();
		const owner = make(disk, "unreadable-source", null);
		owner.vault.put("note.md", bytes("source"));
		disk.files.set("vault/note.md", bytes("only readable copy"));
		const deps = {
			client: owner.client,
			adapter: owner.adapter,
			index: owner.index,
			settings: owner.settings,
			persist: async () => {},
			password: async () => null,
		};
		const plan =
			boundary === "apply"
				? await prepareForceReplacement(deps, "from_local")
				: null;
		owner.vault.readBinary = async () => {
			throw new Error("synthetic unreadable local source");
		};
		await assert.rejects(
			boundary === "prepare"
				? prepareForceReplacement(deps, "from_local")
				: applyForceReplacement(deps, plan!, "without-backup"),
			/synthetic unreadable local source/,
		);
		assert.deepEqual(
			disk.files.get("vault/note.md"),
			bytes("only readable copy"),
		);
		assert.equal(disk.files.has("vault/.obsidian-sync-index.json"), false);
	}
});

test("Force rebuilds stale parent observations before direct uploads", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "cached-force", null);
	owner.vault.put("a.md", bytes("root source"));
	owner.vault.put("nested/b.md", bytes("nested source"));
	disk.folders.add("vault/nested");
	await owner.client.getResource("vault/nested", 1, 0, true);
	disk.folders.delete("vault/nested");
	let checkpoint: ForceRecovery | null = null;
	const deps = {
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		persist: async (state: ForceRecovery | null) => {
			checkpoint = structuredClone(state);
		},
		password: async () => null,
	};
	const plan = await prepareForceReplacement(deps, "from_local");
	assert.ok(plan);
	await applyForceReplacement(deps, plan, "without-backup");
	assert.equal(checkpoint, null);
	assert.deepEqual(disk.files.get("vault/a.md"), bytes("root source"));
	assert.deepEqual(
		disk.files.get("vault/nested/b.md"),
		bytes("nested source"),
	);
	assert.equal((await owner.canonical()).maintenance, undefined);
});

test("Force resumes final publication without replaying replacement after a source edit", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "cutover-owner", null);
	owner.vault.put("note.md", bytes("chosen source"));
	let saved: ForceRecovery | null = null;
	let fail = true;
	const deps = {
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		persist: async (state: ForceRecovery | null) => {
			if (state === null && fail) {
				fail = false;
				throw new Error("final save unavailable");
			}
			saved = structuredClone(state);
		},
		password: async () => null,
	};
	const plan = await prepareForceReplacement(deps, "from_local");
	assert.ok(plan);
	const partial = await applyForceReplacement(deps, plan, "without-backup");
	assert.equal(partial.completed, false);
	assert.ok(partial.errors.length > 0);
	assert.ok(saved);
	const checkpoint = structuredClone(saved) as ForceRecovery;
	owner.vault.put("note.md", bytes("late local edit"));
	const resumed = await resumeForceReplacement(deps, checkpoint);
	await applyForceReplacement(deps, resumed, checkpoint.backupMode);
	assert.equal(saved, null);
	owner.assertLocal("note.md", "late local edit");
	assert.deepEqual(disk.files.get("vault/note.md"), bytes("chosen source"));
	await owner.full();
	assert.deepEqual(disk.files.get("vault/note.md"), bytes("late local edit"));
});

/** Interrupt the plugin's coherent save before the failing write reaches durable storage. */
async function interruptForceFinalization(
	context: TestContext,
	encrypted: boolean,
	boundary: "receipt" | "clear",
) {
	const make = managedDevices(context);
	const disk = new MemoryDisk();
	const canonicalPath = "vault/.obsidian-sync-index.json";
	let owner = make(disk, "receipt-owner", null);
	owner.settings.enableEncryption = encrypted;
	owner.settings.encryptionPassword = encrypted ? "recovery-password" : null;
	owner.vault.put("note.md", bytes("chosen"));
	let durable:
		| {
				checkpoint: ForceRecovery | null;
				device: SavedDevice;
				settings: typeof owner.settings;
		  }
		| undefined;
	let interrupted = false;
	const savedReceipts: string[] = [];
	let maintenance: ArrayBuffer | undefined;
	const persist = async (state: ForceRecovery | null) => {
		if (
			!interrupted &&
			(boundary === "receipt" ? state?.completion : state === null)
		) {
			interrupted = true;
			throw new Error("completion storage failure");
		}
		if (state?.direct?.stage === "publishing" && !state.completion) {
			maintenance ??= disk.files.get(canonicalPath);
		}
		if (state?.completion) {
			savedReceipts.push(state.completion.canonicalSha256);
		}
		durable = {
			checkpoint: structuredClone(state),
			device: await owner.saved(),
			settings: structuredClone(owner.settings),
		};
	};
	const dependencies = () => ({
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		password: async () => null,
		persist,
		retireWatcherEvents: async () => {
			if (boundary === "clear" && !interrupted) {
				// A local edit commits its own snapshot after epoch adoption and before the failed clear.
				owner.vault.put("queued.md", bytes("late work"));
				owner.index.enqueueMutation("put", "queued.md", {
					sha256: await computeSha256(bytes("late work")),
				});
				await persist(durable!.checkpoint);
			}
		},
	});
	const plan = await prepareForceReplacement(dependencies(), "from_local");
	assert.ok(plan);
	const partial = await applyForceReplacement(
		dependencies(),
		plan,
		"without-backup",
	);
	assert.equal(partial.completed, false);
	assert.ok(partial.errors.length && interrupted);
	const lastWrite = () => {
		assert.ok(durable);
		return structuredClone(durable);
	};
	const saved = lastWrite();
	assert.ok(saved.checkpoint && maintenance);
	assertForceRecovery(saved.checkpoint);
	assert.equal(Boolean(saved.checkpoint.completion), boundary === "clear");
	assert.equal(saved.checkpoint.direct!.stage, "publishing");
	owner.crash();
	const restart = () => {
		owner = make(disk, "receipt-owner", null, owner.vault, saved.device);
		Object.assign(owner.settings, saved.settings);
		return owner;
	};
	const writes: string[] = [];
	return {
		disk,
		make,
		plan,
		saved,
		maintenance,
		canonicalPath,
		writes,
		savedReceipts,
		lastWrite,
		restartForFull() {
			const restarted = restart();
			restarted.engine.setForceReplacementPorts({
				...dependencies(),
				getRecovery: () => lastWrite().checkpoint,
			});
			return restarted;
		},
		get owner() {
			return owner;
		},
		observeWrites() {
			writes.length = 0;
			disk.beforeRequest = async (method, endpoint) => {
				if (method !== "GET") {
					writes.push(method + " " + endpoint);
				}
			};
		},
		async resume() {
			restart();
			const checkpoint = structuredClone(saved.checkpoint!);
			const resumed = await resumeForceReplacement(
				dependencies(),
				checkpoint,
			);
			return applyForceReplacement(
				dependencies(),
				resumed,
				checkpoint.backupMode,
			);
		},
	};
}

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";
	test(`ordinary full finishes ${mode} Force and receives the successor edit in one session`, async (context) => {
		const run = await interruptForceFinalization(
			context,
			encrypted,
			"receipt",
		);
		const other = run.make(run.disk, "successor", run.plan.codec);
		await other.full();
		other.vault.put("note.md", bytes("successor edit"));
		await other.full();
		const successor = await other.canonical();
		const before = new Map(run.disk.files);
		const restarted = run.restartForFull();
		restarted.assertLocal("note.md", "chosen");
		const result = await restarted.full();
		assert.equal(result.replacementCommitted, true);
		assert.equal(result.downloaded, 1);
		assert.equal(run.lastWrite().checkpoint, null);
		restarted.assertLocal("note.md", "successor edit");
		assert.equal(
			restarted.lastSaved().localState.observedRevision,
			successor.revision,
		);
		assert.equal(
			restarted.lastSaved().localState.files["note.md"]?.sha256,
			successor.files["note.md"]?.sha256,
		);
		assert.deepEqual(run.disk.files, before);
	});

	test(`Force ${mode} finalization preserves a successor edit after restart`, async (context) => {
		for (const boundary of ["receipt", "clear"] as const) {
			const run = await interruptForceFinalization(
				context,
				encrypted,
				boundary,
			);
			// The same logical revision must match the exact recorded bytes once a receipt is durable.
			if (boundary === "clear") {
				const original = run.disk.files.get(run.canonicalPath)!;
				const expected =
					await run.owner.index.readCanonicalIndexWithCodec(
						run.plan.codec,
					);
				const plain = bytes(JSON.stringify(expected));
				run.disk.files.set(
					run.canonicalPath,
					run.plan.codec
						? await run.plan.codec.encrypt(plain)
						: plain,
				);
				run.observeWrites();
				assert.equal((await run.resume()).completed, false);
				assert.ok(run.lastWrite().checkpoint);
				assert.deepEqual(run.writes, []);
				run.disk.files.set(run.canonicalPath, original);
				run.disk.beforeRequest = undefined;
			}
			const other = run.make(run.disk, "successor", run.plan.codec);
			await other.full();
			other.vault.put("note.md", bytes("successor edit"));
			await other.full();
			const successor = await other.canonical();
			const before = new Map(run.disk.files);
			const receipts = [...run.savedReceipts];
			run.observeWrites();
			assert.equal((await run.resume()).completed, true);
			assert.deepEqual(run.writes, []);
			assert.deepEqual(run.disk.files, before);
			assert.deepEqual(run.savedReceipts, receipts);
			assert.equal(run.lastWrite().checkpoint, null);
			const baseline = run.owner.index.getLocalIndex();
			assert.equal(
				baseline.files["note.md"]?.sha256,
				await computeSha256(bytes("chosen")),
			);
			assert.ok(baseline.observedRevision < successor.revision);
			assert.equal(
				run.owner.index.getRemoteIndex().revision,
				successor.revision,
			);
			if (boundary === "clear") {
				assert.equal(run.saved.device.pendingMutations.length, 1);
				assert.deepEqual(
					run.owner.index.getPendingMutations(),
					run.saved.device.pendingMutations,
				);
			}
			run.disk.beforeRequest = undefined;
			await run.owner.full();
			run.owner.assertLocal("note.md", "successor edit");
		}
	});

	test(`Force ${mode} preserves a successor after a lost final PUT response`, async (context) => {
		const make = managedDevices(context);
		for (const direction of ["from_local", "from_remote"] as const) {
			const disk = new MemoryDisk();
			const codec = await codecFor(encrypted);
			const owner = make(disk, "lost-response", codec);
			await seedForceEncryption(disk, owner, codec);
			owner.vault.put("note.md", bytes("chosen"));
			await owner.full();
			let publishing = false;
			let receipts = 0;
			const deps = {
				...owner,
				password: async () => null,
				persist: async (state: ForceRecovery | null) => {
					publishing = state?.direct?.stage === "publishing";
					await owner.saved();
					if (state?.completion) {
						receipts++;
					}
				},
			};
			owner.engine.setForceReplacementPorts(deps);
			const plan = await prepareForceReplacement(deps, direction, true);
			assert.ok(plan);
			confirmForceReplacementPlan(plan);
			const other = make(disk, "successor", plan.codec);
			const canonicalPath = "vault/.obsidian-sync-index.json";
			let successor: ArrayBuffer | undefined;
			disk.afterRequest = async (method, endpoint, path) => {
				if (
					!publishing ||
					method !== "PUT" ||
					endpoint !== "/upload" ||
					path !== canonicalPath
				) {
					return;
				}
				disk.afterRequest = undefined;
				await other.full();
				other.vault.put("note.md", bytes("successor edit"));
				await other.full();
				successor = disk.files.get(canonicalPath);
				throw new Error("Lost final PUT response");
			};
			const options = {
				forceReplacement: {
					plan,
					backupMode: "without-backup" as const,
				},
			};
			const result =
				direction === "from_local"
					? await owner.engine.forceSyncFromLocal(options)
					: await owner.engine.forceSyncFromRemote(options);
			assert.ok(successor);
			assert.deepEqual(disk.files.get(canonicalPath), successor);
			assert.equal(receipts, 0);
			assert.equal(result.success, true);
			const saved = owner.crash();
			assert.equal(
				saved.localState.files["note.md"]?.sha256,
				await computeSha256(bytes("chosen")),
			);
			const restarted = make(
				disk,
				"lost-response",
				codec,
				owner.vault,
				saved,
			);
			const next = await restarted.full();
			assert.deepEqual([next.uploaded, next.downloaded], [0, 1]);
			await other.full();
			await restarted.assertSettled({ "note.md": "successor edit" });
			await other.assertSettled({ "note.md": "successor edit" });
			assert.deepEqual(disk.files.get(canonicalPath), successor);
		}
	});

	test(`Force ${mode} finalization verifies its publication before resuming writes`, async (context) => {
		const run = await interruptForceFinalization(
			context,
			encrypted,
			"receipt",
		);
		const { disk, plan, canonicalPath, maintenance, saved } = run;
		const expected = await run.owner.index.readCanonicalIndexWithCodec(
			plan.codec,
		);
		const encode = async (index: typeof expected) => {
			const plain = bytes(JSON.stringify(index));
			return plan.codec ? plan.codec.encrypt(plain) : plain;
		};
		const prior = plan.codec
			? await plan.codec.decrypt(maintenance)
			: maintenance;
		const foreign = JSON.parse(
			new TextDecoder().decode(prior),
		) as typeof expected;
		foreign.maintenance!.id += "-other";
		const originals = new Map(disk.files);
		const manifest = "vault/.obsidian-encrypt.json";
		const lock = "vault/.obsidian-sync-index.lock.observer";
		const cases: Record<string, () => unknown> = {
			missing: () => disk.files.delete(canonicalPath),
			ambiguous: () => disk.files.set(lock, maintenance),
			epoch: async () =>
				disk.files.set(
					canonicalPath,
					await encode({ ...expected, epoch: "foreign" }),
				),
			equalRevisionConflict: async () =>
				disk.files.set(
					canonicalPath,
					await encode({ ...expected, lastSyncTime: 1 }),
				),
			olderOrdinaryRevision: async () =>
				disk.files.set(
					canonicalPath,
					await encode({
						...expected,
						revision: expected.revision - 1,
					}),
				),
			maintenance: async () =>
				disk.files.set(canonicalPath, await encode(foreign)),
			root: () => {
				saved.checkpoint!.rootResourceId = "other";
			},
			mode: () =>
				encrypted
					? disk.files.delete(manifest)
					: disk.files.set(manifest, bytes("unreadable")),
		};
		run.observeWrites();
		for (const [name, change] of Object.entries(cases)) {
			await change();
			const accepted = await run.resume().then(
				(result) => result.completed,
				() => false,
			);
			assert.equal(accepted, false, name);
			assert.deepEqual(run.writes, [], name);
			assert.ok(run.lastWrite().checkpoint, name);
			disk.files = new Map(originals);
			saved.checkpoint!.rootResourceId = plan.recovery.rootResourceId;
		}
		disk.files.set(canonicalPath, await encode(expected));
		assert.equal((await run.resume()).completed, true);
		assert.deepEqual(run.writes, []);
		disk.files.set(canonicalPath, maintenance);
		disk.afterRequest = async (method, endpoint) => {
			if (method === "GET" && endpoint.endsWith("/resources/upload")) {
				disk.files.set(lock, maintenance);
			}
		};
		assert.equal((await run.resume()).completed, false);
		assert.deepEqual(run.writes, []);
		assert.deepEqual(disk.files.get(canonicalPath), maintenance);
		disk.files.delete(lock);
		disk.afterRequest = async (method, endpoint, path) => {
			if (
				method === "PUT" &&
				endpoint === "/upload" &&
				path === canonicalPath
			) {
				disk.afterRequest = undefined;
				throw new Error("Lost final PUT response");
			}
		};
		assert.equal((await run.resume()).completed, true);
		assert.deepEqual(await run.owner.canonical(), expected);
		assert.equal(
			run.savedReceipts.at(-1),
			await computeSha256(disk.files.get(canonicalPath)!),
		);
	});
}

test("old current Force checkpoints normalize completion before persistence and invalid receipts fail closed", async (context) => {
	const { loadPluginData } = await import("../src/plugin-data-loader");
	const { persistenceHarness } = await import("./helpers/lifecycle-fixtures");
	const owner = managedDevices(context)(
		new MemoryDisk(),
		"checkpoint-loader",
		null,
	);
	const deps = {
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		persist: async () => {},
		password: async () => null,
	};
	const plan = await prepareForceReplacement(deps, "from_local");
	assert.ok(plan);
	const legacy = JSON.parse(JSON.stringify(plan.recovery)) as Omit<
		ForceRecovery,
		"completion"
	> & { completion?: ForceRecovery["completion"] };
	delete legacy.completion;
	const data = {
		format: "plugin-data",
		settings: owner.settings,
		...(await owner.saved()),
		encryptionTransition: null,
		forceRecovery: legacy as ForceRecovery,
	};
	assert.equal(loadPluginData(data)?.forceRecovery.completion, null);
	const { plugin, writes } = persistenceHarness(data);
	await plugin.loadSettings();
	await plugin.saveSettings();
	assert.equal(
		(writes.at(-1) as { forceRecovery: ForceRecovery }).forceRecovery
			.completion,
		null,
	);
	for (const completion of [
		undefined,
		{},
		{
			epoch: plan.recovery.epoch,
			revision: 1,
			canonicalSha256: "a".repeat(64),
			extra: true,
		},
		{ epoch: "other", revision: 1, canonicalSha256: "a".repeat(64) },
	]) {
		assert.throws(
			() =>
				loadPluginData({
					...data,
					forceRecovery: { ...legacy, completion } as ForceRecovery,
				}),
			/Force recovery/,
		);
	}
});

test("Force crosses pagination with zero bytes and deep Unicode paths then ordinary full converges", async (context) => {
	const make = managedDevices(context);
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk(),
			owner = make(disk, `paged-force-${encrypted}`, null);
		owner.settings.enableEncryption = encrypted;
		owner.settings.encryptionPassword = encrypted
			? "synthetic-password"
			: null;
		for (let i = 0; i < 1004; i++) {
			owner.vault.put(
				`${String(i).padStart(4, "0")}.md`,
				bytes("source"),
			);
		}
		owner.vault.put("zero.md", new ArrayBuffer(0));
		owner.vault.put(
			"Глубина/階層/notes/заметка.md",
			bytes("unicode source"),
		);
		const deps = {
			client: owner.client,
			adapter: owner.adapter,
			index: owner.index,
			settings: owner.settings,
			persist: async () => {},
			password: async () => "synthetic-password",
		};
		const plan = await prepareForceReplacement(deps, "from_local");
		assert.ok(plan);
		await applyForceReplacement(deps, plan, "without-backup");
		assert.equal(Object.keys((await owner.canonical()).files).length, 1006);
		assert.deepEqual(
			await owner.client.downloadFile("vault/zero.md"),
			new ArrayBuffer(0),
		);
		assert.deepEqual(
			await owner.client.downloadFile(
				"vault/Глубина/階層/notes/заметка.md",
			),
			bytes("unicode source"),
		);
		const result = await owner.engine.fullSync();
		assert.equal(result.success, true);
		assert.deepEqual(
			[result.uploaded, result.downloaded, result.deleted],
			[0, 0, 0],
		);
	}
});
