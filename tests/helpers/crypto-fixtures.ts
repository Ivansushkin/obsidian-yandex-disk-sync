import type {
	EncryptionModeDescriptor,
	EncryptionIndexMaintenance,
	RemoteEncryptionManifest,
} from "../../src/types";
import type {
	LocalEncryptionSnapshot,
	LocalEncryptionTransition,
} from "../../src/crypto/encryption-transition";

export function encryptedMode(
	revision = 1,
	salt = "source-salt",
	verifier = "source-verifier",
): EncryptionModeDescriptor {
	return { enabled: true, revision, salt, verifier };
}

export function plaintextMode(): EncryptionModeDescriptor {
	return { enabled: false, revision: null, salt: null, verifier: null };
}

export function maintenance(
	overrides: Partial<EncryptionIndexMaintenance> = {},
): EncryptionIndexMaintenance {
	return {
		id: "transition-a",
		kind: "rotate",
		phase: "index-committed",
		initiatedBy: "device-a",
		sourceRevision: 4,
		targetRevision: 5,
		source: encryptedMode(),
		target: encryptedMode(2, "target-salt", "target-verifier"),
		cleanup: [],
		...overrides,
	};
}

/** Create a complete current wire manifest, retaining explicit test overrides. */
export function encryptionManifest(
	overrides: Partial<RemoteEncryptionManifest> = {},
): RemoteEncryptionManifest {
	return {
		format: "encryption-manifest",
		profileId: "hardened",
		state: "enabled",
		revision: 1,
		salt: "AAAAAAAAAAAAAAAAAAAAAA==",
		verifier: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
		kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600_000 },
		keySchedule: { name: "HKDF", hash: "SHA-256" },
		cipher: { name: "AES-GCM", keyLength: 256, ivLength: 12 },
		filenameCipher: {
			name: "AES-SIV",
			keyLength: 512,
			encoding: "base64url",
			aad: "obsidian-yandex-disk-sync:filename",
		},
		updatedAt: 1,
		updatedBy: "device-a",
		...overrides,
	};
}

/** Pair the manifest key and transition descriptor with canonical authority. */
export function transitionManifest(
	state: "enabling" | "rotating" | "disabling",
	authority: EncryptionIndexMaintenance,
): RemoteEncryptionManifest {
	const mode = state === "disabling" ? authority.source : authority.target;
	return encryptionManifest({
		state,
		revision: mode.revision!,
		salt: mode.salt!,
		verifier: mode.verifier!,
		transition: {
			id: authority.id,
			phase: authority.phase,
			sourceRevision: authority.source.revision,
			targetRevision: authority.target.revision,
			initiatedBy: authority.initiatedBy,
			source: authority.source,
			target: authority.target,
			sourceProfileId: authority.source.enabled ? "hardened" : null,
			targetProfileId: authority.target.enabled ? "hardened" : null,
		},
	});
}

export function localSnapshot(
	salt: string | null,
	password: string | null,
	revision: number | null,
): LocalEncryptionSnapshot {
	return {
		enabled: salt !== null,
		salt,
		password,
		revision,
		profileId: salt ? "hardened" : null,
	};
}

export function localTransition(
	overrides: Partial<LocalEncryptionTransition> = {},
): LocalEncryptionTransition {
	return {
		id: "device:rotate:1",
		kind: "rotate",
		phase: "prepared",
		source: localSnapshot("old-salt", "old-password", 1),
		target: localSnapshot("new-salt", "new-password", 2),
		sourceRawPaths: ["old-file"],
		targetRawByLogicalPath: {},
		sourceFingerprints: { "old-file": "old-fingerprint" },
		targetFingerprints: {},
		sourceCanonicalRevision: 4,
		backupProof: {
			path: ".backup/transition.enc.zip",
			sha256: "backup-sha",
			epoch: "epoch-a",
			canonicalRevision: 4,
			localSnapshotDigest: "snapshot-sha",
			createdAt: 1,
		},
		...overrides,
	};
}
