/**
 * Types and interfaces for Yandex Disk synchronization plugin
 */

// ============================================================================
// Plugin settings
// ============================================================================

export interface YandexDiskSyncSettings {
	/** OAuth token secret name (stored in SecretStorage) */
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
	/** Last synchronization time (timestamp) */
	lastSyncTime: number;
	/** Device ID that created the index */
	deviceId: string;
	/** File map: path -> metadata */
	files: Record<string, FileMetadata>;
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
	/** Soft delete flag */
	deleted?: boolean;
	/** Deletion time (timestamp) */
	deletedAt?: number;
	/** Device ID that last modified the file */
	lastModifiedBy?: string;
}

export const CURRENT_INDEX_VERSION = 2;

export function createEmptyIndex(deviceId: string): SyncIndex {
	return {
		version: CURRENT_INDEX_VERSION,
		lastSyncTime: 0,
		deviceId,
		files: {},
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

export interface YandexOperationStatus {
	status: "success" | "in-progress" | "failed";
}

// ============================================================================
// Plugin events
// ============================================================================

export interface FileChangeEvent {
	type: "create" | "modify" | "delete" | "rename";
	path: string;
	oldPath?: string;
	timestamp: number;
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
