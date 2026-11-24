import type {
	EncryptionManifestRead,
	RemoteAuthorityObservation,
} from "./canonical/manager";
import type { FailureSummary } from "../errors";
import type { LocalSyncState, SyncSessionKind, SyncState } from "../types";

export type SyncEventCallback = (state: SyncState) => void;

/** Publish only these reconciliation fields after their coherent device snapshot is saved. */
export interface RemoteObservation {
	state: Pick<
		LocalSyncState,
		| "observedEpoch"
		| "observedRevision"
		| "lastSyncTime"
		| "files"
		| "folderTombstones"
	>;
	assertCurrent?: () => void;
	publish(): void;
}

export type IndexSaveCallback = (
	observation?: RemoteObservation,
) => void | Promise<void>;

export interface SyncGuardResult {
	failure?: FailureSummary;
	blockReason: string | null;
	blockCode?: string;
	blockStatus?: "error" | "migration-required" | "encryption-required";
	validationToken?: string;
}

export type SyncGuardCallback = (
	validationToken?: string,
	observation?: RemoteAuthorityObservation,
	manifestRead?: EncryptionManifestRead,
) => SyncGuardResult | Promise<SyncGuardResult>;

export type ExternalSyncBlockKind =
	| "persistence"
	| "local-state"
	| "force"
	| "migration"
	| "encryption"
	| "historical"
	| "authentication";

export interface ExternalSyncBlock {
	failure?: FailureSummary;
	kind: ExternalSyncBlockKind;
	reason: string;
	code: string;
	status: "error" | "migration-required" | "encryption-required";
}

export interface PhysicalRewriteUploadProof {
	remoteFingerprint: string;
	remoteMtime?: number;
}

export interface SyncRunOptions {
	/** Identify activation requests independently of progress notification policy. */
	trigger?: "manual" | "automatic" | "maintenance";
	/** One explicit, epoch-bound choice; never retained across replacement generations. */
	epochAdoption?: { epoch: string; decision: "accept" | "preserve" };
	/** Report only activity owned by this invocation, including queue preparation. */
	onActivity?: (state: SyncState) => void;
	/** Use the startup discovery path inside the regular full-sync session. */
	startup?: boolean;
	/** Skip encryption state guard for internal encryption maintenance flows. */
	skipEncryptionGuard?: boolean;
	/** Allow a sync nested inside the active encryption maintenance flow. */
	skipMaintenanceGuard?: boolean;
	/** Reject canonical maintenance before filesystem work during preflight. */
	requireStableCanonical?: boolean;
	/** Re-run the remote encryption guard through this transition's local block. */
	validateThroughExternalEncryptionBlock?: boolean;
	/** Only a locally confirmed replacement may overwrite competing target bytes. */
	authoritativeEncryption?: boolean;
	/** Persist changed per-file references before an authoritative rewrite dispatches bytes. */
	capturePhysicalRewriteReference?: (
		path: string,
		file?: import("../types").FileMetadata,
	) => Promise<void>;
	/** Run after all target files are uploaded and before the canonical commit. */
	beforeIndexCommit?: () => void | Promise<void>;
	/** Prove one rewritten target object before it can enter canonical state. */
	verifyPhysicalRewriteUpload?: (
		logicalPath: string,
		sha256: string,
	) => Promise<PhysicalRewriteUploadProof>;
	/** Prevent an epoch race from scheduling more than one immediate follow-up. */
	epochRetry?: boolean;
}

export interface ForceRunOptions {
	/** Direction-verified replacement, created before the destructive confirmation. */
	forceReplacement?: {
		plan: import("./workflows/force-replacement").PreparedForceReplacement;
		backupMode: "with-backup" | "without-backup";
	};
	onActivity?: SyncRunOptions["onActivity"];
}

export interface SyncLifecycleContext {
	sessionId: string;
	kind: SyncSessionKind;
	startup?: boolean;
}

export interface SyncLifecycleOutcome extends SyncLifecycleContext {
	success: boolean;
	deferred?: boolean;
	epochAdopted?: boolean;
}
