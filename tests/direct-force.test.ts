import assert from "node:assert/strict";
import test from "node:test";
import {
	applyForceReplacement,
	prepareForceReplacement,
	resumeForceReplacement,
} from "../src/sync/workflows/force-replacement";
import type { ForceRecovery } from "../src/sync/workflows/force-state";
import { bytes, managedDevices, MemoryDisk } from "./helpers/sync-flow";

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
		persist: async () => {},
		password: async () => "synthetic-direct-password",
	};
	const upload = await prepareForceReplacement(deps, "from_local");
	assert.ok(upload);
	assert.equal(
		(await applyForceReplacement(deps, upload, "without-backup")).completed,
		true,
	);
	const manifest = disk.files.get("vault/.obsidian-encrypt.json")!.slice(0);
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

test("retrying a failed subtree purge recopies files written during the partial attempt", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "subtree-retry", null);
	owner.vault.configDir = "custom-config";
	owner.vault.put("tree/new.md", bytes("selected"));
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
	assert.deepEqual(disk.files.get("vault/tree/new.md"), bytes("selected"));
	disk.beforeRequest = undefined;
	owner.engine.setForceReplacementPorts(ports);
	await owner.full();
	assert.equal(saved, null);
	assert.equal(disk.files.has("vault/tree/obsolete.md"), false);
	assert.deepEqual(disk.files.get("vault/tree/new.md"), bytes("selected"));
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

test("unload during a Force download prevents the following local mutation", async (context) => {
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
	disk.afterRequest = async (_method, endpoint, path) => {
		if (copying && endpoint === "/download" && path === "vault/source.md") {
			cancelled = true;
		}
	};
	const result = await applyForceReplacement(deps, plan, "without-backup");
	assert.equal(cancelled, true);
	assert.equal(result.completed, false);
	assert.equal(owner.vault.files.has("source.md"), false);
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
		preflight: async () => ({
			migration: false,
			canonical: { state: "absent" },
			replacement: {
				plan,
				backupMode: "without-backup",
				continuing: false,
			},
		}),
		confirm: async (
			_direction,
			_migration,
			_replacement,
			prepareArchive,
		) => {
			void prepareArchive!();
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
		beforeMutation: async () => {},
		run: async () => {
			throw new Error("Cancelled Force must not mutate");
		},
		persist: async () => {},
		replacementCommitted: () => {},
		reconcile: async () => null,
		hasPendingCleanup: () => false,
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
	const controller = new ForceSyncController({
		isSyncBusy: () => false,
		preflight: async () => ({
			migration: false,
			canonical: { state: "absent" },
			replacement: {
				plan: (await prepareForceReplacement(
					deps,
					"from_remote",
					true,
				))!,
				backupMode: "without-backup",
			},
		}),
		confirm: async (_direction, _migration, replacement, archive) => {
			owner.assertLocal("local.md", "keep in archive");
			await assert.rejects(archive!());
			owner.assertLocal("local.md", "keep in archive");
			rejectArchive = false;
			await archive!();
			const name = replacement!.plan.recovery.backupProof!.name;
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
		backup: (_direction, progress, replacement) =>
			owner.index.withForceScope(replacement!.plan.recovery, () =>
				backup.createBackup(undefined, progress, true),
			),
		beforeMutation: async () => {},
		run: async (_direction, options) => {
			const applied = await applyForceReplacement(
				deps,
				options.forceReplacement!.plan,
				"with-backup",
			);
			return {
				...applied,
				success: applied.completed,
				replacementCommitted: applied.completed,
				conflicts: 0,
				startTime: 1,
				endTime: 2,
			};
		},
		persist: async () => {},
		replacementCommitted: () => {},
		reconcile: async () => null,
		hasPendingCleanup: () => false,
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
