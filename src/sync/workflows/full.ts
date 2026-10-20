import { YandexDiskClient } from "../../api/yandex-client";
import { t } from "../../i18n";
import { classifySyncError } from "../errors";
import type {
	PendingMutation,
	SyncError,
	SyncOperation,
	SyncPhase,
	SyncProgress,
	SyncResult,
	YandexDiskSyncSettings,
} from "../../types";
import { logger, shortenDiagnosticValue } from "../../utils/logger";
import { ConflictResolver } from "../reconciliation/conflicts";
import * as fileOperations from "../files/operations";
import { IndexManager } from "../canonical/manager";
import type {
	IndexSaveCallback,
	SyncGuardResult,
	SyncRunOptions,
} from "../contracts";
import * as syncReconciliation from "../reconciliation/commits";
import { receiveInitialRemoteState } from "./initial-receive";
export interface Dependencies {
	indexManager: IndexManager;
	settings: YandexDiskSyncSettings;
	setSyncPhase: (
		phase: SyncPhase,
		currentOperation?: string,
		progress?: SyncProgress,
	) => void;
	yandexClient: YandexDiskClient;
	indexSaveCallback: IndexSaveCallback | null;
	conflictResolver: ConflictResolver;
	reportProgress: (processedOps: number, totalOps: number) => void;
	isPaused: boolean;
	getSyncGuardResult: (
		skipGuard?: boolean,
		validationToken?: string,
		validateThroughExternalBlock?: boolean,
	) => Promise<SyncGuardResult>;
	fileOperations: fileOperations.Dependencies;
	syncReconciliation: syncReconciliation.Dependencies;
}
export interface FullSyncContext {
	adoptionSnapshot: ReturnType<
		IndexManager["captureLocalCausalState"]
	> | null;
	adoptedEpoch: string | null;
}

/** Settle durable puts against the logical state selected by full sync.  Matching puts only need their device watermark. Puts superseded by the reconciled state become local no-ops so staging cannot alter canonical file metadata. */
export function settleFullSyncPendingPuts(deps: Dependencies): {
	pendingWatermarks: number;
	matchingPuts: number;
	noopPuts: number;
} {
	let matchingPuts = 0;
	let noopPuts = 0;
	const pending = deps.indexManager.getPendingMutations();
	const canonicalFiles = deps.indexManager.getRemoteIndex().files;
	for (const mutation of pending) {
		if (mutation.type === "noop") {
			continue;
		}
		if (mutation.type !== "put") {
			continue;
		}
		const canonical = canonicalFiles[mutation.path];
		if (
			canonical &&
			!canonical.deleted &&
			mutation.sha256 !== undefined &&
			canonical.sha256 === mutation.sha256
		) {
			matchingPuts++;
			continue;
		}
		if (deps.indexManager.replacePendingPutWithNoop(mutation.id)) {
			noopPuts++;
		}
	}
	const pendingWatermarks = deps.indexManager
		.getPendingMutations()
		.filter(
			(mutation) => mutation.type === "put" || mutation.type === "noop",
		).length;
	logger[pendingWatermarks > 0 ? "info" : "debug"](
		"Full sync pending put settlement prepared",
		{
			pendingWatermarks,
			matchingPuts,
			noopPuts,
		},
	);
	return {
		pendingWatermarks,
		matchingPuts,
		noopPuts,
	};
}

/** Allocate causal identities for local uploads discovered by a full scan. */
export function prepareFullUploadMutations(
	deps: Dependencies,
	uploads: SyncOperation[],
): PendingMutation[] {
	const pending = deps.indexManager.getPendingMutations();
	return uploads.flatMap((operation) => {
		const sha256 = operation.localMeta?.sha256;
		if (!sha256) {
			return [];
		}
		const existing = [...pending]
			.reverse()
			.find(
				(mutation) =>
					mutation.type === "put" &&
					mutation.path === operation.path &&
					mutation.sha256 === sha256,
			);
		if (existing) {
			return [existing];
		}
		const mutation = deps.indexManager.enqueueMutation(
			"put",
			operation.path,
			{
				sha256,
				baselineSha256:
					deps.indexManager.getLocalIndex().files[operation.path]
						?.sha256,
			},
		);
		pending.push(mutation);
		return [mutation];
	});
}

/** Stamp uploaded full-sync entries with their allocated device sequence. */
export function stampFullUploadMutations(
	deps: Dependencies,
	mutations: PendingMutation[],
): void {
	for (const mutation of mutations) {
		const remote = deps.indexManager.getRemoteIndex().files[mutation.path];
		if (!remote || remote.deleted || remote.sha256 !== mutation.sha256) {
			continue;
		}
		remote.mutationSeq = mutation.seq;
		remote.lastModifiedBy = deps.settings.deviceId;
		const local = deps.indexManager.getLocalIndex().files[mutation.path];
		if (local && !local.deleted && local.sha256 === remote.sha256) {
			local.mutationSeq = mutation.seq;
			local.lastModifiedBy = deps.settings.deviceId;
		}
	}
}

/** Execute bulk uploads and stamp server-owned metadata with one tree read. */
export async function executeBulkUploads(
	deps: Dependencies,
	uploads: SyncOperation[],
	result: SyncResult,
	onProgress: (completed: number) => void,
	failureMessage: string,
): Promise<boolean> {
	if (uploads.length === 0) {
		return false;
	}
	deps.setSyncPhase("applying", t("status.op.uploading_files"));
	const outcomes = await fileOperations.executeOperationsParallel(
		deps.fileOperations,
		uploads,
		onProgress,
	);
	result.uploaded = outcomes.succeeded;
	result.errors.push(...outcomes.errors);
	if (outcomes.succeeded === 0) {
		return false;
	}
	try {
		const liveRemote = await deps.indexManager.getRemoteFiles();
		return deps.indexManager.applyServerMtimes(liveRemote);
	} catch (error) {
		logger.warn(`${failureMessage}; entries keep fallback metadata`, {
			error,
		});
		return false;
	}
}

/** Reconcile one canonical snapshot, preserving causal adoption on failure. */
export async function reconcileFullSync(
	deps: Dependencies,
	options: SyncRunOptions | undefined,
	adoption: FullSyncContext,
	result: SyncResult,
	startTime: number,
	validationToken?: string,
): Promise<void> {
	deps.yandexClient.clearFolderCache();
	// 1. Ensure remote folder exists
	deps.setSyncPhase("checking-remote");
	if (!options?.startup && !(await deps.indexManager.remotePathExists())) {
		await deps.indexManager.createRemotePath();
	}

	// 2. Load remote index
	deps.setSyncPhase("loading-index");
	await deps.indexManager.loadRemoteIndex(false, options?.startup, true);
	if (options?.requireStableCanonical && deps.indexManager.getMaintenance()) {
		throw new Error(
			"Encryption preflight requires a stable canonical index",
		);
	}
	const initialCanonical = deps.indexManager.getRemoteIndex();
	if (
		deps.indexManager.isInitialRemoteReceivePending?.() &&
		!options?.skipEncryptionGuard &&
		!options?.skipMaintenanceGuard &&
		!initialCanonical.maintenance &&
		!(initialCanonical.appliedMutationSeq[deps.settings.deviceId] ?? 0)
	) {
		if (
			Object.values(initialCanonical.moves).some((move) => move.pending)
		) {
			throw new Error(
				"Initial remote receive waits for pending canonical moves to finish",
			);
		}
		await receiveInitialRemoteState(deps, result, validationToken);
		if (result.errors.length > 0) {
			return;
		}
	}
	const localStateBeforeAdoption = deps.indexManager.getLocalIndex();
	const canonicalEpoch = deps.indexManager.getRemoteIndex().epoch;
	const replacesObservedEpoch =
		localStateBeforeAdoption.observedEpoch !== null &&
		localStateBeforeAdoption.observedEpoch !== canonicalEpoch;
	const migratesLegacyBaseline =
		localStateBeforeAdoption.observedEpoch === null &&
		Object.keys(localStateBeforeAdoption.files).length > 0;
	if (replacesObservedEpoch || migratesLegacyBaseline) {
		adoption.adoptionSnapshot = deps.indexManager.captureLocalCausalState();
		adoption.adoptedEpoch = canonicalEpoch;
		deps.indexManager.beginEpochAdoption(canonicalEpoch);
		result.epochAdopted = true;
		logger.info("Replacement canonical epoch will be reconciled", {
			previousEpoch: shortenDiagnosticValue(
				localStateBeforeAdoption.observedEpoch,
			),
			canonicalEpoch: shortenDiagnosticValue(canonicalEpoch),
			legacyBaseline: migratesLegacyBaseline,
			baselineFiles: Object.keys(adoption.adoptionSnapshot.state.files)
				.length,
		});
	}
	if (
		localStateBeforeAdoption.observedEpoch === null &&
		Object.keys(localStateBeforeAdoption.files).length === 0 &&
		Object.keys(localStateBeforeAdoption.folderTombstones).length === 0 &&
		deps.indexManager.getPendingMutations().length === 0 &&
		deps.indexManager.getPendingPhysicalActions().length === 0
	) {
		// Bind initial durable work to its epoch without claiming a reconciled baseline.
		localStateBeforeAdoption.observedEpoch = canonicalEpoch;
		if (deps.indexSaveCallback) {
			await deps.indexSaveCallback();
		}
	}
	const hadPendingCausalWork =
		deps.indexManager.getPendingMutations().length > 0 ||
		deps.indexManager.getPendingPhysicalActions().length > 0 ||
		Object.keys(deps.indexManager.getRemoteIndex().moves).length > 0;
	if (
		!adoption.adoptionSnapshot &&
		deps.indexManager.replayPendingMutations()
	) {
		if (deps.indexSaveCallback) {
			await deps.indexSaveCallback();
		}
	}
	fileOperations.assertPortableLocalTree(
		deps.fileOperations,
		Object.entries(deps.indexManager.getRemoteIndex().files)
			.filter(([, metadata]) => !metadata.deleted)
			.map(([path]) => path),
	);
	if (syncReconciliation.hasPendingPhysicalWork(deps.syncReconciliation)) {
		deps.setSyncPhase("cleanup");
	}
	await syncReconciliation.resumePendingMoves(
		deps.syncReconciliation,
		result,
		true,
	);
	await syncReconciliation.resumePendingPhysicalActions(
		deps.syncReconciliation,
		result,
	);
	if (result.errors.length > 0) {
		return;
	}

	// 3. Build local index
	deps.setSyncPhase("scanning-local");
	const localFiles = await deps.indexManager.buildLocalIndex();

	// 4. Get remote files list
	deps.setSyncPhase("scanning-remote");
	const remoteFiles = await deps.indexManager.getRemoteFiles();
	const verifiedMetadataChanged =
		await syncReconciliation.verifyRemoteContentCandidates(
			deps.syncReconciliation,
			localFiles,
			remoteFiles,
		);
	fileOperations.assertPortableLocalTree(deps.fileOperations, [
		...localFiles.keys(),
		...remoteFiles.keys(),
	]);
	if (
		syncReconciliation.reconcileCompletedPhysicalActions(
			deps.syncReconciliation,
			localFiles,
			remoteFiles,
		) &&
		deps.indexSaveCallback
	) {
		await deps.indexSaveCallback();
	}

	// 5. Determine operations
	deps.setSyncPhase("analyzing");
	const localIndex = deps.indexManager.getLocalIndex();
	const remoteIndex = deps.indexManager.getRemoteIndex();

	let operations = adoption.adoptionSnapshot
		? deps.conflictResolver.determineEpochAdoptionOperations(
				localFiles,
				remoteFiles,
				adoption.adoptionSnapshot.state.files,
				remoteIndex.files,
			)
		: deps.conflictResolver.determineOperations(
				localFiles,
				remoteFiles,
				localIndex.files,
				remoteIndex.files,
				startTime,
				remoteIndex.folderTombstones,
				deps.indexManager.getPendingLocalDeletePaths(),
			);
	if (
		!adoption.adoptionSnapshot &&
		!hadPendingCausalWork &&
		!remoteIndex.maintenance
	) {
		operations = operations.filter((operation) => {
			const { path } = operation;
			if (
				operation.action !== "delete_local" ||
				!remoteIndex.files[path]?.deleted ||
				localFiles.has(path) ||
				remoteFiles.has(path)
			) {
				return true;
			}
			if (
				deps.fileOperations.vaultAdapter.fileExists(path) ||
				deps.fileOperations.vaultAdapter.folderExists(path)
			) {
				throw new Error(
					"Local object exists outside the scanned snapshot; reconciliation required",
				);
			}
			// Absence already matches the tombstone; there is no physical work to stage.
			return false;
		});
	}
	for (const operation of operations) {
		if (operation.action !== "conflict") {
			continue;
		}
		const baseline = (adoption.adoptionSnapshot?.state.files ??
			localIndex.files)[operation.path];
		const canonical = remoteIndex.files[operation.path];
		logger.warn("Conflict classification", {
			path: operation.path,
			reason: operation.reason,
			epochAdoption: Boolean(adoption.adoptionSnapshot),
			baselinePresent: Boolean(baseline),
			baselineLive: Boolean(baseline && !baseline.deleted),
			localMatchesBaseline: baseline
				? operation.localMeta?.sha256 === baseline.sha256
				: null,
			canonicalMatchesBaseline: baseline
				? canonical?.sha256 === baseline.sha256
				: null,
			localMatchesCanonical: canonical
				? operation.localMeta?.sha256 === canonical.sha256
				: null,
		});
	}
	const pendingMutationsBeforeBaselines =
		deps.indexManager.getPendingMutations().length;
	operations = operations.map((operation) =>
		operation.action === "upload"
			? { ...operation, remoteMeta: remoteFiles.get(operation.path) }
			: operation,
	);
	const baselinesChanged = syncReconciliation.recordConfirmedBaselines(
		deps.syncReconciliation,
		localFiles,
		remoteFiles,
		operations,
	);
	if (
		deps.indexManager.getPendingMutations().length >
			pendingMutationsBeforeBaselines &&
		deps.indexSaveCallback
	) {
		await deps.indexSaveCallback();
	}

	logger.info(`Determined ${operations.length} synchronization operations`);

	// 6. Preflight: Create all necessary folders
	await fileOperations.prepareOperationFolders(
		deps.fileOperations,
		operations,
	);

	// 7. Execute operations in parallel by type
	const totalOps = operations.length;
	let processedOps = 0;

	const uploads = operations.filter((op) => op.action === "upload");
	const downloads = operations.filter((op) => op.action === "download");
	logger.debug("Download batch planned", {
		count: downloads.length,
		expectedBytes: downloads.reduce(
			(sum, operation) => sum + (operation.remoteMeta?.size ?? 0),
			0,
		),
		largestFileBytes: downloads.reduce(
			(size, operation) =>
				Math.max(size, operation.remoteMeta?.size ?? 0),
			0,
		),
	});
	let deletes = operations.filter(
		(op) => op.action === "delete_remote" || op.action === "delete_local",
	);
	const conflicts = operations.filter((op) => op.action === "conflict");
	const fullUploadMutations = prepareFullUploadMutations(deps, uploads);
	if (fullUploadMutations.length > 0 && deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}
	let indexCommittedBeforeDeletes = false;

	const mtimeStamped = await executeBulkUploads(
		deps,
		uploads,
		result,
		(completed) => {
			processedOps = completed;
			deps.reportProgress(processedOps, totalOps);
		},
		"Batch server metadata re-read after uploads failed",
	);
	stampFullUploadMutations(deps, fullUploadMutations);
	if (result.errors.length > 0) {
		if (deps.indexSaveCallback) {
			await deps.indexSaveCallback();
		}
		return;
	}

	if (downloads.length > 0) {
		deps.setSyncPhase("applying", t("status.op.downloading_files"), {
			completed: uploads.length,
			total: totalOps,
		});
		const downloadResults = await fileOperations.executeOperationsParallel(
			deps.fileOperations,
			downloads,
			(completed) => {
				processedOps = uploads.length + completed;
				deps.reportProgress(processedOps, totalOps);
			},
		);
		result.downloaded = downloadResults.succeeded;
		result.errors.push(...downloadResults.errors);
		if (downloadResults.errors.length > 0) {
			await deps.indexSaveCallback?.();
			return;
		}
	}

	const mutationSettlement = settleFullSyncPendingPuts(deps);
	if (mutationSettlement.noopPuts > 0 && deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}

	if (deletes.length > 0) {
		deps.setSyncPhase("applying", t("status.op.deleting_files"));
		const deletionCommitProof =
			await syncReconciliation.commitDeletionIntents(
				deps.syncReconciliation,
				deletes,
				result,
			);
		if (!deletionCommitProof) {
			return;
		}
		await syncReconciliation.repairMissingAcceptedUploads(
			deps.syncReconciliation,
			uploads.map((operation) => operation.path),
			deletionCommitProof,
			validationToken,
		);
		indexCommittedBeforeDeletes = true;
		deletes = syncReconciliation.filterCommittedDeletions(
			deps.syncReconciliation,
			deletes,
		);
		const deleteResults = await fileOperations.executeOperationsParallel(
			deps.fileOperations,
			deletes,
			(completed) => {
				processedOps = uploads.length + downloads.length + completed;
				deps.reportProgress(processedOps, totalOps);
			},
		);
		result.deleted = deleteResults.succeeded;
		result.errors.push(...deleteResults.errors);
		if (deps.indexSaveCallback) {
			await deps.indexSaveCallback();
		}
	}

	// Prune remote folders that became empty after the delete group.
	// Done centrally (once) rather than per-file to avoid the parallel
	// race where each delete sees the others' targets as still-present
	// and skips pruning. Only delete_remote operations affect remote
	// folders; delete_local is irrelevant here.
	const deletedRemotePaths = deletes
		.filter((op) => op.action === "delete_remote")
		.map((op) => op.path);
	if (deletedRemotePaths.length > 0) {
		try {
			await fileOperations.pruneRemoteFolders(
				deps.fileOperations,
				deletedRemotePaths,
			);
		} catch (e) {
			logger.warn("Failed to prune remote folders after deletes:", {
				error: e,
			});
		}
	}

	if (conflicts.length > 0) {
		await resolveFullConflicts(
			deps,
			conflicts,
			result,
			processedOps,
			totalOps,
		);
	}

	// 8. Save indexes
	deps.setSyncPhase("saving-index");

	// Tombstones are intentionally retained; Force sync is the only
	// operation that compacts causal deletion history.
	const hadOperations =
		result.uploaded > 0 ||
		result.downloaded > 0 ||
		result.deleted > 0 ||
		result.conflicts > 0;
	const tombstonesRemoved = deps.indexManager.cleanupDeletedFiles();

	// Skip the remote index write when nothing changed during this
	// sync: no file operations, no batch mtime stamping, and no
	// tombstone changes. This avoids unnecessary API calls, 409
	// "folder exists" noise, and reduces the window for concurrent-
	// index conflicts between devices. The local index is still
	// persisted by the caller via indexSaveCallback.
	const indexDirty =
		verifiedMetadataChanged ||
		hadOperations ||
		mtimeStamped ||
		tombstonesRemoved ||
		baselinesChanged ||
		mutationSettlement.pendingWatermarks > 0;
	const strictNoOp = !indexDirty && !hadPendingCausalWork;
	if (!strictNoOp) {
		const guard = await deps.getSyncGuardResult(
			options?.skipEncryptionGuard,
			validationToken,
			options?.validateThroughExternalEncryptionBlock,
		);
		if (guard.blockReason) {
			result.errors.push({
				path: "",
				operation: "none",
				code: "encryption-state-changed",
				message: `Sync aborted before saving: ${guard.blockReason}`,
			});
			return;
		}
		logger.debug("Encryption guard validation completed", {
			validation: "unchanged",
		});
	} else {
		logger.debug("Encryption guard validation skipped", {
			validation: "strict-noop",
		});
	}
	if (!indexDirty) {
		logger.debug(
			"[SyncEngine] No changes detected, skipping remote index save",
		);
		if (deps.indexSaveCallback) {
			await deps.indexSaveCallback();
		}
		if (
			syncReconciliation.hasPendingPhysicalWork(deps.syncReconciliation)
		) {
			deps.setSyncPhase("cleanup");
		}
		await syncReconciliation.resumePendingPhysicalActions(
			deps.syncReconciliation,
			result,
		);
		await syncReconciliation.resumePendingMoves(
			deps.syncReconciliation,
			result,
			true,
		);
		return;
	}
	if (indexCommittedBeforeDeletes && conflicts.length === 0) {
		if (
			syncReconciliation.hasPendingPhysicalWork(deps.syncReconciliation)
		) {
			deps.setSyncPhase("cleanup");
		}
		await syncReconciliation.resumePendingPhysicalActions(
			deps.syncReconciliation,
			result,
		);
		await syncReconciliation.resumePendingMoves(
			deps.syncReconciliation,
			result,
			true,
		);
		return;
	}

	deps.indexManager.updateSyncTime();
	const commitProof = await syncReconciliation.saveRemoteIndexOrAbort(
		deps.syncReconciliation,
		result,
	);
	if (!commitProof) {
		return;
	}
	await syncReconciliation.repairMissingAcceptedUploads(
		deps.syncReconciliation,
		uploads.map((operation) => operation.path),
		commitProof,
		validationToken,
	);
	if (syncReconciliation.hasPendingPhysicalWork(deps.syncReconciliation)) {
		deps.setSyncPhase("cleanup");
	}
	await syncReconciliation.resumePendingPhysicalActions(
		deps.syncReconciliation,
		result,
	);
	await syncReconciliation.resumePendingMoves(
		deps.syncReconciliation,
		result,
		true,
	);
}

/** Restore the previous causal state when replacement adoption did not finish. */
export function restoreAdoptionSnapshot(
	indexManager: IndexManager,
	snapshot: NonNullable<FullSyncContext["adoptionSnapshot"]>,
): void {
	indexManager.restoreLocalCausalState(snapshot);
}

/** Report adoption only after lifecycle finalization has determined success. */
export function reportEpochAdoption(
	adoption: FullSyncContext,
	result: SyncResult,
): void {
	if (!adoption.adoptedEpoch) {
		return;
	}
	result.epochAdopted = result.success;
	logger[result.success ? "info" : "warn"](
		result.success
			? "Replacement canonical epoch reconciled"
			: "Replacement canonical epoch reconciliation deferred",
		{
			epoch: shortenDiagnosticValue(adoption.adoptedEpoch),
			success: result.success,
			conflicts: result.conflicts,
		},
	);
}

/** Resolve the final conflict group without changing earlier transfer receipts. */
async function resolveFullConflicts(
	deps: Dependencies,
	conflicts: SyncOperation[],
	result: SyncResult,
	processedOps: number,
	totalOps: number,
): Promise<void> {
	deps.setSyncPhase("applying", t("status.op.resolving_conflicts"));
	for (const op of conflicts) {
		if (deps.isPaused) {
			result.success = false;
			result.errors.push({
				path: "",
				operation: "none",
				message: "Synchronization interrupted",
			});
			break;
		}

		deps.setSyncPhase(
			"applying",
			t("status.op.conflict", { path: op.path }),
			{ completed: processedOps, total: totalOps },
		);

		try {
			await syncReconciliation.handleConflict(
				deps.syncReconciliation,
				op,
			);
			result.conflicts++;
		} catch (e) {
			const error: SyncError = {
				path: op.path,
				operation: op.action,
				message: (e as Error).message,
				code: e instanceof Error ? classifySyncError(e) : undefined,
			};
			result.errors.push(error);
			logger.error(`Error resolving conflict for ${op.path}:`, {
				error: e,
			});
		} finally {
			processedOps++;
			deps.reportProgress(processedOps, totalOps);
		}
	}
}
