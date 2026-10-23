import { validateEncryptionModeDescriptor } from "../canonical/schema";
import { assertForcePath, isRootIndexLockPath } from "../../utils/path-utils";
import type {
	EncryptionManifest,
	EncryptionModeDescriptor,
	FileMetadata,
	IndexMaintenanceCleanupAction,
} from "../../types";
import { assertSafeTransitionPath } from "../../crypto/encryption-transition";

export type ForceDirection = "from_local" | "from_remote";
export type ForcePhase = "prepared" | "applying" | "cleanup";

export interface ForceSourceFile {
	path: string;
	sha256: string;
	size: number;
	mtime: number;
	rawPath: string;
	fingerprint: string | null;
}

/** Direct replacement progress is local; no locks or payload files are created remotely. */
export interface DirectForceCheckpoint {
	format: "direct-v1";
	configDir: string;
	stage: "purging" | "copying" | "publishing";
	directories: { path: string; rawPath: string }[];
	pendingDeletes: {
		path: string;
		location: "local" | "remote";
		kind: "file" | "dir";
	}[];
	pendingFiles: string[];
	pendingDirectories: string[];
	canonicalReset: boolean;
}

/** Durable source identities and authority; credentials remain exclusively in local plugin data. */
export interface ForceRecovery {
	direct?: DirectForceCheckpoint;
	completion: {
		epoch: string;
		revision: number;
		canonicalSha256: string;
	} | null;
	password: string | null;
	id: string;
	direction: ForceDirection;
	phase: ForcePhase;
	backupMode: "with-backup" | "without-backup";
	backupProof: {
		name: string;
		sha256: string;
		snapshotDigest: string;
	} | null;
	epoch: string;
	remotePath: string;
	rootResourceId: string | null;
	originalCanonicalFingerprint: string | null;
	serviceCleanup: IndexMaintenanceCleanupAction[];
	sourceDigest: string;
	source: ForceSourceFile[];
	target: EncryptionModeDescriptor;
	manifest: EncryptionManifest | null;
	watcherCutoff: string[];
	cleanup: IndexMaintenanceCleanupAction[];
	targetHashes: Record<string, string>;
	files: Record<string, FileMetadata>;
}

/** Validate recovery before it can authorize any filesystem mutation. */
export function assertForceRecovery(
	value: unknown,
): asserts value is ForceRecovery | null {
	if (value === null) {
		return;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid Force recovery");
	}
	const state = value as ForceRecovery;
	const keys = [
		"completion",
		"password",
		"id",
		"direction",
		"phase",
		"backupMode",
		"backupProof",
		"epoch",
		"remotePath",
		"rootResourceId",
		"originalCanonicalFingerprint",
		"serviceCleanup",
		"sourceDigest",
		"source",
		"target",
		"manifest",
		"watcherCutoff",
		"cleanup",
		"targetHashes",
		"files",
	];
	if ("direct" in state) {
		keys.push("direct");
		assertDirectCheckpoint(state.direct);
	}
	const assertPath = state.direct
		? assertForcePath
		: (path: string) => assertSafeTransitionPath(path, "Force");
	if (
		Object.keys(value).length !== keys.length ||
		!keys.every((key) => key in value) ||
		!["from_local", "from_remote"].includes(state.direction) ||
		!["prepared", "applying", "cleanup"].includes(state.phase) ||
		!["with-backup", "without-backup"].includes(state.backupMode) ||
		![state.id, state.epoch, state.remotePath, state.sourceDigest].every(
			(s) => typeof s === "string" && s.length > 0,
		) ||
		!(
			state.rootResourceId === null ||
			typeof state.rootResourceId === "string"
		) ||
		!Array.isArray(state.serviceCleanup) ||
		!Array.isArray(state.source) ||
		!Array.isArray(state.cleanup) ||
		!Array.isArray(state.watcherCutoff) ||
		!state.watcherCutoff.every((id) => typeof id === "string") ||
		!(state.password === null || typeof state.password === "string") ||
		!state.target ||
		typeof state.target.enabled !== "boolean" ||
		!state.files ||
		typeof state.files !== "object" ||
		Array.isArray(state.files)
	) {
		throw new Error("Invalid Force recovery shape");
	}
	if (
		state.backupMode === "with-backup" &&
		(!state.backupProof ||
			typeof state.backupProof.name !== "string" ||
			state.backupProof.name.includes("/") ||
			!state.backupProof.name ||
			!/^[a-f0-9]{64}$/.test(state.backupProof.sha256) ||
			!/^[a-f0-9]{64}$/.test(state.backupProof.snapshotDigest))
	) {
		throw new Error("Invalid Force archive proof");
	}
	if (
		state.completion !== null &&
		(!state.completion ||
			typeof state.completion !== "object" ||
			Array.isArray(state.completion) ||
			Object.keys(state.completion).length !== 3 ||
			state.completion.epoch !== state.epoch ||
			!Number.isSafeInteger(state.completion.revision) ||
			state.completion.revision < 1 ||
			!/^[a-f0-9]{64}$/.test(state.completion.canonicalSha256) ||
			state.phase !== "cleanup")
	) {
		throw new Error("Invalid Force completion receipt");
	}
	validateEncryptionModeDescriptor(state.target, "Force target");
	assertForceManifest(state);
	if (
		!/^[a-zA-Z0-9_-]{8,128}$/.test(state.id) ||
		!/^[a-zA-Z0-9_-]{8,128}$/.test(state.epoch) ||
		!/^[a-f0-9]{64}$/.test(state.sourceDigest) ||
		!(
			state.originalCanonicalFingerprint === null ||
			typeof state.originalCanonicalFingerprint === "string"
		)
	) {
		throw new Error("Invalid Force authority");
	}
	const rawPaths = new Set<string>();
	const paths = new Set<string>();
	for (const file of state.source) {
		assertPath(file.path);
		assertPath(file.rawPath);
		if (
			Object.keys(file).length !== 6 ||
			paths.has(file.path) ||
			rawPaths.has(file.rawPath) ||
			!/^[a-f0-9]{64}$/.test(file.sha256) ||
			!Number.isSafeInteger(file.size) ||
			file.size < 0 ||
			!Number.isFinite(file.mtime) ||
			!(file.fingerprint === null || typeof file.fingerprint === "string")
		) {
			throw new Error("Invalid Force source manifest");
		}
		paths.add(file.path);
		rawPaths.add(file.rawPath);
	}
	if (
		!state.targetHashes ||
		typeof state.targetHashes !== "object" ||
		Array.isArray(state.targetHashes)
	) {
		throw new Error("Invalid Force target proofs");
	}
	for (const [path, hash] of Object.entries(state.targetHashes)) {
		assertPath(path);
		if (!/^[a-f0-9]{64}$/.test(hash)) {
			throw new Error("Invalid Force target hash");
		}
	}
	for (const [path, metadata] of Object.entries(state.files)) {
		const source = state.source.find((file) => file.path === path);
		if (
			!source ||
			!metadata ||
			metadata.path !== path ||
			metadata.sha256 !== source.sha256 ||
			metadata.size !== source.size ||
			metadata.mutationSeq !== 0 ||
			metadata.deleted
		) {
			throw new Error("Invalid Force verified file");
		}
	}
	for (const action of state.serviceCleanup) {
		if (
			!isRootIndexLockPath(action.path) ||
			typeof action.expectedFingerprint !== "string" ||
			!action.expectedFingerprint ||
			Object.keys(action).length !== 2
		) {
			throw new Error("Invalid Force service cleanup proof");
		}
	}
	for (const action of state.cleanup) {
		assertSafeTransitionPath(action.path, "Force cleanup");
		if (
			typeof action.expectedFingerprint !== "string" ||
			!action.expectedFingerprint
		) {
			throw new Error("Invalid Force cleanup proof");
		}
	}
}

/** Reject malformed direct checkpoints rather than widening the scope of old recovery. */
function assertDirectCheckpoint(
	value: unknown,
): asserts value is DirectForceCheckpoint {
	const state = value as DirectForceCheckpoint | undefined;
	const keys = [
		"format",
		"configDir",
		"stage",
		"directories",
		"pendingDeletes",
		"pendingFiles",
		"pendingDirectories",
		"canonicalReset",
	];
	if (
		!state ||
		Object.keys(state).length !== keys.length ||
		!keys.every((key) => key in state) ||
		state.format !== "direct-v1" ||
		typeof state.configDir !== "string" ||
		!["purging", "copying", "publishing"].includes(state.stage) ||
		typeof state.canonicalReset !== "boolean" ||
		!Array.isArray(state.directories) ||
		!Array.isArray(state.pendingDeletes) ||
		!Array.isArray(state.pendingFiles) ||
		!Array.isArray(state.pendingDirectories)
	) {
		throw new Error("Invalid direct Force checkpoint");
	}
	assertForcePath(state.configDir);
	for (const directory of state.directories) {
		if (!directory || Object.keys(directory).length !== 2) {
			throw new Error("Invalid Force source directory");
		}
		assertForcePath(directory.path);
		assertForcePath(directory.rawPath);
	}
	for (const entry of state.pendingDeletes) {
		if (
			!entry ||
			Object.keys(entry).length !== 3 ||
			!["local", "remote"].includes(entry.location) ||
			!["file", "dir"].includes(entry.kind)
		) {
			throw new Error("Invalid Force deletion");
		}
		assertForcePath(entry.path);
		if (entry.path === ".backup" || entry.path.startsWith(".backup/")) {
			throw new Error("Force cannot delete backups");
		}
	}
	for (const path of [...state.pendingFiles, ...state.pendingDirectories]) {
		assertForcePath(path);
	}
}

/** Check nested wire parameters before local recovery can publish a manifest. */
function assertForceManifest(state: ForceRecovery): void {
	const manifest = state.manifest;
	if (!state.target.enabled) {
		if (manifest !== null || state.password !== null) {
			throw new Error(
				"Plaintext Force has encrypted recovery parameters",
			);
		}
		return;
	}
	if (
		!manifest ||
		!state.password ||
		manifest.format !== "encryption-manifest" ||
		manifest.profileId !== "hardened" ||
		manifest.state !== "enabled" ||
		manifest.salt !== state.target.salt ||
		manifest.verifier !== state.target.verifier ||
		manifest.revision !== state.target.revision ||
		!Number.isFinite(manifest.updatedAt) ||
		typeof manifest.updatedBy !== "string" ||
		!manifest.updatedBy ||
		Object.keys(manifest).length !== 12 ||
		!matchesParameters(manifest.kdf, {
			name: "PBKDF2",
			hash: "SHA-256",
			iterations: 600000,
		}) ||
		!matchesParameters(manifest.keySchedule, {
			name: "HKDF",
			hash: "SHA-256",
		}) ||
		!matchesParameters(manifest.cipher, {
			name: "AES-GCM",
			keyLength: 256,
			ivLength: 12,
		}) ||
		!matchesParameters(manifest.filenameCipher, {
			name: "AES-SIV",
			keyLength: 512,
			encoding: "base64url",
			aad: "obsidian-yandex-disk-sync:filename",
		})
	) {
		throw new Error("Force manifest parameters are incoherent");
	}
}

function matchesParameters(
	value: unknown,
	expected: Record<string, unknown>,
): boolean {
	return (
		!!value &&
		typeof value === "object" &&
		Object.keys(value).length === Object.keys(expected).length &&
		Object.entries(expected).every(
			([key, entry]) => (value as Record<string, unknown>)[key] === entry,
		)
	);
}

/** Uncertain Force state requires explicit recovery rather than encryption authentication. */
export class ForceRecoveryPendingError extends Error {
	readonly code = "force-recovery-pending";
	constructor(
		message = "Force recovery is pending; continue the saved operation or explicitly confirm a new replacement",
	) {
		super(message);
		this.name = "ForceRecoveryPendingError";
	}
}
