import assert from "node:assert/strict";
import test from "node:test";
import type { App, DataAdapter, Stat } from "obsidian";
import { VaultAdapter } from "../src/api/vault-adapter";
import type { YandexDiskClient } from "../src/api/yandex-client";
import { SyncEngine } from "../src/sync/sync-engine";
import type { IndexManager } from "../src/sync/index-manager";
import { DEFAULT_SETTINGS } from "../src/types";
import { logger } from "../src/utils/logger";

logger.configure({ consoleEnabled: false, fileEnabled: false });

const TEST_CONFIG_DIR = ".config-hidden-test";
const TEST_BACKUP_DIR =
	`${TEST_CONFIG_DIR}/plugins/yandex-disk-sync/overwritten`;

class FakeHiddenDataAdapter {
	readonly files = new Map<string, ArrayBuffer>();
	readonly directories = new Set<string>([TEST_CONFIG_DIR]);
	readonly systemTrash: string[] = [];
	localTrashCalls = 0;
	failWrite = false;
	failStatVerification = false;
	systemTrashAvailable = true;
	raceDirectory: string | null = null;
	private raced = false;

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.directories.has(path);
	}

	async mkdir(path: string): Promise<void> {
		if (path === this.raceDirectory && !this.raced) {
			this.raced = true;
			this.directories.add(path);
			throw new Error("Folder already exists.");
		}
		if (this.directories.has(path)) {
			throw new Error("Folder already exists.");
		}
		this.directories.add(path);
	}

	async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
		if (this.failWrite) throw new Error("write failed");
		this.files.set(path, content.slice(0));
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const content = this.files.get(path);
		if (!content) throw new Error(`Missing file: ${path}`);
		return content.slice(0);
	}

	async stat(path: string): Promise<Stat | null> {
		const content = this.files.get(path);
		if (content) {
			return {
				type: "file",
				ctime: Date.now(),
				mtime: Date.now(),
				size:
					content.byteLength +
					(this.failStatVerification ? 1 : 0),
			};
		}
		if (this.directories.has(path)) {
			return {
				type: "folder",
				ctime: Date.now(),
				mtime: Date.now(),
				size: 0,
			};
		}
		return null;
	}

	async list(path: string): Promise<{
		files: string[];
		folders: string[];
	}> {
		const prefix = `${path}/`;
		return {
			files: [...this.files.keys()].filter((file) =>
				file.startsWith(prefix),
			),
			folders: [...this.directories].filter((folder) =>
				folder.startsWith(prefix),
			),
		};
	}

	async trashSystem(path: string): Promise<boolean> {
		if (!this.systemTrashAvailable) return false;
		this.systemTrash.push(path);
		this.files.delete(path);
		return true;
	}

	async trashLocal(): Promise<void> {
		this.localTrashCalls++;
	}

	seedFile(path: string, content: ArrayBuffer): void {
		this.files.set(path, content.slice(0));
	}
}

function createVaultAdapter(
	dataAdapter = new FakeHiddenDataAdapter(),
): {
	dataAdapter: FakeHiddenDataAdapter;
	vaultAdapter: VaultAdapter;
} {
	const app = {
		vault: {
			configDir: TEST_CONFIG_DIR,
			adapter: dataAdapter as unknown as DataAdapter,
			getAbstractFileByPath: () => null,
		},
	} as unknown as App;
	return {
		dataAdapter,
		vaultAdapter: new VaultAdapter(app, {
			...DEFAULT_SETTINGS,
			deviceId: "device-backup-test",
		}),
	};
}

test("hidden plugin backup uses DataAdapter and preserves exact bytes", async () => {
	const { dataAdapter, vaultAdapter } = createVaultAdapter();
	const content = new Uint8Array([0, 1, 2, 253, 254, 255]).buffer;

	const firstPath = await vaultAdapter.backupOverwrittenFile(
		"deep/note.md",
		content,
	);
	const secondPath = await vaultAdapter.backupOverwrittenFile(
		"deep/note.md",
		content,
	);

	assert.notEqual(firstPath, secondPath);
	assert.match(
		firstPath,
		new RegExp(`^${TEST_BACKUP_DIR}/`),
	);
	assert.deepEqual(
		new Uint8Array(await dataAdapter.readBinary(firstPath)),
		new Uint8Array(content),
	);
	assert.deepEqual(
		new Uint8Array(await dataAdapter.readBinary(secondPath)),
		new Uint8Array(content),
	);
});

test("backup directory creation tolerates a concurrent mkdir", async () => {
	const dataAdapter = new FakeHiddenDataAdapter();
	dataAdapter.raceDirectory = TEST_BACKUP_DIR;
	const { vaultAdapter } = createVaultAdapter(dataAdapter);

	const path = await vaultAdapter.backupOverwrittenFile(
		"note.md",
		new Uint8Array([1]).buffer,
	);

	assert.equal(await dataAdapter.exists(path), true);
});

test("backup rejects failed writes and failed verification", async () => {
	const writeFailure = new FakeHiddenDataAdapter();
	writeFailure.failWrite = true;
	await assert.rejects(
		createVaultAdapter(writeFailure).vaultAdapter.backupOverwrittenFile(
			"note.md",
			new Uint8Array([1]).buffer,
		),
		/write failed/,
	);

	const verificationFailure = new FakeHiddenDataAdapter();
	verificationFailure.failStatVerification = true;
	await assert.rejects(
		createVaultAdapter(
			verificationFailure,
		).vaultAdapter.backupOverwrittenFile(
			"note.md",
			new Uint8Array([1]).buffer,
		),
		/could not be verified/,
	);
});

test("backup cleanup uses system trash and never local vault trash", async () => {
	const dataAdapter = new FakeHiddenDataAdapter();
	const backupDir = TEST_BACKUP_DIR;
	dataAdapter.directories.add(`${TEST_CONFIG_DIR}/plugins`);
	dataAdapter.directories.add(
		`${TEST_CONFIG_DIR}/plugins/yandex-disk-sync`,
	);
	dataAdapter.directories.add(backupDir);
	const oldPath = `${backupDir}/old`;
	dataAdapter.seedFile(oldPath, new Uint8Array([1]).buffer);
	const originalStat = dataAdapter.stat.bind(dataAdapter);
	dataAdapter.stat = async (path: string): Promise<Stat | null> => {
		const stat = await originalStat(path);
		return stat && path === oldPath
			? { ...stat, mtime: 0 }
			: stat;
	};
	const { vaultAdapter } = createVaultAdapter(dataAdapter);

	assert.equal(await vaultAdapter.cleanupOldBackups(30), 1);
	assert.deepEqual(dataAdapter.systemTrash, [oldPath]);
	assert.equal(dataAdapter.localTrashCalls, 0);
});

test("unavailable system trash preserves stale backup", async () => {
	const dataAdapter = new FakeHiddenDataAdapter();
	const backupDir = TEST_BACKUP_DIR;
	dataAdapter.directories.add(backupDir);
	const oldPath = `${backupDir}/old`;
	dataAdapter.seedFile(oldPath, new Uint8Array([1]).buffer);
	dataAdapter.systemTrashAvailable = false;
	const originalStat = dataAdapter.stat.bind(dataAdapter);
	dataAdapter.stat = async (path: string): Promise<Stat | null> => {
		const stat = await originalStat(path);
		return stat && path === oldPath
			? { ...stat, mtime: 0 }
			: stat;
	};
	const { vaultAdapter } = createVaultAdapter(dataAdapter);

	assert.equal(await vaultAdapter.cleanupOldBackups(30), 0);
	assert.equal(await dataAdapter.exists(oldPath), true);
	assert.equal(dataAdapter.localTrashCalls, 0);
});

test("failed mandatory backup prevents a local overwrite", async () => {
	const remoteContent = new TextEncoder().encode("remote").buffer;
	const localContent = new TextEncoder().encode("local").buffer;
	let writeCalled = false;
	const vaultAdapter = {
		fileExists: () => true,
		readFile: async () => localContent,
		backupOverwrittenFile: async () => {
			throw new Error("backup unavailable");
		},
		writeFile: async () => {
			writeCalled = true;
		},
	};
	const indexManager = {
		getLocalIndex: () => ({
			files: {
				"note.md": {
					path: "note.md",
					sha256: "different-baseline",
				},
			},
		}),
	};
	const yandexClient = {
		downloadFile: async () => remoteContent,
	};
	const engine = new SyncEngine(
		yandexClient as unknown as YandexDiskClient,
		vaultAdapter as unknown as VaultAdapter,
		indexManager as unknown as IndexManager,
		{
			...DEFAULT_SETTINGS,
			deviceId: "device-backup-test",
			remotePath: "vault",
		},
	);

	await assert.rejects(
		engine.downloadFile("note.md"),
		/backup unavailable/,
	);
	assert.equal(writeCalled, false);
});
