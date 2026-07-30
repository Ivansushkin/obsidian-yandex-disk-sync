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

	getPendingPhysicalAction(type: string, path: string) {
		return this.pendingActions.find(
			(action) => action.type === type && action.path === path,
		);
	}

	hasPendingPhysicalAction(type: string, path: string) {
		return this.getPendingPhysicalAction(type, path) !== undefined;
	}

	enqueueMutation(type: PendingMutation["type"], path: string) {
		const mutation: PendingMutation = {
			id: "mutation-1",
			seq: 1,
			epoch: this.index.epoch,
			type,
			baseRevision: this.index.revision,
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
	) {
		this.index.folderTombstones[path] = {
			path,
			deletedAt,
			changedRevision: this.index.revision,
			baseRevision: baseRevision ?? 0,
			lastModifiedBy: "device-test",
		};
	}

	markRemoteFileDeleted(
		path: string,
		deletedByFolder?: string,
		baseRevision?: number,
	) {
		const current = this.index.files[path];
		if (!current || current.deleted) return;
		Object.assign(current, {
			deleted: true,
			deletedAt: 1,
			deletedByFolder,
			baseRevision,
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
		for (const current of Object.values(this.index.files)) {
			if (current.deleted && current.deletedByFolder === "folder") {
				current.changedRevision = this.index.revision;
			}
		}
		const tombstone = this.index.folderTombstones.folder;
		if (tombstone) tombstone.changedRevision = this.index.revision;
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
		return structuredClone(this.index);
	}

	completePhysicalAction(id: string) {
		const index = this.pendingActions.findIndex(
			(action) => action.id === id,
		);
		if (index >= 0) this.pendingActions.splice(index, 1);
	}
}

/**
 * Logical Yandex client fake shared by plaintext and encrypted engine flows.
 */
class FolderDeleteYandexFake {
	readonly resources = new Map<string, { sha256?: string }>();
	readonly deletes: string[] = [];

	constructor() {
		this.resources.set("remote/folder/Чо как.md", {
			sha256: "live-fingerprint",
		});
	}

	async getLogicalResource(path: string) {
		return this.resources.get(path) ?? null;
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
