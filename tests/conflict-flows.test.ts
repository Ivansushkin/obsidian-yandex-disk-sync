import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { MemoryDisk, bytes, codecFor, device } from "./helpers/sync-flow";
import { computeSha256 } from "../src/utils/hash-utils";
import {
	repairMissingAcceptedUploads,
	type Dependencies,
} from "../src/sync/reconciliation/commits";
import type { SyncIndex } from "../src/types";
import {
	StorageBindingController,
	type StorageBindingChoice,
} from "../src/sync/local/storage-binding";

test("storage confirmation preserves queued work and rolls back a failed save", async () => {
	const disk = new MemoryDisk();
	const a = device(disk, "a", null);
	try {
		a.vault.put("note.md", bytes("kept"));
		await a.full();
		const mutation = a.index.enqueueMutation("put", "pending.md", {
			sha256: "pending",
		});
		let choice: StorageBindingChoice = "cancel";
		let failSave = true;
		const controller = new StorageBindingController({
			client: a.client,
			index: a.index,
			getSettings: () => a.settings,
			hasPendingWork: () => a.index.getPendingMutations().length > 0,
			hasTransition: () => false,
			isUnloaded: () => false,
			confirm: async () => choice,
			persist: async () => {
				if (failSave) {
					throw new Error("synthetic persistence failure");
				}
			},
		});
		const remote = [...disk.files];
		assert.equal(await controller.ensure(true), false);
		choice = "new";
		await assert.rejects(controller.ensure(true), /pending work/);
		choice = "same";
		await assert.rejects(controller.ensure(true), /persistence failure/);
		assert.equal(a.index.getLocalIndex().remoteScope, null);
		assert.deepEqual(a.index.getPendingMutations(), [mutation]);
		assert.deepEqual([...disk.files], remote);
		failSave = false;
		assert.equal(await controller.ensure(true), true);
		assert.equal(
			a.index.getLocalIndex().remoteScope?.rootResourceId,
			`${disk.identity}:vault`,
		);
		assert.deepEqual(a.index.getPendingMutations(), [mutation]);
	} finally {
		await a.stop();
	}
});

test("explicit new storage creates its root without carrying previous history", async () => {
	const disk = new MemoryDisk();
	const a = device(disk, "a", null);
	try {
		a.vault.put("note.md", bytes("kept"));
		await a.full();
		a.index.getLocalIndex().remoteScope = {
			remotePath: "vault",
			rootResourceId: `${disk.identity}:vault`,
		};
		a.settings.remotePath = "other";
		a.client.setRemotePath("other");
		const controller = new StorageBindingController({
			client: a.client,
			index: a.index,
			getSettings: () => a.settings,
			hasPendingWork: () => false,
			hasTransition: () => false,
			isUnloaded: () => false,
			confirm: async () => "new",
			persist: async () => {},
		});
		assert.equal(await controller.ensure(true), true);
		assert.equal(a.index.getLocalIndex().remoteScope?.remotePath, "other");
		assert.deepEqual(a.index.getLocalIndex().files, {});
		assert.deepEqual(a.vault.files.get("note.md"), bytes("kept"));
		assert.deepEqual(
			await a.client.downloadFile("vault/note.md"),
			bytes("kept"),
		);
	} finally {
		await a.stop();
	}
});

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";

	test(`${mode} download write guard preserves root and late local changes`, async () => {
		for (const timing of ["download", "write", "local-edit"] as const) {
			const disk = new MemoryDisk();
			const codec = await codecFor(encrypted);
			const a = device(disk, "a", codec);
			const b = device(disk, "b", codec);
			try {
				a.vault.put("note.md", bytes("original"));
				await a.full();
				await b.full();
				b.vault.put("note.md", bytes("remote edit"));
				await b.full();
				a.index.getLocalIndex().remoteScope = {
					remotePath: "vault",
					rootResourceId: `${disk.identity}:vault`,
				};
				const baseline = structuredClone(a.index.getLocalIndex());
				let replaced = false;
				const resource = disk.resource.bind(disk);
				disk.resource = async (path) => {
					const result = await resource(path);
					return result && replaced && path === "vault"
						? { ...result, resource_id: "replacement-root" }
						: result;
				};
				const physicalPath =
					await a.client.getPhysicalPath("vault/note.md");
				disk.beforeRequest = async (_method, endpoint, path) => {
					if (
						timing === "download" &&
						endpoint === "/download" &&
						path === physicalPath
					) {
						replaced = true;
					}
				};
				const write = a.adapter.writeFile.bind(a.adapter);
				let preparingWrite = false;
				const assertScope = a.index.assertRemoteScope.bind(a.index);
				a.index.assertRemoteScope = async () => {
					await assertScope();
					if (timing === "local-edit" && preparingWrite) {
						a.vault.put("note.md", bytes("late edit"));
					}
				};
				a.adapter.writeFile = async (...args) => {
					preparingWrite = true;
					if (timing === "write") {
						replaced = true;
					}
					return await write(...args);
				};
				assert.equal((await a.engine.fullSync()).success, false);
				assert.equal(replaced, timing !== "local-edit");
				assert.deepEqual(
					a.vault.files.get("note.md"),
					bytes(timing === "local-edit" ? "late edit" : "original"),
				);
				assert.deepEqual(a.index.getLocalIndex(), baseline);
			} finally {
				await a.stop();
				await b.stop();
			}
		}
	});

	test(`${mode} lost PUT response is confirmed without abandoning its mutation`, async () => {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		try {
			a.vault.put("note.md", bytes("original"));
			await a.full();
			const nextSequence = a.index.getLocalIndexData().nextMutationSeq;
			a.vault.put("note.md", bytes("new bytes"));
			const physicalPath =
				await a.client.getPhysicalPath("vault/note.md");
			let lost = false;
			disk.afterRequest = async (method, endpoint, path) => {
				if (
					!lost &&
					method === "PUT" &&
					endpoint === "/upload" &&
					path === physicalPath
				) {
					lost = true;
					throw new Error("synthetic lost PUT response");
				}
			};
			await a.full();
			assert.equal(lost, true);
			await a.assertSettled({ "note.md": "new bytes" });
			assert.equal(
				(await a.canonical()).files["note.md"]!.mutationSeq,
				nextSequence,
			);
		} finally {
			await a.stop();
		}
	});

	test(`${mode} ambiguous PUT never confirms revoked authority`, async () => {
		for (const change of [
			"winner",
			"tombstone",
			"epoch",
			"codec",
		] as const) {
			const disk = new MemoryDisk();
			const codec = await codecFor(encrypted);
			const a = device(disk, "a", codec);
			const b = device(disk, "b", codec);
			try {
				a.vault.put("note.md", bytes("original"));
				await a.full();
				await b.full();
				let authority = "initial";
				a.engine.setSyncGuardCallback((token) => ({
					blockReason:
						token !== undefined && token !== authority
							? "synthetic codec changed"
							: null,
					validationToken: authority,
				}));
				a.vault.put("note.md", bytes("local edit"));
				const physical =
					await a.client.getPhysicalPath("vault/note.md");
				let lost = false;
				disk.afterRequest = async (method, endpoint, path) => {
					if (
						lost ||
						method !== "PUT" ||
						endpoint !== "/upload" ||
						path !== physical
					) {
						return;
					}
					lost = true;
					if (change === "winner") {
						b.vault.put("note.md", bytes("foreign winner"));
						await b.engine.uploadFile("note.md");
						const mutation = b.index.enqueueMutation(
							"put",
							"note.md",
							{
								sha256: await computeSha256(
									bytes("foreign winner"),
								),
							},
						);
						b.index.getRemoteIndex().files["note.md"]!.mutationSeq =
							mutation.seq;
						b.index.stageMutation(mutation);
						await b.index.saveRemoteIndex();
					} else if (change === "tombstone") {
						b.vault.remove("note.md");
						await b.full();
					} else if (change === "epoch") {
						const canonical = await b.canonical();
						canonical.epoch = "replacement-epoch";
						const content = bytes(JSON.stringify(canonical));
						disk.files.set(
							"vault/.obsidian-sync-index.json",
							codec ? await codec.encrypt(content) : content,
						);
					} else {
						authority = "replacement";
					}
					throw new Error("synthetic lost PUT response");
				};
				assert.equal(
					(await a.engine.fullSync()).success,
					false,
					change,
				);
				assert.equal(lost, true);
				assert.equal(a.index.getPendingMutations().length, 1);
				assert.deepEqual(
					a.vault.files.get("note.md"),
					bytes("local edit"),
				);
				if (change === "winner") {
					assert.deepEqual(
						await b.client.downloadFile("vault/note.md"),
						bytes("foreign winner"),
					);
				} else if (change === "tombstone") {
					assert.equal(
						(await b.canonical()).files["note.md"]!.deleted,
						true,
					);
					assert.equal(disk.files.has(physical), false);
				}
			} finally {
				disk.afterRequest = undefined;
				await a.stop();
				await b.stop();
			}
		}
	});

	test(`${mode} corrective PUT confirms a lost response with its retained copy`, async () => {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		try {
			a.vault.put("note.md", bytes("accepted"));
			await a.full();
			await a.client.uploadFile(
				"vault/note.md",
				bytes("external version"),
			);
			const physical = await a.client.getPhysicalPath("vault/note.md");
			Object.assign(a.client, { maxRetries: 1 });
			let lost = false;
			disk.afterRequest = async (method, endpoint, path) => {
				if (
					!lost &&
					method === "PUT" &&
					endpoint === "/upload" &&
					path === physical
				) {
					lost = true;
					throw new Error("synthetic lost corrective response");
				}
			};
			const access = a.engine as unknown as {
				syncReconciliationDependencies(): Dependencies;
			};
			await repairMissingAcceptedUploads(
				access.syncReconciliationDependencies(),
				["note.md"],
			);
			assert.equal(lost, true);
			assert.equal(
				(await a.canonical()).files["note.md"]!.remoteFingerprint,
				(await a.client.getLogicalResource("vault/note.md"))!.sha256,
			);
			const copy = [...a.vault.files.keys()].find((name) =>
				name.includes("_conflict_"),
			)!;
			await a.full();
			await a.assertSettled({
				"note.md": "accepted",
				[copy]: "external version",
			});
		} finally {
			await a.stop();
		}
	});

	test(`${mode} partial upload retains unresolved FIFO across restart`, async () => {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		let restarted: ReturnType<typeof device> | undefined;
		try {
			a.vault.put("first.md", bytes("first old"));
			a.vault.put("second.md", bytes("second old"));
			a.vault.put("delete.md", bytes("delete later"));
			a.vault.put("conflict.md", bytes("base"));
			await a.full();
			const before = await a.canonical();
			a.vault.put("first.md", bytes("first new"));
			a.vault.put("second.md", bytes("second new"));
			a.vault.remove("delete.md");
			a.vault.put("conflict.md", bytes("local conflict"));
			await a.client.uploadFile(
				"vault/conflict.md",
				bytes("remote conflict"),
			);
			await a.client.uploadFile(
				"vault/download.md",
				bytes("download later"),
			);
			const second = await a.client.getPhysicalPath("vault/second.md");
			let lost = false;
			disk.afterRequest = async (method, endpoint, path) => {
				if (
					!lost &&
					method === "PUT" &&
					endpoint === "/upload" &&
					path === second
				) {
					lost = true;
					throw new Error("synthetic lost PUT response");
				}
			};
			disk.beforeRequest = async (_method, endpoint, path) => {
				if (lost && endpoint === "/download" && path === second) {
					throw new Error("synthetic unavailable read-back");
				}
			};
			const failed = await a.engine.fullSync();
			assert.equal(failed.success, false);
			assert.match(
				a.engine.getState().errorMessage ?? "",
				/synthetic unavailable read-back/,
			);
			assert.equal(
				failed.downloaded + failed.deleted + failed.conflicts,
				0,
			);
			assert.equal(a.vault.files.has("download.md"), false);
			assert.deepEqual(
				await a.client.downloadFile("vault/delete.md"),
				bytes("delete later"),
			);
			assert.deepEqual(
				[...a.vault.files.keys()].filter((path) =>
					path.includes("_conflict_"),
				),
				[],
			);
			assert.deepEqual(
				a.vault.files.get("conflict.md"),
				bytes("local conflict"),
			);
			const saved = a.lastSaved();
			assert.equal(saved.pendingMutations.length, 2);
			assert.equal(
				saved.localState.files["first.md"]!.sha256,
				await computeSha256(bytes("first new")),
			);
			assert.equal(
				(await a.canonical()).appliedMutationSeq.a,
				before.appliedMutationSeq.a,
			);
			await a.stop();
			disk.beforeRequest = undefined;
			disk.afterRequest = undefined;
			restarted = device(disk, "a", codec, a.vault, saved);
			assert.deepEqual(
				restarted.index.getPendingMutations(),
				saved.pendingMutations,
			);
			await restarted.full();
			const copy = [...a.vault.files.keys()].find((path) =>
				path.startsWith("conflict_conflict_"),
			)!;
			await restarted.assertSettled({
				"first.md": "first new",
				"second.md": "second new",
				"download.md": "download later",
				"conflict.md": "remote conflict",
				[copy]: "local conflict",
			});
		} finally {
			disk.beforeRequest = undefined;
			disk.afterRequest = undefined;
			await a.stop();
			await restarted?.stop();
		}
	});

	test(`${mode} returning state cannot carry deletions to another storage`, async () => {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		try {
			a.vault.put("note.md", bytes("old storage"));
			await a.full();
			const root = await a.client.getResource("vault", 1, 0, true);
			Object.assign(a.index.getLocalIndex(), {
				remoteScope: {
					remotePath: "vault",
					rootResourceId: root!.resource_id,
				},
			});
			a.vault.remove("note.md");
			b.settings.remotePath = "other";
			b.client.setRemotePath("other");
			b.vault.put("note.md", bytes("other storage"));
			await b.full();
			a.settings.remotePath = "other";
			a.client.setRemotePath("other");
			assert.equal((await a.engine.fullSync()).success, false);
			assert.deepEqual(
				await b.client.downloadFile("other/note.md"),
				bytes("other storage"),
			);
		} finally {
			await a.stop();
			await b.stop();
		}
	});

	test(`${mode} restored actor counter cannot report a stale canonical as success`, async () => {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		let restarted: ReturnType<typeof device> | undefined;
		try {
			a.vault.put("note.md", bytes("first"));
			await a.full();
			a.vault.put("note.md", bytes("second"));
			await a.full();
			await a.stop();
			restarted = device(disk, "a", codec, a.vault);
			await restarted.full();
			restarted.vault.put("note.md", bytes("after restart"));
			assert.equal((await restarted.full()).conflicts, 0);
			await restarted.assertSettled({ "note.md": "after restart" });
		} finally {
			await a.stop();
			await restarted?.stop();
		}
	});

	test(`${mode} full compares content before preserving a conflict`, async () => {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		try {
			a.vault.put("note.md", bytes("base"));
			await a.full();
			await b.full();
			b.vault.put("note.md", bytes("same edit"));
			a.vault.put("note.md", bytes("same edit"));
			await a.full();
			assert.equal((await b.full()).conflicts, 0);
			await b.assertSettled({ "note.md": "same edit" });

			await a.full();
			a.vault.put("note.md", bytes("temporary edit"));
			await a.full();
			a.vault.put("note.md", bytes("same edit"));
			await a.full();
			b.vault.put("note.md", bytes("useful edit"));
			assert.equal((await b.full()).conflicts, 0);
			await b.assertSettled({ "note.md": "useful edit" });

			await a.full();
			a.vault.put("folder/old.md", bytes("old child"));
			await a.full();
			await b.full();
			a.vault.remove("folder");
			await a.engine.deleteFolder("folder");
			await a.client.uploadFile(
				"vault/folder/new.md",
				bytes("same survivor"),
			);
			b.vault.put("folder/new.md", bytes("same survivor"));
			assert.equal((await b.full()).conflicts, 0);
			await b.assertSettled({
				"note.md": "useful edit",
				"folder/new.md": "same survivor",
			});
		} finally {
			await a.stop();
			await b.stop();
		}
	});

	test(`${mode} changed fingerprint representation does not imply changed content`, async () => {
		const disk = new MemoryDisk();
		const resource = disk.resource.bind(disk);
		let useSha = false;
		disk.resource = async (path) => {
			const result = await resource(path);
			if (
				result?.type === "file" &&
				!path.includes(".obsidian-sync-index") &&
				!useSha
			) {
				return {
					...result,
					sha256: undefined,
					md5: createHash("md5")
						.update(Buffer.from(disk.files.get(path)!))
						.digest("hex"),
				};
			}
			return result;
		};
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		try {
			a.vault.put("note.md", bytes("base"));
			await a.full();
			await b.full();
			useSha = true;
			b.vault.put("note.md", bytes("useful edit"));
			assert.equal((await b.full()).conflicts, 0);
			await b.assertSettled({ "note.md": "useful edit" });
			await a.client.uploadFile("vault/note.md", bytes("useful edit"));
			b.vault.put("note.md", bytes("next edit"));
			assert.equal((await b.full()).conflicts, 0);
			await b.assertSettled({ "note.md": "next edit" });
		} finally {
			await a.stop();
			await b.stop();
		}
	});

	test(`${mode} conflict retry preserves one copy across restart`, async () => {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		let restarted: ReturnType<typeof device> | undefined;
		try {
			a.vault.put("note.md", bytes("base"));
			await a.full();
			await b.full();
			a.vault.put("note.md", bytes("remote edit"));
			await a.full();
			b.vault.put("note.md", bytes("local edit"));
			const original = await b.client.getPhysicalPath("vault/note.md");
			disk.beforeRequest = async (_method, endpoint, path) => {
				if (
					endpoint === "/download" &&
					path === original &&
					[...b.vault.files.keys()].some((name) =>
						name.includes("_conflict_"),
					)
				) {
					throw new Error("synthetic interrupted winner download");
				}
			};
			assert.equal((await b.engine.fullSync()).success, false);
			const copies = [...b.vault.files.keys()].filter((path) =>
				path.includes("_conflict_"),
			);
			assert.equal(copies.length, 1);
			const saved = await b.saved();
			await b.stop();
			disk.beforeRequest = undefined;
			restarted = device(disk, "b", codec, b.vault, saved);
			await restarted.full();
			await restarted.assertSettled({
				"note.md": "remote edit",
				[copies[0]!]: "local edit",
			});
		} finally {
			disk.beforeRequest = undefined;
			await a.stop();
			await b.stop();
			await restarted?.stop();
		}
	});
	test(`${mode} rejected copy commit cannot authorize replacing the original`, async () => {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		let injected = false;
		try {
			a.vault.put("note.md", bytes("base"));
			await a.full();
			await b.full();
			a.vault.put("note.md", bytes("remote edit"));
			await a.full();
			b.vault.put("note.md", bytes("local edit"));
			disk.beforeRequest = async (_method, endpoint, path) => {
				const copy = [...b.vault.files.keys()].find((name) =>
					name.includes("_conflict_"),
				);
				if (
					injected ||
					!copy ||
					!endpoint.endsWith("/resources/move") ||
					!path.includes(".lock.")
				) {
					return;
				}
				injected = true;
				const canonical = await a.canonical();
				canonical.revision++;
				canonical.files[copy] = {
					path: copy,
					sha256: "tombstone",
					size: 0,
					mtime: 1,
					syncedAt: 1,
					deleted: true,
					deletedAt: 1,
					changedRevision: canonical.revision,
					baseRevision: canonical.revision - 1,
					lastModifiedBy: "c",
					mutationSeq: 1,
				};
				canonical.appliedMutationSeq.c = 1;
				const content = bytes(JSON.stringify(canonical));
				disk.files.set(
					"vault/.obsidian-sync-index.json",
					codec ? await codec.encrypt(content) : content,
				);
			};
			const result = await b.engine.fullSync();
			assert.equal(injected, true);
			assert.equal(result.success, false);
			assert.deepEqual(b.vault.files.get("note.md"), bytes("local edit"));
			disk.beforeRequest = undefined;
			await b.full();
			const copies = [...b.vault.files.keys()].filter((name) =>
				name.startsWith("note_conflict_"),
			);
			assert.equal(copies.length, 1);
			await b.assertSettled({
				"note.md": "remote edit",
				[copies[0]!]: "local edit",
			});
		} finally {
			disk.beforeRequest = undefined;
			await a.stop();
			await b.stop();
		}
	});

	test(`${mode} first-sync copy keeps its pending identity across restart`, async () => {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		const b = device(disk, "b", codec);
		let restarted: ReturnType<typeof device> | undefined;
		try {
			a.vault.put("note.md", bytes("remote edit"));
			await a.full();
			b.vault.put("note.md", bytes("local edit"));
			disk.beforeRequest = async (_method, endpoint, path) => {
				if (
					endpoint.endsWith("/resources/move") &&
					path.includes(".lock.") &&
					[...b.vault.files.keys()].some((name) =>
						name.includes("_conflict_"),
					)
				) {
					throw new Error("synthetic interrupted copy commit");
				}
			};
			assert.equal((await b.engine.fullSync()).success, false);
			const saved = await b.saved();
			assert.equal(saved.pendingMutations.length, 1);
			const copy = saved.pendingMutations[0]!.path;
			await b.stop();
			disk.beforeRequest = undefined;
			restarted = device(disk, "b", codec, b.vault, saved);
			assert.deepEqual(
				restarted.index.getPendingMutations(),
				saved.pendingMutations,
			);
			await restarted.full();
			await restarted.assertSettled({
				"note.md": "remote edit",
				[copy]: "local edit",
			});
		} finally {
			disk.beforeRequest = undefined;
			await a.stop();
			await b.stop();
			await restarted?.stop();
		}
	});

	test(`${mode} corrective upload stops when a newer winner arrives after copy commit`, async () => {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "a", codec);
		let injected = false;
		try {
			a.vault.put("note.md", bytes("accepted"));
			await a.full();
			await a.client.uploadFile(
				"vault/note.md",
				bytes("external version"),
			);
			const original = await a.client.getPhysicalPath("vault/note.md");
			disk.beforeRequest = async (_method, endpoint, path) => {
				if (
					injected ||
					!endpoint.endsWith("/resources/upload") ||
					path !== original ||
					![...a.vault.files.keys()].some((name) =>
						name.includes("_conflict_"),
					)
				) {
					return;
				}
				injected = true;
				const canonical: SyncIndex = await a.canonical();
				canonical.revision++;
				const content = bytes("new winner");
				await a.client.uploadFile("vault/note.md", content);
				const physical =
					await a.client.getLogicalResource("vault/note.md");
				canonical.files["note.md"] = {
					...canonical.files["note.md"]!,
					sha256: await computeSha256(content),
					remoteFingerprint: physical!.sha256,
					changedRevision: canonical.revision,
					lastModifiedBy: "c",
					mutationSeq: 1,
				};
				canonical.appliedMutationSeq.c = 1;
				const indexContent = bytes(JSON.stringify(canonical));
				disk.files.set(
					"vault/.obsidian-sync-index.json",
					codec ? await codec.encrypt(indexContent) : indexContent,
				);
			};
			const access = a.engine as unknown as {
				syncReconciliationDependencies(): Dependencies;
			};
			await assert.rejects(
				repairMissingAcceptedUploads(
					access.syncReconciliationDependencies(),
					["note.md"],
				),
			);
			assert.equal(injected, true);
			assert.deepEqual(
				await a.client.downloadFile("vault/note.md"),
				bytes("new winner"),
			);
			const copy = [...a.vault.files.keys()].find((name) =>
				name.includes("_conflict_"),
			)!;
			assert.deepEqual(
				await a.client.downloadFile(`vault/${copy}`),
				bytes("external version"),
			);
		} finally {
			disk.beforeRequest = undefined;
			await a.stop();
		}
	});
}
