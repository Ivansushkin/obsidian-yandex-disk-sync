import {
	reduceQueuedFileRename,
	reduceQueuedFolderRename,
	reduceFolderChildRename,
	mapPathThroughFolderRename,
	selectFolderRenameParent,
	shouldRetainQueuedFileEvent,
	type DurableFileRenameEvent,
	type DurableFolderEvent,
	type DurableFolderRenameEvent,
	type DurableRenameEvent,
	type RealtimeFileEvent,
	type RealtimeBatchResult,
	type UploadCausalReceipt,
} from "./rules";

export type DeferredWatcherEvent =
	| RealtimeFileEvent
	| {
			action: "delete-folder";
			path: string;
			id?: string;
			epoch?: string | null;
			baseRevision?: number | null;
			createdAt?: number;
			mutationId?: string;
			mutationSeq?: number;
			predecessorFolderEventId?: string;
	  }
	| {
			action: "rename";
			path: string;
			targetPath: string;
			kind: "file" | "folder";
			id?: string;
			epoch?: string | null;
			baseRevision?: number | null;
			createdAt?: number;
			predecessorUploadId?: string;
			mutationId?: string;
			mutationSeq?: number;
			predecessorFolderEventId?: string;
			folderParentAmbiguous?: boolean;
	  };

/** The existing persisted union after watcher-owned identity/context normalization. */
export type WatcherQueueEvent =
	RealtimeFileEvent | DurableFolderEvent | DurableFileRenameEvent;

export interface WatcherQueueContext {
	submittedFileIds: ReadonlySet<string>;
	submittedWatcherIds: ReadonlySet<string>;
}

export interface WatcherQueueReduction {
	events: WatcherQueueEvent[];
	event: WatcherQueueEvent;
	disposition: "queued" | "rebased" | "absorbed";
	chain?: { disposition: "rebased" | "running"; predecessorId: string };
	folderChild?: { parentId?: string; ambiguous: boolean };
	absorbedChildren: number;
	deletedRenameId?: string;
	absorbedDescendantEvents?: number;
}

function isSubmitted(
	event: Readonly<WatcherQueueEvent>,
	context: WatcherQueueContext,
): boolean {
	return (
		context.submittedFileIds.has(event.id) ||
		context.submittedWatcherIds.has(event.id)
	);
}

/** Transform durable events without allocation, scheduling or mutation of submitted snapshots. */
export function reduceWatcherQueue(
	existing: readonly Readonly<WatcherQueueEvent>[],
	incoming: Readonly<WatcherQueueEvent>,
	context: WatcherQueueContext,
): WatcherQueueReduction {
	let events: WatcherQueueEvent[] = [...existing];
	let event: WatcherQueueEvent = incoming;
	const result: WatcherQueueReduction = {
		events,
		event,
		disposition: "queued",
		absorbedChildren: 0,
	};
	if (event.action === "rename" && event.kind === "folder") {
		const parent = event;
		events = events.flatMap((candidate) => {
			if (
				candidate.action !== "rename" ||
				candidate.kind !== "file" ||
				isSubmitted(candidate, context)
			) {
				return [candidate];
			}
			const child = reduceFolderChildRename(parent, candidate);
			if (child.disposition === "absorbed") {
				result.absorbedChildren++;
				return [];
			}
			return [child.event ?? candidate];
		});
		const reduction = reduceQueuedFolderRename(
			events.filter(
				(candidate): candidate is DurableFolderRenameEvent =>
					candidate.action === "rename" &&
					candidate.kind === "folder",
			),
			event,
			context.submittedWatcherIds,
		);
		if (
			reduction.disposition !== "queued" &&
			reduction.predecessorId !== undefined
		) {
			result.chain = {
				disposition: reduction.disposition,
				predecessorId: reduction.predecessorId,
			};
			if (reduction.disposition === "rebased") {
				const predecessor = reduction.events.find(
					(candidate) => candidate.id === reduction.predecessorId,
				)!;
				return {
					...result,
					events: replaceRename(events, predecessor),
					event: predecessor,
					disposition: "rebased",
				};
			}
			event = {
				...event,
				predecessorFolderEventId: reduction.predecessorId,
			};
		}
	}
	if (event.action === "rename" && event.kind === "file") {
		const selection = selectFolderRenameParent(
			events.filter(
				(candidate): candidate is DurableFolderRenameEvent =>
					candidate.action === "rename" &&
					candidate.kind === "folder",
			),
			event.path,
		);
		result.folderChild = {
			parentId: selection.parent?.id,
			ambiguous: selection.ambiguous,
		};
		if (selection.ambiguous) {
			event = { ...event, folderParentAmbiguous: true };
		}
		if (selection.parent) {
			const child = reduceFolderChildRename(selection.parent, event);
			if (child.disposition === "absorbed") {
				return { ...result, events, event, disposition: "absorbed" };
			}
			event = child.event ?? event;
		}
		const reduction = reduceQueuedFileRename(
			events.filter(
				(candidate): candidate is DurableFileRenameEvent =>
					candidate.action === "rename" && candidate.kind === "file",
			),
			event,
			context.submittedWatcherIds,
		);
		if (
			reduction.disposition !== "queued" &&
			reduction.predecessorId !== undefined
		) {
			result.chain = {
				disposition: reduction.disposition,
				predecessorId: reduction.predecessorId,
			};
			if (reduction.disposition === "rebased") {
				const predecessor = reduction.events.find(
					(candidate) => candidate.id === reduction.predecessorId,
				)!;
				return {
					...result,
					events: replaceRename(events, predecessor),
					event: predecessor,
					disposition: "rebased",
				};
			}
		}
	}
	if (event.action === "upload" || event.action === "delete") {
		const predecessor = events.find(
			(candidate): candidate is DurableFileRenameEvent =>
				candidate.action === "rename" &&
				candidate.kind === "file" &&
				candidate.targetPath === event.path &&
				!isSubmitted(candidate, context),
		);
		if (predecessor && event.action === "upload") {
			return {
				...result,
				events,
				event,
				deletedRenameId: predecessor.id,
				disposition: "absorbed",
			};
		}
		if (predecessor) {
			events = events.filter(
				(candidate) => candidate.id !== predecessor.id,
			);
			event = {
				...event,
				path: predecessor.path,
				epoch: predecessor.epoch,
				baseRevision: predecessor.baseRevision,
			};
			result.deletedRenameId = predecessor.id;
		}
	}
	if (event.action === "delete-folder") {
		const prefix = `${event.path.replace(/\/+$/, "")}/`;
		const before = events.length;
		events = events.filter(
			(candidate) =>
				isSubmitted(candidate, context) ||
				!candidate.path.startsWith(prefix),
		);
		result.absorbedDescendantEvents = before - events.length;
	}
	const finalEvent = event;
	events = events.filter((candidate) => {
		if (isSubmitted(candidate, context)) {
			return true;
		}
		if (finalEvent.action === "upload" || finalEvent.action === "delete") {
			return (
				(candidate.action !== "upload" &&
					candidate.action !== "delete") ||
				shouldRetainQueuedFileEvent(
					candidate,
					finalEvent,
					context.submittedFileIds,
				)
			);
		}
		return candidate.path !== finalEvent.path;
	});
	return { ...result, events: [...events, event], event };
}

function replaceRename(
	events: WatcherQueueEvent[],
	predecessor: DurableRenameEvent,
): WatcherQueueEvent[] {
	return events.map((candidate) =>
		candidate.id === predecessor.id ? predecessor : candidate,
	);
}

/** Partition descendants once; submitted events keep their physical and causal paths. */
export function partitionFolderRenameQueue(
	events: readonly Readonly<WatcherQueueEvent>[],
	oldPath: string,
	context: WatcherQueueContext,
): {
	retained: WatcherQueueEvent[];
	descendants: WatcherQueueEvent[];
	coalescedParent: boolean;
} {
	const retained: WatcherQueueEvent[] = [];
	const descendants: WatcherQueueEvent[] = [];
	const prefix = `${oldPath}/`;
	let coalescedParent = false;
	for (const event of events) {
		const submitted = isSubmitted(event, context);
		if (
			!submitted &&
			event.action === "rename" &&
			event.kind === "folder" &&
			event.targetPath === oldPath
		) {
			coalescedParent = true;
		}
		const descendant =
			!submitted &&
			(event.path.startsWith(prefix) ||
				(event.action === "rename" &&
					event.targetPath.startsWith(prefix)));
		(descendant ? descendants : retained).push(event);
	}
	return { retained, descendants, coalescedParent };
}

/** Retarget each descendant once, retaining pre-parent rename/upload receipt order. */
export function retargetFolderDescendants(
	descendants: readonly Readonly<WatcherQueueEvent>[],
	oldPath: string,
	targetPath: string,
	parentId: string | undefined,
	coalescedParent: boolean,
): { predecessors: WatcherQueueEvent[]; successors: WatcherQueueEvent[] } {
	const predecessors: WatcherQueueEvent[] = [];
	const successors: WatcherQueueEvent[] = [];
	const retarget = (path: string) =>
		mapPathThroughFolderRename(path, oldPath, targetPath) ?? path;
	for (const event of descendants) {
		if (!coalescedParent && event.action !== "upload") {
			predecessors.push(
				event.action === "rename"
					? { ...event, targetPath: retarget(event.targetPath) }
					: event,
			);
			continue;
		}
		successors.push(
			event.action === "rename"
				? {
						...event,
						path: retarget(event.path),
						targetPath: retarget(event.targetPath),
						predecessorFolderEventId: parentId,
					}
				: { ...event, path: retarget(event.path) },
		);
	}
	return { predecessors, successors };
}

export type UploadReceiptEffect =
	| {
			kind: "rename";
			event: DurableFileRenameEvent;
			receipt?: UploadCausalReceipt;
	  }
	| {
			kind: "upload";
			event: RealtimeFileEvent;
			receipt: UploadCausalReceipt;
	  };

/** Advance causal successors before their settled upload predecessors are acknowledged. */
export function reduceUploadCausalReceipts(
	existing: readonly Readonly<WatcherQueueEvent>[],
	result: Pick<
		RealtimeBatchResult,
		"completed" | "superseded" | "uploadReceipts"
	>,
): { events: WatcherQueueEvent[]; effects: UploadReceiptEffect[] } {
	const eventsById = new Map(
		existing
			.filter(
				(event) =>
					event.action === "upload" || event.action === "delete",
			)
			.map((event) => [event.id, event]),
	);
	const receipts = new Map(
		(result.uploadReceipts ?? []).map((receipt) => [
			receipt.eventId,
			receipt,
		]),
	);
	const settledIds = new Set([...result.completed, ...result.superseded]);
	const effects: UploadReceiptEffect[] = [];
	let events = existing.map((candidate): WatcherQueueEvent => {
		if (
			candidate.action !== "rename" ||
			candidate.kind !== "file" ||
			!candidate.predecessorUploadId ||
			!settledIds.has(candidate.predecessorUploadId)
		) {
			return candidate;
		}
		const receipt = receipts.get(candidate.predecessorUploadId);
		const event = {
			...candidate,
			...(receipt?.status === "accepted-put"
				? {
						baseRevision: receipt.canonicalRevision,
						epoch: receipt.epoch,
					}
				: {}),
			predecessorUploadId: undefined,
		};
		effects.push({ kind: "rename", event, receipt });
		return event;
	});
	for (const receipt of receipts.values()) {
		if (
			receipt.status !== "accepted-put" ||
			receipt.canonicalRevision === null
		) {
			continue;
		}
		const predecessor = eventsById.get(receipt.eventId);
		if (!predecessor) {
			continue;
		}
		events = events.map((candidate) => {
			if (
				candidate.action !== "upload" ||
				candidate.id === receipt.eventId ||
				candidate.path !== receipt.path ||
				candidate.createdAt <= predecessor.createdAt ||
				settledIds.has(candidate.id) ||
				(candidate.epoch !== null && candidate.epoch !== receipt.epoch)
			) {
				return candidate;
			}
			const event = {
				...candidate,
				baseRevision: receipt.canonicalRevision,
				epoch: receipt.epoch,
			};
			effects.push({ kind: "upload", event, receipt });
			return event;
		});
	}
	return { events, effects };
}
