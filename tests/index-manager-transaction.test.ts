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
	RemoteIndexConcurrentModificationError,
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
	type SyncIndex,
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

test("remote discovery rejects unprovable identity and rewritten paths", async () => {
	for (const [name, method, error] of [
		["note.md", "getRemoteRawFileSnapshots", /no stable fingerprint/],
		["notes\\name.md", "getRemoteFiles", PortablePathCollisionError],
	] as const) {
		const manager = new IndexManager(
			{
				getResourcesRecursive: async () => [
					{
						name,
						path: `vault/${name}`,
						type: "file",
						created: "",
						modified: "",
					},
				],
			} as unknown as YandexDiskClient,
			{} as VaultAdapter,
			createSettings("device-a"),
		);
		await assert.rejects(manager[method](), error, name);
	}
});

async function runLegacyForceCommit(
	encryption: EncryptionCodec | null,
	sourceIndex: Record<string, unknown> = stable1xIndex(),
	faults: {
		throwAfterFinalMove?: boolean;
		corruptIndexUpload?: boolean;
		hashlessMetadata?: boolean;
	} = {},
	label = "legacy Force",
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
	assert.equal(canonical.format, CURRENT_INDEX_FORMAT, label);
	assert.equal("version" in canonical, false, label);
	assert.equal(canonical.revision, 1, label);
	assert.ok(canonical.epoch, label);
	assert.equal(canonical.files["note.md"]?.mutationSeq, 0, label);
	assert.equal(canonical.files["note.md"]?.mtime, 10.375, label);
	assert.equal(manager.getObservedEpoch(), canonical.epoch, label);
	assert.equal(manager.getObservedRevision(), canonical.revision, label);
	assert.equal(client.moveCount, 2, label);
	assert.equal(proof.epoch, canonical.epoch, label);
	assert.equal(proof.revision, canonical.revision, label);
	assert.match(
		proof.contentFingerprint,
		faults.hashlessMetadata ? /^modified:/ : /^sha256:/,
		label,
	);
	assert.equal(
		client.stableReadCount,
		faults.hashlessMetadata ? 5 : faults.throwAfterFinalMove ? 4 : 3,
		label,
	);
	assert.deepEqual(
		[...client.files.keys()].filter((path) => path.includes(".lock.")),
		[],
		label,
	);
	return { client, manager };
}

test("stable plaintext Force preserves legacy edge paths and verifies canonical across transport faults", async () => {
	const source = structuredClone(stableCanonicalFixture);
	for (const metadata of Object.values(source.files)) {
		metadata.mtime += 0.375;
	}
	const removed = fileMetadata("removed.md", {
		sha256: "removed-sha",
		size: 7,
		mtime: 8,
		syncedAt: 9,
	});
	Object.assign(source.files, { "removed.md": removed });
	Object.defineProperty(source.files, "__proto__", {
		value: { ...removed, path: "__proto__" },
		enumerable: true,
	});
	for (const [label, legacy, faults] of [
		["stable 1.0", stable1xIndex(1), {}],
		["stable 1.1 edge paths", source, {}],
		["hashless canonical", stable1xIndex(2), { hashlessMetadata: true }],
		[
			"lost final move response",
			stable1xIndex(2),
			{ throwAfterFinalMove: true },
		],
	] as const) {
		const { manager } = await runLegacyForceCommit(
			null,
			legacy,
			faults,
			label,
		);
		if (label === "stable 1.1 edge paths") {
			const files = manager.getRemoteIndex().files;
			assert.equal(
				files["deleted.md"]?.mtime,
				source.files["deleted.md"].mtime,
			);
			for (const path of ["deleted.md", "removed.md", "__proto__"]) {
				assert.equal(
					Object.prototype.hasOwnProperty.call(files, path),
					true,
					path,
				);
				assert.equal(files[path]?.deleted, true, path);
				assert.equal(files[path]?.mutationSeq, 0, path);
			}
			assert.equal(files["removed.md"]?.lastModifiedBy, "new-device");
		}
	}
});

test("Force rejects unsupported history without moving or changing source bytes", async () => {
	for (const [label, content, codec] of [
		[
			"extra stable field",
			{ ...stable1xIndex(), pendingMutations: [] },
			null,
		],
		["encrypted legacy", stable1xIndex(), xorCodec(0xa5)],
		[
			"numeric current history",
			{ version: 4, revision: 1, files: {} },
			null,
		],
	] as const) {
		const { manager, client, canonicalPath } =
			await createIndexManagerWithContent(content, codec);
		const original = client.files.get(canonicalPath)!.slice(0);
		manager.beginForceBootstrap(true);
		manager.updateRemoteFile(
			"note.md",
			fileMetadata("note.md", { size: 4, mtime: 10, syncedAt: 10 }),
		);
		await assert.rejects(
			manager.saveRemoteIndex(),
			UnsupportedHistoricalDataError,
			label,
		);
		assert.equal(client.moveCount, 0, label);
		assert.deepEqual(client.files.get(canonicalPath), original, label);
	}
});

test("manifest guard tokens detect mutation from present and absent states", async () => {
	const manifestPath = "vault/.obsidian-encrypt.json";
	for (const present of [true, false]) {
		const client = new FakeIndexYandex("vault", null);
		const manifest = encryptionManifest();
		if (present) {
			client.files.set(manifestPath, jsonBytes(manifest));
		}
		const manager = indexManager(client);
		const { validationToken } =
			await manager.downloadEncryptionManifestForGuard();
		if (!present) {
			assert.equal(validationToken, "absent");
		}
		assert.equal(
			await manager.isEncryptionManifestTokenCurrent(validationToken),
			true,
		);
		client.files.set(
			manifestPath,
			jsonBytes({ ...manifest, salt: "AQEBAQEBAQEBAQEBAQEBAQ==" }),
		);
		assert.equal(
			await manager.isEncryptionManifestTokenCurrent(validationToken),
			false,
		);
	}
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

test("strict semantic manifest accepts only the hardened profile", async () => {
	for (const version of [1, 2, 3]) {
		await assert.rejects(
			readEncryptionManifest({ version, ...manifestCommon }),
			UnsupportedHistoricalDataError,
			`historical manifest ${version}`,
		);
	}
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

test("legacy migration rejects protected exposure and path collisions before user reads or writes", async () => {
	for (const [label, indexedPath, physicalPath, missingCanonical, error] of [
		[
			"indexed plugin exposure",
			null,
			"vault-config/plugins/yandex-disk-sync/data.json",
			false,
			LegacyPluginDataExposureError,
		],
		[
			"plugin exposure without canonical",
			null,
			"vault-config/plugins/yandex-disk-sync/data.json",
			true,
			LegacyPluginDataExposureError,
		],
		[
			"indexed service collision",
			"notes/.obsidian-encrypt.json",
			null,
			false,
			LegacyServicePathCollisionError,
		],
		[
			"rewritten legacy path",
			"notes\\name.md",
			null,
			false,
			LegacyServicePathCollisionError,
		],
		[
			"physical-only service collision",
			null,
			"notes/.obsidian-encrypt.json",
			false,
			LegacyServicePathCollisionError,
		],
	] as const) {
		const source = stable1xIndex();
		if (indexedPath) {
			(source.files as Record<string, unknown>)[indexedPath] =
				fileMetadata(indexedPath, {
					sha256: "collision",
					size: 3,
					syncedAt: 2,
				});
		}
		const { manager, client, canonicalPath } =
			await createIndexManagerWithContent(source);
		if (missingCanonical) {
			client.files.delete(canonicalPath);
		}
		if (physicalPath) {
			client.files.set(
				`vault/${physicalPath}`,
				jsonBytes("must-not-be-read"),
			);
		}
		await assert.rejects(
			manager.assertLegacyMigrationPathsSafe(),
			error,
			label,
		);
		assert.equal(client.moveCount, 0, label);
		assert.equal(
			client.downloadedPaths.every((path) => path === canonicalPath),
			true,
			label,
		);
		if (missingCanonical) {
			assert.deepEqual(client.downloadedPaths, [], label);
		}
	}
});

test("canonical load admission preserves history and active codec boundaries", async () => {
	const codec = xorCodec(0xa5);
	const current = {
		...createEmptyIndex("device-current", "epoch-current"),
		revision: 4,
	};
	for (const [label, content, active, storage, error] of [
		[
			"stable plaintext startup",
			stable1xIndex(),
			null,
			null,
			LegacyIndexFormatError,
		],
		[
			"encrypted legacy",
			stable1xIndex(),
			codec,
			codec,
			UnsupportedHistoricalDataError,
		],
		[
			"plaintext legacy with active codec",
			stable1xIndex(),
			codec,
			null,
			UnreadableRemoteIndexError,
		],
		["encrypted current", current, codec, codec, null],
		["malformed JSON", "not-json", null, null, UnreadableRemoteIndexError],
		[
			"encrypted historical format",
			{ version: 999, files: {} },
			codec,
			codec,
			UnsupportedHistoricalDataError,
		],
		[
			"numeric format 3",
			{ version: 3, revision: 1, files: {} },
			null,
			null,
			UnsupportedHistoricalDataError,
		],
		[
			"numeric format 4",
			{ version: 4, revision: 1, files: {} },
			null,
			null,
			UnsupportedHistoricalDataError,
		],
	] as const) {
		const { manager, client, canonicalPath } =
			await createIndexManagerWithContent(content, active, storage);
		const original = client.files.get(canonicalPath)!.slice(0);
		if (error) {
			await assert.rejects(manager.loadRemoteIndex(), error, label);
		} else {
			const loaded = await manager.loadRemoteIndex();
			assert.equal(loaded.epoch, "epoch-current", label);
			assert.equal(loaded.revision, 4, label);
		}
		assert.deepEqual(client.files.get(canonicalPath), original, label);
		assert.equal(client.moveCount, 0, label);
	}
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

test("canonical schema preserves precise metadata and rejects incoherent files and maintenance before writes", async () => {
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
	const maintenance = createMaintenance({
		kind: "rotate",
		phase: "index-committed",
		targetRevision: 6,
		source: encryptedMode(),
		target: encryptedMode(2, "target-salt", "target-verifier"),
		cleanup: [{ path: "old-raw", expectedFingerprint: "sha256:old" }],
	});
	const invalidFiles = [
		["negative mtime", { mtime: -1 }],
		["unsafe mtime", { mtime: Number.MAX_VALUE }],
		["string mtime", { mtime: "1" }],
		["null mtime", { mtime: null }],
		["fractional size", { size: 1.375 }],
		["fractional sequence", { mutationSeq: 0.375 }],
		["fractional revision", { changedRevision: 1.375 }],
		["missing sequence", { mutationSeq: undefined }],
		["unapplied sequence", { mutationSeq: 2 }],
	] as const;
	const invalidMaintenance = [
		["unknown field", 0, { extra: true }],
		[
			"prepared with target revision",
			0,
			{ phase: "prepared", targetRevision: 6 },
		],
		[
			"prepared with cleanup",
			0,
			{ phase: "prepared", targetRevision: null },
		],
		["committed without target revision", 0, { targetRevision: null }],
		["wrong kind", 0, { kind: "enable" }],
		[
			"protected cleanup",
			0,
			{
				cleanup: [
					{
						path: ".backup/object",
						expectedFingerprint: "sha256:old",
					},
				],
			},
		],
		[
			"duplicate cleanup",
			0,
			{ cleanup: [...maintenance.cleanup, ...maintenance.cleanup] },
		],
		["old target revision", 6, { targetRevision: 5 }],
		["future target revision", 6, { targetRevision: 7 }],
		["cleanup revision drift", 8, { phase: "cleanup" }],
		["stable cleanup remains", 6, { phase: "stable" }],
		["source after target", 6, { sourceRevision: 6 }],
	] as const;
	const cases = [
		...invalidFiles.map(([label, patch]) => ({
			label,
			value: {
				...index,
				files: { "note.md": { ...index.files["note.md"], ...patch } },
			},
			section: undefined,
		})),
		{
			label: "array files",
			value: { ...index, files: [] },
			section: "files",
		},
		{
			label: "numeric marker",
			value: { ...index, version: 4 },
			section: undefined,
		},
		...invalidMaintenance.map(([label, revision, patch]) => ({
			label,
			value: {
				...createEmptyIndex("device-current", "epoch-current"),
				revision,
				maintenance: { ...maintenance, ...patch },
			},
			section: undefined,
		})),
	];
	for (const { label, value, section } of cases) {
		const { manager, client } = await createIndexManagerWithContent(value);
		await assert.rejects(
			manager.loadRemoteIndex(),
			(error: unknown) =>
				error instanceof InvalidCurrentIndexError &&
				(!section || error.section === section),
			label,
		);
		assert.equal(client.moveCount, 0, label);
	}
});

test("physical metadata refresh preserves zero-sequence causality under canonical transactions", async () => {
	for (const concurrent of [
		"none",
		"same",
		"other",
		"edit",
		"delete",
		"missing",
		"rewrite",
	] as const) {
		const source = createEmptyIndex("device-a", "epoch-a");
		source.revision = 4;
		source.files["note.md"] = {
			path: "note.md",
			sha256: "plain",
			size: 8,
			mtime: 1,
			syncedAt: 1,
			changedRevision: 4,
			baseRevision: 3,
			lastModifiedBy: "device-a",
			mutationSeq: 0,
			remoteFingerprint: "sha256:cipher",
			remoteMtime: 1,
		};
		const { manager, client, canonicalPath } =
			await createIndexManagerWithContent(source, null);
		await manager.loadRemoteIndex();
		const desired = {
			...source.files["note.md"],
			remoteFingerprint: "cipher",
			remoteMtime: 2,
		};
		manager.updateRemoteFile("note.md", desired);
		const latest = structuredClone(source);
		if (concurrent !== "none") {
			latest.revision = 5;
		}
		if (concurrent === "same") {
			latest.files["note.md"] = desired;
		} else if (concurrent === "other") {
			latest.files["other.md"] = {
				...source.files["note.md"],
				path: "other.md",
			};
		} else if (concurrent === "missing") {
			delete latest.files["note.md"];
		} else if (concurrent === "rewrite") {
			latest.files["note.md"]!.remoteFingerprint = "new-cipher";
		} else if (concurrent === "edit" || concurrent === "delete") {
			Object.assign(latest.files["note.md"]!, {
				sha256: concurrent === "edit" ? "foreign" : "plain",
				deleted: concurrent === "delete",
				changedRevision: 5,
				lastModifiedBy: "device-b",
				mutationSeq: 1,
			});
			latest.appliedMutationSeq["device-b"] = 1;
		}
		client.files.set(
			canonicalPath,
			new TextEncoder().encode(JSON.stringify(latest)).buffer,
		);
		const shouldCommit = ["none", "same", "other"].includes(concurrent);
		if (shouldCommit) {
			await manager.saveRemoteIndex();
		} else {
			await assert.rejects(
				manager.saveRemoteIndex(),
				(error: unknown) =>
					error instanceof RemoteIndexRolledBackError &&
					error.cause instanceof
						RemoteIndexConcurrentModificationError,
			);
		}
		const actual = JSON.parse(
			new TextDecoder().decode(client.files.get(canonicalPath)),
		) as typeof source;
		assert.deepEqual(
			actual.files,
			shouldCommit
				? { ...latest.files, "note.md": desired }
				: latest.files,
			concurrent,
		);
		assert.deepEqual(
			actual.appliedMutationSeq,
			latest.appliedMutationSeq,
			concurrent,
		);
		assert.equal(
			actual.revision,
			latest.revision + (shouldCommit && concurrent !== "same" ? 1 : 0),
			concurrent,
		);
		assert.deepEqual(manager.getPendingMutations(), []);
		assert.equal(
			[...client.files.keys()].some((path) => path.includes(".lock.")),
			false,
		);
	}
});

test("physical metadata refresh cannot disguise invalid logical mutations", async () => {
	for (const [sequence, watermark] of [
		[0, 0],
		[1, 1],
		[3, 1],
	]) {
		const source = createEmptyIndex("device-a", "epoch-a");
		source.revision = 4;
		source.files["note.md"] = {
			path: "note.md",
			sha256: "plain",
			size: 8,
			mtime: 1,
			syncedAt: 1,
			changedRevision: 4,
			baseRevision: 3,
			lastModifiedBy: "device-a",
			mutationSeq: watermark,
			remoteFingerprint: "old",
		};
		source.appliedMutationSeq["device-a"] = watermark!;
		const { manager, client, canonicalPath } =
			await createIndexManagerWithContent(source, null);
		await manager.loadRemoteIndex();
		manager.updateRemoteFile("note.md", {
			...source.files["note.md"],
			sha256: "different",
			mutationSeq: sequence,
			remoteFingerprint: "new",
		});
		await assert.rejects(
			manager.saveRemoteIndex(),
			RemoteIndexRolledBackError,
		);
		assert.deepEqual(
			JSON.parse(
				new TextDecoder().decode(client.files.get(canonicalPath)),
			),
			source,
		);
	}
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

test("resolved lost move retains commit proof when the network fails after read-back", async () => {
	const codec = xorCodec(0x5a);
	const client = new FakeIndexYandex("vault", codec, {
		throwAfterFinalMove: true,
	});
	const canonicalPath = "vault/.obsidian-sync-index.json";
	client.files.set(
		canonicalPath,
		await codec.encrypt(jsonBytes(createEmptyIndex("device-a", "epoch-a"))),
	);
	const manager = indexManager(client);
	await manager.loadRemoteIndex();
	const mutation = manager.enqueueMutation("put", "note.md", {
		sha256: "hash",
		baseRevision: 0,
		epoch: "epoch-a",
	});
	manager.updateRemoteFile(
		"note.md",
		fileMetadata("note.md", {
			sha256: "hash",
			mutationSeq: mutation.seq,
			lastModifiedBy: "device-a",
			baseRevision: 0,
		}),
	);
	manager.stageMutation(mutation);
	const read = client.downloadStableRawFile.bind(client);
	client.downloadStableRawFile = async (...args) => {
		const snapshot = await read(...args);
		if (client.moveCount === 2 && args[0] === canonicalPath) {
			client.disk.beforeRequest = async () => {
				throw new Error("offline after verified commit");
			};
		}
		return snapshot;
	};

	const proof = await manager.saveRemoteIndex();
	const canonical = JSON.parse(
		new TextDecoder().decode(
			await codec.decrypt(client.files.get(canonicalPath)!),
		),
	) as SyncIndex;
	assert.equal(canonical.revision, 1);
	assert.equal(canonical.files["note.md"]?.sha256, "hash");
	assert.deepEqual(proof.index, canonical);
	assert.deepEqual(manager.getRemoteIndex(), canonical);
	assert.deepEqual(manager.getPendingMutations(), [mutation]);
	assert.equal(manager.getObservedRevision(), 0);
	assert.deepEqual([...client.files.keys()], [canonicalPath]);
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
					{ createReadLifetimeGuard: () => () => {} } as never,
					{} as never,
					{
						client,
						getRemotePath: () => "vault",
						getConcurrency: () => 1,
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
