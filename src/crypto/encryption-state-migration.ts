import type {
	FileMetadata,
	LocalSyncState,
	YandexDiskSyncSettings,
} from "../types";
import { UnsupportedPrereleaseDataError } from "../compatibility-errors";
import type { LocalEncryptionTransition } from "./encryption-transition";

interface PersistedPluginData {
	schemaVersion?: number;
	settings?: Partial<YandexDiskSyncSettings> & {
		encryptedPassword?: unknown;
	};
	localIndex?: unknown;
	localState?: unknown;
	pendingMutations?: unknown;
	pendingPhysicalActions?: unknown;
	pendingWatcherEvents?: unknown;
	encryptionTransition?: LocalEncryptionTransition | null;
	lastSyncStats?: unknown;
}

const CURRENT_PLUGIN_DATA_KEYS = new Set([
	"schemaVersion",
	"settings",
	"localState",
	"pendingMutations",
	"pendingPhysicalActions",
	"pendingWatcherEvents",
	"encryptionTransition",
	"lastSyncStats",
]);
const STABLE_1X_PLUGIN_DATA_KEYS = new Set([
	"settings",
	"localIndex",
	"lastSyncStats",
]);
const UNSUPPORTED_STABLE_SETTINGS_KEYS = [
	"enableEncryption",
	"encryptionSalt",
	"encryptedPassword",
	"encryptionPassword",
	"encryptionRevision",
	"encryptionProfileId",
] as const;

/**
 * Load current plugin data or convert the exact top-level shape persisted by
 * plaintext stable 1.0/1.1. Later unversioned data is not migrated.
 */
export function migrateEncryptionPluginData<T extends PersistedPluginData>(
	data: T | null,
): (T & { schemaVersion: 2 }) | null {
	if (!data) return null;
	if (data.schemaVersion === 2) {
		assertExactKeys(data, CURRENT_PLUGIN_DATA_KEYS, "current plugin data");
		assertCurrentEncryptionState(data);
		return data as T & { schemaVersion: 2 };
	}
	if (data.schemaVersion !== undefined) {
		throw new UnsupportedPrereleaseDataError(
			`Plugin data schema ${String(data.schemaVersion)} is unsupported`,
		);
	}
	assertExactKeys(
		data,
		STABLE_1X_PLUGIN_DATA_KEYS,
		"stable 1.0/1.1 plugin data",
	);
	if (!("localIndex" in data)) {
		throw new UnsupportedPrereleaseDataError(
			"Unversioned plugin data is not a stable 1.0/1.1 snapshot",
		);
	}
	const settings = { ...data.settings };
	for (const key of UNSUPPORTED_STABLE_SETTINGS_KEYS) {
		if (key in settings) {
			throw new UnsupportedPrereleaseDataError(
				"Only plaintext stable 1.0/1.1 settings can be migrated",
			);
		}
	}
	settings.encryptionProfileId = null;
	const { localIndex, ...stableData } = data;
	return {
		...stableData,
		schemaVersion: 2,
		settings,
		localState: convertStable1xBaseline(localIndex, settings.deviceId ?? ""),
		pendingMutations: [],
		pendingPhysicalActions: [],
		pendingWatcherEvents: [],
		encryptionTransition: null,
	} as T & { schemaVersion: 2 };
}

function convertStable1xBaseline(
	value: unknown,
	deviceId: string,
): LocalSyncState {
	const data = isRecord(value) ? value : {};
	const rawFiles = isRecord(data.files) ? data.files : {};
	const files: Record<string, FileMetadata> = {};
	for (const [path, value] of Object.entries(rawFiles)) {
		if (!isRecord(value) || typeof value.sha256 !== "string") continue;
		files[path] = {
			path,
			sha256: value.sha256,
			size: typeof value.size === "number" ? value.size : 0,
			mtime: typeof value.mtime === "number" ? value.mtime : 0,
			syncedAt: typeof value.syncedAt === "number" ? value.syncedAt : 0,
			deleted: typeof value.deleted === "boolean" ? value.deleted : undefined,
			deletedAt:
				typeof value.deletedAt === "number" ? value.deletedAt : undefined,
			lastModifiedBy:
				typeof value.lastModifiedBy === "string"
					? value.lastModifiedBy
					: undefined,
		};
	}
	return {
		version: 1,
		deviceId,
		observedEpoch: null,
		observedRevision: 0,
		lastSyncTime:
			typeof data.lastSyncTime === "number" ? data.lastSyncTime : 0,
		files,
		folderTombstones: {},
		nextMutationSeq: 1,
	};
}

function assertCurrentEncryptionState(data: PersistedPluginData): void {
	const settings = data.settings;
	if (!settings || typeof settings !== "object") {
		throw new UnsupportedPrereleaseDataError("Current settings are missing");
	}
	if (settings.enableEncryption) {
		if (settings.encryptionProfileId !== "hardened-v3") {
			throw new UnsupportedPrereleaseDataError(
				"Current encrypted settings require an explicit profile ID",
			);
		}
	} else if (settings.encryptionProfileId !== null) {
		throw new UnsupportedPrereleaseDataError(
			"Current plaintext settings require a null profile ID",
		);
	}
	for (const field of [
		"pendingMutations",
		"pendingPhysicalActions",
		"pendingWatcherEvents",
	] as const) {
		if (!Array.isArray(data[field])) {
			throw new UnsupportedPrereleaseDataError(
				`Current plugin data field ${field} must be an array`,
			);
		}
	}
	if (data.encryptionTransition) {
		assertCurrentSnapshot(data.encryptionTransition.source, "source");
		assertCurrentSnapshot(data.encryptionTransition.target, "target");
		if (
			!Number.isSafeInteger(
				data.encryptionTransition.sourceCanonicalRevision,
			)
		) {
			throw new UnsupportedPrereleaseDataError(
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
		(snapshot.enabled &&
			snapshot.profileId !== "hardened-v3") ||
		(!snapshot.enabled && snapshot.profileId !== null)
	) {
		throw new UnsupportedPrereleaseDataError(
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
			throw new UnsupportedPrereleaseDataError(
				`${label} contains unsupported field ${key}`,
			);
		}
	}
	for (const key of expected) {
		if (!(key in value)) {
			throw new UnsupportedPrereleaseDataError(
				`${label} is missing required field ${key}`,
			);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
