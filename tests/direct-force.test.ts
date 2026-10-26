import assert from "node:assert/strict";
import test from "node:test";
import {
	applyForceReplacement,
	prepareForceReplacement,
} from "../src/sync/workflows/force-replacement";
import type { ForceRecovery } from "../src/sync/workflows/force-state";
import { bytes, managedDevices, MemoryDisk } from "./helpers/sync-flow";

test("direct Force replaces the entire raw destination without temporary files or destination authority", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "direct-source", null);
	owner.vault.configDir = "custom-config";
	owner.settings.syncPatterns = ["*.md"];
	owner.settings.excludePatterns = ["excluded/**"];
	owner.vault.put("excluded/settings.json", bytes("selected"));
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
	disk.files.set("vault/garbage.bin", bytes("discard"));
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
			"vault/custom-config/config.json",
			"vault/excluded/settings.json",
		].sort(),
	);
	assert.deepEqual(
		disk.files.get("vault/excluded/settings.json"),
		bytes("selected"),
	);
	assert.equal((await owner.canonical()).maintenance, undefined);
	assert.deepEqual(owner.index.getPendingMutations(), []);
	disk.beforeRequest = undefined;
	const full = await owner.full();
	assert.deepEqual([full.uploaded, full.downloaded, full.deleted], [0, 0, 0]);
	assert.ok((await owner.canonical()).files["excluded/settings.json"]);
});

test("ordinary full resumes a partial direct Force after JSON restart without deleting its completed files again", async (context) => {
	const make = managedDevices(context);
	const disk = new MemoryDisk();
	const owner = make(disk, "partial-direct", null);
	owner.vault.configDir = "custom-config";
	owner.vault.put("a.md", bytes("first"));
	owner.vault.put("b.md", bytes("second"));
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
	restarted.engine.setForceReplacementPorts(ports);
	disk.beforeRequest = async (method, _endpoint, path) => {
		assert.ok(
			!(method === "DELETE" && path === "vault/b.md"),
			"Continuation repeated the full purge",
		);
	};
	await restarted.full();
	assert.equal(saved, null);
	await restarted.assertSettled({ "a.md": "first", "b.md": "second" });
});

test("direct Force remote permanently replaces excluded local files while retaining its own installation", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "direct-target", null);
	owner.vault.configDir = "custom-config";
	owner.settings.syncPatterns = ["*.md"];
	owner.vault.put("old.bin", bytes("discard"));
	owner.vault.put(
		"custom-config/plugins/yandex-disk-sync/data.json",
		bytes("synthetic-private-state"),
	);
	owner.vault.put(".backup/keep.zip", bytes("keep"));
	disk.folders.add("vault/config");
	disk.files.set("vault/config/state.json", bytes("remote source"));
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
		chooseSourceMode: async () => "plaintext" as const,
	};
	const plan = await prepareForceReplacement(deps, "from_remote");
	assert.ok(plan);
	await applyForceReplacement(deps, plan, "without-backup");
	assert.deepEqual(
		[...owner.vault.files.keys()].sort(),
		[
			".backup/keep.zip",
			"custom-config/plugins/yandex-disk-sync/data.json",
			"config/state.json",
		].sort(),
	);
	assert.deepEqual(
		owner.vault.files.get("config/state.json"),
		bytes("remote source"),
	);
	assert.ok((await owner.canonical()).files["config/state.json"]);
});

test("direct encrypted Force includes hidden files and empty directories and preserves readable source encryption", async (context) => {
	const disk = new MemoryDisk();
	const owner = managedDevices(context)(disk, "hidden-encrypted", null);
	owner.vault.configDir = "custom-config";
	owner.settings.enableEncryption = true;
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
		owner.vault.files.get("custom-config/appearance.json"),
		bytes("selected config"),
	);
	assert.deepEqual(owner.vault.files.get(".hidden/zero.bin"), bytes(""));
	assert.equal(owner.vault.entries.has("empty/nested"), true);
	assert.equal(owner.vault.files.has("discard.bin"), false);
	assert.deepEqual(disk.files.get("vault/.obsidian-encrypt.json"), manifest);
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
		chooseSourceMode: async () => "plaintext" as const,
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
		chooseSourceMode: async () => "plaintext" as const,
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
