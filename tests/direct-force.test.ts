import assert from "node:assert/strict";
import test from "node:test";
import { EncryptionManager } from "../src/crypto/encryption-manager";
import {
	applyForceReplacement,
	confirmForceReplacementPlan,
	prepareForceReplacement,
	resumeForceReplacement,
} from "../src/sync/workflows/force-replacement";
import type { ForceRecovery } from "../src/sync/workflows/force-state";
import { deferred } from "./helpers/deferred";
import {
	bytes,
	codecFor,
	managedDevices,
	MemoryDisk,
	seedForceEncryption,
} from "./helpers/sync-flow";

test("Force rejects missing, unconfirmed and opposite-direction plans before storage access", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "force-entry", null);
	owner.vault.put("local.md", bytes("local"));
	await owner.full();
	disk.files.set("vault/remote.md", bytes("remote"));
	const beforeLocal = structuredClone(owner.vault.files);
	const beforeRemote = structuredClone(disk.files);
	const beforeState = await owner.saved();
	const writes: (ForceRecovery | null)[] = [];
	const ports = {
		persist: async (state: ForceRecovery | null) => {
			writes.push(structuredClone(state));
		},
		password: async () => null,
	};
	owner.engine.setForceReplacementPorts(ports);
	const deps = { ...owner, ...ports };
	const local = await prepareForceReplacement(deps, "from_local");
	const remote = await prepareForceReplacement(deps, "from_remote", true);
	assert.ok(local && remote);

	const requests: string[] = [];
	disk.beforeRequest = async (method, endpoint) => {
		requests.push(`${method} ${endpoint}`);
	};
	const run = (
		direction: "from_local" | "from_remote",
		plan?: typeof local,
	) => {
		const options = plan
			? {
					forceReplacement: {
						plan,
						backupMode: "without-backup" as const,
					},
				}
			: undefined;
		return direction === "from_local"
			? owner.engine.forceSyncFromLocal(options)
			: owner.engine.forceSyncFromRemote(options);
	};
	// Without this check, an unconfirmed or swapped plan can replace the destination.
	assert.equal((await run("from_local", local)).success, false);
	assert.equal((await run("from_remote", remote)).success, false);
	confirmForceReplacementPlan(local);
	confirmForceReplacementPlan(remote);
	const missingArchive = await owner.engine.forceSyncFromLocal({
		forceReplacement: { plan: local, backupMode: "with-backup" },
	});
	assert.equal(missingArchive.success, false);
	for (const [direction, opposite] of [
		["from_local", remote],
		["from_remote", local],
	] as const) {
		for (const plan of [undefined, opposite]) {
			const result = await run(direction, plan);
			assert.equal(result.success, false);
			assert.equal(result.errors.length, 1);
		}
	}
	assert.deepEqual(requests, []);
	assert.deepEqual(writes, []);
	assert.deepEqual(disk.files, beforeRemote);
	assert.deepEqual(owner.vault.files, beforeLocal);
	assert.deepEqual(await owner.saved(), beforeState);
});

test("direct Force applies the configured scope without temporary files or destination history", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "direct-source", null);
	owner.vault.configDir = "custom-config";
	owner.settings.syncPatterns = ["*.md"];
	owner.settings.excludePatterns = ["excluded/**"];
	owner.vault.put("selected.md", bytes("selected"));
	owner.vault.put("excluded/settings.json", bytes("excluded local"));
	owner.vault.put("custom-config/config.json", bytes("configuration"));
	owner.vault.put(
		"custom-config/plugins/yandex-disk-sync/data.json",
		bytes("synthetic-private-state"),
	);
	disk.files.set("vault/.obsidian-sync-index.json", bytes("broken metadata"));
	disk.files.set(
		"vault/.obsidian-sync-index.lock.foreign",
		bytes("broken lock"),
	);
	disk.files.set("vault/garbage.bin", bytes("keep excluded"));
	disk.files.set("vault/obsolete.md", bytes("discard"));
	disk.folders.add("vault/excluded");
	disk.folders.add("vault/excluded/settings.json");
	disk.folders.add("vault/.backup");
	disk.files.set("vault/.backup/archive.zip", bytes("keep"));
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
	disk.beforeRequest = async (method, endpoint, path) => {
		if (method !== "GET" && method !== "DELETE") {
			assert.ok(
				!path.includes(".obsidian-sync-index.lock."),
				`Force created a temporary path: ${path}`,
			);
			assert.ok(!endpoint.endsWith("/move"), "Force used staging MOVE");
		}
	};
	await applyForceReplacement(deps, plan, "without-backup");
	assert.deepEqual(
		[...disk.files.keys()].sort(),
		[
			"vault/.backup/archive.zip",
			"vault/.obsidian-sync-index.json",
			"vault/garbage.bin",
			"vault/selected.md",
		].sort(),
	);
	assert.deepEqual(disk.files.get("vault/selected.md"), bytes("selected"));
	assert.equal((await owner.canonical()).maintenance, undefined);
	assert.deepEqual(owner.index.getPendingMutations(), []);
	disk.beforeRequest = undefined;
	const full = await owner.full();
	assert.deepEqual([full.uploaded, full.downloaded, full.deleted], [0, 0, 0]);
	assert.deepEqual(Object.keys((await owner.canonical()).files), [
		"selected.md",
	]);
});

test("ordinary full leaves a prepared Force untouched until a new scoped confirmation", async (context) => {
	const make = managedDevices(context);
	const disk = new MemoryDisk();
	const owner = make(disk, "prepared-direct", null);
	owner.settings.syncPatterns = ["*.md"];
	owner.vault.put("selected.md", bytes("chosen source"));
	const canonicalPath = "vault/.obsidian-sync-index.json";
	const oldCanonical = bytes("previous canonical");
	disk.files.set(canonicalPath, oldCanonical);
	disk.files.set("vault/excluded.bin", bytes("keep excluded"));
	disk.files.set("vault/obsolete.md", bytes("discard after confirmation"));
	const ports = {
		persist: async (state: ForceRecovery | null) => {
			saved = structuredClone(state);
		},
		getRecovery: () => saved,
		password: async () => null,
	};
	let saved: ForceRecovery | null = null;
	const prepared = await prepareForceReplacement(
		{ ...owner, ...ports },
		"from_local",
	);
	assert.ok(prepared?.recovery.direct);
	delete prepared.recovery.direct.trashExcluded;
	saved = JSON.parse(JSON.stringify(prepared.recovery)) as ForceRecovery;
	const old = structuredClone(saved);
	const restarted = make(
		disk,
		"prepared-direct",
		null,
		owner.vault,
		await owner.saved(),
	);
	restarted.settings.syncPatterns = ["*.md"];
	restarted.engine.setForceReplacementPorts(ports);
	const writes: string[] = [];
	disk.beforeRequest = async (method, _endpoint, path) => {
		if (method !== "GET") {
			writes.push(path);
		}
	};
	const outcome = await restarted.full().catch((error: unknown) => error);
	assert.deepEqual(writes, []);
	assert.ok(outcome instanceof Error);
	assert.equal(outcome.name, "ForceRecoveryPendingError");
	assert.deepEqual(saved, old);
	assert.equal(restarted.index.getObservedEpoch(), null);
	assert.deepEqual(disk.files.get(canonicalPath), oldCanonical);

	const deps = { ...restarted, ...ports };
	const fresh = await prepareForceReplacement(deps, "from_local", true);
	assert.ok(fresh);
	confirmForceReplacementPlan(fresh);
	const result = await applyForceReplacement(deps, fresh, "without-backup");
	assert.equal(result.completed, true);
	assert.equal(saved, null);
	const canonical = await restarted.canonical();
	assert.equal(canonical.epoch, fresh.recovery.epoch);
	assert.notEqual(canonical.epoch, old.epoch);
	assert.deepEqual(Object.keys(canonical.files), ["selected.md"]);
	assert.deepEqual(
		disk.files.get("vault/excluded.bin"),
		bytes("keep excluded"),
	);
	assert.equal(disk.files.has("vault/obsolete.md"), false);
});

test("ordinary full resumes a partial direct Force after JSON restart without deleting its completed files again", async (context) => {
	const make = managedDevices(context);
	const disk = new MemoryDisk();
	const owner = make(disk, "partial-direct", null);
	owner.vault.configDir = "custom-config";
	owner.vault.put("a.md", bytes("first"));
	owner.vault.put("b.md", bytes("second"));
	owner.settings.syncPatterns = ["*.md"];
	disk.files.set("vault/excluded.bin", bytes("keep excluded"));
	disk.files.set("vault/obsolete.md", bytes("old"));
	let saved: ForceRecovery | null = null;
	const ports = {
		persist: async (state: ForceRecovery | null) => {
			saved = structuredClone(state);
		},
		getRecovery: () => saved,
		password: async () => null,
	};
	const deps = {
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		...ports,
	};
	const plan = await prepareForceReplacement(deps, "from_local");
	assert.ok(plan);
	disk.beforeRequest = async (method, endpoint, path) => {
		if (
			method === "PUT" &&
			endpoint === "/upload" &&
			path === "vault/a.md"
		) {
			throw new Error("synthetic transfer failure");
		}
	};
	await applyForceReplacement(deps, plan, "without-backup");
	assert.ok(saved);
	assert.deepEqual(disk.files.get("vault/b.md"), bytes("second"));
	const restarted = make(
		disk,
		"partial-direct",
		null,
		owner.vault,
		await owner.saved(),
	);
	restarted.settings.syncPatterns = ["*.bin"];
	restarted.engine.setForceReplacementPorts(ports);
	disk.beforeRequest = async (method, _endpoint, path) => {
		assert.ok(
			!(
				method === "DELETE" &&
				["vault/b.md", "vault/excluded.bin"].includes(path)
			),
			"Continuation repeated the full purge",
		);
	};
	await restarted.full();
	assert.equal(saved, null);
	restarted.assertLocal("a.md", "first");
	restarted.assertLocal("b.md", "second");
	assert.deepEqual(
		disk.files.get("vault/excluded.bin"),
		bytes("keep excluded"),
	);
	assert.deepEqual(Object.keys((await restarted.canonical()).files).sort(), [
		"a.md",
		"b.md",
		"excluded.bin",
	]);
});

test("local Force checkpoints verified uploads before counting or publishing them", async (context) => {
	for (const encrypted of [false, true]) {
		await context.test(
			encrypted ? "encrypted" : "plaintext",
			async (context) => {
				const make = managedDevices(context);
				const disk = new MemoryDisk();
				const owner = make(disk, "upload-checkpoint", null);
				owner.settings.enableEncryption = encrypted;
				owner.settings.encryptionPassword = encrypted
					? "synthetic-password"
					: null;
				owner.vault.put("a.md", bytes("first"));
				owner.vault.put("b.md", bytes("second"));
				disk.files.set("vault/obsolete.md", bytes("old"));
				let recovery: ForceRecovery | null = null;
				let saved = "null";
				let failSave = true;
				let copying = false;
				let completedId: string | undefined;
				const ports = {
					getRecovery: () => recovery,
					persist: async (state: ForceRecovery | null) => {
						const previous = recovery;
						recovery = state;
						try {
							if (
								!copying &&
								state?.direct?.stage === "copying"
							) {
								copying = true;
								owner.vault.put(
									"b.md",
									bytes("late source edit"),
								);
							}
							if (failSave && state?.files["b.md"]) {
								failSave = false;
								throw new Error(
									"synthetic upload checkpoint failure",
								);
							}
							saved = JSON.stringify(recovery);
							if (state?.completion) {
								completedId = state.id;
							}
						} catch (error) {
							recovery = previous;
							throw error;
						}
					},
					password: async () => null,
				};
				const deps = { ...owner, ...ports };
				const plan = await prepareForceReplacement(deps, "from_local");
				assert.ok(plan);
				const { id, epoch, sourceDigest } = plan.recovery;
				const [first, second] = plan.recovery.source;
				assert.ok(first && second);
				const originalHash = second.sha256;
				const rawA = `vault/${first.rawPath}`;
				const rawB = `vault/${second.rawPath}`;
				let lostResponse = false;
				disk.afterRequest = async (method, endpoint, path) => {
					if (
						method === "PUT" &&
						endpoint === "/upload" &&
						path === rawA
					) {
						lostResponse = true;
						throw new Error("synthetic lost PUT response");
					}
				};

				const partial = await applyForceReplacement(
					deps,
					plan,
					"without-backup",
				);
				assert.equal(lostResponse, true);
				assert.equal(failSave, false);
				assert.equal(partial.completed, false);
				assert.equal(partial.errors.length, 1);
				assert.equal(partial.uploaded, 1);
				assert.deepEqual(
					await owner.client.downloadFile("vault/a.md"),
					bytes("first"),
				);
				assert.deepEqual(
					await owner.client.downloadFile("vault/b.md"),
					bytes("late source edit"),
				);
				assert.equal(disk.files.has("vault/obsolete.md"), false);
				const checkpoint = JSON.parse(saved) as ForceRecovery;
				assert.equal(checkpoint.id, id);
				assert.equal(checkpoint.epoch, epoch);
				assert.equal(checkpoint.sourceDigest, sourceDigest);
				assert.equal(
					checkpoint.source.find((file) => file.path === "b.md")
						?.sha256,
					originalHash,
				);
				assert.deepEqual(checkpoint.direct?.pendingFiles, ["b.md"]);
				assert.deepEqual(checkpoint.direct?.pendingDeletes, []);
				assert.deepEqual(Object.keys(checkpoint.files), ["a.md"]);
				assert.deepEqual(Object.keys(checkpoint.targetHashes), [
					first.rawPath,
				]);
				assert.equal(
					checkpoint.targetHashes[first.rawPath],
					(await disk.resource(rawA))?.sha256,
				);
				const canonical = await owner.canonical();
				assert.equal(canonical.epoch, epoch);
				assert.ok(canonical.maintenance?.kind === "force");
				assert.equal(canonical.maintenance.id, id);
				assert.equal(canonical.maintenance.sourceDigest, sourceDigest);
				assert.deepEqual(Object.keys(canonical.files), ["a.md"]);

				const restarted = make(
					disk,
					"upload-checkpoint",
					null,
					owner.vault,
					await owner.saved(),
				);
				recovery = checkpoint;
				restarted.engine.setForceReplacementPorts(ports);
				disk.afterRequest = undefined;
				disk.beforeRequest = async (method, endpoint, path) => {
					assert.ok(
						!(
							method === "DELETE" &&
							[rawA, rawB, "vault/obsolete.md"].includes(path)
						),
						"Continuation repeated a completed purge",
					);
					assert.ok(
						!(
							method === "PUT" &&
							endpoint === "/upload" &&
							path === rawA
						),
					);
				};
				await restarted.full();
				assert.equal(saved, "null");
				assert.equal(completedId, id);
				assert.equal((await restarted.canonical()).epoch, epoch);
				await restarted.assertSettled({
					"a.md": "first",
					"b.md": "late source edit",
				});
			},
		);
	}
});

test("direct Force remote preserves excluded local files and selects nested included files", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "direct-target", null);
	owner.vault.configDir = "custom-config";
	owner.settings.syncPatterns = ["*.md", "**/*.md"];
	owner.vault.put("old.bin", bytes("keep excluded"));
	owner.vault.put("config/old.md", bytes("discard"));
	owner.vault.put(
		"custom-config/plugins/yandex-disk-sync/data.json",
		bytes("synthetic-private-state"),
	);
	owner.vault.put(".backup/keep.zip", bytes("keep"));
	disk.folders.add("vault/config");
	disk.files.set("vault/config/state.json", bytes("excluded remote"));
	disk.files.set("vault/config/note.md", bytes("remote source"));
	disk.files.set(
		"vault/.obsidian-sync-index.json",
		bytes("unreadable old index"),
	);
	const deps = {
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		persist: async () => {},
		password: async () => null,
	};
	const plan = await prepareForceReplacement(deps, "from_remote");
	assert.ok(plan);
	await applyForceReplacement(deps, plan, "without-backup");
	assert.deepEqual(
		[...owner.vault.files.keys()].sort(),
		[
			".backup/keep.zip",
			"custom-config/plugins/yandex-disk-sync/data.json",
			"config/note.md",
			"old.bin",
		].sort(),
	);
	assert.deepEqual(
		owner.vault.files.get("config/note.md"),
		bytes("remote source"),
	);
	assert.ok((await owner.canonical()).files["config/note.md"]);
});

test("direct encrypted Force includes hidden files and empty directories and preserves readable source encryption", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "hidden-encrypted", null);
	owner.vault.configDir = "custom-config";
	owner.settings.enableEncryption = true;
	owner.settings.syncDotObsidian = true;
	owner.settings.excludePatterns = [".agents/**"];
	owner.settings.encryptionPassword = "synthetic-direct-password";
	owner.vault.put("custom-config/appearance.json", bytes("selected config"));
	owner.vault.put(".hidden/zero.bin", bytes(""));
	owner.vault.folder("empty/nested");
	const deps = {
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		persist: async (state: ForceRecovery | null) => {
			if (!state) {
				owner.client.setEncryptionService(
					await new EncryptionManager().createCodec(
						"hardened",
						owner.settings.encryptionSalt!,
						owner.settings.encryptionPassword!,
					),
				);
			}
		},
		password: async () => "synthetic-direct-password",
	};
	const upload = await prepareForceReplacement(deps, "from_local");
	assert.ok(upload);
	assert.equal(
		(await applyForceReplacement(deps, upload, "without-backup")).completed,
		true,
	);
	const manifest = disk.files.get("vault/.obsidian-encrypt.json")!.slice(0);
	const formerCodec = (await codecFor(true))!;
	const formerRoot = `vault/${await formerCodec.encryptFilename("old")}`;
	const formerNested = `${formerRoot}/${await formerCodec.encryptFilename("nested")}`;
	disk.folders.add(formerRoot);
	disk.folders.add(formerNested);
	disk.folders.add("vault/.agents");
	disk.files.set("vault/.agents/local.json", bytes("excluded remote"));
	owner.vault.put(".agents/local.json", bytes("excluded local"));
	// Config was selected for upload, then excluded on this receiving device.
	owner.settings.syncDotObsidian = false;
	disk.folders.add(`vault/${owner.vault.configDir}`);
	disk.files.set(
		`vault/${owner.vault.configDir}/raw.json`,
		bytes("excluded config"),
	);
	owner.vault.remove(owner.vault.configDir);
	owner.vault.remove(".hidden");
	owner.vault.remove("empty");
	owner.vault.put("discard.bin", bytes("old local"));
	const download = await prepareForceReplacement(deps, "from_remote");
	assert.ok(download);
	const lateFile = `${formerNested}/.backup/keep.md`;
	disk.folders.add(`${formerNested}/.backup`);
	disk.files.set(lateFile, bytes("retain late file"));
	await assert.rejects(
		applyForceReplacement(deps, download, "without-backup"),
		{
			name: "ForceSourceFormatError",
		},
	);
	owner.assertLocal("discard.bin", "old local");
	assert.deepEqual(disk.files.get(lateFile), bytes("retain late file"));
	disk.files.delete(lateFile);
	disk.folders.delete(`${formerNested}/.backup`);
	assert.equal(
		(await applyForceReplacement(deps, download, "without-backup"))
			.completed,
		true,
	);
	assert.deepEqual(
		owner.vault.files.get(".agents/local.json"),
		bytes("excluded local"),
	);
	assert.deepEqual(owner.vault.files.get(".hidden/zero.bin"), bytes(""));
	assert.equal(owner.vault.entries.has("empty/nested"), true);
	assert.equal(owner.vault.files.has("discard.bin"), false);
	assert.equal(disk.folders.has(formerNested), true);
	assert.deepEqual(Object.keys((await owner.canonical()).files), [
		".hidden/zero.bin",
	]);
	assert.deepEqual(owner.index.getPendingPhysicalActions(), []);
	assert.deepEqual(disk.files.get("vault/.obsidian-encrypt.json"), manifest);
	assert.equal(owner.vault.files.has("custom-config/appearance.json"), false);
	disk.files.set(
		"vault/included.md",
		bytes("ordinary content in selected encrypted scope"),
	);
	const before = new Map(owner.vault.files);
	await assert.rejects(prepareForceReplacement(deps, "from_remote"), {
		name: "ForceSourceFormatError",
	});
	assert.deepEqual(owner.vault.files, before);
});

test("Force defers subtree copies and restores a previously completed copy after retrying its purge", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "subtree-retry", null);
	owner.vault.configDir = "custom-config";
	owner.vault.put("tree/new.md", bytes("selected"));
	owner.vault.put("sibling.md", bytes("selected"));
	disk.folders.add("vault/tree");
	disk.files.set("vault/tree/obsolete.md", bytes("old"));
	let saved: ForceRecovery | null = null;
	const ports = {
		persist: async (state: ForceRecovery | null) => {
			saved = structuredClone(state);
		},
		password: async () => null,
		getRecovery: () => saved,
	};
	const deps = {
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		...ports,
	};
	const plan = await prepareForceReplacement(deps, "from_local");
	assert.ok(plan);
	disk.beforeRequest = async (method, _endpoint, path) => {
		if (method === "DELETE" && path === "vault/tree") {
			throw new Error("synthetic subtree deletion failure");
		}
	};
	const partial = await applyForceReplacement(deps, plan, "without-backup");
	assert.equal(partial.completed, false);
	assert.equal(disk.files.has("vault/tree/new.md"), false);
	assert.deepEqual(disk.files.get("vault/sibling.md"), bytes("selected"));
	const checkpoint = ports.getRecovery();
	assert.ok(checkpoint?.direct);
	assert.deepEqual(checkpoint.direct.pendingFiles, ["tree/new.md"]);
	assert.deepEqual(checkpoint.direct.pendingDirectories, ["tree"]);
	// Earlier writers acknowledged the copy while its recursive delete was still pending.
	disk.files.set("vault/tree/new.md", bytes("selected"));
	checkpoint.files["tree/new.md"] = {
		...checkpoint.files["sibling.md"]!,
		path: "tree/new.md",
	};
	checkpoint.targetHashes["tree/new.md"] =
		checkpoint.targetHashes["sibling.md"]!;
	checkpoint.direct.pendingFiles = [];
	checkpoint.direct.pendingDirectories = [];
	disk.beforeRequest = undefined;
	owner.engine.setForceReplacementPorts(ports);
	await owner.full();
	assert.equal(saved, null);
	assert.equal(disk.files.has("vault/tree/obsolete.md"), false);
	assert.deepEqual(disk.files.get("vault/tree/new.md"), bytes("selected"));
});

test("remote Force copies independent paths while a local subtree purge remains pending", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "local-purge", null);
	disk.folders.add("vault/Tree");
	disk.folders.add("vault/Tree/empty");
	disk.files.set("vault/Tree/note.md", bytes("selected"));
	disk.folders.add("vault/Parent");
	disk.files.set("vault/sibling.md", bytes("independent"));
	owner.vault.put("tree/note.md", bytes("original"));
	owner.vault.put("Parent/old.md", bytes("discard after retry"));
	owner.vault.put("Parent/keep.bin", bytes("preserve"));
	owner.settings.excludePatterns = ["Parent/keep.bin"];
	const deps = {
		...owner,
		password: async () => null,
		persist: async () => {},
	};
	const plan = await prepareForceReplacement(deps, "from_remote");
	assert.ok(plan);
	const trash = owner.vault.trashFile.bind(owner.vault);
	owner.vault.trashFile = async () => {
		throw new Error("synthetic local purge failure");
	};
	const partial = await applyForceReplacement(deps, plan, "without-backup");
	owner.vault.trashFile = trash;
	assert.equal(partial.completed, false);
	owner.assertLocal("tree/note.md", "original");
	owner.assertLocal("sibling.md", "independent");
	assert.equal(owner.vault.entries.has("Tree"), false);
	assert.deepEqual(plan.recovery.direct?.pendingFiles, ["Tree/note.md"]);
	assert.deepEqual(plan.recovery.direct?.pendingDirectories, [
		"Parent",
		"Tree",
		"Tree/empty",
	]);
	// On a case-insensitive volume an earlier copy into Tree still lives below tree.
	owner.vault.put("tree/note.md", bytes("selected"));
	const checkpoint = structuredClone(plan.recovery);
	const copied = checkpoint.source.find(
		({ path }) => path === "Tree/note.md",
	)!;
	checkpoint.files[copied.path] = {
		...checkpoint.files["sibling.md"]!,
		path: copied.path,
		sha256: copied.sha256,
		size: copied.size,
	};
	checkpoint.direct!.pendingFiles = [];
	checkpoint.direct!.pendingDirectories = ["Parent"];
	const resumed = await resumeForceReplacement(deps, checkpoint);
	assert.equal(
		(await applyForceReplacement(deps, resumed, "without-backup"))
			.completed,
		true,
	);
	owner.assertLocal("Tree/note.md", "selected");
	assert.equal(owner.vault.entries.has("Tree/empty"), true);
});

test("Force preserves a replacement file at a pending directory deletion across restart", async (context) => {
	const make = managedDevices(context);
	const disk = new MemoryDisk();
	const owner = make(disk, "changed-type", null);
	owner.vault.put("A.md", bytes("selected"));
	owner.vault.put("A.md-extra", bytes("independent"));
	disk.folders.add("vault/A.md");
	let saved = "null";
	const ports = {
		persist: async (state: ForceRecovery | null) => {
			saved = JSON.stringify(state);
		},
		getRecovery: () => JSON.parse(saved) as ForceRecovery | null,
		password: async () => null,
	};
	const deps = { ...owner, ...ports };
	const plan = await prepareForceReplacement(deps, "from_local");
	assert.ok(plan);
	disk.afterRequest = async (method, endpoint, path) => {
		if (
			method === "PUT" &&
			endpoint === "/upload" &&
			path.endsWith(".obsidian-sync-index.json")
		) {
			disk.afterRequest = undefined;
			disk.folders.delete("vault/A.md");
			disk.files.set("vault/A.md", bytes("late file"));
		}
	};
	const partial = await applyForceReplacement(deps, plan, "without-backup");
	assert.equal(partial.completed, false);
	assert.deepEqual(disk.files.get("vault/A.md"), bytes("late file"));
	assert.deepEqual(disk.files.get("vault/A.md-extra"), bytes("independent"));
	const restarted = make(
		disk,
		"changed-type",
		null,
		owner.vault,
		await owner.saved(),
	);
	restarted.engine.setForceReplacementPorts(ports);
	assert.equal((await restarted.engine.fullSync()).success, false);
	assert.deepEqual(disk.files.get("vault/A.md"), bytes("late file"));
	const checkpoint = ports.getRecovery();
	assert.deepEqual(checkpoint?.direct?.pendingFiles, ["A.md"]);
	assert.deepEqual(checkpoint?.direct?.pendingDeletes, [
		{ path: "A.md", kind: "dir", location: "remote" },
	]);
	disk.files.delete("vault/A.md");
	await restarted.full();
	assert.equal(ports.getRecovery(), null);
	assert.deepEqual(disk.files.get("vault/A.md"), bytes("selected"));
});

test("Force recovery keeps a pending file delete when its remote path becomes a directory", async (context) => {
	for (const encrypted of [false, true]) {
		for (const boundary of [
			"restart",
			"retry",
			"wrong metadata",
		] as const) {
			await context.test(
				`${encrypted ? "encrypted" : "plaintext"} ${boundary}`,
				async (t) => {
					const make = managedDevices(t);
					const disk = new MemoryDisk();
					const codec = await codecFor(encrypted);
					const owner = make(disk, "replaced-file", codec);
					await seedForceEncryption(disk, owner, codec);
					owner.settings.syncPatterns = ["*.md"];
					owner.vault.put("old.md", bytes("old"));
					await owner.full();
					const savedDevice = owner.lastSaved();
					const savedSettings = structuredClone(owner.settings);
					let saved = "null";
					const ports = {
						persist: async (state: ForceRecovery | null) => {
							saved = JSON.stringify(state);
						},
						getRecovery: () =>
							JSON.parse(saved) as ForceRecovery | null,
						password: async () => savedSettings.encryptionPassword,
					};
					const deps = { ...owner, ...ports };
					const rawPath = (path: string) =>
						owner.client.getPhysicalPath(`vault/${path}`);
					const target = await rawPath("old.md");
					const child = await rawPath("old.md/excluded.bin");
					const preserved = codec
						? await codec.encrypt(bytes("preserve"))
						: bytes("preserve");
					const replaceFile = () => {
						disk.files.delete(target);
						disk.folders.add(target);
						disk.files.set(child, preserved);
					};
					owner.vault.remove("old.md");
					owner.vault.put("new.md", bytes("independent upload"));
					const plan = await prepareForceReplacement(
						deps,
						"from_local",
					);
					assert.ok(plan);
					const upload = await rawPath("new.md");
					disk.beforeRequest = async (method, endpoint, path) => {
						if (
							(method === "DELETE" && path === target) ||
							(endpoint === "/upload" && path === upload)
						) {
							throw new Error("synthetic interrupted transfer");
						}
					};
					const partial = await applyForceReplacement(
						deps,
						plan,
						"without-backup",
					);
					assert.equal(partial.completed, false);
					const pending = [
						{
							location: "remote",
							kind: "file",
							path: target.slice("vault/".length),
						},
					];
					assert.deepEqual(
						ports.getRecovery()?.direct?.pendingDeletes,
						pending,
					);
					assert.deepEqual(
						ports.getRecovery()?.direct?.pendingFiles,
						["new.md"],
					);
					if (boundary !== "retry") {
						replaceFile();
					}
					if (boundary === "wrong metadata") {
						const resource = disk.resource.bind(disk);
						disk.resource = (path) =>
							resource(path === target ? child : path);
					}
					const restarted = make(
						disk,
						"replaced-file",
						codec,
						owner.vault,
						savedDevice,
						{ maxRetries: 1 },
					);
					Object.assign(restarted.settings, savedSettings);
					restarted.engine.setForceReplacementPorts(ports);
					let deleteAttempts = 0;
					disk.beforeRequest = async (method, _endpoint, path) => {
						if (method === "DELETE" && path === target) {
							deleteAttempts++;
							if (boundary === "retry" && deleteAttempts === 1) {
								replaceFile();
								throw new Error(
									"synthetic lost connection before deletion",
								);
							}
						}
					};
					const result = await restarted.engine.fullSync();
					assert.deepEqual(
						disk.files.get(child),
						preserved,
						"excluded descendant survived",
					);
					assert.equal(deleteAttempts, boundary === "retry" ? 1 : 0);
					assert.equal(result.success, false);
					assert.deepEqual(
						ports.getRecovery()?.direct?.pendingDeletes,
						pending,
					);
					assert.deepEqual(
						ports.getRecovery()?.direct?.pendingFiles,
						[],
					);
					assert.deepEqual(
						await restarted.client.downloadFile("vault/new.md"),
						bytes("independent upload"),
					);
				},
			);
		}
	}
});

test("a confirmed remote source disappearing never becomes an empty replacement", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "missing-source", null);
	owner.vault.configDir = "custom-config";
	owner.vault.put("keep.md", bytes("local data"));
	disk.files.set("vault/source.md", bytes("remote data"));
	const deps = {
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		persist: async () => {},
		password: async () => null,
	};
	const plan = await prepareForceReplacement(deps, "from_remote");
	assert.ok(plan);
	assert.equal(plan.recovery.source.length, 1);
	disk.files.clear();
	disk.folders.delete("vault");
	await assert.rejects(
		applyForceReplacement(deps, plan, "without-backup"),
		/unavailable/,
	);
	assert.deepEqual(owner.vault.files.get("keep.md"), bytes("local data"));
});

test("remote Force joins the failed validation window before returning without purging", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "join-validation", null);
	owner.settings.maxConcurrency = 2;
	owner.vault.put("old.md", bytes("old"));
	for (const file of ["a.md", "b.md", "c.md"]) {
		disk.files.set(`vault/${file}`, bytes(file));
	}
	const deps = {
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		persist: async () => {},
		password: async () => null,
	};
	const plan = await prepareForceReplacement(deps, "from_remote");
	assert.ok(plan);
	const firstRead = deferred();
	const releaseRead = deferred();
	const paths: string[] = [];
	const read = owner.client.downloadStableRawFile.bind(owner.client);
	owner.client.downloadStableRawFile = async (path, ...options) => {
		if (["vault/a.md", "vault/b.md", "vault/c.md"].includes(path)) {
			paths.push(path);
		}
		if (path === "vault/a.md") {
			firstRead.resolve();
			await releaseRead.promise;
		} else if (path === "vault/b.md") {
			throw new Error("synthetic unreadable source");
		}
		return read(path, ...options);
	};
	let settled = false;
	const failure = assert
		.rejects(
			applyForceReplacement(deps, plan, "without-backup"),
			/synthetic unreadable source/,
		)
		.then(() => {
			settled = true;
		});
	try {
		await firstRead.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(paths, ["vault/a.md", "vault/b.md"]);
		assert.equal(settled, false);
		owner.assertLocal("old.md", "old");
	} finally {
		releaseRead.resolve();
		await failure;
	}
	assert.deepEqual(paths, ["vault/a.md", "vault/b.md"]);
	owner.assertLocal("old.md", "old");
	assert.equal(disk.files.has("vault/.obsidian-sync-index.json"), false);
});

test("remote Force bounds all three file reads and serializes writes to a shared parent", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "bounded-target", null);
	owner.settings.maxConcurrency = 2;
	owner.settings.syncPatterns = ["**/*.md"];
	disk.folders.add("vault/tree");
	const files = new Map([
		["vault/tree/a.md", bytes("one")],
		["vault/tree/b.md", bytes("two")],
		["vault/tree/c.md", new ArrayBuffer(5 * 1024 * 1024)],
		["vault/tree/d.md", new ArrayBuffer(5 * 1024 * 1024)],
		["vault/tree/e.md", new ArrayBuffer(9 * 1024 * 1024)],
		["vault/tree/f.md", bytes("six")],
	]);
	for (const [path, content] of files) {
		disk.files.set(path, content);
	}
	const read = owner.client.downloadStableRawFile.bind(owner.client);
	const passes = Array.from({ length: 3 }, () => ({
		started: deferred(),
		first: deferred(),
		second: deferred(),
		active: new Set<string>(),
	}));
	const reads = new Map<string, number>();
	owner.client.downloadStableRawFile = async (path, ...options) => {
		if (!files.has(path)) {
			return read(path, ...options);
		}
		const index = reads.get(path) ?? 0;
		reads.set(path, index + 1);
		const pass = passes[index]!;
		pass.active.add(path);
		try {
			assert.ok(pass.active.size <= 2);
			if (pass.active.size > 1) {
				const size = [...pass.active].reduce(
					(sum, entry) => sum + files.get(entry)!.byteLength,
					0,
				);
				assert.ok(size <= 8 * 1024 * 1024);
			}
			if (path.endsWith("/a.md")) {
				pass.started.resolve();
				await pass.first.promise;
			} else if (path.endsWith("/b.md")) {
				await pass.second.promise;
			}
			return await read(path, ...options);
		} finally {
			pass.active.delete(path);
		}
	};
	const firstWrite = deferred();
	const releaseWrite = deferred();
	const write = owner.vault.createBinary.bind(owner.vault);
	owner.vault.createBinary = async (path, content) => {
		if (path === "tree/a.md") {
			firstWrite.resolve();
			await releaseWrite.promise;
		}
		return write(path, content);
	};
	const deps = {
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		persist: async () => {},
		password: async () => null,
	};
	const run = prepareForceReplacement(deps, "from_remote").then((plan) => {
		assert.ok(plan);
		assert.deepEqual(plan.recovery.direct!.pendingDirectories, []);
		return applyForceReplacement(deps, plan, "without-backup");
	});
	try {
		for (const pass of passes) {
			await pass.started.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual([...pass.active].sort(), [
				"vault/tree/a.md",
				"vault/tree/b.md",
			]);
			pass.second.resolve();
			pass.first.resolve();
		}
		await firstWrite.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(owner.vault.files.size, 0);
	} finally {
		for (const pass of passes) {
			pass.second.resolve();
			pass.first.resolve();
		}
		releaseWrite.resolve();
		await run;
	}
	assert.equal((await run).completed, true);
	assert.deepEqual(Object.keys((await owner.canonical()).files).sort(), [
		"tree/a.md",
		"tree/b.md",
		"tree/c.md",
		"tree/d.md",
		"tree/e.md",
		"tree/f.md",
	]);
	owner.assertLocal("tree/b.md", "two");
});

test("remote Force packs twenty small files and rechecks an attachment that grows before copying", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "size-windows", null);
	owner.settings.maxConcurrency = 20;
	const mib = 1024 * 1024;
	const small = Array.from({ length: 20 }, (_, index) => `note-${index}.md`);
	const grown = small[0]!;
	const fixture = new Map(small.map((path) => [path, bytes(path)]));
	fixture.set("middle.bin", new ArrayBuffer(5 * mib));
	fixture.set("oversized.bin", new ArrayBuffer(9 * mib));
	for (const [path, content] of fixture) {
		disk.files.set(`vault/${path}`, content);
	}
	let copying = false;
	let saved: ForceRecovery | null = null;
	let injected = false;
	let expired = false;
	let peakSmall = 0;
	const active = new Set<string>();
	const metadataGets = new Map<string, number>();
	disk.beforeRequest = async (method, endpoint, path) => {
		if (method === "GET" && endpoint.endsWith("/resources")) {
			metadataGets.set(path, (metadataGets.get(path) ?? 0) + 1);
		}
	};
	const metadata = owner.client.getResource.bind(owner.client);
	owner.client.getResource = async (...args) => {
		const resource = await metadata(...args);
		const budget = args[4];
		if (copying && !expired && args[0] === "vault/note-2.md" && budget) {
			expired = true;
			budget.deadline = 0;
		}
		return resource;
	};
	const read = owner.client.downloadStableRawFile.bind(owner.client);
	owner.client.downloadStableRawFile = async (remote, ...options) => {
		const path = remote.slice("vault/".length);
		if (!fixture.has(path)) {
			return read(remote, ...options);
		}
		active.add(path);
		try {
			peakSmall = Math.max(
				peakSmall,
				[...active].filter((entry) => small.includes(entry)).length,
			);
			if (active.size > 1) {
				assert.ok(
					[...active].reduce(
						(sum, entry) => sum + fixture.get(entry)!.byteLength,
						0,
					) <=
						8 * mib,
				);
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
			return await read(remote, ...options);
		} finally {
			active.delete(path);
		}
	};
	const deps = {
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		password: async () => null,
		getRecovery: () => saved,
		persist: async (state: ForceRecovery | null) => {
			if (state?.phase === "applying" && !copying) {
				copying = true;
				const content = new ArrayBuffer(9 * mib);
				fixture.set(grown, content);
				disk.files.set(`vault/${grown}`, content);
			}
			if (copying && !injected && state?.files[grown]) {
				injected = true;
				throw new Error("synthetic save failure");
			}
			saved = structuredClone(state);
		},
	};
	const plan = await prepareForceReplacement(deps, "from_remote");
	assert.ok(plan);
	assert.equal(peakSmall, 20);
	assert.equal(
		(await applyForceReplacement(deps, plan, "without-backup")).completed,
		false,
	);
	assert.deepEqual(deps.getRecovery()?.direct?.pendingFiles, [grown]);
	assert.equal(metadataGets.get("vault/note-1.md"), 6);
	assert.equal(metadataGets.get("vault/note-2.md"), 7);
	assert.equal(metadataGets.get(`vault/${grown}`), 7);
	const resumed = await resumeForceReplacement(
		deps,
		structuredClone(deps.getRecovery()!),
	);
	assert.equal(
		(await applyForceReplacement(deps, resumed, "without-backup"))
			.completed,
		true,
	);
	assert.equal(saved, null);
	const index = await owner.canonical();
	assert.equal(index.maintenance, undefined);
	for (const [path, content] of fixture) {
		assert.deepEqual(owner.vault.files.get(path), content);
		assert.equal(index.files[path]?.size, content.byteLength);
	}
});

test("remote Force retains an unacknowledged copy across checkpoint failure and restart", async (context) => {
	const disk = new MemoryDisk();
	const make = managedDevices(context);
	const owner = make(disk, "copy-checkpoint", null);
	owner.vault.put("old.md", bytes("old"));
	disk.files.set("vault/a.md", bytes("one"));
	disk.files.set("vault/b.md", bytes("two"));
	let saved: ForceRecovery | null = null;
	let failSave = true;
	const ports = {
		persist: async (state: ForceRecovery | null) => {
			if (failSave && state?.files["a.md"]) {
				failSave = false;
				throw new Error("synthetic copy checkpoint failure");
			}
			saved = structuredClone(state);
		},
		getRecovery: () => saved,
		password: async () => null,
	};
	const deps = {
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		...ports,
	};
	const plan = await prepareForceReplacement(deps, "from_remote");
	assert.ok(plan);
	const partial = await applyForceReplacement(deps, plan, "without-backup");
	assert.equal(partial.completed, false);
	assert.equal(partial.downloaded, 1);
	owner.assertLocal("a.md", "one");
	owner.assertLocal("b.md", "two");
	const checkpoint = JSON.parse(JSON.stringify(saved)) as ForceRecovery;
	assert.deepEqual(checkpoint.direct!.pendingFiles, ["a.md"]);
	assert.equal(checkpoint.files["a.md"], undefined);
	assert.deepEqual(checkpoint.direct!.pendingDeletes, []);
	assert.equal((await owner.canonical()).maintenance?.id, checkpoint.id);
	const restarted = make(
		disk,
		"copy-checkpoint",
		null,
		owner.vault,
		await owner.saved(),
	);
	saved = checkpoint;
	restarted.engine.setForceReplacementPorts(ports);
	const deletePath = owner.vault.remove.bind(owner.vault);
	owner.vault.remove = (path) => {
		assert.fail(`Force restart unexpectedly purged ${path}`);
	};
	try {
		await restarted.full();
	} finally {
		owner.vault.remove = deletePath;
	}
	assert.equal(saved, null);
	const canonical = await restarted.canonical();
	assert.equal(canonical.epoch, checkpoint.epoch);
	assert.equal(canonical.maintenance, undefined);
	assert.deepEqual(Object.keys(canonical.files).sort(), ["a.md", "b.md"]);
});

test("unload during the final Force file stat prevents the following local mutation", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "unloaded-target", null);
	owner.vault.configDir = "custom-config";
	disk.files.set("vault/source.md", bytes("remote data"));
	let cancelled = false;
	let copying = false;
	const deps = {
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		persist: async (state: ForceRecovery | null) => {
			copying = state?.direct?.stage === "copying";
		},
		password: async () => null,
		isCancelled: () => cancelled,
	};
	const plan = await prepareForceReplacement(deps, "from_remote");
	assert.ok(plan);
	const stat = owner.vault.adapter.stat.bind(owner.vault.adapter);
	let fileStats = 0;
	owner.vault.adapter.stat = async (path) => {
		if (copying && path === "source.md" && ++fileStats === 2) {
			cancelled = true;
		}
		return stat(path);
	};
	const result = await applyForceReplacement(deps, plan, "without-backup");
	assert.equal(cancelled, true);
	assert.equal(result.completed, false);
	assert.equal(owner.vault.files.has("source.md"), false);
});

test("Force stops canonical writes at dispatch and retry after lifecycle revocation", async (context) => {
	const cases = [
		"before-delete",
		"after-link",
		"delete-retry",
		"put-retry",
	] as const;
	for (const direction of ["from_local", "from_remote"] as const) {
		for (const boundary of cases) {
			await context.test(`${direction} ${boundary}`, async (t) => {
				const disk = new MemoryDisk();
				const owner = managedDevices(t)(
					disk,
					"revoked-force",
					null,
					undefined,
					undefined,
					{ maxRetries: 1 },
				);
				const canonicalPath = "vault/.obsidian-sync-index.json";
				const oldCanonical = bytes("previous canonical");
				disk.files.set(canonicalPath, oldCanonical);
				disk.files.set("vault/remote.md", bytes("remote data"));
				owner.vault.put("local.md", bytes("local data"));
				const saved: { checkpoint: ForceRecovery | null } = {
					checkpoint: null,
				};
				let revoked = false;
				const unload = boundary === "after-link";
				const revoke = () => {
					revoked = true;
					if (!unload) {
						owner.client.setToken("synthetic-reconnected");
					}
				};
				const deps = {
					...owner,
					persist: async (state: ForceRecovery | null) => {
						saved.checkpoint = structuredClone(state);
					},
					password: async () => null,
					isCancelled: () => unload && revoked,
				};
				const plan = await prepareForceReplacement(deps, direction);
				assert.ok(plan);
				const sentAfterRevocation: string[] = [];
				disk.beforeRequest = async (method, _endpoint, path) => {
					if (method === "GET" || path !== canonicalPath) {
						return;
					}
					if (revoked) {
						sentAfterRevocation.push(method);
					} else if (
						(boundary === "delete-retry" && method === "DELETE") ||
						(boundary === "put-retry" && method === "PUT")
					) {
						throw new Error(
							"synthetic transport failure before acceptance",
						);
					}
				};
				disk.afterRequest = async (method, endpoint, path) => {
					if (
						unload &&
						method === "GET" &&
						endpoint.endsWith("/resources/upload") &&
						path === canonicalPath
					) {
						revoke();
					}
				};
				owner.client.setWriteGuard(async () => {
					await owner.index.assertRemoteScope();
					if (
						boundary === "before-delete" &&
						saved.checkpoint &&
						!revoked
					) {
						revoke();
					}
				});
				owner.client.setRetryCallback((retry) => {
					if (
						(boundary === "delete-retry" &&
							retry?.stage === "API DELETE /resources") ||
						(boundary === "put-retry" && retry?.stage === "upload")
					) {
						revoke();
					}
				});
				const result = await applyForceReplacement(
					deps,
					plan,
					"without-backup",
				);
				assert.equal(revoked, true);
				assert.deepEqual(sentAfterRevocation, []);
				assert.equal(result.completed, false);
				assert.equal(saved.checkpoint?.id, plan.recovery.id);
				assert.equal(saved.checkpoint?.epoch, plan.recovery.epoch);
				assert.equal(saved.checkpoint?.completion, null);
				assert.equal(owner.index.getObservedEpoch(), null);
				assert.deepEqual(
					disk.files.get(canonicalPath),
					boundary === "before-delete" || boundary === "delete-retry"
						? oldCanonical
						: undefined,
				);
				owner.assertLocal("local.md", "local data");
				assert.deepEqual(
					disk.files.get("vault/remote.md"),
					bytes("remote data"),
				);
			});
		}
	}
});

test("cancelling archive confirmation retains the Force reservation until archive settlement", async (context) => {
	const { ForceSyncController } =
		await import("../src/sync/workflows/force-controller");
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "cancel-archive", null);
	const plan = await prepareForceReplacement(
		{
			client: owner.client,
			adapter: owner.adapter,
			index: owner.index,
			settings: owner.settings,
			persist: async () => {},
			password: async () => null,
		},
		"from_local",
	);
	assert.ok(plan);
	let release = () => {};
	let entered = () => {};
	const archive = new Promise<void>((resolve) => {
		release = resolve;
	});
	const archiveEntered = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const controller = new ForceSyncController({
		isSyncBusy: () => false,
		preflight: async () => plan,
		confirm: async (_plan, prepareArchive) => {
			void prepareArchive();
			await archiveEntered;
			return "cancel";
		},
		readyForBackup: async () => true,
		captureProtectedSnapshot: async () => "snapshot",
		backup: async () => {
			entered();
			await archive;
			return {
				success: true,
				backupName: "backup.zip",
				sha256: "verified",
				snapshotDigest: "snapshot",
				fileCount: 0,
				totalSize: 0,
			};
		},
		run: async () => {
			throw new Error("Cancelled Force must not mutate");
		},
		persist: async () => {},
		replacementCommitted: () => {},
		hasPendingRecovery: () => false,
		reportError: () => {},
	});
	const pending = controller.run("from_local");
	await archiveEntered;
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});
	const busyDuringArchive = controller.isBusy();
	release();
	await pending;
	assert.equal(busyDuringArchive, true);
	assert.equal(controller.isBusy(), false);
	assert.equal(controller.getState()?.outcome, "cancelled");
});

test("Force remote verifies the selected local archive before deletion and retries a failed upload", async (context) => {
	const { ForceSyncController } =
		await import("../src/sync/workflows/force-controller");
	const { BackupManager } = await import("../src/backup/backup-manager");
	const { captureLogicalVaultDigest } =
		await import("../src/backup/backup-snapshot");
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "remote-with-archive", null);
	owner.vault.put("local.md", bytes("keep in archive"));
	disk.files.set("vault/remote.md", bytes("selected remote"));
	const deps = {
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		persist: async () => {},
		password: async () => null,
	};
	const backup = new BackupManager(
		owner.client,
		owner.adapter,
		owner.settings,
		"2.0.0",
	);
	let rejectArchive = true;
	let verified = false;
	disk.beforeRequest = async (_method, endpoint, path) => {
		if (
			rejectArchive &&
			endpoint === "/upload" &&
			path.startsWith("vault/.backup/")
		) {
			throw new Error("Synthetic archive upload failure");
		}
	};
	const remove = owner.vault.remove.bind(owner.vault);
	owner.vault.remove = (path) => {
		assert.equal(
			verified,
			true,
			"Local deletion preceded archive verification",
		);
		remove(path);
	};
	owner.engine.setForceReplacementPorts(deps);
	const controller = new ForceSyncController({
		isSyncBusy: () => false,
		preflight: () => prepareForceReplacement(deps, "from_remote", true),
		confirm: async (plan, archive) => {
			owner.assertLocal("local.md", "keep in archive");
			await assert.rejects(archive());
			owner.assertLocal("local.md", "keep in archive");
			rejectArchive = false;
			await archive();
			const name = plan.recovery.backupProof!.name;
			const archiveBytes = disk.files.get(`vault/.backup/${name}`);
			assert.ok(archiveBytes);
			const { default: JSZip } = await import("jszip");
			const contents = await JSZip.loadAsync(archiveBytes);
			assert.equal(
				await contents.file("local.md")!.async("string"),
				"keep in archive",
			);
			verified = true;
			return "with-backup";
		},
		readyForBackup: async () => true,
		captureProtectedSnapshot: () =>
			captureLogicalVaultDigest(owner.adapter, true),
		backup: (_direction, progress, plan) =>
			owner.index.withForceScope(plan.recovery, () =>
				backup.createBackup(undefined, progress, true),
			),
		run: (_direction, options) => owner.engine.forceSyncFromRemote(options),
		persist: async () => {},
		replacementCommitted: () => {},
		hasPendingRecovery: () => false,
		reportError: () => {},
	});
	await controller.run("from_remote");
	assert.equal(controller.getState()?.outcome, "success");
	owner.assertLocal("local.md");
	owner.assertLocal("remote.md", "selected remote");
});

test("Force blocks file-folder collisions with excluded descendants in both directions", async (context) => {
	const make = managedDevices(context);
	for (const direction of ["from_local", "from_remote"] as const) {
		const disk = new MemoryDisk();
		const owner = make(disk, direction, null);
		owner.settings.syncPatterns = ["*.md"];
		if (direction === "from_local") {
			owner.vault.put("shape.md", bytes("selected source"));
			disk.folders.add("vault/shape.md");
			disk.files.set("vault/shape.md/excluded.bin", bytes("preserved"));
		} else {
			disk.files.set("vault/shape.md", bytes("selected source"));
			owner.vault.put("shape.md/excluded.bin", bytes("preserved"));
		}
		const beforeLocal = new Map(owner.vault.files);
		const beforeRemote = new Map(disk.files);
		await assert.rejects(
			prepareForceReplacement(
				{
					client: owner.client,
					adapter: owner.adapter,
					index: owner.index,
					settings: owner.settings,
					password: async () => null,
					persist: async () => {},
				},
				direction,
			),
			{ name: "ForceScopeConflictError" },
		);
		assert.deepEqual(owner.vault.files, beforeLocal);
		assert.deepEqual(disk.files, beforeRemote);
	}
});

test("Force preserves excluded encrypted bytes and their codec and rejects filter drift before replacement", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "excluded-ciphertext", null);
	owner.settings.enableEncryption = true;
	owner.settings.encryptionPassword = "scope-password";
	owner.vault.put("selected.md", bytes("old selected"));
	owner.vault.put("private.md", bytes("preserved encrypted"));
	const deps = {
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		password: async () => "scope-password",
		persist: async () => {},
	};
	const seed = await prepareForceReplacement(deps, "from_local");
	assert.ok(seed?.codec);
	await applyForceReplacement(deps, seed, "without-backup");
	const privatePath = `vault/${await seed.codec.encryptFilename("private.md")}`;
	const privateBytes = disk.files.get(privatePath)!.slice(0);
	owner.settings.excludePatterns = ["private.md"];
	owner.vault.put("selected.md", bytes("new selected"));
	owner.vault.put("private.md", bytes("excluded local changes"));
	const plan = await prepareForceReplacement(deps, "from_local");
	assert.ok(plan?.codec);
	assert.equal(plan.recovery.target.salt, seed.recovery.target.salt);
	owner.settings.excludePatterns.push("selected.md");
	await assert.rejects(
		applyForceReplacement(deps, plan, "without-backup"),
		/connection changed/,
	);
	assert.deepEqual(disk.files.get(privatePath), privateBytes);
	owner.settings.excludePatterns.pop();
	await applyForceReplacement(deps, plan, "without-backup");
	assert.deepEqual(disk.files.get(privatePath), privateBytes);
	assert.equal(
		new TextDecoder().decode(await plan.codec.decrypt(privateBytes)),
		"preserved encrypted",
	);
	assert.deepEqual(Object.keys((await owner.canonical()).files), [
		"selected.md",
	]);
	owner.settings.enableEncryption = false;
	const before = new Map(disk.files);
	await assert.rejects(prepareForceReplacement(deps, "from_local"), {
		name: "ForceScopeConflictError",
	});
	assert.deepEqual(disk.files, before);
	owner.settings.excludePatterns = ["**"];
	await assert.rejects(prepareForceReplacement(deps, "from_local"), {
		name: "ForceScopeConflictError",
	});
	assert.deepEqual(disk.files, before);
});

test("plaintext Force repairs corrupt canonical when the destination codec authenticates selected names", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(
		disk,
		"corrupt-encrypted-index",
		null,
	);
	owner.settings.enableEncryption = true;
	owner.settings.encryptionPassword = "scope-password";
	owner.vault.put("obsolete.md", bytes("old encrypted data"));
	const deps = {
		...owner,
		persist: async () => {},
		password: async () => "scope-password",
	};
	const seed = await prepareForceReplacement(deps, "from_local");
	assert.ok(seed?.codec);
	assert.equal(
		(await applyForceReplacement(deps, seed, "without-backup")).completed,
		true,
	);
	const oldPath = `vault/${await seed.codec.encryptFilename("obsolete.md")}`;
	assert.ok(disk.files.has(oldPath));
	disk.files.set(
		"vault/.obsidian-sync-index.json",
		bytes("broken canonical"),
	);
	owner.vault.remove("obsolete.md");
	owner.vault.put("selected.md", bytes("new plaintext data"));
	owner.settings.syncPatterns = ["*.md"];
	owner.settings.enableEncryption = false;

	const plan = await prepareForceReplacement(deps, "from_local");
	assert.ok(plan?.destinationCodec);
	assert.equal(plan.codec, null);
	const result = await applyForceReplacement(deps, plan, "without-backup");
	assert.equal(result.completed, true);
	assert.equal(disk.files.has(oldPath), false);
	assert.equal(disk.files.has("vault/.obsidian-encrypt.json"), false);
	assert.deepEqual(
		disk.files.get("vault/selected.md"),
		bytes("new plaintext data"),
	);
	const canonical = await owner.canonical();
	assert.equal(canonical.epoch, plan.recovery.epoch);
	assert.equal(canonical.maintenance, undefined);
	assert.deepEqual(Object.keys(canonical.files), ["selected.md"]);
	assert.equal(owner.index.getObservedEpoch(), canonical.epoch);
});

test("Force recovery never deletes new file or directory blockers outside its explicit remainder", async (context) => {
	const make = managedDevices(context);
	for (const direction of ["from_local", "from_remote"] as const) {
		for (const blocker of ["directory", "parent-file"] as const) {
			const disk = new MemoryDisk();
			const owner = make(disk, `${direction}-${blocker}`, null);
			owner.settings.syncPatterns = ["*.md", "**/*.md"];
			const source =
				blocker === "directory" ? "shape.md" : "tree/note.md";
			if (direction === "from_local") {
				owner.vault.put(source, bytes("selected"));
				disk.beforeRequest = async (method, endpoint) => {
					if (method === "PUT" && endpoint === "/upload") {
						throw new Error("synthetic failed upload");
					}
				};
			} else {
				disk.files.set(`vault/${source}`, bytes("selected"));
				if (blocker === "parent-file") {
					disk.folders.add("vault/tree");
				}
			}
			let saved: ForceRecovery | null = null;
			const deps = {
				client: owner.client,
				adapter: owner.adapter,
				index: owner.index,
				settings: owner.settings,
				password: async () => null,
				persist: async (value: ForceRecovery | null) => {
					saved = structuredClone(value);
				},
			};
			const write = owner.adapter.writeForceFile.bind(owner.adapter);
			if (direction === "from_remote") {
				owner.adapter.writeForceFile = async () => {
					throw new Error("synthetic failed local write");
				};
			}
			const plan = await prepareForceReplacement(deps, direction);
			assert.ok(plan);
			const partial = await applyForceReplacement(
				deps,
				plan,
				"without-backup",
			);
			assert.equal(
				partial.completed,
				false,
				`${direction}/${blocker}: initial transfer must fail`,
			);
			assert.ok(saved);
			assert.deepEqual(plan.recovery.direct!.pendingDeletes, []);
			disk.beforeRequest = undefined;
			owner.adapter.writeForceFile = write;
			const keep =
				blocker === "directory" ? "shape.md/excluded.bin" : "tree";
			if (direction === "from_local") {
				if (blocker === "directory") {
					disk.folders.add("vault/shape.md");
				} else {
					disk.folders.delete("vault/tree");
				}
				disk.files.set(`vault/${keep}`, bytes("preserved new blocker"));
			} else {
				owner.vault.put(keep, bytes("preserved new blocker"));
			}
			const resumed = await resumeForceReplacement(deps, saved);
			const result = await applyForceReplacement(
				deps,
				resumed,
				"without-backup",
			);
			assert.equal(
				result.completed,
				false,
				`${direction}/${blocker}: new blocker must be preserved`,
			);
			assert.deepEqual(
				direction === "from_local"
					? disk.files.get(`vault/${keep}`)
					: owner.vault.files.get(keep),
				bytes("preserved new blocker"),
			);
			assert.deepEqual(resumed.recovery.direct!.pendingFiles, [source]);
		}
	}
});

test("remote Force copies into a hidden config directory and resumes its own matching bytes", async (context) => {
	const disk = new MemoryDisk();
	const make = managedDevices(context);
	const owner = make(disk, "hidden-copy", null);
	owner.settings.syncDotObsidian = true;
	const config = owner.vault.configDir;
	const path = `${config}/snippets/new.css`;
	const retained = `${config}/snippets/keep.css`;
	owner.vault.put(retained, bytes("preserved"));
	const unrelated = `${config}/snippets/KEEP.css`;
	owner.vault.put(unrelated, bytes("other casing"));
	const lookup = owner.vault.getAbstractFileByPath.bind(owner.vault);
	owner.vault.getAbstractFileByPath = (name) =>
		name === config || name.startsWith(`${config}/`) ? null : lookup(name);
	disk.folders.add(`vault/${config}`);
	disk.folders.add(`vault/${config}/snippets`);
	disk.files.set(`vault/${path}`, bytes("incoming"));
	let saved: ForceRecovery | null = null;
	let fail = true;
	const ports = {
		getRecovery: () => saved,
		persist: async (state: ForceRecovery | null) => {
			if (fail && state?.files[path]) {
				throw new Error("synthetic copy checkpoint failure");
			}
			saved = structuredClone(state);
		},
		password: async () => null,
	};
	const plan = await prepareForceReplacement(
		{
			...ports,
			client: owner.client,
			adapter: owner.adapter,
			index: owner.index,
			settings: owner.settings,
		},
		"from_remote",
	);
	assert.ok(plan);
	const partial = await applyForceReplacement(
		{
			...ports,
			client: owner.client,
			adapter: owner.adapter,
			index: owner.index,
			settings: owner.settings,
		},
		plan,
		"without-backup",
	);
	assert.equal(partial.completed, false);
	const checkpoint = JSON.parse(JSON.stringify(saved)) as ForceRecovery;
	assert.deepEqual(checkpoint.direct?.pendingFiles, [path]);
	owner.assertLocal(path, "incoming");
	owner.assertLocal(retained, "preserved");

	const restarted = make(
		disk,
		"hidden-copy",
		null,
		owner.vault,
		await owner.saved(),
	);
	restarted.settings.syncDotObsidian = true;
	const deps = {
		...ports,
		client: restarted.client,
		adapter: restarted.adapter,
		index: restarted.index,
		settings: restarted.settings,
	};
	fail = false;
	restarted.engine.setForceReplacementPorts(ports);
	const colliding = `${config}/snippets/NEW.css`;
	restarted.vault.put(colliding, bytes("late collision"));
	await assert.rejects(resumeForceReplacement(deps, checkpoint), {
		name: "ForceRecoveryPendingError",
	});
	restarted.assertLocal(colliding, "late collision");
	restarted.vault.remove(colliding);
	await restarted.full();
	assert.equal(saved, null);
	const canonical = await restarted.canonical();
	assert.equal(canonical.epoch, checkpoint.epoch);
	assert.ok(canonical.files[path]);
	restarted.assertLocal(retained, "preserved");
	restarted.assertLocal(unrelated, "other casing");

	await restarted.full();
	assert.deepEqual(await restarted.canonical(), canonical);
	assert.deepEqual(disk.files.get(`vault/${path}`), bytes("incoming"));
	restarted.assertLocal(path, "incoming");

	restarted.vault.put(path, bytes("local edit"));
	await assert.rejects(prepareForceReplacement(deps, "from_remote"), {
		name: "ForceScopeConflictError",
	});
	restarted.assertLocal(path, "local edit");
	assert.deepEqual(await restarted.canonical(), canonical);
});

test("remote Force distinguishes absent source from malformed copy metadata", async (context) => {
	for (const shape of [
		"incomplete",
		"wrong-path",
		"invalid-time",
		"404",
		"directory",
	] as const) {
		await context.test(shape, async (context) => {
			const disk = new MemoryDisk();
			const owner = managedDevices(context)(disk, "copy-metadata", null);
			const path = "note.md";
			const rawPath = `vault/${path}`;
			owner.vault.put(path, bytes("old"));
			disk.files.set(rawPath, bytes("source"));
			disk.files.set("vault/independent.md", bytes("independent"));
			let copying = false;
			let saved: ForceRecovery | null = null;
			const deps = {
				client: owner.client,
				adapter: owner.adapter,
				index: owner.index,
				settings: owner.settings,
				persist: async (state: ForceRecovery | null) => {
					if (!copying && state?.direct?.stage === "copying") {
						copying = true;
						if (shape === "404" || shape === "directory") {
							disk.files.delete(rawPath);
							if (shape === "directory") {
								disk.folders.add(rawPath);
							}
						}
					}
					saved = structuredClone(state);
				},
				password: async () => null,
			};
			const request = disk.request.bind(disk);
			disk.request = async (params, accepted) => {
				const response = await request(params, accepted);
				const url = new URL(params.url);
				if (
					copying &&
					response.status === 200 &&
					url.pathname.endsWith("/resources") &&
					url.searchParams.get("path") === rawPath
				) {
					const observed = response.json;
					if (shape === "incomplete") {
						return { ...response, json: { path: observed.path } };
					}
					if (shape === "invalid-time") {
						return {
							...response,
							json: { ...observed, modified: "invalid" },
						};
					}
					if (shape === "wrong-path") {
						return {
							...response,
							json: {
								...observed,
								type: "dir",
								path: "disk:/vault/other",
							},
						};
					}
				}
				return response;
			};

			const plan = await prepareForceReplacement(deps, "from_remote");
			assert.ok(plan);
			const outcome = await applyForceReplacement(
				deps,
				plan,
				"without-backup",
			);
			owner.assertLocal("independent.md", "independent");
			owner.assertLocal(path);
			if (shape === "404" || shape === "directory") {
				assert.equal(outcome.completed, true);
				assert.equal(saved, null);
				assert.equal((await owner.canonical()).files[path], undefined);
				return;
			}
			assert.equal(outcome.completed, false);
			assert.ok(outcome.errors.length > 0);
			assert.deepEqual(disk.files.get(rawPath), bytes("source"));
			const checkpoint = JSON.parse(
				JSON.stringify(saved),
			) as ForceRecovery;
			assert.deepEqual(checkpoint.direct?.pendingFiles, [path]);
			assert.equal(
				(await owner.canonical()).maintenance?.id,
				checkpoint.id,
			);
			disk.request = request;
			const resumed = await resumeForceReplacement(deps, checkpoint);
			assert.equal(
				(
					await applyForceReplacement(
						deps,
						resumed,
						checkpoint.backupMode,
					)
				).completed,
				true,
			);
			owner.assertLocal(path, "source");
			assert.equal((await owner.canonical()).epoch, checkpoint.epoch);
		});
	}
});
