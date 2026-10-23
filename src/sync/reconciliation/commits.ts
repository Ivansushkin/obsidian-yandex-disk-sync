import type {
	PendingMutation,
	SyncIndex,
	SyncOperation,
	SyncResult,
} from "../../types";
import { findErrorCause } from "../../utils/error-utils";
import { logger } from "../../utils/logger";
import {
	IndexEpochMismatchError,
	RemoteIndexTransactionError,
} from "../canonical/errors";
import { canApplyDestructiveFolderMutation } from "../canonical/mutation-rules";
import type { CanonicalCommitProof } from "../canonical/transaction";
import * as syncErrors from "../errors";
import type { Dependencies as ReconciliationDependencies } from "./context";
import { cleanupRejectedUploads } from "./rejected-puts";
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
	| "setBlockedState"
	| "settings"
	| "vaultAdapter"
	| "yandexClient"
>;

/** Save the remote index with optimistic concurrency control. If another device wrote a newer index during this sync, do NOT overwrite it: our physical file transfers already landed and will be reconciled on the next sync once we reload the newer index. Returns null (and records an error on `result`) when the save was skipped due to a concurrent modification. */
export async function saveRemoteIndexOrAbort(
	deps: Dependencies,
	result: SyncResult,
	includePendingMutations = true,
): Promise<CanonicalCommitProof | null> {
	try {
		if (includePendingMutations) {
			deps.indexManager.stagePendingMutations();
		}
		const proof = await deps.indexManager.saveRemoteIndex();
		await cleanupRejectedUploads(deps);
		if (includePendingMutations) {
			deps.indexManager.confirmAppliedMutations();
		}
		if (deps.indexSaveCallback) {
			await deps.indexSaveCallback();
		}
		return proof;
	} catch (e) {
		if (!(e instanceof RemoteIndexTransactionError)) {
			throw e;
		}
		if (e.outcome === "committed") {
			result.replacementCommitted = true;
			await deps.indexSaveCallback?.();
		}
		logger.error(
			e.outcome === "committed"
				? "Canonical index committed; cleanup incomplete"
				: "Canonical index transaction did not commit",
			{
				outcome: e.outcome,
				failedStage: e.stage,
				retryable: e.retryable,
				error: e,
			},
		);
		result.errors.push(
			syncErrors.createSyncError(e, "", "none", `canonical-${e.stage}`),
		);
		result.success = false;
		return null;
	}
}

/** Save the remote index from a single-file (real-time) flow. Unlike the bulk sync path, a concurrent modification here is not surfaced as an error: the file transfer already succeeded, and the next full sync will reload the newer remote index and reconcile. We only log a warning so real-time editing stays non-disruptive. */
export async function saveRemoteIndexBestEffort(
	deps: Dependencies,
	assertLatest?: (index: Readonly<SyncIndex>) => void,
): Promise<CanonicalCommitProof | null> {
	try {
		if (deps.realtimeGuardValidationToken !== undefined) {
			const guard = await deps.getSyncGuardResult(
				false,
				deps.realtimeGuardValidationToken,
			);
			if (guard.blockReason) {
				deps.setBlockedState(guard.blockReason);
				logger.warn(
					"Realtime canonical commit blocked by changed encryption state",
				);
				return null;
			}
		}
		const proof = await deps.indexManager.saveRemoteIndex(assertLatest);
		await cleanupRejectedUploads(deps);
		return proof;
	} catch (e) {
		if (e instanceof RemoteIndexTransactionError) {
			if (
				findErrorCause(
					e,
					(candidate) => candidate instanceof IndexEpochMismatchError,
				)
			) {
				deps.epochReplacementPending = true;
			}
			logger.warn(
				e.outcome === "committed"
					? "Realtime canonical index committed; cleanup incomplete"
					: "Realtime canonical index transaction did not commit",
				{
					outcome: e.outcome,
					failedStage: e.stage,
					error: e,
				},
			);
			return null;
		}
		throw e;
	}
}

/** Commit physical move completion without advancing logical revisions. */
export async function saveMoveCompletionBestEffort(
	deps: Dependencies,
): Promise<boolean> {
	deps.indexManager.beginPhysicalRewriteCommit();
	try {
		return Boolean(await saveRemoteIndexBestEffort(deps));
	} finally {
		deps.indexManager.cancelPhysicalRewriteCommit();
	}
}

/** Commit deletion intent before removing any physical resource. */
export async function commitDeletionIntents(
	deps: Dependencies,
	operations: SyncOperation[],
	result: SyncResult,
): Promise<CanonicalCommitProof | null> {
	const unsafeFolderDeletes = operations.filter((operation) => {
		if (!operation.folderTombstonePath) {
			return false;
		}
		const canonical = deps.indexManager.getRemoteIndex();
		const file = canonical.files[operation.path];
		if (!file || file.deleted) {
			return false;
		}
		const tombstone =
			canonical.folderTombstones[operation.folderTombstonePath];
		return (
			!tombstone ||
			typeof tombstone.mutationSeq !== "number" ||
			!canApplyDestructiveFolderMutation(
				file,
				tombstone.baseRevision,
				tombstone.lastModifiedBy,
				tombstone.mutationSeq,
			)
		);
	});
	if (unsafeFolderDeletes.length > 0) {
		result.errors.push(
			...unsafeFolderDeletes.map((operation) => ({
				path: operation.path,
				operation: operation.action,
				code: "folder-delete-causality-unresolved",
				message:
					"Folder deletion is missing confirmed causal metadata.",
			})),
		);
		return null;
	}
	const mutations = new Map<string, PendingMutation>();
	const pending = deps.indexManager.getPendingMutations();
	for (const operation of operations) {
		const canonical =
			deps.indexManager.getRemoteIndex().files[operation.path];
		if (
			canonical?.deleted === true ||
			operation.causalOrigin === "apply-canonical" ||
			operation.causalOrigin === "physical-repair"
		) {
			continue;
		}
		const existing = [...pending]
			.reverse()
			.find(
				(mutation) =>
					mutation.type === "delete-file" &&
					mutation.path === operation.path,
			);
		const mutation =
			existing ??
			deps.indexManager.enqueueMutation("delete-file", operation.path, {
				baselineSha256:
					deps.indexManager.getLocalIndex().files[operation.path]
						?.sha256,
			});
		if (!existing) {
			pending.push(mutation);
		}
		mutations.set(operation.path, mutation);
	}
	if (mutations.size > 0 && deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}

	for (const operation of operations) {
		const mutation = mutations.get(operation.path);
		const canonical =
			deps.indexManager.getRemoteIndex().files[operation.path];
		if (mutation) {
			deps.indexManager.markRemoteFileDeleted(
				operation.path,
				undefined,
				mutation.baseRevision ?? 0,
				mutation.seq,
			);
			deps.indexManager.markLocalFileDeleted(
				operation.path,
				undefined,
				mutation.seq,
			);
			deps.indexManager.stageMutation(mutation);
		} else if (
			canonical?.deleted !== true &&
			operation.folderTombstonePath
		) {
			deps.indexManager.markRemoteFileDeletedByCanonicalFolder(
				operation.path,
				operation.folderTombstonePath,
			);
		}
		logger.debug("Full deletion intent classified", {
			path: operation.path,
			causalOrigin: operation.causalOrigin,
			mutationSeq: mutation?.seq,
			folderTombstonePath: operation.folderTombstonePath,
		});
		deps.indexManager.enqueuePhysicalAction(
			operation.action === "delete_local"
				? "delete-local"
				: "delete-remote",
			operation.path,
			{
				canonicalRevision:
					deps.indexManager.getRemoteIndex().revision + 1,
				expectedFingerprint: operation.remoteMeta?.remoteFingerprint,
				origin: operation.folderTombstonePath
					? "folder-delete"
					: "exact-delete",
			},
		);
		if (operation.action === "delete_local" && operation.remoteMeta) {
			deps.indexManager.enqueuePhysicalAction(
				"delete-remote",
				operation.path,
				{
					canonicalRevision:
						deps.indexManager.getRemoteIndex().revision + 1,
					expectedFingerprint: operation.remoteMeta.remoteFingerprint,
					origin: operation.folderTombstonePath
						? "folder-delete"
						: "exact-delete",
				},
			);
		}
	}
	if (deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}
	deps.indexManager.updateSyncTime();
	return await saveRemoteIndexOrAbort(deps, result);
}

/** Keep only deletes still authorized by the committed canonical state. */
export function filterCommittedDeletions(
	deps: Dependencies,
	operations: SyncOperation[],
): SyncOperation[] {
	const canonicalFiles = deps.indexManager.getRemoteIndex().files;
	return operations.filter((operation) => {
		const canonical = canonicalFiles[operation.path];
		if (!canonical?.deleted) {
			return false;
		}
		const actionType =
			operation.action === "delete_local"
				? "delete-local"
				: "delete-remote";
		deps.indexManager.enqueuePhysicalAction(actionType, operation.path, {
			canonicalRevision: deps.indexManager.getRemoteIndex().revision,
			expectedChangedRevision: canonical.changedRevision,
		});
		if (operation.action === "delete_local" && operation.remoteMeta) {
			deps.indexManager.enqueuePhysicalAction(
				"delete-remote",
				operation.path,
				{
					canonicalRevision:
						deps.indexManager.getRemoteIndex().revision,
					expectedChangedRevision: canonical.changedRevision,
				},
			);
		}
		return true;
	});
}
