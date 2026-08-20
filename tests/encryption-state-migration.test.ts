import assert from "node:assert/strict";
import test from "node:test";
import { UnsupportedPrereleaseDataError } from "../src/compatibility-errors";
import { migrateEncryptionPluginData } from "../src/crypto/encryption-state-migration";
import type { LocalEncryptionTransition } from "../src/crypto/encryption-transition";

function currentTransition(): LocalEncryptionTransition {
	return {
		id: "device:rotate:1",
		kind: "rotate",
		phase: "files-copied",
		source: {
			enabled: true,
			salt: "source",
			password: "source-password",
			revision: 1,
			profileId: "hardened-v3",
		},
		target: {
			enabled: true,
			salt: "target",
			password: "target-password",
			revision: 2,
			profileId: "hardened-v3",
		},
		sourceRawPaths: ["old"],
		targetRawPaths: ["new"],
		sourceFingerprints: { old: "sha256:old" },
		targetFingerprints: { new: "sha256:new" },
		sourceCanonicalRevision: 4,
	};
}

test("plaintext stable 1.0/1.1 data becomes an unobserved baseline with empty queues", () => {
	const migrated = migrateEncryptionPluginData({
		settings: {
			deviceId: "stable-device",
			syncInterval: 5,
		},
		localIndex: {
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
		},
		lastSyncStats: { uploaded: 1 },
	}) as unknown as {
		schemaVersion: 2;
		settings: {
			encryptionProfileId: string | null;
			deviceId: string;
			syncInterval: number;
		};
		localState: {
			observedEpoch: string | null;
			observedRevision: number;
			files: Record<string, { sha256: string }>;
		};
		pendingMutations: unknown[];
		pendingPhysicalActions: unknown[];
		pendingWatcherEvents: unknown[];
		encryptionTransition: LocalEncryptionTransition | null;
	};
	assert.equal(migrated?.schemaVersion, 2);
	assert.equal(migrated?.settings.encryptionProfileId, null);
	assert.equal(migrated?.settings.deviceId, "stable-device");
	assert.equal(migrated?.settings.syncInterval, 5);
	assert.equal(migrated?.localState.observedEpoch, null);
	assert.equal(migrated?.localState.observedRevision, 0);
	assert.equal(migrated?.localState.files["note.md"]?.sha256, "legacy-sha");
	assert.equal(migrated?.localState.files["invalid.md"], undefined);
	assert.deepEqual(migrated?.pendingMutations, []);
	assert.deepEqual(migrated?.pendingPhysicalActions, []);
	assert.deepEqual(migrated?.pendingWatcherEvents, []);
	assert.equal(migrated?.encryptionTransition, null);
});

test("current schema preserves causal data with explicit profiles", () => {
	const source = {
		schemaVersion: 2,
		settings: {
			enableEncryption: true,
			encryptionProfileId: "hardened-v3" as const,
		},
		localState: { version: 1, files: { "note.md": { sha256: "hash" } } },
		pendingMutations: [{ id: "mutation-1", seq: 7 }],
		pendingPhysicalActions: [{ id: "action-1", path: "note.md" }],
		pendingWatcherEvents: [{ id: "event-1", path: "note.md" }],
		encryptionTransition: currentTransition(),
		lastSyncStats: { uploaded: 1 },
	};
	const migrated = migrateEncryptionPluginData(source);
	assert.strictEqual(migrated, source);
});

test("unversioned beta queues are rejected", () => {
	assert.throws(
		() =>
			migrateEncryptionPluginData({
				settings: { enableEncryption: false },
				localState: { version: 1 },
				pendingMutations: [],
			}),
		UnsupportedPrereleaseDataError,
	);
});

test("partial unversioned data is not mistaken for stable 1.0/1.1", () => {
	assert.throws(
		() =>
			migrateEncryptionPluginData({
				settings: { enableEncryption: false },
				localIndex: null,
			}),
		UnsupportedPrereleaseDataError,
	);
});

test("stable 1.2 encryption-shaped data is deliberately unsupported", () => {
	for (const enableEncryption of [false, true]) {
		assert.throws(
			() =>
				migrateEncryptionPluginData({
					settings: {
						enableEncryption,
						encryptionSalt: enableEncryption ? "salt" : null,
						encryptedPassword: enableEncryption ? "password" : null,
					},
					localIndex: null,
					lastSyncStats: {},
				}),
			UnsupportedPrereleaseDataError,
		);
	}
});

test("current transition without profile metadata is rejected", () => {
	const transition = currentTransition() as unknown as {
		source: { profileId?: string };
	};
	delete transition.source.profileId;
	assert.throws(
		() =>
			migrateEncryptionPluginData({
				schemaVersion: 2,
				settings: {
					enableEncryption: true,
					encryptionProfileId: "hardened-v3",
				},
				localState: {},
				pendingMutations: [],
				pendingPhysicalActions: [],
				pendingWatcherEvents: [],
				encryptionTransition:
					transition as unknown as LocalEncryptionTransition,
				lastSyncStats: {},
			}),
		UnsupportedPrereleaseDataError,
	);
});

test("numbered prerelease schemas are rejected instead of downgraded", () => {
	assert.throws(
		() =>
			migrateEncryptionPluginData({
				schemaVersion: 1,
				settings: {},
			}),
		UnsupportedPrereleaseDataError,
	);
});
