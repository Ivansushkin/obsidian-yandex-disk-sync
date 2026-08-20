import assert from "node:assert/strict";
import test from "node:test";
import { EncryptionManager } from "../src/crypto/encryption-manager";
import { EncryptionService } from "../src/crypto/encryption";
import type { YandexDiskSyncSettings } from "../src/types";

const manager = new EncryptionManager();
const salt = EncryptionService.bytesToBase64(new Uint8Array(16).fill(7));

test("encryption manager preserves legacy snapshot defaults", async () => {
	const settings = {
		enableEncryption: true,
		encryptionSalt: salt,
		encryptionPassword: "legacy-password",
		encryptionRevision: 4,
		encryptionProfileId: null,
	} as YandexDiskSyncSettings;
	const snapshot = manager.captureSnapshot(settings);
	assert.equal(snapshot.profileId, "legacy-v2");
	const codec = await manager.applySnapshot(settings, snapshot);
	assert.equal(codec?.profileId, "legacy-v2");
	assert.equal(settings.encryptionProfileId, "legacy-v2");
});

test("encryption manager emits strict hardened v3 manifest descriptors", async () => {
	const codec = await manager.createCodec("hardened-v3", salt, "password");
	const manifest = await manager.createManifest({
		service: codec,
		salt,
		state: "rotating",
		revision: 5,
		deviceId: "device-a",
		transition: {
			id: "transition-a",
			kind: "rotate",
			reason: "format-upgrade",
			phase: "prepared",
			source: {
				enabled: true,
				salt,
				password: "password",
				revision: 4,
				profileId: "legacy-v2",
			},
			target: {
				enabled: true,
				salt,
				password: "password",
				revision: 5,
				profileId: "hardened-v3",
			},
			sourceRawPaths: [],
			targetRawPaths: [],
			sourceFingerprints: {},
			targetFingerprints: {},
			sourceCanonicalRevision: 11,
		},
	});
	assert.equal(manifest.version, 3);
	assert.equal(manifest.kdf.iterations, 600_000);
	assert.equal(manifest.filenameCipher.name, "AES-SIV");
	assert.equal(manifest.transition?.sourceProfileId, "legacy-v2");
	assert.equal(manifest.transition?.targetProfileId, "hardened-v3");
});
