import assert from "node:assert/strict";
import test from "node:test";
import { RemoteIndexTransactionError } from "../src/sync/canonical/manager";
import type { DurableRenameEvent } from "../src/sync/realtime/rules";
import {
	bytes,
	codecFor,
	device,
	managedDevices,
	MemoryDisk,
	type SavedDevice,
} from "./helpers/sync-flow";

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";
	test(`${mode} independent file and folder renames share two canonical commits`, async () => {
		const { disk, a, b, drain } = await queuedRenames(encrypted, true);
		try {
			const before = await a.canonical();
			assert.equal(
				before.files["Folder/D.md"]?.lastModifiedBy,
				"device-b",
			);
			let transactions = 0;
			disk.beforeRequest = async (method, endpoint, path) => {
				if (
					method === "POST" &&
					endpoint.endsWith("/resources/move") &&
					path.includes(".lock.")
				) {
					transactions++;
				}
			};
			let publications = 0;
			let lostMoveReply = false;
			const physicalTarget = await a.client.getPhysicalPath(
				"vault/Destination/A.md",
			);
			disk.afterRequest = async (_method, endpoint, path) => {
				if (
					endpoint.endsWith("/resources/move") &&
					path === "vault/.obsidian-sync-index.json" &&
					publications < 2
				) {
					publications++;
					throw new Error(
						"Synthetic successful canonical move with lost response",
					);
				}
				if (
					!lostMoveReply &&
					endpoint.endsWith("/resources/move") &&
					path === physicalTarget
				) {
					lostMoveReply = true;
					throw new Error(
						"Synthetic successful file move with lost response",
					);
				}
			};
			await drain();
			assert.equal(transactions, 2);
			assert.equal(publications, 2);
			assert.equal(lostMoveReply, true);
			const after = await a.canonical();
			const sequence = after.appliedMutationSeq["device-a"]!;
			assert.ok(sequence > before.appliedMutationSeq["device-b"]!);
			assert.equal(
				after.appliedMutationSeq["device-b"],
				before.appliedMutationSeq["device-b"],
			);
			for (const path of [
				"Destination/Folder/Deep/C.md",
				"Destination/Folder/D.md",
			]) {
				for (const entry of [
					after.files[path],
					a.index.getLocalIndex().files[path],
				]) {
					assert.equal(entry?.lastModifiedBy, "device-a");
					assert.equal(entry.mutationSeq, sequence);
					assert.equal(entry.baseRevision, before.revision);
				}
			}
			disk.afterRequest = undefined;
			disk.beforeRequest = undefined;
			await a.full();
			await b.full();
			const expected = {
				"Destination/A.md": "alpha",
				"Destination/B.md": "beta",
				"Destination/Folder/Deep/C.md": "charlie",
				"Destination/Folder/D.md": "delta",
			};
			await a.assertSettled(expected);
			await b.assertSettled(expected);
		} finally {
			disk.afterRequest = undefined;
			disk.beforeRequest = undefined;
			await a.stop();
			await b.stop();
		}
	});
}

const finalFiles = {
	"Destination/A.md": "alpha",
	"Destination/B.md": "beta",
	"Destination/Folder/Deep/C.md": "charlie",
	"Destination/Folder/D.md": "delta",
};

/** Collect a mixed rename burst without replacing any sync algorithms. */
async function queuedRenames(encrypted: boolean, foreignFolder = false) {
	const disk = new MemoryDisk();
	const codec = await codecFor(encrypted);
	const a = device(disk, "device-a", codec);
	const b = device(disk, "device-b", codec);
	a.vault.put("A.md", bytes("alpha"));
	a.vault.put("B.md", bytes("beta"));
	const folderOwner = foreignFolder ? b : a;
	folderOwner.vault.put("Folder/Deep/C.md", bytes("charlie"));
	folderOwner.vault.put("Folder/D.md", bytes("delta"));
	if (foreignFolder) {
		await b.full();
	}
	await a.full();
	await b.full();
	a.vault.folder("Destination");
	a.start();
	a.watcher.pauseForSync({
		sessionId: "collect-renames",
		kind: "maintenance",
	});
	a.vault.rename("A.md", "Destination/A.md");
	a.vault.rename("B.md", "Destination/B.md");
	a.vault.rename("Folder", "Destination/Folder");
	return {
		disk,
		codec,
		a,
		b,
		drain: async () => {
			await a.watcher.resumeAfterSync({
				sessionId: "collect-renames",
				kind: "maintenance",
				success: true,
			});
			await a.drain();
		},
	};
}

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";
	test(`${mode} rename batch retains failed work and original identities across restart`, async () => {
		for (const failure of ["intent", "physical", "completion"] as const) {
			const { disk, codec, a, b, drain } = await queuedRenames(encrypted);
			let restarted: ReturnType<typeof device> | undefined;
			try {
				const target = await a.client.getPhysicalPath(
					"vault/Destination/Folder/D.md",
				);
				let indexWrites = 0;
				disk.beforeRequest = async (method, endpoint, path) => {
					if (
						method === "PUT" &&
						endpoint === "/upload" &&
						path.includes(".lock.")
					) {
						indexWrites++;
						if (
							failure === "intent" ||
							(failure === "completion" && indexWrites > 1)
						) {
							throw new Error(`Synthetic ${failure} failure`);
						}
					}
					if (
						failure === "physical" &&
						method === "POST" &&
						endpoint.endsWith("/resources/move") &&
						path === target
					) {
						throw new Error("Synthetic child move failure");
					}
				};
				await drain();
				const saved = a.lastSaved();
				assert.ok(saved.pendingWatcherEvents.length > 0, failure);
				const identities = saved.pendingMutations.map(
					(item) => item.id,
				);
				assert.ok(identities.length > 0, failure);
				const sequence = saved.localState.nextMutationSeq;
				await a.stop();
				disk.beforeRequest = undefined;
				restarted = device(disk, "device-a", codec, a.vault, saved);
				restarted.start();
				await restarted.drain();
				await restarted.full();
				await b.full();
				await restarted.assertSettled(finalFiles);
				await b.assertSettled(finalFiles);
				assert.equal(
					restarted.index.getLocalIndexData().nextMutationSeq,
					sequence,
					failure,
				);
			} finally {
				disk.beforeRequest = undefined;
				await a.stop();
				await restarted?.stop();
				await b.stop();
			}
		}
	});
	test(`${mode} foreign deletion during a rename batch cannot resurrect the target`, async () => {
		const { disk, a, b, drain } = await queuedRenames(encrypted);
		let deleted = false;
		try {
			disk.afterRequest = async (_method, endpoint, path) => {
				if (
					!deleted &&
					endpoint.endsWith("/resources/move") &&
					path === "vault/.obsidian-sync-index.json"
				) {
					deleted = true;
					const canonical =
						await b.index.refreshCanonicalForMutation();
					const mutation = b.index.enqueueMutation(
						"delete-file",
						"Destination/B.md",
						{
							epoch: canonical.epoch,
							baseRevision: canonical.revision,
						},
					);
					b.index.markRemoteFileDeleted(
						"Destination/B.md",
						undefined,
						canonical.revision,
						mutation.seq,
					);
					b.index.stageMutation(mutation);
					await b.index.saveRemoteIndex();
				}
			};
			await drain();
			assert.equal(deleted, true);
			assert.equal(
				(await a.canonical()).files["Destination/B.md"]?.deleted,
				true,
			);
			assert.equal(
				await a.client.getLogicalResource("vault/Destination/B.md"),
				null,
			);
			disk.afterRequest = undefined;
			await a.full();
			await b.full();
			const expected = {
				"Destination/A.md": "alpha",
				"Destination/Folder/Deep/C.md": "charlie",
				"Destination/Folder/D.md": "delta",
			};
			await a.assertSettled(expected);
			await b.assertSettled(expected);
		} finally {
			disk.afterRequest = undefined;
			await a.stop();
			await b.stop();
		}
	});
	test(`${mode} a source restored after batch intent remains physically live`, async () => {
		const { disk, a, b, drain } = await queuedRenames(encrypted);
		let restored = false;
		try {
			disk.afterRequest = async (_method, endpoint, path) => {
				if (
					!restored &&
					endpoint.endsWith("/resources/move") &&
					path === "vault/.obsidian-sync-index.json"
				) {
					restored = true;
					const canonical =
						await b.index.refreshCanonicalForMutation();
					const source = canonical.files["A.md"]!;
					const mutation = b.index.enqueueMutation("put", "A.md", {
						epoch: canonical.epoch,
						baseRevision: canonical.revision,
						sha256: source.sha256,
					});
					b.index.updateRemoteFile("A.md", {
						...source,
						deleted: false,
						deletedAt: undefined,
						deletedByFolder: undefined,
						lastModifiedBy: b.settings.deviceId,
						baseRevision: canonical.revision,
						mutationSeq: mutation.seq,
					});
					b.index.stageMutation(mutation);
					await b.index.saveRemoteIndex();
				}
			};
			await drain();
			assert.equal(restored, true);
			assert.equal((await a.canonical()).files["A.md"]?.deleted, false);
			assert.ok(
				await a.client.getLogicalResource("vault/A.md"),
				"Restored source must survive physical move",
			);
			disk.afterRequest = undefined;
			await a.full();
			await b.full();
			const expected = { ...finalFiles, "A.md": "alpha" };
			await a.assertSettled(expected);
			await b.assertSettled(expected);
		} finally {
			disk.afterRequest = undefined;
			await a.stop();
			await b.stop();
		}
	});
	test(`${mode} changed rename content uses the existing path without extra mutation sequences`, async () => {
		const { a, b, drain } = await queuedRenames(encrypted);
		try {
			const sequence = a.index.getLocalIndexData().nextMutationSeq;
			a.vault.put("Destination/B.md", bytes("edited beta"), false);
			await drain();
			assert.equal(
				a.index.getLocalIndexData().nextMutationSeq,
				sequence + 3,
			);
			await a.full();
			await b.full();
			await a.assertSettled({
				...finalFiles,
				"Destination/B.md": "edited beta",
			});
			await b.assertSettled({
				...finalFiles,
				"Destination/B.md": "edited beta",
			});
		} finally {
			await a.stop();
			await b.stop();
		}
	});
}

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";
	test(`${mode} full waits for the rename batch and retains edits made while it runs`, async () => {
		const { disk, codec, a, b, drain } = await queuedRenames(encrypted);
		let restarted: ReturnType<typeof device> | undefined;
		let entered!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const target = await a.client.getPhysicalPath(
				"vault/Destination/A.md",
			);
			disk.beforeRequest = async (method, endpoint, path) => {
				if (
					method === "POST" &&
					endpoint.endsWith("/resources/move") &&
					path === target
				) {
					disk.beforeRequest = undefined;
					entered();
					await blocked;
				}
			};
			const renames = a.watcher.getDeferredEvents().map(({ id }) => id);
			assert.equal(renames.length, 3);
			let lateId: string | undefined;
			const scan = a.index.buildLocalIndex.bind(a.index);
			a.index.buildLocalIndex = async (...args) => {
				const local = await scan(...args);
				assert.equal(
					a
						.lastSaved()
						.pendingWatcherEvents.some(({ id }) =>
							renames.includes(id),
						),
					false,
				);
				const canonical = await a.canonical();
				assert.deepEqual(canonical.moves, {});
				assert.equal(canonical.files["A.md"]?.deleted, true);
				assert.ok(canonical.files["Destination/A.md"]?.sha256);
				a.vault.put("Late.md", bytes("after the full scan"));
				lateId = a.watcher
					.getDeferredEvents()
					.find(({ path }) => path === "Late.md")?.id;
				assert.ok(lateId);
				return local;
			};
			const running = drain();
			await started;
			a.vault.put("Destination/B.md", bytes("edit during batch"));
			a.watcher.setAutomaticAdmission(() => false);
			const full = a.full();
			release();
			await running;
			await full;
			const saved = a.crash();
			assert.ok(lateId);
			assert.deepEqual(
				saved.pendingWatcherEvents.map(({ id }) => id),
				[lateId],
			);
			assert.equal((await a.canonical()).files["Late.md"], undefined);
			assert.equal(
				await a.client.getLogicalResource("vault/Late.md"),
				null,
			);
			restarted = device(disk, "device-a", codec, a.vault, saved);
			assert.deepEqual(
				restarted.watcher.getDeferredEvents().map(({ id }) => id),
				[lateId],
			);
			await restarted.index.loadRemoteIndex();
			restarted.start();
			await restarted.drain();
			await b.full();
			const expected = {
				...finalFiles,
				"Destination/B.md": "edit during batch",
				"Late.md": "after the full scan",
			};
			await restarted.assertSettled(expected);
			await b.assertSettled(expected);
		} finally {
			release();
			disk.beforeRequest = undefined;
			await a.stop();
			await b.stop();
			await restarted?.stop();
		}
	});
	test(`${mode} failed post-commit persistence cannot acknowledge rename events`, async () => {
		const { disk, a, b, drain } = await queuedRenames(encrypted);
		const originalPersist = a.engine["indexSaveCallback"]!;
		let reject = false;
		let publications = 0;
		try {
			const ids = a.watcher.getDeferredEvents().map((event) => event.id);
			a.engine.setIndexSaveCallback(async (observation) => {
				if (reject) {
					throw new Error(
						"Synthetic post-commit persistence failure",
					);
				}
				await originalPersist(observation);
			});
			disk.afterRequest = async (_method, endpoint, path) => {
				if (
					endpoint.endsWith("/resources/move") &&
					path === "vault/.obsidian-sync-index.json"
				) {
					publications++;
					if (publications === 2) {
						reject = true;
					}
				}
			};
			await drain();
			assert.equal(publications, 2);
			assert.deepEqual(
				a.watcher.getDeferredEvents().map((event) => event.id),
				ids,
			);
			assert.deepEqual((await a.canonical()).moves, {});
			const nextSequence = a.index.getLocalIndexData().nextMutationSeq;
			reject = false;
			disk.afterRequest = undefined;
			a.engine.setIndexSaveCallback(originalPersist);
			await a.full();
			await b.full();
			await a.assertSettled(finalFiles);
			await b.assertSettled(finalFiles);
			assert.equal(
				a.index.getLocalIndexData().nextMutationSeq,
				nextSequence,
			);
		} finally {
			reject = false;
			a.engine.setIndexSaveCallback(originalPersist);
			disk.afterRequest = undefined;
			await a.stop();
			await b.stop();
		}
	});
}

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";
	test(`${mode} committed intent with incomplete cleanup retains its receipts without starting transfers`, async () => {
		const { a, b, drain } = await queuedRenames(encrypted);
		const save = a.index.saveRemoteIndex.bind(a.index);
		try {
			a.index.saveRemoteIndex = async () => {
				await save();
				throw new RemoteIndexTransactionError(
					"Synthetic incomplete committed cleanup",
					"RemoteIndexCleanupError",
					"committed",
					"committed",
					false,
				);
			};
			const events = (
				a.watcher as unknown as { deferredEvents: DurableRenameEvent[] }
			).deferredEvents;
			const result = await a.engine.renameBatch(events, async () => {});
			assert.equal(
				result?.filter((item) => item.outcome.status === "retry")
					.length,
				3,
			);
			const canonical = await a.canonical();
			assert.equal(Object.keys(canonical.moves).length, 3);
			assert.equal(
				a.watcher
					.getDeferredEvents()
					.filter((event) => event.action === "rename").length,
				3,
			);
			assert.equal(
				new TextDecoder().decode(
					await a.client.downloadFile("vault/A.md"),
				),
				"alpha",
			);
			assert.equal(
				await a.client.getLogicalResource("vault/Destination/A.md"),
				null,
			);
			const sequence = a.index.getLocalIndexData().nextMutationSeq;
			a.index.saveRemoteIndex = save;
			await drain();
			await a.full();
			await b.full();
			await a.assertSettled(finalFiles);
			await b.assertSettled(finalFiles);
			assert.equal(a.index.getLocalIndexData().nextMutationSeq, sequence);
		} finally {
			a.index.saveRemoteIndex = save;
			await a.stop();
			await b.stop();
		}
	});
	test(`${mode} encryption guard changes stop physical batch writes and preserve recovery`, async () => {
		const { disk, a, b, drain } = await queuedRenames(encrypted);
		let blocked = false;
		try {
			disk.afterRequest = async (_method, endpoint, path) => {
				if (
					!blocked &&
					endpoint.endsWith("/resources/move") &&
					path === "vault/.obsidian-sync-index.json"
				) {
					blocked = true;
					a.engine.setExternalBlockReason(
						"Synthetic changed encryption authority",
					);
				}
			};
			await drain();
			assert.equal(blocked, true);
			assert.equal(
				await a.client.getLogicalResource("vault/Destination/A.md"),
				null,
			);
			assert.equal(
				new TextDecoder().decode(
					await a.client.downloadFile("vault/A.md"),
				),
				"alpha",
			);
			assert.equal(Object.keys((await a.canonical()).moves).length, 3);
			const sequence = a.index.getLocalIndexData().nextMutationSeq;
			disk.afterRequest = undefined;
			a.engine.setExternalBlockReason(null);
			await a.full();
			await b.full();
			await a.assertSettled(finalFiles);
			await b.assertSettled(finalFiles);
			assert.equal(a.index.getLocalIndexData().nextMutationSeq, sequence);
		} finally {
			disk.afterRequest = undefined;
			a.engine.setExternalBlockReason(null);
			await a.stop();
			await b.stop();
		}
	});
}

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";
	test(`${mode} offline source edits survive a completed rename batch`, async () => {
		const { a, b, drain } = await queuedRenames(encrypted);
		try {
			b.vault.put("A.md", bytes("offline source edit"));
			await drain();
			await b.full();
			await a.full();
			await a.assertSettled(finalFiles);
			await b.assertSettled(finalFiles);
			assert.ok(
				[...b.vault.files.values()].some(
					(content) =>
						new TextDecoder().decode(content) ===
						"offline source edit",
				),
			);
		} finally {
			await a.stop();
			await b.stop();
		}
	});
	test(`${mode} a foreign epoch before physical reads cannot execute old batch intents`, async () => {
		const { disk, a, b, drain } = await queuedRenames(encrypted);
		const oldEpoch = a.index.getObservedEpoch();
		let replaced = false;
		let replacement: Promise<void> | null = null;
		const initialRevision = a.index.getRemoteIndex().revision;
		try {
			// All physical tasks pass this guard before their fresh authority read.
			a.engine.setSyncGuardCallback(async () => {
				if (
					!replaced &&
					a.index.getRemoteIndex().revision > initialRevision
				) {
					replaced = true;
					replacement = (async () => {
						const files = structuredClone(
							b.index.getLocalIndex().files,
						);
						b.index.beginForceBootstrap(true);
						for (const [name, metadata] of Object.entries(files)) {
							b.index.updateRemoteFile(name, metadata);
						}
						await b.index.saveRemoteIndex();
					})();
				}
				await replacement;
				return {
					blockReason: null,
					validationToken: "synthetic-stable-codec",
				};
			});
			await drain();
			assert.equal(replaced, true);
			assert.notEqual((await a.canonical()).epoch, oldEpoch);
			assert.equal(
				await a.client.getLogicalResource("vault/Destination/A.md"),
				null,
			);
			assert.equal(
				new TextDecoder().decode(
					await a.client.downloadFile("vault/A.md"),
				),
				"alpha",
			);
			assert.ok(a.watcher.getDeferredEvents().length > 0);
			disk.beforeRequest = undefined;
			disk.afterRequest = undefined;
			const gated = await a.engine.fullSync();
			assert.equal(gated.errors[0]?.code, "epoch-decision-required");
			const adopted = await a.engine.fullSync({
				epochAdoption: {
					epoch: (await b.canonical()).epoch,
					decision: "preserve",
				},
			});
			assert.equal(adopted.success, true, JSON.stringify(adopted.errors));
			assert.equal(
				a.index.getObservedEpoch(),
				(await b.canonical()).epoch,
			);
			for (const value of ["alpha", "beta", "charlie", "delta"]) {
				assert.ok(
					[...a.vault.files.values()].some(
						(content) =>
							new TextDecoder().decode(content) === value,
					),
				);
			}
		} finally {
			disk.beforeRequest = undefined;
			disk.afterRequest = undefined;
			await a.stop();
			await b.stop();
		}
	});
}

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";
	test(`${mode} a foreign folder child coalesces with an equal target and resumes its original move`, async (t) => {
		const open = managedDevices(t);
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const writer = open(disk, "writer", codec);
		const mover = open(disk, "mover", codec);
		const source = "Old/note.md";
		const target = "New/note.md";
		writer.vault.put(source, bytes("shared"));
		await writer.full();
		await mover.full();
		const base = await mover.canonical();
		mover.start();
		const pause = {
			sessionId: "offline-move",
			kind: "maintenance",
		} as const;
		mover.watcher.pauseForSync(pause);
		mover.vault.rename("Old", "New");
		const [event] = mover.watcher.getDeferredEvents();
		assert.ok(event);
		writer.vault.put(target, bytes("shared"));
		writer.vault.put("Old/later.md", bytes("later"));
		await writer.full();
		const before = await writer.canonical();
		if (encrypted) {
			assert.notEqual(
				before.files[source]?.remoteFingerprint,
				before.files[target]?.remoteFingerprint,
			);
		}

		const physicalSource = await mover.client.getPhysicalPath(
			`vault/${source}`,
		);
		disk.beforeRequest = async (method, _endpoint, path) => {
			if (method === "DELETE" && path === physicalSource) {
				throw new Error("Synthetic interruption during source cleanup");
			}
		};
		await mover.watcher.resumeAfterSync({ ...pause, success: true });
		await mover.drain();
		const saved = mover.crash();
		const intent = await writer.canonical();
		const [move] = Object.values(intent.moves);
		assert.ok(move?.pending);
		assert.ok(
			move.mutationSeq &&
				move.mutationSeq < before.appliedMutationSeq.writer!,
		);
		assert.equal(
			intent.appliedMutationSeq.writer,
			before.appliedMutationSeq.writer,
		);
		assert.equal(intent.appliedMutationSeq.mover, move.mutationSeq);
		assert.equal(move.baseRevision, base.revision);
		assert.equal(move.lastModifiedBy, "mover");
		for (const entry of [
			intent.files[source],
			intent.files[target],
			saved.localState.files[target],
		]) {
			assert.equal(entry?.lastModifiedBy, "mover");
			assert.equal(entry.mutationSeq, move.mutationSeq);
			assert.equal(entry.baseRevision, base.revision);
		}
		assert.equal(intent.files[source]?.deleted, true);
		assert.equal(
			intent.files[target]?.sha256,
			before.files[source]?.sha256,
		);
		assert.equal(intent.files["Old/later.md"]?.lastModifiedBy, "writer");
		assert.equal(
			intent.files["Old/later.md"]?.mutationSeq,
			before.files["Old/later.md"]?.mutationSeq,
		);
		assert.deepEqual(
			saved.pendingWatcherEvents.map(
				({ id, mutationId, mutationSeq }) => [
					id,
					mutationId,
					mutationSeq,
				],
			),
			[[event.id, move.id, move.mutationSeq]],
		);
		const [action] = saved.pendingPhysicalActions;
		assert.equal(action?.parentMutationId, move.id);
		assert.equal(action.path, source);
		assert.equal(action.targetPath, target);
		assert.equal(
			action.expectedFingerprint,
			before.files[source]?.remoteFingerprint,
		);
		assert.ok(await mover.client.getLogicalResource(`vault/${source}`));

		disk.beforeRequest = undefined;
		let awaitingAck: SavedDevice | undefined;
		const restarted = open(
			disk,
			"mover",
			codec,
			mover.vault,
			saved,
			{},
			(snapshot) => {
				if (
					!snapshot.pendingMutations.length &&
					snapshot.pendingWatcherEvents.some(
						({ id }) => id === event.id,
					)
				) {
					awaitingAck = snapshot;
				}
			},
		);
		await restarted.index.loadRemoteIndex();
		restarted.start();
		await restarted.drain();
		const completed = await restarted.canonical();
		assert.deepEqual(completed.moves, {});
		assert.equal(
			completed.files[target]?.remoteFingerprint,
			before.files[target]?.remoteFingerprint,
		);
		assert.equal(completed.files[target]?.lastModifiedBy, "mover");
		assert.equal(completed.files[target]?.mutationSeq, move.mutationSeq);
		assert.deepEqual(
			await restarted.client.downloadFile("vault/Old/later.md"),
			bytes("later"),
		);
		assert.equal(
			await restarted.client.getLogicalResource(`vault/${source}`),
			null,
		);
		assert.equal(
			restarted.index.getLocalIndexData().nextMutationSeq,
			saved.localState.nextMutationSeq,
		);
		assert.ok(awaitingAck);
		const unrelated = await writer.engine.renameFolder("Old", "New", {
			epoch: intent.epoch,
			baseRevision: base.revision,
			mutationId: move.id,
			mutationSeq: move.mutationSeq,
		});
		assert.equal(unrelated.status, "retry");
		assert.equal((await writer.canonical()).revision, completed.revision);
		restarted.crash();
		await writer.full();
		writer.start();
		writer.vault.remove("Old");
		await writer.drain();
		writer.vault.put(source, bytes("recreated"));
		await writer.drain();
		const replacement = await writer.canonical();
		assert.equal(
			replacement.folderTombstones.Old?.lastModifiedBy,
			"writer",
		);
		assert.equal(replacement.files[source]?.deleted ?? false, false);
		const replay = open(disk, "mover", codec, mover.vault, awaitingAck);
		await replay.index.loadRemoteIndex();
		replay.vault.put("Queued.md", bytes("next"), false);
		const laterPut = replay.index.enqueueMutation("put", "Queued.md", {
			epoch: replacement.epoch,
			baseRevision: base.revision,
		});
		const nextSeq = replay.index.getLocalIndexData().nextMutationSeq;
		replay.start();
		await replay.drain();
		assert.equal((await replay.canonical()).revision, replacement.revision);
		assert.equal(replay.index.getLocalIndexData().nextMutationSeq, nextSeq);
		assert.deepEqual(replay.lastSaved().pendingWatcherEvents, []);
		assert.deepEqual(replay.index.getPendingMutations(), [laterPut]);
		assert.equal(
			await replay.client.getLogicalResource("vault/Queued.md"),
			null,
		);
		await replay.full();
		await writer.full();
		const expected = {
			[target]: "shared",
			[source]: "recreated",
			"Queued.md": "next",
		};
		await replay.assertSettled(expected);
		await writer.assertSettled(expected);
	});
}
