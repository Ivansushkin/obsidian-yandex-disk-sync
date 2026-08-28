import assert from "node:assert/strict";
import test from "node:test";
import { UnsupportedHistoricalDataError } from "../src/compatibility-errors";
import {
	PLUGIN_DATA_FORMAT,
	loadPluginData,
} from "../src/plugin-data-loader";
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
		targetRawPaths: ["new"],
		sourceFingerprints: { old: "sha256:old" },
		targetFingerprints: { new: "sha256:new" },
		sourceCanonicalRevision: 4,
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

test("current semantic format preserves causal data with explicit profiles", () => {
	const source = {
		format: PLUGIN_DATA_FORMAT,
		settings: {
			enableEncryption: true,
			encryptionProfileId: "hardened" as const,
		},
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
				settings: {
					enableEncryption: true,
					encryptionProfileId: "hardened",
				},
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
				settings: {
					enableEncryption: false,
					encryptionProfileId: null,
				},
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
