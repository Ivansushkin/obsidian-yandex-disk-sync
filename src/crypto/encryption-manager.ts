import type {
	EncryptionManifest,
	EncryptionManifestState,
	EncryptionModeDescriptor,
	IndexMaintenance,
	RemoteEncryptionManifest,
	YandexDiskSyncSettings,
} from "../types";
import { ENCRYPTION_MANIFEST_FORMAT } from "../types";
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
		return manifest.profileId;
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
				profileId: "hardened",
			},
		};
	}

	captureSnapshot(settings: YandexDiskSyncSettings): LocalEncryptionSnapshot {
		const profileId = settings.enableEncryption
			? requireProfileId(settings.encryptionProfileId)
			: null;
		return {
			enabled: settings.enableEncryption,
			salt: settings.encryptionSalt,
			password: settings.encryptionPassword,
			revision: settings.encryptionRevision,
			profileId,
		};
	}

	async applySnapshot(
		settings: YandexDiskSyncSettings,
		snapshot: LocalEncryptionSnapshot,
	): Promise<EncryptionCodec | null> {
		const codec =
			snapshot.enabled && snapshot.salt && snapshot.password
				? await this.createCodec(
						requireProfileId(snapshot.profileId),
						snapshot.salt,
						snapshot.password,
					)
				: null;
		settings.enableEncryption = snapshot.enabled;
		settings.encryptionSalt = snapshot.salt;
		settings.encryptionPassword = snapshot.password;
		settings.encryptionRevision = snapshot.revision;
		settings.encryptionProfileId = snapshot.enabled
			? requireProfileId(snapshot.profileId)
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
			requireProfileId(snapshot.profileId),
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
		if (service.profileId !== "hardened") {
			throw new Error("Only hardened manifests can be written");
		}
		const maintenance = transition ? options.maintenance : undefined;
		if (transition && !maintenance) {
			throw new Error("Transition manifest requires canonical maintenance");
		}
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
						source: maintenance!.source,
						target: maintenance!.target,
						sourceProfileId: transition.source.profileId,
						targetProfileId: transition.target.profileId,
					}
				: undefined,
		};
		return {
			format: ENCRYPTION_MANIFEST_FORMAT,
			profileId: "hardened",
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
				aad: "obsidian-yandex-disk-sync:filename",
			},
		};
	}
}

function requireProfileId(
	profileId: EncryptionProfileId | null,
): EncryptionProfileId {
	if (!profileId) throw new Error("Encrypted snapshot requires a profile ID");
	return profileId;
}
