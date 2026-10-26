import { EncryptionService, SALT_LENGTH } from "../src/crypto/encryption";
import assert from "node:assert/strict";
import test from "node:test";
import type { App, DataAdapter, Stat } from "obsidian";
import { VaultAdapter } from "../src/api/vault-adapter";
import type { YandexDiskClient } from "../src/api/yandex-client";
import { SyncEngine } from "../src/sync/engine";
import type { IndexManager } from "../src/sync/canonical/manager";
import { DEFAULT_SETTINGS } from "../src/types";
import { logger } from "../src/utils/logger";

logger.configure({ consoleEnabled: false, fileEnabled: false });

const TEST_CONFIG_DIR = ".config-hidden-test";
const TEST_BACKUP_DIR = `${TEST_CONFIG_DIR}/plugins/yandex-disk-sync/overwritten`;

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
		if (this.failWrite) {
			throw new Error("write failed");
		}
		this.files.set(path, content.slice(0));
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const content = this.files.get(path);
		if (!content) {
			throw new Error(`Missing file: ${path}`);
		}
		return content.slice(0);
	}

	async stat(path: string): Promise<Stat | null> {
		const content = this.files.get(path);
		if (!content && !this.directories.has(path)) {
			return null;
		}
		return {
			type: content ? "file" : "folder",
			ctime: Date.now(),
			mtime: Date.now(),
			size: content
				? content.byteLength + (this.failStatVerification ? 1 : 0)
				: 0,
		};
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
		if (!this.systemTrashAvailable) {
			return false;
		}
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

function createVaultAdapter(dataAdapter = new FakeHiddenDataAdapter()) {
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
	assert.match(firstPath, new RegExp(`^${TEST_BACKUP_DIR}/`));
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
	for (const [flag, error] of [
		["failWrite", /write failed/],
		["failStatVerification", /could not be verified/],
	] as const) {
		const data = Object.assign(new FakeHiddenDataAdapter(), {
			[flag]: true,
		});
		await assert.rejects(
			createVaultAdapter(data).vaultAdapter.backupOverwrittenFile(
				"note.md",
				new Uint8Array([1]).buffer,
			),
			error,
		);
	}
});

test("backup cleanup uses system trash and never local vault trash", async () => {
	const dataAdapter = new FakeHiddenDataAdapter();
	const backupDir = TEST_BACKUP_DIR;
	dataAdapter.directories.add(`${TEST_CONFIG_DIR}/plugins`);
	dataAdapter.directories.add(`${TEST_CONFIG_DIR}/plugins/yandex-disk-sync`);
	dataAdapter.directories.add(backupDir);
	const oldPath = `${backupDir}/old`;
	dataAdapter.seedFile(oldPath, new Uint8Array([1]).buffer);
	const originalStat = dataAdapter.stat.bind(dataAdapter);
	dataAdapter.stat = async (path: string): Promise<Stat | null> => {
		const stat = await originalStat(path);
		return stat && path === oldPath ? { ...stat, mtime: 0 } : stat;
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
		return stat && path === oldPath ? { ...stat, mtime: 0 } : stat;
	};
	const { vaultAdapter } = createVaultAdapter(dataAdapter);

	assert.equal(await vaultAdapter.cleanupOldBackups(30), 0);
	assert.equal(await dataAdapter.exists(oldPath), true);
	assert.equal(dataAdapter.localTrashCalls, 0);
	let stopped = false;
	dataAdapter.systemTrashAvailable = true;
	dataAdapter.stat = async (path: string): Promise<Stat | null> => {
		const stat = await originalStat(path);
		stopped = true;
		return stat ? { ...stat, mtime: 0 } : stat;
	};
	await assert.rejects(
		vaultAdapter.cleanupOldBackups(30, () => {
			if (stopped) {
				throw new Error("Stopped maintenance");
			}
		}),
		/Stopped maintenance/,
	);
	assert.equal(await dataAdapter.exists(oldPath), true);
	assert.deepEqual(dataAdapter.systemTrash, []);
});

function downloadEngine(
	vault: Partial<Omit<VaultAdapter, "backupOverwrittenFile">> & {
		backupOverwrittenFile(): Promise<unknown>;
	},
	downloadFile: () => Promise<ArrayBuffer>,
	files: Record<string, { sha256: string }> = {},
) {
	return new SyncEngine(
		{ downloadFile } as unknown as YandexDiskClient,
		vault as unknown as VaultAdapter,
		{
			assertRemoteScope: async () => {},
			getLocalIndex: () => ({ files }),
		} as unknown as IndexManager,
		{ ...DEFAULT_SETTINGS, remotePath: "vault" },
	);
}

test("failed mandatory backup prevents a local overwrite", async () => {
	let written = false;
	const engine = downloadEngine(
		{
			fileExists: () => true,
			readFile: async () => new TextEncoder().encode("local").buffer,
			backupOverwrittenFile: async () => {
				throw new Error("backup unavailable");
			},
			writeFile: async () => {
				written = true;
			},
		},
		async () => new TextEncoder().encode("remote").buffer,
		{ "note.md": { sha256: "different-baseline" } },
	);
	await assert.rejects(engine.downloadFile("note.md"), /backup unavailable/);
	assert.equal(written, false);
});

test("download preserves local changes during remote I/O and protective backup", async () => {
	const encode = (value: string) => new TextEncoder().encode(value).buffer;
	const codec = new EncryptionService(new Uint8Array(SALT_LENGTH).fill(21));
	await codec.initializeKey("synthetic-download-password");
	for (const service of [null, codec]) {
		for (const timing of ["create", "edit", "backup"] as const) {
			let local = timing === "create" ? null : encode("old local");
			const remote = encode("remote");
			const stored = service ? await service.encrypt(remote) : remote;
			const vault = {
				fileExists: () => local !== null,
				readFile: async () => local!,
				writeFile: async () => {
					assert.fail("stale download wrote local bytes");
				},
				backupOverwrittenFile: async () => {
					local = encode("late edit");
				},
			};
			const engine = downloadEngine(
				vault,
				async () => {
					if (timing !== "backup") {
						local = encode("late edit");
					}
					return service ? await service.decrypt(stored) : stored;
				},
				timing === "backup"
					? { "note.md": { sha256: "baseline" } }
					: {},
			);
			await assert.rejects(
				engine.downloadFile("note.md"),
				/Local file changed/,
			);
			assert.equal(new TextDecoder().decode(local!), "late edit");
			assert.deepEqual(
				service ? await service.decrypt(stored) : stored,
				remote,
			);
			assert.equal(
				engine.consumeInternalWatcherEvent("note.md", "upload"),
				false,
			);
		}
	}
});
