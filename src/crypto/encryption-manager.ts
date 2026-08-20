import type {
	EncryptionManifest,
	EncryptionManifestState,
	EncryptionModeDescriptor,
	IndexMaintenance,
	RemoteEncryptionManifest,
	YandexDiskSyncSettings,
} from "../types";
import {
	AES_KEY_LENGTH,
	createEncryptionCodec,
	EncryptionService,
	FILENAME_KEY_LENGTH,
	HARDENED_PBKDF2_ITERATIONS,
	IV_LENGTH,
	type EncryptionCodec,
	type EncryptionProfileId,
} from "./encryption";
import type {
	LocalEncryptionSnapshot,
	LocalEncryptionTransition,
} from "./encryption-transition";

/** Owns profile selection and wire-shape creation outside the plugin root. */
export class EncryptionManager {
	getManifestProfileId(
		manifest: RemoteEncryptionManifest,
	): EncryptionProfileId {
		return manifest.version === 3 ? "hardened-v3" : "legacy-v2";
	}

	async createCodec(
		profileId: EncryptionProfileId,
		saltBase64: string,
		password: string,
	): Promise<EncryptionCodec> {
		const codec = createEncryptionCodec(
			profileId,
			EncryptionService.base64ToBytes(saltBase64),
		);
		await codec.initializeKey(password);
		return codec;
	}

	createTargetSnapshot(
		password: string,
		revision: number,
	): { snapshot: LocalEncryptionSnapshot; saltBytes: Uint8Array } {
		const saltBytes = EncryptionService.generateSalt();
		return {
			saltBytes,
			snapshot: {
				enabled: true,
				salt: EncryptionService.bytesToBase64(saltBytes),
				password,
				revision,
				profileId: "hardened-v3",
			},
		};
	}

	captureSnapshot(settings: YandexDiskSyncSettings): LocalEncryptionSnapshot {
		return {
			enabled: settings.enableEncryption,
			salt: settings.encryptionSalt,
			password: settings.encryptionPassword,
			revision: settings.encryptionRevision,
			profileId: settings.enableEncryption
				? (settings.encryptionProfileId ?? "legacy-v2")
				: null,
		};
	}

	async applySnapshot(
		settings: YandexDiskSyncSettings,
		snapshot: LocalEncryptionSnapshot,
	): Promise<EncryptionCodec | null> {
		const codec =
			snapshot.enabled && snapshot.salt && snapshot.password
				? await this.createCodec(
						snapshot.profileId ?? "legacy-v2",
						snapshot.salt,
						snapshot.password,
					)
				: null;
		settings.enableEncryption = snapshot.enabled;
		settings.encryptionSalt = snapshot.salt;
		settings.encryptionPassword = snapshot.password;
		settings.encryptionRevision = snapshot.revision;
		settings.encryptionProfileId = snapshot.enabled
			? (snapshot.profileId ?? "legacy-v2")
			: null;
		return codec;
	}

	async createModeDescriptor(
		snapshot: LocalEncryptionSnapshot,
	): Promise<EncryptionModeDescriptor> {
		if (!snapshot.enabled || !snapshot.salt || !snapshot.password) {
			return {
				enabled: false,
				revision: null,
				salt: null,
				verifier: null,
			};
		}
		const codec = await this.createCodec(
			snapshot.profileId ?? "legacy-v2",
			snapshot.salt,
			snapshot.password,
		);
		return {
			enabled: true,
			revision: snapshot.revision,
			salt: snapshot.salt,
			verifier: await codec.createVerifier(),
		};
	}

	async createManifest(options: {
		service: EncryptionCodec;
		salt: string;
		state: EncryptionManifestState;
		revision: number;
		deviceId: string;
		transition?: LocalEncryptionTransition;
		maintenance?: IndexMaintenance;
	}): Promise<EncryptionManifest> {
		const { service, salt, state, revision, deviceId, transition } = options;
		const common = {
			state,
			revision,
			salt,
			verifier: await service.createVerifier(),
			cipher: {
				name: "AES-GCM" as const,
				keyLength: AES_KEY_LENGTH,
				ivLength: IV_LENGTH,
			},
			updatedAt: Date.now(),
			updatedBy: deviceId,
			transition: transition
				? {
						id: transition.id,
						phase: transition.phase,
						sourceRevision: transition.source.revision,
						targetRevision: transition.target.revision,
						initiatedBy: deviceId,
						source: options.maintenance?.source,
						target: options.maintenance?.target,
						sourceProfileId:
							transition.source.profileId ??
							(transition.source.enabled ? "legacy-v2" : null),
						targetProfileId:
							transition.target.profileId ??
							(transition.target.enabled ? "legacy-v2" : null),
					}
				: undefined,
		};
		if (service.profileId === "legacy-v2") {
			return {
				version: 2,
				...common,
				kdf: {
					name: "PBKDF2",
					hash: "SHA-256",
					iterations: 100_000,
				},
			};
		}
		return {
			version: 3,
			profileId: "hardened-v3",
			...common,
			kdf: {
				name: "PBKDF2",
				hash: "SHA-256",
				iterations: HARDENED_PBKDF2_ITERATIONS,
			},
			keySchedule: { name: "HKDF", hash: "SHA-256" },
			filenameCipher: {
				name: "AES-SIV",
				keyLength: FILENAME_KEY_LENGTH,
				encoding: "base64url",
				aad: "obsidian-yandex-disk-sync:filename:v3",
			},
		};
	}
}
