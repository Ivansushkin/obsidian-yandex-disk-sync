import assert from "node:assert/strict";
import test from "node:test";
import {
	BackupManager,
	BackupPasswordRequiredError,
} from "../src/backup/backup-manager";
import { captureRemoteRawDigest } from "../src/backup/backup-snapshot";
import { isBackupEnvelope } from "../src/backup/backup-envelope";
import {
	YandexApiError,
	type YandexDiskClient,
} from "../src/api/yandex-client";
import type { VaultAdapter } from "../src/api/vault-adapter";
import type { YandexResource } from "../src/types";
import { fileResource } from "./helpers/client-fixtures";
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
		return raw
			? { raw: raw.slice(0), fingerprint: `sha256:${raw.byteLength}` }
			: null;
	}

	async downloadFile(path: string): Promise<ArrayBuffer> {
		this.downloadedPaths.push(path);
		const value = this.files.get(path);
		if (!value) {
			throw new Error("missing backup");
		}
		return value.slice(0);
	}

	async decodeServiceFileContent(content: ArrayBuffer): Promise<ArrayBuffer> {
		this.decodeCalls++;
		return content.slice(0);
	}

	async getResourcesRecursive(): Promise<YandexResource[]> {
		return this.resources.map((resource) => ({ ...resource }));
	}
}

function createManager(
	options: Partial<FakeBackupClient> = {},
	readFile: () => Promise<ArrayBuffer> = async () =>
		new TextEncoder().encode("note").buffer,
) {
	const client = Object.assign(new FakeBackupClient(), options);
	const settings = {
		...DEFAULT_SETTINGS,
		remotePath: "vault",
		enableEncryption: true,
		encryptionPassword: "backup-password",
		encryptionSalt: "unused",
		encryptionRevision: 1,
		encryptionProfileId: "hardened" as const,
	};
	const vault = {
		getAllSyncableFiles: () => [{ path: "note.md" }],
		readFile,
	} as unknown as VaultAdapter;
	return {
		client,
		manager: new BackupManager(
			client as unknown as YandexDiskClient,
			vault,
			settings,
			"2.0.0",
		),
		settings,
	};
}

test("backup retains its destination and encryption password across a settings update", async () => {
	const { client, manager, settings } = createManager({}, async () => {
		manager.updateSettings({
			...settings,
			remotePath: "other",
			encryptionPassword: null,
		});
		client.encrypted = false;
		return new TextEncoder().encode("synthetic note").buffer;
	});
	const result = await manager.createBackup();
	assert.equal(result.success, true);
	assert.equal(client.uploadedPaths.length, 1);
	const path = client.uploadedPaths[0]!;
	assert.ok(path.startsWith("vault/.backup/"));
	assert.equal(isBackupEnvelope(client.files.get(path)!), true);
	for (const encryptionPassword of [null, "new-vault-password"]) {
		manager.updateSettings({
			...settings,
			remotePath: "other",
			encryptionPassword,
		});
		await assert.rejects(
			manager.downloadBackup(path),
			BackupPasswordRequiredError,
		);
	}
	const opened = await manager.downloadBackup(path, "backup-password");
	assert.equal(new Uint8Array(opened)[0], 0x50);
});

test("Force backup proof binds the exact logical and remote snapshots", async () => {
	let localContent = "local-a";
	const { client, manager } = createManager(
		{},
		async () => new TextEncoder().encode(localContent).buffer,
	);
	const firstLocal = await manager.createBackup();
	localContent = "local-b";
	const secondLocal = await manager.createBackup();
	assert.ok(firstLocal.snapshotDigest);
	assert.notEqual(firstLocal.snapshotDigest, secondLocal.snapshotDigest);

	const remotePath = "disk:/vault/remote.md";
	client.resources = [fileResource(remotePath, { size: 8 })];
	client.files.set(remotePath, new TextEncoder().encode("remote-a").buffer);
	const firstRemote = await manager.createRemoteSnapshotBackup();
	client.files.set(remotePath, new TextEncoder().encode("remote-b").buffer);
	const secondRemote = await manager.createRemoteSnapshotBackup();
	assert.ok(firstRemote.snapshotDigest);
	assert.notEqual(firstRemote.snapshotDigest, secondRemote.snapshotDigest);
});

test("remote snapshot backup rejects legacy plugin data before download", async () => {
	const { client, manager } = createManager();
	const exposedPath =
		"disk:/vault/vault-config/plugins/yandex-disk-sync/data.json";
	client.resources = [fileResource(exposedPath, { size: 8 })];
	client.files.set(
		exposedPath,
		new TextEncoder().encode("do-not-read").buffer,
	);

	await assert.rejects(
		captureRemoteRawDigest(client as unknown as YandexDiskClient, "vault"),
		/Remote plugin data must be removed/,
	);
	const result = await manager.createRemoteSnapshotBackup();
	assert.equal(result.success, false);
	assert.deepEqual(client.downloadedPaths, []);
	assert.deepEqual(client.uploadedPaths, []);
});

test("backup verification accepts committed timeouts and retries collisions without overwriting", async () => {
	for (const [label, flag, damaged] of [
		["byte mismatch", "corruptFirstUpload", [1, 2, 3]],
		["exclusive collision", "conflictFirstUpload", [9, 9, 9]],
		["lost response", "storeThenTimeout", null],
	] as const) {
		const { client, manager } = createManager({ [flag]: true });
		assert.equal((await manager.createBackup()).success, true, label);
		assert.equal(client.uploadedPaths.length, damaged ? 2 : 1, label);
		const verifiedPath =
			client.uploadedPaths[client.uploadedPaths.length - 1]!;
		assert.ok(verifiedPath.endsWith(".enc.zip"), label);
		assert.equal(
			isBackupEnvelope(client.files.get(verifiedPath)!),
			true,
			label,
		);
		if (damaged) {
			assert.notEqual(client.uploadedPaths[0], verifiedPath, label);
			assert.deepEqual(
				new Uint8Array(client.files.get(client.uploadedPaths[0]!)!),
				new Uint8Array(damaged),
				label,
			);
		}
	}
});

test("backup formats accept plaintext ZIP and reject corrupt or historical encryption without fallback", async () => {
	const { client, manager } = createManager();
	const invalid = new Uint8Array(12);
	invalid.set(new TextEncoder().encode("OYDSBKP!"));
	new DataView(invalid.buffer).setUint32(8, 16 * 1024 + 1, false);
	const zip = new TextEncoder().encode("PK\u0003\u0004 plaintext ZIP").buffer;
	const historical = new TextEncoder().encode(
		"OYDSBKP2historical-envelope",
	).buffer;
	for (const [label, suffix, content, error] of [
		["plaintext ZIP", ".zip", zip, null],
		["corrupt header", ".enc.zip", invalid.buffer, /header length/],
		[
			"historical envelope",
			".enc.zip",
			historical,
			UnsupportedHistoricalDataError,
		],
		[
			"unknown ZIP bytes",
			".zip",
			new Uint8Array([1, 2, 3, 4]).buffer,
			UnsupportedHistoricalDataError,
		],
	] as const) {
		const path = `vault/.backup/backup_2026-08-20_10-00-00${suffix}`;
		client.files.set(path, content);
		if (error) {
			await assert.rejects(
				manager.downloadBackup(path, "password"),
				error,
				label,
			);
		} else {
			assert.deepEqual(await manager.downloadBackup(path), zip, label);
		}
		assert.equal(client.decodeCalls, 0, label);
	}
	client.resources = [
		fileResource("disk:/vault/.backup/unrecognized-encrypted-name", {
			size: 100,
		}),
	];
	assert.deepEqual(await manager.listBackups(), []);
});

test("optional transition archive retains exact bytes and fails closed on source drift", async () => {
	let content = "source";
	const { client, manager } = createManager(
		{},
		async () => new TextEncoder().encode(content).buffer,
	);
	const canonical = { epoch: "E1", revision: 4 };
	assert.equal(
		await manager.createTransitionBackup(
			"without-backup",
			"target-password",
			canonical,
		),
		null,
	);
	await assert.rejects(
		manager.createTransitionBackup("cancel", "target-password", canonical),
		/explicit backup choice/,
	);
	assert.equal(client.files.size, 0);
	const proof = await manager.createTransitionBackup(
		"with-backup",
		"target-password",
		canonical,
	);
	assert.ok(proof);
	assert.equal(proof.epoch, "E1");
	assert.equal(proof.canonicalRevision, 4);
	const { computeSha256 } = await import("../src/utils/hash-utils");
	assert.equal(
		await computeSha256(client.files.get(proof.path)!),
		proof.sha256,
	);
	const { openBackupEnvelope } =
		await import("../src/backup/backup-envelope");
	await assert.doesNotReject(
		openBackupEnvelope(client.files.get(proof.path)!, "target-password"),
	);
	const read = client.downloadStableRawFile.bind(client);
	client.downloadStableRawFile = async (path) => {
		content = "late change";
		return await read(path);
	};
	await assert.rejects(
		manager.createTransitionBackup(
			"with-backup",
			"target-password",
			canonical,
		),
		/Vault changed/,
	);
	assert.equal(client.files.size, 2);
	assert.equal(content, "late change");
});
