import type {
	EncryptionManifestState,
	EncryptionTransitionDescriptor,
	RemoteEncryptionManifest,
} from "../types";
import { ENCRYPTION_MANIFEST_FORMAT } from "../types";
import { UnsupportedHistoricalDataError } from "../compatibility-errors";
import { isJsonRecord } from "../utils/record-utils";
import {
	HARDENED_PBKDF2_ITERATIONS,
	AES_KEY_LENGTH,
	FILENAME_KEY_LENGTH,
	IV_LENGTH,
} from "./encryption";

const ENCRYPTION_MANIFEST_STATES: EncryptionManifestState[] = [
	"enabled",
	"enabling",
	"rotating",
	"disabling",
];

/** Parse only the current hardened manifest and its exact transition authority. */
export function parseEncryptionManifest(
	data: Record<string, unknown>,
): RemoteEncryptionManifest {
	if (data.format !== ENCRYPTION_MANIFEST_FORMAT) {
		throw new UnsupportedHistoricalDataError(
			"Encryption manifest uses an unsupported historical format",
		);
	}
	const salt = data.salt;
	if (typeof salt !== "string" || !salt) {
		throw new Error("Invalid encryption manifest: missing salt");
	}
	assertManifestBase64(salt, 16, 16, "salt");

	const manifestKeys = [
		"format",
		"profileId",
		"state",
		"revision",
		"salt",
		"verifier",
		"kdf",
		"keySchedule",
		"cipher",
		"filenameCipher",
		"updatedAt",
		"updatedBy",
		"transition",
	] as const;
	assertManifestKeys(
		data,
		manifestKeys,
		manifestKeys.filter((key) => key !== "transition"),
	);

	const state = data.state;
	const revision = data.revision;
	const verifier = data.verifier;
	const updatedAt = data.updatedAt;
	const updatedBy = data.updatedBy;

	if (typeof state !== "string" || !isEncryptionManifestState(state)) {
		throw new Error("Invalid encryption manifest: unsupported state");
	}
	if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
		throw new Error("Invalid encryption manifest: invalid revision");
	}
	if (typeof verifier !== "string" || !verifier) {
		throw new Error("Invalid encryption manifest: missing verifier");
	}
	assertManifestBase64(verifier, 28, 4096, "verifier");
	if (!Number.isSafeInteger(updatedAt) || (updatedAt as number) < 0) {
		throw new Error("Invalid encryption manifest: invalid updatedAt");
	}
	if (typeof updatedBy !== "string" || !updatedBy) {
		throw new Error("Invalid encryption manifest: invalid updatedBy");
	}

	const transition = parseEncryptionTransition(data.transition);
	if (
		(state === "enabled" && transition !== undefined) ||
		(state !== "enabled" && transition === undefined)
	) {
		throw new Error(
			"Invalid encryption manifest: transition/state mismatch",
		);
	}
	if (transition) {
		const invalidModes =
			(state === "enabling" &&
				(transition.source.enabled || !transition.target.enabled)) ||
			(state === "disabling" &&
				(!transition.source.enabled || transition.target.enabled)) ||
			(state === "rotating" &&
				(!transition.source.enabled ||
					!transition.target.enabled ||
					(transition.target.revision ?? 0) <=
						(transition.source.revision ?? 0) ||
					transition.target.salt === transition.source.salt ||
					transition.target.verifier === transition.source.verifier));
		const declared =
			state === "disabling" ? transition.source : transition.target;
		if (
			invalidModes ||
			updatedBy !== transition.initiatedBy ||
			declared.revision !== revision ||
			declared.salt !== salt ||
			declared.verifier !== verifier
		) {
			throw new Error(
				"Invalid encryption manifest: incoherent transition",
			);
		}
	}
	assertHardenedManifestAlgorithms(data);
	return {
		format: ENCRYPTION_MANIFEST_FORMAT,
		profileId: "hardened",
		state,
		revision: revision as number,
		salt,
		verifier,
		kdf: {
			name: "PBKDF2",
			hash: "SHA-256",
			iterations: HARDENED_PBKDF2_ITERATIONS,
		},
		keySchedule: {
			name: "HKDF",
			hash: "SHA-256",
		},
		cipher: {
			name: "AES-GCM",
			keyLength: AES_KEY_LENGTH,
			ivLength: IV_LENGTH,
		},
		filenameCipher: {
			name: "AES-SIV",
			keyLength: FILENAME_KEY_LENGTH,
			encoding: "base64url",
			aad: "obsidian-yandex-disk-sync:filename",
		},
		updatedAt: updatedAt as number,
		updatedBy,
		transition,
	};
}

function assertManifestBase64(
	value: string,
	minimumBytes: number,
	maximumBytes: number,
	field: string,
): void {
	try {
		const binary = atob(value);
		if (
			binary.length < minimumBytes ||
			binary.length > maximumBytes ||
			btoa(binary) !== value
		) {
			throw new Error();
		}
	} catch {
		throw new Error(`Invalid encryption manifest: invalid ${field}`);
	}
}

function assertHardenedManifestAlgorithms(data: Record<string, unknown>): void {
	if (
		!isJsonRecord(data.kdf) ||
		!isJsonRecord(data.keySchedule) ||
		!isJsonRecord(data.cipher) ||
		!isJsonRecord(data.filenameCipher)
	) {
		throw new Error("Invalid encryption manifest: unsupported profile");
	}
	const kdf = data.kdf;
	const schedule = data.keySchedule;
	const cipher = data.cipher;
	const filename = data.filenameCipher;
	assertManifestKeys(kdf, ["name", "hash", "iterations"]);
	assertManifestKeys(schedule, ["name", "hash"]);
	assertManifestKeys(cipher, ["name", "keyLength", "ivLength"]);
	assertManifestKeys(filename, ["name", "keyLength", "encoding", "aad"]);
	if (
		data.profileId !== "hardened" ||
		kdf?.name !== "PBKDF2" ||
		kdf.hash !== "SHA-256" ||
		kdf.iterations !== HARDENED_PBKDF2_ITERATIONS ||
		schedule?.name !== "HKDF" ||
		schedule.hash !== "SHA-256" ||
		cipher?.name !== "AES-GCM" ||
		cipher.keyLength !== AES_KEY_LENGTH ||
		cipher.ivLength !== IV_LENGTH ||
		filename?.name !== "AES-SIV" ||
		filename.keyLength !== FILENAME_KEY_LENGTH ||
		filename.encoding !== "base64url" ||
		filename.aad !== "obsidian-yandex-disk-sync:filename"
	) {
		throw new Error("Invalid encryption manifest: unsupported profile");
	}
}

function parseEncryptionTransition(
	value: unknown,
): EncryptionTransitionDescriptor | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!value || typeof value !== "object") {
		throw new Error("Invalid encryption manifest: invalid transition");
	}
	const data = value as Record<string, unknown>;
	assertManifestKeys(data, [
		"id",
		"phase",
		"sourceRevision",
		"targetRevision",
		"initiatedBy",
		"source",
		"target",
		"sourceProfileId",
		"targetProfileId",
	]);
	const phases = [
		"prepared",
		"files-copied",
		"index-committed",
		"stable",
		"cleanup",
	];
	const validRevision = (revision: unknown): boolean =>
		revision === null ||
		(typeof revision === "number" &&
			Number.isSafeInteger(revision) &&
			revision >= 1);
	if (
		typeof data.id !== "string" ||
		!data.id ||
		typeof data.phase !== "string" ||
		!phases.includes(data.phase) ||
		!validRevision(data.sourceRevision) ||
		!validRevision(data.targetRevision) ||
		typeof data.initiatedBy !== "string" ||
		!data.initiatedBy
	) {
		throw new Error("Invalid encryption manifest: invalid transition");
	}
	const source = parseEncryptionModeDescriptor(data.source);
	const target = parseEncryptionModeDescriptor(data.target);
	const sourceProfileId = parseEncryptionProfileId(data.sourceProfileId);
	const targetProfileId = parseEncryptionProfileId(data.targetProfileId);
	if (
		(source.enabled && sourceProfileId === null) ||
		(!source.enabled && sourceProfileId !== null) ||
		(target.enabled && targetProfileId === null) ||
		(!target.enabled && targetProfileId !== null) ||
		source.revision !== data.sourceRevision ||
		target.revision !== data.targetRevision
	) {
		throw new Error("Invalid encryption manifest: profile/mode mismatch");
	}
	return {
		id: data.id,
		phase: data.phase as EncryptionTransitionDescriptor["phase"],
		sourceRevision: data.sourceRevision as number | null,
		targetRevision: data.targetRevision as number | null,
		initiatedBy: data.initiatedBy,
		source,
		target,
		sourceProfileId,
		targetProfileId,
	};
}

function parseEncryptionProfileId(
	value: unknown,
): EncryptionTransitionDescriptor["sourceProfileId"] {
	if (value === null) {
		return null;
	}
	if (value === "hardened") {
		return value;
	}
	throw new Error("Invalid encryption manifest: invalid profile ID");
}

function parseEncryptionModeDescriptor(
	value: unknown,
): EncryptionTransitionDescriptor["source"] {
	if (!value || typeof value !== "object") {
		throw new Error("Invalid encryption manifest: invalid mode descriptor");
	}
	const descriptor = value as Record<string, unknown>;
	assertManifestKeys(descriptor, ["enabled", "revision", "salt", "verifier"]);
	if (
		typeof descriptor.enabled !== "boolean" ||
		!(
			descriptor.revision === null ||
			Number.isSafeInteger(descriptor.revision)
		) ||
		!(descriptor.salt === null || typeof descriptor.salt === "string") ||
		!(
			descriptor.verifier === null ||
			typeof descriptor.verifier === "string"
		)
	) {
		throw new Error("Invalid encryption manifest: invalid mode descriptor");
	}
	if (descriptor.enabled) {
		if (
			!Number.isSafeInteger(descriptor.revision) ||
			(descriptor.revision as number) < 1 ||
			typeof descriptor.salt !== "string" ||
			!descriptor.salt ||
			typeof descriptor.verifier !== "string" ||
			!descriptor.verifier
		) {
			throw new Error(
				"Invalid encryption manifest: invalid encrypted mode descriptor",
			);
		}
		assertManifestBase64(descriptor.salt, 16, 16, "transition salt");
		assertManifestBase64(
			descriptor.verifier,
			28,
			4096,
			"transition verifier",
		);
	} else if (
		descriptor.revision !== null ||
		descriptor.salt !== null ||
		descriptor.verifier !== null
	) {
		throw new Error(
			"Invalid encryption manifest: invalid plaintext mode descriptor",
		);
	}
	return {
		enabled: descriptor.enabled,
		revision: descriptor.revision as number | null,
		salt: descriptor.salt,
		verifier: descriptor.verifier,
	};
}

function assertManifestKeys(
	data: Record<string, unknown>,
	allowed: readonly string[],
	required: readonly string[] = allowed,
): void {
	const keys = new Set(allowed);
	for (const key of Object.keys(data)) {
		if (!keys.has(key)) {
			throw new Error(
				`Invalid encryption manifest: unsupported field ${key}`,
			);
		}
	}
	for (const key of required) {
		if (!(key in data)) {
			throw new Error(
				`Invalid encryption manifest: missing field ${key}`,
			);
		}
	}
}

function isEncryptionManifestState(
	value: string,
): value is EncryptionManifestState {
	return ENCRYPTION_MANIFEST_STATES.includes(
		value as EncryptionManifestState,
	);
}
