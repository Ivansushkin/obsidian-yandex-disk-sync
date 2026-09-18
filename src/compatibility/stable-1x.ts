import type { FileMetadata, YandexDiskSyncSettings } from "../types";
import { createSafeRecord, setRecordValue } from "../utils/record-utils";
import { isFileModificationTime } from "../utils/timestamp-utils";
import { UnsupportedHistoricalDataError } from "../compatibility-errors";

type JsonRecord = Record<string, unknown>;

export interface Stable1xIndex {
	version: 1 | 2;
	lastSyncTime: number;
	deviceId: string;
	files: Record<string, FileMetadata>;
}

export interface Stable1xPluginData {
	settings: Pick<
		YandexDiskSyncSettings,
		| "yandexTokenSecret"
		| "clientId"
		| "remotePath"
		| "syncInterval"
		| "enableRealtimeSync"
		| "syncPatterns"
		| "excludePatterns"
		| "syncDotObsidian"
		| "deviceId"
		| "debounceDelay"
		| "maxConcurrency"
	>;
	localIndex: Stable1xIndex | null;
	lastSyncStats: {
		uploaded: number;
		downloaded: number;
		deleted: number;
		errors: number;
	};
}

const INDEX_KEYS = ["version", "lastSyncTime", "deviceId", "files"] as const;
const FILE_REQUIRED_KEYS = [
	"path",
	"sha256",
	"size",
	"mtime",
	"syncedAt",
] as const;
const FILE_KEYS = [
	...FILE_REQUIRED_KEYS,
	"deleted",
	"deletedAt",
	"lastModifiedBy",
] as const;
const PLUGIN_DATA_KEYS = ["settings", "localIndex", "lastSyncStats"] as const;
const SETTINGS_KEYS = [
	"yandexTokenSecret",
	"clientId",
	"remotePath",
	"syncInterval",
	"enableRealtimeSync",
	"syncPatterns",
	"excludePatterns",
	"syncDotObsidian",
	"deviceId",
	"debounceDelay",
	"maxConcurrency",
] as const;
const STATS_KEYS = ["uploaded", "downloaded", "deleted", "errors"] as const;

/** Parse the exact canonical/local index shape written by stable 1.0/1.1. */
export function parseStable1xIndex(value: unknown): Stable1xIndex | null {
	if (!isRecord(value) || !hasExactKeys(value, INDEX_KEYS)) {
		return null;
	}
	if (
		(value.version !== 1 && value.version !== 2) ||
		!isNonNegativeInteger(value.lastSyncTime) ||
		typeof value.deviceId !== "string" ||
		!isRecord(value.files)
	) {
		return null;
	}
	const files = createSafeRecord<FileMetadata>();
	for (const [path, raw] of Object.entries(value.files)) {
		if (
			!isStablePath(path) ||
			!isRecord(raw) ||
			!hasAllowedKeys(raw, FILE_KEYS)
		) {
			return null;
		}
		if (
			!FILE_REQUIRED_KEYS.every((key) => key in raw) ||
			raw.path !== path ||
			typeof raw.sha256 !== "string" ||
			!isNonNegativeInteger(raw.size) ||
			!isFileModificationTime(raw.mtime) ||
			!isNonNegativeInteger(raw.syncedAt) ||
			(raw.deleted !== undefined && typeof raw.deleted !== "boolean") ||
			(raw.deletedAt !== undefined &&
				!isNonNegativeInteger(raw.deletedAt)) ||
			(raw.lastModifiedBy !== undefined &&
				typeof raw.lastModifiedBy !== "string")
		) {
			return null;
		}
		setRecordValue(files, path, {
			path,
			sha256: raw.sha256,
			size: raw.size,
			mtime: raw.mtime,
			syncedAt: raw.syncedAt,
			deleted: raw.deleted,
			deletedAt: raw.deletedAt,
			lastModifiedBy: raw.lastModifiedBy,
		});
	}
	return {
		version: value.version,
		lastSyncTime: value.lastSyncTime,
		deviceId: value.deviceId,
		files,
	};
}

/** Parse only the complete plaintext plugin snapshot written by stable 1.0/1.1. */
export function parseStable1xPluginData(value: unknown): Stable1xPluginData {
	if (!isRecord(value) || !hasExactKeys(value, PLUGIN_DATA_KEYS)) {
		rejectStableSnapshot("root fields");
	}
	if (!isStable1xSettings(value.settings)) {
		rejectStableSnapshot("settings");
	}
	if (!isStable1xStats(value.lastSyncStats)) {
		rejectStableSnapshot("lastSyncStats");
	}
	const localIndex =
		value.localIndex === null ? null : parseStable1xIndex(value.localIndex);
	if (value.localIndex !== null && !localIndex) {
		rejectStableSnapshot("localIndex");
	}
	return {
		settings: { ...value.settings },
		localIndex,
		lastSyncStats: { ...value.lastSyncStats },
	};
}

/** Report only fixed schema sections, never user-provided keys, paths or values. */
function rejectStableSnapshot(
	section: "root fields" | "settings" | "lastSyncStats" | "localIndex",
): never {
	throw new UnsupportedHistoricalDataError(
		`Unmarked plugin data is not an exact stable 1.0/1.1 snapshot (invalid ${section})`,
	);
}

function isStable1xSettings(
	value: unknown,
): value is Stable1xPluginData["settings"] {
	if (!isRecord(value) || !hasExactKeys(value, SETTINGS_KEYS)) {
		return false;
	}
	return (
		typeof value.yandexTokenSecret === "string" &&
		typeof value.clientId === "string" &&
		typeof value.remotePath === "string" &&
		isNonNegativeInteger(value.syncInterval) &&
		typeof value.enableRealtimeSync === "boolean" &&
		isStringArray(value.syncPatterns) &&
		isStringArray(value.excludePatterns) &&
		typeof value.syncDotObsidian === "boolean" &&
		typeof value.deviceId === "string" &&
		isNonNegativeInteger(value.debounceDelay) &&
		isNonNegativeInteger(value.maxConcurrency)
	);
}

function isStable1xStats(
	value: unknown,
): value is Stable1xPluginData["lastSyncStats"] {
	return (
		isRecord(value) &&
		hasExactKeys(value, STATS_KEYS) &&
		STATS_KEYS.every((key) => isNonNegativeInteger(value[key]))
	);
}

function isStablePath(value: string): boolean {
	return (
		value.length > 0 &&
		!value.startsWith("/") &&
		!value.endsWith("/") &&
		!value.includes("\0") &&
		value
			.split("/")
			.every(
				(segment) =>
					segment !== "" && segment !== "." && segment !== "..",
			)
	);
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
	return (
		Object.keys(value).length === expected.length &&
		expected.every((key) =>
			Object.prototype.hasOwnProperty.call(value, key),
		)
	);
}

function hasAllowedKeys(
	value: JsonRecord,
	allowed: readonly string[],
): boolean {
	const keys = new Set(allowed);
	return Object.keys(value).every((key) => keys.has(key));
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
