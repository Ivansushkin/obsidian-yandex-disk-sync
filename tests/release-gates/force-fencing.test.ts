import assert from "node:assert/strict";
import test from "node:test";
import {
	applyForceReplacement,
	prepareForceReplacement,
} from "../../src/sync/workflows/force-replacement";
import { bytes, managedDevices, MemoryDisk } from "../helpers/sync-flow";

// These preservation assertions are a release gate. No skipped cases or expected data loss.
for (const timing of ["before-execution", "accepted-async"] as const) {
	test(`server fencing preserves successor against an old Force DELETE: ${timing}`, async (context) => {
		const disk = new MemoryDisk();
		const make = managedDevices(context);
		const old = make(disk, "old-delete", null),
			next = make(disk, "successor-delete", null);
		disk.files.set("vault/note.md", bytes("initial"));
		old.vault.put("note.md", bytes("old source"));
		next.vault.put("note.md", bytes("winner"));
		const deps = (owner: typeof old) => ({
			client: owner.client,
			adapter: owner.adapter,
			index: owner.index,
			settings: owner.settings,
			persist: async () => {},
			password: async () => null,
		});
		const first = await prepareForceReplacement(deps(old), "from_local");
		assert.ok(first);
		let delayed = false;
		const barrier = async (
			method: string,
			_endpoint: string,
			path: string,
		) => {
			if (delayed || method !== "DELETE" || path !== "vault/note.md") {
				return;
			}
			delayed = true;
			const successor = await prepareForceReplacement(
				deps(next),
				"from_local",
			);
			assert.ok(successor);
			await applyForceReplacement(
				deps(next),
				successor,
				"without-backup",
			);
		};
		if (timing === "accepted-async") {
			disk.asyncOperations = (method, _endpoint, path) =>
				!delayed && method === "DELETE" && path === "vault/note.md";
			disk.beforeOperation = barrier;
		} else {
			disk.beforeRequest = barrier;
		}
		// Superseded work may fail. The successor's committed bytes must still survive.
		await assert.rejects(
			applyForceReplacement(deps(old), first, "without-backup"),
			/superseded/,
		);
		const canonical = await next.canonical();
		assert.equal(canonical.maintenance, undefined);
		assert.deepEqual(disk.files.get("vault/note.md"), bytes("winner"));
	});
}

test("server fencing prevents old ordinary PUT from becoming a new external edit after Force", async (context) => {
	const disk = new MemoryDisk(),
		make = managedDevices(context);
	const old = make(disk, "old-full", null),
		next = make(disk, "winner-full", null);
	old.vault.put("note.md", bytes("base"));
	await old.full();
	await next.full();
	old.vault.put("note.md", bytes("late old write"));
	next.vault.put("note.md", bytes("winner"));
	let delayed = false;
	disk.beforeRequest = async (method, endpoint, path) => {
		if (
			delayed ||
			method !== "PUT" ||
			endpoint !== "/upload" ||
			path !== "vault/note.md"
		) {
			return;
		}
		delayed = true;
		const deps = {
			client: next.client,
			adapter: next.adapter,
			index: next.index,
			settings: next.settings,
			persist: async () => {},
			password: async () => null,
		};
		const plan = await prepareForceReplacement(deps, "from_local");
		assert.ok(plan);
		await applyForceReplacement(deps, plan, "without-backup");
	};
	await old.engine.fullSync();
	await next.full();
	next.assertLocal("note.md", "winner");
	assert.deepEqual(disk.files.get("vault/note.md"), bytes("winner"));
});

test("server fencing preserves the successor encryption manifest against an old PUT", async (context) => {
	const disk = new MemoryDisk(),
		make = managedDevices(context);
	const old = make(disk, "old-manifest", null),
		next = make(disk, "new-manifest", null);
	for (const owner of [old, next]) {
		owner.settings.enableEncryption = true;
		owner.settings.encryptionPassword = "synthetic-password";
		owner.vault.put("note.md", bytes("source"));
	}
	const deps = (owner: typeof old) => ({
		client: owner.client,
		adapter: owner.adapter,
		index: owner.index,
		settings: owner.settings,
		persist: async () => {},
		password: async () => "synthetic-password",
	});
	const first = await prepareForceReplacement(deps(old), "from_local");
	assert.ok(first);
	let expectedSalt: string | undefined,
		delayed = false;
	disk.beforeRequest = async (method, endpoint, path) => {
		if (
			delayed ||
			method !== "PUT" ||
			endpoint !== "/upload" ||
			path !== "vault/.obsidian-encrypt.json"
		) {
			return;
		}
		delayed = true;
		const successor = await prepareForceReplacement(
			deps(next),
			"from_local",
		);
		assert.ok(successor);
		await applyForceReplacement(deps(next), successor, "without-backup");
		expectedSalt = successor.recovery.target.salt!;
	};
	await assert.rejects(
		applyForceReplacement(deps(old), first, "without-backup"),
		/superseded/,
	);
	const manifest = await next.index.downloadEncryptionManifest();
	assert.equal(manifest?.salt, expectedSalt);
});

for (const timing of ["before-execution", "accepted-async"] as const) {
	test(`server fencing preserves the successor manifest against an old DELETE: ${timing}`, async (context) => {
		const disk = new MemoryDisk(),
			make = managedDevices(context);
		const seed = make(disk, "manifest-seed", null),
			old = make(disk, "manifest-delete", null),
			next = make(disk, "manifest-winner", null);
		for (const owner of [seed, old, next]) {
			owner.vault.put("note.md", bytes("selected source"));
		}
		for (const owner of [seed, next]) {
			owner.settings.enableEncryption = true;
			owner.settings.encryptionPassword = "synthetic-password";
		}
		const deps = (owner: typeof old) => ({
			client: owner.client,
			adapter: owner.adapter,
			index: owner.index,
			settings: owner.settings,
			persist: async () => {},
			password: async () => "synthetic-password",
		});
		const seeded = await prepareForceReplacement(deps(seed), "from_local");
		assert.ok(seeded);
		await applyForceReplacement(deps(seed), seeded, "without-backup");
		const first = await prepareForceReplacement(deps(old), "from_local");
		assert.ok(first);
		let delayed = false,
			expectedSalt: string | undefined;
		const barrier = async (
			method: string,
			_endpoint: string,
			path: string,
		) => {
			if (
				delayed ||
				method !== "DELETE" ||
				path !== "vault/.obsidian-encrypt.json"
			) {
				return;
			}
			delayed = true;
			const successor = await prepareForceReplacement(
				deps(next),
				"from_local",
			);
			assert.ok(successor);
			await applyForceReplacement(
				deps(next),
				successor,
				"without-backup",
			);
			expectedSalt = successor.recovery.target.salt!;
		};
		if (timing === "accepted-async") {
			disk.asyncOperations = (method, _endpoint, path) =>
				!delayed &&
				method === "DELETE" &&
				path === "vault/.obsidian-encrypt.json";
			disk.beforeOperation = barrier;
		} else {
			disk.beforeRequest = barrier;
		}
		await assert.rejects(
			applyForceReplacement(deps(old), first, "without-backup"),
			/superseded/,
		);
		const manifest = await next.index.downloadEncryptionManifest();
		assert.equal(manifest?.salt, expectedSalt);
	});
}
