import { findErrorCause } from "../utils/error-utils";
import { EncryptionReplacementRevokedError } from "./replacement";
import { ForceRecoveryPendingError } from "../sync/workflows/force-state";
import type { PhysicalRewriteUploadProof, SyncEngine } from "../sync/engine";
import { createSyncFailure } from "../sync/errors";
import type {
	EncryptionModeDescriptor,
	EncryptionTransitionPhase,
	IndexMaintenance,
	PendingPhysicalAction,
	RemoteEncryptionManifest,
	SyncIndex,
} from "../types";
import { computeSha256 } from "../utils/hash-utils";
import { logger } from "../utils/logger";
import {
	getAncestorDirectories,
	isProtectedPath,
	joinPath,
	normalizePath,
} from "../utils/path-utils";
import { protectRecord } from "../utils/record-utils";
import { runWithConcurrencySettled } from "../utils/semaphore";
import {
	getPhysicalResourceFingerprint,
	matchesPhysicalResourceFingerprint,
	matchesStableContentFingerprint,
} from "../utils/resource-fingerprint";
import type {
	EncryptionClient,
	EncryptionEngine,
	EncryptionIndex,
} from "./context";
import type { EncryptionCodec, EncryptionProfileId } from "./encryption";

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
	replacement?: import("../types").EncryptionReplacement;
	referenceFiles?: Record<string, import("../types").FileMetadata>;
	sourceRawPaths: string[];
	targetRawByLogicalPath: Record<string, string>;
	sourceFingerprints: Record<string, string>;
	targetFingerprints: Record<string, string>;
	sourceCanonicalRevision: number;
	backupProof: EncryptionBackupProof | null;
}

/** Verify target bytes and persist the strict proof before returning a file stamp. */
export async function verifyTransitionTargetObject(
	io: {
		client: EncryptionClient;
		remotePath: string;
		persist(): Promise<void>;
	},
	transition: LocalEncryptionTransition,
	logicalPath: string,
	expectedSha256: string,
	targetService: EncryptionCodec | null,
	allowMissing: boolean,
): Promise<PhysicalRewriteUploadProof | null> {
	const rawPath = transition.targetRawByLogicalPath[logicalPath];
	if (!rawPath) {
		throw new Error(
			`Transition target mapping is missing for ${logicalPath}`,
		);
	}
	if (transition.target.enabled !== Boolean(targetService)) {
		throw new Error("Transition target codec does not match its mode");
	}
	const snapshot = await io.client.downloadStableRawFile(
		joinPath(io.remotePath, rawPath),
	);
	if (!snapshot) {
		if (allowMissing) {
			return null;
		}
		throw new Error(`Transition target disappeared for ${logicalPath}`);
	}
	const pinnedFingerprint = transition.targetFingerprints[rawPath];
	if (
		allowMissing &&
		pinnedFingerprint &&
		pinnedFingerprint !== snapshot.fingerprint
	) {
		throw new Error(
			"Transition target fingerprint changed before rollback",
		);
	}
	const decodedPath = await io.client.decodePhysicalUserPath(
		rawPath,
		targetService,
	);
	if (decodedPath !== logicalPath) {
		throw new Error(
			`Transition target decodes to a different logical path`,
		);
	}
	const plaintext = targetService
		? await targetService.decrypt(snapshot.raw)
		: snapshot.raw;
	if ((await computeSha256(plaintext)) !== expectedSha256) {
		throw new Error(
			`Transition target content does not match ${logicalPath}`,
		);
	}
	const remoteFingerprint = getPhysicalResourceFingerprint(snapshot.resource);
	if (!remoteFingerprint) {
		throw new Error("Transition target has no physical fingerprint");
	}
	Object.defineProperty(transition.targetFingerprints, rawPath, {
		value: snapshot.fingerprint,
		writable: true,
		enumerable: true,
		configurable: true,
	});
	await io.persist();
	const remoteMtime = new Date(snapshot.resource.modified).getTime();
	return {
		remoteFingerprint,
		remoteMtime: Number.isFinite(remoteMtime) ? remoteMtime : undefined,
	};
}

interface EncryptionTransitionLifecycle {
	claim(
		transition: LocalEncryptionTransition,
		targetCandidate?: EncryptionCodec | null,
	): Promise<void>;
	applyTarget(
		snapshot: LocalEncryptionSnapshot,
		candidate?: EncryptionCodec | null,
	): Promise<EncryptionCodec | null>;
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
	targetService?: EncryptionCodec | null;
	beforeApplyTarget?(): Promise<void>;
	publishPrepared?(): Promise<void>;
	publishFilesCopied?(): Promise<void>;
	publishIndexCommitted?(): Promise<void>;
}

interface EncryptionCleanupIO {
	client: EncryptionClient;
	getRemotePath(): string;
	getConcurrency(): number;
	completeAction(path: string): void;
	persist(): Promise<void>;
}

interface SourceRollbackAuthority {
	targets: Readonly<Record<string, string>>;
	validate(readCanonical?: () => Promise<SyncIndex>): Promise<SyncIndex>;
}

/**
 * Executes the shared causal workflow for enable, disable, and key rotation.
 * Mode-specific callers only provide manifest publication policy.
 */
export class EncryptionTransitionController {
	constructor(
		private readonly indexManager: EncryptionIndex,
		private readonly syncEngine: EncryptionEngine,
		private readonly lifecycle: EncryptionTransitionLifecycle,
		private readonly cleanupIO?: EncryptionCleanupIO,
	) {}

	async execute(options: EncryptionRewriteOptions): Promise<void> {
		const { transition } = options;
		try {
			await this.lifecycle.claim(transition, options.targetService);
			await options.beforeApplyTarget?.();
			const targetService = await this.lifecycle.applyTarget(
				transition.target,
				options.targetService,
			);
			await this.lifecycle.resolveTargetPaths(transition);
			await options.publishPrepared?.();

			this.indexManager.setIndexTransitionServices(
				options.sourceService,
				targetService,
			);
			let result: Awaited<ReturnType<SyncEngine["reencodeRemoteFiles"]>>;
			try {
				result = await this.syncEngine.reencodeRemoteFiles({
					skipEncryptionGuard: true,
					skipMaintenanceGuard: true,
					authoritativeEncryption: Boolean(transition.replacement),
					verifyPhysicalRewriteUpload: async (logicalPath, sha256) =>
						await this.lifecycle.verifyTargetUpload(
							transition,
							logicalPath,
							sha256,
						),
					beforeIndexCommit: async () => {
						await this.lifecycle.assertSourceUnchanged(transition);
						await this.lifecycle.setPhase("files-copied");
						const cleanup = transition.replacement
							? []
							: requireCleanupProof(transition);
						await this.lifecycle.stageMaintenance(
							transition,
							"index-committed",
							cleanup,
						);
						if (transition.replacement) {
							this.indexManager.stageEncryptionReplacement(
								transition.replacement,
							);
						}
						await options.publishFilesCopied?.();
					},
				});
			} finally {
				this.indexManager.clearIndexTransitionServices();
			}

			if (!result.success) {
				const revoked = result.errors.find((entry) =>
					findErrorCause(
						entry.failureCause,
						(candidate) =>
							candidate instanceof
							EncryptionReplacementRevokedError,
					),
				);
				throw (
					revoked?.failureCause ??
					result.failureCause ??
					result.errors[0]?.failureCause ??
					this.lifecycle.createSyncFailure(result.errors.length)
				);
			}
			await this.lifecycle.setPhase("index-committed");
			await options.publishIndexCommitted?.();
			await this.completeTarget(transition);
		} catch (error) {
			const failure = createSyncFailure(error, {
				stage: `encryption-${transition.phase}`,
				action: "unknown",
				outcome: "unknown",
			});
			try {
				if (
					!findErrorCause(
						error,
						(candidate) =>
							candidate instanceof
							EncryptionReplacementRevokedError,
					)
				) {
					await this.lifecycle.recover();
				}
			} catch (recoveryError) {
				logger.error("Encryption recovery failed", {
					error: createSyncFailure(recoveryError, {
						stage: "encryption-recovery",
						action: "unknown",
					}),
				});
			}
			throw failure;
		}
	}

	/** Complete the post-commit target publication and guarded cleanup. */
	async completeTarget(transition: LocalEncryptionTransition): Promise<void> {
		this.syncEngine.showMaintenanceCleanupPhase();
		const cleanup = transition.replacement
			? []
			: requireCleanupProof(transition);
		await this.lifecycle.publishStable(transition.target);
		await this.lifecycle.commitMaintenance(transition, "cleanup", cleanup);
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

	/** Roll back proven targets while the same source canonical still owns the transition. */
	async rollbackSourceTargets(
		transition: LocalEncryptionTransition,
		options: {
			deviceId: string;
			service: EncryptionCodec | null;
			getTransition(): LocalEncryptionTransition | null;
		},
	): Promise<void> {
		const authority = this.indexManager.getMaintenance();
		const epoch = this.indexManager.getRemoteIndex().epoch;
		if (!authority || authority.kind === "force") {
			throw new Error("Rollback cleanup has no canonical authority");
		}
		const mapping = { ...transition.targetRawByLogicalPath };
		const targets = protectRecord(
			Object.fromEntries(
				Object.values(mapping)
					.filter((path) =>
						Boolean(transition.targetFingerprints[path]),
					)
					.map((path) => [
						path,
						transition.targetFingerprints[path]!,
					]),
			),
		);
		const assertLocal = () => {
			if (
				options.getTransition() !== transition ||
				Object.keys(transition.targetRawByLogicalPath).length !==
					Object.keys(mapping).length ||
				Object.entries(mapping).some(
					([logical, raw]) =>
						transition.targetRawByLogicalPath[logical] !== raw ||
						(targets[raw] &&
							transition.targetFingerprints[raw] !==
								targets[raw]),
				)
			) {
				throw new Error("Local rollback authority changed");
			}
		};
		const rollback: SourceRollbackAuthority = {
			targets,
			validate: async (readCanonical) => {
				assertLocal();
				const current =
					await this.indexManager.assertMaintenanceAuthority(
						epoch,
						authority,
						readCanonical,
					);
				await this.assertLocalRecoveryCoherence({
					transition,
					manifest:
						await this.indexManager.downloadEncryptionManifest(),
					maintenance: current.maintenance,
					deviceId: options.deviceId,
					authority: "source",
					authoritativeService: options.service,
				});
				const latest =
					await this.indexManager.assertMaintenanceAuthority(
						epoch,
						authority,
						readCanonical,
					);
				assertLocal();
				return latest;
			},
		};
		const paths = Object.keys(targets);
		await rollback.validate();
		await this.lifecycle.prepareCleanup(paths, targets);
		await rollback.validate();
		await this.lifecycle.publishStable(transition.source);
		await this.cleanupPaths(paths, targets, rollback);

		await rollback.validate();
		if (!(await this.lifecycle.finishMaintenance(transition))) {
			throw new Error("Encryption rollback cleanup is incomplete");
		}
	}

	/** Every retry revalidates authority and content; absence alone completes an action. */
	async cleanupRawPaths(
		paths: string[],
		fingerprints: Record<string, string>,
	): Promise<void> {
		await this.cleanupPaths(paths, fingerprints);
	}

	private async cleanupPaths(
		paths: string[],
		fingerprints: Record<string, string>,
		rollback?: SourceRollbackAuthority,
	): Promise<void> {
		if (paths.length === 0) {
			return;
		}
		const io = this.cleanupIO;
		const authority = this.indexManager.getMaintenance();
		const epoch = this.indexManager.getRemoteIndex().epoch;
		if (!io || !authority) {
			throw new Error("Encryption cleanup has no canonical authority");
		}
		const lifetime = this.syncEngine.createReadLifetimeGuard();
		const configuration = io.client.getReadConfigurationVersion();
		const remotePath = io.getRemotePath();
		const assertCurrent = () => {
			lifetime();
			if (
				io.client.getReadConfigurationVersion() !== configuration ||
				io.getRemotePath() !== remotePath
			) {
				throw new Error("Encryption cleanup configuration changed");
			}
		};
		const concurrency = rollback
			? 1
			: Math.max(1, Math.min(io.getConcurrency() || 1, 4));
		let cursor = 0;
		let failed = false;
		let firstFailure: unknown;
		await io.client.withWriteGuard(
			() => {
				assertCurrent();
				if (failed) {
					throw firstFailure;
				}
			},
			async () => {
				const workers = Array.from(
					{ length: Math.min(concurrency, paths.length) },
					() => async () => {
						let closeReader = () => {};
						try {
							const reader =
								this.indexManager.createCanonicalReadSession(
									assertCurrent,
								);
							closeReader = () => reader.close();
							while (!failed && cursor < paths.length) {
								const path = paths[cursor++]!;
								await this.cleanupPath(
									path,
									fingerprints[path],
									() =>
										this.validateCleanupAuthority(
											epoch,
											authority,
											rollback,
											reader,
										),
									() => reader.assertCurrent(),
									rollback,
								);
							}
						} catch (error) {
							if (!failed) {
								failed = true;
								firstFailure = error;
							}
							throw error;
						} finally {
							closeReader();
						}
					},
				);
				await runWithConcurrencySettled(
					workers,
					concurrency,
					undefined,
					{ stopOnError: () => true },
				);
				if (failed) {
					throw firstFailure;
				}
			},
		);
	}

	/** A rejected attempt guard is never an ambiguous DELETE response. */
	private async cleanupPath(
		path: string,
		expected: string | undefined,
		readAuthority: () => Promise<SyncIndex>,
		assertCurrent: () => void,
		rollback?: SourceRollbackAuthority,
	): Promise<void> {
		const io = this.cleanupIO!;
		const remotePath = joinPath(io.getRemotePath(), path);
		const validate = async (): Promise<void> => {
			const current = await readAuthority();
			if (
				!expected ||
				!(rollback
					? rollback.targets[path] === expected
					: current.maintenance?.cleanup.some(
							(action) =>
								action.path === path &&
								action.expectedFingerprint === expected,
						))
			) {
				throw new Error(
					"Encryption cleanup action is no longer authorized",
				);
			}
			await this.assertNotLiveRawTarget(remotePath, current.files);
			const resource = await io.client.getResource(
				remotePath,
				1,
				0,
				true,
			);
			if (
				resource &&
				!(rollback
					? matchesStableContentFingerprint(expected, resource)
					: matchesPhysicalResourceFingerprint(expected, resource))
			) {
				throw new Error("Encryption cleanup target changed");
			}
			const latest = await readAuthority();
			if (rollback) {
				await this.assertNotLiveRawTarget(remotePath, latest.files);
			}
			assertCurrent();
		};
		let guardFailed = false;
		let deletionError: unknown;
		try {
			await io.client.deleteResource(
				remotePath,
				false,
				true,
				async () => {
					try {
						await validate();
					} catch (error) {
						guardFailed = true;
						throw error;
					}
				},
			);
		} catch (error) {
			if (guardFailed) {
				throw error;
			}
			deletionError = error;
		}
		await readAuthority();
		if (await io.client.getResource(remotePath, 1, 0, true)) {
			throw deletionError instanceof Error
				? deletionError
				: new Error("Encryption cleanup deletion is incomplete");
		}
		assertCurrent();
		io.completeAction(path);
		await io.persist();
	}

	/** Optional recursive folder pruning is disabled until the server can fence late descendants. */
	async cleanupRawFolders(_paths: string[]): Promise<void> {}

	/** Keep source rollback proof separate from the committed canonical cleanup list. */
	private async validateCleanupAuthority(
		epoch: string,
		maintenance: IndexMaintenance,
		rollback?: SourceRollbackAuthority,
		readCanonical?: () => Promise<SyncIndex>,
	): Promise<SyncIndex> {
		return rollback
			? await rollback.validate(readCanonical)
			: await this.indexManager.assertMaintenanceAuthority(
					epoch,
					maintenance,
					readCanonical,
				);
	}

	private async assertNotLiveRawTarget(
		rawPath: string,
		files: Record<string, import("../types").FileMetadata>,
		folder = false,
	): Promise<void> {
		const io = this.cleanupIO!;
		for (const [logical, meta] of Object.entries(files)) {
			if (meta.deleted) {
				continue;
			}
			const live = await io.client.getPhysicalPath(
				joinPath(io.getRemotePath(), logical),
			);
			if (
				live === rawPath ||
				(folder && live.startsWith(`${rawPath}/`))
			) {
				throw new Error("Cleanup would delete a live canonical target");
			}
		}
	}

	/** Publish target authority before advancing the canonical cleanup phase. */
	async completeRemoteTarget(
		maintenance: IndexMaintenance,
		publishStable: () => Promise<void>,
		cleanup: () => Promise<void>,
	): Promise<void> {
		const epoch = this.indexManager.getRemoteIndex().epoch;
		await this.indexManager.assertMaintenanceAuthority(epoch, maintenance);
		await publishStable();
		await this.indexManager.assertMaintenanceAuthority(epoch, maintenance);
		if (maintenance.phase !== "cleanup") {
			this.indexManager.setMaintenance({
				...maintenance,
				phase: "cleanup",
			});
			await this.indexManager.saveRemoteIndex();
		}
		await cleanup();
	}

	/** Finish canonical cleanup without adopting a foreign epoch or replaying its local queues. */
	async resumeCanonicalCleanup(): Promise<boolean> {
		const maintenance = this.indexManager.getMaintenance();
		if (!maintenance || maintenance.phase !== "cleanup") {
			return true;
		}
		const io = this.cleanupIO;
		if (!io) {
			throw new Error("Encryption cleanup I/O is unavailable");
		}
		const epoch = this.indexManager.getRemoteIndex().epoch;
		const ownsLocalEpoch = this.indexManager.getObservedEpoch() === epoch;
		if (ownsLocalEpoch) {
			for (const action of maintenance.cleanup) {
				this.indexManager.enqueuePhysicalAction(
					"guarded-cleanup",
					action.path,
					{
						expectedFingerprint: action.expectedFingerprint,
						origin: "encryption-cleanup",
						canonicalRevision:
							this.indexManager.getRemoteIndex().revision,
					},
				);
			}
			await io.persist();
		}
		const paths = maintenance.cleanup.map((action) => action.path);
		if (maintenance.replacement) {
			await this.lifecycle.deletePaths([], {});
		} else {
			await this.cleanupRawPaths(
				paths,
				Object.fromEntries(
					maintenance.cleanup.map((action) => [
						action.path,
						action.expectedFingerprint,
					]),
				),
			);
		}
		await this.cleanupRawFolders(paths);
		const pending =
			ownsLocalEpoch &&
			hasPendingEncryptionCleanup(
				this.indexManager.getPendingPhysicalActions(),
				epoch,
			);
		if (!pending) {
			this.indexManager.clearMaintenance(maintenance.id);
			await this.indexManager.saveRemoteIndex();
		}
		await io.persist();
		return !pending;
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
		if (!maintenance) {
			return;
		}
		if (
			(maintenance.phase !== "index-committed" &&
				maintenance.phase !== "cleanup" &&
				maintenance.phase !== "stable") ||
			maintenance.targetRevision === null ||
			!maintenance.target.enabled ||
			(maintenance.kind !== "enable" && maintenance.kind !== "rotate")
		) {
			throw new Error(
				"Stable manifest conflicts with active maintenance",
			);
		}
		if (
			manifest.revision !== maintenance.target.revision ||
			manifest.salt !== maintenance.target.salt ||
			!maintenance.target.verifier ||
			!(await verifies(service, maintenance.target.verifier))
		) {
			throw new Error(
				"Stable manifest does not match maintenance target",
			);
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
			if (
				transition.phase !== "prepared" &&
				transition.phase !== "files-copied"
			) {
				throw new Error(
					"Local transition phase cannot select source authority",
				);
			}
		} else if (
			!maintenance &&
			transition.phase !== "index-committed" &&
			transition.phase !== "cleanup" &&
			transition.phase !== "stable"
		) {
			throw new Error(
				"Target authority has no committed local or canonical phase",
			);
		}

		if (maintenance) {
			const maintenancePreCommit =
				maintenance.phase === "prepared" ||
				maintenance.phase === "files-copied";
			if (
				maintenance.id !== transition.id ||
				maintenance.kind !== transition.kind ||
				maintenance.initiatedBy !== deviceId ||
				maintenance.sourceRevision !==
					transition.sourceCanonicalRevision ||
				!snapshotMatchesModeDescriptor(
					transition.source,
					maintenance.source,
				) ||
				!snapshotMatchesModeDescriptor(
					transition.target,
					maintenance.target,
				) ||
				(sourceAuthoritative
					? !maintenancePreCommit
					: maintenancePreCommit)
			) {
				throw new Error(
					"Local transition does not match canonical maintenance",
				);
			}
		}

		const authoritativeSnapshot = sourceAuthoritative
			? transition.source
			: transition.target;
		if (authoritativeSnapshot.enabled) {
			if (!authoritativeService) {
				throw new Error(
					"Encrypted recovery authority requires its codec",
				);
			}
			const maintenanceMode = maintenance
				? sourceAuthoritative
					? maintenance.source
					: maintenance.target
				: null;
			if (
				maintenanceMode &&
				(!maintenanceMode.verifier ||
					!(await verifies(
						authoritativeService,
						maintenanceMode.verifier,
					)))
			) {
				throw new Error(
					"Canonical maintenance verifier does not match recovery authority",
				);
			}
			const manifestDescribesAuthority =
				manifest?.state === "enabled" ||
				(sourceAuthoritative && manifest?.state === "disabling") ||
				(!sourceAuthoritative &&
					(manifest?.state === "enabling" ||
						manifest?.state === "rotating"));
			if (
				manifestDescribesAuthority &&
				manifest &&
				!(await verifies(authoritativeService, manifest.verifier))
			) {
				throw new Error(
					"Manifest verifier does not match recovery authority",
				);
			}
		}
		if (!manifest) {
			if (authoritativeSnapshot.enabled) {
				throw new Error(
					"Encrypted recovery authority requires a manifest",
				);
			}
			return;
		}
		if (manifest.state === "enabled") {
			if (
				!authoritativeSnapshot.enabled ||
				manifest.salt !== authoritativeSnapshot.salt ||
				manifest.revision !== authoritativeSnapshot.revision
			) {
				throw new Error(
					"Stable manifest does not match local recovery authority",
				);
			}
			return;
		}
		if (!maintenance || !manifest.transition) {
			throw new Error(
				"Transitional manifest requires matching maintenance",
			);
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
			!snapshotMatchesModeDescriptor(
				transition.source,
				descriptor.source,
			) ||
			!snapshotMatchesModeDescriptor(
				transition.target,
				descriptor.target,
			) ||
			(!exactPhase && !allowedPreCommitPublicationWindow)
		) {
			throw new Error(
				"Manifest does not match local transition recovery",
			);
		}
	}
}

export type EncryptionRecoveryDecision =
	"finish-target" | "rollback-source" | "blocked";

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
	if (!manifest || manifest.state === "enabled") {
		return null;
	}
	if (manifest.state === "enabling") {
		return "enable";
	}
	if (manifest.state === "rotating") {
		return "rotate";
	}
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
	const sourceAncestors = getAncestorDirectories(source);
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
			throw new Error(
				`Encryption target collides with source path ${rawPath}`,
			);
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
			throw new Error(
				`Duplicate encryption logical target ${logicalPath}`,
			);
		}
		logicalByRaw.set(rawPath, logicalPath);
		targetPaths.add(rawPath);
		for (const ancestor of getAncestorDirectories([rawPath])) {
			targetAncestors.add(ancestor);
		}
		rawByLogical.set(logicalPath, rawPath);
	}
	return protectRecord(Object.fromEntries(rawByLogical));
}

function hasPathAncestor(
	path: string,
	candidates: ReadonlySet<string>,
): boolean {
	const segments = path.split("/");
	let ancestor = segments[0] ?? "";
	for (let index = 1; index < segments.length; index++) {
		if (candidates.has(ancestor)) {
			return true;
		}
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
		path
			.split("/")
			.some(
				(segment) =>
					segment === "" || segment === "." || segment === "..",
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
	if (maintenance?.kind === "force") {
		throw new ForceRecoveryPendingError();
	}
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
			throw new Error(
				"Missing manifest is valid only for plaintext target",
			);
		}
		return { kind, maintenance, passwordMode: "none" };
	}

	const transition = manifest.transition;
	if (
		!transition ||
		transition.id !== maintenance.id ||
		transition.initiatedBy !== maintenance.initiatedBy ||
		(transition.phase !== maintenance.phase &&
			!(
				maintenance.phase === "cleanup" &&
				transition.phase === "index-committed"
			)) ||
		manifest.updatedBy !== transition.initiatedBy
	) {
		throw new Error(
			"Remote transition identity does not match maintenance",
		);
	}
	if (
		!sameModeDescriptor(transition.source, maintenance.source) ||
		!sameModeDescriptor(transition.target, maintenance.target) ||
		transition.sourceRevision !== maintenance.source.revision ||
		transition.targetRevision !== maintenance.target.revision
	) {
		throw new Error(
			"Remote transition descriptors do not match maintenance",
		);
	}
	if (
		transition.sourceProfileId !==
			(maintenance.source.enabled ? "hardened" : null) ||
		transition.targetProfileId !==
			(maintenance.target.enabled ? "hardened" : null)
	) {
		throw new Error("Remote transition profiles do not match maintenance");
	}

	const declaredMode =
		kind === "disable" ? maintenance.source : maintenance.target;
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
	if (invalid) {
		throw new Error("Encryption maintenance modes do not match its kind");
	}
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
