import assert from "node:assert/strict";
import test from "node:test";
import {
	MemoryDisk,
	bytes,
	codecFor,
	managedDevices,
} from "./helpers/sync-flow";

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";
	test(`${mode} recreated descendants retain deletes across restart and ignore old notifications`, async (t) => {
		const make = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		let a = make(disk, "device-a", codec);
		const b = make(disk, "device-b", await codecFor(encrypted));
		const paths = ["Folder/note.md", "Folder/Moved/note.md"];
		for (const path of paths) {
			a.vault.put(path, bytes("old"));
		}
		a.vault.put("Incoming/note.md", bytes("moved"));
		await a.full();
		await b.full();
		b.vault.put("Offline.md", bytes("offline"));
		// Keep the suppression window open through crypto, restart and explicit drains.
		a.settings.debounceDelay = 60_000;
		a.start();
		const oldFiles = paths.map((path) => a.vault.entries.get(path)!);
		a.vault.remove("Folder");
		await a.drain();
		a.vault.put(paths[0]!, bytes("created"));
		a.vault.rename("Incoming", "Folder/Moved");
		await a.drain();
		for (const file of oldFiles) {
			a.vault.emit("delete", file);
		}
		await a.drain();
		await a.assertSettled({
			"Folder/note.md": "created",
			"Folder/Moved/note.md": "moved",
		});

		const before = (await a.canonical()).appliedMutationSeq["device-a"]!;
		for (const path of paths) {
			a.vault.remove(path);
		}
		const deletes = a.watcher.getDeferredEvents();
		assert.deepEqual(
			deletes.map(({ action, path }) => ({ action, path })),
			paths.map((path) => ({ action: "delete", path })),
		);
		await a.stop();
		const saved = await a.saved();
		a = make(disk, "device-a", codec, a.vault, saved);
		assert.deepEqual(a.watcher.getDeferredEvents(), deletes);
		await a.index.loadRemoteIndex();
		a.start();
		await a.drain();
		const canonical = await a.canonical();
		assert.equal(canonical.appliedMutationSeq["device-a"], before + 2);
		for (const path of paths) {
			assert.equal(canonical.files[path]?.deleted, true);
			assert.equal(
				disk.files.has(await a.client.getPhysicalPath(`vault/${path}`)),
				false,
			);
		}
		await a.assertSettled({});
		await b.full();
		await a.full();
		await b.assertSettled({ "Offline.md": "offline" });
		await a.assertSettled({ "Offline.md": "offline" });
	});
}
