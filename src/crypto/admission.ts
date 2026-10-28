import { ForceRecoveryPendingError } from "../sync/workflows/force-state";
import { UnsupportedHistoricalDataError } from "../compatibility-errors";
import { t } from "../i18n/index";
import { createSyncFailure, formatOperationFailure } from "../sync/errors";
import type { RemoteEncryptionManifest } from "../types";
import { logger } from "../utils/logger";
import type { EncryptionContext, EncryptionPromptMode } from "./context";
import type { EncryptionTransitionController } from "./encryption-transition";
import type { EncryptionRecovery } from "./recovery";
import type {
	EncryptionConnectionOptions,
	EncryptionWorkflow,
} from "./workflow";

export interface EncryptionReadyOptions {
	/** Whether the user can be prompted for a missing or rotated password. */
	prompt: boolean;
	/** Whether admission may recover transitions or change the remote encryption mode. */
	allowRecovery?: boolean;
	/** Drop invocation observations before changing codec or entering recovery. */
	invalidateReads?(): void;
	/** Reject a revoked deferred request before accepting credentials. */
	assertCurrent?(): void;
}

interface AutomaticPasswordRequest {
	kind: "rotated";
	target: string;
	configuration: number;
	assertLifetime(): void;
}

/** Host lifecycle capabilities; credential decisions remain in admission. */
export interface AutomaticPasswordPorts {
	isAllowed(): boolean;
	isBusy(): boolean;
	runExclusive(action: () => Promise<boolean>): Promise<boolean>;
	resume(): Promise<void>;
}

/** Validates current remote encryption and serializes explicit password prompts. */
export class EncryptionAdmission {
	private encryptionPromptPromise: Promise<boolean> | null = null;
	private automaticPorts?: AutomaticPasswordPorts;
	private automaticRequest: AutomaticPasswordRequest | null = null;
	private automaticRequestPromise: Promise<void> | null = null;
	private readonly attemptedAutomaticTargets = new Set<string>();
	private automaticGeneration = 0;
	constructor(
		private readonly context: EncryptionContext,
		private readonly workflow: Pick<
			EncryptionWorkflow,
			"clearLocalEncryptionState" | "connectForSync"
		>,
		private readonly recovery: Pick<
			EncryptionRecovery,
			"recoverRemotePlaintextTargetTransition"
		>,
		private readonly controller: EncryptionTransitionController,
	) {}

	configureAutomaticPasswordRequests(ports: AutomaticPasswordPorts): void {
		this.automaticPorts = ports;
	}

	/** Retire all deferred work when the connection changes or the host unloads. */
	resetAutomaticPasswordRequests(): void {
		this.automaticGeneration++;
		this.automaticRequest = null;
		this.attemptedAutomaticTargets.clear();
	}

	/** Drain after both coordinator settlement and the outer host operation finish. */
	flushAutomaticPasswordRequest(): Promise<void> {
		if (this.automaticRequestPromise) {
			return this.automaticRequestPromise;
		}
		const ports = this.automaticPorts;
		if (!ports || !this.automaticRequest) {
			return Promise.resolve();
		}
		if (!ports.isAllowed()) {
			this.automaticRequest = null;
			return Promise.resolve();
		}
		if (ports.isBusy()) {
			return Promise.resolve();
		}
		const task = Promise.resolve()
			.then(() => this.runAutomaticPasswordRequest(ports))
			.catch((error: unknown) => {
				logger.warn("Deferred encryption password request stopped", {
					error,
				});
			})
			.finally(() => {
				this.automaticRequestPromise = null;
				if (this.automaticRequest) {
					void this.flushAutomaticPasswordRequest();
				}
			});
		this.automaticRequestPromise = task;
		return task;
	}

	private async runAutomaticPasswordRequest(
		ports: AutomaticPasswordPorts,
	): Promise<void> {
		if (!ports.isAllowed() || ports.isBusy()) {
			return;
		}
		const request = this.automaticRequest;
		this.automaticRequest = null;
		if (!request || this.attemptedAutomaticTargets.has(request.target)) {
			return;
		}
		const generation = this.automaticGeneration;
		const assertCurrent = () => {
			request.assertLifetime();
			this.context.assertConnectionAllowed();
			if (
				this.context.isCancelled() ||
				!ports.isAllowed() ||
				generation !== this.automaticGeneration ||
				request.configuration !==
					this.context.client.getReadConfigurationVersion()
			) {
				throw new Error(
					"Deferred encryption password request was revoked",
				);
			}
		};
		assertCurrent();
		const connected = await ports.runExclusive(async () => {
			assertCurrent();
			const manifest =
				await this.context.index.downloadEncryptionManifest();
			assertCurrent();
			if (
				!manifest ||
				manifest.state !== "enabled" ||
				this.attemptedAutomaticTargets.has(
					this.passwordTarget(manifest),
				)
			) {
				return false;
			}
			return await this.ensureEncryptionReady(
				{ prompt: true, allowRecovery: false, assertCurrent },
				{ manifest },
			);
		});
		request.assertLifetime();
		if (
			connected &&
			generation === this.automaticGeneration &&
			ports.isAllowed() &&
			!this.context.isCancelled()
		) {
			await ports.resume();
		}
	}

	private passwordTarget(manifest: RemoteEncryptionManifest): string {
		return JSON.stringify([
			manifest.profileId,
			manifest.salt,
			manifest.revision,
		]);
	}

	/** Keep only an advisory target; processing always reads the current manifest again. */
	private deferRotatedPassword(
		manifest: RemoteEncryptionManifest,
		origin: Omit<AutomaticPasswordRequest, "kind" | "target"> & {
			generation: number;
		},
	): void {
		try {
			origin.assertLifetime();
		} catch {
			return;
		}
		if (
			this.context.isCancelled() ||
			origin.generation !== this.automaticGeneration ||
			origin.configuration !==
				this.context.client.getReadConfigurationVersion()
		) {
			return;
		}
		const target = this.passwordTarget(manifest);
		if (this.attemptedAutomaticTargets.has(target)) {
			return;
		}
		this.automaticRequest = {
			kind: "rotated",
			target,
			configuration: origin.configuration,
			assertLifetime: origin.assertLifetime,
		};
	}

	/**
	 * Ensure local encryption settings match the remote manifest before sync.
	 */
	async ensureEncryptionReady(
		options: EncryptionReadyOptions,
		knownManifest?: { manifest: RemoteEncryptionManifest | null },
	): Promise<boolean> {
		const origin = {
			generation: this.automaticGeneration,
			configuration: this.context.client.getReadConfigurationVersion(),
			assertLifetime: this.context.engine.createReadLifetimeGuard(),
		};
		try {
			options.assertCurrent?.();
			const manifest =
				knownManifest !== undefined
					? knownManifest.manifest
					: await this.context.index.downloadEncryptionManifest();
			if (!manifest) {
				this.automaticRequest = null;
				if (this.context.getSettings().enableEncryption) {
					if (options.allowRecovery === false) {
						this.context.ui.setBlock(
							t("notice.encryption_remote_busy"),
						);
						return false;
					}
					const plaintextCanonical =
						await this.context.index.readCanonicalIndexWithCodecIfPresent(
							null,
						);
					if (!plaintextCanonical) {
						this.context.ui.setBlock(
							t("notice.encryption_remote_busy"),
						);
						return false;
					}
					if (plaintextCanonical.maintenance) {
						if (plaintextCanonical.maintenance.kind === "force") {
							throw new ForceRecoveryPendingError();
						}
						this.controller.createRemoteTargetRecoveryPlan(
							null,
							plaintextCanonical.maintenance,
						);
						this.context.ui.setBlock(
							t("notice.encryption_remote_busy"),
						);
						if (!options.prompt) {
							return false;
						}
						options.invalidateReads?.();
						await this.context.engine.runExclusiveMaintenance(
							async () => {
								await this.recovery.recoverRemotePlaintextTargetTransition(
									null,
									null,
								);
							},
						);
						return true;
					}
					// A readable stable plaintext canonical proves remote disable.
					logger.info(
						"Remote encryption manifest gone; auto-disabling local encryption",
					);
					options.invalidateReads?.();
					await this.workflow.clearLocalEncryptionState();
					this.context.ui.disabledRemotely();
					this.context.ui.stateChanged();
				}
				return true;
			}

			if (manifest.state !== "enabled") {
				this.automaticRequest = null;
				this.context.ui.setBlock(t("notice.encryption_remote_busy"));
				if (!options.prompt || options.allowRecovery === false) {
					return false;
				}
				const recoveryKind =
					this.controller.getRemoteTargetRecoveryKind(manifest);
				options.invalidateReads?.();
				return await this.promptForRemoteEncryptionPassword(
					manifest,
					recoveryKind === "rotate" ? "rotated" : "recover",
					options,
				);
			}

			const hasLocalEncryption = Boolean(
				this.context.getSettings().enableEncryption &&
				this.context.getSettings().encryptionSalt &&
				this.context.getSettings().encryptionPassword &&
				this.context.getService(),
			);
			const localRevision =
				this.context.getSettings().encryptionRevision ?? 1;
			const matchesRemote =
				hasLocalEncryption &&
				this.context.getSettings().encryptionSalt === manifest.salt &&
				this.context.getSettings().encryptionProfileId ===
					this.context.manager.getManifestProfileId(manifest) &&
				localRevision === manifest.revision;

			if (!matchesRemote) {
				if (hasLocalEncryption && !options.prompt) {
					this.deferRotatedPassword(manifest, origin);
				}
				const reason = hasLocalEncryption
					? t("notice.encryption_password_changed_remote")
					: t("notice.encryption_password_required");
				this.context.ui.setBlock(reason);
				if (!options.prompt) {
					return false;
				}
				options.invalidateReads?.();
				return await this.promptForRemoteEncryptionPassword(
					manifest,
					hasLocalEncryption ? "rotated" : "connect",
					options,
				);
			}

			const service = this.context.getService();
			if (service) {
				try {
					if (!(await service.verifyVerifier(manifest.verifier))) {
						throw new Error(t("notice.encryption_wrong_password"));
					}
				} catch {
					if (!options.prompt) {
						this.deferRotatedPassword(manifest, origin);
					}
					this.context.ui.setBlock(
						t("notice.encryption_password_changed_remote"),
					);
					if (!options.prompt) {
						return false;
					}
					options.invalidateReads?.();
					return await this.promptForRemoteEncryptionPassword(
						manifest,
						"rotated",
						options,
					);
				}
			}

			this.automaticRequest = null;
			this.context.ui.setBlock(null);
			return true;
		} catch (e) {
			this.automaticRequest = null;
			if (e instanceof ForceRecoveryPendingError) {
				throw e;
			}
			if (e instanceof UnsupportedHistoricalDataError) {
				this.context.ui.setBlock(null, false);
				this.context.ui.setHistoricalBlock(
					t("notice.unsupported_historical_data"),
				);
				return false;
			}
			const message = formatOperationFailure(
				createSyncFailure(e, {
					stage: "encryption-validation",
					action: "read",
				}).summary,
			);
			logger.warn("Error checking remote encryption state:", {
				error: e,
			});
			this.context.ui.setBlock(
				t("notice.encryption_state_check_failed", { error: message }),
			);
			return false;
		}
	}

	private async promptForRemoteEncryptionPassword(
		manifest: RemoteEncryptionManifest,
		mode: EncryptionPromptMode,
		options: EncryptionConnectionOptions,
	): Promise<boolean> {
		if (this.encryptionPromptPromise) {
			return await this.encryptionPromptPromise;
		}

		this.automaticRequest = null;
		if (mode === "rotated") {
			this.attemptedAutomaticTargets.add(this.passwordTarget(manifest));
		}
		this.encryptionPromptPromise =
			this.promptForRemoteEncryptionPasswordOnce(
				manifest,
				mode,
				options,
			).finally(() => {
				this.encryptionPromptPromise = null;
			});

		return await this.encryptionPromptPromise;
	}
	private async promptForRemoteEncryptionPasswordOnce(
		manifest: RemoteEncryptionManifest,
		mode: EncryptionPromptMode,
		options: EncryptionConnectionOptions,
	): Promise<boolean> {
		const assertLifetime = this.context.engine.createReadLifetimeGuard();
		const reads = this.context.index.createStartupReadSession(() => {
			options.assertCurrent?.();
			assertLifetime();
			this.context.assertConnectionAllowed();
		}, true);
		try {
			reads.assertCurrent();
			const password = await this.context.ui.requestPassword(
				manifest,
				mode,
			);
			if (!password || this.context.isCancelled()) {
				return false;
			}
			reads.assertCurrent();
			await this.workflow.connectForSync(password, manifest, {
				allowRecovery: options.allowRecovery,
				assertCurrent: () => {
					options.assertCurrent?.();
					reads.assertCurrent();
				},
			});
			assertLifetime();
			if (this.context.isCancelled()) {
				return false;
			}
			this.context.ui.connected();
			this.context.ui.stateChanged();
			return true;
		} catch (error) {
			try {
				reads.assertCurrent();
			} catch {
				return false;
			}
			if (!this.context.isCancelled()) {
				this.context.ui.setBlock(
					error instanceof Error ? error.message : String(error),
				);
			}
			return false;
		} finally {
			reads.close();
		}
	}
}
