import assert from "node:assert/strict";
import test from "node:test";
import type { YandexDiskClient } from "../src/api/yandex-client";
import type { VaultAdapter } from "../src/api/vault-adapter";
import { SyncEngine } from "../src/sync/sync-engine";
import type { IndexManager } from "../src/sync/index-manager";
import {
	createEmptyIndex,
	DEFAULT_SETTINGS,
	type FileMetadata,
	type PendingMutation,
	type PendingPhysicalAction,
} from "../src/types";

function metadata(
	path: string,
	options?: {
		deleted?: boolean;
		fingerprint?: string;
		changedRevision?: number;
	},
): FileMetadata {
	return {
		path,
		sha256: `sha:${path}`,
		size: 1,
		mtime: 1,
		syncedAt: 1,
		deleted: options?.deleted,
		remoteFingerprint: options?.fingerprint,
		changedRevision: options?.changedRevision,
	};
}

/**
 * Minimal causal index used to exercise the folder-delete orchestration.
 */
class FolderDeleteIndexFake {
	readonly index = createEmptyIndex("device-test", "epoch-test");
	readonly local = {
		version: 1 as const,
		observedEpoch: "epoch-test",
		observedRevision: 7,
		files: {} as Record<string, FileMetadata>,
		folderTombstones: {},
		nextMutationSeq: 1,
		lastSyncTime: 0,
	};
	readonly pendingActions: PendingPhysicalAction[] = [];
	readonly pendingMutations: PendingMutation[] = [];
	readonly commits: number[] = [];
	beforeCanonicalRead?: () => void;

	constructor() {
		this.index.revision = 7;
		this.index.files["folder/Без названия.md"] = metadata(
			"folder/Без названия.md",
			{ deleted: true, changedRevision: 6 },
		);
		this.index.files["folder/Чо как.md"] = metadata(
			"folder/Чо как.md",
			{ fingerprint: "live-fingerprint", changedRevision: 7 },
		);
		this.local.files = structuredClone(this.index.files);
	}

	getRemoteIndex() {
		return this.index;
	}

	getLocalIndex() {
		return this.local;
	}

	getPendingPhysicalActions() {
		return this.pendingActions.map((action) => ({ ...action }));
	}

	getPendingMutations() {
		return this.pendingMutations;
	}

	getPendingPhysicalAction(type: string, path: string) {
		return this.pendingActions.find(
			(action) => action.type === type && action.path === path,
		);
	}

	hasPendingPhysicalAction(type: string, path: string) {
		return this.getPendingPhysicalAction(type, path) !== undefined;
	}

	enqueueMutation(
		type: PendingMutation["type"],
		path: string,
		options?: Partial<PendingMutation>,
	) {
		const mutation: PendingMutation = {
			id: "mutation-1",
			seq: this.pendingMutations.length + 2,
			epoch: this.index.epoch,
			type,
			baseRevision: options?.baseRevision ?? this.index.revision,
			path,
			createdAt: 1,
		};
		this.pendingMutations.push(mutation);
		return mutation;
	}

	markFolderDeleted(
		path: string,
		deletedAt: number,
		baseRevision: number | null,
		mutationSeq?: number,
	) {
		this.index.folderTombstones[path] = {
			path,
			deletedAt,
			changedRevision: this.index.revision,
			baseRevision: baseRevision ?? 0,
			lastModifiedBy: "device-test",
			mutationSeq,
		};
	}

	markRemoteFileDeleted(
		path: string,
		deletedByFolder?: string,
		baseRevision?: number,
		mutationSeq?: number,
	) {
		const current = this.index.files[path];
		if (!current || current.deleted) return;
		Object.assign(current, {
			deleted: true,
			deletedAt: 1,
			deletedByFolder,
			baseRevision,
			mutationSeq,
			lastModifiedBy: "device-test",
		});
	}

	markLocalFileDeleted(path: string, deletedByFolder?: string) {
		const current = this.local.files[path];
		if (!current || current.deleted) return;
		Object.assign(current, {
			deleted: true,
			deletedAt: 1,
			deletedByFolder,
		});
	}

	updateRemoteFile(path: string, value: FileMetadata) {
		this.index.files[path] = { ...value, lastModifiedBy: "device-test" };
	}

	updateLocalFile(path: string, value: FileMetadata) {
		this.local.files[path] = { ...value };
	}

	recordMove(
		id: string,
		fromPath: string,
		toPath: string,
		kind: "file" | "folder",
		baseRevision: number,
		mutationSeq?: number,
	) {
		this.index.moves[id] = {
			id,
			fromPath,
			toPath,
			kind,
			baseRevision,
			changedRevision: this.index.revision,
			pending: true,
			lastModifiedBy: "device-test",
			mutationSeq,
		};
	}

	completeMove(id: string) {
		delete this.index.moves[id];
	}

	enqueuePhysicalAction(
		type: PendingPhysicalAction["type"],
		path: string,
		options: Partial<PendingPhysicalAction>,
	) {
		const action: PendingPhysicalAction = {
			id: `action-${this.pendingActions.length + 1}`,
			type,
			epoch: this.index.epoch,
			origin: options.origin ?? "exact-delete",
			path,
			targetPath: options.targetPath,
			parentMutationId: options.parentMutationId,
			canonicalRevision:
				options.canonicalRevision ?? this.index.revision,
			expectedFingerprint: options.expectedFingerprint,
			createdAt: 1,
		};
		this.pendingActions.push(action);
		return action;
	}

	stageMutation(mutation: PendingMutation) {
		this.index.appliedMutationSeq["device-test"] = mutation.seq;
	}

	async saveRemoteIndex() {
		this.index.revision++;
		this.commits.push(this.index.revision);
		for (const current of Object.values(this.index.files)) {
			if (current.deleted && current.deletedByFolder === "folder") {
				current.changedRevision = this.index.revision;
			}
		}
		const tombstone = this.index.folderTombstones.folder;
		if (tombstone) tombstone.changedRevision = this.index.revision;
		for (const move of Object.values(this.index.moves)) {
			move.changedRevision = this.index.revision;
		}
	}

	consumeRejectedPuts() {
		return [];
	}

	confirmMutation(id: string) {
		const index = this.pendingMutations.findIndex(
			(mutation) => mutation.id === id,
		);
		if (index >= 0) this.pendingMutations.splice(index, 1);
	}

	async readCanonicalIndex() {
		this.beforeCanonicalRead?.();
		this.beforeCanonicalRead = undefined;
		return structuredClone(this.index);
	}

	async refreshCanonicalForMutation() {
		return structuredClone(this.index);
	}

	completePhysicalAction(id: string) {
		const index = this.pendingActions.findIndex(
			(action) => action.id === id,
		);
		if (index >= 0) this.pendingActions.splice(index, 1);
	}

	beginPhysicalRewriteCommit() {}

	cancelPhysicalRewriteCommit() {}
}

/**
 * Logical Yandex client fake shared by plaintext and encrypted engine flows.
 */
class FolderDeleteYandexFake {
	readonly resources = new Map<string, { sha256?: string }>();
	readonly deletes: string[] = [];
	readonly moves: Array<{ fromPath: string; toPath: string }> = [];

	constructor() {
		this.resources.set("remote/folder/Чо как.md", {
			sha256: "live-fingerprint",
		});
	}

	async getLogicalResource(path: string) {
		const resource = this.resources.get(path);
		return resource
			? {
					...resource,
					type: "file",
					modified: new Date(1).toISOString(),
					size: 1,
				  }
			: null;
	}

	async moveResource(fromPath: string, toPath: string) {
		const resource = this.resources.get(fromPath);
		if (!resource) throw new Error("missing source");
		if (this.resources.has(toPath)) throw new Error("target exists");
		this.resources.set(toPath, resource);
		this.resources.delete(fromPath);
		this.moves.push({ fromPath, toPath });
	}

	async deleteResource(path: string) {
		this.deletes.push(path);
		this.resources.delete(path);
	}

	async isFolderEmpty() {
		return true;
	}
}

for (const mode of ["plaintext", "encrypted"] as const) {
	test(`${mode} rename tombstone is skipped by folder delete`, async () => {
		const indexManager = new FolderDeleteIndexFake();
		const yandexClient = new FolderDeleteYandexFake();
		const engine = new SyncEngine(
			yandexClient as unknown as YandexDiskClient,
			{} as VaultAdapter,
			indexManager as unknown as IndexManager,
			{
				...DEFAULT_SETTINGS,
				deviceId: "device-test",
				remotePath: "remote",
				enableEncryption: mode === "encrypted",
			},
		);

		await engine.deleteFolder("folder");

		assert.deepEqual(yandexClient.deletes, [
			"remote/folder/Чо как.md",
			"remote/folder",
		]);
		assert.equal(indexManager.index.revision, 8);
		assert.equal(indexManager.pendingMutations.length, 0);
		assert.equal(indexManager.pendingActions.length, 0);
		assert.equal(
			indexManager.index.files["folder/Без названия.md"]
				?.changedRevision,
			6,
		);
		assert.equal(
			indexManager.index.files["folder/Без названия.md"]
				?.deletedByFolder,
			undefined,
		);
	});
}

for (const mode of ["plaintext", "encrypted"] as const) {
	test(`${mode} folder rename uses guarded file moves and two commits`, async () => {
		const indexManager = new FolderDeleteIndexFake();
		indexManager.index.files = {
			"A/deep/note.md": {
				...metadata("A/deep/note.md", {
					fingerprint: "source-fingerprint",
					changedRevision: 7,
				}),
				lastModifiedBy: "device-test",
				mutationSeq: 1,
			},
		};
		indexManager.local.files = structuredClone(indexManager.index.files);
		const yandexClient = new FolderDeleteYandexFake();
		yandexClient.resources.clear();
		yandexClient.resources.set("remote/A/deep/note.md", {
			sha256: "source-fingerprint",
		});
		const vault = {
			fileExists: () => false,
			getFileMtime: () => 1,
		};
		const engine = new SyncEngine(
			yandexClient as unknown as YandexDiskClient,
			vault as unknown as VaultAdapter,
			indexManager as unknown as IndexManager,
			{
				...DEFAULT_SETTINGS,
				deviceId: "device-test",
				remotePath: "remote",
				enableEncryption: mode === "encrypted",
			},
		);

		const outcome = await engine.renameFolder("A", "B", {
			epoch: "epoch-test",
			baseRevision: 7,
		});

		assert.equal(outcome.status, "completed");
		assert.deepEqual(yandexClient.moves, [
			{
				fromPath: "remote/A/deep/note.md",
				toPath: "remote/B/deep/note.md",
			},
		]);
		assert.equal(indexManager.index.files["A/deep/note.md"]?.deleted, true);
		assert.equal(indexManager.index.files["B/deep/note.md"]?.deleted, false);
		assert.equal(
			indexManager.index.files["B/deep/note.md"]?.mutationSeq,
			2,
		);
		assert.deepEqual(indexManager.index.moves, {});
		assert.equal(indexManager.pendingActions.length, 0);
		assert.equal(indexManager.pendingMutations.length, 0);
		assert.equal(indexManager.commits.length, 2);
	});
}

test("restored folder source is never deleted without a target snapshot", async () => {
	const indexManager = new FolderDeleteIndexFake();
	indexManager.index.files = {
		"A/note.md": {
			...metadata("A/note.md", {
				fingerprint: "source-fingerprint",
				changedRevision: 7,
			}),
			lastModifiedBy: "device-test",
			mutationSeq: 1,
		},
	};
	indexManager.local.files = structuredClone(indexManager.index.files);
	indexManager.beforeCanonicalRead = () => {
		indexManager.index.files["A/note.md"] = {
			...metadata("A/note.md", {
				fingerprint: "restored-fingerprint",
				changedRevision: 9,
			}),
			lastModifiedBy: "device-test",
			mutationSeq: 3,
		};
	};
	const yandexClient = new FolderDeleteYandexFake();
	yandexClient.resources.clear();
	yandexClient.resources.set("remote/A/note.md", {
		sha256: "restored-fingerprint",
	});
	const engine = new SyncEngine(
		yandexClient as unknown as YandexDiskClient,
		{
			fileExists: () => false,
			getFileMtime: () => 1,
		} as unknown as VaultAdapter,
		indexManager as unknown as IndexManager,
		{
			...DEFAULT_SETTINGS,
			deviceId: "device-test",
			remotePath: "remote",
		},
	);

	const outcome = await engine.renameFolder("A", "B", {
		epoch: "epoch-test",
		baseRevision: 7,
	});

	assert.equal(outcome.status, "retry");
	assert.equal(yandexClient.resources.has("remote/A/note.md"), true);
	assert.equal(yandexClient.resources.has("remote/B/note.md"), false);
	assert.equal(yandexClient.moves.length, 0);
	assert.equal(Object.keys(indexManager.index.moves).length, 1);
});

test("folder target conflict performs no canonical or physical writes", async () => {
	const indexManager = new FolderDeleteIndexFake();
	indexManager.index.files = {
		"A/note.md": {
			...metadata("A/note.md", { changedRevision: 7 }),
			lastModifiedBy: "device-test",
			mutationSeq: 1,
		},
		"B/note.md": {
			...metadata("B/note.md", { changedRevision: 7 }),
			sha256: "different-target",
			lastModifiedBy: "other-device",
			mutationSeq: 1,
		},
	};
	indexManager.local.files = {
		"A/note.md": structuredClone(indexManager.index.files["A/note.md"]!),
	};
	const yandexClient = new FolderDeleteYandexFake();
	yandexClient.resources.clear();
	yandexClient.resources.set("remote/A/note.md", { sha256: "hash" });
	yandexClient.resources.set("remote/B/note.md", { sha256: "different-target" });
	const engine = new SyncEngine(
		yandexClient as unknown as YandexDiskClient,
		{} as VaultAdapter,
		indexManager as unknown as IndexManager,
		{
			...DEFAULT_SETTINGS,
			deviceId: "device-test",
			remotePath: "remote",
		},
	);

	const before = structuredClone(indexManager.index);
	const outcome = await engine.renameFolder("A", "B", {
		epoch: "epoch-test",
		baseRevision: 7,
	});

	assert.equal(outcome.status, "retry");
	assert.equal(outcome.reason, "folder-target-conflict");
	assert.equal(outcome.requiresUserAction, true);
	assert.deepEqual(indexManager.index, before);
	assert.deepEqual(indexManager.commits, []);
	assert.deepEqual(yandexClient.moves, []);
	assert.deepEqual(yandexClient.deletes, []);
	assert.equal(indexManager.pendingMutations.length, 1);
});

test("missing expected fingerprint defers remote deletion", async () => {
	const indexManager = new FolderDeleteIndexFake();
	indexManager.pendingActions.push({
		id: "legacy-action",
		type: "delete-remote",
		epoch: indexManager.index.epoch,
		origin: "folder-delete",
		path: "folder/Без названия.md",
		canonicalRevision: 8,
		createdAt: 1,
	});
	const yandexClient = new FolderDeleteYandexFake();
	yandexClient.resources.set("remote/folder/Без названия.md", {
		sha256: "new-fingerprint",
	});
	const engine = new SyncEngine(
		yandexClient as unknown as YandexDiskClient,
		{} as VaultAdapter,
		indexManager as unknown as IndexManager,
		{
			...DEFAULT_SETTINGS,
			deviceId: "device-test",
			remotePath: "remote",
		},
	);

	await engine.deleteRemoteFile("folder/Без названия.md");

	assert.deepEqual(yandexClient.deletes, []);
	assert.equal(indexManager.pendingActions.length, 1);
});

test("changed physical fingerprint defers remote deletion", async () => {
	const indexManager = new FolderDeleteIndexFake();
	indexManager.pendingActions.push({
		id: "changed-action",
		type: "delete-remote",
		epoch: indexManager.index.epoch,
		origin: "folder-delete",
		path: "folder/Без названия.md",
		canonicalRevision: 8,
		expectedFingerprint: "old-fingerprint",
		createdAt: 1,
	});
	const yandexClient = new FolderDeleteYandexFake();
	yandexClient.resources.set("remote/folder/Без названия.md", {
		sha256: "new-fingerprint",
	});
	const engine = new SyncEngine(
		yandexClient as unknown as YandexDiskClient,
		{} as VaultAdapter,
		indexManager as unknown as IndexManager,
		{
			...DEFAULT_SETTINGS,
			deviceId: "device-test",
			remotePath: "remote",
		},
	);

	await engine.deleteRemoteFile("folder/Без названия.md");

	assert.deepEqual(yandexClient.deletes, []);
	assert.equal(indexManager.pendingActions.length, 1);
});

test("newer live canonical state cancels a legacy folder action", async () => {
	const indexManager = new FolderDeleteIndexFake();
	indexManager.index.files["folder/Без названия.md"] = metadata(
		"folder/Без названия.md",
		{ fingerprint: "new-fingerprint", changedRevision: 9 },
	);
	indexManager.pendingActions.push({
		id: "obsolete-action",
		type: "delete-remote",
		epoch: indexManager.index.epoch,
		origin: "folder-delete",
		path: "folder/Без названия.md",
		canonicalRevision: 8,
		expectedFingerprint: "old-fingerprint",
		createdAt: 1,
	});
	const yandexClient = new FolderDeleteYandexFake();
	yandexClient.resources.set("remote/folder/Без названия.md", {
		sha256: "new-fingerprint",
	});
	const engine = new SyncEngine(
		yandexClient as unknown as YandexDiskClient,
		{} as VaultAdapter,
		indexManager as unknown as IndexManager,
		{
			...DEFAULT_SETTINGS,
			deviceId: "device-test",
			remotePath: "remote",
		},
	);

	await engine.deleteRemoteFile("folder/Без названия.md");

	assert.deepEqual(yandexClient.deletes, []);
	assert.equal(indexManager.pendingActions.length, 0);
});

test("absent physical file completes a legacy action without delete", async () => {
	const indexManager = new FolderDeleteIndexFake();
	indexManager.pendingActions.push({
		id: "legacy-action",
		type: "delete-remote",
		epoch: indexManager.index.epoch,
		origin: "folder-delete",
		path: "folder/Без названия.md",
		canonicalRevision: 8,
		createdAt: 1,
	});
	const yandexClient = new FolderDeleteYandexFake();
	const engine = new SyncEngine(
		yandexClient as unknown as YandexDiskClient,
		{} as VaultAdapter,
		indexManager as unknown as IndexManager,
		{
			...DEFAULT_SETTINGS,
			deviceId: "device-test",
			remotePath: "remote",
		},
	);

	await engine.deleteRemoteFile("folder/Без названия.md");

	assert.deepEqual(yandexClient.deletes, []);
	assert.equal(indexManager.pendingActions.length, 0);
});
