import assert from "node:assert/strict";
import test from "node:test";
import { captureRemoteRawSnapshot } from "../src/backup/backup-snapshot";
import {
	bytes,
	codecFor,
	managedDevices,
	MemoryDisk,
} from "./helpers/sync-flow";

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";
	test(`${mode} unreadable live file never becomes a deletion across restart`, async (t) => {
		const make = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		let a = make(disk, "device-a", codec);
		const b = make(disk, "device-b", codec);
		a.vault.put("note.md", bytes("valuable original"));
		a.vault.put("other.md", bytes("initial"));
		await a.full();
		await b.full();
		// A returns offline after B has advanced canonical beyond A's baseline.
		b.vault.put("other.md", bytes("remote edit"));
		await b.full();
		a.settings.excludePatterns = [
			...a.settings.excludePatterns,
			"excluded/**",
		];
		a.vault.put("excluded/private.md", bytes("excluded"));
		a.vault.put(".backup/private.md", bytes("protected"));
		const read = a.vault.readBinary.bind(a.vault);
		const failure = new Error("synthetic local read failure");
		let unreadable = true;
		a.vault.readBinary = async (file) => {
			if (
				(unreadable && file.path === "note.md") ||
				file.path.endsWith("private.md")
			) {
				throw failure;
			}
			return await read(file);
		};
		const before = await a.saved();
		const remote = structuredClone(disk.files);
		for (let pass = 0; pass < 2; pass++) {
			const result = await a.engine.fullSync();
			assert.equal(result.success, false);
			assert.equal(result.errors[0]?.failureCause?.cause, failure);
			assert.equal(
				result.deleted + result.uploaded + result.downloaded,
				0,
			);
			assert.deepEqual(await a.saved(), before);
			assert.deepEqual(disk.files, remote);
			a.assertLocal("note.md", "valuable original");
			await a.stop();
			a = make(disk, "device-a", codec, a.vault, await a.saved());
			a.settings.excludePatterns = [
				...a.settings.excludePatterns,
				"excluded/**",
			];
		}
		await b.full();
		b.assertLocal("note.md", "valuable original");
		unreadable = false;
		await a.full();
		await a.assertSettled({
			"note.md": "valuable original",
			"other.md": "remote edit",
		});
		// A real absence still publishes a tombstone and propagates to B.
		a.vault.remove("note.md");
		await a.full();
		await b.full();
		assert.equal((await b.canonical()).files["note.md"]?.deleted, true);
		await a.assertSettled({ "other.md": "remote edit" });
		await b.assertSettled({ "other.md": "remote edit" });
		a.assertLocal("excluded/private.md", "excluded");
		a.assertLocal(".backup/private.md", "protected");
	});

	test(`${mode} unreadable scans block initial receive and epoch adoption`, async (t) => {
		const make = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = make(disk, "device-a", codec);
		const b = make(disk, "device-b", codec);
		a.vault.put("note.md", bytes("cloud"));
		await a.full();
		b.vault.put("note.md", bytes("initial local"));
		b.vault.put("local-only.md", bytes("new file"));
		const read = b.vault.readBinary.bind(b.vault);
		const failure = new Error("synthetic unreadable source");
		let unreadable: string | null = "local-only.md";
		b.vault.readBinary = async (file) => {
			if (file.path === unreadable) {
				throw failure;
			}
			return await read(file);
		};
		let remote = structuredClone(disk.files);
		const initial = await b.engine.fullSync();
		assert.equal(initial.success, false);
		assert.equal(initial.errors[0]?.failureCause?.cause, failure);
		assert.equal(b.index.getLocalIndex().observedRevision, 0);
		assert.equal(b.index.getLocalIndex().lastSyncTime, 0);
		assert.deepEqual(b.index.getLocalIndex().files, {});
		assert.deepEqual(disk.files, remote);
		b.assertLocal("note.md", "initial local");
		b.assertLocal("local-only.md", "new file");
		unreadable = null;
		await b.full();
		await b.assertSettled({
			"note.md": "cloud",
			"local-only.md": "new file",
		});
		await a.full();
		a.vault.put("note.md", bytes("replacement"));
		const canonical = await a.index.captureForceCanonicalProof();
		const snapshot = await captureRemoteRawSnapshot(a.client, "vault");
		const force = await a.engine.forceSyncFromLocal({
			forcePreflightProof: {
				direction: "from_local",
				canonical,
				snapshotDigest: snapshot.digest,
				backup: null,
			},
		});
		assert.equal(force.success, true, JSON.stringify(force.errors));
		const epoch = (await a.canonical()).epoch;
		const before = await b.saved();
		assert.notEqual(epoch, before.localState.observedEpoch);
		remote = structuredClone(disk.files);
		unreadable = "note.md";
		const adoption = await b.engine.fullSync({
			epochAdoption: { epoch, decision: "accept" },
		});
		assert.equal(adoption.success, false);
		assert.equal(adoption.errors[0]?.failureCause?.cause, failure);
		assert.notEqual(adoption.epochAdopted, true);
		assert.deepEqual(await b.saved(), before);
		assert.deepEqual(disk.files, remote);
		b.assertLocal("note.md", "cloud");
		unreadable = null;
		assert.equal((await b.full()).epochAdopted, true);
		await b.assertSettled({
			"note.md": "replacement",
			"local-only.md": "new file",
		});
	});
}
