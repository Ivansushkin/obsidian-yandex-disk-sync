import type { FileMetadata, IndexMove, SyncResult } from "../../types";
import { logger } from "../../utils/logger";
import { runWithConcurrencySettled } from "../../utils/semaphore";
import * as syncErrors from "../errors";
import * as fileOperations from "../files/operations";
import * as remoteMoves from "../files/remote-moves";
import { saveRemoteIndexOrAbort } from "./commits";
import type { Dependencies as ReconciliationDependencies } from "./context";
export type Dependencies = Pick<
	ReconciliationDependencies,
	| "conflictResolver"
	| "epochReplacementPending"
	| "expectWatcherEvent"
	| "fileOperations"
	| "getSyncGuardResult"
	| "indexManager"
	| "indexSaveCallback"
	| "realtimeGuardValidationToken"
	| "remoteMoves"
	| "setBlockedState"
	| "settings"
	| "vaultAdapter"
	| "yandexClient"
>;

/** Return whether a full session still has guarded physical work to resume. */
export function hasPendingPhysicalWork(
	deps: Pick<Dependencies, "indexManager">,
): boolean {
	return (
		deps.indexManager.getPendingPhysicalActions().length > 0 ||
		Object.values(deps.indexManager.getRemoteIndex().moves).some(
			(move) => move.pending,
		)
	);
}

/** Finish logical moves left pending by an interrupted device. */
export async function resumePendingMoves(
	deps: Dependencies,
	result: SyncResult,
	reportUnresolved = false,
): Promise<void> {
	const pendingMoves = Object.values(deps.indexManager.getRemoteIndex().moves)
		.filter((move) => move.pending)
		.sort(
			(left, right) =>
				left.changedRevision - right.changedRevision ||
				(left.mutationSeq ?? Number.MAX_SAFE_INTEGER) -
					(right.mutationSeq ?? Number.MAX_SAFE_INTEGER),
		);
	if (pendingMoves.length === 0) {
		return;
	}

	let changed = false;
	let recovered = 0;
	let unresolved = 0;
	const completedLocalMutationIds: string[] = [];
	for (const move of pendingMoves) {
		try {
			if (move.kind === "folder") {
				const folderResult = await resumePendingFolderMove(deps, move);
				if (folderResult.unresolved > 0) {
					throw new Error(
						`${folderResult.unresolved} child move(s) remain unresolved`,
					);
				}
				deps.indexManager.completeMove(move.id);
				if (stageRecoveredMoveMutation(deps, move.id)) {
					completedLocalMutationIds.push(move.id);
				}
				changed = true;
				recovered++;
				continue;
			}
			if (
				deps.indexManager.getRemoteIndex().files[move.toPath]?.deleted
			) {
				const action = deps.indexManager.getPendingPhysicalAction(
					"move-remote",
					move.fromPath,
				);
				if (
					action?.targetPath === move.toPath &&
					action.epoch === deps.indexManager.getRemoteIndex().epoch
				) {
					deps.indexManager.completePhysicalAction(action.id);
				}
				deps.indexManager.completeMove(move.id);
				if (stageRecoveredMoveMutation(deps, move.id)) {
					completedLocalMutationIds.push(move.id);
				}
				changed = true;
				recovered++;
				continue;
			}
			if (move.kind === "file") {
				const target =
					deps.indexManager.getRemoteIndex().files[move.toPath];
				if (
					target &&
					!target.deleted &&
					target.lastModifiedBy !== move.lastModifiedBy
				) {
					throw new Error(
						`Move target changed concurrently: ${move.toPath}`,
					);
				}
			}
			deps.indexManager.enqueuePhysicalAction(
				"move-remote",
				move.fromPath,
				{
					targetPath: move.toPath,
					canonicalRevision:
						deps.indexManager.getRemoteIndex().revision,
					expectedFingerprint:
						deps.indexManager.getRemoteIndex().files[move.fromPath]
							?.remoteFingerprint,
					origin: "move",
				},
			);
			await remoteMoves.executeGuardedRemoteMove(
				deps.remoteMoves,
				move.fromPath,
				move.toPath,
			);
			deps.indexManager.completeMove(move.id);
			if (stageRecoveredMoveMutation(deps, move.id)) {
				completedLocalMutationIds.push(move.id);
			}
			changed = true;
			recovered++;
		} catch (e) {
			unresolved++;
			logger.warn(
				`Could not resume pending move ${move.fromPath} -> ${move.toPath}:`,
				{
					finalPass: reportUnresolved,
					error: e,
				},
			);
			if (reportUnresolved) {
				result.errors.push({
					path: move.toPath,
					operation: "none",
					message: `Pending move ${move.fromPath} -> ${move.toPath}: ${
						e instanceof Error ? e.message : String(e)
					}`,
				});
			}
		}
	}
	if (changed) {
		let committed = false;
		deps.indexManager.beginPhysicalRewriteCommit();
		try {
			committed = Boolean(
				await saveRemoteIndexOrAbort(deps, result, false),
			);
		} finally {
			deps.indexManager.cancelPhysicalRewriteCommit();
		}
		if (committed) {
			for (const id of completedLocalMutationIds) {
				deps.indexManager.confirmMutation(id);
			}
			if (
				completedLocalMutationIds.length > 0 &&
				deps.indexSaveCallback
			) {
				await deps.indexSaveCallback();
			}
		}
	}
	logger[unresolved > 0 && reportUnresolved ? "warn" : "info"](
		"Pending file move recovery completed",
		{
			finalPass: reportUnresolved,
			attempted: pendingMoves.length,
			recovered,
			unresolved,
		},
	);
}

/** Resume the file-level physical work authorized by one folder move. */
export async function resumePendingFolderMove(
	deps: Dependencies,
	move: IndexMove,
): Promise<{ recovered: number; unresolved: number }> {
	if (typeof move.mutationSeq !== "number") {
		return { recovered: 0, unresolved: 1 };
	}
	const index = deps.indexManager.getRemoteIndex();
	const fromPrefix = `${move.fromPath.replace(/\/+$/, "")}/`;
	const toPrefix = `${move.toPath.replace(/\/+$/, "")}/`;
	const targets = Object.entries(index.files).filter(
		([path, metadata]) =>
			path.startsWith(toPrefix) &&
			metadata.deleted !== true &&
			metadata.lastModifiedBy === move.lastModifiedBy &&
			metadata.mutationSeq === move.mutationSeq,
	);
	const pairs = targets.map(([toPath, target]) => {
		const fromPath = `${fromPrefix}${toPath.slice(toPrefix.length)}`;
		return { fromPath, toPath, source: index.files[fromPath], target };
	});
	const results = await runWithConcurrencySettled(
		pairs.map(({ fromPath, toPath, source }) => async () => {
			const action = deps.indexManager.enqueuePhysicalAction(
				"move-remote",
				fromPath,
				{
					targetPath: toPath,
					parentMutationId: move.id,
					canonicalRevision: index.revision,
					expectedFingerprint:
						source?.deleted === true
							? source.remoteFingerprint
							: undefined,
					expectedChangedRevision: source?.changedRevision,
					origin: "move",
				},
			);
			await remoteMoves.executeGuardedRemoteMove(
				deps.remoteMoves,
				fromPath,
				toPath,
				action.id,
			);
		}),
		Math.min(Math.max(1, deps.settings.maxConcurrency), 4),
	);
	const unresolved = results.filter(
		(result) => result.status === "rejected",
	).length;
	return { recovered: pairs.length - unresolved, unresolved };
}

/** Stage the local half of a recovered canonical move, when this device still owns its durable FIFO mutation. */
function stageRecoveredMoveMutation(
	deps: Dependencies,
	moveId: string,
): boolean {
	const mutation = deps.indexManager
		.getPendingMutations()
		.find(
			(candidate) => candidate.id === moveId && candidate.type === "move",
		);
	if (!mutation) {
		return false;
	}
	deps.indexManager.stageMutation(mutation);
	return true;
}

/** Finish canonical-authorized destructive work before scanning physical files, so an interrupted delete cannot be mistaken for a new file. */
export async function resumePendingPhysicalActions(
	deps: Dependencies,
	result: SyncResult,
): Promise<void> {
	const actions = deps.indexManager
		.getPendingPhysicalActions()
		.filter(
			(action) =>
				action.type === "delete-local" ||
				action.type === "delete-remote",
		);
	for (const action of actions) {
		try {
			if (action.type === "delete-local") {
				await fileOperations.deleteLocalFile(
					deps.fileOperations,
					action.path,
				);
			} else {
				await fileOperations.deleteRemoteFile(
					deps.fileOperations,
					action.path,
				);
			}
			if (
				deps.indexManager
					.getPendingPhysicalActions()
					.some((candidate) => candidate.id === action.id)
			) {
				result.errors.push({
					path: action.path,
					operation:
						action.type === "delete-local"
							? "delete_local"
							: "delete_remote",
					code: "pending-physical-action-unresolved",
					message: `Authorized physical action remains unresolved: ${action.id}`,
				});
			}
		} catch (error) {
			result.errors.push(
				syncErrors.createSyncError(
					error,
					action.path,
					action.type === "delete-local"
						? "delete_local"
						: "delete_remote",
					"physical-recovery",
				),
			);
		}
	}
	if (actions.length > 0 && deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}
}

/** Acknowledge durable actions only when the scanned state proves completion. */
export function reconcileCompletedPhysicalActions(
	deps: Dependencies,
	localFiles: Map<string, FileMetadata>,
	remoteFiles: Map<string, FileMetadata>,
): boolean {
	let changed = false;
	for (const action of deps.indexManager.getPendingPhysicalActions()) {
		const completed =
			(action.type === "delete-local" && !localFiles.has(action.path)) ||
			(action.type === "delete-remote" &&
				!remoteFiles.has(action.path)) ||
			(action.type === "move-remote" &&
				action.targetPath !== undefined &&
				!remoteFiles.has(action.path) &&
				remoteFiles.has(action.targetPath));
		if (!completed) {
			continue;
		}
		deps.indexManager.completePhysicalAction(action.id);
		changed = true;
	}
	return changed;
}
