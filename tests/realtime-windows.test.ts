import assert from "node:assert/strict";
import test from "node:test";
import { computeSha256 } from "../src/utils/hash-utils";
import {
	MemoryDisk,
	bytes,
	codecFor,
	managedDevices,
} from "./helpers/sync-flow";

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";
	test(`${mode} realtime windows settle a committed receipt before the next window`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const a = device(disk, "device-a", await codecFor(encrypted));
		await a.full();
		a.start();
		const expected: Record<string, string> = {};
		for (let i = 0; i < 65; i++) {
			const path = `Note${i}.md`;
			expected[path] = `content ${i}`;
			a.vault.put(path, bytes(expected[path]));
		}
		const ids = a.watcher.getDeferredEvents().map((event) => event.id);
		let renamed = false;
		disk.beforeRequest = async (method, endpoint, path) => {
			if (
				!renamed &&
				method === "PUT" &&
				endpoint === "/upload" &&
				path.includes(".lock.")
			) {
				renamed = true;
				a.vault.rename("Note0.md", "Final.md");
			}
		};
		const read = a.adapter.readFile.bind(a.adapter);
		let boundary:
			| {
					committed: boolean;
					acknowledged: boolean;
					handedOff: boolean;
					busy: boolean;
					latePredecessor: string | undefined;
			  }
			| undefined;
		a.adapter.readFile = async (path) => {
			if (path === "Note32.md") {
				a.vault.rename("Note1.md", "AfterWindow.md");
				const lateRename = a.watcher
					.getDeferredEvents()
					.find(
						(event) =>
							event.action === "rename" &&
							event.targetPath === "AfterWindow.md",
					);
				const canonical = await a.canonical();
				const saved = a.lastSaved();
				const rename = saved.pendingWatcherEvents.find(
					(event) => event.action === "rename",
				);
				boundary = {
					committed:
						canonical.files["Note0.md"]?.sha256 ===
						(await computeSha256(bytes("content 0"))),
					acknowledged: !saved.pendingWatcherEvents.some((event) =>
						ids.slice(0, 32).includes(event.id),
					),
					handedOff: rename?.baseRevision === canonical.revision,
					busy: a.engine.hasPendingWork(),
					latePredecessor:
						lateRename?.action === "rename"
							? lateRename.predecessorUploadId
							: "missing",
				};
			}
			return read(path);
		};
		await a.drain();
		disk.beforeRequest = undefined;
		assert.deepEqual(boundary, {
			committed: true,
			acknowledged: true,
			handedOff: true,
			busy: true,
			latePredecessor: undefined,
		});
		assert.equal(renamed, true);
		delete expected["Note0.md"];
		expected["Final.md"] = "content 0";
		delete expected["Note1.md"];
		expected["AfterWindow.md"] = "content 1";
		await a.drain();
		await a.assertSettled(expected);
		const b = device(disk, "device-b", await codecFor(encrypted));
		await b.full();
		await b.assertSettled(expected);
	});

	test(`${mode} middle realtime window failure preserves prefix and retry identities across restart`, async (t) => {
		const device = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		let a = device(disk, "device-a", codec);
		await a.full();
		const b = device(disk, "device-b", await codecFor(encrypted));
		await b.full();
		b.vault.put("Offline.md", bytes("offline"));
		a.start();
		const expected: Record<string, string> = { "Offline.md": "offline" };
		for (let i = 0; i < 65; i++) {
			const path = `Note${i}.md`;
			expected[path] = `content ${i}`;
			a.vault.put(path, bytes(expected[path]));
		}
		const ids = a.watcher.getDeferredEvents().map((event) => event.id);
		const failedPath = await a.client.getPhysicalPath("vault/Note40.md");
		let lostResponse = false;
		disk.afterRequest = async (method, endpoint, path) => {
			if (
				method === "PUT" &&
				endpoint === "/upload" &&
				path === failedPath
			) {
				lostResponse = true;
				throw new Error("Synthetic middle window lost response");
			}
		};
		const read = a.adapter.readFile.bind(a.adapter);
		const reads: string[] = [];
		a.adapter.readFile = async (path) => {
			reads.push(path);
			return read(path);
		};
		await a.drain();
		await a.stop();
		disk.afterRequest = undefined;
		assert.equal(lostResponse, true);
		assert.equal(reads.includes("Note64.md"), false);
		const saved = await a.saved();
		assert.deepEqual(
			saved.pendingWatcherEvents.map((event) => event.id),
			ids.slice(40),
		);
		const pending = saved.pendingMutations.map(({ id, seq }) => ({
			id,
			seq,
		}));
		assert.equal(pending.length, 24);
		assert.equal((await a.canonical()).appliedMutationSeq["device-a"], 40);
		const prefixPhysical = new Set(
			await Promise.all(
				Array.from({ length: 40 }, (_, i) =>
					a.client.getPhysicalPath(`vault/Note${i}.md`),
				),
			),
		);
		disk.beforeRequest = async (method, endpoint, path) => {
			assert.equal(
				method === "PUT" &&
					endpoint === "/upload" &&
					prefixPhysical.has(path),
				false,
			);
		};
		a = device(disk, "device-a", codec, a.vault, saved);
		await a.index.loadRemoteIndex();
		assert.deepEqual(
			a.index.getPendingMutations().map(({ id, seq }) => ({ id, seq })),
			pending,
		);
		a.start();
		await a.drain();
		disk.beforeRequest = undefined;
		assert.equal((await a.canonical()).appliedMutationSeq["device-a"], 65);
		assert.deepEqual(a.index.getPendingMutations(), []);
		await b.full();
		await a.full();
		await b.full();
		await a.assertSettled(expected);
		await b.assertSettled(expected);
	});
}

test("realtime byte windows isolate oversized files and rehash changed-size reads", async (t) => {
	const device = managedDevices(t);
	const disk = new MemoryDisk();
	const a = device(disk, "device-a", null);
	await a.full();
	a.start();
	const expected = {
		"First.md": "a".repeat(5 * 1024 * 1024),
		"Drift.md": "b".repeat(5 * 1024 * 1024),
		"Large.md": "c".repeat(9 * 1024 * 1024),
		"Last.md": "end",
	};
	for (const [path, text] of Object.entries(expected)) {
		a.vault.put(path, bytes(text));
	}
	a.adapter.getFile("Drift.md")!.stat.size = 1;
	const read = a.adapter.readFile.bind(a.adapter);
	let driftReads = 0;
	let firstCommittedBeforeReread = false;
	let oversizedCommittedBeforeLastRead = false;
	a.adapter.readFile = async (path) => {
		if (path === "Drift.md" && ++driftReads === 2) {
			expected["Drift.md"] = "changed after first read";
			a.vault.put(path, bytes(expected["Drift.md"]), false);
			firstCommittedBeforeReread = Boolean(
				(await a.canonical()).files["First.md"],
			);
		}
		if (path === "Last.md") {
			oversizedCommittedBeforeLastRead = Boolean(
				(await a.canonical()).files["Large.md"],
			);
		}
		return read(path);
	};
	await a.drain();
	assert.equal(driftReads, 2);
	assert.equal(firstCommittedBeforeReread, true);
	assert.equal(oversizedCommittedBeforeLastRead, true);
	await a.assertSettled(expected);
});
