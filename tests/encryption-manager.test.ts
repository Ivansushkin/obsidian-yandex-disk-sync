import assert from "node:assert/strict";
import test from "node:test";
import { EncryptionManager } from "../src/crypto/encryption-manager";
import { EncryptionService } from "../src/crypto/encryption";
import type { YandexDiskSyncSettings } from "../src/types";

const manager = new EncryptionManager();
const salt = EncryptionService.bytesToBase64(new Uint8Array(16).fill(7));

test("candidate encryption credentials persist only after authentication and coherence", async () => {
	const calls: string[] = [];
	const accepted = await manager.acceptCandidate({
		service: { verifyVerifier: async () => true } as never,
		verifier: "verifier",
		validateAuthority: async () => {
			calls.push("authority");
			return "canonical";
		},
		persist: async (authority) => {
			calls.push(`persist:${authority}`);
		},
	});
	assert.equal(accepted, "canonical");
	assert.deepEqual(calls, ["authority", "persist:canonical"]);

	calls.length = 0;
	assert.equal(
		await manager.acceptCandidate({
			service: { verifyVerifier: async () => false } as never,
			verifier: "verifier",
			validateAuthority: async () => {
				calls.push("authority");
				return "canonical";
			},
			persist: async () => {
				calls.push("persist");
			},
		}),
		null,
	);
	assert.equal(calls.length, 0);

	await assert.rejects(
		manager.acceptCandidate({
			service: { verifyVerifier: async () => true } as never,
			verifier: "verifier",
			validateAuthority: async () => {
				throw new Error("incoherent authority");
			},
			persist: async () => {
				calls.push("persist");
			},
		}),
		/incoherent authority/,
	);
	assert.equal(calls.length, 0);
	assert.equal(
		await manager.acceptCandidate({
			service: null,
			verifier: "verifier",
			validateAuthority: async () => "canonical",
			persist: async () => {
				calls.push("persist");
			},
		}),
		null,
	);
	assert.equal(calls.length, 0);
});

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
	const targetVerifier = await codec.createVerifier();
	const source = {
		enabled: true,
		revision: 4,
		salt: EncryptionService.bytesToBase64(new Uint8Array(16).fill(6)),
		verifier: "source-verifier",
	};
	const target = {
		enabled: true,
		revision: 5,
		salt,
		verifier: targetVerifier,
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
				salt: source.salt,
				password: "source-password",
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
			targetRawByLogicalPath: {},
			sourceFingerprints: {},
			targetFingerprints: {},
			sourceCanonicalRevision: 11,
			backupProof: {
				path: ".backup/transition.enc.zip",
				sha256: "backup-sha",
				epoch: "epoch-a",
				canonicalRevision: 11,
				localSnapshotDigest: "snapshot-sha",
				createdAt: 1,
			},
		},
		maintenance: {
			id: "transition-a",
			kind: "rotate",
			phase: "prepared",
			initiatedBy: "device-a",
			sourceRevision: 11,
			targetRevision: null,
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
	assert.equal(manifest.verifier, targetVerifier);
	assert.equal(manifest.transition?.sourceProfileId, "hardened");
	assert.equal(manifest.transition?.targetProfileId, "hardened");
});

test("transition manifest reuses the verifier for its declared key", async () => {
	const targetCodec = await manager.createCodec(
		"hardened",
		salt,
		"target-password",
	);
	const wrongCodec = await manager.createCodec(
		"hardened",
		salt,
		"wrong-password",
	);
	const targetVerifier = await targetCodec.createVerifier();
	const target = {
		enabled: true,
		revision: 1,
		salt,
		verifier: targetVerifier,
	};
	const transition = {
		id: "enable-transition",
		kind: "enable" as const,
		phase: "prepared" as const,
		source: {
			enabled: false,
			salt: null,
			password: null,
			revision: null,
			profileId: null,
		},
		target: {
			enabled: true,
			salt,
			password: "target-password",
			revision: 1,
			profileId: "hardened" as const,
		},
		sourceRawPaths: [],
		targetRawByLogicalPath: {},
		sourceFingerprints: {},
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
	};
	const maintenance = {
		id: transition.id,
		kind: transition.kind,
		phase: transition.phase,
		initiatedBy: "device-a",
		sourceRevision: 4,
		targetRevision: null,
		source: {
			enabled: false,
			revision: null,
			salt: null,
			verifier: null,
		},
		target,
		cleanup: [],
	};
	const options = {
		service: targetCodec,
		salt,
		state: "enabling" as const,
		revision: 1,
		deviceId: "device-a",
		transition,
		maintenance,
	};
	const manifest = await manager.createManifest(options);
	assert.equal(manifest.verifier, targetVerifier);
	const staged = await manager.createManifest({
		...options,
		transition: { ...transition, phase: "files-copied" },
		maintenance: {
			...maintenance,
			phase: "index-committed",
			targetRevision: 5,
		},
	});
	assert.equal(staged.transition?.phase, "index-committed");
	await assert.rejects(
		manager.createManifest({ ...options, service: wrongCodec }),
		/does not match its declared mode/,
	);
	await assert.rejects(
		manager.createManifest({ ...options, state: "rotating" }),
		/metadata is incoherent/,
	);
});
