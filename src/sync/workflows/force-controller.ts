import type { OperationBackupChoice } from "../../backup/operation-backup-choice";
import type { BackupProgress, BackupResult } from "../../backup/backup-manager";
import type { SyncResult, SyncState } from "../../types";
import type { ForcePreflightProof, SyncRunOptions } from "../contracts";
import { createSyncFailure } from "../errors";
import type { FailureSummary } from "../../errors";
import { logger } from "../../utils/logger";

export type ForceDirection = "from_local" | "from_remote";
export type ForcePhase =
	| "preflight"
	| "confirming"
	| "protected-snapshot"
	| BackupProgress
	| "syncing"
	| "persisting"
	| "reconciling";
export type ForceOutcome =
	| "success"
	| "cancelled"
	| "blocked"
	| "backup-failed"
	| "failed"
	| "cleanup-pending";

export interface ForceFlowState {
	id: number;
	direction: ForceDirection;
	migration: boolean;
	active: boolean;
	phase: ForcePhase;
	activity?: SyncState;
	outcome?: ForceOutcome;
	errorCode?: string;
	failure?: FailureSummary;
	successful?: number;
}

export interface ForceSyncDependencies {
	isSyncBusy(): boolean;
	preflight(direction: ForceDirection): Promise<{
		replacement?: NonNullable<SyncRunOptions["forceReplacement"]>;
		canonical: ForcePreflightProof["canonical"];
		migration: boolean;
	} | null>;
	confirm(
		direction: ForceDirection,
		migration: boolean,
		replacement?: SyncRunOptions["forceReplacement"],
	): Promise<OperationBackupChoice>;
	captureProtectedSnapshot(direction: ForceDirection): Promise<string>;
	readyForBackup(
		migration: boolean,
		replacement?: SyncRunOptions["forceReplacement"],
	): Promise<boolean>;
	backupFailure?(
		replacement?: SyncRunOptions["forceReplacement"],
	): Promise<"retry" | "without-backup" | "cancel">;
	backup(
		direction: ForceDirection,
		progress: (phase: BackupProgress) => void,
		replacement?: SyncRunOptions["forceReplacement"],
	): Promise<BackupResult>;
	beforeMutation(migration: boolean): Promise<void>;
	run(
		direction: ForceDirection,
		options: SyncRunOptions,
	): Promise<SyncResult>;
	persist(result: SyncResult): Promise<void>;
	replacementCommitted(): void;
	reconcile(
		onActivity: (state: SyncState) => void,
	): Promise<SyncResult | null>;
	hasPendingCleanup(): boolean;
	reportError(error: unknown): void;
}

/** Owns one complete user-requested Force flow without adding a sync queue. */
export class ForceSyncController {
	private state: ForceFlowState | null = null;
	private sequence = 0;
	private running: Promise<void> | null = null;
	private listeners = new Set<(state: ForceFlowState) => void>();

	constructor(private readonly deps: ForceSyncDependencies) {}

	getState(): ForceFlowState | null {
		return this.state ? { ...this.state } : null;
	}

	isBusy(): boolean {
		return this.state?.active === true;
	}

	subscribe(listener: (state: ForceFlowState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		this.listeners.clear();
	}

	/** Reserve synchronously so repeated calls cannot queue another destructive flow. */
	run(direction: ForceDirection): Promise<void> {
		if (this.running) {
			return this.running;
		}
		this.running = this.execute(direction).finally(() => {
			this.running = null;
		});
		return this.running;
	}

	private async execute(direction: ForceDirection): Promise<void> {
		if (this.isBusy() || this.deps.isSyncBusy()) {
			return;
		}
		const id = ++this.sequence;
		this.state = {
			id,
			direction,
			migration: false,
			active: true,
			phase: "preflight",
		};
		const update = (patch: Partial<ForceFlowState>) => {
			if (this.state?.id !== id || !this.state.active) {
				return;
			}
			this.state = { ...this.state, ...patch };
			for (const listener of this.listeners) {
				try {
					listener(this.getState()!);
				} catch (error) {
					logger.warn("Force presentation failed", { error });
				}
			}
		};
		const phase = (value: ForcePhase) =>
			update({ phase: value, activity: undefined });
		let committed = false;
		const startedAt = Date.now();
		const fail = (error: unknown, outcome: ForceOutcome) => {
			const stage = this.state?.phase ?? "preflight";
			const failure = createSyncFailure(error, {
				stage,
				action:
					stage === "preflight" || stage === "protected-snapshot"
						? "read"
						: "unknown",
				outcome: committed
					? "partial"
					: [
								"preflight",
								"confirming",
								"protected-snapshot",
								"creating-backup",
								"uploading-backup",
								"verifying-backup",
						  ].includes(stage)
						? "stopped-before-write"
						: "unknown",
				durationMs: Date.now() - startedAt,
			});
			this.deps.reportError(failure);
			update({
				outcome,
				failure: failure.summary,
				errorCode: failure.summary.code,
			});
		};
		try {
			update({});
			const prepared = await this.deps.preflight(direction);
			if (!prepared) {
				update({ outcome: "blocked" });
				return;
			}
			update({ migration: prepared.migration });
			phase("confirming");
			let choice = await this.deps.confirm(
				direction,
				prepared.migration,
				prepared.replacement,
			);
			if (choice === "cancel") {
				update({ outcome: "cancelled" });
				return;
			}
			if (
				!(await this.deps.readyForBackup(
					prepared.migration,
					prepared.replacement,
				))
			) {
				update({ outcome: "blocked" });
				return;
			}
			let snapshotDigest = "";
			if (!prepared.replacement) {
				phase("protected-snapshot");
				snapshotDigest =
					await this.deps.captureProtectedSnapshot(direction);
			}
			let backupProof: ForcePreflightProof["backup"] = null;
			while (choice === "with-backup") {
				let backup: BackupResult;
				try {
					if (prepared.replacement) {
						phase("protected-snapshot");
						snapshotDigest =
							await this.deps.captureProtectedSnapshot(direction);
					}
					phase("creating-backup");
					backup = await this.deps.backup(
						direction,
						phase,
						prepared.replacement,
					);
				} catch (error) {
					const decision = await this.deps.backupFailure?.(
						prepared.replacement,
					);
					if (decision === "retry") {
						continue;
					}
					if (decision === "without-backup") {
						choice = "without-backup";
						break;
					}
					fail(error, "backup-failed");
					return;
				}
				if (
					!backup.success ||
					!backup.backupName ||
					!backup.sha256 ||
					backup.snapshotDigest !== snapshotDigest
				) {
					const decision = await this.deps.backupFailure?.(
						prepared.replacement,
					);
					if (decision === "retry") {
						continue;
					}
					if (decision === "without-backup") {
						choice = "without-backup";
						break;
					}
					fail(
						backup.failureCause ??
							new Error(
								backup.error ??
									"Backup proof did not match the protected snapshot",
							),
						"backup-failed",
					);
					return;
				}
				backupProof = {
					backupName: backup.backupName,
					backupSha256: backup.sha256,
				};
				break;
			}
			if (prepared.replacement) {
				prepared.replacement.plan.recovery.backupProof = backupProof
					? {
							name: backupProof.backupName,
							sha256: backupProof.backupSha256,
							snapshotDigest,
						}
					: null;
			}
			phase("syncing");
			if (
				prepared.replacement &&
				choice === "with-backup" &&
				snapshotDigest !==
					(await this.deps.captureProtectedSnapshot(direction))
			) {
				throw new Error(
					"Force destination changed after archive verification",
				);
			}
			const result = await this.deps.run(direction, {
				forceReplacement: prepared.replacement
					? { ...prepared.replacement, backupMode: choice }
					: undefined,
				forcePreflightProof: {
					direction,
					canonical: prepared.canonical,
					snapshotDigest,
					backup: backupProof,
				},
				beforeForceMutation: () =>
					this.deps.beforeMutation(prepared.migration),
				onActivity: (activity) => update({ activity }),
			});
			committed = result.replacementCommitted === true;
			if (committed) {
				this.deps.replacementCommitted();
			}
			phase("persisting");
			await this.deps.persist(result);
			if (!committed) {
				const first = result.errors[0];
				fail(
					first?.failureCause ??
						new Error(
							first?.message ??
								"Force did not commit a replacement",
						),
					"failed",
				);
				if (first?.code) {
					update({ errorCode: first.code });
				}
				return;
			}
			if (prepared.replacement && !result.success) {
				fail(
					result.errors[0]?.failureCause ??
						new Error(
							result.errors[0]?.message ??
								"Force recovery is unfinished",
						),
					"cleanup-pending",
				);
				return;
			}
			phase("reconciling");
			const reconciled = await this.deps.reconcile((activity) =>
				update({ activity }),
			);
			if (!reconciled?.success || this.deps.hasPendingCleanup()) {
				fail(
					reconciled?.errors[0]?.failureCause ??
						new Error(
							reconciled?.errors[0]?.message ??
								"Committed replacement needs finalization",
						),
					"cleanup-pending",
				);
				return;
			}
			update({
				outcome: "success",
				successful:
					result.uploaded + result.downloaded + result.deleted,
			});
		} catch (error) {
			fail(error, committed ? "cleanup-pending" : "failed");
		} finally {
			update({ active: false });
		}
	}
}
