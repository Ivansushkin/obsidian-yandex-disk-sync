import assert from "node:assert/strict";
import test from "node:test";
import { TFile, type App } from "obsidian";
import type { VaultAdapter } from "../src/api/vault-adapter";
import type { YandexDiskClient } from "../src/api/yandex-client";
import type { IndexManager } from "../src/sync/canonical/manager";
import { SyncEngine } from "../src/sync/engine";
import type { RealtimeFileEvent } from "../src/sync/realtime/rules";
import { FileWatcher } from "../src/sync/realtime/watcher";
import * as reconcileAcceptedUploads from "../src/sync/reconciliation/accepted-uploads";
import { ConflictResolver } from "../src/sync/reconciliation/conflicts";
import * as reconcilePhysicalRecovery from "../src/sync/reconciliation/physical-recovery";
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

	getFile(path: string) {
		const content = this.files.get(path);
		return content ? { stat: { size: content.byteLength } } : null;
	}

	getFileMtime() {
		return 1;
	}
}

class RenameYandexFake {
	async withWriteGuard<T>(
		assertCurrent: () => void,
		action: () => Promise<T>,
	): Promise<T> {
		assertCurrent();
		const result = await action();
		assertCurrent();
		return result;
	}
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

	getReadConfigurationVersion() {
		return 0;
	}

	async downloadStableLogicalFile(path: string) {
		const resource = await this.getLogicalResource(path);
		return resource
			? {
					resource,
					content: await this.downloadFile(path),
					fingerprint: `sha256:${resource.sha256}`,
					verifiedRawSha256: resource.sha256,
				}
			: null;
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
	override createCanonicalReadSession(assertActive: () => void = () => {}) {
		const read = async () => {
			assertActive();
			return await this.readCanonicalIndex();
		};
		return Object.assign(read, {
			assertCurrent: assertActive,
			load: read,
		});
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
): SyncEngine {
	return new SyncEngine(
		yandex as unknown as YandexDiskClient,
		vault as unknown as VaultAdapter,
		index as unknown as IndexManager,
		{
			...DEFAULT_SETTINGS,
			deviceId: "device-a",
			remotePath: "remote",
		},
	);
}

function createHarness() {
	const yandex = new RenameYandexFake();
	const vault = new RenameVaultFake();
	const index = new RenameIndexFake(yandex);
	const engine = createRenameEngine(yandex, vault, index);
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

function content(value: string): ArrayBuffer {
	return new TextEncoder().encode(value).buffer;
}

test("accepted upload repair revalidates canonical and encryption authority", async () => {
	for (const revoked of ["canonical", "encryption"] as const) {
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
			revision: 8,
			index: structuredClone(index.index),
			contentFingerprint: "md5:accepted",
		};
		if (revoked === "canonical") {
			index.beforeRepairAuthorization = () => {
				index.index.revision = 9;
				Object.assign(index.index.files["note.md"]!, {
					deleted: true,
					changedRevision: 9,
					lastModifiedBy: "device-b",
				});
			};
		} else {
			engine.setSyncGuardCallback(async (token) => ({
				blockReason:
					token === "old-manifest" ? "manifest changed" : null,
			}));
		}
		const repair = reconcileAcceptedUploads.repairMissingAcceptedUploads(
			reconciliationDependencies(engine),
			[{ path: "note.md", snapshot: { content: fileContent, sha256 } }],
			proof,
			revoked === "encryption" ? "old-manifest" : undefined,
		);
		if (revoked === "encryption") {
			await assert.rejects(repair, /encryption state changed/i);
		} else {
			await repair;
		}
		assert.deepEqual(yandex.uploads, [], revoked);
		assert.equal(yandex.resources.has("remote/note.md"), false, revoked);
	}
});

test("file rename preserves causal sources and materializes only an authorized target", async () => {
	const cases = [
		{ name: "unsynced", pending: true, edited: true },
		{
			name: "retargeted physical put",
			pending: true,
			physical: true,
			edited: true,
		},
		{ name: "causal move", baseline: true, physical: true, move: true },
		{
			name: "modified source",
			baseline: true,
			physical: true,
			edited: true,
		},
		{
			name: "accepted predecessor",
			baseline: true,
			physical: true,
			pending: true,
			accepted: true,
			move: true,
		},
		{
			name: "concurrent source",
			baseline: true,
			physical: true,
			foreign: true,
			edited: true,
		},
		{
			name: "lost move response",
			baseline: true,
			physical: true,
			move: true,
			lost: true,
		},
		{
			name: "occupied target",
			baseline: true,
			physical: true,
			collision: true,
		},
	] as const;
	for (const row of cases) {
		const scenario = row as {
			name: string;
			pending?: boolean;
			baseline?: boolean;
			physical?: boolean;
			edited?: boolean;
			accepted?: boolean;
			foreign?: boolean;
			move?: boolean;
			lost?: boolean;
			collision?: boolean;
		};
		const { yandex, vault, index, engine } = createHarness();
		const source = content("source");
		const sourceSha = await computeSha256(source);
		const target = content(scenario.edited ? "edited" : "source");
		const targetSha = await computeSha256(target);
		const path = "deep/Б.md";
		vault.files.set(path, target);
		if (scenario.physical) {
			await yandex.uploadFile("remote/A.md", source);
		}
		if (scenario.baseline) {
			setBaseline(index, sourceSha, source.byteLength);
		}
		let predecessorSeq: number | undefined;
		if (scenario.pending) {
			const put = index.enqueueMutation("put", "A.md", {
				sha256: sourceSha,
				epoch: "epoch-a",
				baseRevision: 7,
			});
			predecessorSeq = put.seq;
			if (scenario.physical && !scenario.baseline) {
				index.local.files["A.md"] = fileMetadata("A.md", sourceSha, {
					size: source.byteLength,
				});
			}
			if (scenario.accepted) {
				index.index.appliedMutationSeq["device-a"] = put.seq;
				setBaseline(index, sourceSha, source.byteLength, 8);
			}
		}
		if (scenario.foreign) {
			const foreignSource = content("foreign-source");
			const foreignSha = await computeSha256(foreignSource);
			await yandex.uploadFile("remote/A.md", foreignSource);
			Object.assign(index.index.files["A.md"]!, {
				changedRevision: 8,
				lastModifiedBy: "device-b",
				sha256: foreignSha,
				remoteFingerprint: foreignSha,
				size: foreignSource.byteLength,
			});
			index.index.revision = 8;
		}
		const collision = content("foreign-target");
		if (scenario.collision) {
			await yandex.uploadFile(`remote/${path}`, collision);
		}
		yandex.uploads.length = 0;
		yandex.moveThrowsAfterSuccess = Boolean(scenario.lost);
		const rename = engine.renameFile("A.md", path, {
			epoch: "epoch-a",
			baseRevision: scenario.accepted ? 8 : 7,
		});
		if (scenario.collision) {
			await assert.rejects(
				rename,
				/Move target already exists/,
				scenario.name,
			);
			assert.equal(
				yandex.resources.get(`remote/${path}`)?.sha256,
				await computeSha256(collision),
			);
			assert.equal(yandex.resources.has("remote/A.md"), true);
			assert.equal(Object.keys(index.index.moves).length, 1);
			assert.equal(index.getPendingPhysicalActions().length, 1);
			continue;
		}
		await rename;
		assert.deepEqual(
			yandex.uploads,
			scenario.move ? [] : [`remote/${path}`],
			scenario.name,
		);
		assert.deepEqual(
			yandex.moves,
			scenario.move
				? [{ from: "remote/A.md", to: `remote/${path}` }]
				: [],
			scenario.name,
		);
		assert.equal(
			yandex.resources.has("remote/A.md"),
			Boolean(scenario.foreign),
			scenario.name,
		);
		assert.equal(
			yandex.resources.get(`remote/${path}`)?.sha256,
			targetSha,
			scenario.name,
		);
		assert.deepEqual(index.index.moves, {}, scenario.name);
		assert.deepEqual(index.getPendingMutations(), [], scenario.name);
		assert.deepEqual(index.getPendingPhysicalActions(), [], scenario.name);
		assert.equal(
			index.local.files[path]?.remoteFingerprint,
			targetSha,
			scenario.name,
		);
		assert.equal(
			index.local.files[path]?.remoteMtime,
			Date.parse("2026-07-30T00:00:00.000Z"),
			scenario.name,
		);
		if (predecessorSeq !== undefined) {
			assert.equal(
				index.index.appliedMutationSeq["device-a"],
				scenario.accepted ? predecessorSeq + 1 : predecessorSeq,
				scenario.name,
			);
		}
		if (scenario.foreign) {
			assert.equal(index.index.files["A.md"]?.deleted, undefined);
		} else if (scenario.pending && !scenario.baseline) {
			assert.equal(index.index.files["A.md"], undefined);
			assert.equal(index.local.files["A.md"], undefined);
		}
		assert.deepEqual(
			new ConflictResolver().determineOperations(
				new Map([[path, { ...index.local.files[path] }]]),
				new Map([[path, { ...index.index.files[path]! }]]),
				{ [path]: index.local.files[path] },
				{ [path]: index.index.files[path]! },
				Date.now(),
				{},
				new Set(),
			),
			[],
			scenario.name,
		);
	}
});

test("durable create rename and deep move materializes only final path", async () => {
	const { yandex, vault, index, engine } = createHarness();

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

test("running upload hands its committed revision to a deep rename", async () => {
	const { yandex, vault, index, engine } = createHarness();

	const sourceContent = content("");
	const targetContent = content("final-target");
	vault.files.set("A.md", sourceContent);

	const watcher = new FileWatcher({} as App, engine, DEFAULT_SETTINGS);
	const persistedQueues: ReturnType<FileWatcher["getDeferredEvents"]>[] = [];
	watcher.setPersistCallback(async () => {
		persistedQueues.push(structuredClone(watcher.getDeferredEvents()));
	});
	watcher.loadDeferredEvents([fileEvent("upload-a", "A.md")]);
	const access = watcherAccess(watcher);
	index.beforeSave = () => {
		index.beforeSave = undefined;
		const predecessor = watcher
			.getDeferredEvents()
			.find((event) => event.id === "upload-a");
		assert.ok(predecessor?.action === "upload");
		vault.files.delete("A.md");
		vault.files.set("deep/C.md", targetContent);
		const target = new TFile();
		target.path = "deep/C.md";
		access.handleFileRename(target, "A.md");
	};

	await access.flushDeferredEventsNow();
	const [rename] = watcher.getDeferredEvents();
	assert.ok(rename?.action === "rename" && rename.kind === "file");
	assert.equal(rename.baseRevision, 8);
	assert.equal(rename.predecessorUploadId, undefined);
	assert.deepEqual(persistedQueues.at(-1), [rename]);

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

test("replayed upload receipts acknowledge the original watermark without another upload", async () => {
	for (const renamed of [false, true]) {
		const { yandex, vault, index, engine } = createHarness();
		const value = content("accepted");
		const sha = await computeSha256(value);
		if (!renamed) {
			vault.files.set("note.md", value);
		}
		await yandex.uploadFile("remote/note.md", value);
		yandex.uploads.length = 0;
		index.index.revision = 8;
		index.index.appliedMutationSeq["device-a"] = 1;
		index.index.files["note.md"] = fileMetadata("note.md", sha, {
			size: value.byteLength,
			changedRevision: 8,
			baseRevision: 7,
			remoteFingerprint: sha,
			lastModifiedBy: "device-a",
			mutationSeq: 1,
		});
		assert.equal(vault.files.has("note.md"), !renamed);
		const replay = await engine.syncFileBatch([
			fileEvent("upload", "note.md", {
				baseRevision: 7,
				mutationId: "device-a:1",
				mutationSeq: 1,
				snapshotSha256: sha,
				superseded: renamed,
				supersededByRenameId: renamed ? "rename" : undefined,
			}),
		]);
		assert.deepEqual(yandex.uploads, []);
		assert.deepEqual(replay.completed, ["upload"]);
		assert.equal(replay.uploadReceipts[0]?.status, "accepted-put");
		assert.equal(replay.uploadReceipts[0]?.canonicalRevision, 8);
		assert.equal(index.local.files["note.md"]?.sha256, sha);
		if (!renamed) {
			assert.equal(replay.uploadReceipts[0]?.reason, "idempotent");
		}
	}
});

test("upload supersession retains rename work and closes ordinary FIFO predecessors", async () => {
	for (const cause of ["rename", "edit", "queued-edit"] as const) {
		const { yandex, vault, index, engine } = createHarness();
		vault.files.set("A.md", content("source"));
		const event: RealtimeFileEvent = fileEvent("upload", "A.md");
		const events = [event];
		if (cause === "queued-edit") {
			const pending = index.enqueueMutation("put", "A.md", {
				sha256: "previous",
				epoch: "epoch-a",
				baseRevision: 7,
			});
			Object.assign(event, {
				mutationId: pending.id,
				mutationSeq: pending.seq,
				snapshotSha256: "previous",
				superseded: true,
			});
			events.push(fileEvent("latest", "A.md", { createdAt: 2 }));
		} else {
			yandex.afterUpload = () => {
				yandex.afterUpload = undefined;
				event.superseded = true;
				if (cause === "rename") {
					event.supersededByRenameId = "rename";
					vault.files.delete("A.md");
					vault.files.set("B.md", content("target"));
				}
			};
		}
		const batch = await engine.syncFileBatch(events);
		assert.deepEqual(yandex.uploads, ["remote/A.md"], cause);
		if (cause === "rename") {
			assert.deepEqual(batch.superseded, ["upload"]);
			assert.equal(batch.uploadReceipts[0]?.status, "pending-put");
			assert.equal(index.index.files["A.md"], undefined);
			assert.equal(index.getPendingMutations()[0]?.path, "A.md");
			await engine.renameFile("A.md", "B.md", {
				epoch: "epoch-a",
				baseRevision: 7,
			});
			assert.equal(yandex.resources.has("remote/A.md"), false);
			assert.equal(yandex.resources.has("remote/B.md"), true);
			assert.equal(index.index.files["A.md"], undefined);
			assert.equal(index.index.files["B.md"]?.deleted, undefined);
		} else {
			assert.deepEqual(batch.completed, [
				cause === "queued-edit" ? "latest" : "upload",
			]);
			assert.equal(index.index.files["A.md"]?.deleted, undefined);
			assert.equal(yandex.resources.has("remote/A.md"), true);
			if (cause === "queued-edit") {
				assert.deepEqual(batch.superseded, ["upload"]);
				assert.equal(index.index.appliedMutationSeq["device-a"], 2);
				assert.equal(index.index.files["A.md"]?.mutationSeq, 2);
			}
		}
		assert.deepEqual(index.getPendingMutations(), [], cause);
	}
});

test("move recovery distinguishes missing materialized acknowledged and conflicting targets", async () => {
	for (const state of [
		"missing",
		"materialized",
		"acknowledged",
		"conflicting",
	] as const) {
		const { yandex, vault, index, engine } = createHarness();
		const target = content("recovered");
		const sha = await computeSha256(target);
		const path = "folder/B.md";
		vault.files.set(
			path,
			state === "conflicting" ? content("different") : target,
		);
		if (state === "materialized" || state === "acknowledged") {
			await yandex.uploadFile(`remote/${path}`, target);
		}
		yandex.uploads.length = 0;
		setMovedCanonical(
			index,
			path,
			sha,
			target.byteLength,
			state === "acknowledged",
		);
		index.index.revision = 8;
		if (state !== "acknowledged") {
			index.recordMove("device-a:3", "A.md", path, "file", 7);
		}
		const result = syncResult();
		if (state === "missing") {
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
						targetPath: path,
						resourceKind: "file",
						createdAt: 1,
					},
				],
				4,
			);
			index.enqueuePhysicalAction("move-remote", "A.md", {
				targetPath: path,
				origin: "move",
			});
		}
		if (state === "missing" || state === "conflicting") {
			await reconcilePhysicalRecovery.resumePendingMoves(
				reconciliationDependencies(engine),
				result,
				true,
			);
		} else {
			const outcome = await engine.renameFile("A.md", path, {
				epoch: "epoch-a",
				baseRevision: 7,
			});
			if (state === "acknowledged") {
				assert.equal(outcome.plan, "already-applied");
				assert.equal(outcome.canonicalRevision, 8);
				assert.equal(index.index.revision, 8);
			}
		}
		assert.deepEqual(
			yandex.uploads,
			state === "missing" ? [`remote/${path}`] : [],
			state,
		);
		assert.deepEqual(yandex.moves, [], state);
		if (state === "conflicting") {
			assert.equal(result.errors.length, 1);
			assert.match(result.errors[0]?.message ?? "", /Pending move/);
			assert.equal(index.index.moves["device-a:3"]?.pending, true);
			assert.equal(index.getPendingPhysicalActions().length, 1);
		} else {
			assert.equal(yandex.resources.has("remote/A.md"), false);
			assert.equal(
				yandex.resources.get(`remote/${path}`)?.sha256,
				sha,
				state,
			);
			assert.deepEqual(index.index.moves, {}, state);
			assert.deepEqual(index.getPendingPhysicalActions(), [], state);
			assert.deepEqual(index.getPendingMutations(), [], state);
			assert.deepEqual(result.errors, [], state);
			if (state === "missing") {
				assert.equal(index.index.appliedMutationSeq["device-a"], 3);
				assert.equal(index.local.files[path]?.remoteFingerprint, sha);
			}
		}
	}
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
