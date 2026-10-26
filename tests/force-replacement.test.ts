import { computeSha256 } from "../src/utils/hash-utils";
import assert from "node:assert/strict";
import test from "node:test";
import {
	applyForceReplacement,
	prepareForceReplacement,
	resumeForceReplacement,
} from "../src/sync/workflows/force-replacement";
import {
	assertForceRecovery,
	type ForceRecovery,
} from "../src/sync/workflows/force-state";
import { bytes, managedDevices, MemoryDisk } from "./helpers/sync-flow";

test("Force authenticates restricted encrypted targets and replaces old ciphertext without its key in full scope", async (context) => {
	const disk = new MemoryDisk();
	const make = managedDevices(context);
	const source = make(disk, "restricted-encrypted", null);
	source.settings.syncPatterns = ["*.md", "**/*.md"];
	source.settings.enableEncryption = true;
	source.settings.encryptionPassword = "synthetic-old-password";
	source.vault.put("note.md", bytes("old encrypted source"));
	const sourceDeps = {
		client: source.client,
		adapter: source.adapter,
		index: source.index,
		settings: source.settings,
		persist: async () => {},
		password: async () => null,
	};
	const seed = await prepareForceReplacement(sourceDeps, "from_local");
	assert.ok(seed?.codec);
	await applyForceReplacement(sourceDeps, seed, "without-backup");
	const oldPath = `vault/${await seed.codec.encryptFilename("note.md")}`;
	assert.equal(disk.files.has(oldPath), true);
	const owner = make(disk, "keyless-plaintext", null);
	owner.settings.syncPatterns = [];
	owner.vault.put("note.md", bytes("new plaintext source"));
	disk.files.set(
		"vault/.obsidian-sync-index.json",
		bytes("corrupt canonical"),
	);
	disk.files.set("vault/.obsidian-encrypt.json", bytes("corrupt manifest"));
	const deps = {
		...sourceDeps,
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
	};
	const plan = await prepareForceReplacement(deps, "from_local");
	assert.ok(plan);
	await applyForceReplacement(deps, plan, "without-backup");
	assert.equal(disk.files.has(oldPath), false);
	assert.equal(disk.files.has("vault/.obsidian-encrypt.json"), false);
	assert.deepEqual(
		disk.files.get("vault/note.md"),
		bytes("new plaintext source"),
	);
	assert.deepEqual(Object.keys((await owner.canonical()).files), ["note.md"]);
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
						chooseSourceMode: async () => "plaintext" as const,
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
			password: async () => "replacement-password",
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
		owner.settings.encryptionPassword = encrypted
			? "replacement-password"
			: null;
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
		const result = await owner.engine.forceSyncFromLocal({
			forceReplacement: {
				plan,
				backupMode: "without-backup",
			},
		});
		assert.equal(result.success, true, JSON.stringify(result.errors));
		assert.equal(owner.engine.isSyncPaused(), true);
		assert.equal(disk.files.has("vault/workspace.json"), false);
		assert.equal(disk.files.has("vault/" + excludedLongName), false);
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
		const seedDeps = {
			client: owner.client,
			adapter: owner.adapter,
			index: owner.index,
			settings: owner.settings,
			persist: async () => {},
			password: async () => "source-password",
		};
		const seed = await prepareForceReplacement(seedDeps, "from_local");
		assert.ok(seed);
		await applyForceReplacement(seedDeps, seed, "without-backup");
		const receiving = make(disk, "new-installation", null);
		receiving.vault.put("shape/old.md", bytes("old local destination"));
		receiving.vault.put("extra.md", bytes("discard me"));
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
			chooseSourceMode: async () => "plaintext" as const,
		};
		const plan = await prepareForceReplacement(deps, "from_remote");
		assert.ok(plan);
		receiving.engine.setForceReplacementPorts(deps);
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
		await receiving.full();
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
		chooseSourceMode: async () => "plaintext" as const,
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

test("Force encrypted source requires authenticated parameters and Cancel preserves the local destination", async (context) => {
	const disk = new MemoryDisk();
	const make = managedDevices(context);
	const source = make(disk, "encrypted-source", null);
	source.settings.enableEncryption = true;
	source.settings.encryptionPassword = "source-password";
	source.vault.put("note.md", bytes("encrypted source"));
	const sourceDeps = {
		client: source.client,
		adapter: source.adapter,
		index: source.index,
		settings: source.settings,
		persist: async () => {},
		password: async () => "source-password",
	};
	const seed = await prepareForceReplacement(sourceDeps, "from_local");
	assert.ok(seed);
	await applyForceReplacement(sourceDeps, seed, "without-backup");
	const target = make(disk, "source-reader", null);
	target.vault.put("local.md", bytes("keep local"));
	target.settings.enableEncryption = true;
	target.settings.encryptionSalt = source.settings.encryptionSalt;
	target.settings.encryptionProfileId = "hardened";
	target.settings.encryptionRevision = source.settings.encryptionRevision;
	target.settings.encryptionPassword = "incorrect-password";
	const deps = {
		client: target.client,
		adapter: target.adapter,
		index: target.index,
		settings: target.settings,
		persist: async () => {},
		password: async () => null,
		chooseSourceMode: async () => "encrypted" as const,
	};
	assert.equal(await prepareForceReplacement(deps, "from_remote"), null);
	target.assertLocal("local.md", "keep local");
	disk.files.delete("vault/.obsidian-encrypt.json");
	target.settings.enableEncryption = false;
	target.settings.encryptionPassword = null;
	target.settings.encryptionSalt = null;
	target.settings.encryptionProfileId = null;
	target.settings.encryptionRevision = null;
	await assert.rejects(
		prepareForceReplacement(deps, "from_remote"),
		/salt\/profile/,
	);
	target.settings.enableEncryption = true;
	target.settings.encryptionPassword = "source-password";
	target.settings.encryptionSalt = source.settings.encryptionSalt;
	target.settings.encryptionProfileId = "hardened";
	target.settings.encryptionRevision = source.settings.encryptionRevision;
	const recovered = await prepareForceReplacement(deps, "from_remote");
	assert.ok(recovered);
	target.assertLocal("local.md", "keep local");
	await applyForceReplacement(deps, recovered, "without-backup");
	target.assertLocal("local.md");
	target.assertLocal("note.md", "encrypted source");
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

test("completion receipt preserves successor revisions and new epoch mutations across local recovery", async (context) => {
	for (const boundary of ["receipt", "clear"] as const) {
		const disk = new MemoryDisk(),
			make = managedDevices(context),
			owner = make(disk, `receipt-${boundary}`, null);
		owner.vault.put("note.md", bytes("chosen"));
		let saved: ForceRecovery | null = null,
			fail = true;
		const deps = {
			client: owner.client,
			adapter: owner.adapter,
			index: owner.index,
			settings: owner.settings,
			password: async () => null,
			persist: async (state: ForceRecovery | null) => {
				if (state) {
					saved = structuredClone(state);
				}
				if (
					fail &&
					((boundary === "receipt" && state?.completion) ||
						(boundary === "clear" && state === null))
				) {
					fail = false;
					throw new Error("completion storage failure");
				}
				if (!state) {
					saved = null;
				}
			},
		};
		const plan = await prepareForceReplacement(deps, "from_local");
		assert.ok(plan);
		const partial = await applyForceReplacement(
			deps,
			plan,
			"without-backup",
		);
		assert.equal(partial.completed, false);
		assert.ok(partial.errors.length > 0);
		const checkpoint = JSON.parse(JSON.stringify(saved)) as ForceRecovery;
		assertForceRecovery(checkpoint);
		assert.ok(checkpoint.completion);
		const other = make(disk, `successor-${boundary}`, null);
		await other.full();
		other.vault.put("remote.md", bytes("new remote work"));
		await other.full();
		owner.vault.put("note.md", bytes("late source edit"));
		const queued =
			boundary === "clear"
				? owner.index.enqueueMutation("put", "note.md", {
						sha256: await computeSha256(bytes("late source edit")),
					})
				: null;
		const before = owner.index.getPendingMutations();
		const resumed = await resumeForceReplacement(deps, checkpoint);
		await applyForceReplacement(deps, resumed, checkpoint.backupMode);
		if (queued) {
			assert.deepEqual(owner.index.getPendingMutations(), before);
		}
		assert.equal(saved, null);
		await owner.full();
		owner.assertLocal("remote.md", "new remote work");
		owner.assertLocal("note.md", "late source edit");
		assert.deepEqual(
			disk.files.get("vault/note.md"),
			bytes("late source edit"),
		);
	}
});

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
		lastSyncStats: {},
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
