import assert from "node:assert/strict";
import test from "node:test";
import {
	IndexManager,
	LegacyIndexVersionError,
	RemoteIndexRolledBackError,
	IndexEpochMismatchError,
	UnreadableRemoteIndexError,
} from "../src/sync/index-manager";
import {
	CURRENT_INDEX_VERSION,
	DEFAULT_SETTINGS,
	type YandexDiskSyncSettings,
	type YandexResource,
} from "../src/types";
import type { EncryptionService } from "../src/crypto/encryption";
import type { YandexDiskClient } from "../src/api/yandex-client";
import type { VaultAdapter } from "../src/api/vault-adapter";
import { logger } from "../src/utils/logger";

logger.configure({ consoleEnabled: false, fileEnabled: false });

class XorEncryptionService {
	constructor(private readonly key: number) {}

	async encrypt(content: ArrayBuffer): Promise<ArrayBuffer> {
		return this.transform(content);
	}

	async decrypt(content: ArrayBuffer): Promise<ArrayBuffer> {
		return this.transform(content);
	}

	private transform(content: ArrayBuffer): ArrayBuffer {
		const source = new Uint8Array(content);
		const result = new Uint8Array(source.length);
		for (let index = 0; index < source.length; index++) {
			result[index] = source[index]! ^ this.key;
		}
		return result.buffer;
	}
}

class RejectingEncryptionService {
	async encrypt(content: ArrayBuffer): Promise<ArrayBuffer> {
		return content.slice(0);
	}

	async decrypt(): Promise<ArrayBuffer> {
		const error = new Error("authentication failed");
		error.name = "OperationError";
		throw error;
	}
}

class FakeIndexYandex {
	readonly files = new Map<string, ArrayBuffer>();
	moveCount = 0;

	constructor(
		private readonly remotePath: string,
		private readonly encryption: EncryptionService | null,
		private readonly faults: {
			throwAfterFinalMove?: boolean;
			corruptIndexUpload?: boolean;
		} = {},
	) {}

	hasEncryptionService(): boolean {
		return this.encryption !== null;
	}

	async decodeServiceFileContent(
		raw: ArrayBuffer,
		service?: EncryptionService | null,
	): Promise<ArrayBuffer> {
		const codec = service === undefined ? this.encryption : service;
		return codec ? await codec.decrypt(raw) : raw;
	}

	async downloadFile(path: string, raw = false): Promise<ArrayBuffer> {
		const value = this.files.get(path);
		if (!value) throw new Error(`Missing file: ${path}`);
		const copy = value.slice(0);
		return raw || !this.encryption
			? copy
			: await this.encryption.decrypt(copy);
	}

	async downloadStableRawFile(path: string): Promise<{
		raw: ArrayBuffer;
		resource: YandexResource;
		fingerprint: string;
	} | null> {
		const resource = await this.getResource(path);
		if (!resource) return null;
		const raw = await this.downloadFile(path, true);
		return {
			raw,
			resource,
			fingerprint: this.getContentFingerprint(resource)!,
		};
	}

	getContentFingerprint(resource: YandexResource | null): string | null {
		if (!resource) return null;
		if (resource.sha256) return `sha256:${resource.sha256}`;
		if (resource.md5) return `md5:${resource.md5}`;
		if (resource.modified) {
			return `modified:${resource.modified}:size:${resource.size ?? -1}`;
		}
		return null;
	}

	async uploadFile(
		path: string,
		content: ArrayBuffer | string,
		_skipFolderCheck = false,
		raw = false,
		overwrite = true,
	): Promise<void> {
		if (!overwrite && this.files.has(path)) {
			throw new Error("target exists");
		}
		const plain =
			typeof content === "string"
				? new TextEncoder().encode(content).buffer
				: content;
		const stored =
			raw || !this.encryption
				? plain
				: await this.encryption.encrypt(plain);
		const storedCopy = stored.slice(0);
		if (
			this.faults.corruptIndexUpload &&
			!raw &&
			path.includes(".obsidian-sync-index.lock.")
		) {
			const bytes = new Uint8Array(storedCopy);
			bytes[0] = (bytes[0] ?? 0) ^ 0xff;
		}
		this.files.set(path, storedCopy);
	}

	async uploadFileWithEncryptionService(
		path: string,
		content: string,
		service: EncryptionService | null,
		overwrite = true,
	): Promise<void> {
		const plain = new TextEncoder().encode(content).buffer;
		const stored = service ? await service.encrypt(plain) : plain;
		await this.uploadFile(path, stored, true, true, overwrite);
	}

	async uploadFileExclusive(
		path: string,
		content: string,
		_rawPath = false,
		rawContent = false,
	): Promise<void> {
		await this.uploadFile(path, content, true, rawContent, false);
	}

	async moveResourceExclusive(
		fromPath: string,
		toPath: string,
	): Promise<void> {
		if (this.files.has(toPath)) throw new Error("target exists");
		const value = this.files.get(fromPath);
		if (!value) throw new Error("source missing");
		this.files.set(toPath, value);
		this.files.delete(fromPath);
		this.moveCount++;
		if (this.faults.throwAfterFinalMove && this.moveCount === 2) {
			throw new Error("lost final move response");
		}
	}

	async deleteResource(path: string): Promise<void> {
		this.files.delete(path);
	}

	async getResource(
		path: string,
		_limit = 1000,
		_offset = 0,
		_raw = false,
	): Promise<YandexResource | null> {
		if (path === this.remotePath) {
			const items = [...this.files.entries()]
				.filter(([filePath]) =>
					filePath.startsWith(`${this.remotePath}/`),
				)
				.map(([filePath, content]) =>
					this.createResource(filePath, content),
				);
			return {
				name: this.remotePath,
				path: this.remotePath,
				type: "dir",
				created: "2026-01-01T00:00:00Z",
				modified: "2026-01-01T00:00:00Z",
				_embedded: {
					items,
					total: items.length,
					limit: 1000,
					offset: 0,
					path: this.remotePath,
					sort: "",
				},
			};
		}
		const content = this.files.get(path);
		return content ? this.createResource(path, content) : null;
	}

	private createResource(
		path: string,
		content: ArrayBuffer,
	): YandexResource {
		return {
			name: path.split("/").pop() ?? path,
			path,
			type: "file",
			created: "2026-01-01T00:00:00Z",
			modified: "2026-01-01T00:00:00Z",
			size: content.byteLength,
			md5: this.fingerprint(content),
		};
	}

	private fingerprint(content: ArrayBuffer): string {
		return [...new Uint8Array(content)]
			.reduce((value, byte) => (value * 33 + byte) >>> 0, 5381)
			.toString(16)
			.padStart(8, "0");
	}
}

function createSettings(deviceId: string): YandexDiskSyncSettings {
	return {
		...DEFAULT_SETTINGS,
		deviceId,
		remotePath: "vault",
	};
}

async function runLegacyForceCommit(
	encryption: EncryptionService | null,
	sourceIndex: Record<string, unknown> = {
		version: 2,
		lastSyncTime: 1,
		deviceId: "old-device",
		files: {},
	},
	faults: {
		throwAfterFinalMove?: boolean;
		corruptIndexUpload?: boolean;
	} = {},
): Promise<{
	client: FakeIndexYandex;
	manager: IndexManager;
	canonicalPath: string;
	originalRaw: ArrayBuffer;
}> {
	const client = new FakeIndexYandex("vault", encryption, faults);
	const canonicalPath = "vault/.obsidian-sync-index.json";
	const legacy = JSON.stringify(sourceIndex);
	const legacyBytes = new TextEncoder().encode(legacy).buffer;
	client.files.set(
		canonicalPath,
		encryption
			? await encryption.encrypt(legacyBytes)
			: legacyBytes,
	);
	const originalRaw = client.files.get(canonicalPath)!.slice(0);
	const manager = new IndexManager(
		client as unknown as YandexDiskClient,
		{} as VaultAdapter,
		createSettings("new-device"),
	);
	manager.beginForceBootstrap(true);
	manager.updateRemoteFile("note.md", {
		path: "note.md",
		sha256: "hash",
		size: 4,
		mtime: 10,
		syncedAt: 10,
		remoteMtime: undefined,
	});

	if (faults.corruptIndexUpload) {
		return { client, manager, canonicalPath, originalRaw };
	}

	await manager.saveRemoteIndex();

	const raw = client.files.get(canonicalPath)!;
	const plain = encryption ? await encryption.decrypt(raw) : raw;
	const canonical = JSON.parse(
		new TextDecoder().decode(plain),
	) as { version: number; epoch: string; revision: number };
	assert.equal(canonical.version, CURRENT_INDEX_VERSION);
	assert.equal(canonical.revision, 1);
	assert.ok(canonical.epoch);
	assert.equal(manager.getObservedEpoch(), canonical.epoch);
	assert.equal(manager.getObservedRevision(), canonical.revision);
	assert.equal(client.moveCount, 2);
	assert.deepEqual(
		[...client.files.keys()].filter((path) => path.includes(".lock.")),
		[],
	);
	return { client, manager, canonicalPath, originalRaw };
}

test("plaintext legacy Force commits and verifies canonical v3", async () => {
	await runLegacyForceCommit(null);
});

test("encrypted legacy Force commits and verifies canonical v3", async () => {
	await runLegacyForceCommit(
		new XorEncryptionService(0xa5) as unknown as EncryptionService,
	);
});

test("encryption manifest validation token detects unchanged and changed content", async () => {
	const client = new FakeIndexYandex("vault", null);
	const manifestPath = "vault/.obsidian-encrypt.json";
	const manifest = {
		version: 2,
		state: "enabled",
		revision: 1,
		salt: "c2FsdA==",
		verifier: "dmVyaWZpZXI=",
		updatedAt: 1,
		updatedBy: "device-a",
	};
	client.files.set(
		manifestPath,
		new TextEncoder().encode(JSON.stringify(manifest)).buffer,
	);
	const manager = new IndexManager(
		client as unknown as YandexDiskClient,
		{} as VaultAdapter,
		createSettings("device-a"),
	);
	const read = await manager.downloadEncryptionManifestForGuard();
	assert.equal(
		await manager.isEncryptionManifestTokenCurrent(read.validationToken),
		true,
	);
	client.files.set(
		manifestPath,
		new TextEncoder().encode(
			JSON.stringify({ ...manifest, revision: 2 }),
		).buffer,
	);
	assert.equal(
		await manager.isEncryptionManifestTokenCurrent(read.validationToken),
		false,
	);
});

test("absent manifest token detects a newly created manifest", async () => {
	const client = new FakeIndexYandex("vault", null);
	const manager = new IndexManager(
		client as unknown as YandexDiskClient,
		{} as VaultAdapter,
		createSettings("device-a"),
	);
	const read = await manager.downloadEncryptionManifestForGuard();
	assert.equal(read.validationToken, "absent");
	assert.equal(
		await manager.isEncryptionManifestTokenCurrent(read.validationToken),
		true,
	);
	client.files.set(
		"vault/.obsidian-encrypt.json",
		new TextEncoder().encode("{}").buffer,
	);
	assert.equal(
		await manager.isEncryptionManifestTokenCurrent(read.validationToken),
		false,
	);
});

async function createIndexManagerWithContent(
	content: Record<string, unknown> | string,
	activeEncryption: EncryptionService | null,
	storageEncryption: EncryptionService | null = activeEncryption,
): Promise<{
	client: FakeIndexYandex;
	manager: IndexManager;
	canonicalPath: string;
}> {
	const client = new FakeIndexYandex("vault", activeEncryption);
	const canonicalPath = "vault/.obsidian-sync-index.json";
	const json =
		typeof content === "string" ? content : JSON.stringify(content);
	const plain = new TextEncoder().encode(json).buffer;
	client.files.set(
		canonicalPath,
		storageEncryption
			? await storageEncryption.encrypt(plain)
			: plain,
	);
	return {
		client,
		manager: new IndexManager(
			client as unknown as YandexDiskClient,
			{} as VaultAdapter,
			createSettings("new-device"),
		),
		canonicalPath,
	};
}

test("plaintext legacy startup preserves LegacyIndexVersionError", async () => {
	const { manager } = await createIndexManagerWithContent(
		{ version: 2, files: {} },
		null,
	);
	await assert.rejects(
		manager.loadRemoteIndex(),
		(error: unknown) =>
			error instanceof LegacyIndexVersionError &&
			error.version === 2,
	);
});

test("encrypted legacy startup preserves LegacyIndexVersionError", async () => {
	const encryption =
		new XorEncryptionService(0xa5) as unknown as EncryptionService;
	const { manager, client, canonicalPath } =
		await createIndexManagerWithContent(
			{ version: 2, files: {} },
			encryption,
		);
	const originalRaw = client.files.get(canonicalPath)!.slice(0);
	await assert.rejects(
		manager.loadRemoteIndex(),
		(error: unknown) =>
			error instanceof LegacyIndexVersionError &&
			error.version === 2,
	);
	assert.deepEqual(
		new Uint8Array(client.files.get(canonicalPath)!),
		new Uint8Array(originalRaw),
	);
	assert.equal(client.moveCount, 0);
});

test("plaintext legacy index falls back from active encryption codec", async () => {
	const encryption =
		new XorEncryptionService(0xa5) as unknown as EncryptionService;
	const { manager } = await createIndexManagerWithContent(
		{ version: 2, files: {} },
		encryption,
		null,
	);
	await assert.rejects(
		manager.loadRemoteIndex(),
		LegacyIndexVersionError,
	);
});

test("encrypted current index loads without plaintext fallback", async () => {
	const encryption =
		new XorEncryptionService(0xa5) as unknown as EncryptionService;
	const { manager } = await createIndexManagerWithContent(
		{
			version: CURRENT_INDEX_VERSION,
			epoch: "epoch-current",
			revision: 4,
			files: {},
		},
		encryption,
	);
	const index = await manager.loadRemoteIndex();
	assert.equal(index.epoch, "epoch-current");
	assert.equal(index.revision, 4);
});

test("only full discovery may load a replacement current epoch", async () => {
	const { manager } = await createIndexManagerWithContent(
		{
			version: CURRENT_INDEX_VERSION,
			epoch: "epoch-b",
			revision: 4,
			files: {},
		},
		null,
	);
	manager.loadLocalIndexFromData({
		version: 1,
		deviceId: "new-device",
		observedEpoch: "epoch-a",
		observedRevision: 3,
		files: {},
		folderTombstones: {},
		nextMutationSeq: 1,
	});
	await assert.rejects(manager.loadRemoteIndex(), IndexEpochMismatchError);
	const replacement = await manager.loadRemoteIndex(false, false, true);
	assert.equal(replacement.epoch, "epoch-b");
	assert.equal(manager.getObservedEpoch(), "epoch-a");
});

test("wrong encrypted index key is classified as unreadable", async () => {
	const currentEncryption =
		new RejectingEncryptionService() as unknown as EncryptionService;
	const storageEncryption =
		new XorEncryptionService(0x5a) as unknown as EncryptionService;
	const { manager } = await createIndexManagerWithContent(
		{
			version: CURRENT_INDEX_VERSION,
			epoch: "epoch-current",
			revision: 4,
			files: {},
		},
		currentEncryption,
		storageEncryption,
	);
	await assert.rejects(
		manager.loadRemoteIndex(),
		(error: unknown) =>
			error instanceof UnreadableRemoteIndexError &&
			error.attempts.some(
				(attempt) =>
					attempt.codec === "current" &&
					attempt.stage === "decrypt" &&
					attempt.errorName === "OperationError",
			) &&
			error.attempts.some(
				(attempt) =>
					attempt.codec === "plaintext" &&
					attempt.stage === "json",
			),
	);
});

test("invalid plaintext index is classified as unreadable", async () => {
	const { manager } = await createIndexManagerWithContent(
		"not-json",
		null,
	);
	await assert.rejects(
		manager.loadRemoteIndex(),
		UnreadableRemoteIndexError,
	);
});

test("semantic index version errors are not masked by codec fallback", async () => {
	const encryption =
		new XorEncryptionService(0xa5) as unknown as EncryptionService;
	const { manager } = await createIndexManagerWithContent(
		{ version: 999, files: {} },
		encryption,
	);
	await assert.rejects(
		manager.loadRemoteIndex(),
		/Remote sync index version 999 is not supported/,
	);
});

test("explicit transition codec does not fall back to plaintext", async () => {
	const encryption =
		new XorEncryptionService(0xa5) as unknown as EncryptionService;
	const { manager, client, canonicalPath } =
		await createIndexManagerWithContent(
			{
				version: CURRENT_INDEX_VERSION,
				epoch: "epoch-current",
				revision: 1,
				files: {},
			},
			encryption,
			null,
		);
	const raw = client.files.get(canonicalPath)!;
	const decoder = manager as unknown as {
		decodeIndexSnapshot(
			content: ArrayBuffer,
			allowLegacy: boolean,
			service: EncryptionService | null,
			codec: "source",
		): Promise<unknown>;
	};
	await assert.rejects(
		decoder.decodeIndexSnapshot(
			raw,
			false,
			encryption,
			"source",
		),
		(error: unknown) =>
			error instanceof UnreadableRemoteIndexError &&
			error.attempts.length === 1 &&
			error.attempts[0]?.codec === "source",
	);
});

test("Force replaces an unreadable prerelease v3 without epoch", async () => {
	await runLegacyForceCommit(null, {
		version: 3,
		revision: 1,
		files: {},
	});
});

test("successful final move with a lost response still commits", async () => {
	const { client } = await runLegacyForceCommit(
		null,
		undefined,
		{ throwAfterFinalMove: true },
	);
	assert.equal(client.moveCount, 2);
});

test("unverified modified lock restores the encrypted source bytes", async () => {
	const encryption =
		new XorEncryptionService(0x5a) as unknown as EncryptionService;
	const { client, manager, canonicalPath, originalRaw } =
		await runLegacyForceCommit(encryption, undefined, {
			corruptIndexUpload: true,
		});
	const transaction = manager as unknown as {
		saveRemoteIndexLocked(): Promise<unknown>;
	};

	await assert.rejects(
		transaction.saveRemoteIndexLocked(),
		RemoteIndexRolledBackError,
	);
	assert.equal(
		Buffer.from(client.files.get(canonicalPath)!).equals(
			Buffer.from(originalRaw),
		),
		true,
	);
	assert.deepEqual(
		[...client.files.keys()].filter((path) => path.includes(".lock.")),
		[],
	);
});

test("semantic epoch rollback is not retried while transient rollback is", () => {
	const semantic = new RemoteIndexRolledBackError(
		"rolled back",
		"acquired",
		new IndexEpochMismatchError("epoch-a", "epoch-b"),
	);
	const transient = new RemoteIndexRolledBackError(
		"rolled back",
		"acquired",
		new TypeError("fetch failed"),
	);
	assert.equal(semantic.retryable, false);
	assert.equal(transient.retryable, true);
});

test("legacy local index becomes an unobserved v3 baseline", () => {
	const manager = new IndexManager(
		new FakeIndexYandex("vault", null) as unknown as YandexDiskClient,
		{} as VaultAdapter,
		createSettings("device-a"),
	);
	manager.loadLegacyLocalIndexFromData({
		lastSyncTime: 10,
		files: {
			"note.md": {
				path: "note.md",
				sha256: "legacy-sha",
				size: 7,
				mtime: 8,
				syncedAt: 9,
			},
			"invalid.md": { path: "invalid.md" },
		},
	});
	const local = manager.getLocalIndex();
	assert.equal(local.observedEpoch, null);
	assert.equal(local.observedRevision, 0);
	assert.equal(local.files["note.md"]?.sha256, "legacy-sha");
	assert.equal(local.files["invalid.md"], undefined);
});
