import { UnsupportedHistoricalDataError } from "../compatibility-errors";
import { t } from "../i18n/index";
import { createSyncFailure, formatOperationFailure } from "../sync/errors";
import type { RemoteEncryptionManifest } from "../types";
import { logger } from "../utils/logger";
import type { EncryptionContext, EncryptionPromptMode } from "./context";
import type { EncryptionTransitionController } from "./encryption-transition";
import type { EncryptionRecovery } from "./recovery";
import type { EncryptionWorkflow } from "./workflow";

export interface EncryptionReadyOptions {
	/** Whether the user can be prompted for a missing or rotated password. */
	prompt: boolean;
	/** Admission checks authority without starting recovery or reconnect. */
	allowRecovery?: boolean;
}

/** Validates current remote encryption and serializes explicit password prompts. */
export class EncryptionAdmission {
	private encryptionPromptPromise: Promise<boolean> | null = null;
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

	/**
	 * Ensure local encryption settings match the remote manifest before sync.
	 */
	async ensureEncryptionReady(
		options: EncryptionReadyOptions,
		knownManifest?: { manifest: RemoteEncryptionManifest | null },
	): Promise<boolean> {
		try {
			const manifest =
				knownManifest !== undefined
					? knownManifest.manifest
					: await this.context.index.downloadEncryptionManifest();
			if (!manifest) {
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
					await this.workflow.clearLocalEncryptionState();
					this.context.ui.disabledRemotely();
					this.context.ui.stateChanged();
				}
				return true;
			}

			if (manifest.state !== "enabled") {
				this.context.ui.setBlock(t("notice.encryption_remote_busy"));
				if (!options.prompt || options.allowRecovery === false) {
					return false;
				}
				const recoveryKind =
					this.controller.getRemoteTargetRecoveryKind(manifest);
				return await this.promptForRemoteEncryptionPassword(
					manifest,
					recoveryKind === "rotate" ? "rotated" : "recover",
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
				const reason = hasLocalEncryption
					? t("notice.encryption_password_changed_remote")
					: t("notice.encryption_password_required");
				this.context.ui.setBlock(reason);
				if (!options.prompt || options.allowRecovery === false) {
					return false;
				}
				return await this.promptForRemoteEncryptionPassword(
					manifest,
					hasLocalEncryption ? "rotated" : "connect",
				);
			}

			const service = this.context.getService();
			if (service) {
				try {
					if (!(await service.verifyVerifier(manifest.verifier))) {
						throw new Error(t("notice.encryption_wrong_password"));
					}
				} catch {
					this.context.ui.setBlock(
						t("notice.encryption_password_changed_remote"),
					);
					if (!options.prompt || options.allowRecovery === false) {
						return false;
					}
					return await this.promptForRemoteEncryptionPassword(
						manifest,
						"rotated",
					);
				}
			}

			this.context.ui.setBlock(null);
			return true;
		} catch (e) {
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
		mode: "connect" | "rotated" | "recover",
	): Promise<boolean> {
		if (this.encryptionPromptPromise) {
			return await this.encryptionPromptPromise;
		}

		this.encryptionPromptPromise =
			this.promptForRemoteEncryptionPasswordOnce(manifest, mode).finally(
				() => {
					this.encryptionPromptPromise = null;
				},
			);

		return await this.encryptionPromptPromise;
	}
	private async promptForRemoteEncryptionPasswordOnce(
		manifest: RemoteEncryptionManifest,
		mode: EncryptionPromptMode,
	): Promise<boolean> {
		const password = await this.context.ui.requestPassword(manifest, mode);
		if (!password || this.context.isCancelled()) {
			return false;
		}
		try {
			await this.workflow.connectForSync(password, manifest);
			if (this.context.isCancelled()) {
				return false;
			}
			this.context.ui.connected();
			this.context.ui.stateChanged();
			return true;
		} catch (error) {
			if (!this.context.isCancelled()) {
				this.context.ui.setBlock(
					error instanceof Error ? error.message : String(error),
				);
			}
			return false;
		}
	}
}
