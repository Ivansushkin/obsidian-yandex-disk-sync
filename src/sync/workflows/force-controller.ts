import type { OperationBackupChoice } from "../../backup/operation-backup-choice";
import type { BackupProgress, BackupResult } from "../../backup/backup-manager";
import type { SyncResult, SyncState } from "../../types";
import type { ForcePreflightProof, SyncRunOptions } from "../contracts";
import { logger } from "../../utils/logger";

export type ForceDirection = "from_local" | "from_remote";
export type ForcePhase =
	| "preflight"
	| "confirming"
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
	successful?: number;
}

export interface ForceSyncDependencies {
	isSyncBusy(): boolean;
	preflight(): Promise<{
		canonical: ForcePreflightProof["canonical"];
		migration: boolean;
	} | null>;
	confirm(
		direction: ForceDirection,
		migration: boolean,
	): Promise<OperationBackupChoice>;
	captureProtectedSnapshot(direction: ForceDirection): Promise<string>;
	readyForBackup(migration: boolean): Promise<boolean>;
	backup(
		direction: ForceDirection,
		progress: (phase: BackupProgress) => void,
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
	async run(direction: ForceDirection): Promise<void> {
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
		try {
			update({});
			const prepared = await this.deps.preflight();
			if (!prepared) {
				update({ outcome: "blocked" });
				return;
			}
			update({ migration: prepared.migration });
			phase("confirming");
			const choice = await this.deps.confirm(
				direction,
				prepared.migration,
			);
			if (choice === "cancel") {
				update({ outcome: "cancelled" });
				return;
			}
			if (!(await this.deps.readyForBackup(prepared.migration))) {
				update({ outcome: "blocked" });
				return;
			}
			const snapshotDigest =
				await this.deps.captureProtectedSnapshot(direction);
			let backupProof: ForcePreflightProof["backup"] = null;
			if (choice === "with-backup") {
				phase("creating-backup");
				let backup: BackupResult;
				try {
					backup = await this.deps.backup(direction, phase);
				} catch (error) {
					this.deps.reportError(error);
					update({ outcome: "backup-failed" });
					return;
				}
				if (
					!backup.success ||
					!backup.backupName ||
					!backup.sha256 ||
					backup.snapshotDigest !== snapshotDigest
				) {
					update({ outcome: "backup-failed" });
					return;
				}
				backupProof = {
					backupName: backup.backupName,
					backupSha256: backup.sha256,
				};
			}
			phase("syncing");
			const result = await this.deps.run(direction, {
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
				update({
					outcome: "failed",
					errorCode: result.errors[0]?.code,
				});
				return;
			}
			phase("reconciling");
			const reconciled = await this.deps.reconcile((activity) =>
				update({ activity }),
			);
			if (!reconciled?.success || this.deps.hasPendingCleanup()) {
				update({ outcome: "cleanup-pending" });
				return;
			}
			update({
				outcome: "success",
				successful:
					result.uploaded + result.downloaded + result.deleted,
			});
		} catch (error) {
			this.deps.reportError(error);
			update({ outcome: committed ? "cleanup-pending" : "failed" });
		} finally {
			update({ active: false });
		}
	}
}
