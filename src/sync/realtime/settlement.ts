import type { SyncLifecycleContext } from "../contracts";
import { logger } from "../../utils/logger";
import type { DeferredWatcherEvent, WatcherQueueEvent } from "./queue-rules";
import type {
	DurableFileRenameEvent,
	FileRenameOutcome,
	FolderMutationOutcome,
	RealtimeBatchResult,
} from "./rules";

interface SettlementPorts {
	getEvents(): readonly WatcherQueueEvent[];
	applyBatchResult(result: RealtimeBatchResult): void;
	acknowledgeEvents(ids: string[]): void;
	waitForPersistence(): Promise<void>;
	observeEpochReplacement(): void;
	deferRenameToFull(eventId: string): boolean;
}

/** Settle single and batched replay outcomes against the watcher's live queue. */
export class WatcherSettlement {
	constructor(private readonly ports: SettlementPorts) {}

	/** Apply receipts and save acknowledgement before releasing the file batch session. */
	async settleFileBatch(
		result: RealtimeBatchResult,
		replayResult: RealtimeBatchResult,
		lifecycle?: SyncLifecycleContext,
	): Promise<void> {
		this.ports.applyBatchResult(result);
		replayResult.completed.push(...result.completed);
		replayResult.superseded.push(...result.superseded);
		replayResult.retry.push(...result.retry);
		await this.ports.waitForPersistence();
		logger.debug("Realtime file batch settled in coordinator", {
			sessionId: lifecycle?.sessionId ?? null,
			completed: result.completed.length,
			superseded: result.superseded.length,
			retry: result.retry.length,
			pendingWatcherEvents: this.ports.getEvents().length,
		});
	}

	/** Rebase a live successor or retain an unresolved rename for full reconciliation. */
	async settleRenameEvent(
		event: DurableFileRenameEvent,
		outcome: FileRenameOutcome,
		lifecycle?: SyncLifecycleContext,
		replayResult?: RealtimeBatchResult,
	): Promise<void> {
		if (outcome.requiresFullSync === "epoch-replaced") {
			this.ports.observeEpochReplacement();
		}
		const successor = this.ports
			.getEvents()
			.find(
				(candidate): candidate is DurableFileRenameEvent =>
					candidate.action === "rename" &&
					candidate.kind === "file" &&
					candidate.id !== event.id &&
					candidate.path === event.targetPath,
			);
		if (
			outcome.status === "retry" &&
			!outcome.remoteStarted &&
			outcome.reason === "target-missing-before-remote" &&
			successor
		) {
			successor.path = event.path;
			successor.epoch = event.epoch;
			successor.baseRevision = event.baseRevision;
			this.ports.acknowledgeEvents([event.id]);
			replayResult?.superseded.push(event.id);
			await this.ports.waitForPersistence();
			logger.info("Running watcher rename safely rebased", {
				sessionId: lifecycle?.sessionId ?? null,
				eventId: event.id,
				successorId: successor.id,
				oldPath: event.path,
				targetPath: successor.targetPath,
				state: "rebased",
			});
			return;
		}
		if (
			outcome.status === "retry" &&
			!outcome.remoteStarted &&
			outcome.reason === "target-missing-before-remote" &&
			this.ports.deferRenameToFull(event.id)
		) {
			logger.info("Watcher rename awaits post-full settlement", {
				sessionId: lifecycle?.sessionId ?? null,
				eventId: event.id,
				oldPath: event.path,
				targetPath: event.targetPath,
				reason: outcome.reason,
			});
			return;
		}

		if (outcome.status === "retry") {
			if (!replayResult?.retry.includes(event.id)) {
				replayResult?.retry.push(event.id);
			}
			logger.warn("Watcher rename remains durable for retry", {
				sessionId: lifecycle?.sessionId ?? null,
				eventId: event.id,
				oldPath: event.path,
				targetPath: event.targetPath,
				reason: outcome.reason,
				remoteStarted: outcome.remoteStarted,
			});
			return;
		}

		if (successor && outcome.canonicalRevision !== null) {
			successor.baseRevision = outcome.canonicalRevision;
			successor.epoch = outcome.epoch;
		}
		this.ports.acknowledgeEvents([event.id]);
		if (outcome.status === "superseded") {
			replayResult?.superseded.push(event.id);
		} else {
			replayResult?.completed.push(event.id);
		}
		await this.ports.waitForPersistence();
		logger.info("Watcher rename settled in coordinator", {
			sessionId: lifecycle?.sessionId ?? null,
			eventId: event.id,
			status: outcome.status,
			plan: outcome.plan,
			canonicalRevision: outcome.canonicalRevision,
			successorId: successor?.id ?? null,
			pendingWatcherEvents: this.ports.getEvents().length,
		});
	}

	/** Persist a folder operation receipt before acknowledging its watcher event. */
	async settleFolderEvent(
		event: DeferredWatcherEvent,
		outcome: FolderMutationOutcome,
		replayResult: RealtimeBatchResult,
	): Promise<void> {
		const id = event.id;
		if (!id) {
			return;
		}
		if (outcome.status === "retry") {
			if (!replayResult.retry.includes(id)) {
				replayResult.retry.push(id);
			}
			logger.warn("Watcher folder event remains durable", {
				eventId: id,
				action: event.action,
				path: event.path,
				reason: outcome.reason,
				unresolved: outcome.unresolved ?? 0,
				requiresUserAction: outcome.requiresUserAction === true,
			});
			return;
		}
		const successors = this.ports
			.getEvents()
			.filter(
				(candidate) =>
					candidate !== event &&
					candidate.action === "rename" &&
					(candidate.predecessorFolderEventId === id ||
						(candidate.kind === "folder" &&
							candidate.path ===
								(event.action === "rename"
									? event.targetPath
									: ""))),
			);
		if (outcome.canonicalRevision !== null) {
			for (const successor of successors) {
				if (successor.action !== "rename") {
					continue;
				}
				successor.baseRevision = outcome.canonicalRevision;
				successor.epoch = outcome.epoch;
				successor.predecessorFolderEventId = undefined;
			}
		}
		this.ports.acknowledgeEvents([id]);
		if (outcome.status === "superseded") {
			replayResult.superseded.push(id);
		} else {
			replayResult.completed.push(id);
		}
		await this.ports.waitForPersistence();
		logger.info("Watcher folder event settled", {
			eventId: id,
			action: event.action,
			path: event.path,
			canonicalRevision: outcome.canonicalRevision,
			mutationSeq: outcome.mutationSeq,
			survivors: outcome.survivors ?? 0,
			conflicts: outcome.conflicts ?? 0,
		});
	}
}
