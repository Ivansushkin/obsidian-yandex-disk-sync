import { t } from "../i18n/index";
import type { IndexMaintenance, RemoteEncryptionManifest } from "../types";
import { logger } from "../utils/logger";
import { UnreadableRemoteIndexError } from "../sync/canonical/errors";
import type { EncryptionContext } from "./context";
import { type EncryptionCodec } from "./encryption";
import type { EncryptionTransitionController } from "./encryption-transition";
import {
	decideEncryptionRecovery,
	verifyTransitionTargetObject,
	type LocalEncryptionSnapshot,
	type LocalEncryptionTransition,
} from "./encryption-transition";
import type { EncryptionMaintenance } from "./maintenance";
type RecoveryWorkflow = Pick<
	EncryptionMaintenance,
	| "applyEncryptionSnapshot"
	| "createEncryptionManifest"
	| "getEncryptionTransitionLogContext"
	| "hasPendingGuardedCleanup"
	| "requireCanonicalMaintenanceCleanupComplete"
>;

/** Resumes source rollback or committed target cleanup without selecting a new archive. */
export class EncryptionRecovery {
	constructor(
		private readonly context: EncryptionContext,
		private readonly workflow: RecoveryWorkflow,
		private readonly controller: EncryptionTransitionController,
		private readonly connectForSync: (
			password: string,
			manifest?: RemoteEncryptionManifest,
		) => Promise<void>,
	) {}

	/** Resume post-commit cleanup using only the target password. */
	async recoverRemoteEncryptedTargetTransition(
		manifest: RemoteEncryptionManifest,
		service: EncryptionCodec,
		password: string,
	): Promise<void> {
		if (!manifest.transition) {
			throw new Error(t("notice.encryption_remote_busy"));
		}
		const candidateCanonical =
			await this.context.index.readCanonicalIndexWithCodec(service);
		this.controller.createRemoteTargetRecoveryPlan(
			manifest,
			candidateCanonical.maintenance,
		);
		await this.context.index.runTargetMaintenanceRecovery(
			manifest.transition.id,
			async () => {
				await this.context.index.loadRemoteIndexWithTargetCodec(
					service,
				);
				const maintenance = await this.context.manager.acceptCandidate({
					service,
					verifier: manifest.verifier,
					validateAuthority: async () =>
						this.controller.createRemoteTargetRecoveryPlan(
							manifest,
							this.context.index.getMaintenance(),
						).maintenance,
					persist: async () => {
						await this.workflow.applyEncryptionSnapshot({
							enabled: true,
							salt: manifest.salt,
							password,
							revision: manifest.revision,
							profileId: "hardened",
						});
					},
				});
				if (!maintenance) {
					throw new Error(t("notice.encryption_remote_busy"));
				}
				await this.controller.completeRemoteTarget(
					maintenance,
					async () =>
						this.context.index.uploadEncryptionManifest(
							await this.workflow.createEncryptionManifest(
								service,
								manifest.salt,
								"enabled",
								manifest.revision,
							),
						),
					() =>
						this.workflow.requireCanonicalMaintenanceCleanupComplete(),
				);
			},
		);
		this.context.ui.setBlock(null);
	}

	/** Recover a committed disable using the plaintext target canonical. */
	async recoverRemotePlaintextTargetTransition(
		manifest: RemoteEncryptionManifest | null,
		verifiedSourceService: EncryptionCodec | null,
	): Promise<void> {
		const canonical =
			await this.context.index.readCanonicalIndexWithCodecIfPresent(null);
		if (!canonical) {
			throw new Error(t("notice.encryption_remote_busy"));
		}
		const maintenance = canonical.maintenance;
		if (!maintenance) {
			throw new Error(t("notice.encryption_remote_busy"));
		}
		const plan = this.controller.createRemoteTargetRecoveryPlan(
			manifest,
			maintenance,
		);
		if (plan.kind !== "disable" || maintenance.target.enabled) {
			throw new Error(t("notice.encryption_remote_busy"));
		}
		if (
			manifest &&
			(!verifiedSourceService ||
				!maintenance.source.verifier ||
				!(await verifiedSourceService.verifyVerifier(
					maintenance.source.verifier,
				)))
		) {
			throw new Error(t("notice.encryption_wrong_password"));
		}

		await this.context.index.runTargetMaintenanceRecovery(
			maintenance.id,
			async () => {
				this.context.index.setIndexTransitionServices(null, null);
				try {
					await this.context.index.loadRemoteIndexWithTargetCodec(
						null,
					);
					const validateCurrent = async () =>
						this.controller.createRemoteTargetRecoveryPlan(
							manifest,
							this.context.index.getMaintenance(),
						).maintenance;
					let current: IndexMaintenance | null;
					if (manifest) {
						current = await this.context.manager.acceptCandidate({
							service: verifiedSourceService,
							verifier: manifest.verifier,
							validateAuthority: validateCurrent,
							persist: async () => {
								await this.workflow.applyEncryptionSnapshot({
									enabled: false,
									salt: null,
									password: null,
									revision: null,
									profileId: null,
								});
							},
						});
					} else {
						current = await validateCurrent();
						await this.workflow.applyEncryptionSnapshot({
							enabled: false,
							salt: null,
							password: null,
							revision: null,
							profileId: null,
						});
					}
					if (!current) {
						throw new Error(t("notice.encryption_wrong_password"));
					}
					await this.controller.completeRemoteTarget(
						current,
						async () => {
							if (manifest) {
								await this.context.index.deleteEncryptionManifest();
							}
						},
						() =>
							this.workflow.requireCanonicalMaintenanceCleanupComplete(),
					);
				} finally {
					this.context.index.clearIndexTransitionServices();
				}
			},
		);
		this.context.ui.setBlock(null);
		this.context.ui.stateChanged();
	}

	async tryRecoverRemoteTargetTransition(): Promise<boolean> {
		try {
			const manifest =
				await this.context.index.downloadEncryptionManifest();
			if (!manifest) {
				const canonical =
					await this.context.index.readCanonicalIndexWithCodecIfPresent(
						null,
					);
				if (!canonical?.maintenance) {
					return false;
				}
				this.controller.createRemoteTargetRecoveryPlan(
					null,
					canonical.maintenance,
				);
				await this.context.engine.runExclusiveMaintenance(async () => {
					await this.recoverRemotePlaintextTargetTransition(
						null,
						null,
					);
				});
				return true;
			}
			const password = this.context.getSettings().encryptionPassword;
			if (
				!password ||
				!this.context.getSettings().enableEncryption ||
				this.context.getSettings().encryptionSalt !== manifest.salt ||
				this.context.getSettings().encryptionProfileId !== "hardened"
			) {
				return false;
			}
			await this.connectForSync(password, manifest);
			return true;
		} catch (error) {
			logger.warn("Target encryption transition recovery is blocked", {
				error,
			});
			throw error;
		}
	}

	/** Only a decoded-content mismatch permits trying the other transition codec. */
	private async canReadCanonicalWith(
		snapshot: LocalEncryptionSnapshot,
	): Promise<boolean> {
		await this.workflow.applyEncryptionSnapshot(snapshot);
		try {
			await this.context.index.loadRemoteIndex();
			return true;
		} catch (error) {
			if (error instanceof UnreadableRemoteIndexError) {
				return false;
			}
			throw error;
		}
	}

	/** Retire a final-save checkpoint only after proving a completed, unchanged source tree. */
	private async assertCompletedSourceRollback(
		transition: LocalEncryptionTransition,
	): Promise<void> {
		const current = await this.context.index.readCanonicalIndex();
		if (
			current.maintenance ||
			current.epoch !== this.context.index.getObservedEpoch() ||
			current.revision < transition.sourceCanonicalRevision
		) {
			throw new Error(
				"Completed source rollback has no matching canonical authority",
			);
		}
		const snapshots = await this.context.index.getRemoteRawFileSnapshots();
		const sourcePaths = new Set(transition.sourceRawPaths);
		if (
			snapshots.length !== sourcePaths.size ||
			snapshots.some(
				({ path, fingerprint }) =>
					!sourcePaths.has(path) ||
					transition.sourceFingerprints[path] !== fingerprint,
			)
		) {
			throw new Error("Completed source rollback physical tree changed");
		}
		const latest = await this.context.index.readCanonicalIndex();
		if (
			this.context.getTransition() !== transition ||
			latest.maintenance ||
			latest.epoch !== current.epoch ||
			latest.revision !== current.revision
		) {
			throw new Error("Completed source rollback authority changed");
		}
		await this.controller.assertLocalRecoveryCoherence({
			transition,
			manifest: await this.context.index.downloadEncryptionManifest(),
			maintenance: latest.maintenance,
			deviceId: this.context.getSettings().deviceId,
			authority: "source",
			authoritativeService: this.context.getService(),
		});
	}

	async recoverEncryptionTransition(): Promise<void> {
		const transition = this.context.getTransition();
		if (!transition) {
			return;
		}
		// Recovery may upload a stable manifest or resume cleanup, so reject
		// unsupported remote metadata before deciding either direction.
		const manifest = await this.context.index.downloadEncryptionManifest();
		const committedPhase =
			transition.phase === "index-committed" ||
			transition.phase === "stable" ||
			transition.phase === "cleanup";
		const targetReadable = committedPhase
			? false
			: await this.canReadCanonicalWith(transition.target);
		const sourceReadable =
			!committedPhase &&
			!targetReadable &&
			(await this.canReadCanonicalWith(transition.source));
		const decision = decideEncryptionRecovery(
			transition.phase,
			targetReadable,
			sourceReadable,
		);
		logger.warn("Recovering interrupted encryption transition", {
			...this.workflow.getEncryptionTransitionLogContext(transition),
			targetReadable,
			sourceReadable,
			recoveryDecision: decision,
		});
		if (decision === "blocked") {
			throw new Error(
				"Encryption transition recovery could not read the canonical index with either key",
			);
		}

		if (decision === "finish-target") {
			await this.workflow.applyEncryptionSnapshot(transition.target);
			await this.context.index.loadRemoteIndex();
			const maintenance = this.context.index.getMaintenance();
			await this.controller.assertLocalRecoveryCoherence({
				transition,
				manifest,
				maintenance,
				deviceId: this.context.getSettings().deviceId,
				authority: "target",
				authoritativeService: this.context.getService(),
			});
			if (!maintenance) {
				if (this.workflow.hasPendingGuardedCleanup()) {
					throw new Error(
						"Stable encryption recovery still has pending cleanup",
					);
				}
				this.context.setTransition(null);
				await this.context.persist();
				this.context.ui.setBlock(null);
				return;
			}
			await this.controller.completeTarget(transition);
			return;
		} else {
			await this.workflow.applyEncryptionSnapshot(transition.source);
			await this.context.index.loadRemoteIndex();
			const maintenance = this.context.index.getMaintenance();
			await this.controller.assertLocalRecoveryCoherence({
				transition,
				manifest,
				maintenance,
				deviceId: this.context.getSettings().deviceId,
				authority: "source",
				authoritativeService: this.context.getService(),
			});
			let targetService: EncryptionCodec | null = null;
			if (transition.target.enabled) {
				if (
					!transition.target.profileId ||
					!transition.target.salt ||
					!transition.target.password
				) {
					throw new Error(
						"Encrypted transition target is incomplete",
					);
				}
				targetService = await this.context.manager.createCodec(
					transition.target.profileId,
					transition.target.salt,
					transition.target.password,
				);
			}
			let targetPresent = false;
			for (const logicalPath of Object.keys(
				transition.targetRawByLogicalPath,
			)) {
				const metadata =
					this.context.index.getRemoteIndex().files[logicalPath];
				if (!metadata || metadata.deleted) {
					throw new Error(
						`Transition target has no authoritative logical metadata for ${logicalPath}`,
					);
				}
				const proof = await verifyTransitionTargetObject(
					{
						client: this.context.client,
						remotePath: this.context.getSettings().remotePath,
						persist: () => this.context.persist(),
					},
					transition,
					logicalPath,
					metadata.sha256,
					targetService,
					true,
				);
				targetPresent = targetPresent || Boolean(proof);
			}
			if (maintenance) {
				await this.controller.rollbackSourceTargets(transition, {
					deviceId: this.context.getSettings().deviceId,
					service: this.context.getService(),
					getTransition: () => this.context.getTransition(),
				});
			} else if (targetPresent) {
				throw new Error("Rollback cleanup has no canonical authority");
			} else if (this.workflow.hasPendingGuardedCleanup()) {
				throw new Error("Encryption rollback cleanup is incomplete");
			} else {
				await this.assertCompletedSourceRollback(transition);
			}
		}
		if (this.context.getTransition() !== transition) {
			throw new Error("Local encryption recovery authority changed");
		}
		this.context.setTransition(null);
		try {
			await this.context.persist();
		} catch (error) {
			this.context.setTransition(transition);
			throw error;
		}
		this.context.ui.setBlock(null);
	}
}
