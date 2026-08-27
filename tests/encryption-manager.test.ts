import assert from "node:assert/strict";
import test from "node:test";
import { EncryptionManager } from "../src/crypto/encryption-manager";
import { EncryptionService } from "../src/crypto/encryption";
import type { YandexDiskSyncSettings } from "../src/types";

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
