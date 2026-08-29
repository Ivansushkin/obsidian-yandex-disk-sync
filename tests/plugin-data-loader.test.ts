import assert from "node:assert/strict";
import test from "node:test";
import { UnsupportedHistoricalDataError } from "../src/compatibility-errors";
import {
	PLUGIN_DATA_FORMAT,
	loadPluginData,
	loadPluginDataWithSource,
} from "../src/plugin-data-loader";
import { serializeStable1xPluginData } from "../src/compatibility/stable-1x";
import { DEFAULT_SETTINGS } from "../src/types";
import stableFilledFixture from "./fixtures/stable-1.1/plugin-data-filled.json";
import stableEmptyFixture from "./fixtures/stable-1.1/plugin-data-empty.json";
import type { LocalEncryptionTransition } from "../src/crypto/encryption-transition";

function stable1xSettings() {
	return {
		yandexTokenSecret: "stable-token",
		clientId: "stable-client",
		remotePath: "stable-vault",
		syncInterval: 5,
		enableRealtimeSync: true,
		syncPatterns: ["**"],
		excludePatterns: ["cache"],
		syncDotObsidian: false,
		deviceId: "stable-device",
		debounceDelay: 1000,
		maxConcurrency: 10,
	};
}

function stable1xStats() {
	return {
		uploaded: 1,
		downloaded: 2,
		deleted: 3,
		errors: 4,
	};
}

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
			profileId: "hardened",
		},
		target: {
			enabled: true,
			salt: "target",
			password: "target-password",
			revision: 2,
			profileId: "hardened",
		},
		sourceRawPaths: ["old"],
		targetRawByLogicalPath: { "note.md": "new" },
		sourceFingerprints: { old: "sha256:old" },
		targetFingerprints: { new: "sha256:new" },
		sourceCanonicalRevision: 4,
		backupProof: {
			path: ".backup/transition.enc.zip",
			sha256: "backup-sha",
			epoch: "epoch-a",
			canonicalRevision: 4,
			localSnapshotDigest: "snapshot-sha",
			createdAt: 1,
		},
	};
}

function currentEncryptedSettings() {
	return {
		enableEncryption: true,
		encryptionSalt: "target",
		encryptionPassword: "target-password",
		encryptionRevision: 2,
		encryptionProfileId: "hardened" as const,
	};
}

function currentPlaintextSettings() {
	return {
		enableEncryption: false,
		encryptionSalt: null,
		encryptionPassword: null,
		encryptionRevision: null,
		encryptionProfileId: null,
	};
}

test("fresh plugin data accepts nullish storage and rejects arbitrary roots", () => {
	assert.equal(loadPluginData(null), null);
	assert.equal(loadPluginData(undefined), null);
	for (const value of [0, "data", [], { arbitrary: true }]) {
		assert.throws(
			() => loadPluginData(value as never),
			UnsupportedHistoricalDataError,
		);
	}
});

test("plaintext stable 1.0/1.1 data becomes an unobserved baseline with empty queues", () => {
	const migrated = loadPluginData({
		settings: stable1xSettings(),
		localIndex: {
			version: 2,
			lastSyncTime: 10,
			deviceId: "stable-device",
			files: {
				"note.md": {
					path: "note.md",
					sha256: "legacy-sha",
					size: 7,
					mtime: 8,
					syncedAt: 9,
				},
			},
		},
		lastSyncStats: stable1xStats(),
	}) as unknown as {
		format: "plugin-data";
		settings: {
			encryptionProfileId: string | null;
			deviceId: string;
			syncInterval: number;
			syncPatterns: string[];
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
		lastSyncStats: ReturnType<typeof stable1xStats>;
	};
	assert.ok(migrated);
	assert.equal(migrated?.format, PLUGIN_DATA_FORMAT);
	assert.equal("schemaVersion" in migrated, false);
	assert.equal("version" in migrated, false);
	assert.equal("version" in migrated.localState, false);
	assert.equal(migrated?.settings.encryptionProfileId, null);
	assert.equal(migrated?.settings.deviceId, "stable-device");
	assert.equal(migrated?.settings.syncInterval, 5);
	assert.deepEqual(migrated?.settings.syncPatterns, ["**"]);
	assert.equal(migrated?.localState.observedEpoch, null);
	assert.equal(migrated?.localState.observedRevision, 0);
	assert.equal(migrated?.localState.files["note.md"]?.sha256, "legacy-sha");
	assert.deepEqual(migrated?.pendingMutations, []);
	assert.deepEqual(migrated?.pendingPhysicalActions, []);
	assert.deepEqual(migrated?.pendingWatcherEvents, []);
	assert.equal(migrated?.encryptionTransition, null);
	assert.deepEqual(migrated?.lastSyncStats, stable1xStats());
});

test("stable 1.1 data remains rollback-readable until verified Force cutover", () => {
	const loaded = loadPluginDataWithSource(stableFilledFixture);
	assert.equal(loaded.source, "stable-1x");
	assert.ok(loaded.stableSnapshot);
	const inMemorySettings = {
		...DEFAULT_SETTINGS,
		...loaded.data?.settings,
		deviceId: "current-installation-id",
		remotePath: "changed/remote-path",
	};
	const persisted = serializeStable1xPluginData(
		loaded.stableSnapshot,
		inMemorySettings,
	);
	assert.deepEqual(Object.keys(persisted).sort(), [
		"lastSyncStats",
		"localIndex",
		"settings",
	]);
	assert.equal("format" in persisted, false);
	assert.equal(persisted.settings.deviceId, "stable-device-filled");
	assert.equal(persisted.settings.remotePath, "changed/remote-path");
	assert.ok(loadPluginDataWithSource(persisted).stableSnapshot);
});

test("stable 1.1 empty golden fixture preserves zero interval and config sync", () => {
	const loaded = loadPluginDataWithSource(stableEmptyFixture);
	const current = loaded.data as unknown as {
		settings: { syncInterval: number; syncDotObsidian: boolean };
		localState: { lastSyncTime: number };
	};
	assert.equal(loaded.source, "stable-1x");
	assert.equal(current.settings.syncInterval, 0);
	assert.equal(current.settings.syncDotObsidian, true);
	assert.equal(current.localState.lastSyncTime, 0);
});

test("legacy root __proto__ path survives stable conversion", () => {
	const source = JSON.parse(JSON.stringify(stableFilledFixture)) as typeof stableFilledFixture;
	if (!source.localIndex) throw new Error("fixture local index is missing");
	Object.defineProperty(source.localIndex.files, "__proto__", {
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
	const loaded = loadPluginDataWithSource(source);
	const current = loaded.data as unknown as {
		localState: { files: Record<string, { sha256: string }> };
	};
	assert.equal(loaded.source, "stable-1x");
	assert.equal(
		Object.prototype.hasOwnProperty.call(
			current.localState.files,
			"__proto__",
		),
		true,
	);
	assert.equal(
		current.localState.files["__proto__"]?.sha256,
		"proto-sha",
	);
});

test("current semantic format preserves causal data with explicit profiles", () => {
	const source = {
		format: PLUGIN_DATA_FORMAT,
		settings: currentEncryptedSettings(),
		localState: {
			deviceId: "device-a",
			observedEpoch: "epoch-a",
			observedRevision: 4,
			lastSyncTime: 5,
			files: { "note.md": { sha256: "hash" } },
			folderTombstones: {},
			nextMutationSeq: 8,
		},
		pendingMutations: [{ id: "mutation-1", seq: 7 }],
		pendingPhysicalActions: [{ id: "action-1", path: "note.md" }],
		pendingWatcherEvents: [{ id: "event-1", path: "note.md" }],
		encryptionTransition: currentTransition(),
		lastSyncStats: { uploaded: 1 },
	};
	const migrated = loadPluginData(source);
	assert.strictEqual(migrated, source);
});

test("already converted current local data can finish a stable 1.1 migration", () => {
	const current = {
		format: PLUGIN_DATA_FORMAT,
		settings: currentPlaintextSettings(),
		localState: null,
		pendingMutations: [],
		pendingPhysicalActions: [],
		pendingWatcherEvents: [],
		encryptionTransition: null,
		lastSyncStats: {},
	};
	const loaded = loadPluginDataWithSource(current);
	assert.equal(loaded.source, "current");
	assert.strictEqual(loaded.data, current);
	assert.equal(loaded.stableSnapshot, null);
});

test("unmarked historical queues are rejected", () => {
	assert.throws(
		() =>
			loadPluginData({
				settings: stable1xSettings(),
				localIndex: null,
				lastSyncStats: stable1xStats(),
				pendingMutations: [],
			}),
		UnsupportedHistoricalDataError,
	);
});

test("partial unmarked data is not mistaken for stable 1.0/1.1", () => {
	assert.throws(
		() =>
			loadPluginData({
				settings: { enableEncryption: false },
				localIndex: null,
			}),
		UnsupportedHistoricalDataError,
	);
});

test("unmarked encrypted legacy data is deliberately unsupported", () => {
	for (const enableEncryption of [false, true]) {
		assert.throws(
			() =>
				loadPluginData({
					settings: {
						enableEncryption,
						encryptionSalt: enableEncryption ? "salt" : null,
						encryptedPassword: enableEncryption ? "password" : null,
					},
					localIndex: null,
					lastSyncStats: {},
				}),
			UnsupportedHistoricalDataError,
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
			loadPluginData({
				format: PLUGIN_DATA_FORMAT,
				settings: currentEncryptedSettings(),
				localState: null,
				pendingMutations: [],
				pendingPhysicalActions: [],
				pendingWatcherEvents: [],
				encryptionTransition:
					transition as unknown as LocalEncryptionTransition,
				lastSyncStats: {},
			}),
		UnsupportedHistoricalDataError,
	);
});

test("current transition without mandatory backup proof is rejected", () => {
	const transition = currentTransition() as unknown as Record<string, unknown>;
	delete transition.backupProof;
	assert.throws(
		() =>
			loadPluginData({
				format: PLUGIN_DATA_FORMAT,
				settings: currentEncryptedSettings(),
				localState: null,
				pendingMutations: [],
				pendingPhysicalActions: [],
				pendingWatcherEvents: [],
				encryptionTransition:
					transition as unknown as LocalEncryptionTransition,
				lastSyncStats: {},
			}),
		UnsupportedHistoricalDataError,
	);
});

test("current transition requires an injective disjoint target mapping", () => {
	for (const targetRawByLogicalPath of [
		{ "one.md": "same", "two.md": "same" },
		{ "one.md": "old" },
		{ "one.md": ".backup/object" },
	] as Array<Record<string, string>>) {
		const transition = {
			...currentTransition(),
			targetRawByLogicalPath,
			targetFingerprints: {},
		};
		assert.throws(
			() =>
				loadPluginData({
					format: PLUGIN_DATA_FORMAT,
					settings: currentEncryptedSettings(),
					localState: null,
					pendingMutations: [],
					pendingPhysicalActions: [],
					pendingWatcherEvents: [],
					encryptionTransition: transition,
					lastSyncStats: {},
				}),
			UnsupportedHistoricalDataError,
		);
	}
});

test("copied transition requires a fingerprint for every target object", () => {
	const transition = currentTransition();
	transition.targetFingerprints = {};
	assert.throws(
		() =>
			loadPluginData({
				format: PLUGIN_DATA_FORMAT,
				settings: currentEncryptedSettings(),
				localState: null,
				pendingMutations: [],
				pendingPhysicalActions: [],
				pendingWatcherEvents: [],
				encryptionTransition: transition,
				lastSyncStats: {},
			}),
		UnsupportedHistoricalDataError,
	);
});

test("__proto__ transition paths cannot impersonate persisted fingerprints", () => {
	const missingSourceFingerprint = currentTransition();
	missingSourceFingerprint.sourceRawPaths = ["__proto__"];
	missingSourceFingerprint.sourceFingerprints = {};
	assert.throws(
		() =>
			loadPluginData({
				format: PLUGIN_DATA_FORMAT,
				settings: currentEncryptedSettings(),
				localState: null,
				pendingMutations: [],
				pendingPhysicalActions: [],
				pendingWatcherEvents: [],
				encryptionTransition: missingSourceFingerprint,
				lastSyncStats: {},
			}),
		UnsupportedHistoricalDataError,
	);

	const missingTargetFingerprint = currentTransition();
	missingTargetFingerprint.targetRawByLogicalPath = {
		"note.md": "__proto__",
	};
	missingTargetFingerprint.targetFingerprints = {};
	assert.throws(
		() =>
			loadPluginData({
				format: PLUGIN_DATA_FORMAT,
				settings: currentEncryptedSettings(),
				localState: null,
				pendingMutations: [],
				pendingPhysicalActions: [],
				pendingWatcherEvents: [],
				encryptionTransition: missingTargetFingerprint,
				lastSyncStats: {},
			}),
		UnsupportedHistoricalDataError,
	);
});

test("current settings must match the source or target transition mode", () => {
	assert.throws(
		() =>
			loadPluginData({
				format: PLUGIN_DATA_FORMAT,
				settings: {
					...currentEncryptedSettings(),
					encryptionSalt: "unrelated",
				},
				localState: null,
				pendingMutations: [],
				pendingPhysicalActions: [],
				pendingWatcherEvents: [],
				encryptionTransition: currentTransition(),
				lastSyncStats: {},
			}),
		UnsupportedHistoricalDataError,
	);
});

test("historical transition target path arrays are rejected", () => {
	const transition = currentTransition() as unknown as Record<string, unknown>;
	delete transition.targetRawByLogicalPath;
	transition.targetRawPaths = ["new"];
	assert.throws(
		() =>
			loadPluginData({
				format: PLUGIN_DATA_FORMAT,
				settings: currentEncryptedSettings(),
				localState: null,
				pendingMutations: [],
				pendingPhysicalActions: [],
				pendingWatcherEvents: [],
				encryptionTransition:
					transition as unknown as LocalEncryptionTransition,
				lastSyncStats: {},
			}),
		UnsupportedHistoricalDataError,
	);
});

test("numbered local state marker is rejected from current plugin data", () => {
	assert.throws(
		() =>
			loadPluginData({
				format: PLUGIN_DATA_FORMAT,
				settings: currentPlaintextSettings(),
				localState: {
					version: 1,
					deviceId: "device-a",
					observedEpoch: null,
					observedRevision: 0,
					lastSyncTime: 0,
					files: {},
					folderTombstones: {},
					nextMutationSeq: 1,
				},
				pendingMutations: [],
				pendingPhysicalActions: [],
				pendingWatcherEvents: [],
				encryptionTransition: null,
				lastSyncStats: {},
			}),
		UnsupportedHistoricalDataError,
	);
});

test("numeric historical plugin schemas are rejected instead of downgraded", () => {
	assert.throws(
		() =>
			loadPluginData({
				schemaVersion: 2,
				settings: {},
			}),
		UnsupportedHistoricalDataError,
	);
});

test("historical encryption profile is rejected from current plugin data", () => {
	assert.throws(
		() =>
			loadPluginData({
				format: PLUGIN_DATA_FORMAT,
				settings: {
					enableEncryption: true,
					encryptionProfileId: "hardened-v3",
				} as never,
				localState: null,
				pendingMutations: [],
				pendingPhysicalActions: [],
				pendingWatcherEvents: [],
				encryptionTransition: null,
				lastSyncStats: {},
			}),
		UnsupportedHistoricalDataError,
	);
});
