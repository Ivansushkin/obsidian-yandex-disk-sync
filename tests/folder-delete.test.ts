import assert from "node:assert/strict";
import test from "node:test";
import type { VaultAdapter } from "../src/api/vault-adapter";
import type { YandexDiskClient } from "../src/api/yandex-client";
import { SyncEngine } from "../src/sync/engine";
import { DEFAULT_SETTINGS, type FileMetadata } from "../src/types";
import { fileMetadata, MemoryIndex } from "./helpers/realtime-fixtures";

function metadata(
	path: string,
	options?: {
		deleted?: boolean;
		fingerprint?: string;
		changedRevision?: number;
		lastModifiedBy?: string;
		mutationSeq?: number;
	},
): FileMetadata {
	return fileMetadata(path, `sha:${path}`, {
		deleted: options?.deleted,
		remoteFingerprint: options?.fingerprint,
		changedRevision: options?.changedRevision,
		lastModifiedBy: options?.lastModifiedBy ?? "device-test",
		mutationSeq: options?.mutationSeq ?? 1,
	});
}

/**
 * Minimal causal index used to exercise the folder-delete orchestration.
 */
class FolderDeleteIndexFake extends MemoryIndex {
	constructor() {
		super("device-test", "epoch-test");
		this.index.appliedMutationSeq["device-test"] = 1;
		this.store.loadMutations(undefined, 2);
		this.index.revision = 7;
		this.index.files["folder/Без названия.md"] = metadata(
			"folder/Без названия.md",
			{ deleted: true, changedRevision: 6 },
		);
		this.index.files["folder/Чо как.md"] = metadata("folder/Чо как.md", {
			fingerprint: "live-fingerprint",
			changedRevision: 7,
		});
		this.local.files = structuredClone(this.index.files);
	}
	get pendingActions() {
		return this.getPendingPhysicalActions();
	}

	get pendingMutations() {
		return this.getPendingMutations();
	}

	override async refreshCanonicalForMutation() {
		return structuredClone(this.index);
	}

	async saveRemoteIndex() {
		await super.saveRemoteIndex();
		for (const current of Object.values(this.index.files)) {
			if (current.deleted && current.deletedByFolder === "folder") {
				current.changedRevision = this.index.revision;
			}
		}
		const tombstone = this.index.folderTombstones.folder;
		if (tombstone) {
			tombstone.changedRevision = this.index.revision;
		}
		for (const move of Object.values(this.index.moves)) {
			move.changedRevision = this.index.revision;
		}
		return {
			epoch: this.index.epoch,
			revision: this.index.revision,
			index: structuredClone(this.index),
			contentFingerprint: "md5:test",
		};
	}
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
		if (!resource) {
			throw new Error("missing source");
		}
		if (this.resources.has(toPath)) {
			throw new Error("target exists");
		}
		this.resources.set(toPath, resource);
		this.resources.delete(fromPath);
		this.moves.push({ fromPath, toPath });
	}

	async deleteResource(
		path: string,
		_permanently = false,
		_raw = false,
		beforeAttempt?: () => Promise<void>,
	) {
		await beforeAttempt?.();
		this.deletes.push(path);
		this.resources.delete(path);
	}

	async isFolderEmpty() {
		return true;
	}
}

function createHarness() {
	const indexManager = new FolderDeleteIndexFake();
	const yandexClient = new FolderDeleteYandexFake();
	const engine = new SyncEngine(
		yandexClient as unknown as YandexDiskClient,
		{
			fileExists: () => false,
			getFileMtime: () => 1,
		} as unknown as VaultAdapter,
		indexManager,
		{
			...DEFAULT_SETTINGS,
			deviceId: "device-test",
			remotePath: "remote",
		},
	);
	return { indexManager, yandexClient, engine };
}

test("rename tombstone is skipped by folder delete", async () => {
	const { indexManager, yandexClient, engine } = createHarness();

	await engine.deleteFolder("folder");

	assert.deepEqual(yandexClient.deletes, ["remote/folder/Чо как.md"]);
	assert.equal(indexManager.index.revision, 8);
	assert.equal(indexManager.pendingMutations.length, 0);
	assert.equal(indexManager.pendingActions.length, 0);
	assert.equal(
		indexManager.index.files["folder/Без названия.md"]?.changedRevision,
		6,
	);
	assert.equal(
		indexManager.index.files["folder/Без названия.md"]?.deletedByFolder,
		undefined,
	);
});

test("folder rename uses guarded file moves and two commits", async () => {
	const { indexManager, yandexClient, engine } = createHarness();
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

	yandexClient.resources.clear();
	yandexClient.resources.set("remote/A/deep/note.md", {
		sha256: "source-fingerprint",
	});

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
	assert.equal(indexManager.index.files["B/deep/note.md"]?.mutationSeq, 2);
	assert.deepEqual(indexManager.index.moves, {});
	assert.equal(indexManager.pendingActions.length, 0);
	assert.equal(indexManager.pendingMutations.length, 0);
	assert.equal(indexManager.commits.length, 2);
});

test("restored folder source is never deleted without a target snapshot", async () => {
	const { indexManager, yandexClient, engine } = createHarness();
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

	yandexClient.resources.clear();
	yandexClient.resources.set("remote/A/note.md", {
		sha256: "restored-fingerprint",
	});

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
	const { indexManager, yandexClient, engine } = createHarness();
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

	yandexClient.resources.clear();
	yandexClient.resources.set("remote/A/note.md", { sha256: "hash" });
	yandexClient.resources.set("remote/B/note.md", {
		sha256: "different-target",
	});

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

for (const scenario of [
	{ name: "missing expected fingerprint defers remote deletion", pending: 1 },
	{
		name: "changed physical fingerprint defers remote deletion",
		expectedFingerprint: "old-fingerprint",
		pending: 1,
	},
	{
		name: "newer live canonical state cancels a legacy folder action",
		expectedFingerprint: "old-fingerprint",
		restored: true,
		pending: 0,
	},
	{
		name: "absent physical file completes a legacy action without delete",
		absent: true,
		pending: 0,
	},
]) {
	test(scenario.name, async () => {
		const { indexManager, yandexClient, engine } = createHarness();
		const path = "folder/Без названия.md";
		if (scenario.restored) {
			indexManager.index.files[path] = metadata(path, {
				fingerprint: "new-fingerprint",
				changedRevision: 9,
			});
		}
		indexManager.loadPendingPhysicalActions([
			{
				id: "guarded-action",
				type: "delete-remote",
				epoch: indexManager.index.epoch,
				origin: "folder-delete",
				path,
				canonicalRevision: 8,
				createdAt: 1,
				expectedFingerprint: scenario.expectedFingerprint,
			},
		]);
		if (!scenario.absent) {
			yandexClient.resources.set("remote/" + path, {
				sha256: "new-fingerprint",
			});
		}

		await engine.deleteRemoteFile(path);

		assert.deepEqual(yandexClient.deletes, []);
		assert.equal(indexManager.pendingActions.length, scenario.pending);
	});
}
