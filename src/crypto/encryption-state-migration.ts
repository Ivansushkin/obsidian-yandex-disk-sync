import type { YandexDiskSyncSettings } from "../types";
import type { LocalEncryptionTransition } from "./encryption-transition";

interface PersistedEncryptionData {
	schemaVersion?: number;
	settings?: Partial<YandexDiskSyncSettings>;
	encryptionTransition?: LocalEncryptionTransition | null;
}

/**
 * Add encryption profile metadata without rewriting causal queues or baseline
 * fields owned by the caller's persisted data object.
 */
export function migrateEncryptionPluginData<
	T extends PersistedEncryptionData,
>(data: T | null):
	| (Omit<T, "schemaVersion" | "settings" | "encryptionTransition"> & {
			schemaVersion: 2;
			settings: NonNullable<T["settings"]> &
				Partial<YandexDiskSyncSettings>;
			encryptionTransition?: LocalEncryptionTransition | null;
	  })
	| null {
	if (!data) return null;
	if (typeof data.schemaVersion === "number" && data.schemaVersion > 2) {
		throw new Error("Unsupported plugin data schema version");
	}
	const settings = { ...data.settings };
	if (settings.enableEncryption) {
		settings.encryptionProfileId = normalizeProfileId(
			settings.encryptionProfileId,
		);
	} else {
		settings.encryptionProfileId = null;
	}
	const transition = data.encryptionTransition
		? {
				...data.encryptionTransition,
				source: normalizeSnapshot(data.encryptionTransition.source),
				target: normalizeSnapshot(data.encryptionTransition.target),
			}
		: data.encryptionTransition;
	return {
		...data,
		schemaVersion: 2,
		settings,
		encryptionTransition: transition,
	};
}

function normalizeSnapshot(
	snapshot: LocalEncryptionTransition["source"],
): LocalEncryptionTransition["source"] {
	return {
		...snapshot,
		profileId: snapshot.enabled
			? normalizeProfileId(snapshot.profileId)
			: null,
	};
}

function normalizeProfileId(value: unknown): "legacy-v2" | "hardened-v3" {
	return value === "hardened-v3" ? value : "legacy-v2";
}
