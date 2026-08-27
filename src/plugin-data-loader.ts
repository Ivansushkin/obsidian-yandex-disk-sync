import type {
	FileMetadata,
	LocalSyncState,
	YandexDiskSyncSettings,
} from "./types";
import { UnsupportedHistoricalDataError } from "./compatibility-errors";
import {
	parseStable1xPluginData,
	type Stable1xIndex,
} from "./compatibility/stable-1x";
import type { LocalEncryptionTransition } from "./crypto/encryption-transition";

interface PersistedPluginData {
	format?: unknown;
	settings?: Partial<YandexDiskSyncSettings>;
	localState?: unknown;
	pendingMutations?: unknown;
	pendingPhysicalActions?: unknown;
	pendingWatcherEvents?: unknown;
	encryptionTransition?: LocalEncryptionTransition | null;
	lastSyncStats?: unknown;
}

export const PLUGIN_DATA_FORMAT = "plugin-data" as const;

const CURRENT_PLUGIN_DATA_KEYS = new Set([
	"format",
	"settings",
	"localState",
	"pendingMutations",
	"pendingPhysicalActions",
	"pendingWatcherEvents",
	"encryptionTransition",
	"lastSyncStats",
]);

/**
 * Load current plugin data or convert the exact top-level shape persisted by
 * plaintext stable 1.0/1.1. Other unmarked data is not migrated.
 */
export function loadPluginData<T extends PersistedPluginData>(
	data: T | null,
): (T & { format: typeof PLUGIN_DATA_FORMAT }) | null {
	if (data === null) return null;
	if (data.format === PLUGIN_DATA_FORMAT) {
		assertExactKeys(data, CURRENT_PLUGIN_DATA_KEYS, "current plugin data");
		assertCurrentEncryptionState(data);
		return data as T & { format: typeof PLUGIN_DATA_FORMAT };
	}
	if (data.format !== undefined || "schemaVersion" in data) {
		throw new UnsupportedHistoricalDataError(
			"Plugin data uses an unsupported historical format",
		);
	}
	const stable = parseStable1xPluginData(data);
	if (!stable) {
		throw new UnsupportedHistoricalDataError(
			"Unmarked plugin data is not an exact stable 1.0/1.1 snapshot",
		);
	}
	const settings: Partial<YandexDiskSyncSettings> = { ...stable.settings };
	settings.encryptionProfileId = null;
	return {
		format: PLUGIN_DATA_FORMAT,
		settings,
		localState: convertStable1xBaseline(
			stable.localIndex,
			stable.settings.deviceId,
		),
		pendingMutations: [],
		pendingPhysicalActions: [],
		pendingWatcherEvents: [],
		encryptionTransition: null,
		lastSyncStats: stable.lastSyncStats,
	} as T & { format: typeof PLUGIN_DATA_FORMAT };
}

function convertStable1xBaseline(
	value: Stable1xIndex | null,
	deviceId: string,
): LocalSyncState {
	const files: Record<string, FileMetadata> = {};
	for (const [path, metadata] of Object.entries(value?.files ?? {})) {
		files[path] = {
			path,
			sha256: metadata.sha256,
			size: metadata.size,
			mtime: metadata.mtime,
			syncedAt: metadata.syncedAt,
			deleted: metadata.deleted,
			deletedAt: metadata.deletedAt,
			lastModifiedBy: metadata.lastModifiedBy,
		};
	}
	return {
		deviceId,
		observedEpoch: null,
		observedRevision: 0,
		lastSyncTime: value?.lastSyncTime ?? 0,
		files,
		folderTombstones: {},
		nextMutationSeq: 1,
	};
}

function assertCurrentEncryptionState(data: PersistedPluginData): void {
	const settings = data.settings;
	if (!settings || typeof settings !== "object") {
		throw new UnsupportedHistoricalDataError("Current settings are missing");
	}
	if (settings.enableEncryption) {
		if (settings.encryptionProfileId !== "hardened") {
			throw new UnsupportedHistoricalDataError(
				"Current encrypted settings require an explicit profile ID",
			);
		}
	} else if (settings.encryptionProfileId !== null) {
		throw new UnsupportedHistoricalDataError(
			"Current plaintext settings require a null profile ID",
		);
	}
	for (const field of [
		"pendingMutations",
		"pendingPhysicalActions",
		"pendingWatcherEvents",
	] as const) {
		if (!Array.isArray(data[field])) {
			throw new UnsupportedHistoricalDataError(
				`Current plugin data field ${field} must be an array`,
			);
		}
	}
	if (data.localState !== null) {
		if (!isRecord(data.localState)) {
			throw new UnsupportedHistoricalDataError(
				"Current local state must be an object or null",
			);
		}
		assertExactKeys(
			data.localState,
			new Set([
				"deviceId",
				"observedEpoch",
				"observedRevision",
				"lastSyncTime",
				"files",
				"folderTombstones",
				"nextMutationSeq",
			]),
			"current local state",
		);
	}
	if (data.encryptionTransition) {
		assertCurrentSnapshot(data.encryptionTransition.source, "source");
		assertCurrentSnapshot(data.encryptionTransition.target, "target");
		if (
			!Number.isSafeInteger(
				data.encryptionTransition.sourceCanonicalRevision,
			)
		) {
			throw new UnsupportedHistoricalDataError(
				"Current transition has no canonical revision",
			);
		}
	}
}

function assertCurrentSnapshot(
	snapshot: LocalEncryptionTransition["source"],
	label: string,
): void {
	if (
		(snapshot.enabled && snapshot.profileId !== "hardened") ||
		(!snapshot.enabled && snapshot.profileId !== null)
	) {
		throw new UnsupportedHistoricalDataError(
			`Current transition ${label} has no explicit profile ID`,
		);
	}
}

function assertExactKeys(
	value: object,
	expected: ReadonlySet<string>,
	label: string,
): void {
	for (const key of Object.keys(value)) {
		if (!expected.has(key)) {
			throw new UnsupportedHistoricalDataError(
				`${label} contains unsupported field ${key}`,
			);
		}
	}
	for (const key of expected) {
		if (!(key in value)) {
			throw new UnsupportedHistoricalDataError(
				`${label} is missing required field ${key}`,
			);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
