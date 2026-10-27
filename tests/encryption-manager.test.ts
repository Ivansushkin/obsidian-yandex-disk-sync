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

test("transition manifests preserve semantic descriptors and authenticate their declared key", async () => {
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
	const snapshot = localSnapshot(salt, "target-password", 5);
	for (const candidate of [targetCodec, wrongCodec]) {
		const descriptor = await manager.createModeDescriptor(
			snapshot,
			candidate,
		);
		assert.equal(
			await targetCodec.verifyVerifier(descriptor.verifier!),
			true,
		);
		assert.equal(
			await manager.verifyCandidate(candidate, descriptor.verifier!),
			candidate === targetCodec,
		);
	}
	const settings = {} as YandexDiskSyncSettings;
	assert.equal(
		await manager.applySnapshot(settings, snapshot, targetCodec),
		targetCodec,
	);
	const verifier = await targetCodec.createVerifier();
	const sourceSalt = EncryptionService.bytesToBase64(
		new Uint8Array(16).fill(6),
	);
	for (const kind of ["enable", "rotate"] as const) {
		const transition = localTransition({
			id: `${kind}-transition`,
			kind,
			source:
				kind === "enable"
					? localSnapshot(null, null, null)
					: localSnapshot(sourceSalt, "source-password", 4),
			target: localSnapshot(salt, "target-password", 5),
			sourceRawPaths: [],
			sourceFingerprints: {},
		});
		const maintenance = createMaintenance({
			id: transition.id,
			kind,
			phase: transition.phase,
			targetRevision: null,
			source:
				kind === "enable"
					? plaintextMode()
					: encryptedMode(4, sourceSalt, "source-verifier"),
			target: encryptedMode(5, salt, verifier),
		});
		const options = {
			service: targetCodec,
			salt,
			state:
				kind === "enable"
					? ("enabling" as const)
					: ("rotating" as const),
			revision: 5,
			deviceId: "device-a",
			transition,
			maintenance,
		};
		const manifest = await manager.createManifest(options);
		assert.equal(manifest.format, "encryption-manifest", kind);
		assert.equal("version" in manifest, false, kind);
		assert.equal(manifest.profileId, "hardened", kind);
		assert.equal(manifest.kdf.iterations, 600_000, kind);
		assert.equal(manifest.filenameCipher.name, "AES-SIV", kind);
		assert.equal(manifest.verifier, verifier, kind);
		assert.equal(
			manifest.transition?.sourceProfileId,
			kind === "enable" ? null : "hardened",
			kind,
		);
		assert.equal(manifest.transition?.targetProfileId, "hardened", kind);
		const staged = await manager.createManifest({
			...options,
			transition: { ...transition, phase: "files-copied" },
			maintenance: {
				...maintenance,
				phase: "index-committed",
				targetRevision: 5,
			},
		});
		assert.equal(staged.transition?.phase, "index-committed", kind);
		await assert.rejects(
			manager.createManifest({ ...options, service: wrongCodec }),
			/does not match its declared mode/,
			kind,
		);
		await assert.rejects(
			manager.createManifest({ ...options, state: "disabling" }),
			/metadata is incoherent/,
			kind,
		);
	}
});
