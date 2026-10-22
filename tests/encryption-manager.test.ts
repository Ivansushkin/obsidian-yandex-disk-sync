import {
	encryptedMode,
	plaintextMode,
	localSnapshot,
	localTransition,
	maintenance as createMaintenance,
} from "./helpers/crypto-fixtures";
import assert from "node:assert/strict";
import test from "node:test";
import { EncryptionManager } from "../src/crypto/encryption-manager";
import { EncryptionService } from "../src/crypto/encryption";
import type { YandexDiskSyncSettings } from "../src/types";

const manager = new EncryptionManager();
const salt = EncryptionService.bytesToBase64(new Uint8Array(16).fill(7));

test("candidate encryption credentials persist only after authentication and coherence", async () => {
	const calls: string[] = [];
	const candidate = {
		service: { verifyVerifier: async () => true } as never,
		verifier: "verifier",
		validateAuthority: async () => {
			calls.push("authority");
			return "canonical";
		},
		persist: async (authority: string) => {
			calls.push(`persist:${authority}`);
		},
	};
	assert.equal(await manager.acceptCandidate(candidate), "canonical");
	assert.deepEqual(calls, ["authority", "persist:canonical"]);
	calls.length = 0;
	for (const service of [
		null,
		{ verifyVerifier: async () => false } as never,
	]) {
		assert.equal(
			await manager.acceptCandidate({ ...candidate, service }),
			null,
		);
		assert.deepEqual(calls, []);
	}
	await assert.rejects(
		manager.acceptCandidate({
			...candidate,
			validateAuthority: async () => {
				throw new Error("incoherent authority");
			},
		}),
		/incoherent authority/,
	);
	assert.deepEqual(calls, []);
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
	const source = encryptedMode(
		4,
		EncryptionService.bytesToBase64(new Uint8Array(16).fill(6)),
		"source-verifier",
	);
	const target = encryptedMode(5, salt, targetVerifier);
	const manifest = await manager.createManifest({
		service: codec,
		salt,
		state: "rotating",
		revision: 5,
		deviceId: "device-a",
		transition: localTransition({
			id: "transition-a",
			source: localSnapshot(source.salt, "source-password", 4),
			target: localSnapshot(salt, "password", 5),
			sourceRawPaths: [],
			sourceFingerprints: {},
			sourceCanonicalRevision: 11,
			backupProof: {
				...localTransition().backupProof!,
				canonicalRevision: 11,
			},
		}),
		maintenance: createMaintenance({
			phase: "prepared",
			sourceRevision: 11,
			targetRevision: null,
			source,
			target,
		}),
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
	const target = encryptedMode(1, salt, targetVerifier);
	const transition = localTransition({
		id: "enable-transition",
		kind: "enable",
		source: localSnapshot(null, null, null),
		target: localSnapshot(salt, "target-password", 1),
		sourceRawPaths: [],
		sourceFingerprints: {},
	});
	const maintenance = createMaintenance({
		id: transition.id,
		kind: transition.kind,
		phase: transition.phase,
		targetRevision: null,
		source: plaintextMode(),
		target,
	});
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
