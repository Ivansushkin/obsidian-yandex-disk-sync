import type { SyncSessionKind, SyncState } from "../types";
import { type ForceCanonicalProof } from "./canonical/manager";

export type SyncEventCallback = (state: SyncState) => void;

export type IndexSaveCallback = () => void | Promise<void>;

export interface SyncGuardResult {
	blockReason: string | null;
	blockCode?: string;
	blockStatus?: "error" | "migration-required" | "encryption-required";
	validationToken?: string;
}

export type SyncGuardCallback = (
	validationToken?: string,
) => SyncGuardResult | Promise<SyncGuardResult>;

export type ExternalSyncBlockKind =
	| "local-state"
	| "migration"
	| "encryption"
	| "historical"
	| "authentication";

export interface ExternalSyncBlock {
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
	/**
	 * Skip generation of delete_remote operations. Used by encryption transition
	 * flows where remote cleanup of stale paths is handled separately as a bulk
	 * operation, avoiding race conditions from concurrent folder deletions.
	 */
	skipRemoteDeletes?: boolean;
	/** Run after all target files are uploaded and before the canonical commit. */
	beforeIndexCommit?: () => void | Promise<void>;
	/** Prove one rewritten target object before it can enter canonical state. */
	verifyPhysicalRewriteUpload?: (
		logicalPath: string,
		sha256: string,
	) => Promise<PhysicalRewriteUploadProof>;
	/** Prevent an epoch race from scheduling more than one immediate follow-up. */
	epochRetry?: boolean;
	/** Exact verified backup and pre-backup canonical identity for Force only. */
	forceBackupProof?: ForceBackupProof;
	/** Verified source boundaries, with an optional user-selected archive. */
	forcePreflightProof?: ForcePreflightProof;
	/** Run a compatible caller pre-mutation hook after Force proof revalidation. */
	beforeForceMutation?: () => void | Promise<void>;
}

export interface ForcePreflightProof {
	direction: "from_local" | "from_remote";
	canonical: ForceCanonicalProof;
	snapshotDigest: string;
	backup: { backupName: string; backupSha256: string } | null;
}

export interface ForceBackupProof {
	direction: "from_local" | "from_remote";
	canonical: ForceCanonicalProof;
	snapshotDigest: string;
	backupName: string;
	backupSha256: string;
}

export interface SyncLifecycleContext {
	sessionId: string;
	kind: SyncSessionKind;
	startup?: boolean;
}

export interface SyncLifecycleOutcome extends SyncLifecycleContext {
	success: boolean;
	epochAdopted?: boolean;
}
