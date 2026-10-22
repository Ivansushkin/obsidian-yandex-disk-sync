import type { FileMetadata, PendingMutation, SyncIndex } from "../../types";
import { computeSha256 } from "../../utils/hash-utils";
import { logger } from "../../utils/logger";
import { getAncestorDirectoriesDeepestFirst } from "../../utils/path-utils";
import { runWithConcurrencySettled } from "../../utils/semaphore";
import { isPathInsideFolder } from "../canonical/mutation-rules";
import { planFolderMove, stageFolderMove } from "../files/folder-mutations";
import { pruneRemoteFolders } from "../files/operations";
import { executeGuardedRemoteMove } from "../files/remote-moves";
import { stageFileMove, type Dependencies } from "../files/rename";
import {
	saveMoveCompletionBestEffort,
	saveRemoteIndexBestEffort,
} from "../reconciliation/commits";
import {
	wasRenameSourceCausallyLive,
	type DurableRenameEvent,
	type RenameBatchResult,
} from "./rules";

export const MAX_RENAME_BATCH_EVENTS = 32;

interface MovePair {
	fromPath: string;
	toPath: string;
	metadata: FileMetadata;
}
interface PreparedRename {
	event: DurableRenameEvent;
	pairs: MovePair[];
	mutation?: PendingMutation;
}

/** Stop at the first dependency; shared ancestor directories alone are harmless. */
export function independentRenamePrefix(
	events: readonly DurableRenameEvent[],
): DurableRenameEvent[] {
	const selected: DurableRenameEvent[] = [];
	const roots = new Set<string>();
	const ancestors = new Set<string>();
	for (const event of events.slice(0, MAX_RENAME_BATCH_EVENTS)) {
		if (
			!event.id ||
			event.mutationId ||
			event.mutationSeq !== undefined ||
			event.predecessorFolderEventId ||
			(event.kind === "file" &&
				(event.predecessorUploadId || event.folderParentAmbiguous)) ||
			event.epoch === null ||
			event.baseRevision === null ||
			(selected.length > 0 &&
				(event.epoch !== selected[0]!.epoch ||
					event.baseRevision !== selected[0]!.baseRevision)) ||
			isPathInsideFolder(event.path, event.targetPath) ||
			isPathInsideFolder(event.targetPath, event.path) ||
			[event.path, event.targetPath].some(
				(path) =>
					roots.has(path) ||
					ancestors.has(path) ||
					getAncestorDirectoriesDeepestFirst([path]).some((parent) =>
						roots.has(parent),
					),
			)
		) {
			break;
		}
		selected.push(event);
		for (const path of [event.path, event.targetPath]) {
			roots.add(path);
			for (const parent of getAncestorDirectoriesDeepestFirst([path])) {
				ancestors.add(parent);
			}
		}
	}
	return selected;
}

/** Classify an unchanged contiguous prefix before allocating any durable sequence. */
async function prepareRenames(
	deps: Dependencies,
	events: DurableRenameEvent[],
	canonical: SyncIndex,
): Promise<PreparedRename[]> {
	const prepared: PreparedRename[] = [];
	const localFiles = deps.vaultAdapter.getAllSyncableFiles();
	for (const event of events) {
		if (
			event.epoch !== canonical.epoch ||
			!deps.vaultAdapter.shouldSync(event.path) ||
			!deps.vaultAdapter.shouldSync(event.targetPath) ||
			canonical.files[event.targetPath]
		) {
			break;
		}
		let pairs: MovePair[];
		if (event.kind === "folder") {
			const plan = planFolderMove(
				canonical,
				deps.settings.deviceId,
				event.path,
				event.targetPath,
				event.baseRevision!,
				deps.indexManager.getLocalIndexData().nextMutationSeq +
					prepared.length,
			);
			if (
				plan.survivors ||
				plan.conflicts ||
				plan.ambiguous ||
				plan.plannedPairs.length === 0 ||
				Object.keys(canonical.files).some((path) =>
					isPathInsideFolder(path, event.targetPath),
				)
			) {
				break;
			}
			pairs = plan.plannedPairs.map((pair) => ({
				...pair,
				metadata: canonical.files[pair.fromPath]!,
			}));
			if (
				localFiles.filter((file) =>
					isPathInsideFolder(file.path, event.targetPath),
				).length !== pairs.length
			) {
				break;
			}
		} else {
			const source = canonical.files[event.path];
			if (!source || source.deleted) {
				break;
			}
			pairs = [
				{
					fromPath: event.path,
					toPath: event.targetPath,
					metadata: source,
				},
			];
		}
		let eligible = true;
		for (const pair of pairs) {
			if (
				!deps.vaultAdapter.shouldSync(pair.fromPath) ||
				!deps.vaultAdapter.shouldSync(pair.toPath) ||
				!wasRenameSourceCausallyLive(
					deps.indexManager.getLocalIndex().files[pair.fromPath],
					pair.metadata,
					event.baseRevision,
					deps.settings.deviceId,
				) ||
				!deps.vaultAdapter.fileExists(pair.toPath)
			) {
				eligible = false;
				break;
			}
			try {
				if (
					(await computeSha256(
						await deps.vaultAdapter.readFile(pair.toPath),
					)) !== pair.metadata.sha256
				) {
					eligible = false;
					break;
				}
			} catch {
				eligible = false;
				break;
			}
		}
		if (!eligible) {
			break;
		}
		prepared.push({ event, pairs });
	}
	return prepared;
}

/** Publish independent intents together while retaining per-move authority and recovery. */
export async function renameBatchNow(
	deps: Dependencies,
	events: readonly DurableRenameEvent[],
): Promise<RenameBatchResult | null> {
	const candidates = independentRenamePrefix(events);
	const index = deps.indexManager;
	if (
		candidates.length < 2 ||
		index.getPendingMutations().length ||
		index.getPendingPhysicalActions().length
	) {
		return null;
	}
	const guard = await deps.getSyncGuardResult(false);
	if (guard.blockReason) {
		return null;
	}
	deps.realtimeGuardValidationToken = guard.validationToken;
	const canonical = await index.refreshCanonicalForMutation();
	if (canonical.maintenance || Object.keys(canonical.moves).length) {
		return null;
	}
	const prepared = await prepareRenames(deps, candidates, canonical);
	if (prepared.length < 2) {
		return null;
	}
	const startedAt = Date.now();
	let confirmedCommits = 0;
	const outcomes: RenameBatchResult = prepared.map(({ event }) =>
		event.kind === "file"
			? {
					eventId: event.id,
					kind: "file",
					outcome: {
						status: "retry",
						canonicalRevision: null,
						epoch: event.epoch,
						remoteStarted: true,
						plan: "remote-move",
						reason: "rename-batch-unresolved",
					},
				}
			: {
					eventId: event.id,
					kind: "folder",
					outcome: {
						status: "retry",
						canonicalRevision: null,
						epoch: event.epoch,
						reason: "rename-batch-unresolved",
					},
				},
	);
	const receipts = new Map(
		outcomes.map((outcome) => [outcome.eventId, outcome]),
	);
	try {
		for (const item of prepared) {
			const { event } = item;
			if (event.kind === "file") {
				const source = item.pairs[0]!.metadata;
				item.mutation = stageFileMove(
					index,
					event.path,
					event.targetPath,
					{
						path: event.targetPath,
						sha256: source.sha256,
						size: source.size,
						mtime:
							deps.vaultAdapter.getFileMtime(event.targetPath) ||
							source.mtime,
						syncedAt: Date.now(),
					},
					event,
					source,
				).mutation;
			} else {
				item.mutation = index.enqueueMutation("move", event.path, {
					targetPath: event.targetPath,
					resourceKind: "folder",
					epoch: event.epoch,
					baseRevision: event.baseRevision,
				});
				stageFolderMove(
					index,
					canonical,
					event.path,
					event.targetPath,
					item.mutation,
					item.pairs,
				);
			}
			event.mutationId = item.mutation.id;
			event.mutationSeq = item.mutation.seq;
			const receipt = receipts.get(event.id)!;
			if (receipt.kind === "folder") {
				receipt.outcome.mutationId = item.mutation.id;
				receipt.outcome.mutationSeq = item.mutation.seq;
			}
		}
		await deps.indexSaveCallback?.();
		if (!(await saveRemoteIndexBestEffort(deps.syncReconciliation))) {
			return outcomes;
		}
		confirmedCommits++;
		const tasks = prepared.flatMap((item) =>
			item.pairs.map((pair) => async () => {
				const accepted = index.getRemoteIndex();
				const source = accepted.files[pair.fromPath];
				const target = accepted.files[pair.toPath];
				const mutation = item.mutation!;
				if (
					!source?.deleted ||
					source.mutationSeq !== mutation.seq ||
					source.lastModifiedBy !== deps.settings.deviceId ||
					!target ||
					target.deleted ||
					target.mutationSeq !== mutation.seq ||
					target.lastModifiedBy !== deps.settings.deviceId ||
					target.sha256 !== pair.metadata.sha256 ||
					!accepted.moves[mutation.id]?.pending
				) {
					throw new Error(
						"Rename pair was not accepted by canonical",
					);
				}
				const action = index.enqueuePhysicalAction(
					"move-remote",
					pair.fromPath,
					{
						targetPath: pair.toPath,
						parentMutationId:
							item.event.kind === "folder"
								? mutation.id
								: undefined,
						canonicalRevision: accepted.revision,
						expectedFingerprint: pair.metadata.remoteFingerprint,
						expectedChangedRevision: source.changedRevision,
						origin: "move",
					},
				);
				const physicalGuard = await deps.getSyncGuardResult(
					false,
					guard.validationToken,
				);
				if (physicalGuard.blockReason) {
					throw new Error(physicalGuard.blockReason);
				}
				await executeGuardedRemoteMove(
					deps.remoteMoves,
					pair.fromPath,
					pair.toPath,
					action.id,
				);
			}),
		);
		const results = await runWithConcurrencySettled(
			tasks,
			Math.min(Math.max(1, deps.settings.maxConcurrency), 4),
		);
		const failed = results.find((result) => result.status === "rejected");
		if (failed?.status === "rejected") {
			logger.warn("Rename batch physical work remains pending", {
				error: failed.reason,
			});
		}
		const finalCanonical = await index.readCanonicalIndex();
		if (finalCanonical.epoch !== canonical.epoch) {
			deps.epochReplacementPending = true;
		}
		let offset = 0;
		const completed = prepared.filter((item) => {
			const physical = results.slice(offset, offset + item.pairs.length);
			offset += item.pairs.length;
			return (
				finalCanonical.epoch === canonical.epoch &&
				!finalCanonical.maintenance &&
				physical.every((result) => result.status === "fulfilled") &&
				item.pairs.every((pair) => {
					const target = finalCanonical.files[pair.toPath];
					return (
						target &&
						!target.deleted &&
						target.sha256 === pair.metadata.sha256 &&
						target.lastModifiedBy === deps.settings.deviceId &&
						target.mutationSeq === item.mutation!.seq &&
						!index.getPendingPhysicalAction(
							"move-remote",
							pair.fromPath,
						)
					);
				})
			);
		});
		if (completed.length === 0) {
			return outcomes;
		}
		for (const item of completed) {
			index.completeMove(item.mutation!.id);
		}
		if (!(await saveMoveCompletionBestEffort(deps.syncReconciliation))) {
			return outcomes;
		}
		confirmedCommits++;
		for (const item of completed) {
			index.confirmMutation(item.mutation!.id);
			const outcome = receipts.get(item.event.id)!.outcome;
			outcome.status = "completed";
			outcome.reason = undefined;
			outcome.canonicalRevision = index.getRemoteIndex().revision;
		}
		await deps.indexSaveCallback?.();
		await pruneRemoteFolders(
			deps.fileOperations,
			completed.flatMap((item) =>
				item.pairs.map((pair) => pair.fromPath),
			),
		);
		return outcomes;
	} catch (error) {
		for (const item of outcomes) {
			item.outcome.status = "retry";
			item.outcome.reason = "rename-batch-unresolved";
		}
		logger.warn("Rename batch remains durable", { error });
		return outcomes;
	} finally {
		if (deps.epochReplacementPending) {
			for (const item of outcomes) {
				if (item.kind === "file") {
					item.outcome.requiresFullSync = "epoch-replaced";
				}
			}
		}
		await deps.indexSaveCallback?.();
		const retry = outcomes.filter(
			(item) => item.outcome.status === "retry",
		).length;
		logger[retry ? "warn" : "info"]("Rename batch finished", {
			events: prepared.length,
			completed: outcomes.length - retry,
			retry,
			confirmedCommits,
			durationMs: Date.now() - startedAt,
		});
	}
}
