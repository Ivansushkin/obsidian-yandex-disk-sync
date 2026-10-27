import type { StartupReadSession } from "../sync/canonical/manager";
import type { OperationBackupChoice } from "../backup/operation-backup-choice";
import { UnsupportedHistoricalDataError } from "../compatibility-errors";
import { t } from "../i18n/index";
import type { RemoteEncryptionManifest } from "../types";
import { logger } from "../utils/logger";
import { EncryptionAdmission } from "./admission";
import type { EncryptionContext } from "./context";
import {
	createEncryptionCodec,
	EncryptionService,
	type EncryptionCodec,
	type EncryptionProfileId,
} from "./encryption";
import {
	EncryptionTransitionController,
	verifyTransitionTargetObject,
	type EncryptionBackupProof,
	type LocalEncryptionSnapshot,
} from "./encryption-transition";
import { EncryptionMaintenance } from "./maintenance";
import { EncryptionRecovery } from "./recovery";

/** Bound a credential connection to its original operation and recovery permission. */
export interface EncryptionConnectionOptions {
	allowRecovery?: boolean;
	assertCurrent?(): void;
}

/** Prepares transitions and wires the existing controller to snapshot and recovery ports. */
export class EncryptionWorkflow {
	readonly maintenance: EncryptionMaintenance;
	readonly controller: EncryptionTransitionController;
	readonly recovery: EncryptionRecovery;
	readonly admission: EncryptionAdmission;
	constructor(private readonly context: EncryptionContext) {
		this.controller = new EncryptionTransitionController(
			context.index,
			context.engine,
			{
				claim: (transition, targetCandidate) =>
					this.maintenance.claimEncryptionMaintenance(
						transition,
						targetCandidate,
					),
				applyTarget: (snapshot, candidate) =>
					this.maintenance.applyEncryptionSnapshot(
						snapshot,
						candidate,
					),
				resolveTargetPaths: (transition) =>
					this.maintenance.resolveTransitionTargetPaths(transition),
				assertSourceUnchanged: (transition) =>
					this.maintenance.assertTransitionSourceUnchanged(
						transition,
					),
				verifyTargetUpload: async (transition, logicalPath, sha256) => {
					const proof = await verifyTransitionTargetObject(
						{
							client: context.client,
							remotePath: context.getSettings().remotePath,
							persist: () => context.persist(),
						},
						transition,
						logicalPath,
						sha256,
						context.getService(),
						false,
					);
					if (!proof) {
						throw new Error(
							`Uploaded target is missing for ${logicalPath}`,
						);
					}
					return proof;
				},
				setPhase: (phase) =>
					this.maintenance.setEncryptionTransitionPhase(phase),
				stageMaintenance: (transition, phase, cleanup) =>
					this.maintenance.stageCanonicalMaintenance(
						transition,
						phase,
						cleanup,
					),
				commitMaintenance: (transition, phase, cleanup) =>
					this.maintenance.commitCanonicalMaintenance(
						transition,
						phase,
						cleanup,
					),
				publishStable: async (snapshot) => {
					const authority = context.index.getMaintenance();
					if (!authority) {
						throw new Error(
							"Transition publication has no canonical authority",
						);
					}
					await context.index.assertMaintenanceAuthority(
						context.index.getRemoteIndex().epoch,
						authority,
					);
					await this.maintenance.publishStableEncryptionSnapshot(
						snapshot,
					);
				},
				prepareCleanup: (paths, fingerprints) =>
					this.maintenance.prepareGuardedCleanup(paths, fingerprints),
				deletePaths: (paths, fingerprints) =>
					this.maintenance.deleteRemoteRawPaths(paths, fingerprints),
				deleteFolders: (paths) =>
					this.maintenance.deleteRemoteRawFolders(paths),
				finishMaintenance: (transition) =>
					this.maintenance.finishCanonicalMaintenanceIfCleanupComplete(
						transition,
					),
				clearLocalTransition: async () => {
					const transition = context.getTransition();
					const causal = context.index.captureLocalCausalState();
					if (transition?.replacement) {
						context.index.finishEncryptionReplacement();
					}
					context.setTransition(null);
					try {
						await context.persist();
					} catch (error) {
						context.index.restoreLocalCausalState(causal);
						context.setTransition(transition);
						throw error;
					}
				},
				recover: () => this.recovery.recoverEncryptionTransition(),
				clearBlock: () => context.ui.setBlock(null),
				createSyncFailure: (errorCount) =>
					new Error(
						t("notice.encryption_sync_failed", {
							errors: errorCount,
						}),
					),
			},
			{
				client: context.client,
				getRemotePath: () => context.getSettings().remotePath,
				getConcurrency: () => context.getSettings().maxConcurrency,
				completeAction: (path) =>
					this.maintenance.completeGuardedCleanup(path),
				persist: () => context.persist(),
			},
		);
		this.maintenance = new EncryptionMaintenance(context, this.controller);
		this.recovery = new EncryptionRecovery(
			context,
			this.maintenance,
			this.controller,
			(password, manifest) => this.connectForSync(password, manifest),
		);
		this.admission = new EncryptionAdmission(
			context,
			this,
			this.recovery,
			this.controller,
		);
	}

	/** Authenticate inside the existing maintenance queue, with fresh lifecycle admission. */
	async connectForSync(
		password: string,
		manifest?: RemoteEncryptionManifest,
		options: EncryptionConnectionOptions = {},
	): Promise<void> {
		options.assertCurrent?.();
		this.context.assertConnectionAllowed();
		await this.context.engine.runExclusiveMaintenance(async () => {
			options.assertCurrent?.();
			this.context.assertConnectionAllowed();
			await this.connectToRemoteEncryptionNow(
				password,
				manifest,
				options,
			);
		});
	}

	// ============================================================================
	// Encryption
	// ============================================================================

	/**
	 * Initialize encryption service from stored settings.
	 * Called during plugin load; silently returns if encryption is disabled or
	 * if password/salt is missing.
	 */
	async initEncryption(): Promise<void> {
		const settings = this.context.getSettings();
		if (
			!settings.enableEncryption ||
			!settings.encryptionSalt ||
			!settings.encryptionPassword
		) {
			this.context.client.setEncryptionService(null);
			return;
		}

		const assertLifetime = this.context.engine.createReadLifetimeGuard();
		const reads = this.context.index.createStartupReadSession(() => {
			assertLifetime();
			this.context.assertConnectionAllowed();
		});
		try {
			const service = await this.context.manager.createCodec(
				this.requireEncryptionProfileId(),
				settings.encryptionSalt,
				settings.encryptionPassword,
			);
			reads.assertCurrent();
			this.context.setService(service);
			this.context.client.setEncryptionService(service);
			logger.info("Encryption initialized successfully");
		} catch (e) {
			if (this.context.isCancelled()) {
				return;
			}
			try {
				reads.assertCurrent();
			} catch {
				return;
			}
			logger.warn("Failed to initialize encryption:", { error: e });
			this.context.setService(null);
			this.context.client.setEncryptionService(null);
			this.context.ui.setBlock(t("notice.encryption_wrong_password"));
		} finally {
			reads.close();
		}
	}

	async enableEncryptionNow(
		password: string,
		choice?: OperationBackupChoice,
	): Promise<void> {
		const remoteManifest =
			await this.context.index.downloadEncryptionManifest();
		if (remoteManifest) {
			await this.connectToRemoteEncryptionNow(password, remoteManifest);
			return;
		}

		await this.runEncryptionPreflight();
		const backupProof = await this.createSelectedEncryptionBackup(
			choice,
			password,
		);
		const sourceFiles =
			await this.context.index.getRemoteRawFileSnapshots();
		const oldRawPaths = sourceFiles.map((file) => file.path);
		const source = this.maintenance.captureEncryptionSnapshot();
		const saltBytes = EncryptionService.generateSalt();
		const saltBase64 = EncryptionService.bytesToBase64(saltBytes);
		const revision = 1;
		const service = await this.prepareTransitionCodec(saltBase64, password);
		const target: LocalEncryptionSnapshot = {
			enabled: true,
			salt: saltBase64,
			password,
			revision,
			profileId: "hardened",
		};
		const transition = await this.maintenance.beginEncryptionTransition(
			"enable",
			source,
			target,
			oldRawPaths,
			Object.fromEntries(
				sourceFiles.map((file) => [file.path, file.fingerprint]),
			),
			backupProof,
		);
		const publishEnablingManifest =
			this.maintenance.createEncryptionManifestPublisher(
				service,
				saltBase64,
				"enabling",
				revision,
				transition,
			);

		logger.info("Re-uploading all files with encryption...");
		await this.controller.execute({
			transition,
			sourceService: null,
			targetService: service,
			beforeApplyTarget: publishEnablingManifest,
			publishFilesCopied: publishEnablingManifest,
			publishIndexCommitted: publishEnablingManifest,
		});
		logger.info("Encryption enabled");
	}

	async disableEncryptionNow(
		options?: {
			reuploadPlaintext?: boolean;
		},
		choice?: OperationBackupChoice,
	): Promise<{ hadErrors: boolean }> {
		let partialErrors = false;

		if (options?.reuploadPlaintext) {
			if (this.context.getSettings().encryptionProfileId !== "hardened") {
				throw new UnsupportedHistoricalDataError(
					"Only hardened encryption can be disabled",
				);
			}
			await this.runEncryptionPreflight();
			const backupPassword =
				this.context.getSettings().encryptionPassword;
			if (!backupPassword) {
				throw new Error(t("notice.encryption_password_required"));
			}
			const backupProof = await this.createSelectedEncryptionBackup(
				choice,
				backupPassword,
			);
			const source = this.maintenance.captureEncryptionSnapshot();
			const sourceService = this.context.getService();
			// Capture encrypted paths while service is still active
			const sourceFiles =
				await this.context.index.getRemoteRawFileSnapshots();
			const oldRawPaths = sourceFiles.map((file) => file.path);
			const target: LocalEncryptionSnapshot = {
				enabled: false,
				salt: null,
				password: null,
				revision: null,
				profileId: null,
			};
			const transition = await this.maintenance.beginEncryptionTransition(
				"disable",
				source,
				target,
				oldRawPaths,
				Object.fromEntries(
					sourceFiles.map((file) => [file.path, file.fingerprint]),
				),
				backupProof,
			);

			try {
				const publishDisablingManifest =
					sourceService && source.salt
						? this.maintenance.createEncryptionManifestPublisher(
								sourceService,
								source.salt,
								"disabling",
								source.revision ?? 1,
								transition,
							)
						: async () => undefined;
				logger.info("Re-uploading all files as plaintext...");
				await this.controller.execute({
					transition,
					sourceService,
					beforeApplyTarget: publishDisablingManifest,
					publishFilesCopied: publishDisablingManifest,
					publishIndexCommitted: publishDisablingManifest,
				});
			} catch (error) {
				logger.warn("Encryption disable did not complete:", {
					error,
				});
				partialErrors = true;
			}
		} else {
			this.context.setService(null);
			this.context.client.setEncryptionService(null);
		}

		if (partialErrors) {
			return { hadErrors: true };
		}

		// Always clear local encryption state regardless of remote errors
		this.context.getSettings().enableEncryption = false;
		this.context.getSettings().encryptionSalt = null;
		this.context.getSettings().encryptionPassword = null;
		this.context.getSettings().encryptionRevision = null;
		this.context.getSettings().encryptionProfileId = null;
		await this.context.persist();

		try {
			await this.context.index.deleteEncryptionManifest();
		} catch (e) {
			logger.warn("Failed to delete encryption manifest from remote:", {
				error: e,
			});
			partialErrors = true;
		}

		this.context.ui.setBlock(null);
		logger.info("Encryption disabled");

		return { hadErrors: partialErrors };
	}

	/**
	 * Clear local encryption settings and service without touching remote state.
	 * Used when remote state already reflects the disabled encryption (e.g. another
	 * device disabled it) so there is nothing to clean up on the server side.
	 */
	async clearLocalEncryptionState(): Promise<void> {
		this.context.setService(null);
		this.context.client.setEncryptionService(null);
		this.context.getSettings().enableEncryption = false;
		this.context.getSettings().encryptionSalt = null;
		this.context.getSettings().encryptionPassword = null;
		this.context.getSettings().encryptionRevision = null;
		this.context.getSettings().encryptionProfileId = null;
		await this.context.persist();
		this.context.ui.setBlock(null);
	}

	async rotateEncryptionPasswordNow(
		newPassword: string,
		choice?: OperationBackupChoice,
	): Promise<void> {
		const currentManifest =
			await this.context.index.downloadEncryptionManifest();
		if (currentManifest && currentManifest.state !== "enabled") {
			throw new Error(t("notice.encryption_remote_busy"));
		}
		if (this.context.getSettings().encryptionProfileId !== "hardened") {
			throw new UnsupportedHistoricalDataError(
				"Only hardened encryption can be rotated",
			);
		}
		if (
			!this.context.getSettings().enableEncryption ||
			!this.context.getSettings().encryptionSalt
		) {
			throw new Error(t("notice.encryption_password_required"));
		}

		await this.runEncryptionPreflight();
		const backupProof = await this.createSelectedEncryptionBackup(
			choice,
			newPassword,
		);
		const source = this.maintenance.captureEncryptionSnapshot();
		const sourceService = this.context.getService();
		const sourceFiles =
			await this.context.index.getRemoteRawFileSnapshots();
		const oldRawPaths = sourceFiles.map((file) => file.path);
		const saltBytes = EncryptionService.generateSalt();
		const saltBase64 = EncryptionService.bytesToBase64(saltBytes);
		const revision =
			Math.max(
				currentManifest?.revision ?? 1,
				this.context.getSettings().encryptionRevision ?? 1,
			) + 1;
		const service = await this.prepareTransitionCodec(
			saltBase64,
			newPassword,
		);
		const target: LocalEncryptionSnapshot = {
			enabled: true,
			salt: saltBase64,
			password: newPassword,
			revision,
			profileId: "hardened",
		};
		const transition = await this.maintenance.beginEncryptionTransition(
			"rotate",
			source,
			target,
			oldRawPaths,
			Object.fromEntries(
				sourceFiles.map((file) => [file.path, file.fingerprint]),
			),
			backupProof,
		);
		const publishRotatingManifest =
			this.maintenance.createEncryptionManifestPublisher(
				service,
				saltBase64,
				"rotating",
				revision,
				transition,
			);
		logger.info(
			"Re-uploading all files after encryption password rotation...",
		);
		await this.controller.execute({
			transition,
			sourceService,
			targetService: service,
			beforeApplyTarget: publishRotatingManifest,
			publishFilesCopied: publishRotatingManifest,
			publishIndexCommitted: publishRotatingManifest,
		});
		logger.info("Encryption password rotated");
	}

	async connectToRemoteEncryptionNow(
		password: string,
		manifest?: RemoteEncryptionManifest,
		options: EncryptionConnectionOptions = {},
	): Promise<void> {
		const assertLifetime = this.context.engine.createReadLifetimeGuard();
		const reads = this.context.index.createStartupReadSession(() => {
			options.assertCurrent?.();
			assertLifetime();
			this.context.assertConnectionAllowed();
		}, options.allowRecovery === false);
		try {
			await this.connectToRemoteEncryptionWithReads(
				password,
				manifest,
				reads,
				options,
			);
		} finally {
			reads.close();
		}
	}

	/** Authenticate and validate the exact remote target before installing its prepared codec. */
	private async connectToRemoteEncryptionWithReads(
		password: string,
		expected: RemoteEncryptionManifest | undefined,
		reads: StartupReadSession,
		options: EncryptionConnectionOptions,
	): Promise<void> {
		const remoteManifest = (await reads.manifest()).manifest;
		if (
			expected &&
			JSON.stringify(expected) !== JSON.stringify(remoteManifest)
		) {
			throw new Error(t("notice.encryption_state_changed"));
		}
		if (!remoteManifest) {
			throw new Error(t("notice.encryption_remote_missing"));
		}
		if (
			options.allowRecovery === false &&
			remoteManifest.state !== "enabled"
		) {
			throw new Error(t("notice.encryption_remote_busy"));
		}
		const profileId =
			this.context.manager.getManifestProfileId(remoteManifest);
		const activeCodecMatchesCandidate = Boolean(
			this.context.getService() &&
			this.context.getSettings().enableEncryption &&
			this.context.getSettings().encryptionSalt === remoteManifest.salt &&
			this.context.getSettings().encryptionPassword === password &&
			this.context.getSettings().encryptionProfileId === profileId,
		);
		const candidate = activeCodecMatchesCandidate
			? this.context.getService()!
			: await this.context.manager.createCodec(
					profileId,
					remoteManifest.salt,
					password,
				);
		await this.verifyRemoteEncryptionPassword(candidate, remoteManifest);
		reads.assertCurrent();
		const recoveryKind =
			this.controller.getRemoteTargetRecoveryKind(remoteManifest);
		if (recoveryKind === "disable") {
			reads.close();
			await this.recovery.recoverRemotePlaintextTargetTransition(
				remoteManifest,
				candidate,
			);
		} else if (recoveryKind === "enable" || recoveryKind === "rotate") {
			reads.close();
			await this.recovery.recoverRemoteEncryptedTargetTransition(
				remoteManifest,
				candidate,
				password,
			);
		} else {
			const canonical = await this.context.manager.acceptCandidate({
				service: candidate,
				verifier: remoteManifest.verifier,
				validateAuthority: async () => {
					const current =
						await reads.readWithCodecIfPresent(candidate);
					if (!current) {
						throw new Error(t("notice.encryption_remote_busy"));
					}
					if (
						options.allowRecovery === false &&
						current.maintenance
					) {
						throw new Error(t("notice.encryption_remote_busy"));
					}
					await this.controller.assertStableManifestTarget(
						remoteManifest,
						current.maintenance,
						candidate,
					);
					const latest = (await reads.manifest()).manifest;
					if (
						JSON.stringify(latest) !==
						JSON.stringify(remoteManifest)
					) {
						throw new Error(t("notice.encryption_state_changed"));
					}
					reads.assertCurrent();
					return current;
				},
				persist: async () => {
					reads.assertCurrent();
					await this.maintenance.applyEncryptionSnapshot(
						{
							enabled: true,
							salt: remoteManifest.salt,
							password,
							revision: remoteManifest.revision,
							profileId,
						},
						candidate,
					);
				},
			});
			if (!canonical) {
				throw new Error(t("notice.encryption_wrong_password"));
			}
			if (canonical.maintenance) {
				await this.context.index.runTargetMaintenanceRecovery(
					canonical.maintenance.id,
					async () => {
						await this.context.index.loadRemoteIndexWithTargetCodec(
							candidate,
						);
						await this.controller.assertStableManifestTarget(
							remoteManifest,
							this.context.index.getMaintenance(),
							candidate,
						);
						const maintenance = this.context.index.getMaintenance();
						if (maintenance?.phase === "index-committed") {
							this.context.index.setMaintenance({
								...maintenance,
								phase: "cleanup",
							});
							await this.context.index.saveRemoteIndex();
						}
						await this.maintenance.requireCanonicalMaintenanceCleanupComplete();
					},
				);
			}
		}
		this.context.assertConnectionAllowed();
		this.context.ui.setBlock(null);
		logger.info("Encryption configured from remote manifest");
	}

	private async verifyRemoteEncryptionPassword(
		service: EncryptionCodec,
		manifest: RemoteEncryptionManifest,
	): Promise<void> {
		try {
			if (await service.verifyVerifier(manifest.verifier)) {
				return;
			}
		} catch {
			throw new Error(t("notice.encryption_wrong_password"));
		}
		throw new Error(t("notice.encryption_wrong_password"));
	}

	/**
	 * Verify a candidate encryption password against the currently initialized
	 * encryption service. Returns false if encryption is not active or the
	 * password does not derive the same key.
	 */
	async verifyEncryptionPassword(password: string): Promise<boolean> {
		const settings = this.context.getSettings();
		const service = this.context.getService();
		if (!service || !settings.encryptionSalt) {
			return false;
		}

		try {
			const salt = EncryptionService.base64ToBytes(
				settings.encryptionSalt,
			);
			const candidate = createEncryptionCodec(
				this.requireEncryptionProfileId(),
				salt,
			);
			await candidate.initializeKey(password);
			const verifier = await service.createVerifier();
			return await candidate.verifyVerifier(verifier);
		} catch {
			return false;
		}
	}

	private requireEncryptionProfileId(): EncryptionProfileId {
		const profileId = this.context.getSettings().encryptionProfileId;
		if (!profileId) {
			throw new UnsupportedHistoricalDataError(
				"Encrypted settings have no current profile ID",
			);
		}
		return profileId;
	}

	/** Prepare a transition key without accepting a late configuration or host change. */
	private async prepareTransitionCodec(
		salt: string,
		password: string,
	): Promise<EncryptionCodec> {
		const lifetime = this.context.engine.createReadLifetimeGuard();
		const reads = this.context.index.createStartupReadSession(() => {
			lifetime();
			this.context.assertConnectionAllowed();
		});
		try {
			const service = await this.context.manager.createCodec(
				"hardened",
				salt,
				password,
			);
			reads.assertCurrent();
			return service;
		} finally {
			reads.close();
		}
	}

	/** Bind the archive choice to the current canonical source. */
	private async createSelectedEncryptionBackup(
		choice: OperationBackupChoice | undefined,
		password: string,
	): Promise<EncryptionBackupProof | null> {
		return await this.context.backup.createTransitionBackup(
			choice,
			password,
			this.context.index.getRemoteIndex(),
		);
	}

	private async runEncryptionPreflight(): Promise<void> {
		// Parse the manifest immediately before the source sync. Only coordinator
		// nesting is bypassed; encryption and canonical-maintenance guards remain
		// authoritative until this orchestrator acquires its own claim.
		await this.context.index.downloadEncryptionManifest();
		const canonical = await this.context.index.loadRemoteIndex(
			false,
			false,
			true,
		);
		if (canonical.maintenance) {
			throw new Error(
				"Encryption preflight requires a stable canonical index",
			);
		}
		await this.context.index.buildLocalIndex();
	}
}
