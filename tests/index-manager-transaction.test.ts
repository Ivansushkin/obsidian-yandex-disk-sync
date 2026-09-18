import assert from "node:assert/strict";
import test from "node:test";
import {
	IndexManager,
	LegacyIndexFormatError,
	RemoteIndexRolledBackError,
	IndexEpochMismatchError,
	InvalidCurrentIndexError,
	UnreadableRemoteIndexError,
	ForceBackupStaleError,
	PortablePathCollisionError,
	LegacyPluginDataExposureError,
	LegacyServicePathCollisionError,
} from "../src/sync/canonical/manager";
import {
	CURRENT_INDEX_FORMAT,
	createEmptyIndex,
	DEFAULT_SETTINGS,
	type YandexDiskSyncSettings,
	type YandexResource,
	type FileMetadata,
} from "../src/types";
import type { EncryptionCodec } from "../src/crypto/encryption";
import type { YandexDiskClient } from "../src/api/yandex-client";
import type { VaultAdapter } from "../src/api/vault-adapter";
import { logger } from "../src/utils/logger";
import { UnsupportedHistoricalDataError } from "../src/compatibility-errors";
import stableCanonicalFixture from "./fixtures/stable-1.1/canonical-v2.json";

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
	stableReadCount = 0;
	readonly downloadedPaths: string[] = [];

	constructor(
		private readonly remotePath: string,
		private readonly encryption: EncryptionCodec | null,
		private readonly faults: {
			throwAfterFinalMove?: boolean;
			corruptIndexUpload?: boolean;
			hashlessMetadata?: boolean;
		} = {},
	) {}

	hasEncryptionService(): boolean {
		return this.encryption !== null;
	}

	async decodeServiceFileContent(
		raw: ArrayBuffer,
		service?: EncryptionCodec | null,
	): Promise<ArrayBuffer> {
		const codec = service === undefined ? this.encryption : service;
		return codec ? await codec.decrypt(raw) : raw;
	}

	async downloadFile(path: string, raw = false): Promise<ArrayBuffer> {
		this.downloadedPaths.push(path);
		const value = this.files.get(path);
		if (!value) {
			throw new Error(`Missing file: ${path}`);
		}
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
		this.stableReadCount++;
		const resource = await this.getResource(path);
		if (!resource) {
			return null;
		}
		const raw = await this.downloadFile(path, true);
		return {
			raw,
			resource,
			fingerprint: this.getContentFingerprint(resource)!,
		};
	}

	getContentFingerprint(resource: YandexResource | null): string | null {
		if (!resource) {
			return null;
		}
		if (resource.sha256) {
			return `sha256:${resource.sha256}`;
		}
		if (resource.md5) {
			return `md5:${resource.md5}`;
		}
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
		service: EncryptionCodec | null,
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
		if (this.files.has(toPath)) {
			throw new Error("target exists");
		}
		const value = this.files.get(fromPath);
		if (!value) {
			throw new Error("source missing");
		}
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

	async getResourcesRecursive(): Promise<YandexResource[]> {
		return [...this.files.entries()].map(([path, content]) =>
			this.createResource(path, content),
		);
	}

	private createResource(path: string, content: ArrayBuffer): YandexResource {
		const identity = this.fingerprint(content);
		return {
			name: path.split("/").pop() ?? path,
			path,
			type: "file",
			created: "2026-01-01T00:00:00Z",
			modified: this.faults.hashlessMetadata
				? `content-${identity}-${path}`
				: "2026-01-01T00:00:00Z",
			size: content.byteLength,
			md5: this.faults.hashlessMetadata ? undefined : identity,
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

function stable1xIndex(version: 1 | 2 = 2): Record<string, unknown> {
	return {
		version,
		lastSyncTime: 1,
		deviceId: "stable-device",
		files: {},
	};
}

test("encryption source snapshot rejects an unprovable raw user object", async () => {
	const manager = new IndexManager(
		{
			getResourcesRecursive: async () => [
				{
					name: "note.md",
					path: "vault/note.md",
					type: "file",
					created: "",
					modified: "",
				},
			],
		} as unknown as YandexDiskClient,
		{} as VaultAdapter,
		createSettings("device-a"),
	);

	await assert.rejects(
		manager.getRemoteRawFileSnapshots(),
		/no stable fingerprint/,
	);
});

test("remote paths rewritten by current normalization fail before indexing", async () => {
	const manager = new IndexManager(
		{
			getResourcesRecursive: async () => [
				{
					name: "notes\\name.md",
					path: "vault/notes\\name.md",
					type: "file",
					created: "",
					modified: "",
				},
			],
		} as unknown as YandexDiskClient,
		{} as VaultAdapter,
		createSettings("device-a"),
	);

	await assert.rejects(manager.getRemoteFiles(), PortablePathCollisionError);
});

async function runLegacyForceCommit(
	encryption: EncryptionCodec | null,
	sourceIndex: Record<string, unknown> = stable1xIndex(),
	faults: {
		throwAfterFinalMove?: boolean;
		corruptIndexUpload?: boolean;
		hashlessMetadata?: boolean;
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
		encryption ? await encryption.encrypt(legacyBytes) : legacyBytes,
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
		mtime: 10.375,
		syncedAt: 10,
		remoteMtime: undefined,
	});

	if (faults.corruptIndexUpload) {
		return { client, manager, canonicalPath, originalRaw };
	}

	const proof = await manager.saveRemoteIndex();

	const raw = client.files.get(canonicalPath)!;
	const plain = encryption ? await encryption.decrypt(raw) : raw;
	const canonical = JSON.parse(new TextDecoder().decode(plain)) as {
		format: string;
		epoch: string;
		revision: number;
		files: Record<string, FileMetadata>;
	};
	assert.equal(canonical.format, CURRENT_INDEX_FORMAT);
	assert.equal("version" in canonical, false);
	assert.equal(canonical.revision, 1);
	assert.ok(canonical.epoch);
	assert.equal(canonical.files["note.md"]?.mutationSeq, 0);
	assert.equal(canonical.files["note.md"]?.mtime, 10.375);
	assert.equal(manager.getObservedEpoch(), canonical.epoch);
	assert.equal(manager.getObservedRevision(), canonical.revision);
	assert.equal(client.moveCount, 2);
	assert.equal(proof.epoch, canonical.epoch);
	assert.equal(proof.revision, canonical.revision);
	assert.match(
		proof.contentFingerprint,
		faults.hashlessMetadata ? /^modified:/ : /^md5:/,
	);
	assert.equal(
		client.stableReadCount,
		faults.throwAfterFinalMove || faults.hashlessMetadata ? 4 : 3,
	);
	assert.deepEqual(
		[...client.files.keys()].filter((path) => path.includes(".lock.")),
		[],
	);
	return { client, manager, canonicalPath, originalRaw };
}

test("plaintext stable 1.0/1.1 Force commits and verifies current canonical", async () => {
	for (const version of [1, 2] as const) {
		await runLegacyForceCommit(null, {
			version,
			lastSyncTime: 1,
			deviceId: "stable-device",
			files: {},
		});
	}
	const fixtureResult = await runLegacyForceCommit(
		null,
		stableCanonicalFixture,
	);
	const historicalDelete =
		fixtureResult.manager.getRemoteIndex().files["deleted.md"];
	assert.equal(historicalDelete?.deleted, true);
	assert.equal(historicalDelete?.mutationSeq, 0);
});

test("stable fractional mtime survives Force replacement and current canonical readback", async () => {
	const source = structuredClone(stableCanonicalFixture);
	for (const metadata of Object.values(source.files)) {
		metadata.mtime += 0.375;
	}
	const { manager } = await runLegacyForceCommit(null, source);
	assert.equal(
		manager.getRemoteIndex().files["deleted.md"]?.mtime,
		source.files["deleted.md"].mtime,
	);
});

test("Force replacement tombstones survive initiator loss", async () => {
	const source = stable1xIndex();
	const files = source.files as Record<string, unknown>;
	files["removed.md"] = {
		path: "removed.md",
		sha256: "removed-sha",
		size: 7,
		mtime: 8,
		syncedAt: 9,
	};
	const { manager } = await runLegacyForceCommit(null, source);
	const tombstone = manager.getRemoteIndex().files["removed.md"];
	assert.equal(tombstone?.deleted, true);
	assert.equal(tombstone?.mutationSeq, 0);
	assert.equal(tombstone?.lastModifiedBy, "new-device");
});

test("legacy root __proto__ path survives conversion and Force", async () => {
	const source = stable1xIndex();
	const files = source.files as Record<string, unknown>;
	Object.defineProperty(files, "__proto__", {
		value: {
			path: "__proto__",
			sha256: "proto-sha",
			size: 5,
			mtime: 6,
			syncedAt: 7,
		},
		enumerable: true,
		configurable: true,
		writable: true,
	});
	const { manager } = await runLegacyForceCommit(null, source);
	const replacement = manager.getRemoteIndex().files;
	assert.equal(
		Object.prototype.hasOwnProperty.call(replacement, "__proto__"),
		true,
	);
	assert.equal(replacement["__proto__"]?.deleted, true);
	assert.equal(replacement["__proto__"]?.mutationSeq, 0);
});

test("versioned data outside the exact stable 1.x shape is rejected before Force locks", async () => {
	const { manager, client } = await createIndexManagerWithContent(
		{
			version: 2,
			lastSyncTime: 1,
			deviceId: "historical-device",
			files: {},
			pendingMutations: [],
		},
		null,
	);
	manager.beginForceBootstrap(true);
	await assert.rejects(
		manager.saveRemoteIndex(),
		UnsupportedHistoricalDataError,
	);
	assert.equal(client.moveCount, 0);
});

test("encrypted legacy index is rejected before Force acquires a lock", async () => {
	const encryption = new XorEncryptionService(
		0xa5,
	) as unknown as EncryptionCodec;
	const { manager, client } = await createIndexManagerWithContent(
		stable1xIndex(),
		encryption,
	);
	manager.beginForceBootstrap(true);
	await assert.rejects(
		manager.saveRemoteIndex(),
		UnsupportedHistoricalDataError,
	);
	assert.equal(client.moveCount, 0);
});

test("hashless canonical metadata falls back to semantic verification", async () => {
	await runLegacyForceCommit(null, undefined, { hashlessMetadata: true });
});

test("encryption manifest validation token detects unchanged and changed content", async () => {
	const client = new FakeIndexYandex("vault", null);
	const manifestPath = "vault/.obsidian-encrypt.json";
	const manifest = {
		format: "encryption-manifest",
		profileId: "hardened",
		state: "enabled",
		revision: 1,
		salt: "AAAAAAAAAAAAAAAAAAAAAA==",
		verifier: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
		kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600_000 },
		keySchedule: { name: "HKDF", hash: "SHA-256" },
		cipher: { name: "AES-GCM", keyLength: 256, ivLength: 12 },
		filenameCipher: {
			name: "AES-SIV",
			keyLength: 512,
			encoding: "base64url",
			aad: "obsidian-yandex-disk-sync:filename",
		},
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
			JSON.stringify({ ...manifest, salt: "AQEBAQEBAQEBAQEBAQEBAQ==" }),
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

async function readEncryptionManifest(manifest: object) {
	const client = new FakeIndexYandex("vault", null);
	client.files.set(
		"vault/.obsidian-encrypt.json",
		new TextEncoder().encode(JSON.stringify(manifest)).buffer,
	);
	const manager = new IndexManager(
		client as unknown as YandexDiskClient,
		{} as VaultAdapter,
		createSettings("device-a"),
	);
	return await manager.downloadEncryptionManifest();
}

const manifestCommon = {
	state: "enabled",
	revision: 1,
	salt: "AAAAAAAAAAAAAAAAAAAAAA==",
	verifier: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
	updatedAt: 1,
	updatedBy: "device-a",
};

test("numeric historical manifests are rejected as unsupported data", async () => {
	for (const version of [1, 2, 3]) {
		await assert.rejects(
			readEncryptionManifest({ version, ...manifestCommon }),
			UnsupportedHistoricalDataError,
		);
	}
});

test("strict semantic manifest accepts only the hardened profile", async () => {
	const hardened = {
		format: "encryption-manifest",
		profileId: "hardened",
		...manifestCommon,
		kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600_000 },
		keySchedule: { name: "HKDF", hash: "SHA-256" },
		cipher: { name: "AES-GCM", keyLength: 256, ivLength: 12 },
		filenameCipher: {
			name: "AES-SIV",
			keyLength: 512,
			encoding: "base64url",
			aad: "obsidian-yandex-disk-sync:filename",
		},
	};
	const parsed = await readEncryptionManifest(hardened);
	assert.equal(parsed?.format, "encryption-manifest");
	assert.equal(parsed ? "version" in parsed : true, false);
	await assert.rejects(
		readEncryptionManifest({ ...hardened, version: 3 }),
		/unsupported field version/,
	);
	await assert.rejects(
		readEncryptionManifest({
			...hardened,
			filenameCipher: { ...hardened.filenameCipher, name: "AES-GCM" },
		}),
		/unsupported profile/,
	);
	await assert.rejects(
		readEncryptionManifest({
			...hardened,
			kdf: { ...hardened.kdf, fallbackIterations: 100_000 },
		}),
		/unsupported field fallbackIterations/,
	);
	const rotating = {
		...hardened,
		state: "rotating",
		revision: 2,
		salt: "AQEBAQEBAQEBAQEBAQEBAQ==",
		verifier: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==",
		transition: {
			id: "transition-a",
			phase: "prepared",
			sourceRevision: 1,
			targetRevision: 2,
			initiatedBy: "device-a",
			source: {
				enabled: true,
				revision: 1,
				salt: manifestCommon.salt,
				verifier: manifestCommon.verifier,
			},
			target: {
				enabled: true,
				revision: 2,
				salt: "AQEBAQEBAQEBAQEBAQEBAQ==",
				verifier: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==",
			},
			sourceProfileId: "hardened",
			targetProfileId: "hardened",
		},
	};
	assert.equal((await readEncryptionManifest(rotating))?.state, "rotating");
	await assert.rejects(
		readEncryptionManifest({
			...rotating,
			updatedBy: "different-device",
		}),
		/incoherent transition/,
	);
	await assert.rejects(
		readEncryptionManifest({
			...hardened,
			state: "rotating",
			transition: {
				id: "transition-a",
				phase: "prepared",
				sourceRevision: 1,
				targetRevision: 2,
				initiatedBy: "device-a",
			},
		}),
		/missing field source/,
	);
	await assert.rejects(
		readEncryptionManifest({
			...hardened,
			state: "rotating",
		}),
		/transition\/state mismatch/,
	);
});

test("foreign post-commit maintenance is scoped to matching target recovery", async () => {
	const manager = new IndexManager(
		{} as YandexDiskClient,
		{} as VaultAdapter,
		createSettings("target-device"),
	);
	const index = createEmptyIndex("source-device");
	index.maintenance = {
		id: "transition-a",
		kind: "rotate",
		phase: "index-committed",
		initiatedBy: "source-device",
		sourceRevision: 1,
		targetRevision: 2,
		source: {
			enabled: true,
			revision: 1,
			salt: "source-salt",
			verifier: "source-verifier",
		},
		target: {
			enabled: true,
			revision: 2,
			salt: "target-salt",
			verifier: "target-verifier",
		},
		cleanup: [{ path: "old-raw", expectedFingerprint: "sha256:old" }],
	};
	const access = manager as unknown as {
		assertMaintenanceCompatible(value: typeof index): void;
	};
	for (const phase of ["index-committed", "cleanup", "stable"] as const) {
		index.maintenance.phase = phase;
		assert.throws(() => access.assertMaintenanceCompatible(index));
		await manager.runTargetMaintenanceRecovery("transition-a", async () => {
			assert.doesNotThrow(() =>
				access.assertMaintenanceCompatible(index),
			);
			index.maintenance!.phase = "files-copied";
			assert.throws(() => access.assertMaintenanceCompatible(index));
			index.maintenance!.phase = phase;
		});
		assert.throws(() => access.assertMaintenanceCompatible(index));
	}
});

test("plaintext target recovery reads committed disable canonical without source key", async () => {
	const sourceEncryption = new XorEncryptionService(
		0xa5,
	) as unknown as EncryptionCodec;
	const index = createEmptyIndex("source-device", "epoch-disable");
	index.revision = 2;
	index.maintenance = {
		id: "transition-disable",
		kind: "disable",
		phase: "index-committed",
		initiatedBy: "source-device",
		sourceRevision: 1,
		targetRevision: 2,
		source: {
			enabled: true,
			revision: 1,
			salt: "source-salt",
			verifier: "source-verifier",
		},
		target: {
			enabled: false,
			revision: null,
			salt: null,
			verifier: null,
		},
		cleanup: [],
	};
	const { manager } = await createIndexManagerWithContent(
		index,
		sourceEncryption,
		null,
		"target-device",
	);

	await assert.rejects(manager.loadRemoteIndex(), UnreadableRemoteIndexError);
	const discovered = await manager.readCanonicalIndexWithCodecIfPresent(null);
	assert.equal(discovered?.maintenance?.id, "transition-disable");
	await assert.rejects(
		manager.loadRemoteIndexWithTargetCodec(null),
		/requires recovery ownership/,
	);
	manager.loadLocalIndexFromData({
		observedEpoch: "old-epoch",
		observedRevision: 1,
		files: {},
		nextMutationSeq: 1,
	});
	manager.enqueueMutation("put", "offline.md", { sha256: "offline-sha" });
	const oldState = structuredClone(manager.getLocalIndexData());
	const oldQueue = structuredClone(manager.getPendingMutations());
	const recovered = await manager.runTargetMaintenanceRecovery(
		"transition-disable",
		async () => {
			manager.setIndexTransitionServices(null, null);
			try {
				await manager.loadRemoteIndexWithTargetCodec(null);
				manager.setMaintenance({
					...manager.getMaintenance()!,
					phase: "cleanup",
				});
				await manager.saveRemoteIndex();
				assert.deepEqual(manager.getPendingMutations(), oldQueue);
				assert.equal(
					manager.getRemoteIndex().files["offline.md"],
					undefined,
				);
				manager.clearMaintenance("transition-disable");
				await manager.saveRemoteIndex();
				return manager.getRemoteIndex();
			} finally {
				manager.clearIndexTransitionServices();
			}
		},
	);
	assert.equal(recovered.epoch, "epoch-disable");
	assert.equal(recovered.maintenance, undefined);
	assert.deepEqual(manager.getLocalIndexData(), oldState);
	assert.deepEqual(manager.getPendingMutations(), oldQueue);
});

async function createIndexManagerWithContent(
	content: object | string,
	activeEncryption: EncryptionCodec | null,
	storageEncryption: EncryptionCodec | null = activeEncryption,
	deviceId = "new-device",
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
		storageEncryption ? await storageEncryption.encrypt(plain) : plain,
	);
	return {
		client,
		manager: new IndexManager(
			client as unknown as YandexDiskClient,
			{} as VaultAdapter,
			createSettings(deviceId),
		),
		canonicalPath,
	};
}

test("plaintext stable 1.x startup preserves LegacyIndexFormatError", async () => {
	const { manager } = await createIndexManagerWithContent(
		stable1xIndex(),
		null,
	);
	await assert.rejects(manager.loadRemoteIndex(), LegacyIndexFormatError);
});

test("legacy protected plugin data blocks migration without content download", async () => {
	const source = stable1xIndex();
	const { manager, client, canonicalPath } =
		await createIndexManagerWithContent(source, null);
	client.files.set(
		"vault/vault-config/plugins/yandex-disk-sync/data.json",
		new TextEncoder().encode("must-not-be-read").buffer,
	);
	await assert.rejects(
		manager.assertLegacyMigrationPathsSafe(),
		LegacyPluginDataExposureError,
	);
	assert.equal(
		client.downloadedPaths.every((path) => path === canonicalPath),
		true,
	);
});

test("missing legacy canonical cannot hide exposed plugin data", async () => {
	const { manager, client, canonicalPath } =
		await createIndexManagerWithContent(stable1xIndex(), null);
	client.files.delete(canonicalPath);
	client.files.set(
		"vault/vault-config/plugins/yandex-disk-sync/data.json",
		new TextEncoder().encode("must-not-be-read").buffer,
	);
	await assert.rejects(
		manager.assertLegacyMigrationPathsSafe(),
		LegacyPluginDataExposureError,
	);
	assert.deepEqual(client.downloadedPaths, []);
});

test("legacy service-name collision blocks migration before remote writes", async () => {
	const source = stable1xIndex();
	const files = source.files as Record<string, unknown>;
	files["notes/.obsidian-encrypt.json"] = {
		path: "notes/.obsidian-encrypt.json",
		sha256: "collision",
		size: 3,
		mtime: 1,
		syncedAt: 2,
	};
	const { manager, client } = await createIndexManagerWithContent(
		source,
		null,
	);
	await assert.rejects(
		manager.assertLegacyMigrationPathsSafe(),
		LegacyServicePathCollisionError,
	);
	assert.equal(client.moveCount, 0);
});

test("legacy paths that current normalization would rewrite block migration", async () => {
	const source = stable1xIndex();
	const files = source.files as Record<string, unknown>;
	files["notes\\name.md"] = {
		path: "notes\\name.md",
		sha256: "legacy-path",
		size: 3,
		mtime: 1,
		syncedAt: 2,
	};
	const { manager, client } = await createIndexManagerWithContent(
		source,
		null,
	);
	await assert.rejects(
		manager.assertLegacyMigrationPathsSafe(),
		LegacyServicePathCollisionError,
	);
	assert.equal(client.moveCount, 0);
});

test("legacy physical-only service collision is not silently filtered", async () => {
	const { manager, client } = await createIndexManagerWithContent(
		stable1xIndex(),
		null,
	);
	client.files.set(
		"vault/notes/.obsidian-encrypt.json",
		new TextEncoder().encode("user-content").buffer,
	);
	await assert.rejects(
		manager.assertLegacyMigrationPathsSafe(),
		LegacyServicePathCollisionError,
	);
});

test("encrypted legacy startup is rejected as unsupported data", async () => {
	const encryption = new XorEncryptionService(
		0xa5,
	) as unknown as EncryptionCodec;
	const { manager, client, canonicalPath } =
		await createIndexManagerWithContent(stable1xIndex(), encryption);
	const originalRaw = client.files.get(canonicalPath)!.slice(0);
	await assert.rejects(
		manager.loadRemoteIndex(),
		UnsupportedHistoricalDataError,
	);
	assert.deepEqual(
		new Uint8Array(client.files.get(canonicalPath)!),
		new Uint8Array(originalRaw),
	);
	assert.equal(client.moveCount, 0);
});

test("plaintext legacy index never falls back from an active encryption codec", async () => {
	const encryption = new XorEncryptionService(
		0xa5,
	) as unknown as EncryptionCodec;
	const { manager } = await createIndexManagerWithContent(
		stable1xIndex(),
		encryption,
		null,
	);
	await assert.rejects(manager.loadRemoteIndex(), UnreadableRemoteIndexError);
});

test("encrypted current index loads without plaintext fallback", async () => {
	const encryption = new XorEncryptionService(
		0xa5,
	) as unknown as EncryptionCodec;
	const { manager } = await createIndexManagerWithContent(
		{
			...createEmptyIndex("device-current", "epoch-current"),
			epoch: "epoch-current",
			revision: 4,
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
			...createEmptyIndex("device-current", "epoch-b"),
			epoch: "epoch-b",
			revision: 4,
		},
		null,
	);
	manager.loadLocalIndexFromData({
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

test("canonical file metadata preserves timestamp precision and validates causal counters", async () => {
	const index = createEmptyIndex("device-current", "epoch-current");
	index.revision = 4;
	index.files["note.md"] = {
		path: "note.md",
		sha256: "hash",
		size: 4,
		mtime: 1.375,
		syncedAt: 1,
		changedRevision: 4,
		baseRevision: 3,
		mutationSeq: 0,
		lastModifiedBy: "device-current",
	};
	index.appliedMutationSeq["device-current"] = 1;
	const { manager } = await createIndexManagerWithContent(index, null);
	assert.equal(
		(await manager.loadRemoteIndex()).files["note.md"]?.mtime,
		1.375,
	);
	for (const patch of [
		...[-1, NaN, Infinity, Number.MAX_VALUE, "1", null].map((mtime) => ({
			mtime,
		})),
		{ size: 1.375 },
		{ mutationSeq: 0.375 },
		{ changedRevision: 1.375 },
		{ mutationSeq: undefined },
		{ mutationSeq: 2 },
	]) {
		const invalid = structuredClone(index);
		Object.assign(invalid.files["note.md"]!, patch);
		const { manager, client } = await createIndexManagerWithContent(
			invalid,
			null,
		);
		await assert.rejects(
			manager.loadRemoteIndex(),
			InvalidCurrentIndexError,
		);
		assert.equal(client.moveCount, 0);
	}
});

test("malformed current canonical is rejected as a semantic index error", async () => {
	const malformed = createEmptyIndex("device-current", "epoch-current");
	(malformed as unknown as { files: unknown }).files = [];
	const { manager } = await createIndexManagerWithContent(malformed, null);
	await assert.rejects(
		manager.loadRemoteIndex(),
		(error: unknown) =>
			error instanceof InvalidCurrentIndexError &&
			error.section === "files",
	);
});

test("malformed maintenance is rejected before any remote write", async () => {
	const source = {
		enabled: true,
		revision: 1,
		salt: "source-salt",
		verifier: "source-verifier",
	};
	const target = {
		enabled: true,
		revision: 2,
		salt: "target-salt",
		verifier: "target-verifier",
	};
	const valid = {
		id: "transition-a",
		kind: "rotate" as const,
		phase: "index-committed" as const,
		initiatedBy: "device-a",
		sourceRevision: 4,
		targetRevision: 6,
		source,
		target,
		cleanup: [{ path: "old-raw", expectedFingerprint: "sha256:old" }],
	};
	const variants: unknown[] = [
		{ ...valid, extra: true },
		{ ...valid, phase: "prepared", targetRevision: 6 },
		{ ...valid, phase: "prepared", targetRevision: null },
		{ ...valid, targetRevision: null },
		{ ...valid, kind: "enable" },
		{
			...valid,
			cleanup: [
				{ path: ".backup/object", expectedFingerprint: "sha256:old" },
			],
		},
		{
			...valid,
			cleanup: [
				{ path: "old-raw", expectedFingerprint: "sha256:old" },
				{ path: "old-raw", expectedFingerprint: "sha256:old" },
			],
		},
	];
	for (const maintenance of variants) {
		const index = createEmptyIndex("device-current", "epoch-current");
		index.maintenance = maintenance as typeof index.maintenance;
		const { manager, client } = await createIndexManagerWithContent(
			index,
			null,
		);
		await assert.rejects(
			manager.loadRemoteIndex(),
			InvalidCurrentIndexError,
		);
		assert.equal(client.moveCount, 0);
	}
	for (const targetRevision of [5, 7]) {
		const index = createEmptyIndex("device-current", "epoch-current");
		index.revision = 6;
		index.maintenance = { ...valid, targetRevision };
		const { manager, client } = await createIndexManagerWithContent(
			index,
			null,
		);
		await assert.rejects(
			manager.loadRemoteIndex(),
			InvalidCurrentIndexError,
		);
		assert.equal(client.moveCount, 0);
	}
	for (const [phase, revision] of [
		["cleanup", 8],
		["stable", 6],
	] as const) {
		const index = createEmptyIndex("device-current", "epoch-current");
		index.revision = revision;
		index.maintenance = { ...valid, phase };
		const { manager, client } = await createIndexManagerWithContent(
			index,
			null,
		);
		await assert.rejects(
			manager.loadRemoteIndex(),
			InvalidCurrentIndexError,
		);
		assert.equal(client.moveCount, 0);
	}
	const staleSource = createEmptyIndex("device-current", "epoch-current");
	staleSource.revision = 6;
	staleSource.maintenance = { ...valid, sourceRevision: 6 };
	const { manager, client } = await createIndexManagerWithContent(
		staleSource,
		null,
	);
	await assert.rejects(manager.loadRemoteIndex(), InvalidCurrentIndexError);
	assert.equal(client.moveCount, 0);
});

test("current canonical rejects an extra numeric format marker", async () => {
	const current = {
		...createEmptyIndex("device-current", "epoch-current"),
		version: 4,
	};
	const { manager, client } = await createIndexManagerWithContent(
		current,
		null,
	);
	await assert.rejects(manager.loadRemoteIndex(), InvalidCurrentIndexError);
	assert.equal(client.moveCount, 0);
});

test("canonical transaction accepts causal continuation and rejects foreign edits", async () => {
	for (const author of ["device-a", "device-b"] as const) {
		const foreign = author === "device-b";
		const current = createEmptyIndex(author, "epoch-a");
		current.revision = 36;
		current.files["note.md"] = {
			path: "note.md",
			sha256: "previous",
			size: 8,
			mtime: 1,
			syncedAt: 1,
			changedRevision: 36,
			baseRevision: 35,
			lastModifiedBy: author,
			mutationSeq: foreign ? 3 : 7,
		};
		current.appliedMutationSeq = { "device-a": 7, "device-b": 3 };
		const { manager, client, canonicalPath } =
			await createIndexManagerWithContent(
				current,
				null,
				null,
				"device-a",
			);
		manager.loadLocalIndexFromData({
			deviceId: "device-a",
			observedEpoch: "epoch-a",
			observedRevision: 35,
			files: foreign
				? {}
				: { "note.md": { ...current.files["note.md"] } },
			folderTombstones: {},
			nextMutationSeq: 8,
		});
		manager.loadPendingMutations(undefined);
		await manager.loadRemoteIndex();
		const mutation = manager.enqueueMutation("put", "note.md", {
			sha256: "latest",
			baseRevision: 35,
			epoch: "epoch-a",
		});
		assert.equal(mutation.seq, 8, author);
		manager.updateRemoteFile("note.md", {
			...current.files["note.md"],
			sha256: "latest",
			lastModifiedBy: "device-a",
			baseRevision: 35,
			mutationSeq: mutation.seq,
			...(foreign ? { remoteFingerprint: "uploaded-device-a" } : {}),
		});
		manager.stageMutation(mutation);
		await manager.saveRemoteIndex();

		const canonical = JSON.parse(
			new TextDecoder().decode(client.files.get(canonicalPath)),
		) as ReturnType<typeof createEmptyIndex>;
		assert.equal(
			canonical.files["note.md"]?.sha256,
			foreign ? "previous" : "latest",
			author,
		);
		const rejected = manager.consumeRejectedPuts();
		if (foreign) {
			assert.equal(rejected[0]?.reason, "conflict");
		} else {
			assert.equal(canonical.revision, 37);
			assert.equal(canonical.files["note.md"]?.mutationSeq, 8);
			assert.equal(canonical.appliedMutationSeq["device-a"], 8);
			assert.deepEqual(rejected, []);
		}
	}
});

test("wrong encrypted index key is classified as unreadable", async () => {
	const currentEncryption =
		new RejectingEncryptionService() as unknown as EncryptionCodec;
	const storageEncryption = new XorEncryptionService(
		0x5a,
	) as unknown as EncryptionCodec;
	const { manager } = await createIndexManagerWithContent(
		{
			...createEmptyIndex("device-current", "epoch-current"),
			epoch: "epoch-current",
			revision: 4,
		},
		currentEncryption,
		storageEncryption,
	);
	await assert.rejects(
		manager.loadRemoteIndex(),
		(error: unknown) =>
			error instanceof UnreadableRemoteIndexError &&
			error.attempts.length === 1 &&
			error.attempts.some(
				(attempt) =>
					attempt.codec === "current" &&
					attempt.stage === "decrypt" &&
					attempt.errorName === "OperationError",
			),
	);
});

test("invalid plaintext index is classified as unreadable", async () => {
	const { manager } = await createIndexManagerWithContent("not-json", null);
	await assert.rejects(manager.loadRemoteIndex(), UnreadableRemoteIndexError);
});

test("historical format errors are not masked by codec fallback", async () => {
	const encryption = new XorEncryptionService(
		0xa5,
	) as unknown as EncryptionCodec;
	const { manager } = await createIndexManagerWithContent(
		{ version: 999, files: {} },
		encryption,
	);
	await assert.rejects(
		manager.loadRemoteIndex(),
		UnsupportedHistoricalDataError,
	);
});

test("numeric historical canonical formats are rejected during normal load", async () => {
	for (const version of [3, 4]) {
		const { manager, client } = await createIndexManagerWithContent(
			{ version, revision: 1, files: {} },
			null,
		);
		await assert.rejects(
			manager.loadRemoteIndex(),
			UnsupportedHistoricalDataError,
		);
		assert.equal(client.moveCount, 0);
	}
});

test("explicit transition codec does not fall back to plaintext", async () => {
	const encryption = new XorEncryptionService(
		0xa5,
	) as unknown as EncryptionCodec;
	const { manager, client, canonicalPath } =
		await createIndexManagerWithContent(
			{
				...createEmptyIndex("device-current", "epoch-current"),
				epoch: "epoch-current",
				revision: 1,
			},
			encryption,
			null,
		);
	const raw = client.files.get(canonicalPath)!;
	const decoder = manager as unknown as {
		decodeIndexSnapshot(
			content: ArrayBuffer,
			allowLegacy: boolean,
			service: EncryptionCodec | null,
			codec: "source",
		): Promise<unknown>;
	};
	await assert.rejects(
		decoder.decodeIndexSnapshot(raw, false, encryption, "source"),
		(error: unknown) =>
			error instanceof UnreadableRemoteIndexError &&
			error.attempts.length === 1 &&
			error.attempts[0]?.codec === "source",
	);
});

test("Force rejects numeric historical canonical before any remote move", async () => {
	const client = new FakeIndexYandex("vault", null);
	const canonicalPath = "vault/.obsidian-sync-index.json";
	const source = new TextEncoder().encode(
		JSON.stringify({
			version: 4,
			revision: 1,
			files: {},
		}),
	).buffer;
	client.files.set(canonicalPath, source.slice(0));
	const manager = new IndexManager(
		client as unknown as YandexDiskClient,
		{} as VaultAdapter,
		createSettings("device-a"),
	);
	manager.beginForceBootstrap(true);
	manager.updateRemoteFile("note.md", {
		path: "note.md",
		sha256: "hash",
		size: 4,
		mtime: 10,
		syncedAt: 10,
	});
	await assert.rejects(
		manager.saveRemoteIndex(),
		UnsupportedHistoricalDataError,
	);
	assert.equal(client.moveCount, 0);
	assert.deepEqual(
		new Uint8Array(client.files.get(canonicalPath)!),
		new Uint8Array(source),
	);
});

test("Force canonical proof becomes stale before any replacement write", async () => {
	const { manager, client, canonicalPath } =
		await createIndexManagerWithContent(
			createEmptyIndex("device-a", "epoch-a"),
			null,
		);
	const proof = await manager.captureForceCanonicalProof();
	const changed = createEmptyIndex("device-b", "epoch-b");
	changed.revision = 1;
	client.files.set(
		canonicalPath,
		new TextEncoder().encode(JSON.stringify(changed)).buffer,
	);
	await assert.rejects(
		manager.assertForceCanonicalProof(proof),
		ForceBackupStaleError,
	);
	assert.equal(client.moveCount, 0);
});

test("successful final move with a lost response still commits", async () => {
	const { client } = await runLegacyForceCommit(null, undefined, {
		throwAfterFinalMove: true,
	});
	assert.equal(client.moveCount, 2);
});

test("unverified modified lock restores the encrypted source bytes", async () => {
	const encryption = new XorEncryptionService(
		0x5a,
	) as unknown as EncryptionCodec;
	const client = new FakeIndexYandex("vault", encryption, {
		corruptIndexUpload: true,
	});
	const canonicalPath = "vault/.obsidian-sync-index.json";
	const current = createEmptyIndex("device-a", "epoch-a");
	const plain = new TextEncoder().encode(JSON.stringify(current)).buffer;
	client.files.set(canonicalPath, await encryption.encrypt(plain));
	const originalRaw = client.files.get(canonicalPath)!.slice(0);
	const manager = new IndexManager(
		client as unknown as YandexDiskClient,
		{} as VaultAdapter,
		createSettings("device-a"),
	);
	await manager.loadRemoteIndex();
	const mutation = manager.enqueueMutation("put", "note.md", {
		sha256: "hash",
		baseRevision: 0,
		epoch: "epoch-a",
	});
	manager.updateRemoteFile("note.md", {
		path: "note.md",
		sha256: "hash",
		size: 4,
		mtime: 10,
		syncedAt: 10,
		mutationSeq: mutation.seq,
		lastModifiedBy: "device-a",
		baseRevision: 0,
	});
	manager.stageMutation(mutation);

	await assert.rejects(manager.saveRemoteIndex(), RemoteIndexRolledBackError);
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

test("foreign target recovery survives restart at each persistent step without replaying old epoch work", async () => {
	const { EncryptionService, SALT_LENGTH } =
		await import("../src/crypto/encryption");
	const { EncryptionTransitionController } =
		await import("../src/crypto/encryption-transition");
	const { computeSha256 } = await import("../src/utils/hash-utils");
	const codec = new EncryptionService(new Uint8Array(SALT_LENGTH).fill(31));
	await codec.initializeKey("synthetic-target-password");
	const verifier = await codec.createVerifier();
	const bytes = new TextEncoder().encode("preserved target bytes").buffer;
	for (const kind of ["enable", "rotate", "disable"] as const) {
		const targetCodec = kind === "disable" ? null : codec;
		const rawTarget = targetCodec
			? await codec.encryptFilename("note.md")
			: "note.md";
		for (const crashAt of ["manifest", "canonical", "physical"] as const) {
			const canonical = createEmptyIndex("A", "E2");
			canonical.revision = 5;
			canonical.files["note.md"] = {
				path: "note.md",
				sha256: await computeSha256(bytes),
				size: bytes.byteLength,
				mtime: 1,
				syncedAt: 1,
				mutationSeq: 0,
				changedRevision: 5,
				baseRevision: 4,
				lastModifiedBy: "A",
			};
			const target = {
				enabled: targetCodec !== null,
				revision: targetCodec ? 2 : null,
				salt: targetCodec
					? EncryptionService.bytesToBase64(
							new Uint8Array(SALT_LENGTH).fill(31),
						)
					: null,
				verifier: targetCodec ? verifier : null,
			};
			canonical.maintenance = {
				id: "transition-A",
				kind,
				phase: "index-committed",
				initiatedBy: "A",
				sourceRevision: 4,
				targetRevision: 5,
				source:
					kind === "enable"
						? {
								enabled: false,
								revision: null,
								salt: null,
								verifier: null,
							}
						: {
								enabled: true,
								revision: 1,
								salt: "source-salt",
								verifier: "source-verifier",
							},
				target,
				cleanup: [],
			};
			const { client } = await createIndexManagerWithContent(
				canonical,
				targetCodec,
			);
			client.files.set(
				`vault/${rawTarget}`,
				targetCodec ? await targetCodec.encrypt(bytes) : bytes,
			);
			client.files.set("vault/old-object", bytes);
			canonical.maintenance.cleanup = [
				{
					path: "old-object",
					expectedFingerprint: (await client.getResource(
						"vault/old-object",
					))!.md5!,
				},
			];
			await client.uploadFile(
				"vault/.obsidian-sync-index.json",
				JSON.stringify(canonical),
			);
			let stablePublished = false;
			let interrupted = false;
			const run = async () => {
				const manager = new IndexManager(
					client as unknown as YandexDiskClient,
					{} as VaultAdapter,
					createSettings("B"),
				);
				manager.loadLocalIndexFromData({
					observedEpoch: "E1",
					observedRevision: 2,
					files: {},
					nextMutationSeq: 1,
				});
				manager.enqueueMutation("put", "offline.md", {
					sha256: "offline",
				});
				const saved = manager.captureLocalCausalState();
				const cleanupClient = {
					getResource: client.getResource.bind(client),
					getPhysicalPath: async () => `vault/${rawTarget}`,
					deleteResource: async (
						path: string,
						_permanent: boolean,
						_raw: boolean,
						guard: () => Promise<void>,
					) => {
						await guard();
						await client.deleteResource(path);
					},
				} as unknown as YandexDiskClient;
				const controller = new EncryptionTransitionController(
					manager,
					{} as never,
					{} as never,
					{
						client: cleanupClient,
						getRemotePath: () => "vault",
						completeAction: () => {},
						persist: async () => {},
					},
				);
				const crash = (step: typeof crashAt) => {
					if (!interrupted && step === crashAt) {
						interrupted = true;
						throw new Error(`crash:${step}`);
					}
				};
				try {
					await manager.runTargetMaintenanceRecovery(
						"transition-A",
						async () => {
							await manager.loadRemoteIndexWithTargetCodec(
								targetCodec,
							);
							await controller.completeRemoteTarget(
								manager.getMaintenance()!,
								async () => {
									stablePublished = true;
									crash("manifest");
								},
								async () => {
									assert.equal(stablePublished, true);
									assert.equal(
										manager.getMaintenance()?.phase,
										"cleanup",
									);
									crash("canonical");
									await controller.cleanupRawPaths(
										["old-object"],
										{
											"old-object":
												canonical.maintenance!
													.cleanup[0]!
													.expectedFingerprint,
										},
									);
									crash("physical");
									assert.equal(
										await controller.resumeCanonicalCleanup(),
										true,
									);
								},
							);
						},
					);
				} finally {
					assert.deepEqual(manager.captureLocalCausalState(), saved);
				}
				return manager;
			};
			await assert.rejects(run(), /crash:/);
			const recovered = await run();
			assert.equal(recovered.getMaintenance(), undefined);
			assert.equal(
				recovered.getRemoteIndex().files["offline.md"],
				undefined,
			);
			assert.equal(client.files.has("vault/old-object"), false);
			const stored = client.files.get(`vault/${rawTarget}`)!;
			assert.deepEqual(
				targetCodec ? await targetCodec.decrypt(stored) : stored,
				bytes,
			);
			await assert.rejects(
				recovered.loadRemoteIndex(),
				IndexEpochMismatchError,
			);
		}
	}
});
