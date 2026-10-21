import { fileMetadata } from "./helpers/metadata";
import { MemoryDisk } from "./helpers/sync-flow";
import {
	encryptionManifest,
	transitionManifest,
	encryptedMode,
	plaintextMode,
	maintenance as createMaintenance,
} from "./helpers/crypto-fixtures";
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
	type FileMetadata,
} from "../src/types";
import type { EncryptionCodec } from "../src/crypto/encryption";
import { YandexDiskClient } from "../src/api/yandex-client";
import type { VaultAdapter } from "../src/api/vault-adapter";
import { logger } from "../src/utils/logger";
import { UnsupportedHistoricalDataError } from "../src/compatibility-errors";
import stableCanonicalFixture from "./fixtures/stable-1.1/canonical-v2.json";

logger.configure({ consoleEnabled: false, fileEnabled: false });

/** Reversible byte codec isolates index protocol tests from expensive KDF work. */
function xorCodec(key: number): EncryptionCodec {
	const transform = async (content: ArrayBuffer): Promise<ArrayBuffer> =>
		Uint8Array.from(new Uint8Array(content), (byte) => byte ^ key).buffer;
	return {
		encrypt: transform,
		decrypt: transform,
	} as unknown as EncryptionCodec;
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

/** Use production codec and stable-read behavior with synthetic HTTP faults. */
class FakeIndexYandex extends YandexDiskClient {
	readonly disk = new MemoryDisk();
	readonly files = this.disk.files;
	moveCount = 0;
	stableReadCount = 0;
	readonly downloadedPaths: string[] = [];
	private corruptUpload = false;

	constructor(
		remotePath: string,
		encryption: EncryptionCodec | null,
		faults: {
			throwAfterFinalMove?: boolean;
			corruptIndexUpload?: boolean;
			hashlessMetadata?: boolean;
		} = {},
	) {
		super({ token: "synthetic", maxRetries: 0, retryDelay: 0 });
		this.setRemotePath(remotePath);
		this.setEncryptionService(encryption);
		const resource = this.disk.resource.bind(this.disk);
		this.disk.resource = async (path) => {
			const result = await resource(path);
			if (result && faults.hashlessMetadata && this.files.has(path)) {
				result.modified = `content-${String(result.sha256)}-${path}`;
				delete result.sha256;
			}
			return result;
		};
		this.disk.beforeRequest = async (_method, endpoint, path) => {
			for (const name of this.files.keys()) {
				const parts = name.split("/");
				for (let depth = 1; depth < parts.length; depth++) {
					this.disk.folders.add(parts.slice(0, depth).join("/"));
				}
			}
			if (endpoint === "/download") {
				this.downloadedPaths.push(path);
			}
		};
		this.disk.afterRequest = async (method, endpoint, path) => {
			if (endpoint.endsWith("/resources/move")) {
				this.moveCount++;
				if (faults.throwAfterFinalMove && this.moveCount === 2) {
					throw new Error("lost final move response");
				}
			}
			if (
				faults.corruptIndexUpload &&
				this.corruptUpload &&
				endpoint === "/upload" &&
				method === "PUT" &&
				path.includes(".obsidian-sync-index.lock.")
			) {
				const bytes = new Uint8Array(this.files.get(path)!);
				bytes[0] = bytes[0]! ^ 0xff;
			}
		};
		this.disk.install();
	}

	override async uploadFile(
		...args: Parameters<YandexDiskClient["uploadFile"]>
	): Promise<void> {
		this.corruptUpload = !args[3];
		try {
			await super.uploadFile(...args);
		} finally {
			this.corruptUpload = false;
		}
	}

	override async downloadStableRawFile(
		...args: Parameters<YandexDiskClient["downloadStableRawFile"]>
	): ReturnType<YandexDiskClient["downloadStableRawFile"]> {
		this.stableReadCount++;
		return super.downloadStableRawFile(...args);
	}
}

function createSettings(deviceId: string): YandexDiskSyncSettings {
	return {
		...DEFAULT_SETTINGS,
		deviceId,
		remotePath: "vault",
	};
}

function indexManager(
	client: FakeIndexYandex,
	deviceId = "device-a",
): IndexManager {
	return new IndexManager(
		client,
		{} as VaultAdapter,
		createSettings(deviceId),
	);
}

/** Encode fixture JSON exactly as the service stores it. */
function jsonBytes(value: unknown): ArrayBuffer {
	return new TextEncoder().encode(JSON.stringify(value)).buffer;
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
}> {
	const client = new FakeIndexYandex("vault", encryption, faults);
	const canonicalPath = "vault/.obsidian-sync-index.json";
	const legacy = JSON.stringify(sourceIndex);
	const legacyBytes = new TextEncoder().encode(legacy).buffer;
	client.files.set(
		canonicalPath,
		encryption ? await encryption.encrypt(legacyBytes) : legacyBytes,
	);
	const manager = indexManager(client, "new-device");
	manager.beginForceBootstrap(true);
	manager.updateRemoteFile(
		"note.md",
		fileMetadata("note.md", {
			size: 4,
			mtime: 10.375,
			syncedAt: 10,
			remoteMtime: undefined,
		}),
	);

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
		faults.hashlessMetadata ? /^modified:/ : /^sha256:/,
	);
	assert.equal(
		client.stableReadCount,
		faults.hashlessMetadata ? 5 : faults.throwAfterFinalMove ? 4 : 3,
	);
	assert.deepEqual(
		[...client.files.keys()].filter((path) => path.includes(".lock.")),
		[],
	);
	return { client, manager };
}

test("plaintext stable 1.0/1.1 Force commits and verifies current canonical", async () => {
	for (const version of [1, 2] as const) {
		await runLegacyForceCommit(null, stable1xIndex(version));
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
	files["removed.md"] = fileMetadata("removed.md", {
		sha256: "removed-sha",
		size: 7,
		mtime: 8,
		syncedAt: 9,
	});
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
		value: fileMetadata("__proto__", {
			sha256: "proto-sha",
			size: 5,
			mtime: 6,
			syncedAt: 7,
		}),
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
	const encryption = xorCodec(0xa5);
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
	const manifest = encryptionManifest();
	client.files.set(manifestPath, jsonBytes(manifest));
	const manager = indexManager(client, "device-a");
	const read = await manager.downloadEncryptionManifestForGuard();
	assert.equal(
		await manager.isEncryptionManifestTokenCurrent(read.validationToken),
		true,
	);
	client.files.set(
		manifestPath,
		jsonBytes({ ...manifest, salt: "AQEBAQEBAQEBAQEBAQEBAQ==" }),
	);
	assert.equal(
		await manager.isEncryptionManifestTokenCurrent(read.validationToken),
		false,
	);
});

test("absent manifest token detects a newly created manifest", async () => {
	const client = new FakeIndexYandex("vault", null);
	const manager = indexManager(client, "device-a");
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
	client.files.set("vault/.obsidian-encrypt.json", jsonBytes(manifest));
	const manager = indexManager(client, "device-a");
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
	const hardened = encryptionManifest();
	const parsed = await readEncryptionManifest(hardened);
	assert.equal(parsed?.format, "encryption-manifest");
	assert.equal(parsed ? "version" in parsed : true, false);
	for (const [patch, error] of [
		[{ version: 3 }, /unsupported field version/],
		[
			{ filenameCipher: { ...hardened.filenameCipher, name: "AES-GCM" } },
			/unsupported profile/,
		],
		[
			{ kdf: { ...hardened.kdf, fallbackIterations: 100_000 } },
			/unsupported field fallbackIterations/,
		],
	] as const) {
		await assert.rejects(
			readEncryptionManifest({ ...hardened, ...patch }),
			error,
		);
	}
	const rotating = transitionManifest(
		"rotating",
		createMaintenance({
			phase: "prepared",
			sourceRevision: 1,
			targetRevision: null,
			source: encryptedMode(
				1,
				manifestCommon.salt,
				manifestCommon.verifier,
			),
			target: encryptedMode(
				2,
				"AQEBAQEBAQEBAQEBAQEBAQ==",
				"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==",
			),
		}),
	);
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
	index.maintenance = createMaintenance({
		initiatedBy: "source-device",
		sourceRevision: 1,
		targetRevision: 2,
		cleanup: [{ path: "old-raw", expectedFingerprint: "sha256:old" }],
	});
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
	const sourceEncryption = xorCodec(0xa5);
	const index = createEmptyIndex("source-device", "epoch-disable");
	index.revision = 2;
	index.maintenance = createMaintenance({
		id: "transition-disable",
		kind: "disable",
		initiatedBy: "source-device",
		sourceRevision: 1,
		targetRevision: 2,
		target: plaintextMode(),
	});
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
	activeEncryption: EncryptionCodec | null = null,
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
		manager: indexManager(client, deviceId),
		canonicalPath,
	};
}

test("plaintext stable 1.x startup preserves LegacyIndexFormatError", async () => {
	const { manager } = await createIndexManagerWithContent(stable1xIndex());
	await assert.rejects(manager.loadRemoteIndex(), LegacyIndexFormatError);
});

test("legacy protected plugin data blocks migration without content download", async () => {
	const source = stable1xIndex();
	const { manager, client, canonicalPath } =
		await createIndexManagerWithContent(source);
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
		await createIndexManagerWithContent(stable1xIndex());
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
	files["notes/.obsidian-encrypt.json"] = fileMetadata(
		"notes/.obsidian-encrypt.json",
		{ sha256: "collision", size: 3, syncedAt: 2 },
	);
	const { manager, client } = await createIndexManagerWithContent(source);
	await assert.rejects(
		manager.assertLegacyMigrationPathsSafe(),
		LegacyServicePathCollisionError,
	);
	assert.equal(client.moveCount, 0);
});

test("legacy paths that current normalization would rewrite block migration", async () => {
	const source = stable1xIndex();
	const files = source.files as Record<string, unknown>;
	files["notes\\name.md"] = fileMetadata("notes\\name.md", {
		sha256: "legacy-path",
		size: 3,
		syncedAt: 2,
	});
	const { manager, client } = await createIndexManagerWithContent(source);
	await assert.rejects(
		manager.assertLegacyMigrationPathsSafe(),
		LegacyServicePathCollisionError,
	);
	assert.equal(client.moveCount, 0);
});

test("legacy physical-only service collision is not silently filtered", async () => {
	const { manager, client } =
		await createIndexManagerWithContent(stable1xIndex());
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
	const encryption = xorCodec(0xa5);
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
	const encryption = xorCodec(0xa5);
	const { manager } = await createIndexManagerWithContent(
		stable1xIndex(),
		encryption,
		null,
	);
	await assert.rejects(manager.loadRemoteIndex(), UnreadableRemoteIndexError);
});

test("encrypted current index loads without plaintext fallback", async () => {
	const encryption = xorCodec(0xa5);
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
	index.files["note.md"] = fileMetadata("note.md", {
		size: 4,
		mtime: 1.375,
		changedRevision: 4,
		baseRevision: 3,
		mutationSeq: 0,
		lastModifiedBy: "device-current",
	});
	index.appliedMutationSeq["device-current"] = 1;
	const { manager } = await createIndexManagerWithContent(index);
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
		const { manager, client } =
			await createIndexManagerWithContent(invalid);
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
	const { manager } = await createIndexManagerWithContent(malformed);
	await assert.rejects(
		manager.loadRemoteIndex(),
		(error: unknown) =>
			error instanceof InvalidCurrentIndexError &&
			error.section === "files",
	);
});

test("malformed maintenance is rejected before any remote write", async () => {
	const source = encryptedMode();
	const target = encryptedMode(2, "target-salt", "target-verifier");
	const valid = createMaintenance({
		kind: "rotate" as const,
		phase: "index-committed" as const,
		targetRevision: 6,
		source,
		target,
		cleanup: [{ path: "old-raw", expectedFingerprint: "sha256:old" }],
	});
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
	const cases = [
		...variants.map((maintenance) => ({ revision: 0, maintenance })),
		...[5, 7].map((targetRevision) => ({
			revision: 6,
			maintenance: { ...valid, targetRevision },
		})),
		{ revision: 8, maintenance: { ...valid, phase: "cleanup" } },
		{ revision: 6, maintenance: { ...valid, phase: "stable" } },
		{ revision: 6, maintenance: { ...valid, sourceRevision: 6 } },
	];
	for (const { revision, maintenance } of cases) {
		const index = {
			...createEmptyIndex("device-current", "epoch-current"),
			revision,
			maintenance,
		};
		const { manager, client } = await createIndexManagerWithContent(index);
		await assert.rejects(
			manager.loadRemoteIndex(),
			InvalidCurrentIndexError,
		);
		assert.equal(client.moveCount, 0);
	}
});

test("current canonical rejects an extra numeric format marker", async () => {
	const current = {
		...createEmptyIndex("device-current", "epoch-current"),
		version: 4,
	};
	const { manager, client } = await createIndexManagerWithContent(current);
	await assert.rejects(manager.loadRemoteIndex(), InvalidCurrentIndexError);
	assert.equal(client.moveCount, 0);
});

test("canonical transaction accepts causal continuation and rejects foreign edits", async () => {
	for (const author of ["device-a", "device-b"] as const) {
		const foreign = author === "device-b";
		const current = createEmptyIndex(author, "epoch-a");
		current.revision = 36;
		current.files["note.md"] = fileMetadata("note.md", {
			sha256: "previous",
			size: 8,
			changedRevision: 36,
			baseRevision: 35,
			lastModifiedBy: author,
			mutationSeq: foreign ? 3 : 7,
		});
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
	const storageEncryption = xorCodec(0x5a);
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
	const { manager } = await createIndexManagerWithContent("not-json");
	await assert.rejects(manager.loadRemoteIndex(), UnreadableRemoteIndexError);
});

test("historical format errors are not masked by codec fallback", async () => {
	const encryption = xorCodec(0xa5);
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
	const encryption = xorCodec(0xa5);
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
	const source = jsonBytes({
		version: 4,
		revision: 1,
		files: {},
	});
	client.files.set(canonicalPath, source.slice(0));
	const manager = indexManager(client, "device-a");
	manager.beginForceBootstrap(true);
	manager.updateRemoteFile(
		"note.md",
		fileMetadata("note.md", { size: 4, mtime: 10, syncedAt: 10 }),
	);
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
	client.files.set(canonicalPath, jsonBytes(changed));
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
	const encryption = xorCodec(0x5a);
	const client = new FakeIndexYandex("vault", encryption, {
		corruptIndexUpload: true,
	});
	const canonicalPath = "vault/.obsidian-sync-index.json";
	const current = createEmptyIndex("device-a", "epoch-a");
	const plain = jsonBytes(current);
	client.files.set(canonicalPath, await encryption.encrypt(plain));
	const originalRaw = client.files.get(canonicalPath)!.slice(0);
	const manager = indexManager(client, "device-a");
	await manager.loadRemoteIndex();
	const mutation = manager.enqueueMutation("put", "note.md", {
		sha256: "hash",
		baseRevision: 0,
		epoch: "epoch-a",
	});
	manager.updateRemoteFile(
		"note.md",
		fileMetadata("note.md", {
			size: 4,
			mtime: 10,
			syncedAt: 10,
			mutationSeq: mutation.seq,
			lastModifiedBy: "device-a",
			baseRevision: 0,
		}),
	);
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
			canonical.files["note.md"] = fileMetadata("note.md", {
				sha256: await computeSha256(bytes),
				size: bytes.byteLength,
				mutationSeq: 0,
				changedRevision: 5,
				baseRevision: 4,
				lastModifiedBy: "A",
			});
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
			canonical.maintenance = createMaintenance({
				id: "transition-A",
				kind,
				initiatedBy: "A",
				source:
					kind === "enable"
						? plaintextMode()
						: encryptedMode(1, "source-salt", "source-verifier"),
				target,
			});
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
						1000,
						0,
						true,
					))!.sha256!,
				},
			];
			await client.uploadFile(
				"vault/.obsidian-sync-index.json",
				JSON.stringify(canonical),
			);
			let stablePublished = false;
			let interrupted = false;
			const run = async () => {
				const manager = indexManager(client, "B");
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

				const controller = new EncryptionTransitionController(
					manager,
					{} as never,
					{} as never,
					{
						client,
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
