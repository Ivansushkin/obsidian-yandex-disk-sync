import type { FileMetadata, IndexMove, PendingMutation } from "../types";

export interface WatcherCausalContext {
	epoch: string | null;
	baseRevision: number | null;
}

export interface RealtimeFileEvent extends WatcherCausalContext {
	id: string;
	path: string;
	action: "upload" | "delete";
	createdAt: number;
	/**
	 * Mutable only while the event is waiting in the coordinator. Once a
	 * physical upload starts, a later rename observes the upload result.
	 */
	superseded?: boolean;
}

export interface RealtimeBatchResult {
	completed: string[];
	superseded: string[];
	retry: string[];
}

export type FileRenamePlan =
	| "put-target"
	| "remote-move"
	| "materialize-target";

export type FileRenameOutcomePlan =
	| FileRenamePlan
	| "delete-source"
	| "already-applied";

export interface FileRenameOutcome {
	status: "completed" | "superseded" | "retry";
	plan?: FileRenameOutcomePlan;
	canonicalRevision: number | null;
	epoch: string | null;
	reason?: string;
	/** True once an API read or write may have observed or changed remote state. */
	remoteStarted: boolean;
}

export interface DurableFileRenameEvent extends WatcherCausalContext {
	id: string;
	action: "rename";
	path: string;
	targetPath: string;
	kind: "file";
	createdAt: number;
}

export interface RenameChainReduction {
	events: DurableFileRenameEvent[];
	disposition: "queued" | "rebased" | "running";
	predecessorId?: string;
}

/**
 * Reduce a newly observed rename against queued work without rewriting an
 * already running predecessor. Recreated source paths remain separate events.
 */
export function reduceQueuedFileRename(
	existing: DurableFileRenameEvent[],
	incoming: DurableFileRenameEvent,
	runningIds: ReadonlySet<string>,
): RenameChainReduction {
	const predecessorIndex = existing.findIndex(
		(event) => event.targetPath === incoming.path,
	);
	if (predecessorIndex < 0) {
		return { events: [...existing, incoming], disposition: "queued" };
	}
	const predecessor = existing[predecessorIndex]!;
	if (runningIds.has(predecessor.id)) {
		return {
			events: [...existing, incoming],
			disposition: "running",
			predecessorId: predecessor.id,
		};
	}
	const reduced = [...existing];
	reduced[predecessorIndex] = {
		...predecessor,
		targetPath: incoming.targetPath,
	};
	return {
		events: reduced,
		disposition: "rebased",
		predecessorId: predecessor.id,
	};
}

/**
 * Decide whether the source belonged to the state observed by the rename.
 */
export function wasRenameSourceCausallyLive(
	localBaseline: FileMetadata | undefined,
	canonicalSource: FileMetadata | undefined,
	baseRevision: number | null,
): boolean {
	if (!localBaseline || localBaseline.deleted) return false;
	if (!canonicalSource || canonicalSource.deleted) return false;
	if (baseRevision === null) return false;
	return (canonicalSource.changedRevision ?? 0) <= baseRevision;
}

/**
 * Select the physical implementation of a file rename.
 */
export function selectFileRenamePlan(
	sourceCausallyLive: boolean,
	sourceMetadata: FileMetadata | undefined,
	targetSha256: string,
): FileRenamePlan {
	if (!sourceCausallyLive) return "put-target";
	if (!sourceMetadata || sourceMetadata.sha256 !== targetSha256) {
		return "materialize-target";
	}
	return "remote-move";
}

/**
 * Confirm that a locally pending put was already accepted by the canonical
 * device watermark and still represents a live source.
 */
export function wasPendingPutAccepted(
	pendingPut: PendingMutation | undefined,
	appliedMutationSeq: Record<string, number>,
	canonicalSource: FileMetadata | undefined,
): boolean {
	if (!pendingPut || !canonicalSource || canonicalSource.deleted) return false;
	return wasMutationApplied(pendingPut, appliedMutationSeq);
}

/**
 * Check a mutation against the canonical per-device high watermark.
 */
export function wasMutationApplied(
	mutation: PendingMutation,
	appliedMutationSeq: Record<string, number>,
): boolean {
	const separator = mutation.id.lastIndexOf(":");
	if (separator <= 0) return false;
	const deviceId = mutation.id.slice(0, separator);
	return (appliedMutationSeq[deviceId] ?? 0) >= mutation.seq;
}

/**
 * Decide whether a missing upload path has a durable causal replacement.
 */
export function isMissingUploadSuperseded(
	event: RealtimeFileEvent,
	canonicalSource: FileMetadata | undefined,
	moves: Record<string, IndexMove>,
): boolean {
	if (event.superseded || canonicalSource?.deleted) return true;
	return Object.values(moves).some(
		(move) => move.fromPath === event.path,
	);
}

/**
 * Keep submitted work but replace older queued file work for the same path.
 */
export function shouldRetainQueuedFileEvent(
	existing: RealtimeFileEvent,
	incoming: RealtimeFileEvent,
	submittedIds: ReadonlySet<string>,
): boolean {
	return existing.path !== incoming.path || submittedIds.has(existing.id);
}

/**
 * Create independent acknowledgement buckets for a realtime drain.
 */
export function createRealtimeBatchResult(): RealtimeBatchResult {
	return {
		completed: [],
		superseded: [],
		retry: [],
	};
}
