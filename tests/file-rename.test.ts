import assert from "node:assert/strict";
import test from "node:test";
import type { YandexDiskClient } from "../src/api/yandex-client";
import type { VaultAdapter } from "../src/api/vault-adapter";
import { SyncEngine } from "../src/sync/sync-engine";
import type { IndexManager } from "../src/sync/index-manager";
import { LocalOperationStore } from "../src/sync/local-operation-store";
import { computeSha256 } from "../src/utils/hash-utils";
import {
	createEmptyIndex,
	createEmptyLocalState,
	DEFAULT_SETTINGS,
	type FileMetadata,
	type PendingMutation,
	type PendingMutationType,
	type PendingPhysicalAction,
	type SyncResult,
} from "../src/types";

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
		if (!content) throw new Error(`Missing local file: ${path}`);
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

	async uploadFile(path: string, content: ArrayBuffer) {
		const copy = content.slice(0);
		this.resources.set(path, {
			content: copy,
			sha256: await computeSha256(copy),
			modified: "2026-07-30T00:00:00.000Z",
		});
		this.uploads.push(path);
	}

	async uploadFileExclusive(path: string, content: ArrayBuffer) {
		if (this.resources.has(path)) {
			throw new Error(`Remote upload target exists: ${path}`);
		}
		await this.uploadFile(path, content);
	}

	async downloadFile(path: string) {
		const resource = this.resources.get(path);
		if (!resource) throw new Error(`Missing remote file: ${path}`);
		return resource.content.slice(0);
	}

	async getLogicalResource(path: string) {
		const resource = this.resources.get(path);
		if (!resource) return null;
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
		if (!source) throw new Error(`Missing remote move source: ${from}`);
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

	async deleteResource(path: string) {
		this.resources.delete(path);
	}

	async isFolderEmpty(path: string) {
		const prefix = `${path.replace(/\/+$/, "")}/`;
		return !Array.from(this.resources.keys()).some((item) =>
			item.startsWith(prefix),
		);
	}
}

class RenameIndexFake {
	readonly index = createEmptyIndex("device-a", "epoch-a");
	readonly local = createEmptyLocalState("device-a");
	readonly store = new LocalOperationStore("device-a");

	constructor(private readonly yandex: RenameYandexFake) {
		this.index.revision = 7;
		this.local.observedEpoch = "epoch-a";
		this.local.observedRevision = 7;
		this.store.loadMutations(undefined, 1);
	}

	getRemoteIndex() {
		return this.index;
	}

	getLocalIndex() {
		return this.local;
	}

	async readCanonicalIndex() {
		return structuredClone(this.index);
	}

	getPendingMutations() {
		return this.store.getMutations();
	}

	enqueueMutation(
		type: PendingMutationType,
		path: string,
		options?: {
			targetPath?: string;
			resourceKind?: "file" | "folder";
			sha256?: string;
			baselineSha256?: string;
			epoch?: string | null;
			baseRevision?: number | null;
		},
	) {
		return this.store.enqueueMutation(
			type,
			path,
			options?.epoch ?? this.local.observedEpoch,
			options?.baseRevision ?? this.local.observedRevision,
			options,
		);
	}

	retargetPendingPut(
		oldPath: string,
		newPath: string,
		sha256: string,
	) {
		return this.store.retargetLatestPut(oldPath, newPath, sha256);
	}

	stageMutation(mutation: PendingMutation) {
		this.store.stageMutation(this.index.appliedMutationSeq, mutation);
	}

	confirmMutation(id: string) {
		this.store.confirmMutation(id, this.index.appliedMutationSeq);
	}

	confirmMutationAgainst(
		id: string,
		appliedMutationSeq: Record<string, number>,
	) {
		this.store.confirmMutation(id, appliedMutationSeq);
	}

	getPendingPutBaseRevision(path: string) {
		return this.store.findLatestPutBaseRevision(path);
	}

	getCausalBaseRevision() {
		return this.local.observedRevision;
	}

	updateLocalFile(path: string, metadata: FileMetadata) {
		this.local.files[path] = {
			...metadata,
			lastModifiedBy: "device-a",
		};
	}

	updateRemoteFile(path: string, metadata: FileMetadata) {
		this.index.files[path] = {
			...metadata,
			lastModifiedBy: "device-a",
		};
	}

	removeFromLocalIndex(path: string) {
		delete this.local.files[path];
	}

	markLocalFileDeleted(path: string) {
		const metadata = this.local.files[path];
		if (metadata) metadata.deleted = true;
	}

	markRemoteFileDeleted(path: string) {
		const metadata = this.index.files[path];
		if (metadata) metadata.deleted = true;
	}

	recordMove(
		id: string,
		fromPath: string,
		toPath: string,
		kind: "file" | "folder",
		baseRevision: number,
	) {
		this.index.moves[id] = {
			id,
			fromPath,
			toPath,
			kind,
			baseRevision,
			changedRevision: this.index.revision,
			pending: true,
			lastModifiedBy: "device-a",
		};
	}

	completeMove(id: string) {
		delete this.index.moves[id];
	}

	enqueuePhysicalAction(
		type: PendingPhysicalAction["type"],
		path: string,
		options?: Partial<PendingPhysicalAction>,
	) {
		return this.store.enqueuePhysicalAction(
			type,
			path,
			this.index.revision,
			{
				...options,
				epoch: this.index.epoch,
			},
		);
	}

	getPendingPhysicalAction(type: PendingPhysicalAction["type"], path: string) {
		return this.store.findPhysicalAction(type, path);
	}

	getPendingPhysicalActions() {
		return this.store.getPhysicalActions();
	}

	completePhysicalAction(id: string) {
		this.store.completePhysicalAction(id);
	}

	consumeRejectedPuts() {
		return [];
	}

	async saveRemoteIndex() {
		this.index.revision++;
	}

	beginPhysicalRewriteCommit() {}

	cancelPhysicalRewriteCommit() {}

	async getRemoteFiles() {
		const result = new Map<string, FileMetadata>();
		for (const [path, resource] of this.yandex.resources) {
			const logicalPath = path.replace(/^remote\//, "");
			result.set(logicalPath, {
				path: logicalPath,
				sha256: resource.sha256,
				size: resource.content.byteLength,
				mtime: 1,
				syncedAt: 1,
				remoteMtime: new Date(resource.modified).getTime(),
				remoteFingerprint: resource.sha256,
			});
		}
		return result;
	}
}

function content(value: string): ArrayBuffer {
	return new TextEncoder().encode(value).buffer;
}

function result(): SyncResult {
	return {
		success: true,
		uploaded: 0,
		downloaded: 0,
		deleted: 0,
		conflicts: 0,
		errors: [],
		startTime: 1,
		endTime: 0,
	};
}

for (const mode of ["plaintext", "encrypted"] as const) {
	test(`${mode} unsynced rename retargets the pending put`, async () => {
		const yandex = new RenameYandexFake();
		const vault = new RenameVaultFake();
		vault.files.set("deep/Б.md", content("target"));
		const index = new RenameIndexFake(yandex);
		const original = index.enqueueMutation("put", "A.md", {
			sha256: "old",
			epoch: "epoch-a",
			baseRevision: 7,
		});
		const engine = new SyncEngine(
			yandex as unknown as YandexDiskClient,
			vault as unknown as VaultAdapter,
			index as unknown as IndexManager,
			{
				...DEFAULT_SETTINGS,
				deviceId: "device-a",
				remotePath: "remote",
				enableEncryption: mode === "encrypted",
			},
		);

		await engine.renameFile("A.md", "deep/Б.md", {
			epoch: "epoch-a",
			baseRevision: 7,
		});

		assert.deepEqual(yandex.uploads, ["remote/deep/Б.md"]);
		assert.deepEqual(yandex.moves, []);
		assert.equal(index.index.files["A.md"], undefined);
		assert.equal(index.index.moves[original.id], undefined);
		assert.deepEqual(index.getPendingMutations(), []);
		assert.equal(
			index.index.appliedMutationSeq["device-a"],
			original.seq,
		);
	});

	test(`${mode} retargeted put removes its verified stale physical source`, async () => {
		const yandex = new RenameYandexFake();
		const vault = new RenameVaultFake();
		const sourceContent = content("source-upload");
		const targetContent = content("target-edit");
		const sourceSha = await computeSha256(sourceContent);
		vault.files.set("B.md", targetContent);
		await yandex.uploadFile("remote/A.md", sourceContent);
		yandex.uploads.length = 0;
		const index = new RenameIndexFake(yandex);
		index.enqueueMutation("put", "A.md", {
			sha256: sourceSha,
			epoch: "epoch-a",
			baseRevision: 7,
		});
		index.local.files["A.md"] = {
			path: "A.md",
			sha256: sourceSha,
			size: sourceContent.byteLength,
			mtime: 1,
			syncedAt: 1,
		};
		const engine = new SyncEngine(
			yandex as unknown as YandexDiskClient,
			vault as unknown as VaultAdapter,
			index as unknown as IndexManager,
			{
				...DEFAULT_SETTINGS,
				deviceId: "device-a",
				remotePath: "remote",
				enableEncryption: mode === "encrypted",
			},
		);

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
		const yandex = new RenameYandexFake();
		const vault = new RenameVaultFake();
		const sourceContent = content("settled");
		const sourceSha = await computeSha256(sourceContent);
		vault.files.set("deep/B.md", sourceContent);
		await yandex.uploadFile("remote/A.md", sourceContent);
		yandex.uploads.length = 0;
		const index = new RenameIndexFake(yandex);
		const baseline: FileMetadata = {
			path: "A.md",
			sha256: sourceSha,
			size: sourceContent.byteLength,
			mtime: 1,
			syncedAt: 1,
			remoteFingerprint: sourceSha,
			changedRevision: 7,
			lastModifiedBy: "device-a",
		};
		index.index.files["A.md"] = { ...baseline };
		index.local.files["A.md"] = { ...baseline };
		const engine = new SyncEngine(
			yandex as unknown as YandexDiskClient,
			vault as unknown as VaultAdapter,
			index as unknown as IndexManager,
			{
				...DEFAULT_SETTINGS,
				deviceId: "device-a",
				remotePath: "remote",
				enableEncryption: mode === "encrypted",
			},
		);

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
		const yandex = new RenameYandexFake();
		const vault = new RenameVaultFake();
		const oldContent = content("old");
		const newContent = content("new");
		const oldSha = await computeSha256(oldContent);
		const newSha = await computeSha256(newContent);
		vault.files.set("deep/B.md", newContent);
		await yandex.uploadFile("remote/A.md", oldContent);
		yandex.uploads.length = 0;
		const index = new RenameIndexFake(yandex);
		const baseline: FileMetadata = {
			path: "A.md",
			sha256: oldSha,
			size: oldContent.byteLength,
			mtime: 1,
			syncedAt: 1,
			remoteFingerprint: oldSha,
			changedRevision: 7,
			lastModifiedBy: "device-a",
		};
		index.index.files["A.md"] = { ...baseline };
		index.local.files["A.md"] = { ...baseline };
		const engine = new SyncEngine(
			yandex as unknown as YandexDiskClient,
			vault as unknown as VaultAdapter,
			index as unknown as IndexManager,
			{
				...DEFAULT_SETTINGS,
				deviceId: "device-a",
				remotePath: "remote",
				enableEncryption: mode === "encrypted",
			},
		);

		await engine.renameFile("A.md", "deep/B.md", {
			epoch: "epoch-a",
			baseRevision: 7,
		});

		assert.deepEqual(yandex.uploads, ["remote/deep/B.md"]);
		assert.deepEqual(yandex.moves, []);
		assert.equal(yandex.resources.has("remote/A.md"), false);
		assert.equal(
			yandex.resources.get("remote/deep/B.md")?.sha256,
			newSha,
		);
		assert.deepEqual(index.index.moves, {});
		assert.deepEqual(index.getPendingPhysicalActions(), []);
	});
}

test("beta.4 missing move target is materialized and completed", async () => {
	const yandex = new RenameYandexFake();
	const vault = new RenameVaultFake();
	const targetContent = content("recovered");
	const targetSha = await computeSha256(targetContent);
	vault.files.set("folder/B.md", targetContent);
	const index = new RenameIndexFake(yandex);
	index.index.files["A.md"] = {
		path: "A.md",
		sha256: targetSha,
		size: targetContent.byteLength,
		mtime: 1,
		syncedAt: 1,
		deleted: true,
		changedRevision: 8,
		lastModifiedBy: "device-a",
	};
	index.index.files["folder/B.md"] = {
		path: "folder/B.md",
		sha256: targetSha,
		size: targetContent.byteLength,
		mtime: 1,
		syncedAt: 1,
		changedRevision: 8,
		lastModifiedBy: "device-a",
	};
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
	const engine = new SyncEngine(
		yandex as unknown as YandexDiskClient,
		vault as unknown as VaultAdapter,
		index as unknown as IndexManager,
		{
			...DEFAULT_SETTINGS,
			deviceId: "device-a",
			remotePath: "remote",
		},
	);
	const recoveryResult = result();

	await (
		engine as unknown as {
			resumePendingMoves(
				syncResult: SyncResult,
				reportUnresolved: boolean,
			): Promise<void>;
		}
	).resumePendingMoves(recoveryResult, true);

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
	const yandex = new RenameYandexFake();
	const vault = new RenameVaultFake();
	const sourceContent = content("accepted");
	const sourceSha = await computeSha256(sourceContent);
	vault.files.set("B.md", sourceContent);
	await yandex.uploadFile("remote/A.md", sourceContent);
	yandex.uploads.length = 0;
	const index = new RenameIndexFake(yandex);
	const pendingPut = index.enqueueMutation("put", "A.md", {
		sha256: sourceSha,
		epoch: "epoch-a",
		baseRevision: 7,
	});
	index.index.appliedMutationSeq["device-a"] = pendingPut.seq;
	const baseline: FileMetadata = {
		path: "A.md",
		sha256: sourceSha,
		size: sourceContent.byteLength,
		mtime: 1,
		syncedAt: 1,
		remoteFingerprint: sourceSha,
		changedRevision: 8,
		lastModifiedBy: "device-a",
	};
	index.index.files["A.md"] = { ...baseline };
	index.local.files["A.md"] = { ...baseline };
	const engine = new SyncEngine(
		yandex as unknown as YandexDiskClient,
		vault as unknown as VaultAdapter,
		index as unknown as IndexManager,
		{
			...DEFAULT_SETTINGS,
			deviceId: "device-a",
			remotePath: "remote",
		},
	);

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
	const yandex = new RenameYandexFake();
	const vault = new RenameVaultFake();
	const baselineContent = content("baseline");
	const concurrentContent = content("concurrent");
	const targetContent = content("local-target");
	const baselineSha = await computeSha256(baselineContent);
	const concurrentSha = await computeSha256(concurrentContent);
	vault.files.set("B.md", targetContent);
	await yandex.uploadFile("remote/A.md", concurrentContent);
	yandex.uploads.length = 0;
	const index = new RenameIndexFake(yandex);
	index.local.files["A.md"] = {
		path: "A.md",
		sha256: baselineSha,
		size: baselineContent.byteLength,
		mtime: 1,
		syncedAt: 1,
		changedRevision: 7,
		lastModifiedBy: "device-a",
	};
	index.index.files["A.md"] = {
		path: "A.md",
		sha256: concurrentSha,
		size: concurrentContent.byteLength,
		mtime: 2,
		syncedAt: 2,
		remoteFingerprint: concurrentSha,
		changedRevision: 8,
		lastModifiedBy: "device-b",
	};
	index.index.revision = 8;
	const engine = new SyncEngine(
		yandex as unknown as YandexDiskClient,
		vault as unknown as VaultAdapter,
		index as unknown as IndexManager,
		{
			...DEFAULT_SETTINGS,
			deviceId: "device-a",
			remotePath: "remote",
		},
	);

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
	const yandex = new RenameYandexFake();
	const vault = new RenameVaultFake();
	const targetContent = content("moved");
	const targetSha = await computeSha256(targetContent);
	vault.files.set("B.md", targetContent);
	await yandex.uploadFile("remote/B.md", targetContent);
	yandex.uploads.length = 0;
	const index = new RenameIndexFake(yandex);
	index.index.files["A.md"] = {
		path: "A.md",
		sha256: targetSha,
		size: targetContent.byteLength,
		mtime: 1,
		syncedAt: 1,
		deleted: true,
		changedRevision: 8,
		lastModifiedBy: "device-a",
	};
	index.index.files["B.md"] = {
		path: "B.md",
		sha256: targetSha,
		size: targetContent.byteLength,
		mtime: 1,
		syncedAt: 1,
		changedRevision: 8,
		lastModifiedBy: "device-a",
	};
	index.recordMove("device-a:3", "A.md", "B.md", "file", 7);
	const engine = new SyncEngine(
		yandex as unknown as YandexDiskClient,
		vault as unknown as VaultAdapter,
		index as unknown as IndexManager,
		{
			...DEFAULT_SETTINGS,
			deviceId: "device-a",
			remotePath: "remote",
		},
	);

	await engine.renameFile("A.md", "B.md", {
		epoch: "epoch-a",
		baseRevision: 7,
	});

	assert.deepEqual(yandex.uploads, []);
	assert.deepEqual(yandex.moves, []);
	assert.deepEqual(index.index.moves, {});
	assert.deepEqual(index.getPendingPhysicalActions(), []);
});

test("lost remote move response is confirmed from final state", async () => {
	const yandex = new RenameYandexFake();
	yandex.moveThrowsAfterSuccess = true;
	const vault = new RenameVaultFake();
	const sourceContent = content("ambiguous-move");
	const sourceSha = await computeSha256(sourceContent);
	vault.files.set("B.md", sourceContent);
	await yandex.uploadFile("remote/A.md", sourceContent);
	yandex.uploads.length = 0;
	const index = new RenameIndexFake(yandex);
	const baseline: FileMetadata = {
		path: "A.md",
		sha256: sourceSha,
		size: sourceContent.byteLength,
		mtime: 1,
		syncedAt: 1,
		remoteFingerprint: sourceSha,
		changedRevision: 7,
		lastModifiedBy: "device-a",
	};
	index.index.files["A.md"] = { ...baseline };
	index.local.files["A.md"] = { ...baseline };
	const engine = new SyncEngine(
		yandex as unknown as YandexDiskClient,
		vault as unknown as VaultAdapter,
		index as unknown as IndexManager,
		{
			...DEFAULT_SETTINGS,
			deviceId: "device-a",
			remotePath: "remote",
		},
	);

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
	const yandex = new RenameYandexFake();
	const vault = new RenameVaultFake();
	const sourceContent = content("source");
	const targetContent = content("target");
	const concurrentContent = content("concurrent-target");
	const sourceSha = await computeSha256(sourceContent);
	const concurrentSha = await computeSha256(concurrentContent);
	vault.files.set("B.md", targetContent);
	await yandex.uploadFile("remote/A.md", sourceContent);
	await yandex.uploadFile("remote/B.md", concurrentContent);
	yandex.uploads.length = 0;
	const index = new RenameIndexFake(yandex);
	const baseline: FileMetadata = {
		path: "A.md",
		sha256: sourceSha,
		size: sourceContent.byteLength,
		mtime: 1,
		syncedAt: 1,
		remoteFingerprint: sourceSha,
		changedRevision: 7,
		lastModifiedBy: "device-a",
	};
	index.index.files["A.md"] = { ...baseline };
	index.local.files["A.md"] = { ...baseline };
	const engine = new SyncEngine(
		yandex as unknown as YandexDiskClient,
		vault as unknown as VaultAdapter,
		index as unknown as IndexManager,
		{
			...DEFAULT_SETTINGS,
			deviceId: "device-a",
			remotePath: "remote",
		},
	);

	await assert.rejects(
		engine.renameFile("A.md", "B.md", {
			epoch: "epoch-a",
			baseRevision: 7,
		}),
		/Move target already exists/,
	);

	assert.equal(
		yandex.resources.get("remote/B.md")?.sha256,
		concurrentSha,
	);
	assert.equal(yandex.resources.has("remote/A.md"), true);
	assert.equal(Object.keys(index.index.moves).length, 1);
	assert.equal(index.getPendingPhysicalActions().length, 1);
});

test("unresolved final move recovery records a full-sync error", async () => {
	const yandex = new RenameYandexFake();
	const vault = new RenameVaultFake();
	vault.files.set("B.md", content("different"));
	const expectedContent = content("expected");
	const expectedSha = await computeSha256(expectedContent);
	const index = new RenameIndexFake(yandex);
	index.index.files["A.md"] = {
		path: "A.md",
		sha256: expectedSha,
		size: expectedContent.byteLength,
		mtime: 1,
		syncedAt: 1,
		deleted: true,
		changedRevision: 8,
		lastModifiedBy: "device-a",
	};
	index.index.files["B.md"] = {
		path: "B.md",
		sha256: expectedSha,
		size: expectedContent.byteLength,
		mtime: 1,
		syncedAt: 1,
		changedRevision: 8,
		lastModifiedBy: "device-a",
	};
	index.recordMove("device-a:3", "A.md", "B.md", "file", 7);
	const engine = new SyncEngine(
		yandex as unknown as YandexDiskClient,
		vault as unknown as VaultAdapter,
		index as unknown as IndexManager,
		{
			...DEFAULT_SETTINGS,
			deviceId: "device-a",
			remotePath: "remote",
		},
	);
	const recoveryResult = result();

	await (
		engine as unknown as {
			resumePendingMoves(
				syncResult: SyncResult,
				reportUnresolved: boolean,
			): Promise<void>;
		}
	).resumePendingMoves(recoveryResult, true);

	assert.equal(recoveryResult.errors.length, 1);
	assert.match(recoveryResult.errors[0]?.message ?? "", /Pending move/);
	assert.equal(index.index.moves["device-a:3"]?.pending, true);
	assert.equal(index.getPendingPhysicalActions().length, 1);
});
