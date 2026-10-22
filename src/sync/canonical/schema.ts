import type {
	EncryptionModeDescriptor,
	FileMetadata,
	SyncIndex,
} from "../../types";
import { CURRENT_INDEX_FORMAT } from "../../types";
import { isProtectedPath } from "../../utils/path-utils";
import { isJsonRecord } from "../../utils/record-utils";
import { isFileModificationTime } from "../../utils/timestamp-utils";
import { InvalidCurrentIndexError } from "./errors";

type JsonRecord = Record<string, unknown>;

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 0;
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
	return value === undefined || isNonNegativeInteger(value);
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isLogicalPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.startsWith("/") &&
		!value.endsWith("/") &&
		!value.includes("\\") &&
		!value.includes("\u0000") &&
		value
			.split("/")
			.every(
				(segment) =>
					segment !== "" && segment !== "." && segment !== "..",
			)
	);
}

function assertIndexSection(
	condition: boolean,
	section: string,
	reason: string,
): asserts condition {
	if (!condition) {
		throw new InvalidCurrentIndexError(section, reason);
	}
}

/** Validate current persisted codec authority without accepting partial modes. */
export function validateEncryptionModeDescriptor(
	value: unknown,
	section: string,
): asserts value is EncryptionModeDescriptor {
	assertIndexSection(isJsonRecord(value), section, "must be an object");
	assertIndexSection(
		Object.keys(value).length === 4 &&
			["enabled", "revision", "salt", "verifier"].every(
				(key) => key in value,
			),
		section,
		"fields do not match the current mode descriptor",
	);
	assertIndexSection(
		typeof value.enabled === "boolean",
		section,
		"enabled must be boolean",
	);
	assertIndexSection(
		value.revision === null || isNonNegativeInteger(value.revision),
		section,
		"revision must be null or a non-negative integer",
	);
	assertIndexSection(
		value.salt === null || typeof value.salt === "string",
		section,
		"salt must be null or string",
	);
	assertIndexSection(
		value.verifier === null || typeof value.verifier === "string",
		section,
		"verifier must be null or string",
	);
	if (value.enabled) {
		assertIndexSection(
			isNonNegativeInteger(value.revision) &&
				value.revision > 0 &&
				typeof value.salt === "string" &&
				value.salt.length > 0 &&
				typeof value.verifier === "string" &&
				value.verifier.length > 0,
			section,
			"encrypted mode requires revision, salt, and verifier",
		);
	} else {
		assertIndexSection(
			value.revision === null &&
				value.salt === null &&
				value.verifier === null,
			section,
			"plaintext mode requires null encryption fields",
		);
	}
}

/** Validate current canonical records before any state or physical write. */
export function validateCurrentIndexShape(
	data: JsonRecord,
): asserts data is JsonRecord & SyncIndex {
	const requiredRootKeys = [
		"format",
		"epoch",
		"revision",
		"lastSyncTime",
		"deviceId",
		"files",
		"folderTombstones",
		"moves",
		"appliedMutationSeq",
	];
	const allowedRootKeys = new Set([...requiredRootKeys, "maintenance"]);
	assertIndexSection(
		Object.keys(data).every((key) => allowedRootKeys.has(key)) &&
			requiredRootKeys.every((key) => key in data),
		"root",
		"fields do not match the current canonical format",
	);
	assertIndexSection(
		data.format === CURRENT_INDEX_FORMAT,
		"root",
		"format marker is invalid",
	);
	assertIndexSection(
		typeof data.epoch === "string" && data.epoch.length > 0,
		"root",
		"epoch is required",
	);
	assertIndexSection(
		isNonNegativeInteger(data.revision),
		"root",
		"revision must be a non-negative integer",
	);
	assertIndexSection(
		isNonNegativeInteger(data.lastSyncTime),
		"root",
		"lastSyncTime must be a non-negative integer",
	);
	assertIndexSection(
		typeof data.deviceId === "string" && data.deviceId.length > 0,
		"root",
		"deviceId is required",
	);
	assertIndexSection(isJsonRecord(data.files), "files", "must be an object");
	for (const [path, raw] of Object.entries(data.files)) {
		assertIndexSection(
			isLogicalPath(path),
			"files",
			"contains an invalid path key",
		);
		assertIndexSection(
			isJsonRecord(raw),
			"files",
			"metadata must be an object",
		);
		assertIndexSection(
			raw.path === path,
			"files",
			"metadata path must match its key",
		);
		assertIndexSection(
			typeof raw.sha256 === "string",
			"files",
			"sha256 must be a string",
		);
		assertIndexSection(
			isNonNegativeInteger(raw.size),
			"files",
			"size must be a non-negative integer",
		);
		assertIndexSection(
			isFileModificationTime(raw.mtime),
			"files",
			"mtime must be a finite non-negative timestamp",
		);
		assertIndexSection(
			isNonNegativeInteger(raw.syncedAt),
			"files",
			"syncedAt must be a non-negative integer",
		);
		assertIndexSection(
			isOptionalNonNegativeInteger(raw.remoteMtime),
			"files",
			"remoteMtime must be a non-negative integer",
		);
		assertIndexSection(
			isOptionalString(raw.remoteFingerprint),
			"files",
			"remoteFingerprint must be a string",
		);
		assertIndexSection(
			raw.deleted === undefined || typeof raw.deleted === "boolean",
			"files",
			"deleted must be boolean",
		);
		assertIndexSection(
			isOptionalNonNegativeInteger(raw.deletedAt),
			"files",
			"deletedAt must be a non-negative integer",
		);
		assertIndexSection(
			isOptionalString(raw.deletedByFolder),
			"files",
			"deletedByFolder must be a string",
		);
		assertIndexSection(
			isOptionalString(raw.lastModifiedBy),
			"files",
			"lastModifiedBy must be a string",
		);
		assertIndexSection(
			isNonNegativeInteger(raw.mutationSeq),
			"files",
			"mutationSeq must be a non-negative integer",
		);
		assertIndexSection(
			isOptionalNonNegativeInteger(raw.changedRevision),
			"files",
			"changedRevision must be a non-negative integer",
		);
		assertIndexSection(
			isOptionalNonNegativeInteger(raw.baseRevision),
			"files",
			"baseRevision must be a non-negative integer",
		);
	}
	assertIndexSection(
		isJsonRecord(data.folderTombstones),
		"folderTombstones",
		"must be an object",
	);
	for (const [path, raw] of Object.entries(data.folderTombstones)) {
		assertIndexSection(
			isLogicalPath(path),
			"folderTombstones",
			"contains an invalid path key",
		);
		assertIndexSection(
			isJsonRecord(raw),
			"folderTombstones",
			"entry must be an object",
		);
		assertIndexSection(
			raw.path === path,
			"folderTombstones",
			"path must match its key",
		);
		assertIndexSection(
			isNonNegativeInteger(raw.deletedAt),
			"folderTombstones",
			"deletedAt must be a non-negative integer",
		);
		assertIndexSection(
			isNonNegativeInteger(raw.changedRevision),
			"folderTombstones",
			"changedRevision must be a non-negative integer",
		);
		assertIndexSection(
			isNonNegativeInteger(raw.baseRevision),
			"folderTombstones",
			"baseRevision must be a non-negative integer",
		);
		assertIndexSection(
			typeof raw.lastModifiedBy === "string" &&
				raw.lastModifiedBy.length > 0,
			"folderTombstones",
			"lastModifiedBy is required",
		);
		assertIndexSection(
			isNonNegativeInteger(raw.mutationSeq),
			"folderTombstones",
			"mutationSeq must be a non-negative integer",
		);
	}
	assertIndexSection(isJsonRecord(data.moves), "moves", "must be an object");
	for (const [id, raw] of Object.entries(data.moves)) {
		assertIndexSection(
			id.length > 0 && isJsonRecord(raw),
			"moves",
			"entry must be an object",
		);
		assertIndexSection(raw.id === id, "moves", "id must match its key");
		assertIndexSection(
			isLogicalPath(raw.fromPath),
			"moves",
			"fromPath is invalid",
		);
		assertIndexSection(
			isLogicalPath(raw.toPath),
			"moves",
			"toPath is invalid",
		);
		assertIndexSection(
			raw.kind === "file" || raw.kind === "folder",
			"moves",
			"kind is invalid",
		);
		assertIndexSection(
			isNonNegativeInteger(raw.baseRevision),
			"moves",
			"baseRevision must be a non-negative integer",
		);
		assertIndexSection(
			isNonNegativeInteger(raw.changedRevision),
			"moves",
			"changedRevision must be a non-negative integer",
		);
		assertIndexSection(
			typeof raw.pending === "boolean",
			"moves",
			"pending must be boolean",
		);
		assertIndexSection(
			typeof raw.lastModifiedBy === "string" &&
				raw.lastModifiedBy.length > 0,
			"moves",
			"lastModifiedBy is required",
		);
		assertIndexSection(
			isNonNegativeInteger(raw.mutationSeq),
			"moves",
			"mutationSeq must be a non-negative integer",
		);
	}
	assertIndexSection(
		isJsonRecord(data.appliedMutationSeq),
		"appliedMutationSeq",
		"must be an object",
	);
	for (const [deviceId, sequence] of Object.entries(
		data.appliedMutationSeq,
	)) {
		assertIndexSection(
			deviceId.length > 0 && isNonNegativeInteger(sequence),
			"appliedMutationSeq",
			"contains an invalid watermark",
		);
	}
	if (data.maintenance === undefined) {
		return;
	}
	const maintenance = data.maintenance;
	assertIndexSection(
		isJsonRecord(maintenance),
		"maintenance",
		"must be an object",
	);
	if (maintenance.kind === "force") {
		validateForceMaintenance(maintenance, data.revision);
		return;
	}
	const maintenanceKeys = [
		"id",
		"kind",
		"phase",
		"initiatedBy",
		"sourceRevision",
		"targetRevision",
		"source",
		"target",
		"cleanup",
	];
	assertIndexSection(
		Object.keys(maintenance).length === maintenanceKeys.length &&
			maintenanceKeys.every((key) => key in maintenance),
		"maintenance",
		"fields do not match the current maintenance format",
	);
	assertIndexSection(
		typeof maintenance.id === "string" && maintenance.id.length > 0,
		"maintenance",
		"id is required",
	);
	assertIndexSection(
		maintenance.kind === "enable" ||
			maintenance.kind === "disable" ||
			maintenance.kind === "rotate",
		"maintenance",
		"kind is invalid",
	);
	assertIndexSection(
		[
			"prepared",
			"files-copied",
			"index-committed",
			"stable",
			"cleanup",
		].includes(String(maintenance.phase)),
		"maintenance",
		"phase is invalid",
	);
	assertIndexSection(
		typeof maintenance.initiatedBy === "string" &&
			maintenance.initiatedBy.length > 0,
		"maintenance",
		"initiatedBy is required",
	);
	assertIndexSection(
		isNonNegativeInteger(maintenance.sourceRevision),
		"maintenance",
		"sourceRevision must be a non-negative integer",
	);
	assertIndexSection(
		maintenance.targetRevision === null ||
			isNonNegativeInteger(maintenance.targetRevision),
		"maintenance",
		"targetRevision must be null or a non-negative integer",
	);
	assertIndexSection(
		maintenance.sourceRevision < data.revision,
		"maintenance.sourceRevision",
		"must precede the current canonical revision",
	);
	const source = maintenance.source;
	const target = maintenance.target;
	validateEncryptionModeDescriptor(source, "maintenance.source");
	validateEncryptionModeDescriptor(target, "maintenance.target");
	const preCommit =
		maintenance.phase === "prepared" ||
		maintenance.phase === "files-copied";
	assertIndexSection(
		preCommit
			? maintenance.targetRevision === null
			: isNonNegativeInteger(maintenance.targetRevision),
		"maintenance.targetRevision",
		"must agree with the maintenance phase",
	);
	if (!preCommit) {
		const targetRevision = maintenance.targetRevision;
		assertIndexSection(
			targetRevision !== null &&
				targetRevision > maintenance.sourceRevision &&
				targetRevision <= data.revision &&
				(maintenance.phase !== "index-committed" ||
					targetRevision === data.revision) &&
				(maintenance.phase !== "cleanup" ||
					targetRevision + 1 === data.revision) &&
				(maintenance.phase !== "stable" ||
					targetRevision < data.revision),
			"maintenance.targetRevision",
			"does not match the canonical commit revision",
		);
	}
	const modeMismatch =
		(maintenance.kind === "enable" &&
			(source.enabled || !target.enabled)) ||
		(maintenance.kind === "disable" &&
			(!source.enabled || target.enabled)) ||
		(maintenance.kind === "rotate" &&
			(!source.enabled ||
				!target.enabled ||
				(target.revision ?? 0) <= (source.revision ?? 0) ||
				target.salt === source.salt ||
				target.verifier === source.verifier));
	assertIndexSection(
		!modeMismatch,
		"maintenance",
		"source and target modes do not match its kind",
	);
	assertIndexSection(
		Array.isArray(maintenance.cleanup),
		"maintenance.cleanup",
		"must be an array",
	);
	assertIndexSection(
		!preCommit || maintenance.cleanup.length === 0,
		"maintenance.cleanup",
		"pre-commit maintenance cannot authorize cleanup",
	);
	const cleanupPaths = new Set<string>();
	for (const action of maintenance.cleanup) {
		assertIndexSection(
			isJsonRecord(action),
			"maintenance.cleanup",
			"entry must be an object",
		);
		assertIndexSection(
			Object.keys(action).length === 2 &&
				"path" in action &&
				"expectedFingerprint" in action,
			"maintenance.cleanup",
			"entry fields are invalid",
		);
		assertIndexSection(
			isLogicalPath(action.path) && !isProtectedPath(action.path),
			"maintenance.cleanup",
			"path is invalid or protected",
		);
		assertIndexSection(
			!cleanupPaths.has(action.path),
			"maintenance.cleanup",
			"path is duplicated",
		);
		cleanupPaths.add(action.path);
		assertIndexSection(
			typeof action.expectedFingerprint === "string" &&
				action.expectedFingerprint.length > 0,
			"maintenance.cleanup",
			"expectedFingerprint is required",
		);
	}
}

/** Validate the separate Force authority without accepting encryption lookalikes. */
function validateForceMaintenance(value: JsonRecord, revision: number): void {
	const keys = [
		"id",
		"kind",
		"phase",
		"initiatedBy",
		"sourceRevision",
		"targetRevision",
		"source",
		"target",
		"cleanup",
		"direction",
		"sourceDigest",
	];
	assertIndexSection(
		Object.keys(value).length === keys.length &&
			keys.every((key) => key in value),
		"maintenance",
		"Force fields are invalid",
	);
	assertIndexSection(
		[value.id, value.initiatedBy, value.sourceDigest].every(
			(v) => typeof v === "string" && v.length > 0,
		),
		"maintenance",
		"Force identity is invalid",
	);
	assertIndexSection(
		["from_local", "from_remote"].includes(String(value.direction)) &&
			["prepared", "applying", "cleanup"].includes(String(value.phase)),
		"maintenance",
		"Force direction or phase is invalid",
	);
	assertIndexSection(
		value.sourceRevision === 0 &&
			value.targetRevision === revision &&
			revision > 0,
		"maintenance",
		"Force revision is invalid",
	);
	validateEncryptionModeDescriptor(value.source, "maintenance.source");
	validateEncryptionModeDescriptor(value.target, "maintenance.target");
	assertIndexSection(
		Array.isArray(value.cleanup),
		"maintenance.cleanup",
		"Force cleanup must be an array",
	);
	const paths = new Set<string>();
	for (const action of value.cleanup) {
		assertIndexSection(
			isJsonRecord(action) &&
				Object.keys(action).length === 2 &&
				isLogicalPath(action.path) &&
				!isProtectedPath(action.path) &&
				typeof action.expectedFingerprint === "string" &&
				action.expectedFingerprint.length > 0 &&
				!paths.has(action.path),
			"maintenance.cleanup",
			"Force cleanup proof is invalid",
		);
		paths.add(action.path);
	}
}

/** Require positive causal sequences to be covered by their device watermark. */
export function validateCurrentIndexCausality(index: SyncIndex): void {
	const validateEntry = (
		section: string,
		entry: Pick<FileMetadata, "lastModifiedBy" | "mutationSeq">,
	): void => {
		if (entry.mutationSeq === undefined) {
			return;
		}
		if (entry.mutationSeq === 0) {
			return;
		}
		assertIndexSection(
			typeof entry.lastModifiedBy === "string" &&
				entry.lastModifiedBy.length > 0,
			section,
			"positive mutationSeq requires lastModifiedBy",
		);
		assertIndexSection(
			(index.appliedMutationSeq[entry.lastModifiedBy] ?? 0) >=
				entry.mutationSeq,
			section,
			"mutationSeq exceeds its device watermark",
		);
	};

	for (const metadata of Object.values(index.files)) {
		validateEntry("files", metadata);
	}
	for (const tombstone of Object.values(index.folderTombstones)) {
		validateEntry("folderTombstones", tombstone);
	}
	for (const move of Object.values(index.moves)) {
		validateEntry("moves", move);
	}
}
