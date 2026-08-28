import type {
	EncryptionCodec,
	EncryptionProfileId,
} from "./encryption";
import type { IndexManager } from "../sync/index-manager";
import type { SyncEngine } from "../sync/sync-engine";
import type {
	EncryptionTransitionPhase,
	EncryptionModeDescriptor,
	IndexMaintenance,
	PendingPhysicalAction,
	RemoteEncryptionManifest,
} from "../types";
import type { PhysicalRewriteUploadProof } from "../sync/sync-engine";
import { isProtectedPath, normalizePath } from "../utils/path-utils";

export interface LocalEncryptionSnapshot {
	enabled: boolean;
	salt: string | null;
	password: string | null;
	revision: number | null;
	profileId: EncryptionProfileId | null;
}

export interface EncryptionBackupProof {
	path: string;
	sha256: string;
	epoch: string;
	canonicalRevision: number;
	localSnapshotDigest: string;
	createdAt: number;
}

export interface LocalEncryptionTransition {
	id: string;
	kind: "enable" | "disable" | "rotate";
	phase: EncryptionTransitionPhase;
	source: LocalEncryptionSnapshot;
	target: LocalEncryptionSnapshot;
	sourceRawPaths: string[];
	targetRawByLogicalPath: Record<string, string>;
	sourceFingerprints: Record<string, string>;
	targetFingerprints: Record<string, string>;
	sourceCanonicalRevision: number;
	backupProof: EncryptionBackupProof;
}

interface EncryptionTransitionLifecycle {
	claim(transition: LocalEncryptionTransition): Promise<void>;
	applyTarget(snapshot: LocalEncryptionSnapshot): Promise<EncryptionCodec | null>;
	resolveTargetPaths(transition: LocalEncryptionTransition): Promise<void>;
	assertSourceUnchanged(transition: LocalEncryptionTransition): Promise<void>;
	verifyTargetUpload(
		transition: LocalEncryptionTransition,
		logicalPath: string,
		sha256: string,
	): Promise<PhysicalRewriteUploadProof>;
	setPhase(phase: EncryptionTransitionPhase): Promise<void>;
	stageMaintenance(
		transition: LocalEncryptionTransition,
		phase: EncryptionTransitionPhase,
		cleanup?: IndexMaintenance["cleanup"],
	): Promise<void>;
	commitMaintenance(
		transition: LocalEncryptionTransition,
		phase: EncryptionTransitionPhase,
		cleanup?: IndexMaintenance["cleanup"],
	): Promise<void>;
	publishStable(snapshot: LocalEncryptionSnapshot): Promise<void>;
	prepareCleanup(
		paths: string[],
		fingerprints: Record<string, string>,
	): Promise<void>;
	deletePaths(
		paths: string[],
		fingerprints: Record<string, string>,
	): Promise<void>;
	deleteFolders(paths: string[]): Promise<void>;
	finishMaintenance(transition: LocalEncryptionTransition): Promise<boolean>;
	clearLocalTransition(): Promise<void>;
	recover(): Promise<void>;
	clearBlock(): void;
	createSyncFailure(errorCount: number): Error;
}

export interface EncryptionRewriteOptions {
	transition: LocalEncryptionTransition;
	sourceService: EncryptionCodec | null;
	beforeApplyTarget?(): Promise<void>;
	publishPrepared?(): Promise<void>;
	publishFilesCopied?(): Promise<void>;
	publishIndexCommitted?(): Promise<void>;
}

/**
 * Executes the shared causal workflow for enable, disable, and key rotation.
 * Mode-specific callers only provide manifest publication policy.
 */
export class EncryptionTransitionController {
	constructor(
		private readonly indexManager: IndexManager,
		private readonly syncEngine: SyncEngine,
		private readonly lifecycle: EncryptionTransitionLifecycle,
	) {}

	async execute(options: EncryptionRewriteOptions): Promise<void> {
		const { transition } = options;
		try {
			await this.lifecycle.claim(transition);
			await options.beforeApplyTarget?.();
			const targetService = await this.lifecycle.applyTarget(
				transition.target,
			);
			await this.lifecycle.resolveTargetPaths(transition);
			await options.publishPrepared?.();

			this.indexManager.setIndexTransitionServices(
				options.sourceService,
				targetService,
			);
			let result: Awaited<
				ReturnType<SyncEngine["reencodeRemoteFiles"]>
			>;
			try {
				result = await this.syncEngine.reencodeRemoteFiles({
					skipEncryptionGuard: true,
					skipMaintenanceGuard: true,
					verifyPhysicalRewriteUpload: async (logicalPath, sha256) =>
						await this.lifecycle.verifyTargetUpload(
							transition,
							logicalPath,
							sha256,
						),
					beforeIndexCommit: async () => {
						await this.lifecycle.assertSourceUnchanged(transition);
						await this.lifecycle.setPhase("files-copied");
						const cleanup = requireCleanupProof(transition);
						await this.lifecycle.stageMaintenance(
							transition,
							"index-committed",
							cleanup,
						);
						await options.publishFilesCopied?.();
					},
				});
			} finally {
				this.indexManager.clearIndexTransitionServices();
			}

			if (!result.success) {
				throw this.lifecycle.createSyncFailure(result.errors.length);
			}
			await this.lifecycle.setPhase("index-committed");
			await options.publishIndexCommitted?.();
			await this.completeTarget(transition);
		} catch (error) {
			await this.lifecycle.recover();
			throw error;
		}
	}

	/** Complete the post-commit target publication and guarded cleanup. */
	async completeTarget(transition: LocalEncryptionTransition): Promise<void> {
		this.syncEngine.showMaintenanceCleanupPhase();
		const cleanup = requireCleanupProof(transition);
		await this.lifecycle.publishStable(transition.target);
		await this.lifecycle.commitMaintenance(
			transition,
			"cleanup",
			cleanup,
		);
		await this.lifecycle.prepareCleanup(
			transition.sourceRawPaths,
			transition.sourceFingerprints,
		);
		await this.lifecycle.deletePaths(
			transition.sourceRawPaths,
			transition.sourceFingerprints,
		);
		await this.lifecycle.deleteFolders(transition.sourceRawPaths);
		if (!(await this.lifecycle.finishMaintenance(transition))) {
			throw new Error("Encryption cleanup is incomplete");
		}
		await this.lifecycle.clearLocalTransition();
		this.lifecycle.clearBlock();
	}

	getRemoteTargetRecoveryKind(
		manifest: RemoteEncryptionManifest | null,
	): RemoteTargetRecoveryKind | null {
		return getRemoteTargetRecoveryKind(manifest);
	}

	/** Build a cross-artifact recovery plan only for a committed target. */
	createRemoteTargetRecoveryPlan(
		manifest: RemoteEncryptionManifest | null,
		maintenance: IndexMaintenance | undefined,
	): RemoteTargetRecoveryPlan {
		return createRemoteTargetRecoveryPlan(manifest, maintenance);
	}

	/** Validate a stable manifest that was published before cleanup completed. */
	async assertStableManifestTarget(
		manifest: RemoteEncryptionManifest,
		maintenance: IndexMaintenance | undefined,
		service: EncryptionCodec,
	): Promise<void> {
		if (!maintenance) return;
		if (
			(maintenance.phase !== "index-committed" &&
				maintenance.phase !== "cleanup" &&
				maintenance.phase !== "stable") ||
			maintenance.targetRevision === null ||
			!maintenance.target.enabled ||
			(maintenance.kind !== "enable" && maintenance.kind !== "rotate")
		) {
			throw new Error("Stable manifest conflicts with active maintenance");
		}
		if (
			manifest.revision !== maintenance.target.revision ||
			manifest.salt !== maintenance.target.salt ||
			!maintenance.target.verifier ||
			!(await verifies(service, maintenance.target.verifier))
		) {
			throw new Error("Stable manifest does not match maintenance target");
		}
	}

	/** Validate local recovery against the manifest and canonical authority. */
	async assertLocalRecoveryCoherence(options: {
		transition: LocalEncryptionTransition;
		manifest: RemoteEncryptionManifest | null;
		maintenance: IndexMaintenance | undefined;
		deviceId: string;
		authority: "source" | "target";
		authoritativeService: EncryptionCodec | null;
	}): Promise<void> {
		const {
			transition,
			manifest,
			maintenance,
			deviceId,
			authority,
			authoritativeService,
		} = options;
		const sourceAuthoritative = authority === "source";
		if (sourceAuthoritative) {
			if (transition.phase !== "prepared" && transition.phase !== "files-copied") {
				throw new Error("Local transition phase cannot select source authority");
			}
		} else if (
			!maintenance &&
			transition.phase !== "index-committed" &&
			transition.phase !== "cleanup" &&
			transition.phase !== "stable"
		) {
			throw new Error("Target authority has no committed local or canonical phase");
		}

		if (maintenance) {
			const maintenancePreCommit =
				maintenance.phase === "prepared" ||
				maintenance.phase === "files-copied";
			if (
				maintenance.id !== transition.id ||
				maintenance.kind !== transition.kind ||
				maintenance.initiatedBy !== deviceId ||
				maintenance.sourceRevision !== transition.sourceCanonicalRevision ||
				!snapshotMatchesModeDescriptor(transition.source, maintenance.source) ||
				!snapshotMatchesModeDescriptor(transition.target, maintenance.target) ||
				(sourceAuthoritative ? !maintenancePreCommit : maintenancePreCommit)
			) {
				throw new Error("Local transition does not match canonical maintenance");
			}
		}

		const authoritativeSnapshot = sourceAuthoritative
			? transition.source
			: transition.target;
		if (authoritativeSnapshot.enabled) {
			if (!authoritativeService) {
				throw new Error("Encrypted recovery authority requires its codec");
			}
			const maintenanceMode = maintenance
				? sourceAuthoritative
					? maintenance.source
					: maintenance.target
				: null;
			if (
				maintenanceMode &&
				(!maintenanceMode.verifier ||
					!(await verifies(authoritativeService, maintenanceMode.verifier)))
			) {
				throw new Error("Canonical maintenance verifier does not match recovery authority");
			}
			const manifestDescribesAuthority =
				manifest?.state === "enabled" ||
				(sourceAuthoritative && manifest?.state === "disabling") ||
				(!sourceAuthoritative &&
					(manifest?.state === "enabling" || manifest?.state === "rotating"));
			if (
				manifestDescribesAuthority &&
				manifest &&
				!(await verifies(authoritativeService, manifest.verifier))
			) {
				throw new Error("Manifest verifier does not match recovery authority");
			}
		}
		if (!manifest) {
			if (authoritativeSnapshot.enabled) {
				throw new Error("Encrypted recovery authority requires a manifest");
			}
			return;
		}
		if (manifest.state === "enabled") {
			if (
				!authoritativeSnapshot.enabled ||
				manifest.salt !== authoritativeSnapshot.salt ||
				manifest.revision !== authoritativeSnapshot.revision
			) {
				throw new Error("Stable manifest does not match local recovery authority");
			}
			return;
		}
		if (!maintenance || !manifest.transition) {
			throw new Error("Transitional manifest requires matching maintenance");
		}
		const expectedState = {
			enable: "enabling",
			rotate: "rotating",
			disable: "disabling",
		}[transition.kind];
		const descriptor = manifest.transition;
		const exactPhase = descriptor.phase === maintenance.phase;
		const allowedPreCommitPublicationWindow =
			sourceAuthoritative &&
			transition.phase === "files-copied" &&
			descriptor.phase === "index-committed" &&
			(maintenance.phase === "prepared" ||
				maintenance.phase === "files-copied");
		if (
			manifest.state !== expectedState ||
			descriptor.id !== transition.id ||
			descriptor.initiatedBy !== deviceId ||
			!sameModeDescriptor(descriptor.source, maintenance.source) ||
			!sameModeDescriptor(descriptor.target, maintenance.target) ||
			!snapshotMatchesModeDescriptor(transition.source, descriptor.source) ||
			!snapshotMatchesModeDescriptor(transition.target, descriptor.target) ||
			(!exactPhase && !allowedPreCommitPublicationWindow)
		) {
			throw new Error("Manifest does not match local transition recovery");
		}
	}
}

export type EncryptionRecoveryDecision =
	| "finish-target"
	| "rollback-source"
	| "blocked";

/**
 * Select the only safe recovery direction around the canonical index commit.
 */
export function decideEncryptionRecovery(
	phase: EncryptionTransitionPhase,
	targetReadable: boolean,
	sourceReadable: boolean,
): EncryptionRecoveryDecision {
	if (
		phase === "index-committed" ||
		phase === "stable" ||
		phase === "cleanup" ||
		targetReadable
	) {
		return "finish-target";
	}
	return sourceReadable ? "rollback-source" : "blocked";
}

export type RemoteTargetRecoveryKind = "enable" | "rotate" | "disable";

export interface RemoteTargetRecoveryPlan {
	kind: RemoteTargetRecoveryKind;
	maintenance: IndexMaintenance;
	passwordMode: "source" | "target" | "none";
}

export function getRemoteTargetRecoveryKind(
	manifest: RemoteEncryptionManifest | null,
): RemoteTargetRecoveryKind | null {
	if (!manifest || manifest.state === "enabled") return null;
	if (manifest.state === "enabling") return "enable";
	if (manifest.state === "rotating") return "rotate";
	return "disable";
}

/** Build a complete injective target map before any physical upload starts. */
export function createTargetRawMapping(
	entries: Iterable<readonly [string, string]>,
	sourcePaths: Iterable<string>,
): Record<string, string> {
	const source = new Set<string>();
	for (const sourcePath of sourcePaths) {
		assertSafeTransitionPath(sourcePath, "physical source");
		source.add(sourcePath);
	}
	const sourceAncestors = collectPathAncestors(source);
	const logicalByRaw = new Map<string, string>();
	const targetPaths = new Set<string>();
	const targetAncestors = new Set<string>();
	const rawByLogical = new Map<string, string>();
	for (const [logicalPath, rawPath] of entries) {
		assertSafeTransitionPath(logicalPath, "logical target");
		assertSafeTransitionPath(rawPath, "physical target");
		if (
			source.has(rawPath) ||
			sourceAncestors.has(rawPath) ||
			hasPathAncestor(rawPath, source)
		) {
			throw new Error(`Encryption target collides with source path ${rawPath}`);
		}
		const existingLogicalPath = logicalByRaw.get(rawPath);
		if (
			existingLogicalPath ||
			targetAncestors.has(rawPath) ||
			hasPathAncestor(rawPath, targetPaths)
		) {
			throw new Error(
				`Encryption target collision for ${existingLogicalPath ?? "another target"} and ${logicalPath}`,
			);
		}
		if (rawByLogical.has(logicalPath)) {
			throw new Error(`Duplicate encryption logical target ${logicalPath}`);
		}
		logicalByRaw.set(rawPath, logicalPath);
		targetPaths.add(rawPath);
		for (const ancestor of collectPathAncestors([rawPath])) {
			targetAncestors.add(ancestor);
		}
		rawByLogical.set(logicalPath, rawPath);
	}
	return Object.fromEntries(rawByLogical);
}

function collectPathAncestors(paths: Iterable<string>): Set<string> {
	const result = new Set<string>();
	for (const path of paths) {
		const segments = path.split("/");
		let ancestor = segments[0] ?? "";
		for (let index = 1; index < segments.length; index++) {
			result.add(ancestor);
			ancestor = `${ancestor}/${segments[index]}`;
		}
	}
	return result;
}

function hasPathAncestor(path: string, candidates: ReadonlySet<string>): boolean {
	const segments = path.split("/");
	let ancestor = segments[0] ?? "";
	for (let index = 1; index < segments.length; index++) {
		if (candidates.has(ancestor)) return true;
		ancestor = `${ancestor}/${segments[index]}`;
	}
	return false;
}

export function assertSafeTransitionPath(path: string, label: string): void {
	if (
		!path ||
		normalizePath(path) !== path ||
		isProtectedPath(path) ||
		path.includes("\\") ||
		path.includes("\0") ||
		path.split("/").some((segment) =>
			segment === "" || segment === "." || segment === ".."
		)
	) {
		throw new Error(`Invalid encryption ${label} path`);
	}
}

/** Ignore unrelated durable work when deciding whether encryption may finish. */
export function hasPendingEncryptionCleanup(
	actions: readonly PendingPhysicalAction[],
	epoch: string,
): boolean {
	return actions.some(
		(action) =>
			action.type === "guarded-cleanup" &&
			action.origin === "encryption-cleanup" &&
			action.epoch === epoch,
	);
}

/**
 * Validate manifest and canonical maintenance as one post-commit authority.
 */
export function createRemoteTargetRecoveryPlan(
	manifest: RemoteEncryptionManifest | null,
	maintenance: IndexMaintenance | undefined,
): RemoteTargetRecoveryPlan {
	if (
		!maintenance ||
		(maintenance.phase !== "index-committed" &&
			maintenance.phase !== "cleanup" &&
			maintenance.phase !== "stable") ||
		maintenance.targetRevision === null
	) {
		throw new Error("Remote target maintenance is not post-commit");
	}
	const manifestKind = getRemoteTargetRecoveryKind(manifest);
	const kind = manifestKind ?? "disable";
	if (maintenance.kind !== kind) {
		throw new Error("Remote target maintenance kind does not match");
	}
	assertModePair(kind, maintenance.source, maintenance.target);

	if (!manifest) {
		if (kind !== "disable" || maintenance.target.enabled) {
			throw new Error("Missing manifest is valid only for plaintext target");
		}
		return { kind, maintenance, passwordMode: "none" };
	}

	const transition = manifest.transition;
	if (
		!transition ||
		transition.id !== maintenance.id ||
		transition.initiatedBy !== maintenance.initiatedBy ||
		transition.phase !== maintenance.phase ||
		manifest.updatedBy !== transition.initiatedBy
	) {
		throw new Error("Remote transition identity does not match maintenance");
	}
	if (
		!sameModeDescriptor(transition.source, maintenance.source) ||
		!sameModeDescriptor(transition.target, maintenance.target) ||
		transition.sourceRevision !== maintenance.source.revision ||
		transition.targetRevision !== maintenance.target.revision
	) {
		throw new Error("Remote transition descriptors do not match maintenance");
	}
	if (
		transition.sourceProfileId !==
			(maintenance.source.enabled ? "hardened" : null) ||
		transition.targetProfileId !==
			(maintenance.target.enabled ? "hardened" : null)
	) {
		throw new Error("Remote transition profiles do not match maintenance");
	}

	const declaredMode = kind === "disable"
		? maintenance.source
		: maintenance.target;
	const manifestMode: EncryptionModeDescriptor = {
		enabled: true,
		revision: manifest.revision,
		salt: manifest.salt,
		verifier: manifest.verifier,
	};
	if (!sameModeDescriptor(manifestMode, declaredMode)) {
		throw new Error("Manifest key does not match committed maintenance");
	}
	return {
		kind,
		maintenance,
		passwordMode: kind === "disable" ? "source" : "target",
	};
}

function assertModePair(
	kind: RemoteTargetRecoveryKind,
	source: EncryptionModeDescriptor,
	target: EncryptionModeDescriptor,
): void {
	const invalid =
		(kind === "enable" && (source.enabled || !target.enabled)) ||
		(kind === "disable" && (!source.enabled || target.enabled)) ||
		(kind === "rotate" &&
			(!source.enabled ||
				!target.enabled ||
				(target.revision ?? 0) <= (source.revision ?? 0) ||
				target.salt === source.salt ||
				target.verifier === source.verifier));
	if (invalid) throw new Error("Encryption maintenance modes do not match its kind");
}

function sameModeDescriptor(
	left: EncryptionModeDescriptor,
	right: EncryptionModeDescriptor,
): boolean {
	return (
		left.enabled === right.enabled &&
		left.revision === right.revision &&
		left.salt === right.salt &&
		left.verifier === right.verifier
	);
}

function snapshotMatchesModeDescriptor(
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

async function verifies(
	service: EncryptionCodec,
	verifier: string,
): Promise<boolean> {
	try {
		return await service.verifyVerifier(verifier);
	} catch {
		return false;
	}
}

function requireCleanupProof(
	transition: LocalEncryptionTransition,
): IndexMaintenance["cleanup"] {
	return transition.sourceRawPaths.map((path) => {
		const expectedFingerprint = transition.sourceFingerprints[path];
		if (
			!Object.prototype.hasOwnProperty.call(
				transition.sourceFingerprints,
				path,
			) ||
			typeof expectedFingerprint !== "string" ||
			!expectedFingerprint
		) {
			throw new Error(`Missing cleanup fingerprint for ${path}`);
		}
		return { path, expectedFingerprint };
	});
}
