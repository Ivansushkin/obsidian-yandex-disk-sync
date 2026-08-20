import assert from "node:assert/strict";
import test from "node:test";
import { migrateEncryptionPluginData } from "../src/crypto/encryption-state-migration";
import type { LocalEncryptionTransition } from "../src/crypto/encryption-transition";

function legacyTransition(): LocalEncryptionTransition {
	return {
		id: "device:rotate:1",
		kind: "rotate",
		phase: "files-copied",
		source: {
			enabled: true,
			salt: "source",
			password: "source-password",
			revision: 1,
		},
		target: {
			enabled: true,
			salt: "target",
			password: "target-password",
			revision: 2,
		},
		sourceRawPaths: ["old"],
		targetRawPaths: ["new"],
		sourceFingerprints: { old: "sha256:old" },
		targetFingerprints: { new: "sha256:new" },
		sourceCanonicalRevision: 4,
	};
}

test("plugin data migration preserves every causal queue and baseline", () => {
	const causal = {
		localState: { version: 1, files: { "note.md": { sha256: "hash" } } },
		pendingMutations: [{ id: "mutation-1", seq: 7 }],
		pendingPhysicalActions: [{ id: "action-1", path: "note.md" }],
		pendingWatcherEvents: [{ id: "event-1", path: "note.md" }],
	};
	const source = {
		...causal,
		settings: { enableEncryption: true },
		encryptionTransition: legacyTransition(),
	};
	const migrated = migrateEncryptionPluginData(source)!;
	assert.equal(migrated.schemaVersion, 2);
	assert.equal(migrated.settings.encryptionProfileId, "legacy-v2");
	assert.equal(
		migrated.encryptionTransition?.source.profileId,
		"legacy-v2",
	);
	assert.equal(
		migrated.encryptionTransition?.target.profileId,
		"legacy-v2",
	);
	for (const key of Object.keys(causal) as Array<keyof typeof causal>) {
		assert.deepEqual(migrated[key], causal[key]);
	}
});

test("plugin data migration rejects future schemas instead of downgrading", () => {
	assert.throws(
		() =>
			migrateEncryptionPluginData({
				schemaVersion: 3,
				settings: {},
			}),
		/Unsupported plugin data schema/,
	);
});
