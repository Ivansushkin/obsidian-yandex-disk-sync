import {
	confirmForceReplacementPlan,
	type PreparedForceReplacement,
} from "./force-replacement";
import type { ForceDirection } from "./force-state";
import type { OperationBackupChoice } from "../../backup/operation-backup-choice";
import type { BackupProgress, BackupResult } from "../../backup/backup-manager";
import type { SyncResult, SyncState } from "../../types";
import type { ForceRunOptions } from "../contracts";
import { createSyncFailure } from "../errors";
import type { FailureSummary } from "../../errors";
import { logger } from "../../utils/logger";

export type { ForceDirection } from "./force-state";
export type ForcePhase =
	| "preflight"
	| "confirming"
	| "protected-snapshot"
	| BackupProgress
	| "syncing"
	| "persisting";
export type ForceOutcome =
	| "success"
	| "cancelled"
	| "blocked"
	| "failed"
	| "recovery-pending"
	| "cleanup-pending";

export interface ForceFlowState {
	id: number;
	direction: ForceDirection;
	active: boolean;
	phase: ForcePhase;
	activity?: SyncState;
	sourceProgress?: { completed: number; total: number };
	outcome?: ForceOutcome;
	errorCode?: string;
	failure?: FailureSummary;
	successful?: number;
	failed?: number;
}

/** Read-only preparation capabilities scoped to one reserved Force invocation. */
export interface ForcePreparationContext {
	isCancelled(): boolean;
	password(create: boolean, invalid?: boolean): Promise<string | null>;
	progress(completed: number, total: number): void;
}

export interface ForceSyncDependencies {
	open?(direction: ForceDirection): void;
	close?(): void;
	password?(create: boolean, invalid?: boolean): Promise<string | null>;
	retryPreparation?(failure: FailureSummary): Promise<boolean>;
	isSyncBusy(): boolean;
	preflight(
		direction: ForceDirection,
		preparation: ForcePreparationContext,
	): Promise<PreparedForceReplacement | null>;
	confirm(
		plan: PreparedForceReplacement,
		prepareArchive: () => Promise<void>,
	): Promise<OperationBackupChoice>;
	captureProtectedSnapshot(direction: ForceDirection): Promise<string>;
	readyForBackup(plan: PreparedForceReplacement): Promise<boolean>;
	backup(
		direction: ForceDirection,
		progress: (phase: BackupProgress) => void,
		plan: PreparedForceReplacement,
	): Promise<BackupResult>;
	run(
		direction: ForceDirection,
		options: ForceRunOptions,
	): Promise<SyncResult>;
	persist(result: SyncResult): Promise<void>;
	replacementCommitted(): void;
	hasPendingRecovery(): boolean;
	reportError(error: unknown): void;
}

/** Owns one complete user-requested Force flow without adding a sync queue. */
export class ForceSyncController {
	private state: ForceFlowState | null = null;
	private sequence = 0;
	private cancelRequested = false;
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

	/** Cancellation joins admitted reads/archive work; a confirmed replacement can only be hidden. */
	cancel(): boolean {
		if (
			!this.isBusy() ||
			["syncing", "persisting"].includes(this.state!.phase)
		) {
			return false;
		}
		this.cancelRequested = true;
		return true;
	}

	dispose(): void {
		this.cancel();
		this.deps.close?.();
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
		this.cancelRequested = false;
		const isCancelled = () => this.cancelRequested || this.state?.id !== id;
		this.state = {
			id,
			direction,
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
			update({
				phase: value,
				activity: undefined,
				sourceProgress: undefined,
			});
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
				outcome: this.deps.hasPendingRecovery()
					? "recovery-pending"
					: outcome,
				failure: failure.summary,
				errorCode: failure.summary.code,
			});
		};
		try {
			this.deps.open?.(direction);
			update({});
			let prepared: PreparedForceReplacement | null = null;
			while (!isCancelled()) {
				try {
					prepared = await this.deps.preflight(direction, {
						isCancelled,
						password: (create, invalid) =>
							this.deps.password?.(create, invalid) ??
							Promise.resolve(null),
						progress: (completed, total) =>
							update({ sourceProgress: { completed, total } }),
					});
					break;
				} catch (error) {
					if (isCancelled()) {
						break;
					}
					const failure = createSyncFailure(error, {
						stage: "preflight",
						action: "read",
						outcome: "stopped-before-write",
					}).summary;
					update({
						failure,
						errorCode: failure.code,
						sourceProgress: undefined,
					});
					if (
						!this.deps.retryPreparation ||
						!(await this.deps.retryPreparation(failure))
					) {
						if (!isCancelled()) {
							throw error;
						}
						break;
					}
					update({
						sourceProgress: undefined,
						failure: undefined,
						errorCode: undefined,
					});
				}
			}
			if (isCancelled()) {
				update({ outcome: "cancelled" });
				return;
			}
			if (!prepared) {
				update({ outcome: "blocked" });
				return;
			}
			const plan = prepared;
			phase("confirming");
			const archiveWork: { pending: Promise<void> | null } = {
				pending: null,
			};
			const assertArchiveActive = () => {
				if (isCancelled()) {
					throw new Error(
						"Force archive was cancelled before replacement",
					);
				}
			};
			const createArchive = async () => {
				try {
					assertArchiveActive();
					if (!(await this.deps.readyForBackup(plan))) {
						throw new Error(
							"Force archive destination is unavailable",
						);
					}
					assertArchiveActive();
					phase("protected-snapshot");
					const snapshotDigest =
						await this.deps.captureProtectedSnapshot(direction);
					assertArchiveActive();
					phase("creating-backup");
					const backup = await this.deps.backup(
						direction,
						phase,
						plan,
					);
					if (
						!backup.success ||
						!backup.backupName ||
						!backup.sha256 ||
						backup.snapshotDigest !== snapshotDigest
					) {
						throw (
							backup.failureCause ??
							new Error(
								backup.error ??
									"The selected archive was not verified",
							)
						);
					}
					assertArchiveActive();
					plan.recovery.backupProof = {
						name: backup.backupName,
						sha256: backup.sha256,
						snapshotDigest,
					};
				} finally {
					phase("confirming");
				}
			};
			const prepareArchive = () => {
				if (!archiveWork.pending) {
					archiveWork.pending = createArchive();
					void archiveWork.pending.then(
						() => {
							archiveWork.pending = null;
						},
						() => {
							archiveWork.pending = null;
						},
					);
				}
				return archiveWork.pending;
			};
			let choice: OperationBackupChoice;
			try {
				choice = await this.deps.confirm(plan, prepareArchive);
			} finally {
				// Closing confirmation cancels replacement, but cannot release an active archive scope.
				await archiveWork.pending?.catch(() => {});
			}
			if (choice === "cancel" || isCancelled()) {
				update({ outcome: "cancelled" });
				return;
			}
			if (choice === "with-backup" && !plan.recovery.backupProof) {
				await prepareArchive();
			}
			if (isCancelled()) {
				update({ outcome: "cancelled" });
				return;
			}
			confirmForceReplacementPlan(plan);
			phase("syncing");
			const result = await this.deps.run(direction, {
				forceReplacement: { plan, backupMode: choice },
				onActivity: (activity) => update({ activity }),
			});
			committed = result.replacementCommitted === true;
			phase("persisting");
			await this.deps.persist(result);
			update({
				successful:
					result.uploaded + result.downloaded + result.deleted,
				failed: result.errors.length,
			});
			if (result.deferred) {
				update({ outcome: "recovery-pending" });
				return;
			}
			if (!result.success || !committed) {
				fail(
					result.errors[0]?.failureCause ??
						new Error(
							result.errors[0]?.message ??
								"Force replacement remains incomplete",
						),
					"failed",
				);
				return;
			}
			this.deps.replacementCommitted();
			update({ outcome: "success" });
		} catch (error) {
			if (isCancelled()) {
				update({ outcome: "cancelled" });
			} else {
				fail(error, committed ? "cleanup-pending" : "failed");
			}
		} finally {
			update({ active: false });
		}
	}
}
