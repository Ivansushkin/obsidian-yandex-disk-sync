import assert from "node:assert/strict";
import test from "node:test";
import {
	BackupManager,
	BackupPasswordRequiredError,
} from "../src/backup/backup-manager";
import { isBackupEnvelope } from "../src/backup/backup-envelope";
import {
	YandexApiError,
	type YandexDiskClient,
} from "../src/api/yandex-client";
import type { VaultAdapter } from "../src/api/vault-adapter";
import type {
	YandexDiskSyncSettings,
	YandexResource,
} from "../src/types";
import { DEFAULT_SETTINGS } from "../src/types";
import { UnsupportedHistoricalDataError } from "../src/compatibility-errors";

class FakeBackupClient {
	files = new Map<string, ArrayBuffer>();
	uploadedPaths: string[] = [];
	storeThenTimeout = false;
	corruptFirstUpload = false;
	conflictFirstUpload = false;
	encrypted = true;
	decodeCalls = 0;
	downloadedPaths: string[] = [];
	decoder: ((content: ArrayBuffer) => Promise<ArrayBuffer>) | null = null;
	resources: YandexResource[] = [];

	hasEncryptionService(): boolean {
		return this.encrypted;
	}

	async uploadFileExclusive(
		path: string,
		content: ArrayBuffer,
	): Promise<void> {
		this.uploadedPaths.push(path);
		if (this.conflictFirstUpload && this.uploadedPaths.length === 1) {
			this.files.set(path, new Uint8Array([9, 9, 9]).buffer);
			throw new YandexApiError("name collision", 409);
		}
		const stored =
			this.corruptFirstUpload && this.uploadedPaths.length === 1
				? new Uint8Array([1, 2, 3]).buffer
				: content.slice(0);
		this.files.set(path, stored);
		if (this.storeThenTimeout) {
			this.storeThenTimeout = false;
			throw new Error("response lost after commit");
		}
	}

	async downloadStableRawFile(path: string): Promise<{
		raw: ArrayBuffer;
		fingerprint: string;
	} | null> {
		const raw = this.files.get(path);
		return raw ? { raw: raw.slice(0), fingerprint: `sha256:${raw.byteLength}` } : null;
	}

	async downloadFile(path: string): Promise<ArrayBuffer> {
		this.downloadedPaths.push(path);
		const value = this.files.get(path);
		if (!value) throw new Error("missing backup");
		return value.slice(0);
	}

	async decodeServiceFileContent(content: ArrayBuffer): Promise<ArrayBuffer> {
		this.decodeCalls++;
		return this.decoder ? await this.decoder(content) : content.slice(0);
	}

	async getResourcesRecursive(): Promise<YandexResource[]> {
		return this.resources.map((resource) => ({ ...resource }));
	}

}

function createManager(
	client: FakeBackupClient,
	readFile: () => Promise<ArrayBuffer> = async () =>
		new TextEncoder().encode("note").buffer,
): {
	manager: BackupManager;
	settings: YandexDiskSyncSettings;
} {
	const settings: YandexDiskSyncSettings = {
		...DEFAULT_SETTINGS,
		remotePath: "vault",
		enableEncryption: true,
		encryptionPassword: "backup-password",
		encryptionSalt: "unused",
		encryptionRevision: 1,
		encryptionProfileId: "hardened",
	};
	const vault = {
		getAllSyncableFiles: () => [{ path: "note.md" }],
		readFile,
	} as unknown as VaultAdapter;
	return {
		manager: new BackupManager(
			client as unknown as YandexDiskClient,
			vault,
			settings,
			"2.0.0",
		),
		settings,
	};
}

test("both Force backup directions report upload and readback before returning verified success", async () => {
	for (const remote of [false, true]) {
		const client = new FakeBackupClient();
		client.encrypted = false;
		const { manager } = createManager(client, async () => new TextEncoder().encode("content").buffer);
		const phases: string[] = [];
		const upload = client.uploadFileExclusive.bind(client);
		client.uploadFileExclusive = async (path, bytes) => {
			assert.equal(phases[phases.length - 1], "uploading-backup");
			await upload(path, bytes);
		};
		const read = client.downloadStableRawFile.bind(client);
		client.downloadStableRawFile = async (path) => {
			assert.equal(phases[phases.length - 1], "verifying-backup");
			return await read(path);
		};
		const result = remote
			? await manager.createRemoteSnapshotBackup(undefined, (phase) => phases.push(phase))
			: await manager.createBackup(undefined, (phase) => phases.push(phase));
		assert.equal(result.success, true);
		assert.ok(result.sha256);
		assert.deepEqual(phases, ["creating-backup", "uploading-backup", "verifying-backup"]);
	}
});

test("Force backup proof binds the exact logical and remote snapshots", async () => {
	const client = new FakeBackupClient();
	let localContent = "local-a";
	const { manager } = createManager(
		client,
		async () => new TextEncoder().encode(localContent).buffer,
	);
	const firstLocal = await manager.createBackup();
	localContent = "local-b";
	const secondLocal = await manager.createBackup();
	assert.ok(firstLocal.snapshotDigest);
	assert.notEqual(firstLocal.snapshotDigest, secondLocal.snapshotDigest);

	const remotePath = "disk:/vault/remote.md";
	client.resources = [
		{
			name: "remote.md",
			path: remotePath,
			type: "file",
			created: "2026-08-20T10:00:00Z",
			modified: "2026-08-20T10:00:00Z",
			size: 8,
		},
	];
	client.files.set(remotePath, new TextEncoder().encode("remote-a").buffer);
	const firstRemote = await manager.createRemoteSnapshotBackup();
	client.files.set(remotePath, new TextEncoder().encode("remote-b").buffer);
	const secondRemote = await manager.createRemoteSnapshotBackup();
	assert.ok(firstRemote.snapshotDigest);
	assert.notEqual(firstRemote.snapshotDigest, secondRemote.snapshotDigest);
});

test("remote snapshot backup rejects legacy plugin data before download", async () => {
	const client = new FakeBackupClient();
	const exposedPath =
		"disk:/vault/vault-config/plugins/yandex-disk-sync/data.json";
	client.resources = [
		{
			name: "data.json",
			path: exposedPath,
			type: "file",
			created: "2026-08-20T10:00:00Z",
			modified: "2026-08-20T10:00:00Z",
			size: 8,
		},
	];
	client.files.set(exposedPath, new TextEncoder().encode("do-not-read").buffer);
	const { manager } = createManager(client);

	const result = await manager.createRemoteSnapshotBackup();
	assert.equal(result.success, false);
	assert.deepEqual(client.downloadedPaths, []);
	assert.deepEqual(client.uploadedPaths, []);
});

test("verified backup accepts an upload whose response was lost", async () => {
	const client = new FakeBackupClient();
	client.storeThenTimeout = true;
	const { manager } = createManager(client);
	const result = await manager.createBackup();
	assert.equal(result.success, true);
	assert.equal(client.uploadedPaths.length, 1);
	assert.ok(result.backupName?.endsWith(".enc.zip"));
	assert.equal(
		isBackupEnvelope(client.files.get(client.uploadedPaths[0]!)!),
		true,
	);
});

test("byte mismatch never overwrites and retries with a unique name", async () => {
	const client = new FakeBackupClient();
	client.corruptFirstUpload = true;
	const { manager } = createManager(client);
	const result = await manager.createBackup();
	assert.equal(result.success, true);
	assert.equal(client.uploadedPaths.length, 2);
	assert.notEqual(client.uploadedPaths[0], client.uploadedPaths[1]);
	assert.deepEqual(
		new Uint8Array(client.files.get(client.uploadedPaths[0]!)!),
		new Uint8Array([1, 2, 3]),
	);
});

test("exclusive 409 collision is read back and retried under a new name", async () => {
	const client = new FakeBackupClient();
	client.conflictFirstUpload = true;
	const { manager } = createManager(client);
	const result = await manager.createBackup();
	assert.equal(result.success, true);
	assert.equal(client.uploadedPaths.length, 2);
	assert.notEqual(client.uploadedPaths[0], client.uploadedPaths[1]);
	assert.deepEqual(
		new Uint8Array(client.files.get(client.uploadedPaths[0]!)!),
		new Uint8Array([9, 9, 9]),
	);
});

test("self-contained backup opens with its own password after vault state changes", async () => {
	const client = new FakeBackupClient();
	const { manager, settings } = createManager(client);
	const result = await manager.createBackup();
	assert.equal(result.success, true);
	const path = `vault/.backup/${result.backupName}`;
	settings.encryptionPassword = "new-vault-password";
	await assert.rejects(
		manager.downloadBackup(path),
		BackupPasswordRequiredError,
	);
	const zip = await manager.downloadBackup(path, "backup-password");
	assert.equal(new Uint8Array(zip).slice(0, 2).toString(), "80,75");
});

test("invalid envelope header is reported as corruption, not a password prompt", async () => {
	const client = new FakeBackupClient();
	const { manager } = createManager(client);
	const invalid = new Uint8Array(12);
	invalid.set(new TextEncoder().encode("OYDSBKP!"));
	new DataView(invalid.buffer).setUint32(8, 16 * 1024 + 1, false);
	client.files.set("vault/.backup/corrupt.enc.zip", invalid.buffer);
	await assert.rejects(
		manager.downloadBackup("vault/.backup/corrupt.enc.zip", "password"),
		(error: unknown) =>
			error instanceof Error &&
			!(error instanceof BackupPasswordRequiredError) &&
			/header length/.test(error.message),
	);
});

test("numbered historical envelope is rejected without invoking decryption", async () => {
	const client = new FakeBackupClient();
	client.files.set(
		"vault/.backup/backup_2026-08-20_10-00-00.enc.zip",
		new TextEncoder().encode("OYDSBKP2historical-envelope").buffer,
	);
	const { manager } = createManager(client);
	await assert.rejects(
		manager.downloadBackup(
			"vault/.backup/backup_2026-08-20_10-00-00.enc.zip",
		),
		UnsupportedHistoricalDataError,
	);
	assert.equal(client.decodeCalls, 0);
});

test("encrypted legacy backup names are ignored without compatibility decoding", async () => {
	const client = new FakeBackupClient();
	const physicalName = "unrecognized-encrypted-name";
	client.resources = [
		{
			name: physicalName,
			path: `disk:/vault/.backup/${physicalName}`,
			type: "file",
			created: "2026-08-20T10:00:00Z",
			modified: "2026-08-20T10:00:00Z",
			size: 100,
		},
	];
	const { manager } = createManager(client);
	const backups = await manager.listBackups();
	assert.deepEqual(backups, []);
});

test("historical plaintext zip is returned without codec fallback", async () => {
	const client = new FakeBackupClient();
	const zip = new TextEncoder().encode("PK\u0003\u0004 plaintext ZIP").buffer;
	client.files.set("vault/.backup/backup_2026-08-20_10-00-00.zip", zip);
	const { manager } = createManager(client);
	assert.deepEqual(
		new Uint8Array(
			await manager.downloadBackup(
				"vault/.backup/backup_2026-08-20_10-00-00.zip",
			),
		),
		new Uint8Array(zip),
	);
	assert.equal(client.decodeCalls, 0);
});

test("unknown historical zip bytes fail closed without decryption fallback", async () => {
	const client = new FakeBackupClient();
	client.files.set(
		"vault/.backup/backup_2026-08-20_10-00-00.zip",
		new Uint8Array([1, 2, 3, 4]).buffer,
	);
	const { manager } = createManager(client);
	await assert.rejects(
		manager.downloadBackup(
			"vault/.backup/backup_2026-08-20_10-00-00.zip",
		),
		UnsupportedHistoricalDataError,
	);
	assert.equal(client.decodeCalls, 0);
});
