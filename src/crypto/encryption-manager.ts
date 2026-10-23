import type {
	EncryptionManifest,
	EncryptionManifestState,
	EncryptionModeDescriptor,
	IndexMaintenance,
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

/** The only mutable settings fields owned by encryption snapshots. */
export type LocalEncryptionSettings = Pick<
	YandexDiskSyncSettings,
	| "enableEncryption"
	| "encryptionSalt"
	| "encryptionPassword"
	| "encryptionRevision"
	| "encryptionProfileId"
>;

/** Owns profile selection and wire-shape creation outside the plugin root. */
export class EncryptionManager {
	private readonly preparedCodecs = new WeakMap<
		EncryptionCodec,
		{ profileId: EncryptionProfileId; salt: string; password: string }
	>();

	/** Persist candidate credentials only after authentication and authority checks. */
	async acceptCandidate<T>(options: {
		service: EncryptionCodec | null;
		verifier: string;
		validateAuthority(): Promise<T>;
		persist(authority: T): Promise<void>;
	}): Promise<T | null> {
		if (!options.service) {
			return null;
		}
		const authenticated = await this.verifyCandidate(
			options.service,
			options.verifier,
		);
		if (!authenticated) {
			return null;
		}
		const authority = await options.validateAuthority();
		await options.persist(authority);
		return authority;
	}

	/** Treat failed authenticated decryption as an invalid candidate without exposing cryptographic errors. */
	async verifyCandidate(
		service: EncryptionCodec | null,
		verifier: string,
	): Promise<boolean> {
		if (!service) {
			return false;
		}
		try {
			return await service.verifyVerifier(verifier);
		} catch {
			return false;
		}
	}

	getManifestProfileId(manifest: EncryptionManifest): EncryptionProfileId {
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
		this.preparedCodecs.set(codec, {
			profileId,
			salt: saltBase64,
			password,
		});
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

	captureSnapshot(
		settings: LocalEncryptionSettings,
	): LocalEncryptionSnapshot {
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
		settings: LocalEncryptionSettings,
		snapshot: LocalEncryptionSnapshot,
		candidate?: EncryptionCodec | null,
		assertCurrent: () => void = () => {},
	): Promise<EncryptionCodec | null> {
		const prepared = candidate
			? this.preparedCodecs.get(candidate)
			: undefined;
		const matches =
			prepared &&
			prepared.profileId === snapshot.profileId &&
			prepared.salt === snapshot.salt &&
			prepared.password === snapshot.password;
		const codec =
			snapshot.enabled && snapshot.salt && snapshot.password
				? matches
					? candidate!
					: await this.createCodec(
							requireProfileId(snapshot.profileId),
							snapshot.salt,
							snapshot.password,
						)
				: null;
		assertCurrent();
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
		const { service, salt, state, revision, deviceId, transition } =
			options;
		if (service.profileId !== "hardened") {
			throw new Error("Only hardened manifests can be written");
		}
		const maintenance =
			transition && options.maintenance?.kind !== "force"
				? options.maintenance
				: undefined;
		if (transition && !maintenance) {
			throw new Error(
				"Transition manifest requires canonical maintenance",
			);
		}
		if (transition && maintenance) {
			const expectedState = {
				enable: "enabling",
				rotate: "rotating",
				disable: "disabling",
			}[transition.kind];
			if (
				state !== expectedState ||
				maintenance.id !== transition.id ||
				maintenance.kind !== transition.kind ||
				maintenance.initiatedBy !== deviceId ||
				maintenance.sourceRevision !==
					transition.sourceCanonicalRevision ||
				!snapshotMatchesMode(transition.source, maintenance.source) ||
				!snapshotMatchesMode(transition.target, maintenance.target)
			) {
				throw new Error("Transition manifest metadata is incoherent");
			}
		}
		const declaredMode = transition
			? state === "disabling"
				? maintenance!.source
				: maintenance!.target
			: null;
		if (declaredMode) {
			let verifierMatches = false;
			if (declaredMode.verifier) {
				try {
					verifierMatches = await service.verifyVerifier(
						declaredMode.verifier,
					);
				} catch {
					verifierMatches = false;
				}
			}
			if (
				!declaredMode.enabled ||
				declaredMode.salt !== salt ||
				declaredMode.revision !== revision ||
				!declaredMode.verifier ||
				!verifierMatches
			) {
				throw new Error(
					"Transition manifest service does not match its declared mode",
				);
			}
		}
		const common = {
			state,
			revision,
			salt,
			verifier:
				declaredMode?.verifier ?? (await service.createVerifier()),
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
						phase: maintenance!.phase,
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
	if (!profileId) {
		throw new Error("Encrypted snapshot requires a profile ID");
	}
	return profileId;
}

function snapshotMatchesMode(
	snapshot: LocalEncryptionSnapshot,
	mode: EncryptionModeDescriptor,
): boolean {
	return (
		snapshot.enabled === mode.enabled &&
		snapshot.revision === mode.revision &&
		snapshot.salt === mode.salt &&
		snapshot.profileId === (mode.enabled ? "hardened" : null)
	);
}
