import type {
	PendingMutation,
	SyncIndex,
	YandexDiskSyncSettings,
} from "../../types";
import { logger } from "../../utils/logger";
import { runWithConcurrencySettled } from "../../utils/semaphore";
import * as fileOperations from "./operations";
import { IndexManager } from "../canonical/manager";
import {
	canApplyDestructiveFolderMutation,
	collectFolderDeleteTargets,
} from "../canonical/mutation-rules";
import {
	type FolderMutationOutcome,
	type WatcherCausalContext,
} from "../realtime/rules";
import * as remoteMoves from "./remote-moves";
import type { IndexSaveCallback, SyncGuardResult } from "../contracts";
import * as syncReconciliation from "../reconciliation/commits";
export interface Dependencies {
	indexManager: IndexManager;
	getSyncGuardResult: (
		skipGuard?: boolean,
		validationToken?: string,
		validateThroughExternalBlock?: boolean,
	) => Promise<SyncGuardResult>;
	setBlockedState: (
		reason: string,
		status?: "error" | "migration-required" | "encryption-required",
	) => void;
	realtimeGuardValidationToken: string | undefined;
	settings: YandexDiskSyncSettings;
	indexSaveCallback: IndexSaveCallback | null;
	fileOperations: fileOperations.Dependencies;
	syncReconciliation: syncReconciliation.Dependencies;
	remoteMoves: remoteMoves.Dependencies;
}

/** Reuse a durable folder mutation receipt after restart or allocate it once. */
export function getOrCreateFolderMutation(
	deps: Dependencies,
	type: "delete-folder" | "move",
	path: string,
	targetPath: string | undefined,
	context: WatcherCausalContext,
): PendingMutation {
	const persisted = context.mutationId
		? deps.indexManager
				.getPendingMutations()
				.find(
					(candidate) =>
						candidate.id === context.mutationId &&
						candidate.seq === context.mutationSeq &&
						candidate.type === type,
				)
		: undefined;
	if (persisted) {
		return persisted;
	}
	return deps.indexManager.enqueueMutation(type, path, {
		targetPath,
		resourceKind: type === "move" ? "folder" : undefined,
		epoch: context.epoch,
		baseRevision: context.baseRevision,
	});
}

/** Publish a causal folder tombstone before guarded physical deletion. */
export async function deleteFolderNow(
	deps: Dependencies,
	path: string,
	context: WatcherCausalContext,
	onPrepared?: (outcome: FolderMutationOutcome) => void | Promise<void>,
): Promise<FolderMutationOutcome> {
	const folderPath = path.replace(/\/+$/, "");
	const guard = await deps.getSyncGuardResult(false);
	if (guard.blockReason) {
		deps.setBlockedState(guard.blockReason);
		return {
			status: "retry",
			canonicalRevision: null,
			epoch: context.epoch,
			reason: guard.blockReason,
		};
	}
	deps.realtimeGuardValidationToken = guard.validationToken;
	const canonical = await deps.indexManager.refreshCanonicalForMutation();
	const recoveryActions = context.mutationId
		? deps.indexManager
				.getPendingPhysicalActions()
				.filter(
					(action) =>
						action.parentMutationId === context.mutationId &&
						action.origin === "folder-delete",
				)
		: [];
	if (recoveryActions.length > 0) {
		const results = await runWithConcurrencySettled(
			recoveryActions.map((action) => async () => {
				await fileOperations.deleteRemoteFile(
					deps.fileOperations,
					action.path,
				);
			}),
			Math.min(Math.max(1, deps.settings.maxConcurrency), 4),
		);
		const unresolved = recoveryActions.filter((action) =>
			deps.indexManager
				.getPendingPhysicalActions()
				.some((candidate) => candidate.id === action.id),
		).length;
		if (deps.indexSaveCallback) {
			await deps.indexSaveCallback();
		}
		return {
			status: unresolved > 0 ? "retry" : "completed",
			canonicalRevision: canonical.revision,
			epoch: canonical.epoch,
			mutationId: context.mutationId,
			mutationSeq: context.mutationSeq,
			unresolved,
			reason:
				unresolved > 0 ||
				results.some((result) => result.status === "rejected")
					? "folder-delete-recovery-unresolved"
					: "folder-delete-recovered",
		} satisfies FolderMutationOutcome;
	}
	const targets = collectFolderDeleteTargets(canonical.files, folderPath);
	if (targets.livePaths.length === 0) {
		logger.info("Folder deletion completed without canonical changes", {
			path: folderPath,
			knownDescendants: targets.knownDescendants,
			historicalTombstonesSkipped: targets.historicalTombstonesSkipped,
		});
		return {
			status: "superseded",
			canonicalRevision: canonical.revision,
			epoch: canonical.epoch,
			reason: "folder-has-no-live-canonical-descendants",
		};
	}

	const mutation = getOrCreateFolderMutation(
		deps,
		"delete-folder",
		folderPath,
		undefined,
		context,
	);
	const preparedOutcome: FolderMutationOutcome = {
		status: "retry",
		canonicalRevision: canonical.revision,
		epoch: mutation.epoch,
		mutationId: mutation.id,
		mutationSeq: mutation.seq,
		reason: "mutation-prepared",
	};
	if (onPrepared) {
		await onPrepared(preparedOutcome);
	} else if (deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}

	const acceptedPaths: string[] = [];
	let survivors = 0;
	let ambiguous = 0;
	for (const filePath of targets.livePaths) {
		const metadata = canonical.files[filePath]!;
		const accepted = canApplyDestructiveFolderMutation(
			metadata,
			mutation.baseRevision ?? 0,
			deps.settings.deviceId,
			mutation.seq,
		);
		if (accepted) {
			acceptedPaths.push(filePath);
			continue;
		}
		survivors++;
		if (typeof metadata.mutationSeq !== "number") {
			ambiguous++;
		}
	}
	logger.info("Folder deletion causality classified", {
		path: folderPath,
		mutationId: mutation.id,
		mutationSeq: mutation.seq,
		baseRevision: mutation.baseRevision,
		knownDescendants: targets.knownDescendants,
		liveTargets: targets.livePaths.length,
		historicalTombstonesSkipped: targets.historicalTombstonesSkipped,
		causalTargets: acceptedPaths.length,
		survivors,
		ambiguous,
	});
	if (ambiguous > 0) {
		return {
			status: "retry",
			canonicalRevision: canonical.revision,
			epoch: canonical.epoch,
			mutationId: mutation.id,
			mutationSeq: mutation.seq,
			survivors,
			unresolved: ambiguous,
			reason: "folder-delete-descendant-without-causal-sequence",
		};
	}

	deps.indexManager.markFolderDeleted(
		folderPath,
		mutation.createdAt,
		mutation.baseRevision,
		mutation.seq,
	);
	const physicalActionIds: string[] = [];
	for (const filePath of acceptedPaths) {
		deps.indexManager.markRemoteFileDeleted(
			filePath,
			folderPath,
			mutation.baseRevision ?? 0,
			mutation.seq,
		);
		deps.indexManager.markLocalFileDeleted(
			filePath,
			folderPath,
			mutation.seq,
		);
		const physicalAction = deps.indexManager.enqueuePhysicalAction(
			"delete-remote",
			filePath,
			{
				canonicalRevision:
					deps.indexManager.getRemoteIndex().revision + 1,
				expectedFingerprint:
					canonical.files[filePath]?.remoteFingerprint,
				expectedChangedRevision:
					canonical.files[filePath]?.changedRevision,
				parentMutationId: mutation.id,
				origin: "folder-delete",
			},
		);
		physicalActionIds.push(physicalAction.id);
	}
	deps.indexManager.stageMutation(mutation);
	if (deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}

	if (
		!(await syncReconciliation.saveRemoteIndexBestEffort(
			deps.syncReconciliation,
		))
	) {
		return {
			status: "retry",
			canonicalRevision: canonical.revision,
			epoch: canonical.epoch,
			mutationId: mutation.id,
			mutationSeq: mutation.seq,
			reason: "folder-delete-intent-not-committed",
		};
	}
	deps.indexManager.confirmMutation(mutation.id);
	if (deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}

	const committedPaths = acceptedPaths.filter((filePath) => {
		const meta = deps.indexManager.getRemoteIndex().files[filePath];
		return meta?.deleted === true && meta.deletedByFolder === folderPath;
	});
	const committedPathSet = new Set(committedPaths);
	for (const filePath of acceptedPaths) {
		if (committedPathSet.has(filePath)) {
			continue;
		}
		const action = deps.indexManager.getPendingPhysicalAction(
			"delete-remote",
			filePath,
		);
		if (action?.parentMutationId === mutation.id) {
			deps.indexManager.completePhysicalAction(action.id);
		}
	}
	const deletionResults = await runWithConcurrencySettled(
		committedPaths.map((filePath) => async () => {
			await fileOperations.deleteRemoteFile(
				deps.fileOperations,
				filePath,
			);
		}),
		Math.min(Math.max(1, deps.settings.maxConcurrency || 4), 4),
	);
	await fileOperations.pruneRemoteFolders(
		deps.fileOperations,
		committedPaths,
	);
	if (deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}
	const pendingActionIds = new Set(
		deps.indexManager
			.getPendingPhysicalActions()
			.map((action) => action.id),
	);
	const remainingActions = physicalActionIds.filter((id) =>
		pendingActionIds.has(id),
	).length;
	const failedActions = deletionResults.filter(
		(result) => result.status === "rejected",
	).length;
	const diagnosticContext = {
		path: folderPath,
		canonicalRevision: deps.indexManager.getRemoteIndex().revision,
		liveTargets: targets.livePaths.length,
		committedTargets: committedPaths.length,
		survivors,
		confirmedActions: physicalActionIds.length - remainingActions,
		remainingActions,
		failedActions,
	};
	if (
		remainingActions > 0 ||
		failedActions > 0 ||
		committedPaths.length !== acceptedPaths.length
	) {
		logger.warn(
			"Folder deletion completed with pending physical actions",
			diagnosticContext,
		);
		return {
			status: "retry",
			canonicalRevision: deps.indexManager.getRemoteIndex().revision,
			epoch: deps.indexManager.getRemoteIndex().epoch,
			mutationId: mutation.id,
			mutationSeq: mutation.seq,
			survivors,
			unresolved: Math.max(
				remainingActions + failedActions,
				acceptedPaths.length - committedPaths.length,
			),
			reason: "folder-delete-physical-work-unresolved",
		};
	}
	logger.info("Folder deletion completed", diagnosticContext);
	return {
		status: "completed",
		canonicalRevision: deps.indexManager.getRemoteIndex().revision,
		epoch: deps.indexManager.getRemoteIndex().epoch,
		mutationId: mutation.id,
		mutationSeq: mutation.seq,
		survivors,
	};
}

/** Plan causal descendants without allocating mutations or changing either index. */
export function planFolderMove(
	canonical: SyncIndex,
	deviceId: string,
	oldPath: string,
	newPath: string,
	baseRevision: number,
	mutationSeq: number,
) {
	const oldPrefix = `${oldPath.replace(/\/+$/, "")}/`;
	const newPrefix = `${newPath.replace(/\/+$/, "")}/`;
	const targetHashes = new Map<string, string>();
	const plannedPairs: Array<{ fromPath: string; toPath: string }> = [];
	let survivors = 0;
	let conflicts = 0;
	let ambiguous = 0;
	for (const [filePath, meta] of Object.entries({
		...canonical.files,
	})) {
		if (!filePath.startsWith(oldPrefix) || meta.deleted) {
			continue;
		}
		const target = `${newPrefix}${filePath.slice(oldPrefix.length)}`;
		if (
			!canApplyDestructiveFolderMutation(
				meta,
				baseRevision,
				deviceId,
				mutationSeq,
			)
		) {
			survivors++;
			if (typeof meta.mutationSeq !== "number") {
				ambiguous++;
			}
			continue;
		}
		const existingTarget = canonical.files[target];
		if (
			existingTarget &&
			!existingTarget.deleted &&
			existingTarget.sha256 !== meta.sha256
		) {
			conflicts++;
			continue;
		}
		targetHashes.set(target, meta.sha256);
		plannedPairs.push({ fromPath: filePath, toPath: target });
	}
	return { targetHashes, plannedPairs, survivors, conflicts, ambiguous };
}

/** Stage one planned folder move using its original causal snapshot. */
export function stageFolderMove(
	index: IndexManager,
	canonical: SyncIndex,
	oldPath: string,
	newPath: string,
	mutation: PendingMutation,
	plannedPairs: ReturnType<typeof planFolderMove>["plannedPairs"],
): void {
	const localIndex = index.getLocalIndex();
	const oldPrefix = `${oldPath.replace(/\/+$/, "")}/`;
	const newPrefix = `${newPath.replace(/\/+$/, "")}/`;
	index.recordMove(
		mutation.id,
		oldPath,
		newPath,
		"folder",
		mutation.baseRevision ?? index.getRemoteIndex().revision,
		mutation.seq,
	);
	index.markFolderDeleted(
		oldPath,
		mutation.createdAt,
		mutation.baseRevision,
		mutation.seq,
	);
	for (const { fromPath: filePath, toPath: target } of plannedPairs) {
		const meta = canonical.files[filePath]!;
		index.markRemoteFileDeleted(
			filePath,
			oldPath,
			mutation.baseRevision ?? 0,
			mutation.seq,
		);
		index.updateRemoteFile(target, {
			...meta,
			path: target,
			deleted: false,
			deletedAt: undefined,
			deletedByFolder: undefined,
			mutationSeq: mutation.seq,
		});
	}
	const plannedSourcePaths = new Set(
		plannedPairs.map((pair) => pair.fromPath),
	);
	for (const [filePath, meta] of Object.entries({
		...localIndex.files,
	})) {
		if (!filePath.startsWith(oldPrefix) || meta.deleted) {
			continue;
		}
		if (!plannedSourcePaths.has(filePath)) {
			continue;
		}
		index.markLocalFileDeleted(filePath, oldPath, mutation.seq);
		index.updateLocalFile(
			`${newPrefix}${filePath.slice(oldPrefix.length)}`,
			{
				...meta,
				path: `${newPrefix}${filePath.slice(oldPrefix.length)}`,
				deleted: false,
				deletedAt: undefined,
				deletedByFolder: undefined,
				mutationSeq: mutation.seq,
			},
		);
	}
	index.stageMutation(mutation);
}

/** Prepare one folder mutation and recover its descendant moves. */
export async function renameFolderNow(
	deps: Dependencies,
	oldPath: string,
	newPath: string,
	context: WatcherCausalContext,
	onPrepared?: (outcome: FolderMutationOutcome) => void | Promise<void>,
): Promise<FolderMutationOutcome> {
	const guard = await deps.getSyncGuardResult(false);
	if (guard.blockReason) {
		deps.setBlockedState(guard.blockReason);
		return {
			status: "retry",
			canonicalRevision: null,
			epoch: context.epoch,
			reason: guard.blockReason,
		};
	}
	deps.realtimeGuardValidationToken = guard.validationToken;
	const canonical = await deps.indexManager.refreshCanonicalForMutation();
	const pendingMove = context.mutationId
		? canonical.moves[context.mutationId]
		: undefined;
	if (pendingMove?.pending && pendingMove.kind === "folder") {
		const recovery = await syncReconciliation.resumePendingFolderMove(
			deps.syncReconciliation,
			pendingMove,
		);
		if (recovery.unresolved > 0) {
			if (deps.indexSaveCallback) {
				await deps.indexSaveCallback();
			}
			return {
				status: "retry",
				canonicalRevision: canonical.revision,
				epoch: canonical.epoch,
				mutationId: pendingMove.id,
				mutationSeq: pendingMove.mutationSeq,
				unresolved: recovery.unresolved,
				reason: "folder-move-recovery-unresolved",
			};
		}
		deps.indexManager.completeMove(pendingMove.id);
		if (
			!(await syncReconciliation.saveMoveCompletionBestEffort(
				deps.syncReconciliation,
			))
		) {
			return {
				status: "retry",
				canonicalRevision: canonical.revision,
				epoch: canonical.epoch,
				mutationId: pendingMove.id,
				mutationSeq: pendingMove.mutationSeq,
				reason: "folder-move-recovery-completion-not-committed",
			};
		}
		deps.indexManager.confirmMutation(pendingMove.id);
		if (deps.indexSaveCallback) {
			await deps.indexSaveCallback();
		}
		return {
			status: "completed",
			canonicalRevision: deps.indexManager.getRemoteIndex().revision,
			epoch: deps.indexManager.getRemoteIndex().epoch,
			mutationId: pendingMove.id,
			mutationSeq: pendingMove.mutationSeq,
			reason: "folder-move-recovered",
		};
	}
	const mutation = getOrCreateFolderMutation(
		deps,
		"move",
		oldPath,
		newPath,
		context,
	);
	const preparedOutcome: FolderMutationOutcome = {
		status: "retry",
		canonicalRevision: canonical.revision,
		epoch: mutation.epoch,
		mutationId: mutation.id,
		mutationSeq: mutation.seq,
		reason: "mutation-prepared",
	};
	if (onPrepared) {
		await onPrepared(preparedOutcome);
	} else if (deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}
	const id = mutation.id;
	const oldPrefix = `${oldPath.replace(/\/+$/, "")}/`;
	const remoteIndex = deps.indexManager.getRemoteIndex();
	const localIndex = deps.indexManager.getLocalIndex();
	const hasIndexedDescendants =
		Object.entries(remoteIndex.files).some(
			([filePath, meta]) =>
				filePath.startsWith(oldPrefix) && !meta.deleted,
		) ||
		Object.entries(localIndex.files).some(
			([filePath, meta]) =>
				filePath.startsWith(oldPrefix) && !meta.deleted,
		);
	if (!hasIndexedDescendants) {
		deps.indexManager.discardMutation(mutation.id);
		if (deps.indexSaveCallback) {
			await deps.indexSaveCallback();
		}
		return {
			status: "superseded",
			canonicalRevision: canonical.revision,
			epoch: canonical.epoch,
			mutationId: mutation.id,
			mutationSeq: mutation.seq,
			reason: "folder-has-no-causal-descendants",
		};
	}

	const { targetHashes, plannedPairs, survivors, conflicts, ambiguous } =
		planFolderMove(
			canonical,
			deps.settings.deviceId,
			oldPath,
			newPath,
			mutation.baseRevision ?? 0,
			mutation.seq,
		);
	logger.info("Folder move causality classified", {
		mutationId: mutation.id,
		mutationSeq: mutation.seq,
		baseRevision: mutation.baseRevision,
		oldPath,
		newPath,
		causalPairs: plannedPairs.length,
		survivors,
		conflicts,
		ambiguous,
	});
	if (conflicts > 0 || ambiguous > 0) {
		return {
			status: "retry",
			canonicalRevision: canonical.revision,
			epoch: canonical.epoch,
			mutationId: mutation.id,
			mutationSeq: mutation.seq,
			conflicts,
			survivors,
			unresolved: conflicts + ambiguous,
			requiresUserAction: conflicts > 0,
			reason:
				conflicts > 0
					? "folder-target-conflict"
					: "folder-move-descendant-without-causal-sequence",
		};
	}

	stageFolderMove(
		deps.indexManager,
		canonical,
		oldPath,
		newPath,
		mutation,
		plannedPairs,
	);
	if (
		!(await syncReconciliation.saveRemoteIndexBestEffort(
			deps.syncReconciliation,
		))
	) {
		return {
			status: "retry",
			canonicalRevision: canonical.revision,
			epoch: canonical.epoch,
			mutationId: mutation.id,
			mutationSeq: mutation.seq,
			reason: "folder-move-intent-not-committed",
		};
	}
	const committedPairs = plannedPairs.filter(({ fromPath, toPath }) => {
		const source = deps.indexManager.getRemoteIndex().files[fromPath];
		const target = deps.indexManager.getRemoteIndex().files[toPath];
		return (
			source?.deleted === true &&
			source.mutationSeq === mutation.seq &&
			target?.deleted !== true &&
			target?.mutationSeq === mutation.seq &&
			target.sha256 === targetHashes.get(toPath)
		);
	});
	const moveResults = await runWithConcurrencySettled(
		committedPairs.map(({ fromPath, toPath }) => async () => {
			const source = canonical.files[fromPath];
			const action = deps.indexManager.enqueuePhysicalAction(
				"move-remote",
				fromPath,
				{
					targetPath: toPath,
					parentMutationId: mutation.id,
					canonicalRevision:
						deps.indexManager.getRemoteIndex().revision,
					expectedFingerprint: source?.remoteFingerprint,
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
	const unresolved =
		plannedPairs.length -
		committedPairs.length +
		moveResults.filter((result) => result.status === "rejected").length;
	if (unresolved > 0) {
		if (deps.indexSaveCallback) {
			await deps.indexSaveCallback();
		}
		return {
			status: "retry",
			canonicalRevision: deps.indexManager.getRemoteIndex().revision,
			epoch: deps.indexManager.getRemoteIndex().epoch,
			mutationId: mutation.id,
			mutationSeq: mutation.seq,
			conflicts,
			survivors,
			unresolved,
			reason: "folder-move-physical-work-unresolved",
		};
	}
	deps.indexManager.completeMove(id);
	if (
		!(await syncReconciliation.saveMoveCompletionBestEffort(
			deps.syncReconciliation,
		))
	) {
		return {
			status: "retry",
			canonicalRevision: deps.indexManager.getRemoteIndex().revision,
			epoch: deps.indexManager.getRemoteIndex().epoch,
			mutationId: mutation.id,
			mutationSeq: mutation.seq,
			reason: "folder-move-completion-not-committed",
		};
	}
	deps.indexManager.confirmMutation(mutation.id);
	if (deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}
	await fileOperations.pruneRemoteFolders(
		deps.fileOperations,
		committedPairs.map((pair) => pair.fromPath),
	);
	return {
		status: "completed",
		canonicalRevision: deps.indexManager.getRemoteIndex().revision,
		epoch: deps.indexManager.getRemoteIndex().epoch,
		mutationId: mutation.id,
		mutationSeq: mutation.seq,
		conflicts,
		survivors,
	};
}
