import * as forceSync from "../src/sync/workflows/force";
import assert from "node:assert/strict";
import test from "node:test";
import type { YandexDiskClient } from "../src/api/yandex-client";
import type { VaultAdapter } from "../src/api/vault-adapter";
import { SyncEngine } from "../src/sync/engine";
import {
	ForceBackupStaleError,
	ForceSourceChangedError,
	type IndexManager,
} from "../src/sync/canonical/manager";
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
	const engine = new SyncEngine(yandexClient, vaultAdapter, indexManager, {
		...DEFAULT_SETTINGS,
		remotePath: "vault",
	});
	const deps = (
		engine as unknown as { forceSyncDependencies(): forceSync.Dependencies }
	).forceSyncDependencies();
	const proof = {
		direction: "from_remote" as const,
		canonical: { state: "absent" as const },
		snapshotDigest: (await captureLogicalVaultSnapshot(vaultAdapter))
			.digest,
		backupName: "verified.zip",
		backupSha256: await computeSha256(backupBytes),
	};

	const withoutArchive = {
		direction: proof.direction,
		canonical: proof.canonical,
		snapshotDigest: proof.snapshotDigest,
		backup: null,
	};
	const choices = [
		{ forceBackupProof: proof },
		{ forcePreflightProof: withoutArchive },
		{
			forcePreflightProof: {
				...withoutArchive,
				backup: {
					backupName: proof.backupName,
					backupSha256: proof.backupSha256,
				},
			},
		},
	];
	for (const options of choices) {
		localBytes = encoder.encode("before").buffer;
		await forceSync.assertForcePreflightProof(deps, "from_remote", options);
		assert.equal(canonicalChecked, true);
		localBytes = encoder.encode("after").buffer;
		await assert.rejects(
			forceSync.assertForcePreflightProof(deps, "from_remote", options),
			ForceBackupStaleError,
		);
	}
	await assert.rejects(
		forceSync.assertForcePreflightProof(deps, "from_remote", {
			forceBackupProof: proof,
			forcePreflightProof: withoutArchive,
		}),
		/Conflicting Force proofs/,
	);
});

test("Force source identity rejects local content and remote fingerprint drift", () => {
	for (const [getIdentity, assertUnchanged, source, changed] of [
		[
			forceSync.getForceLocalSourceIdentity,
			forceSync.assertForceLocalSourceUnchanged,
			metadata("note.md", "before"),
			metadata("note.md", "after"),
		],
		[
			forceSync.getForceRemoteSourceIdentity,
			forceSync.assertForceRemoteSourceUnchanged,
			metadata("note.md", "logical", "before"),
			metadata("note.md", "logical", "after"),
		],
	] as const) {
		const snapshot = new Map([[source.path, source]]);
		const identity = getIdentity(snapshot);
		assertUnchanged(identity, snapshot);
		assert.throws(
			() => assertUnchanged(identity, new Map([[changed.path, changed]])),
			ForceSourceChangedError,
		);
	}
});
