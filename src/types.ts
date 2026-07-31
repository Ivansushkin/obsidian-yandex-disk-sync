/**
 * Types and interfaces for Yandex Disk synchronization plugin
 */

// ============================================================================
// Plugin settings
// ============================================================================

export interface YandexDiskSyncSettings {
	/** OAuth token stored only in local plugin data */
	yandexTokenSecret: string;
	/** Client ID for Yandex OAuth application */
	clientId: string;
	/** Path to folder on Yandex Disk */
	remotePath: string;
	/** Auto-sync interval in minutes (0 = disabled) */
	syncInterval: number;
	/** Enable real-time sync on filesystem events */
	enableRealtimeSync: boolean;
	/** Patterns for including files in synchronization */
	syncPatterns: string[];
	/** Patterns for excluding files from synchronization */
	excludePatterns: string[];
	/** Synchronize .obsidian folder */
	syncDotObsidian: boolean;
	/** Unique device identifier */
	deviceId: string;
	/** Debounce delay for real-time sync in ms */
	debounceDelay: number;
	/** Maximum number of concurrent operations during sync */
	maxConcurrency: number;
	/** Enable debug logging (verbose output) */
	enableDebugLogging: boolean;
	/** Write logs to a file in the vault for debugging */
	logToFile: boolean;
	/** Enable end-to-end encryption */
	enableEncryption: boolean;
	/** Base64-encoded salt for key derivation (null = not initialized) */
	encryptionSalt: string | null;
	/**
	 * User-provided encryption password stored locally as a plaintext string.
	 * This field is intentionally not encrypted because Obsidian mobile plugins
	 * do not have access to the OS keychain. Keep it inside plugin sandbox data.
	 */
	encryptionPassword: string | null;
	/** Remote encryption manifest revision applied on this device */
	encryptionRevision: number | null;
}

export const DEFAULT_SETTINGS: YandexDiskSyncSettings = {
	yandexTokenSecret: "",
	clientId: "",
	remotePath: "obsidian-sync",
	syncInterval: 5,
	enableRealtimeSync: true,
	syncPatterns: ["**"],
	excludePatterns: ["workspace.json", "cache"],
	syncDotObsidian: false,
	deviceId: "",
	debounceDelay: 1000,
	maxConcurrency: 10,
	enableDebugLogging: false,
	logToFile: true,
	enableEncryption: false,
	encryptionSalt: null,
	encryptionPassword: null,
	encryptionRevision: null,
};

// ============================================================================
// Encryption manifest
// ============================================================================

export type EncryptionManifestState =
	| "enabled"
	| "enabling"
	| "rotating"
	| "disabling";

export interface EncryptionManifestKdfParams {
	/** Key derivation algorithm */
	name: "PBKDF2";
	/** Hash algorithm used by PBKDF2 */
	hash: "SHA-256";
	/** Number of PBKDF2 iterations */
	iterations: number;
}

export interface EncryptionManifestCipherParams {
	/** Content and verifier cipher */
	name: "AES-GCM";
	/** AES key length in bits */
	keyLength: number;
	/** AES-GCM IV length in bytes */
	ivLength: number;
}

export type EncryptionTransitionPhase =
	| "prepared"
	| "files-copied"
	| "index-committed"
	| "stable"
	| "cleanup";

export interface EncryptionTransitionDescriptor {
	/** Stable transition identifier */
	id: string;
	/** Current durable transition phase */
	phase: EncryptionTransitionPhase;
	/** Source encryption revision, or null for plaintext */
	sourceRevision: number | null;
	/** Target encryption revision, or null for plaintext */
	targetRevision: number | null;
	/** Device responsible for recovery */
	initiatedBy: string;
	/** Source encryption mode used before the canonical commit */
	source?: EncryptionModeDescriptor;
	/** Target encryption mode used after the canonical commit */
	target?: EncryptionModeDescriptor;
}

export interface EncryptionModeDescriptor {
	/** Whether user files and canonical index content are encrypted */
	enabled: boolean;
	/** Key revision, or null for plaintext */
	revision: number | null;
	/** Base64-encoded PBKDF2 salt, or null for plaintext */
	salt: string | null;
	/** Password verifier, or null for plaintext */
	verifier: string | null;
}

export interface EncryptionManifest {
	/** Manifest format version */
	version: 2;
	/** Current remote encryption state */
	state: EncryptionManifestState;
	/** Monotonic key revision shared by devices */
	revision: number;
	/** Base64-encoded PBKDF2 salt */
	salt: string;
	/** Base64-encoded encrypted verifier payload */
	verifier: string;
	/** Key derivation parameters */
	kdf: EncryptionManifestKdfParams;
	/** Cipher parameters */
	cipher: EncryptionManifestCipherParams;
	/** Unix timestamp of the latest manifest update */
	updatedAt: number;
	/** Device ID that wrote the manifest */
	updatedBy: string;
	/** Recovery metadata present only while encryption is transitioning */
	transition?: EncryptionTransitionDescriptor;
}

export interface LegacyEncryptionManifest {
	/** Legacy salt-only manifest format */
	version: 1;
	/** Legacy salt-only manifests are treated as enabled */
	state: "enabled";
	/** Synthetic revision for legacy manifests */
	revision: 1;
	/** Base64-encoded PBKDF2 salt */
	salt: string;
	/** Legacy manifests do not contain password verifier */
	verifier: null;
	/** Marks a manifest converted from the legacy format */
	legacy: true;
	/** Legacy manifests do not contain update timestamp */
	updatedAt: number;
	/** Legacy manifests do not contain writer device ID */
	updatedBy: string;
}

export type RemoteEncryptionManifest =
	| EncryptionManifest
	| LegacyEncryptionManifest;

// ============================================================================
// Synchronization index
// ============================================================================

export interface SyncIndex {
	/** Index format version */
	version: number;
	/** Causal history generation replaced only by an explicit Force sync */
	epoch: string;
	/** Monotonic revision of the authoritative remote index */
	revision: number;
	/** Last synchronization time (timestamp) */
	lastSyncTime: number;
	/** Device ID that created the index */
	deviceId: string;
	/** File map: path -> metadata */
	files: Record<string, FileMetadata>;
	/** Folder deletion markers keyed by normalized folder path */
	folderTombstones: Record<string, FolderTombstone>;
	/** Pending logical moves keyed by mutation ID */
	moves: Record<string, IndexMove>;
	/** Highest contiguous mutation sequence accepted for each device */
	appliedMutationSeq: Record<string, number>;
	/** Distributed encryption maintenance owned through the index transaction */
	maintenance?: IndexMaintenance;
}

export interface IndexMaintenanceCleanupAction {
	/** Raw physical path that belongs to the obsolete encryption mode */
	path: string;
	/** Immutable server fingerprint captured before the transition commit */
	expectedFingerprint: string;
}

export interface IndexMaintenance {
	/** Globally unique transition identifier */
	id: string;
	/** Maintenance operation kind */
	kind: "enable" | "disable" | "rotate";
	/** Durable phase used for crash recovery */
	phase: EncryptionTransitionPhase;
	/** Installation that acquired the distributed transition ownership */
	initiatedBy: string;
	/** Canonical revision observed before maintenance started */
	sourceRevision: number;
	/** Canonical revision that switched authority to the target mode */
	targetRevision: number | null;
	/** Source encryption mode */
	source: EncryptionModeDescriptor;
	/** Target encryption mode */
	target: EncryptionModeDescriptor;
	/** Guarded cleanup work that any target-capable device may resume */
	cleanup: IndexMaintenanceCleanupAction[];
}

/**
 * Device-local causal baseline. It is deliberately not shaped as a canonical
 * index: reading remote state must not advance what this installation has
 * fully observed and applied.
 */
export interface LocalSyncState {
	/** Local state format version */
	version: 1;
	/** Installation identifier that owns pending FIFO sequences */
	deviceId: string;
	/** Canonical epoch last fully applied on this installation */
	observedEpoch: string | null;
	/** Canonical revision last fully applied on this installation */
	observedRevision: number;
	/** Last successful local reconciliation time */
	lastSyncTime: number;
	/** Per-path plaintext baselines and canonical causal metadata */
	files: Record<string, FileMetadata>;
	/** Folder tombstones last observed by this installation */
	folderTombstones: Record<string, FolderTombstone>;
	/** Next sequence reserved for a new local mutation */
	nextMutationSeq: number;
}

export interface FileMetadata {
	/** Relative file path */
	path: string;
	/** SHA256 hash of content */
	sha256: string;
	/** File size in bytes */
	size: number;
	/** Modification time (timestamp) */
	mtime: number;
	/** Last sync time for this file */
	syncedAt: number;
	/**
	 * Server-side modification time of the remote resource (Yandex Disk
	 * `resource.modified`). Stored separately from `mtime` (which is the local
	 * filesystem mtime) so remote-side change detection can compare server
	 * timestamps against server timestamps, avoiding clock skew between devices
	 * and the different semantics of local vs server mtime.
	 * undefined for entries written by older plugin versions or rebuilt from
	 * a fresh local index; consumers must fall back to the legacy mixed-clock
	 * comparison logic in that case.
	 */
	remoteMtime?: number;
	/** Server content fingerprint used for guarded cleanup */
	remoteFingerprint?: string;
	/** Soft delete flag */
	deleted?: boolean;
	/** Deletion time (timestamp) */
	deletedAt?: number;
	/** Folder tombstone that caused this derived file deletion */
	deletedByFolder?: string;
	/** Device ID that last modified the file */
	lastModifiedBy?: string;
	/** Remote index revision that last changed this entry */
	changedRevision?: number;
	/** Revision visible to the device when this change was created */
	baseRevision?: number;
}

export interface FolderTombstone {
	/** Normalized folder path */
	path: string;
	/** Deletion timestamp for diagnostics only */
	deletedAt: number;
	/** Revision that accepted the deletion */
	changedRevision: number;
	/** Revision visible to the deleting device */
	baseRevision: number;
	/** Device that created the deletion */
	lastModifiedBy: string;
}

export interface IndexMove {
	/** Stable mutation identifier */
	id: string;
	/** Source path */
	fromPath: string;
	/** Destination path */
	toPath: string;
	/** Whether the moved resource is a file or folder */
	kind: "file" | "folder";
	/** Revision visible when the move was created */
	baseRevision: number;
	/** Revision that accepted the move */
	changedRevision: number;
	/** Whether the physical move is still pending */
	pending: boolean;
	/** Device that created the move */
	lastModifiedBy: string;
}

export type PendingMutationType =
	| "put"
	| "noop"
	| "delete-file"
	| "delete-folder"
	| "move";

export interface PendingMutation {
	/** Globally unique, stable mutation identifier */
	id: string;
	/** Monotonic sequence scoped to the originating device */
	seq: number;
	/** Canonical epoch in which this mutation was created */
	epoch: string | null;
	/** Mutation kind */
	type: PendingMutationType;
	/** Revision visible when the local event occurred, or null on first sync */
	baseRevision: number | null;
	/** Source or affected path */
	path: string;
	/** Destination path for move mutations */
	targetPath?: string;
	/** Resource kind for move mutations */
	resourceKind?: "file" | "folder";
	/** Plaintext content hash for put mutations */
	sha256?: string;
	/** Last confirmed local hash before the put changed the in-memory entry */
	baselineSha256?: string;
	/** Creation timestamp for diagnostics and FIFO ordering */
	createdAt: number;
}

export type PendingPhysicalActionType =
	| "delete-local"
	| "delete-remote"
	| "move-remote"
	| "guarded-cleanup";

export type PendingPhysicalActionOrigin =
	| "exact-delete"
	| "folder-delete"
	| "move"
	| "rejected-upload"
	| "encryption-cleanup"
	| "force-reset";

/**
 * Durable local work that must happen after its canonical intent is committed.
 */
export interface PendingPhysicalAction {
	/** Stable identifier used for idempotent retries */
	id: string;
	/** Physical operation kind */
	type: PendingPhysicalActionType;
	/** Canonical epoch that authorized this action */
	epoch: string | null;
	/** Logical operation that created this physical work */
	origin: PendingPhysicalActionOrigin;
	/** Source or affected logical path */
	path: string;
	/** Destination logical path for move operations */
	targetPath?: string;
	/** Canonical revision that authorized this action */
	canonicalRevision: number;
	/** Server fingerprint required by guarded cleanup */
	expectedFingerprint?: string;
	/** Canonical file revision that authorized a destructive action */
	expectedChangedRevision?: number;
	/** Target fingerprint used to verify a completed move */
	expectedTargetFingerprint?: string;
	/** Plaintext baseline used to decide whether local backup is required */
	baselineSha256?: string;
	/** Creation timestamp used to retain FIFO ordering */
	createdAt: number;
}

export const CURRENT_INDEX_VERSION = 3;

export function createSyncEpoch(): string {
	const uuid = globalThis.crypto?.randomUUID?.();
	if (uuid) return uuid;
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createEmptyIndex(
	deviceId: string,
	epoch = createSyncEpoch(),
): SyncIndex {
	return {
		version: CURRENT_INDEX_VERSION,
		epoch,
		revision: 0,
		lastSyncTime: 0,
		deviceId,
		files: {},
		folderTombstones: {},
		moves: {},
		appliedMutationSeq: {},
	};
}

export function createEmptyLocalState(deviceId: string): LocalSyncState {
	return {
		version: 1,
		deviceId,
		observedEpoch: null,
		observedRevision: 0,
		lastSyncTime: 0,
		files: {},
		folderTombstones: {},
		nextMutationSeq: 1,
	};
}

// ============================================================================
// Synchronization state
// ============================================================================

export type SyncStatus =
	| "idle"
	| "syncing"
	| "error"
	| "paused"
	| "offline"
	| "initializing"
	| "encryption-required";

export interface SyncState {
	/** Current synchronization status */
	status: SyncStatus;
	/** Error message (if any) */
	errorMessage?: string;
	/** Last successful sync time */
	lastSyncTime?: number;
	/** Number of files pending synchronization */
	pendingCount: number;
	/** Current operation progress (0-100) */
	progress?: number;
	/** Current operation description */
	currentOperation?: string;
}

export const INITIAL_SYNC_STATE: SyncState = {
	status: "idle",
	pendingCount: 0,
};

// ============================================================================
// Synchronization operations
// ============================================================================

export type SyncAction =
	| "upload"
	| "download"
	| "delete_remote"
	| "delete_local"
	| "conflict"
	| "none";

export interface SyncOperation {
	/** Operation type */
	action: SyncAction;
	/** File path */
	path: string;
	/** Operation reason */
	reason: string;
	/** Local metadata (if available) */
	localMeta?: FileMetadata;
	/** Remote metadata (if available) */
	remoteMeta?: FileMetadata;
	/** Folder tombstone responsible for a derived deletion */
	folderTombstonePath?: string;
}

export interface SyncResult {
	/** Whether synchronization completed successfully */
	success: boolean;
	/** Number of uploaded files */
	uploaded: number;
	/** Number of downloaded files */
	downloaded: number;
	/** Number of deleted files */
	deleted: number;
	/** Number of conflicts */
	conflicts: number;
	/** Errors (if any) */
	errors: SyncError[];
	/** Synchronization start time */
	startTime: number;
	/** Synchronization end time */
	endTime: number;
}

export interface SyncError {
	/** File path */
	path: string;
	/** Operation that caused the error */
	operation: SyncAction;
	/** Error message */
	message: string;
	/** Error code (if available) */
	code?: string;
}

// ============================================================================
// Yandex Disk API types
// ============================================================================

export interface YandexResource {
	path: string;
	type: "file" | "dir";
	name: string;
	created: string;
	modified: string;
	size?: number;
	mime_type?: string;
	/** MD5 hash of the resource content (Yandex Disk, present for files) */
	md5?: string;
	sha256?: string;
	resource_id?: string;
	revision?: number;
	file?: string;
	_embedded?: YandexResourceList;
}

export interface YandexResourceList {
	total: number;
	limit: number;
	offset: number;
	path: string;
	sort: string;
	items: YandexResource[];
}

export interface YandexUploadLink {
	method: string;
	href: string;
	templated: boolean;
	operation_id?: string;
}

export interface YandexDownloadLink {
	method: string;
	href: string;
	templated: boolean;
}

export interface YandexError {
	error: string;
	description: string;
	message?: string;
	reason?: string;
}

// ============================================================================
// Backup management
// ============================================================================

export interface BackupInfo {
	/** Backup filename (e.g., backup_2026-01-25_14-30-00.zip) */
	name: string;
	/** Date created, parsed from filename */
	created: Date;
	/** File size in bytes */
	size: number;
	/** Full path on Yandex Disk */
	remotePath: string;
}
