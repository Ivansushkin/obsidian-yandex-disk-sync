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
import {
	assertSafeTransitionPath,
	createTargetRawMapping,
	type LocalEncryptionTransition,
} from "./crypto/encryption-transition";

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
	data: T | null | undefined,
): (T & { format: typeof PLUGIN_DATA_FORMAT }) | null {
	if (data == null) return null;
	if (typeof data !== "object" || Array.isArray(data)) {
		throw new UnsupportedHistoricalDataError(
			"Plugin data root must be a recognized object",
		);
	}
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
	const encryptedSettingsInvalid =
		settings.enableEncryption === true &&
		(settings.encryptionProfileId !== "hardened" ||
			typeof settings.encryptionSalt !== "string" ||
			settings.encryptionSalt.length === 0 ||
			typeof settings.encryptionPassword !== "string" ||
			settings.encryptionPassword.length === 0 ||
			!Number.isSafeInteger(settings.encryptionRevision) ||
			(settings.encryptionRevision ?? 0) <= 0);
	const plaintextSettingsInvalid =
		settings.enableEncryption === false &&
		(settings.encryptionProfileId !== null ||
			settings.encryptionSalt !== null ||
			settings.encryptionPassword !== null ||
			settings.encryptionRevision !== null);
	if (
		typeof settings.enableEncryption !== "boolean" ||
		encryptedSettingsInvalid ||
		plaintextSettingsInvalid
	) {
		throw new UnsupportedHistoricalDataError(
			"Current encryption settings are incomplete or incoherent",
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
		assertCurrentTransition(data.encryptionTransition);
		if (
			!settingsMatchSnapshot(settings, data.encryptionTransition.source) &&
			!settingsMatchSnapshot(settings, data.encryptionTransition.target)
		) {
			throw new UnsupportedHistoricalDataError(
				"Current settings do not match either transition mode",
			);
		}
	}
}

function settingsMatchSnapshot(
	settings: Partial<YandexDiskSyncSettings>,
	snapshot: LocalEncryptionTransition["source"],
): boolean {
	return (
		settings.enableEncryption === snapshot.enabled &&
		settings.encryptionSalt === snapshot.salt &&
		settings.encryptionPassword === snapshot.password &&
		settings.encryptionRevision === snapshot.revision &&
		settings.encryptionProfileId === snapshot.profileId
	);
}

function assertCurrentTransition(transition: LocalEncryptionTransition): void {
	assertExactKeys(
		transition,
		new Set([
			"id",
			"kind",
			"phase",
			"source",
			"target",
			"sourceRawPaths",
			"targetRawByLogicalPath",
			"sourceFingerprints",
			"targetFingerprints",
			"sourceCanonicalRevision",
			"backupProof",
		]),
		"current encryption transition",
	);
	assertCurrentSnapshot(transition.source, "source");
	assertCurrentSnapshot(transition.target, "target");
	if (
		!transition.id ||
		!["enable", "disable", "rotate"].includes(transition.kind) ||
		!["prepared", "files-copied", "index-committed", "stable", "cleanup"].includes(
			transition.phase,
		) ||
		!Number.isSafeInteger(transition.sourceCanonicalRevision) ||
		transition.sourceCanonicalRevision < 0
	) {
		throw new UnsupportedHistoricalDataError(
			"Current transition identity or phase is invalid",
		);
	}
	const modeMismatch =
		(transition.kind === "enable" &&
			(transition.source.enabled || !transition.target.enabled)) ||
		(transition.kind === "disable" &&
			(!transition.source.enabled || transition.target.enabled)) ||
		(transition.kind === "rotate" &&
			(!transition.source.enabled ||
				!transition.target.enabled ||
				(transition.target.revision ?? 0) <=
					(transition.source.revision ?? 0) ||
				transition.target.salt === transition.source.salt));
	if (modeMismatch) {
		throw new UnsupportedHistoricalDataError(
			"Current transition modes do not match its kind",
		);
	}
	if (!Array.isArray(transition.sourceRawPaths)) {
		throw new UnsupportedHistoricalDataError(
			"Current transition source paths must be an array",
		);
	}
	const sourcePaths = new Set<string>();
	for (const path of transition.sourceRawPaths) {
		assertCurrentPhysicalPath(path, "source");
		if (sourcePaths.has(path)) {
			throw new UnsupportedHistoricalDataError(
				"Current transition contains duplicate source paths",
			);
		}
		sourcePaths.add(path);
	}
	assertStringRecord(transition.sourceFingerprints, "source fingerprints");
	if (
		Object.keys(transition.sourceFingerprints).length !== sourcePaths.size ||
		[...sourcePaths].some(
			(path) => !hasOwn(transition.sourceFingerprints, path),
		)
	) {
		throw new UnsupportedHistoricalDataError(
			"Current transition source paths require exact fingerprints",
		);
	}
	assertStringRecord(
		transition.targetRawByLogicalPath,
		"target path mapping",
	);
	let targetPaths: Set<string>;
	try {
		const normalizedMapping = createTargetRawMapping(
			Object.entries(transition.targetRawByLogicalPath),
			sourcePaths,
		);
		targetPaths = new Set(Object.values(normalizedMapping));
	} catch (error) {
		throw new UnsupportedHistoricalDataError(
			error instanceof Error
				? error.message
				: "Current transition target mapping is invalid",
		);
	}
	assertStringRecord(transition.targetFingerprints, "target fingerprints");
	if (
		Object.keys(transition.targetFingerprints).some(
			(path) => !targetPaths.has(path),
		)
	) {
		throw new UnsupportedHistoricalDataError(
			"Current transition has a fingerprint outside its target mapping",
		);
	}
	if (
		transition.phase !== "prepared" &&
		[...targetPaths].some(
			(path) => !hasOwn(transition.targetFingerprints, path),
		)
	) {
		throw new UnsupportedHistoricalDataError(
			"Current copied transition target requires exact fingerprints",
		);
	}
	assertExactKeys(
		transition.backupProof,
		new Set([
			"path",
			"sha256",
			"epoch",
			"canonicalRevision",
			"localSnapshotDigest",
			"createdAt",
		]),
		"current transition backup proof",
	);
	const proof = transition.backupProof;
	if (
		!proof.path ||
		!proof.sha256 ||
		!proof.epoch ||
		!proof.localSnapshotDigest ||
		!Number.isSafeInteger(proof.canonicalRevision) ||
		proof.canonicalRevision < 0 ||
		!Number.isSafeInteger(proof.createdAt) ||
		proof.createdAt < 0
	) {
		throw new UnsupportedHistoricalDataError(
			"Current transition backup proof is invalid",
		);
	}
}

function assertCurrentSnapshot(
	snapshot: LocalEncryptionTransition["source"],
	label: string,
): void {
	assertExactKeys(
		snapshot,
		new Set(["enabled", "salt", "password", "revision", "profileId"]),
		`current transition ${label}`,
	);
	const encryptedSnapshotInvalid =
		snapshot.enabled &&
		(snapshot.profileId !== "hardened" ||
			typeof snapshot.salt !== "string" ||
			snapshot.salt.length === 0 ||
			typeof snapshot.password !== "string" ||
			snapshot.password.length === 0 ||
			!Number.isSafeInteger(snapshot.revision) ||
			(snapshot.revision ?? 0) <= 0);
	const plaintextSnapshotInvalid =
		!snapshot.enabled &&
		(snapshot.profileId !== null ||
			snapshot.salt !== null ||
			snapshot.password !== null ||
			snapshot.revision !== null);
	if (encryptedSnapshotInvalid || plaintextSnapshotInvalid) {
		throw new UnsupportedHistoricalDataError(
			`Current transition ${label} descriptor is invalid`,
		);
	}
}

function assertStringRecord(value: unknown, label: string): asserts value is Record<string, string> {
	if (
		!isRecord(value) ||
		Object.values(value).some(
			(entry) => typeof entry !== "string" || entry.length === 0,
		)
	) {
		throw new UnsupportedHistoricalDataError(
			`Current transition ${label} must contain non-empty strings`,
		);
	}
}

function assertCurrentPhysicalPath(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string") {
		throw new UnsupportedHistoricalDataError(
			`Current transition ${label} path is invalid`,
		);
	}
	try {
		assertSafeTransitionPath(value, label);
	} catch (error) {
		throw new UnsupportedHistoricalDataError(
			error instanceof Error
				? error.message
				: `Current transition ${label} path is invalid`,
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

function hasOwn(value: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}
