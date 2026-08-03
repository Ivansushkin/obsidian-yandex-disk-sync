import type { FileMetadata, IndexMove, PendingMutation } from "../types";

export interface WatcherCausalContext {
	epoch: string | null;
	baseRevision: number | null;
	mutationId?: string;
	mutationSeq?: number;
}

export interface RealtimeFileEvent extends WatcherCausalContext {
	id: string;
	path: string;
	action: "upload" | "delete";
	createdAt: number;
	/** Durable identity of the put allocated before a remote upload starts. */
	mutationId?: string;
	mutationSeq?: number;
	/** Plaintext snapshot identity used to recover an accepted put after crash. */
	snapshotSha256?: string;
	/** Rename that causally consumes this upload, when one arrived in flight. */
	supersededByRenameId?: string;
	/**
	 * Mutable only while the event is waiting in the coordinator. Once a
	 * physical upload starts, a later rename observes the upload result.
	 */
	superseded?: boolean;
}

export interface UploadCausalReceipt {
	eventId: string;
	path: string;
	status: "pending-put" | "accepted-put" | "rejected-put";
	reason:
		| "accepted-put"
		| "coalesced"
		| "idempotent"
		| "stale-same-device"
		| "foreign-conflict"
		| "unresolved";
	epoch: string | null;
	canonicalRevision: number | null;
	mutationId?: string;
	mutationSeq?: number;
	sha256?: string;
}

export interface RealtimeBatchResult {
	completed: string[];
	superseded: string[];
	retry: string[];
	uploadReceipts: UploadCausalReceipt[];
	requiresFullSync?: "epoch-replaced";
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
	requiresFullSync?: "epoch-replaced";
}

export interface DurableFileRenameEvent extends WatcherCausalContext {
	id: string;
	action: "rename";
	path: string;
	targetPath: string;
	kind: "file";
	createdAt: number;
	/** Submitted upload whose accepted state must be observed before this rename. */
	predecessorUploadId?: string;
	/** Folder move that rebased this user-authored child rename. */
	predecessorFolderEventId?: string;
	/** Multiple equally specific folder events could not be ordered causally. */
	folderParentAmbiguous?: boolean;
}

interface DurableFolderEventBase extends WatcherCausalContext {
	id: string;
	path: string;
	createdAt: number;
	mutationId?: string;
	mutationSeq?: number;
	predecessorFolderEventId?: string;
}

export interface DurableFolderDeleteEvent extends DurableFolderEventBase {
	action: "delete-folder";
}

export interface DurableFolderRenameEvent extends DurableFolderEventBase {
	action: "rename";
	targetPath: string;
	kind: "folder";
}

export type DurableFolderEvent =
	| DurableFolderDeleteEvent
	| DurableFolderRenameEvent;

export interface FolderMutationOutcome {
	status: "completed" | "superseded" | "retry";
	canonicalRevision: number | null;
	epoch: string | null;
	mutationId?: string;
	mutationSeq?: number;
	reason?: string;
	conflicts?: number;
	survivors?: number;
	unresolved?: number;
	requiresUserAction?: boolean;
}

export interface FolderRenameReduction {
	events: DurableFolderRenameEvent[];
	disposition: "queued" | "rebased" | "running";
	predecessorId?: string;
}

/**
 * Map a descendant path through a folder rename while preserving its suffix.
 */
export function mapPathThroughFolderRename(
	path: string,
	fromFolder: string,
	toFolder: string,
): string | null {
	const from = fromFolder.replace(/\/+$/, "");
	const to = toFolder.replace(/\/+$/, "");
	if (!path.startsWith(`${from}/`)) return null;
	return `${to}/${path.slice(from.length + 1)}`;
}

/**
 * Coalesce queued folder rename chains without rewriting a running parent.
 */
export function reduceQueuedFolderRename(
	existing: DurableFolderRenameEvent[],
	incoming: DurableFolderRenameEvent,
	runningIds: ReadonlySet<string>,
): FolderRenameReduction {
	const predecessorIndex = existing.findIndex(
		(event) =>
			event.action === "rename" &&
			event.targetPath === incoming.path,
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
 * Classify an Obsidian child rename emitted by a queued folder rename.
 */
export function reduceFolderChildRename(
	parent: DurableFolderRenameEvent,
	child: DurableFileRenameEvent,
): { disposition: "absorbed" | "successor" | "unrelated"; event?: DurableFileRenameEvent } {
	const mechanicalTarget = mapPathThroughFolderRename(
		child.path,
		parent.path,
		parent.targetPath,
	);
	if (!mechanicalTarget) return { disposition: "unrelated" };
	if (mechanicalTarget === child.targetPath) {
		return { disposition: "absorbed" };
	}
	return {
		disposition: "successor",
		event: {
			...child,
			path: mechanicalTarget,
			predecessorFolderEventId: parent.id,
		},
	};
}

export interface FolderRenameParentSelection {
	parent?: DurableFolderRenameEvent;
	ambiguous: boolean;
}

/**
 * Select the most specific causal folder rename for a child path. Equal-depth
 * events are ordered by creation time and must form an explicit chain.
 */
export function selectFolderRenameParent(
	parents: readonly DurableFolderRenameEvent[],
	childPath: string,
): FolderRenameParentSelection {
	const applicable = parents
		.map((parent, order) => ({
			parent,
			order,
			depth: parent.path.replace(/\/+$/, "").split("/").length,
		}))
		.filter(({ parent }) =>
			childPath.startsWith(`${parent.path.replace(/\/+$/, "")}/`),
		)
		.sort(
			(left, right) =>
				right.depth - left.depth ||
				right.parent.createdAt - left.parent.createdAt ||
				right.order - left.order,
		);
	const selected = applicable[0];
	if (!selected) return { ambiguous: false };
	const competing = applicable[1];
	return {
		parent: selected.parent,
		ambiguous:
			competing !== undefined &&
			competing.depth === selected.depth &&
			selected.parent.predecessorFolderEventId !== competing.parent.id &&
			competing.parent.targetPath !== selected.parent.path,
	};
}

export interface RenameChainReduction {
	events: DurableFileRenameEvent[];
	disposition: "queued" | "rebased" | "running";
	predecessorId?: string;
}

export interface PostFullRenameState {
	canonicalEpoch: string;
	canonicalRevision: number;
	canonicalSource?: FileMetadata;
	canonicalTarget?: FileMetadata;
	localTarget?: FileMetadata;
	targetExists: boolean;
	hasPendingWork: boolean;
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
	deviceId?: string,
): boolean {
	if (!localBaseline || localBaseline.deleted) return false;
	if (!canonicalSource || canonicalSource.deleted) return false;
	if (baseRevision === null) return false;
	return (
		(canonicalSource.changedRevision ?? 0) <= baseRevision ||
		(canonicalSource.lastModifiedBy === deviceId &&
			typeof canonicalSource.mutationSeq === "number")
	);
}

/**
 * Classify a missing-target rename after a successful full reconciliation.
 * This decision is logical-only and never authorizes a physical operation.
 */
export function classifyPostFullRename(
	event: DurableFileRenameEvent,
	state: PostFullRenameState,
): FileRenameOutcome {
	const baseRevision = event.baseRevision;
	const sourceIsNewer =
		state.canonicalSource !== undefined &&
		!state.canonicalSource.deleted &&
		baseRevision !== null &&
		(state.canonicalSource.changedRevision ?? 0) > baseRevision;
	const sourceIsSettled =
		state.canonicalSource === undefined ||
		state.canonicalSource.deleted === true;
	const targetIsConfirmed =
		state.targetExists &&
		state.canonicalTarget !== undefined &&
		!state.canonicalTarget.deleted &&
		state.localTarget !== undefined &&
		!state.localTarget.deleted &&
		state.localTarget.sha256 === state.canonicalTarget.sha256;
	const baseOutcome = {
		canonicalRevision: state.canonicalRevision,
		epoch: state.canonicalEpoch,
		remoteStarted: false,
	} as const;

	if (event.epoch !== null && event.epoch !== state.canonicalEpoch) {
		return {
			...baseOutcome,
			status: "superseded",
			reason: "epoch-replaced-by-full",
		};
	}
	if (state.hasPendingWork) {
		return {
			...baseOutcome,
			status: "retry",
			reason: "related-causal-work-pending",
		};
	}
	if (targetIsConfirmed && (sourceIsSettled || sourceIsNewer)) {
		return {
			...baseOutcome,
			status: "completed",
			plan: "already-applied",
			reason: sourceIsNewer
				? "target-applied-concurrent-source-preserved"
				: "target-applied-by-full",
		};
	}
	if (
		!state.targetExists &&
		(state.canonicalTarget === undefined || state.canonicalTarget.deleted)
	) {
		if (sourceIsSettled) {
			return {
				...baseOutcome,
				status: "superseded",
				reason: "source-and-target-settled-by-full",
			};
		}
		if (sourceIsNewer) {
			return {
				...baseOutcome,
				status: "superseded",
				reason: "concurrent-source-preserved",
			};
		}
	}
	return {
		...baseOutcome,
		status: "retry",
		reason: "post-full-rename-ambiguous",
	};
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
		uploadReceipts: [],
	};
}
