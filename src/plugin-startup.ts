import type { ExternalSyncBlockKind } from "./sync/contracts";
import { UnsupportedHistoricalDataError } from "./compatibility-errors";
import type { EncryptionReadyOptions } from "./crypto/admission";
import { t } from "./i18n/index";
import type { IndexManager } from "./sync/canonical/manager";
import { LegacyIndexFormatError } from "./sync/canonical/errors";
import type { SyncEngine } from "./sync/engine";
import { createSyncFailure, formatOperationFailure } from "./sync/errors";
import type { FailureSummary } from "./errors";
import type { RemoteEncryptionManifest, YandexDiskSyncSettings } from "./types";
import { logger } from "./utils/logger";

export type StartupState = "ready" | "migration" | "blocked";
export type StartupBlockKind = Exclude<ExternalSyncBlockKind, "local-state">;
export type StartupBlocks = Record<StartupBlockKind, string | null>;
interface StartupPorts {
	index: Pick<
		IndexManager,
		"downloadEncryptionManifest" | "inspectRemoteCanonicalFormat"
	>;
	engine: Pick<SyncEngine, "runExclusiveMaintenance">;
	getSettings(): Pick<
		YandexDiskSyncSettings,
		"yandexTokenSecret" | "enableEncryption"
	>;
	getBlocks(): StartupBlocks;
	hasTransition(): boolean;
	isStopped(): boolean;
	setBlock(
		kind: StartupBlockKind,
		reason: string | null,
		failure?: FailureSummary,
		showNotice?: boolean,
	): void;
	ensureStorageBinding(prompt: boolean): Promise<boolean>;
	recoverEncryptionTransition(): Promise<void>;
	tryRecoverRemoteTargetTransition(): Promise<boolean>;
	ensureEncryptionReady(
		options: EncryptionReadyOptions,
		read: { manifest: RemoteEncryptionManifest | null },
	): Promise<boolean>;
}

/** Classify storage, history and encryption before any normal synchronization. */
export class PluginStartup {
	validated = false;
	constructor(private readonly deps: StartupPorts) {}

	/** Recheck stale migration decisions and preserve distinct typed block outcomes. */
	async refresh(
		prompt: boolean,
		allowRecovery = true,
	): Promise<StartupState> {
		const { deps } = this;
		if (deps.isStopped()) {
			return "blocked";
		}
		if (!deps.getSettings().yandexTokenSecret) {
			deps.setBlock("authentication", t("notice.token_missing"));
			logger.info("Token not configured, waiting for settings");
			return "blocked";
		}
		try {
			if (
				!(await deps.ensureStorageBinding(prompt)) ||
				deps.isStopped()
			) {
				return "blocked";
			}
			if (this.validated) {
				if (deps.getBlocks().migration) {
					// A different updated device may already have committed replacement.
					this.validated = false;
				} else {
					if (
						deps.getBlocks().historical ||
						deps.getBlocks().authentication
					) {
						return "blocked";
					}
					if (!deps.getBlocks().encryption) {
						return "ready";
					}
					if (!prompt) {
						return "blocked";
					}
				}
			}
			const manifest = await deps.index.downloadEncryptionManifest();
			if (deps.isStopped()) {
				return "blocked";
			}
			if (!manifest) {
				const canonicalFormat =
					await deps.index.inspectRemoteCanonicalFormat();
				if (deps.isStopped()) {
					return "blocked";
				}
				if (
					canonicalFormat === "legacy" &&
					(deps.getSettings().enableEncryption ||
						deps.hasTransition())
				) {
					throw new UnsupportedHistoricalDataError(
						"Encrypted current local state cannot migrate a plaintext stable canonical",
					);
				}
				if (canonicalFormat === "legacy") {
					deps.setBlock("authentication", null);
					deps.setBlock("historical", null);
					deps.setBlock("encryption", null, undefined, false);
					deps.setBlock(
						"migration",
						t("notice.legacy_index_blocked"),
					);
					this.validated = true;
					return "migration";
				}
			}

			deps.setBlock("migration", null);
			deps.setBlock("historical", null);
			deps.setBlock("authentication", null);
			let recovered = false;
			if (deps.isStopped()) {
				return "blocked";
			}
			if (allowRecovery) {
				if (deps.hasTransition()) {
					await deps.engine.runExclusiveMaintenance(async () => {
						if (!deps.isStopped()) {
							await deps.recoverEncryptionTransition();
						}
					});
					recovered = true;
				} else {
					recovered = await deps.tryRecoverRemoteTargetTransition();
				}
			} else if (deps.hasTransition()) {
				deps.setBlock("encryption", t("notice.encryption_remote_busy"));
				return "blocked";
			}
			if (deps.isStopped()) {
				return "blocked";
			}
			const currentManifest = recovered
				? await deps.index.downloadEncryptionManifest()
				: manifest;
			if (deps.isStopped()) {
				return "blocked";
			}
			const ready = await deps.ensureEncryptionReady(
				{ prompt, allowRecovery },
				{ manifest: currentManifest },
			);
			if (deps.isStopped()) {
				return "blocked";
			}
			this.validated = ready || Boolean(deps.getBlocks().encryption);
			if (!ready) {
				return "blocked";
			}
			deps.setBlock("encryption", null, undefined, false);

			return "ready";
		} catch (error) {
			if (deps.isStopped()) {
				return "blocked";
			}
			this.validated = false;
			if (error instanceof LegacyIndexFormatError) {
				deps.setBlock("authentication", null);
				deps.setBlock("historical", null);
				deps.setBlock("encryption", null, undefined, false);
				deps.setBlock("migration", t("notice.legacy_index_blocked"));
				this.validated = true;
				return "migration";
			}
			if (error instanceof UnsupportedHistoricalDataError) {
				deps.setBlock("migration", null);
				deps.setBlock("encryption", null, undefined, false);
				deps.setBlock(
					"historical",
					t("notice.unsupported_historical_data"),
				);
				this.validated = true;
				return "blocked";
			}
			const failure = createSyncFailure(error, {
				stage: "startup",
				action: "read",
				outcome: "unknown",
			});
			logger.warn("Remote startup validation failed", { error: failure });
			deps.setBlock(
				"authentication",
				formatOperationFailure(failure.summary),
				failure.summary,
			);
			return "blocked";
		}
	}
}
