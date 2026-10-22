import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { MemoryDisk, bytes, codecFor, device } from "./helpers/sync-flow";

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";
	test(`${mode} zero-sequence refresh survives restart and offline edits without rewriting user bytes`, async () => {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "device-a", codec);
		const b = device(disk, "device-b", codec);
		let restarted: ReturnType<typeof device> | undefined;
		try {
			a.vault.put("note.md", bytes("preserved"));
			await a.full();
			await b.full();
			const physicalPath =
				await a.client.getPhysicalPath("vault/note.md");
			const physicalBytes = disk.files.get(physicalPath)!.slice(0);
			const fingerprint = createHash("sha256")
				.update(Buffer.from(physicalBytes))
				.digest("hex");
			const source = await a.canonical();
			source.files["note.md"]!.mutationSeq = 0;
			source.files["note.md"]!.remoteFingerprint =
				`sha256:${fingerprint}`;
			const canonicalBytes = bytes(JSON.stringify(source));
			disk.files.set(
				"vault/.obsidian-sync-index.json",
				codec ? await codec.encrypt(canonicalBytes) : canonicalBytes,
			);
			const original = structuredClone(source.files["note.md"]!);
			b.vault.put("note.md", bytes("offline edit"));
			a.start();
			let interrupted = false;
			disk.beforeRequest = async (method, endpoint, path) => {
				if (
					!interrupted &&
					method === "PUT" &&
					endpoint === "/upload" &&
					path.includes(".obsidian-sync-index.lock.")
				) {
					interrupted = true;
					a.vault.put("late.md", bytes("late event"));
					throw new Error("synthetic interrupted metadata commit");
				}
			};
			const failed = await a.engine.fullSync();
			assert.equal(interrupted, true);
			assert.equal(failed.success, false);
			assert.equal(a.index.getObservedRevision(), source.revision);
			assert.deepEqual((await a.canonical()).files, source.files);
			assert.deepEqual(disk.files.get(physicalPath), physicalBytes);
			disk.beforeRequest = undefined;
			await a.stop();
			const saved = await a.saved();
			assert.equal(
				saved.pendingWatcherEvents.some(
					(event) => event.path === "late.md",
				),
				true,
			);
			restarted = device(disk, "device-a", codec, a.vault, saved);
			let lostResponse = false;
			disk.afterRequest = async (_method, endpoint, path) => {
				if (
					!lostResponse &&
					endpoint.endsWith("/resources/move") &&
					path === "vault/.obsidian-sync-index.json"
				) {
					lostResponse = true;
					throw new Error(
						"synthetic lost canonical publication response",
					);
				}
			};
			await restarted.full();
			assert.equal(lostResponse, true);
			disk.afterRequest = undefined;
			await restarted.assertSettled({
				"note.md": "preserved",
				"late.md": "late event",
			});
			const repaired = await restarted.canonical();
			assert.deepEqual(repaired.files["note.md"], {
				...original,
				remoteFingerprint: fingerprint,
			});
			assert.deepEqual(disk.files.get(physicalPath), physicalBytes);
			const noop = await restarted.full();
			assert.equal(
				noop.uploaded + noop.downloaded + noop.deleted + noop.conflicts,
				0,
			);
			assert.equal(
				(await restarted.canonical()).revision,
				repaired.revision,
			);
			await b.full();
			await restarted.full();
			await b.assertSettled({
				"note.md": "offline edit",
				"late.md": "late event",
			});
			await restarted.assertSettled({
				"note.md": "offline edit",
				"late.md": "late event",
			});
		} finally {
			disk.beforeRequest = undefined;
			disk.afterRequest = undefined;
			await a.stop();
			await b.stop();
			await restarted?.stop();
		}
	});
}
