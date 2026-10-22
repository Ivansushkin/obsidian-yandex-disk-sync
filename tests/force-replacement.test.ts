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

test("Force refuses ambiguous raw destination scope before publication and during recovery", async (context) => {
	const make = managedDevices(context);
	for (const boundary of ["prepare", "confirm", "intent"] as const) {
		const disk = new MemoryDisk();
		const owner = make(disk, `scope-${boundary}`, null);
		owner.settings.syncPatterns = ["*.md", "**/*.md"];
		owner.vault.put("note.md", bytes("selected source"));
		owner.index.enqueueMutation("put", "queued.md", { sha256: "pending" });
		disk.files.set("vault/short", bytes("excluded short name"));
		const foreign = "0123456789abcdef0123456789abcdef";
		const addForeign = () => {
			disk.files.set(`vault/${foreign}`, bytes("excluded long name"));
		};
		let saved: ForceRecovery | null = null;
		let inject = boundary === "intent";
		const deps = {
			client: owner.client,
			adapter: owner.adapter,
			index: owner.index,
			settings: owner.settings,
			persist: async (state: ForceRecovery | null) => {
				saved = structuredClone(state);
				if (inject && state?.phase === "applying") {
					inject = false;
					addForeign();
				}
			},
			password: async () => null,
		};
		if (boundary === "prepare") {
			addForeign();
			await assert.rejects(
				prepareForceReplacement(deps, "from_local"),
				/Force destination scope is ambiguous/,
			);
		} else {
			const plan = await prepareForceReplacement(deps, "from_local");
			assert.ok(plan);
			if (boundary === "confirm") {
				addForeign();
			}
			await assert.rejects(
				applyForceReplacement(deps, plan, "without-backup"),
				/Force destination scope is ambiguous/,
			);
		}
		assert.deepEqual(
			disk.files.get(`vault/${foreign}`),
			bytes("excluded long name"),
		);
		assert.deepEqual(
			disk.files.get("vault/short"),
			bytes("excluded short name"),
		);
		assert.equal(disk.files.has("vault/note.md"), false);
		assert.equal(owner.index.getPendingMutations().length, 1);
		owner.assertLocal("note.md", "selected source");
		if (boundary !== "intent") {
			assert.equal(saved, null);
			assert.equal(
				disk.files.has("vault/.obsidian-sync-index.json"),
				false,
			);
			continue;
		}
		assert.ok(saved);
		const checkpoint = saved as ForceRecovery;
		assert.equal((await owner.canonical()).maintenance?.id, checkpoint.id);
		owner.settings.excludePatterns.push(foreign);
		const resumed = await resumeForceReplacement(deps, checkpoint);
		await applyForceReplacement(deps, resumed, "without-backup");
		assert.equal(saved, null);
		assert.equal((await owner.canonical()).epoch, checkpoint.epoch);
		assert.deepEqual(
			disk.files.get(`vault/${foreign}`),
			bytes("excluded long name"),
		);
		assert.deepEqual(
			disk.files.get("vault/note.md"),
			bytes("selected source"),
		);
	}
});

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
	test(`Force replacement ${encrypted ? "encrypted" : "plaintext"} rebuilds corrupt destination and survives JSON restart`, async (context) => {
		const disk = new MemoryDisk();
		const make = managedDevices(context);
		const current = make(disk, "force-owner", null);
		current.settings.enableEncryption = encrypted;
		current.settings.encryptionPassword = encrypted
			? "synthetic-force-password"
			: null;
		current.vault.put("note.md", bytes("source bytes"));
		disk.files.set(
			"vault/.obsidian-sync-index.json",
			bytes("broken destination"),
		);
		disk.files.set("vault/extra.md", bytes("obsolete destination"));
		disk.files.set("vault/.backup/keep", bytes("protected"));
		let recovery: ForceRecovery | null = null;
		const deps = {
			client: current.client,
			adapter: current.adapter,
			index: current.index,
			settings: current.settings,
			persist: async (value: ForceRecovery | null) => {
				recovery = JSON.parse(
					JSON.stringify(value),
				) as ForceRecovery | null;
			},
			password: async () => "synthetic-force-password",
		};
		const plan = await prepareForceReplacement(deps, "from_local");
		assert.ok(plan);
		let failed = false;
		disk.afterRequest = async (method, endpoint, path) => {
			if (
				!failed &&
				method === "PUT" &&
				endpoint === "/upload" &&
				path.includes(".payload.")
			) {
				failed = true;
				throw new Error("synthetic lost response");
			}
		};
		await applyForceReplacement(deps, plan, "without-backup");
		assert.equal(recovery, null);
		assert.equal(disk.files.has("vault/extra.md"), false);
		assert.deepEqual(
			disk.files.get("vault/.backup/keep"),
			bytes("protected"),
		);
		await current.index.loadRemoteIndex();
		assert.equal(current.index.getRemoteIndex().maintenance, undefined);
		assert.equal(
			current.index.getRemoteIndex().files["note.md"]?.mutationSeq,
			0,
		);
		const receiving = make(disk, "receiver", plan.codec);
		await receiving.full();
		receiving.assertLocal("note.md", "source bytes");
	});
}

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
		for (const boundary of [
			"prepared",
			"applying",
			"cleanup",
			"final",
		] as const) {
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
			await assert.rejects(
				applyForceReplacement(dependencies(), plan, "without-backup"),
				/synthetic/,
			);
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
		assert.deepEqual(
			disk.files.get("vault/workspace.json"),
			bytes("excluded workspace"),
		);
		assert.deepEqual(
			disk.files.get(`vault/${excludedLongName}`),
			bytes("excluded long name"),
		);
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
	await assert.rejects(
		applyForceReplacement(deps, plan, "without-backup"),
		/source changed/,
	);
	assert.deepEqual(
		disk.files.get("vault/keep.md"),
		bytes("protected by failed source proof"),
	);
	const fresh = await prepareForceReplacement(deps, "from_local");
	assert.ok(fresh);
	owner.settings.remotePath = "different-storage";
	await assert.rejects(
		applyForceReplacement(deps, fresh, "without-backup"),
		/configuration changed/,
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
		/listing/,
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
		/listing/,
	);
	assert.deepEqual(owner.vault.files, local);
	disk.beforeRequest = undefined;
	owner.settings.enableEncryption = true;
	owner.settings.encryptionPassword = null;
	assert.equal(await prepareForceReplacement(deps, "from_local"), null);
	assert.deepEqual(
		disk.files.get("vault/keep.md"),
		bytes("protected by failed source proof"),
	);
});

test("a superseded Force cannot overwrite the completed successor through a late upload", async (context) => {
	const disk = new MemoryDisk();
	const make = managedDevices(context);
	const old = make(disk, "old-force", null);
	const next = make(disk, "new-force", null);
	old.vault.put("note.md", bytes("old selected bytes"));
	next.vault.put("note.md", bytes("new selected bytes"));
	const dependencies = (current: typeof old) => ({
		client: current.client,
		adapter: current.adapter,
		index: current.index,
		settings: current.settings,
		persist: async () => {},
		password: async () => null,
	});
	const first = await prepareForceReplacement(
		dependencies(old),
		"from_local",
	);
	assert.ok(first);
	let superseded = false;
	disk.beforeRequest = async (method, endpoint, path) => {
		if (
			!superseded &&
			method === "PUT" &&
			endpoint === "/upload" &&
			(path === "vault/note.md" || path.includes(".payload."))
		) {
			superseded = true;
			const replacement = await prepareForceReplacement(
				dependencies(next),
				"from_local",
			);
			assert.ok(replacement);
			await applyForceReplacement(
				dependencies(next),
				replacement,
				"without-backup",
			);
		}
	};
	await assert.rejects(
		applyForceReplacement(dependencies(old), first, "without-backup"),
		/superseded/,
	);
	assert.equal(superseded, true);
	assert.deepEqual(
		disk.files.get("vault/note.md"),
		bytes("new selected bytes"),
	);
	assert.equal(
		[...disk.files.keys()].some((path) => path.includes(".payload.")),
		false,
	);
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

test("Force stops after three destination inventories and resumes without acknowledging old causal work", async (context) => {
	const disk = new MemoryDisk();
	const current = managedDevices(context)(disk, "bounded-force", null);
	current.vault.put("note.md", bytes("stable source"));
	current.index.enqueueMutation("put", "old.md", { sha256: "pending" });
	const queued = structuredClone(current.index.getPendingMutations());
	let recovery: ForceRecovery | null = null;
	const deps = {
		client: current.client,
		adapter: current.adapter,
		index: current.index,
		settings: current.settings,
		persist: async (state: ForceRecovery | null) => {
			recovery = structuredClone(state);
		},
		password: async () => null,
	};
	const plan = await prepareForceReplacement(deps, "from_local");
	assert.ok(plan);
	let passes = 0;
	disk.afterRequest = async (method, endpoint, path) => {
		if (
			method === "POST" &&
			endpoint.endsWith("/resources/move") &&
			path === "vault/note.md"
		) {
			passes++;
			disk.files.set(
				`vault/drift-${passes}.md`,
				bytes("destination drift"),
			);
		}
	};
	current.engine.setForceReplacementPorts(deps);
	const result = await current.engine.forceSyncFromLocal({
		forceReplacement: {
			plan,
			backupMode: "without-backup",
		},
	});
	assert.equal(result.success, false);
	assert.equal(passes, 3);
	assert.equal(current.index.getObservedEpoch(), null);
	assert.deepEqual(current.index.getPendingMutations(), queued);
	assert.ok(recovery);
	disk.afterRequest = undefined;
	const { resumeForceReplacement } =
		await import("../src/sync/workflows/force-replacement");
	const resumed = await resumeForceReplacement(
		deps,
		JSON.parse(JSON.stringify(recovery)) as ForceRecovery,
	);
	await applyForceReplacement(deps, resumed, "without-backup");
	assert.equal(recovery, null);
	assert.equal(current.index.getObservedEpoch(), plan.recovery.epoch);
	assert.deepEqual(current.index.getPendingMutations(), []);
});

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

test("Force final recovery verifies manifest and finishes its owned service cleanup", async (context) => {
	const make = managedDevices(context);
	const disk = new MemoryDisk();
	const owner = make(disk, "final-recovery", null);
	owner.settings.enableEncryption = true;
	owner.settings.encryptionPassword = "synthetic-final-password";
	owner.vault.put("note.md", bytes("source"));
	let saved: ForceRecovery | null = null;
	let failFinal = true;
	const deps = {
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		persist: async (value: ForceRecovery | null) => {
			if (value === null && failFinal) {
				throw new Error("synthetic final save failure");
			}
			saved = structuredClone(value);
		},
		password: async () => "synthetic-final-password",
	};
	const plan = await prepareForceReplacement(deps, "from_local");
	assert.ok(plan);
	await assert.rejects(
		applyForceReplacement(deps, plan, "without-backup"),
		/synthetic final save failure/,
	);
	assert.ok(saved);
	const manifest = disk.files.get("vault/.obsidian-encrypt.json")!;
	disk.files.set("vault/.obsidian-encrypt.json", bytes("damaged manifest"));
	failFinal = false;
	await assert.rejects(
		applyForceReplacement(deps, plan, "without-backup"),
		/Force final manifest changed/,
	);
	assert.ok(saved);
	disk.files.set("vault/.obsidian-encrypt.json", manifest);
	const orphan = `vault/.obsidian-sync-index.lock.${plan.recovery.id}.target`;
	disk.files.set(orphan, bytes("owned leftover"));
	await applyForceReplacement(deps, plan, "without-backup");
	assert.equal(saved, null);
	assert.equal(disk.files.has(orphan), false);
});

test("Force replaces nested empty folder trees with source files in both directions", async (context) => {
	const make = managedDevices(context);
	for (const direction of ["from_local", "from_remote"] as const) {
		const disk = new MemoryDisk();
		const owner = make(disk, "empty-folder-owner", null);
		if (direction === "from_local") {
			owner.vault.put("a", bytes("source"));
			disk.folders.add("vault/a");
			disk.folders.add("vault/a/b");
		} else {
			owner.vault.folder("a/b");
			disk.files.set("vault/a", bytes("source"));
		}
		const deps = {
			client: owner.client,
			adapter: owner.adapter,
			index: owner.index,
			settings: owner.settings,
			persist: async () => {},
			password: async () => null,
			chooseSourceMode: async () => "plaintext" as const,
		};
		const plan = await prepareForceReplacement(deps, direction);
		assert.ok(plan);
		await applyForceReplacement(deps, plan, "without-backup");
		if (direction === "from_local") {
			assert.deepEqual(disk.files.get("vault/a"), bytes("source"));
			assert.equal(disk.folders.has("vault/a/b"), false);
		} else {
			owner.assertLocal("a", "source");
			assert.equal(owner.vault.entries.has("a/b"), false);
		}
	}
});

test("Force archive snapshot failure offers retry or explicit replacement without copies", async (context) => {
	const { ForceSyncController } =
		await import("../src/sync/workflows/force-controller");
	const make = managedDevices(context);
	for (const decision of ["retry", "without-backup"] as const) {
		const disk = new MemoryDisk();
		const owner = make(disk, "archive-retry", null);
		owner.vault.put("note.md", bytes("source"));
		const dependencies = {
			client: owner.client,
			adapter: owner.adapter,
			index: owner.index,
			settings: owner.settings,
			persist: async () => {},
			password: async () => null,
		};
		const plan = await prepareForceReplacement(dependencies, "from_local");
		assert.ok(plan);
		let snapshotFailed = false;
		let prompted = false;
		const controller = new ForceSyncController({
			isSyncBusy: () => false,
			preflight: async () => ({
				replacement: { plan, dependencies, backupMode: "with-backup" },
				canonical: { state: "absent" },
				migration: false,
			}),
			confirm: async () => "with-backup",
			readyForBackup: async () => true,
			captureProtectedSnapshot: async () => {
				if (!snapshotFailed) {
					snapshotFailed = true;
					throw new Error("synthetic archive snapshot failure");
				}
				return "snapshot";
			},
			backupFailure: async () => {
				prompted = true;
				return decision;
			},
			backup: async () => ({
				success: true,
				backupName: "synthetic.zip",
				sha256: "proof",
				snapshotDigest: "snapshot",
				fileCount: 1,
				totalSize: 6,
			}),
			beforeMutation: async () => {},
			run: async (_direction, options) => {
				assert.equal(
					options.forceReplacement?.backupMode,
					decision === "retry" ? "with-backup" : "without-backup",
				);
				return {
					success: true,
					replacementCommitted: true,
					uploaded: 1,
					downloaded: 0,
					deleted: 0,
					conflicts: 0,
					errors: [],
					startTime: 1,
					endTime: 2,
				};
			},
			persist: async () => {},
			replacementCommitted: () => {},
			reconcile: async () => ({
				success: true,
				uploaded: 0,
				downloaded: 0,
				deleted: 0,
				conflicts: 0,
				errors: [],
				startTime: 1,
				endTime: 2,
			}),
			hasPendingCleanup: () => false,
			reportError: () => {},
		});
		await controller.run("from_local");
		assert.equal(prompted, true);
		assert.equal(controller.getState()?.outcome, "success");
	}
});
