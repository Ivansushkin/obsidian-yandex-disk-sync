import assert from "node:assert/strict";
import test from "node:test";
import { EncryptionManager } from "../src/crypto/encryption-manager";
import { EncryptionService } from "../src/crypto/encryption";
import type {
	IndexMaintenance,
	RemoteEncryptionManifest,
	YandexDiskSyncSettings,
} from "../src/types";

const manager = new EncryptionManager();
const salt = EncryptionService.bytesToBase64(new Uint8Array(16).fill(7));

test("encryption manager requires explicit current profile metadata", () => {
	const settings = {
		enableEncryption: true,
		encryptionSalt: salt,
		encryptionPassword: "legacy-password",
		encryptionRevision: 4,
		encryptionProfileId: null,
	} as YandexDiskSyncSettings;
	assert.throws(
		() => manager.captureSnapshot(settings),
		/explicit profile ID|requires a profile ID/,
	);
});

test("encryption manager emits strict semantic hardened manifest descriptors", async () => {
	const codec = await manager.createCodec("hardened", salt, "password");
	const source = {
		enabled: true,
		revision: 4,
		salt,
		verifier: "source-verifier",
	};
	const target = {
		enabled: true,
		revision: 5,
		salt,
		verifier: "target-verifier",
	};
	const manifest = await manager.createManifest({
		service: codec,
		salt,
		state: "rotating",
		revision: 5,
		deviceId: "device-a",
		transition: {
			id: "transition-a",
			kind: "rotate",
			phase: "prepared",
			source: {
				enabled: true,
				salt,
				password: "password",
				revision: 4,
				profileId: "hardened",
			},
			target: {
				enabled: true,
				salt,
				password: "password",
				revision: 5,
				profileId: "hardened",
			},
			sourceRawPaths: [],
			targetRawPaths: [],
			sourceFingerprints: {},
			targetFingerprints: {},
			sourceCanonicalRevision: 11,
		},
		maintenance: {
			id: "transition-a",
			kind: "rotate",
			phase: "prepared",
			initiatedBy: "device-a",
			sourceRevision: 4,
			targetRevision: 5,
			source,
			target,
			cleanup: [],
		},
	});
	assert.equal(manifest.format, "encryption-manifest");
	assert.equal("version" in manifest, false);
	assert.equal(manifest.profileId, "hardened");
	assert.equal(manifest.kdf.iterations, 600_000);
	assert.equal(manifest.filenameCipher.name, "AES-SIV");
	assert.equal(manifest.transition?.sourceProfileId, "hardened");
	assert.equal(manifest.transition?.targetProfileId, "hardened");
});

test("foreign encrypted target recovery requires matching committed descriptors", () => {
	for (const kind of ["enable", "rotate"] as const) {
		const source =
			kind === "enable"
				? { enabled: false, revision: null, salt: null, verifier: null }
				: {
						enabled: true,
						revision: 1,
						salt: "source-salt",
						verifier: "source-verifier",
					};
		const target = {
			enabled: true,
			revision: 2,
			salt: "target-salt",
			verifier: "target-verifier",
		};
		const maintenance: IndexMaintenance = {
			id: `${kind}-transition`,
			kind,
			phase: "index-committed",
			initiatedBy: "device-a",
			sourceRevision: 4,
			targetRevision: 5,
			source,
			target,
			cleanup: [],
		};
		const manifest = createTransitionManifest(
			kind === "enable" ? "enabling" : "rotating",
			maintenance,
		);
		assert.doesNotThrow(() =>
			manager.assertRemoteTargetMaintenance(manifest, maintenance),
		);
		assert.throws(() =>
			manager.assertRemoteTargetMaintenance(manifest, {
				...maintenance,
				target: { ...target, verifier: "different" },
			}),
		);
	}
});

test("foreign disable target recovery accepts committed plaintext canonical", () => {
	const maintenance: IndexMaintenance = {
		id: "disable-transition",
		kind: "disable",
		phase: "cleanup",
		initiatedBy: "device-a",
		sourceRevision: 4,
		targetRevision: 5,
		source: {
			enabled: true,
			revision: 2,
			salt: "source-salt",
			verifier: "source-verifier",
		},
		target: { enabled: false, revision: null, salt: null, verifier: null },
		cleanup: [],
	};
	assert.doesNotThrow(() =>
		manager.assertRemoteTargetMaintenance(null, maintenance),
	);
	assert.doesNotThrow(() =>
		manager.assertRemoteTargetMaintenance(
			createTransitionManifest("disabling", maintenance),
			maintenance,
		),
	);
	assert.throws(() =>
		manager.assertRemoteTargetMaintenance(null, {
			...maintenance,
			phase: "files-copied",
		}),
	);
});

function createTransitionManifest(
	state: "enabling" | "rotating" | "disabling",
	maintenance: IndexMaintenance,
): RemoteEncryptionManifest {
	const manifestMode =
		state === "disabling" ? maintenance.source : maintenance.target;
	return {
		format: "encryption-manifest",
		profileId: "hardened",
		state,
		revision: manifestMode.revision!,
		salt: manifestMode.salt!,
		verifier: manifestMode.verifier!,
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
		transition: {
			id: maintenance.id,
			phase: "files-copied",
			sourceRevision: maintenance.source.revision,
			targetRevision: maintenance.target.revision,
			initiatedBy: maintenance.initiatedBy,
			source: maintenance.source,
			target: maintenance.target,
			sourceProfileId: maintenance.source.enabled ? "hardened" : null,
			targetProfileId: maintenance.target.enabled ? "hardened" : null,
		},
	};
}
