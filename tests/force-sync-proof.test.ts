import assert from "node:assert/strict";
import test from "node:test";
import type { YandexDiskClient } from "../src/api/yandex-client";
import type { VaultAdapter } from "../src/api/vault-adapter";
import { SyncEngine } from "../src/sync/sync-engine";
import {
	ForceBackupStaleError,
	ForceSourceChangedError,
	type IndexManager,
} from "../src/sync/index-manager";
import { DEFAULT_SETTINGS } from "../src/types";
import { captureLogicalVaultSnapshot } from "../src/backup/backup-snapshot";
import { computeSha256 } from "../src/utils/hash-utils";
import type { FileMetadata } from "../src/types";

function metadata(
	path: string,
	sha256: string,
	remoteFingerprint = "fingerprint",
): FileMetadata {
	return {
		path,
		sha256,
		remoteFingerprint,
		remoteMtime: 10,
		size: 4,
		mtime: 10,
		syncedAt: 10,
	};
}

function createSourceProofAccess() {
	const engine = new SyncEngine(
		{} as YandexDiskClient,
		{} as VaultAdapter,
		{} as IndexManager,
		DEFAULT_SETTINGS,
	);
	return engine as unknown as {
		getForceLocalSourceIdentity(files: Map<string, FileMetadata>): string;
		getForceRemoteSourceIdentity(files: Map<string, FileMetadata>): string;
		assertForceLocalSourceUnchanged(
			expected: string,
			files: Map<string, FileMetadata>,
		): void;
		assertForceRemoteSourceUnchanged(
			expected: string,
			files: Map<string, FileMetadata>,
		): void;
	};
}

test("Force backup proof is required before any destructive operation", async () => {
	const engine = new SyncEngine(
		{
			getApiReadMetrics: () => ({}),
		} as unknown as YandexDiskClient,
		{} as VaultAdapter,
		{
			getLocalIndex: () => ({
				observedEpoch: null,
				observedRevision: 0,
			}),
			getRemoteIndex: () => ({ epoch: "epoch-a", revision: 0 }),
			getMaintenance: () => undefined,
			getPendingMutations: () => [],
			getPendingPhysicalActions: () => [],
		} as unknown as IndexManager,
		{ ...DEFAULT_SETTINGS, remotePath: "vault" },
	);
	const result = await engine.forceSyncFromLocal();
	assert.equal(result.success, false);
	assert.equal(result.errors[0]?.code, "force-backup-stale");
});

test("Force backup proof accepts only the matching protected snapshot", async () => {
	const encoder = new TextEncoder();
	const backupBytes = encoder.encode("verified-backup").buffer;
	let localBytes = encoder.encode("before").buffer;
	const vaultAdapter = {
		getAllSyncableFiles: () => [{ path: "note.md" }],
		readFile: async () => localBytes.slice(0),
	} as unknown as VaultAdapter;
	let canonicalChecked = false;
	const indexManager = {
		assertForceCanonicalProof: async () => {
			canonicalChecked = true;
		},
	} as unknown as IndexManager;
	const yandexClient = {
		getApiReadMetrics: () => ({}),
		downloadStableRawFile: async () => ({ raw: backupBytes.slice(0) }),
	} as unknown as YandexDiskClient;
	const engine = new SyncEngine(
		yandexClient,
		vaultAdapter,
		indexManager,
		{ ...DEFAULT_SETTINGS, remotePath: "vault" },
	);
	const access = engine as unknown as {
		assertForceBackupProof(
			direction: "from_remote",
			proof: {
				direction: "from_remote";
				canonical: { state: "absent" };
				snapshotDigest: string;
				backupName: string;
				backupSha256: string;
			},
		): Promise<void>;
	};
	const proof = {
		direction: "from_remote" as const,
		canonical: { state: "absent" as const },
		snapshotDigest: (await captureLogicalVaultSnapshot(vaultAdapter)).digest,
		backupName: "verified.zip",
		backupSha256: await computeSha256(backupBytes),
	};

	await access.assertForceBackupProof("from_remote", proof);
	assert.equal(canonicalChecked, true);
	localBytes = encoder.encode("after").buffer;
	await assert.rejects(
		access.assertForceBackupProof("from_remote", proof),
		ForceBackupStaleError,
	);
});

test("Force local source drift aborts before replacement commit", () => {
	const access = createSourceProofAccess();
	const source = new Map([["note.md", metadata("note.md", "before")]]);
	const identity = access.getForceLocalSourceIdentity(source);
	access.assertForceLocalSourceUnchanged(identity, source);
	const changed = new Map([["note.md", metadata("note.md", "after")]]);
	assert.throws(
		() => access.assertForceLocalSourceUnchanged(identity, changed),
		ForceSourceChangedError,
	);
});

test("Force remote source drift aborts before replacement commit", () => {
	const access = createSourceProofAccess();
	const source = new Map([
		["note.md", metadata("note.md", "logical", "remote-before")],
	]);
	const identity = access.getForceRemoteSourceIdentity(source);
	access.assertForceRemoteSourceUnchanged(identity, source);
	const changed = new Map([
		["note.md", metadata("note.md", "logical", "remote-after")],
	]);
	assert.throws(
		() => access.assertForceRemoteSourceUnchanged(identity, changed),
		ForceSourceChangedError,
	);
});
