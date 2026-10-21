import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import type { VaultAdapter } from "../src/api/vault-adapter";
import type { YandexDiskClient } from "../src/api/yandex-client";
import type { IndexManager } from "../src/sync/canonical/manager";
import { SyncEngine } from "../src/sync/engine";
import type { RealtimeFileEvent } from "../src/sync/realtime/rules";
import { FileWatcher } from "../src/sync/realtime/watcher";
import * as syncReconciliation from "../src/sync/reconciliation/commits";
import { ConflictResolver } from "../src/sync/reconciliation/conflicts";
import * as fullSync from "../src/sync/workflows/full";
import { DEFAULT_SETTINGS, type FileMetadata } from "../src/types";
import { computeSha256 } from "../src/utils/hash-utils";
import {
	fileEvent,
	fileMetadata,
	MemoryIndex,
	reconciliationDependencies,
	renameEvent,
	syncResult,
	watcherAccess,
} from "./helpers/realtime-fixtures";

class RenameVaultFake {
	readonly files = new Map<string, ArrayBuffer>();

	shouldSync() {
		return true;
	}

	fileExists(path: string) {
		return this.files.has(path);
	}

	async readFile(path: string) {
		const content = this.files.get(path);
		if (!content) {
			throw new Error(`Missing local file: ${path}`);
		}
		return content.slice(0);
	}

	getFileMtime() {
		return 1;
	}
}

class RenameYandexFake {
	readonly resources = new Map<
		string,
		{ content: ArrayBuffer; sha256: string; modified: string }
	>();
	readonly uploads: string[] = [];
	readonly moves: Array<{ from: string; to: string }> = [];
	moveThrowsAfterSuccess = false;
	afterUpload?: () => void;

	async uploadFile(path: string, content: ArrayBuffer) {
		const copy = content.slice(0);
		this.resources.set(path, {
			content: copy,
			sha256: await computeSha256(copy),
			modified: "2026-07-30T00:00:00.000Z",
		});
		this.uploads.push(path);
		this.afterUpload?.();
	}

	async uploadFileExclusive(path: string, content: ArrayBuffer) {
		if (this.resources.has(path)) {
			throw new Error(`Remote upload target exists: ${path}`);
		}
		await this.uploadFile(path, content);
	}

	async downloadFile(path: string) {
		const resource = this.resources.get(path);
		if (!resource) {
			throw new Error(`Missing remote file: ${path}`);
		}
		return resource.content.slice(0);
	}

	async getLogicalResource(path: string) {
		const resource = this.resources.get(path);
		if (!resource) {
			return null;
		}
		return {
			name: path.split("/").pop() ?? path,
			path,
			type: "file" as const,
			size: resource.content.byteLength,
			modified: resource.modified,
			sha256: resource.sha256,
		};
	}

	async moveResource(from: string, to: string) {
		const source = this.resources.get(from);
		if (!source) {
			throw new Error(`Missing remote move source: ${from}`);
		}
		if (this.resources.has(to)) {
			throw new Error(`Remote move target exists: ${to}`);
		}
		this.resources.set(to, source);
		this.resources.delete(from);
		this.moves.push({ from, to });
		if (this.moveThrowsAfterSuccess) {
			throw new Error("Move response lost");
		}
	}

	async deleteResource(
		path: string,
		_permanently = false,
		_raw = false,
		beforeAttempt?: () => Promise<void>,
	) {
		await beforeAttempt?.();
		this.resources.delete(path);
	}

	async isFolderEmpty(path: string) {
		const prefix = `${path.replace(/\/+$/, "")}/`;
		return !Array.from(this.resources.keys()).some((item) =>
			item.startsWith(prefix),
		);
	}
}

class RenameIndexFake extends MemoryIndex {
	constructor(private readonly yandex: RenameYandexFake) {
		super();
	}
	remoteFileScans = 0;
	async getRemoteFiles() {
		this.remoteFileScans++;
		const result = new Map<string, FileMetadata>();
		for (const [path, resource] of this.yandex.resources) {
			const logicalPath = path.replace(/^remote\//, "");
			result.set(
				logicalPath,
				fileMetadata(logicalPath, resource.sha256, {
					size: resource.content.byteLength,
					remoteMtime: new Date(resource.modified).getTime(),
					remoteFingerprint: resource.sha256,
				}),
			);
		}
		return result;
	}
}

/** Wire the real engine to independent in-memory resources for each scenario. */
function createRenameEngine(
	yandex: RenameYandexFake,
	vault: RenameVaultFake,
	index: RenameIndexFake,
	encrypted = false,
): SyncEngine {
	return new SyncEngine(
		yandex as unknown as YandexDiskClient,
		vault as unknown as VaultAdapter,
		index as unknown as IndexManager,
		{
			...DEFAULT_SETTINGS,
			deviceId: "device-a",
			remotePath: "remote",
			enableEncryption: encrypted,
		},
	);
}

function createHarness(encrypted = false) {
	const yandex = new RenameYandexFake();
	const vault = new RenameVaultFake();
	const index = new RenameIndexFake(yandex);
	const engine = createRenameEngine(yandex, vault, index, encrypted);
	return { yandex, vault, index, engine };
}

function setBaseline(
	index: RenameIndexFake,
	sha256: string,
	size: number,
	changedRevision = 7,
) {
	const baseline = fileMetadata("A.md", sha256, {
		size,
		remoteFingerprint: sha256,
		changedRevision,
		lastModifiedBy: "device-a",
	});
	index.index.files["A.md"] = { ...baseline };
	index.local.files["A.md"] = { ...baseline };
}

function setMovedCanonical(
	index: RenameIndexFake,
	targetPath: string,
	sha256: string,
	size: number,
	observed = false,
) {
	const target = fileMetadata(targetPath, sha256, {
		size,
		changedRevision: 8,
		lastModifiedBy: "device-a",
		...(observed ? { remoteFingerprint: sha256 } : {}),
	});
	index.index.files["A.md"] = fileMetadata("A.md", sha256, {
		size,
		changedRevision: 8,
		lastModifiedBy: "device-a",
		deleted: true,
	});
	index.index.files[targetPath] = target;
}

test("foreign delete after commit cancels proof-based physical repair", async () => {
	const { yandex, vault, index, engine } = createHarness();

	const fileContent = content("accepted");
	const sha256 = await computeSha256(fileContent);
	vault.files.set("note.md", fileContent);

	index.index.files["note.md"] = fileMetadata("note.md", sha256, {
		size: fileContent.byteLength,
		changedRevision: 8,
		lastModifiedBy: "device-a",
		mutationSeq: 1,
	});
	index.index.revision = 8;
	const proof = {
		epoch: index.index.epoch,
		revision: index.index.revision,
		index: structuredClone(index.index),
		contentFingerprint: "md5:accepted",
	};
	index.beforeRepairAuthorization = () => {
		index.index.revision = 9;
		index.index.files["note.md"] = {
			...index.index.files["note.md"]!,
			deleted: true,
			changedRevision: 9,
			lastModifiedBy: "device-b",
			mutationSeq: 1,
		};
	};

	await syncReconciliation.repairMissingAcceptedUploads(
		reconciliationDependencies(engine),
		[{ path: "note.md", snapshot: { content: fileContent, sha256 } }],
		proof,
	);

	assert.deepEqual(yandex.uploads, []);
	assert.equal(yandex.resources.has("remote/note.md"), false);
});

test("encryption change blocks proof-based physical repair", async () => {
	const { yandex, vault, index, engine } = createHarness();

	const fileContent = content("accepted");
	const sha256 = await computeSha256(fileContent);
	vault.files.set("note.md", fileContent);

	index.index.files["note.md"] = fileMetadata("note.md", sha256, {
		size: fileContent.byteLength,
		changedRevision: 8,
		lastModifiedBy: "device-a",
		mutationSeq: 1,
	});
	index.index.revision = 8;
	const proof = {
		epoch: index.index.epoch,
		revision: index.index.revision,
		index: structuredClone(index.index),
		contentFingerprint: "md5:accepted",
	};

	engine.setSyncGuardCallback(async (token) => ({
		blockReason: token === "old-manifest" ? "manifest changed" : null,
	}));

	await assert.rejects(
		syncReconciliation.repairMissingAcceptedUploads(
			reconciliationDependencies(engine),
			[{ path: "note.md", snapshot: { content: fileContent, sha256 } }],
			proof,
			"old-manifest",
		),
		/encryption state changed/i,
	);
	assert.deepEqual(yandex.uploads, []);
});

function content(value: string): ArrayBuffer {
	return new TextEncoder().encode(value).buffer;
}

for (const mode of ["plaintext", "encrypted"] as const) {
	test(`${mode} unsynced rename retargets the pending put`, async () => {
		const { yandex, vault, index, engine } = createHarness(
			mode === "encrypted",
		);

		vault.files.set("deep/Б.md", content("target"));

		const original = index.enqueueMutation("put", "A.md", {
			sha256: "old",
			epoch: "epoch-a",
			baseRevision: 7,
		});

		await engine.renameFile("A.md", "deep/Б.md", {
			epoch: "epoch-a",
			baseRevision: 7,
		});

		assert.deepEqual(yandex.uploads, ["remote/deep/Б.md"]);
		assert.deepEqual(yandex.moves, []);
		assert.equal(index.index.files["A.md"], undefined);
		assert.equal(index.index.moves[original.id], undefined);
		assert.deepEqual(index.getPendingMutations(), []);
		assert.equal(index.index.appliedMutationSeq["device-a"], original.seq);
		const confirmed = index.local.files["deep/Б.md"];
		assert.ok(confirmed);
		assert.equal(
			confirmed.remoteFingerprint,
			await computeSha256(content("target")),
		);
		assert.equal(
			confirmed.remoteMtime,
			new Date("2026-07-30T00:00:00.000Z").getTime(),
		);
		const canonical = index.index.files["deep/Б.md"];
		assert.ok(canonical);
		const operations = new ConflictResolver().determineOperations(
			new Map([["deep/Б.md", { ...confirmed }]]),
			new Map([["deep/Б.md", { ...canonical }]]),
			index.local.files,
			index.index.files,
			Date.now(),
			index.index.folderTombstones,
			new Set(),
		);
		assert.deepEqual(operations, []);
	});

	test(`${mode} durable create rename and deep move materializes only final path`, async () => {
		const { yandex, vault, index, engine } = createHarness(
			mode === "encrypted",
		);

		vault.files.set("deep/C.md", content("final-target"));

		index.enqueueMutation("put", "A.md", {
			sha256: "initial",
			epoch: "epoch-a",
			baseRevision: 7,
		});

		const watcher = new FileWatcher({} as App, engine, DEFAULT_SETTINGS);
		watcher.setPersistCallback(async () => {});
		watcher.loadDeferredEvents([
			renameEvent("rename-a-b", "A.md", "B.md"),
			renameEvent("rename-b-c", "B.md", "deep/C.md", { createdAt: 2 }),
		]);

		await watcherAccess(watcher).flushDeferredEventsNow();

		assert.deepEqual(yandex.uploads, ["remote/deep/C.md"]);
		assert.equal(yandex.resources.has("remote/A.md"), false);
		assert.equal(yandex.resources.has("remote/B.md"), false);
		assert.equal(yandex.resources.has("remote/deep/C.md"), true);
		assert.deepEqual(index.getPendingMutations(), []);
		assert.deepEqual(index.getPendingPhysicalActions(), []);
		assert.deepEqual(watcher.getDeferredEvents(), []);
		assert.equal(index.remoteFileScans, 0);
	});

	test(`${mode} running upload hands its committed revision to a deep rename`, async () => {
		const { yandex, vault, index, engine } = createHarness(
			mode === "encrypted",
		);

		const sourceContent = content("");
		const targetContent = content("final-target");
		vault.files.set("A.md", sourceContent);

		const watcher = new FileWatcher({} as App, engine, DEFAULT_SETTINGS);
		watcher.setPersistCallback(async () => {});
		watcher.loadDeferredEvents([fileEvent("upload-a", "A.md")]);
		const access = watcherAccess(watcher);
		index.beforeSave = () => {
			index.beforeSave = undefined;
			const predecessor = access.deferredEvents.find(
				(event) => event.id === "upload-a",
			);
			assert.ok(predecessor?.action === "upload");
			predecessor.superseded = true;
			predecessor.supersededByRenameId = "rename-a-c";
			vault.files.delete("A.md");
			vault.files.set("deep/C.md", targetContent);
			access.deferEvent(
				renameEvent("rename-a-c", "A.md", "deep/C.md", {
					createdAt: 2,
					predecessorUploadId: "upload-a",
				}),
			);
		};

		await access.flushDeferredEventsNow();
		const [rename] = watcher.getDeferredEvents();
		assert.ok(rename?.action === "rename" && rename.kind === "file");
		assert.equal(rename.baseRevision, 8);
		assert.equal(rename.predecessorUploadId, undefined);

		await access.flushDeferredEventsNow();

		assert.equal(index.index.files["A.md"]?.deleted, true);
		assert.equal(index.index.files["deep/C.md"]?.deleted, undefined);
		assert.equal(yandex.resources.has("remote/A.md"), false);
		assert.equal(yandex.resources.has("remote/deep/C.md"), true);
		assert.deepEqual(index.getPendingMutations(), []);
		assert.deepEqual(index.getPendingPhysicalActions(), []);
		assert.deepEqual(watcher.getDeferredEvents(), []);
		assert.equal(index.remoteFileScans, 0);
	});

	test(`${mode} rename after physical upload retargets before canonical commit`, async () => {
		const { yandex, vault, index, engine } = createHarness(
			mode === "encrypted",
		);

		const sourceContent = content("source");
		const targetContent = content("target");
		vault.files.set("A.md", sourceContent);

		const event: RealtimeFileEvent = fileEvent("upload-a", "A.md");
		yandex.afterUpload = () => {
			yandex.afterUpload = undefined;
			event.superseded = true;
			event.supersededByRenameId = "rename-a-b";
			vault.files.delete("A.md");
			vault.files.set("B.md", targetContent);
		};

		const uploadResult = await engine.syncFileBatch([event]);

		assert.deepEqual(uploadResult.superseded, ["upload-a"]);
		assert.equal(uploadResult.uploadReceipts[0]?.status, "pending-put");
		assert.equal(index.index.files["A.md"], undefined);
		assert.equal(index.getPendingMutations()[0]?.path, "A.md");
		assert.equal(yandex.resources.has("remote/A.md"), true);

		await engine.renameFile("A.md", "B.md", {
			epoch: "epoch-a",
			baseRevision: 7,
		});

		assert.equal(index.index.files["A.md"], undefined);
		assert.equal(index.index.files["B.md"]?.deleted, undefined);
		assert.equal(yandex.resources.has("remote/A.md"), false);
		assert.equal(yandex.resources.has("remote/B.md"), true);
		assert.deepEqual(index.getPendingMutations(), []);
	});

	test(`${mode} accepted upload receipt recovers after watcher settlement crash`, async () => {
		const { yandex, index, engine } = createHarness(mode === "encrypted");

		const sourceContent = content("accepted");
		const sourceSha = await computeSha256(sourceContent);
		await yandex.uploadFile("remote/A.md", sourceContent);
		yandex.uploads.length = 0;

		index.index.revision = 8;
		index.index.appliedMutationSeq["device-a"] = 1;
		index.index.files["A.md"] = fileMetadata("A.md", sourceSha, {
			size: sourceContent.byteLength,
			changedRevision: 8,
			remoteFingerprint: sourceSha,
			lastModifiedBy: "device-a",
		});

		const event: RealtimeFileEvent = fileEvent("upload-a", "A.md", {
			mutationId: "device-a:1",
			mutationSeq: 1,
			snapshotSha256: sourceSha,
			superseded: true,
			supersededByRenameId: "rename-a-b",
		});

		const recovered = await engine.syncFileBatch([event]);

		assert.deepEqual(yandex.uploads, []);
		assert.deepEqual(recovered.completed, ["upload-a"]);
		assert.equal(recovered.uploadReceipts[0]?.status, "accepted-put");
		assert.equal(recovered.uploadReceipts[0]?.canonicalRevision, 8);
		assert.equal(index.local.files["A.md"]?.sha256, sourceSha);
	});

	test(`${mode} applied edit replay is acknowledged without a second upload`, async () => {
		const { yandex, vault, index, engine } = createHarness(
			mode === "encrypted",
		);

		const latestContent = content("latest edit");
		const latestSha = await computeSha256(latestContent);
		vault.files.set("note.md", latestContent);
		await yandex.uploadFile("remote/note.md", latestContent);
		yandex.uploads.length = 0;

		index.index.revision = 36;
		index.index.appliedMutationSeq["device-a"] = 7;
		index.index.files["note.md"] = fileMetadata("note.md", latestSha, {
			size: latestContent.byteLength,
			changedRevision: 36,
			baseRevision: 35,
			remoteFingerprint: latestSha,
			lastModifiedBy: "device-a",
			mutationSeq: 7,
		});

		const replay = await engine.syncFileBatch([
			fileEvent("upload-7", "note.md", {
				baseRevision: 35,
				mutationId: "device-a:7",
				mutationSeq: 7,
				snapshotSha256: latestSha,
			}),
		]);

		assert.deepEqual(yandex.uploads, []);
		assert.deepEqual(replay.completed, ["upload-7"]);
		assert.equal(replay.uploadReceipts[0]?.reason, "idempotent");
	});

	test(`${mode} non-rename supersession does not strand a running put`, async () => {
		const { yandex, vault, index, engine } = createHarness(
			mode === "encrypted",
		);

		vault.files.set("A.md", content("source"));

		const event: RealtimeFileEvent = fileEvent("upload-a", "A.md");
		yandex.afterUpload = () => {
			yandex.afterUpload = undefined;
			event.superseded = true;
		};

		const uploadResult = await engine.syncFileBatch([event]);

		assert.deepEqual(uploadResult.completed, ["upload-a"]);
		assert.equal(index.index.files["A.md"]?.deleted, undefined);
		assert.equal(yandex.resources.has("remote/A.md"), true);
		assert.deepEqual(index.getPendingMutations(), []);
	});

	test(`${mode} queued edit coalesces a persisted predecessor without FIFO gap`, async () => {
		const { yandex, vault, index, engine } = createHarness(
			mode === "encrypted",
		);

		const latestContent = content("latest");
		vault.files.set("note.md", latestContent);

		const previous = index.enqueueMutation("put", "note.md", {
			sha256: "previous",
			epoch: "epoch-a",
			baseRevision: 7,
		});

		const batch = await engine.syncFileBatch([
			fileEvent("upload-previous", "note.md", {
				mutationId: previous.id,
				mutationSeq: previous.seq,
				snapshotSha256: "previous",
				superseded: true,
			}),
			fileEvent("upload-latest", "note.md", { createdAt: 2 }),
		]);

		assert.deepEqual(yandex.uploads, ["remote/note.md"]);
		assert.deepEqual(batch.superseded, ["upload-previous"]);
		assert.deepEqual(batch.completed, ["upload-latest"]);
		assert.equal(index.index.appliedMutationSeq["device-a"], 2);
		assert.equal(index.index.files["note.md"]?.mutationSeq, 2);
		assert.deepEqual(index.getPendingMutations(), []);
	});

	test(`${mode} retargeted put removes its verified stale physical source`, async () => {
		const { yandex, vault, index, engine } = createHarness(
			mode === "encrypted",
		);

		const sourceContent = content("source-upload");
		const targetContent = content("target-edit");
		const sourceSha = await computeSha256(sourceContent);
		vault.files.set("B.md", targetContent);
		await yandex.uploadFile("remote/A.md", sourceContent);
		yandex.uploads.length = 0;

		index.enqueueMutation("put", "A.md", {
			sha256: sourceSha,
			epoch: "epoch-a",
			baseRevision: 7,
		});
		index.local.files["A.md"] = fileMetadata("A.md", sourceSha, {
			size: sourceContent.byteLength,
		});

		await engine.renameFile("A.md", "B.md", {
			epoch: "epoch-a",
			baseRevision: 7,
		});

		assert.equal(yandex.resources.has("remote/A.md"), false);
		assert.equal(yandex.resources.has("remote/B.md"), true);
		assert.equal(index.local.files["A.md"], undefined);
		assert.deepEqual(index.getPendingPhysicalActions(), []);
	});

	test(`${mode} causal rename uses one guarded remote move`, async () => {
		const { yandex, vault, index, engine } = createHarness(
			mode === "encrypted",
		);

		const sourceContent = content("settled");
		const sourceSha = await computeSha256(sourceContent);
		vault.files.set("deep/B.md", sourceContent);
		await yandex.uploadFile("remote/A.md", sourceContent);
		yandex.uploads.length = 0;

		setBaseline(index, sourceSha, sourceContent.byteLength);

		await engine.renameFile("A.md", "deep/B.md", {
			epoch: "epoch-a",
			baseRevision: 7,
		});

		assert.deepEqual(yandex.uploads, []);
		assert.deepEqual(yandex.moves, [
			{ from: "remote/A.md", to: "remote/deep/B.md" },
		]);
		assert.equal(yandex.resources.has("remote/A.md"), false);
		assert.equal(yandex.resources.has("remote/deep/B.md"), true);
		assert.deepEqual(index.index.moves, {});
		assert.deepEqual(index.getPendingPhysicalActions(), []);
		assert.deepEqual(index.getPendingMutations(), []);
		assert.equal(
			index.local.files["deep/B.md"]?.remoteFingerprint,
			sourceSha,
		);
	});

	test(`${mode} modified source rename materializes target before cleanup`, async () => {
		const { yandex, vault, index, engine } = createHarness(
			mode === "encrypted",
		);

		const oldContent = content("old");
		const newContent = content("new");
		const oldSha = await computeSha256(oldContent);
		const newSha = await computeSha256(newContent);
		vault.files.set("deep/B.md", newContent);
		await yandex.uploadFile("remote/A.md", oldContent);
		yandex.uploads.length = 0;

		setBaseline(index, oldSha, oldContent.byteLength);

		await engine.renameFile("A.md", "deep/B.md", {
			epoch: "epoch-a",
			baseRevision: 7,
		});

		assert.deepEqual(yandex.uploads, ["remote/deep/B.md"]);
		assert.deepEqual(yandex.moves, []);
		assert.equal(yandex.resources.has("remote/A.md"), false);
		assert.equal(yandex.resources.get("remote/deep/B.md")?.sha256, newSha);
		assert.deepEqual(index.index.moves, {});
		assert.deepEqual(index.getPendingPhysicalActions(), []);
	});
}

test("missing move target is materialized and completed", async () => {
	const { yandex, vault, index, engine } = createHarness();

	const targetContent = content("recovered");
	const targetSha = await computeSha256(targetContent);
	vault.files.set("folder/B.md", targetContent);

	setMovedCanonical(
		index,
		"folder/B.md",
		targetSha,
		targetContent.byteLength,
	);
	index.index.appliedMutationSeq["device-a"] = 2;
	index.store.loadMutations(
		[
			{
				id: "device-a:3",
				seq: 3,
				epoch: "epoch-a",
				type: "move",
				baseRevision: 7,
				path: "A.md",
				targetPath: "folder/B.md",
				resourceKind: "file",
				createdAt: 1,
			},
		],
		4,
	);
	index.recordMove("device-a:3", "A.md", "folder/B.md", "file", 7);
	index.enqueuePhysicalAction("move-remote", "A.md", {
		targetPath: "folder/B.md",
		origin: "move",
	});

	const recoveryResult = syncResult();

	await syncReconciliation.resumePendingMoves(
		reconciliationDependencies(engine),
		recoveryResult,
		true,
	);

	assert.deepEqual(yandex.uploads, ["remote/folder/B.md"]);
	assert.equal(yandex.resources.has("remote/A.md"), false);
	assert.equal(yandex.resources.has("remote/folder/B.md"), true);
	assert.deepEqual(index.index.moves, {});
	assert.deepEqual(index.getPendingPhysicalActions(), []);
	assert.deepEqual(index.getPendingMutations(), []);
	assert.equal(index.index.appliedMutationSeq["device-a"], 3);
	assert.deepEqual(recoveryResult.errors, []);
	assert.equal(
		index.local.files["folder/B.md"]?.remoteFingerprint,
		targetSha,
	);
});

test("accepted source put is confirmed before the following move", async () => {
	const { yandex, vault, index, engine } = createHarness();

	const sourceContent = content("accepted");
	const sourceSha = await computeSha256(sourceContent);
	vault.files.set("B.md", sourceContent);
	await yandex.uploadFile("remote/A.md", sourceContent);
	yandex.uploads.length = 0;

	const pendingPut = index.enqueueMutation("put", "A.md", {
		sha256: sourceSha,
		epoch: "epoch-a",
		baseRevision: 7,
	});
	index.index.appliedMutationSeq["device-a"] = pendingPut.seq;
	setBaseline(index, sourceSha, sourceContent.byteLength, 8);

	await engine.renameFile("A.md", "B.md", {
		epoch: "epoch-a",
		baseRevision: 8,
	});

	assert.deepEqual(index.getPendingMutations(), []);
	assert.equal(index.index.appliedMutationSeq["device-a"], 2);
	assert.deepEqual(yandex.moves, [
		{ from: "remote/A.md", to: "remote/B.md" },
	]);
});

test("source changed after rename base survives as a concurrent file", async () => {
	const { yandex, vault, index, engine } = createHarness();

	const baselineContent = content("baseline");
	const concurrentContent = content("concurrent");
	const targetContent = content("local-target");
	const baselineSha = await computeSha256(baselineContent);
	const concurrentSha = await computeSha256(concurrentContent);
	vault.files.set("B.md", targetContent);
	await yandex.uploadFile("remote/A.md", concurrentContent);
	yandex.uploads.length = 0;

	index.local.files["A.md"] = fileMetadata("A.md", baselineSha, {
		size: baselineContent.byteLength,
		changedRevision: 7,
		lastModifiedBy: "device-a",
	});
	index.index.files["A.md"] = fileMetadata("A.md", concurrentSha, {
		size: concurrentContent.byteLength,
		mtime: 2,
		syncedAt: 2,
		remoteFingerprint: concurrentSha,
		changedRevision: 8,
		lastModifiedBy: "device-b",
	});
	index.index.revision = 8;

	await engine.renameFile("A.md", "B.md", {
		epoch: "epoch-a",
		baseRevision: 7,
	});

	assert.equal(yandex.resources.has("remote/A.md"), true);
	assert.equal(yandex.resources.has("remote/B.md"), true);
	assert.equal(index.index.files["A.md"]?.deleted, undefined);
	assert.deepEqual(yandex.moves, []);
});

test("rename replay completes an already materialized canonical move", async () => {
	const { yandex, vault, index, engine } = createHarness();

	const targetContent = content("moved");
	const targetSha = await computeSha256(targetContent);
	vault.files.set("B.md", targetContent);
	await yandex.uploadFile("remote/B.md", targetContent);
	yandex.uploads.length = 0;

	setMovedCanonical(index, "B.md", targetSha, targetContent.byteLength);
	index.recordMove("device-a:3", "A.md", "B.md", "file", 7);

	await engine.renameFile("A.md", "B.md", {
		epoch: "epoch-a",
		baseRevision: 7,
	});

	assert.deepEqual(yandex.uploads, []);
	assert.deepEqual(yandex.moves, []);
	assert.deepEqual(index.index.moves, {});
	assert.deepEqual(index.getPendingPhysicalActions(), []);
});

test("rename acknowledgement replay detects an already applied target", async () => {
	const { yandex, vault, index, engine } = createHarness();

	const targetContent = content("already-applied");
	const targetSha = await computeSha256(targetContent);
	vault.files.set("B.md", targetContent);
	await yandex.uploadFile("remote/B.md", targetContent);
	yandex.uploads.length = 0;

	setMovedCanonical(index, "B.md", targetSha, targetContent.byteLength, true);
	index.index.revision = 8;

	const outcome = await engine.renameFile("A.md", "B.md", {
		epoch: "epoch-a",
		baseRevision: 7,
	});

	assert.equal(outcome.plan, "already-applied");
	assert.equal(outcome.canonicalRevision, 8);
	assert.deepEqual(yandex.uploads, []);
	assert.deepEqual(yandex.moves, []);
	assert.equal(index.index.revision, 8);
});

test("lost remote move response is confirmed from final state", async () => {
	const { yandex, vault, index, engine } = createHarness();
	yandex.moveThrowsAfterSuccess = true;

	const sourceContent = content("ambiguous-move");
	const sourceSha = await computeSha256(sourceContent);
	vault.files.set("B.md", sourceContent);
	await yandex.uploadFile("remote/A.md", sourceContent);
	yandex.uploads.length = 0;

	setBaseline(index, sourceSha, sourceContent.byteLength);

	await engine.renameFile("A.md", "B.md", {
		epoch: "epoch-a",
		baseRevision: 7,
	});

	assert.equal(yandex.resources.has("remote/A.md"), false);
	assert.equal(yandex.resources.has("remote/B.md"), true);
	assert.deepEqual(index.index.moves, {});
	assert.deepEqual(index.getPendingPhysicalActions(), []);
});

test("different physical target is not overwritten by rename", async () => {
	const { yandex, vault, index, engine } = createHarness();

	const sourceContent = content("source");
	const targetContent = content("target");
	const concurrentContent = content("concurrent-target");
	const sourceSha = await computeSha256(sourceContent);
	const concurrentSha = await computeSha256(concurrentContent);
	vault.files.set("B.md", targetContent);
	await yandex.uploadFile("remote/A.md", sourceContent);
	await yandex.uploadFile("remote/B.md", concurrentContent);
	yandex.uploads.length = 0;

	setBaseline(index, sourceSha, sourceContent.byteLength);

	await assert.rejects(
		engine.renameFile("A.md", "B.md", {
			epoch: "epoch-a",
			baseRevision: 7,
		}),
		/Move target already exists/,
	);

	assert.equal(yandex.resources.get("remote/B.md")?.sha256, concurrentSha);
	assert.equal(yandex.resources.has("remote/A.md"), true);
	assert.equal(Object.keys(index.index.moves).length, 1);
	assert.equal(index.getPendingPhysicalActions().length, 1);
});

test("unresolved final move recovery records a full-sync error", async () => {
	const { vault, index, engine } = createHarness();

	vault.files.set("B.md", content("different"));
	const expectedContent = content("expected");
	const expectedSha = await computeSha256(expectedContent);

	setMovedCanonical(index, "B.md", expectedSha, expectedContent.byteLength);
	index.recordMove("device-a:3", "A.md", "B.md", "file", 7);

	const recoveryResult = syncResult();

	await syncReconciliation.resumePendingMoves(
		reconciliationDependencies(engine),
		recoveryResult,
		true,
	);

	assert.equal(recoveryResult.errors.length, 1);
	assert.match(recoveryResult.errors[0]?.message ?? "", /Pending move/);
	assert.equal(index.index.moves["device-a:3"]?.pending, true);
	assert.equal(index.getPendingPhysicalActions().length, 1);
});

test("full sync settles accepted and superseded puts through one watermark", () => {
	const { index, engine } = createHarness();

	index.index.files["accepted.md"] = fileMetadata(
		"accepted.md",
		"accepted-sha",
		{ size: 8, changedRevision: 7, lastModifiedBy: "device-a" },
	);
	index.index.files["remote-wins.md"] = fileMetadata(
		"remote-wins.md",
		"remote-sha",
		{ size: 6, changedRevision: 7, lastModifiedBy: "device-b" },
	);
	const accepted = index.enqueueMutation("put", "accepted.md", {
		sha256: "accepted-sha",
	});
	const superseded = index.enqueueMutation("put", "remote-wins.md", {
		sha256: "obsolete-local-sha",
	});

	const settlement = fullSync.settleFullSyncPendingPuts(
		(
			engine as unknown as {
				fullSyncDependencies(): fullSync.Dependencies;
			}
		).fullSyncDependencies(),
	);

	assert.deepEqual(settlement, {
		pendingWatermarks: 2,
		matchingPuts: 1,
		noopPuts: 1,
	});
	assert.equal(index.index.files["accepted.md"]?.sha256, "accepted-sha");
	assert.equal(index.index.files["remote-wins.md"]?.sha256, "remote-sha");
	assert.deepEqual(
		index.getPendingMutations().map((mutation) => ({
			id: mutation.id,
			type: mutation.type,
		})),
		[
			{ id: accepted.id, type: "put" },
			{ id: superseded.id, type: "noop" },
		],
	);

	index.store.stagePendingMutations(index.index.appliedMutationSeq);
	index.store.confirmAppliedMutations(index.index.appliedMutationSeq);

	assert.equal(index.index.appliedMutationSeq["device-a"], superseded.seq);
	assert.deepEqual(index.getPendingMutations(), []);
});
