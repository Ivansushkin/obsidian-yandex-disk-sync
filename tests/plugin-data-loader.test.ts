import assert from "node:assert/strict";
import test from "node:test";
import { UnsupportedHistoricalDataError } from "../src/compatibility-errors";
import {
	PLUGIN_DATA_FORMAT,
	loadPluginData,
	loadPluginDataWithSource,
} from "../src/plugin-data-loader";
import { parseStable1xIndex } from "../src/compatibility/stable-1x";
import {
	DEFAULT_SETTINGS,
	createEmptyLocalState,
	type LocalSyncState,
} from "../src/types";
import stableFilledFixture from "./fixtures/stable-1.1/plugin-data-filled.json";
import stableEmptyFixture from "./fixtures/stable-1.1/plugin-data-empty.json";
import { localSnapshot, localTransition } from "./helpers/crypto-fixtures";

test("stable timestamps allow filesystem precision without relaxing sizes or counters", () => {
	const source = structuredClone(stableFilledFixture);
	source.localIndex.files["note.md"].mtime += 0.375;
	assert.ok(parseStable1xIndex(source.localIndex));
	for (const invalid of [
		-1,
		NaN,
		Infinity,
		-Infinity,
		Number.MAX_VALUE,
		"1",
		null,
	]) {
		const index = structuredClone(source.localIndex);
		Object.assign(index.files["note.md"], { mtime: invalid });
		assert.equal(parseStable1xIndex(index), null);
	}
	for (const field of ["size", "syncedAt"] as const) {
		const index = structuredClone(source.localIndex);
		index.files["note.md"][field] += 0.375;
		assert.equal(parseStable1xIndex(index), null);
	}
});

test("stable snapshot rejection identifies only fixed schema sections", () => {
	const sentinel = "private-value-must-not-appear";
	for (const section of [
		"root fields",
		"settings",
		"localIndex",
		"lastSyncStats",
	]) {
		const source = structuredClone(stableFilledFixture);
		if (section === "root fields") {
			Object.assign(source, { [sentinel]: sentinel });
		} else {
			Object.assign(source, { [section]: { [sentinel]: sentinel } });
		}
		assert.throws(
			() => loadPluginData(source),
			(error: unknown) => {
				assert.ok(error instanceof UnsupportedHistoricalDataError);
				assert.ok(error.message.includes(`invalid ${section}`));
				assert.equal(error.message.includes(sentinel), false);
				return true;
			},
		);
	}
});

function currentTransition() {
	return localTransition({
		phase: "files-copied",
		source: localSnapshot("source", "source-password", 1),
		target: localSnapshot("target", "target-password", 2),
		sourceRawPaths: ["old"],
		targetRawByLogicalPath: { "note.md": "new" },
		sourceFingerprints: { old: "sha256:old" },
		targetFingerprints: { new: "sha256:new" },
	});
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

/** Build one current snapshot so rejection cases specify only their difference. */
function currentData<T extends Record<string, unknown>>(
	overrides: T = {} as T,
) {
	const data = {
		format: PLUGIN_DATA_FORMAT,
		settings: currentEncryptedSettings(),
		localState: null,
		pendingMutations: [],
		pendingPhysicalActions: [],
		pendingWatcherEvents: [],
		encryptionTransition: currentTransition(),
		forceRecovery: null,
		lastSyncStats: {},
	};
	return { ...data, ...overrides } as Omit<typeof data, keyof T> & T;
}

function rejectData(value: unknown, label?: string) {
	assert.throws(
		() => loadPluginData(value as never),
		UnsupportedHistoricalDataError,
		label,
	);
}

test("plaintext stable 1.0/1.1 data becomes an unobserved baseline with empty queues", () => {
	const source = structuredClone(stableFilledFixture);
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
	const migrated = loadPluginData(source) as unknown as ReturnType<
		typeof currentData
	> & {
		settings: typeof DEFAULT_SETTINGS;
		localState: LocalSyncState;
	};
	assert.deepEqual(migrated, {
		format: PLUGIN_DATA_FORMAT,
		settings: { ...source.settings, encryptionProfileId: null },
		localState: {
			...createEmptyLocalState(source.settings.deviceId),
			lastSyncTime: source.localIndex.lastSyncTime,
			files: {
				["__proto__"]: {
					...((source.localIndex.files as Record<string, unknown>)[
						"__proto__"
					] as object),
					deleted: undefined,
					deletedAt: undefined,
					lastModifiedBy: undefined,
				},
				"deleted.md": source.localIndex.files["deleted.md"],
				"note.md": {
					...source.localIndex.files["note.md"],
					deleted: undefined,
					deletedAt: undefined,
					lastModifiedBy:
						source.localIndex.files["note.md"].lastModifiedBy,
				},
			},
		},
		pendingMutations: [],
		pendingPhysicalActions: [],
		pendingWatcherEvents: [],
		encryptionTransition: null,
		forceRecovery: null,
		lastSyncStats: source.lastSyncStats,
	});
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

test("current semantic format preserves causal data with explicit profiles", () => {
	const source = currentData({
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
		lastSyncStats: { uploaded: 1 },
	});
	const migrated = loadPluginData(source);
	assert.deepEqual(migrated, {
		...source,
		localState: { ...source.localState, remoteScope: null },
	});
	assert.equal("remoteScope" in source.localState, false);
});

test("unsupported local formats fail closed instead of migrating", () => {
	assert.equal(loadPluginData(null), null);
	assert.equal(loadPluginData(undefined), null);
	const cases: [string, unknown][] = [
		...[0, "data", [], { arbitrary: true }].map(
			(value): [string, unknown] => ["arbitrary root", value],
		),
		["unmarked queues", { ...stableFilledFixture, pendingMutations: [] }],
		[
			"partial stable",
			{ settings: { enableEncryption: false }, localIndex: null },
		],
		["numeric schema", { schemaVersion: 2, settings: {} }],
		[
			"historical profile",
			currentData({
				settings: {
					enableEncryption: true,
					encryptionProfileId: "hardened-v3",
				},
				encryptionTransition: null,
			}),
		],
		...[false, true].map((enabled): [string, unknown] => [
			`legacy encryption ${enabled}`,
			{
				settings: {
					enableEncryption: enabled,
					encryptionSalt: enabled ? "salt" : null,
					encryptedPassword: enabled ? "password-placeholder" : null,
				},
				localIndex: null,
				lastSyncStats: {},
			},
		]),
	];
	for (const [label, value] of cases) {
		rejectData(value, label);
	}
});

test("persisted transitions reject missing authority invalid mappings and incompatible settings", () => {
	assert.doesNotThrow(() =>
		loadPluginData(
			currentData({
				encryptionTransition: {
					...currentTransition(),
					backupProof: null,
				},
			}),
		),
	);
	const sourceWithoutProfile = { ...currentTransition().source } as Record<
		string,
		unknown
	>;
	delete sourceWithoutProfile.profileId;
	const withoutBackup = { ...currentTransition() } as Record<string, unknown>;
	delete withoutBackup.backupProof;
	const historicalMapping = { ...currentTransition() } as Record<
		string,
		unknown
	>;
	delete historicalMapping.targetRawByLogicalPath;
	historicalMapping.targetRawPaths = ["new"];
	const cases: Array<[string, unknown]> = [
		[
			"source profile",
			currentData({
				encryptionTransition: {
					...currentTransition(),
					source: sourceWithoutProfile,
				},
			}),
		],
		["backup proof", currentData({ encryptionTransition: withoutBackup })],
		[
			"target proof",
			currentData({
				encryptionTransition: {
					...currentTransition(),
					targetFingerprints: {},
				},
			}),
		],
		[
			"historical mapping",
			currentData({ encryptionTransition: historicalMapping }),
		],
		...[
			{ "one.md": "same", "two.md": "same" },
			{ "one.md": "old" },
			{ "one.md": ".backup/object" },
		].map((targetRawByLogicalPath): [string, unknown] => [
			`target mapping ${JSON.stringify(targetRawByLogicalPath)}`,
			currentData({
				encryptionTransition: {
					...currentTransition(),
					targetRawByLogicalPath,
					targetFingerprints: {},
				},
			}),
		]),
		[
			"prototype source",
			currentData({
				encryptionTransition: {
					...currentTransition(),
					sourceRawPaths: ["__proto__"],
					sourceFingerprints: {},
				},
			}),
		],
		[
			"prototype target",
			currentData({
				encryptionTransition: {
					...currentTransition(),
					targetRawByLogicalPath: { "note.md": "__proto__" },
					targetFingerprints: {},
				},
			}),
		],
		[
			"unrelated settings",
			currentData({
				settings: {
					...currentEncryptedSettings(),
					encryptionSalt: "unrelated",
				},
			}),
		],
		[
			"numbered state",
			currentData({
				settings: DEFAULT_SETTINGS,
				localState: {
					...createEmptyLocalState("device-a"),
					version: 1,
				},
				encryptionTransition: null,
			}),
		],
	];
	for (const [label, value] of cases) {
		rejectData(value, label);
	}
});
