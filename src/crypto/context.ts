import type { YandexDiskClient } from "../api/yandex-client";
import type { BackupManager } from "../backup/backup-manager";
import type { IndexManager } from "../sync/canonical/manager";
import type { SyncEngine } from "../sync/engine";
import type {
	RemoteEncryptionManifest,
	YandexDiskSyncSettings,
} from "../types";
import type { EncryptionCodec } from "./encryption";
import type {
	EncryptionManager,
	LocalEncryptionSettings,
} from "./encryption-manager";
import type { LocalEncryptionTransition } from "./encryption-transition";

export type EncryptionIndex = Pick<
	IndexManager,
	| "assertMaintenanceAuthority"
	| "clearIndexTransitionServices"
	| "createStartupReadSession"
	| "clearMaintenance"
	| "completePhysicalAction"
	| "deleteEncryptionManifest"
	| "downloadEncryptionManifest"
	| "enqueuePhysicalAction"
	| "getMaintenance"
	| "getObservedEpoch"
	| "getPendingPhysicalAction"
	| "getPendingPhysicalActions"
	| "getRemoteIndex"
	| "getRemoteRawFileSnapshots"
	| "loadRemoteIndex"
	| "loadRemoteIndexWithTargetCodec"
	| "readCanonicalIndex"
	| "readCanonicalIndexWithCodec"
	| "readCanonicalIndexWithCodecIfPresent"
	| "runTargetMaintenanceRecovery"
	| "saveRemoteIndex"
	| "setIndexTransitionServices"
	| "setMaintenance"
	| "uploadEncryptionManifest"
>;
export type EncryptionEngine = Pick<
	SyncEngine,
	| "fullSync"
	| "createReadLifetimeGuard"
	| "reencodeRemoteFiles"
	| "runExclusiveMaintenance"
	| "showMaintenanceCleanupPhase"
>;
export type EncryptionClient = Pick<
	YandexDiskClient,
	| "decodePhysicalUserPath"
	| "deleteResource"
	| "downloadStableRawFile"
	| "getPhysicalPath"
	| "getResource"
	| "isRawFolderEmpty"
	| "setEncryptionService"
>;

export type EncryptionWorkflowSettings = LocalEncryptionSettings &
	Pick<YandexDiskSyncSettings, "deviceId" | "remotePath">;

export type EncryptionPromptMode = "connect" | "rotated" | "recover";

/** Host effects; domain algorithms never import Obsidian presentation APIs. */
export interface EncryptionUI {
	setBlock(reason: string | null, showNotice?: boolean): void;
	setHistoricalBlock(reason: string | null): void;
	requestPassword(
		manifest: RemoteEncryptionManifest,
		mode: EncryptionPromptMode,
	): Promise<string | null>;
	connected(): void;
	disabledRemotely(): void;
	stateChanged(): void;
}

/** Current snapshot ports share the plugin's single coherent persistence queue. */
export interface EncryptionContext {
	readonly client: EncryptionClient;
	readonly index: EncryptionIndex;
	readonly engine: EncryptionEngine;
	getLocalSnapshotDigest(): Promise<string>;
	readonly backup: Pick<BackupManager, "createTransitionBackup">;
	readonly manager: EncryptionManager;
	readonly ui: EncryptionUI;
	getSettings(): EncryptionWorkflowSettings;
	getService(): EncryptionCodec | null;
	setService(service: EncryptionCodec | null): void;
	getTransition(): LocalEncryptionTransition | null;
	setTransition(transition: LocalEncryptionTransition | null): void;
	isCancelled(): boolean;
	assertConnectionAllowed(): void;
	persist(): Promise<void>;
}
