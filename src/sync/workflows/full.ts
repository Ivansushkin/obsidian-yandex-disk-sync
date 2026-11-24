import {
	collectReplayedDeletions,
	planFullRecreations,
	prepareRecreationVersions,
	commitRecreatedFiles,
	type ReplayedExactDeletion,
	type FullRecreation,
} from "../reconciliation/recreations";
import { receiveEncryptionReplacement } from "./encryption-adoption";
import { YandexDiskClient } from "../../api/yandex-client";
import { t } from "../../i18n";
import type {
	FileMetadata,
	PendingMutation,
	SyncError,
	SyncOperation,
	SyncPhase,
	SyncProgress,
	SyncResult,
	YandexDiskSyncSettings,
} from "../../types";
import { logger, shortenDiagnosticValue } from "../../utils/logger";
import {
	isPublishedRemoteVersion,
	PendingPutLookup,
} from "../local/baseline-rules";
import {
	IndexManager,
	type CanonicalReadSession,
	type RemoteAuthorityObservation,
} from "../canonical/manager";
import type {
	IndexSaveCallback,
	SyncGuardResult,
	SyncRunOptions,
} from "../contracts";
import { createSyncError } from "../errors";
import { RemoteIndexConcurrentModificationError } from "../canonical/errors";
import { sameIndexValue } from "../canonical/transaction-rules";
import * as fileOperations from "../files/operations";
import * as reconcileAcceptedUploads from "../reconciliation/accepted-uploads";
import * as reconcileBaselines from "../reconciliation/baselines";
import * as syncReconciliation from "../reconciliation/commits";
import * as reconcileConflictSettlement from "../reconciliation/conflict-settlement";
import { ConflictResolver } from "../reconciliation/conflicts";
import * as reconciliationContext from "../reconciliation/context";
import * as reconcilePhysicalRecovery from "../reconciliation/physical-recovery";
import { receiveInitialRemoteState } from "./initial-receive";
export interface Dependencies {
	watcherBoundary?: Record<string, string>;
	canonicalReadSession?: CanonicalReadSession;
	decideEpochAdoption?: (
		epoch: string,
	) => Promise<"accept" | "preserve" | null>;
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
		observation?: RemoteAuthorityObservation,
	) => Promise<SyncGuardResult>;
	fileOperations: fileOperations.Dependencies;
	syncReconciliation: reconciliationContext.Dependencies;
}
export interface FullSyncContext {
	adoptionSnapshot: ReturnType<
		IndexManager["captureLocalCausalState"]
	> | null;
	adoptedEpoch: string | null;
}

/** Match a queued put against the live file version selected by full sync. */
function matchesReconciledPut(
	mutation: PendingMutation,
	file: FileMetadata | undefined,
): boolean {
	return (
		file !== undefined &&
		!file.deleted &&
		mutation.sha256 !== undefined &&
		file.sha256 === mutation.sha256
	);
}

/** Validate the FIFO before either commit in a full sync that has conflicts. */
async function prepareFullConflictPredecessors(
	deps: Pick<Dependencies, "indexManager" | "indexSaveCallback" | "settings">,
	result: SyncResult,
	phase: "deletion" | "conflict" | "recreation",
	recreatedPaths?: ReadonlyMap<string, FullRecreation>,
): Promise<boolean> {
	const index = deps.indexManager;
	const desired = index.getRemoteIndex();
	const applied = desired.appliedMutationSeq[deps.settings.deviceId] ?? 0;
	const pending = index
		.getPendingMutations()
		.filter(({ seq }) => seq > applied)
		.sort((left, right) => left.seq - right.seq);
	const latestFolderDelete = new Map<string, number>();
	const pendingBySeq = new Map<number, PendingMutation>();
	for (const mutation of pending) {
		pendingBySeq.set(mutation.seq, mutation);
		if (mutation.type === "delete-folder") {
			latestFolderDelete.set(
				mutation.path.replace(/\/+$/, ""),
				mutation.seq,
			);
		}
	}
	let expected = applied + 1;
	for (const mutation of pending) {
		const file = desired.files[mutation.path];
		const recreationPlan = recreatedPaths?.get(mutation.path);
		const retainedForeign =
			recreationPlan?.foreign && recreationPlan.copyPath;
		const readyPut =
			mutation.type === "put" &&
			(matchesReconciledPut(mutation, file) ||
				(retainedForeign && recreationPlan.put.id === mutation.id));
		const folderPath = mutation.path.replace(/\/+$/, "");
		const folder = desired.folderTombstones[folderPath];
		const recreation = pendingBySeq.get(file?.mutationSeq ?? 0);
		const restoredAfterDeletion =
			mutation.type === "delete-file" &&
			file?.lastModifiedBy === deps.settings.deviceId &&
			recreation?.type === "put" &&
			recreation.path === mutation.path &&
			recreation.epoch === mutation.epoch &&
			recreation.seq > mutation.seq &&
			matchesReconciledPut(recreation, file) &&
			(index.hasPublishedFileDeletion(mutation.path) ||
				recreationPlan?.deletions.has(mutation.seq));
		const preparedDelete =
			(mutation.type === "delete-file" &&
				file?.deleted === true &&
				!file.deletedByFolder) ||
			restoredAfterDeletion ||
			(retainedForeign &&
				mutation.type === "delete-file" &&
				recreationPlan.deletions.has(mutation.seq)) ||
			(mutation.type === "delete-folder" &&
				folder?.lastModifiedBy === deps.settings.deviceId &&
				folder.mutationSeq === latestFolderDelete.get(folderPath));
		if (
			mutation.seq !== expected ||
			mutation.epoch !== desired.epoch ||
			!(mutation.type === "noop" || readyPut || preparedDelete)
		) {
			logger.info("Full conflict waits for a pending mutation", {
				phase,
				mutationType: mutation.type,
				mutationSeq: mutation.seq,
				expectedSequence: expected,
			});
			await deps.indexSaveCallback?.();
			result.deferred = true;
			return false;
		}
		expected++;
	}
	if (phase === "conflict") {
		for (const mutation of pending) {
			index.stageMutation(mutation);
		}
	}
	return true;
}

/** Settle durable puts against the logical state selected by full sync.  Matching puts only need their device watermark. Puts superseded by the reconciled state become local no-ops so staging cannot alter canonical file metadata. */
export function settleFullSyncPendingPuts(
	deps: Pick<Dependencies, "indexManager">,
	retainedPuts: ReadonlySet<string> = new Set(),
): {
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
		if (mutation.type !== "put" || retainedPuts.has(mutation.id)) {
			continue;
		}
		if (matchesReconciledPut(mutation, canonicalFiles[mutation.path])) {
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
	deps: Pick<Dependencies, "indexManager">,
	uploads: SyncOperation[],
	verifiedPredecessors: ReadonlyMap<string, PendingMutation> = new Map(),
	replayedDeletes?: ReadonlyMap<string, ReplayedExactDeletion>,
): PendingMutation[] {
	const pending = new PendingPutLookup(
		deps.indexManager.getPendingMutations(),
	);
	return uploads.flatMap((operation) => {
		const sha256 = operation.localMeta?.sha256;
		if (!sha256) {
			return [];
		}
		const deletion = replayedDeletes?.get(operation.path);
		const predecessor =
			deletion ?? verifiedPredecessors.get(operation.path);
		const existing = pending.get(operation.path, sha256);
		if (
			existing &&
			(!deletion || existing.seq > deletion.lastDeletion) &&
			(!predecessor ||
				(existing.baseRevision === predecessor.baseRevision &&
					existing.baselineSha256 === predecessor.baselineSha256))
		) {
			return [existing];
		}
		const mutation = deps.indexManager.enqueueMutation(
			"put",
			operation.path,
			{
				sha256,
				baseRevision: predecessor?.baseRevision,
				baselineSha256: predecessor
					? predecessor.baselineSha256
					: deps.indexManager.getLocalIndex().files[operation.path]
							?.sha256,
			},
		);
		pending.add(mutation);
		return [mutation];
	});
}

/** Stamp uploaded full-sync entries with their allocated device sequence. */
export function stampFullUploadMutations(
	deps: Pick<Dependencies, "indexManager" | "settings">,
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

/** Execute bulk uploads and refresh only missing server-owned metadata. */
export async function executeBulkUploads(
	deps: Dependencies,
	uploads: SyncOperation[],
	result: SyncResult,
	onProgress: (completed: number) => void,
	failureMessage: string,
	directoryPages: ReadonlyMap<string, number> = new Map(),
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
		const liveRemote = await deps.indexManager.refreshMissingServerMetadata(
			directoryPages,
			() => {
				deps.canonicalReadSession?.assertCurrent();
			},
		);
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
	if (!(await loadFullCanonical(deps, options, result, validationToken))) {
		return;
	}
	if (await receiveEncryptionReplacement(deps, adoption, result)) {
		return;
	}
	const admission = await prepareFullReconciliation(
		deps,
		options,
		adoption,
		result,
	);
	if (!admission) {
		return;
	}
	const plan = await scanFullReconciliation(
		deps,
		adoption,
		admission,
		startTime,
	);
	deps.canonicalReadSession?.assertCurrent();
	await applyFullReconciliation(
		deps,
		options,
		result,
		plan,
		admission.hadPendingCausalWork,
		admission.replayedExactDeletions,
		validationToken,
	);
	deps.canonicalReadSession?.assertCurrent();
}

interface FullAdmission {
	adoptionDecision: "accept" | "preserve" | null;
	hadPendingCausalWork: boolean;
	replayedFolderChildren: ReadonlySet<string> | undefined;
	replayedExactDeletions: ReadonlyMap<string, ReplayedExactDeletion>;
}

interface FullPlan {
	directoryPages: Map<string, number>;
	operations: SyncOperation[];
	verifiedMetadataChanged: boolean;
	baselinesChanged: boolean;
	allowPublishedLocalDeletes: boolean;
	verifiedUploadPredecessors: ReadonlyMap<string, PendingMutation>;
}

/** Discover canonical state and finish first-connection reception before adoption. */
async function loadFullCanonical(
	deps: Dependencies,
	options: SyncRunOptions | undefined,
	result: SyncResult,
	validationToken?: string,
): Promise<boolean> {
	deps.yandexClient.clearFolderCache();
	// 1. Ensure remote folder exists
	deps.setSyncPhase("checking-remote");
	if (!options?.startup && !(await deps.indexManager.remotePathExists())) {
		await deps.indexManager.createRemotePath();
	}

	// 2. Load remote index
	deps.setSyncPhase("loading-index");
	if (deps.canonicalReadSession) {
		await deps.canonicalReadSession.load(true);
	} else {
		await deps.indexManager.loadRemoteIndex(false, options?.startup, true);
	}
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
			Object.values(initialCanonical.moves).some(
				(move) =>
					move.pending &&
					!reconcilePhysicalRecovery.isVaultTrashMove(move),
			)
		) {
			throw new Error(
				"Initial remote receive waits for pending canonical moves to finish",
			);
		}
		await receiveInitialRemoteState(deps, result, validationToken);
		if (result.errors.length > 0) {
			return false;
		}
	}

	return true;
}

/** Capture rollback state before epoch adoption, then resume durable causal work. */
async function prepareFullReconciliation(
	deps: Dependencies,
	options: SyncRunOptions | undefined,
	adoption: FullSyncContext,
	result: SyncResult,
): Promise<FullAdmission | null> {
	const localStateBeforeAdoption = deps.indexManager.getLocalIndex();
	const canonicalEpoch = deps.indexManager.getRemoteIndex().epoch;
	const replacesObservedEpoch =
		localStateBeforeAdoption.observedEpoch !== null &&
		localStateBeforeAdoption.observedEpoch !== canonicalEpoch;
	const migratesLegacyBaseline =
		localStateBeforeAdoption.observedEpoch === null &&
		Object.keys(localStateBeforeAdoption.files).length > 0;
	let adoptionDecision: "accept" | "preserve" | null = null;
	if (replacesObservedEpoch) {
		const actual = await deps.indexManager.buildLocalIndex();
		const baseline = localStateBeforeAdoption.files;
		const offlineChanges =
			deps.indexManager.getPendingMutations().length > 0 ||
			deps.indexManager.getPendingPhysicalActions().length > 0 ||
			[...new Set([...actual.keys(), ...Object.keys(baseline)])].some(
				(path) =>
					(actual.get(path)?.sha256 ?? null) !==
					(baseline[path]?.deleted
						? null
						: (baseline[path]?.sha256 ?? null)),
			);
		if (offlineChanges) {
			adoptionDecision =
				options?.epochAdoption?.epoch === canonicalEpoch
					? options.epochAdoption.decision
					: ((await deps.decideEpochAdoption?.(canonicalEpoch)) ??
						null);
			if (!adoptionDecision) {
				result.errors.push({
					path: "",
					operation: "none",
					code: "epoch-decision-required",
					message: t("force.epoch_description"),
				});
				return null;
			}
		}
	}
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
	const replayedExactDeletions = adoption.adoptionSnapshot
		? new Map<string, ReplayedExactDeletion>()
		: collectReplayedDeletions(deps);
	const replay = adoption.adoptionSnapshot
		? undefined
		: deps.indexManager.replayPendingMutations();
	if (replay?.confirmedMutations) {
		await deps.indexSaveCallback?.();
	}
	fileOperations.assertPortableLocalTree(
		deps.fileOperations,
		Object.entries(deps.indexManager.getRemoteIndex().files)
			.filter(([, metadata]) => !metadata.deleted)
			.map(([path]) => path),
	);
	if (
		reconcilePhysicalRecovery.hasPendingPhysicalWork(
			deps.syncReconciliation,
		)
	) {
		deps.setSyncPhase("cleanup");
	}
	await reconcilePhysicalRecovery.resumePendingMoves(
		deps.syncReconciliation,
		result,
		true,
	);
	await reconcilePhysicalRecovery.resumePendingPhysicalActions(
		deps.syncReconciliation,
		result,
	);
	if (result.errors.length > 0) {
		return null;
	}

	return {
		adoptionDecision,
		hadPendingCausalWork,
		replayedFolderChildren: replay?.replayedFolderChildren,
		replayedExactDeletions,
	};
}

/** Classify fresh local/remote observations without claiming lifecycle completion. */
async function scanFullReconciliation(
	deps: Dependencies,
	adoption: FullSyncContext,
	{
		adoptionDecision,
		hadPendingCausalWork,
		replayedFolderChildren,
	}: FullAdmission,
	startTime: number,
): Promise<FullPlan> {
	// 3. Build local index
	deps.setSyncPhase("scanning-local");
	const directoryPages = new Map<string, number>();
	const scanStartedAt = Date.now();
	const scans = await Promise.allSettled([
		deps.indexManager.buildLocalIndex(),
		deps.indexManager.getRemoteFiles(directoryPages, {
			projectSyncInventory: true,
		}),
	]);
	if (scans[0].status === "rejected") {
		throw scans[0].reason;
	}
	if (scans[1].status === "rejected") {
		throw scans[1].reason;
	}
	const localFiles = scans[0].value;
	const remoteFiles = scans[1].value;
	const listedFiles = new Map(remoteFiles);
	logger.info("Full scan observations completed", {
		durationMs: Date.now() - scanStartedAt,
		localFiles: localFiles.size,
		remoteFiles: remoteFiles.size,
	});
	const { metadataChanged: verifiedMetadataChanged, hashVerifiedPaths } =
		await reconcileBaselines.verifyRemoteContentCandidates(
			deps.syncReconciliation,
			localFiles,
			remoteFiles,
		);
	fileOperations.assertPortableLocalTree(deps.fileOperations, [
		...localFiles.keys(),
		...remoteFiles.keys(),
	]);
	if (
		reconcilePhysicalRecovery.reconcileCompletedPhysicalActions(
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
				adoptionDecision === "accept"
					? Object.fromEntries(localFiles)
					: adoption.adoptionSnapshot.state.files,
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
				replayedFolderChildren,
				hashVerifiedPaths,
			);
	operations = operations.filter((operation) =>
		deps.syncReconciliation.vaultAdapter.shouldSync(operation.path),
	);
	// Absence from the Vault snapshot does not prove a Force-written raw file was deleted.
	const retainedLocalPaths = new Set<string>();
	for (const { action, path } of operations) {
		if (
			action === "delete_remote" &&
			!localFiles.has(path) &&
			(await deps.fileOperations.vaultAdapter.vault.adapter.stat(path))
		) {
			retainedLocalPaths.add(path);
		}
	}
	operations = operations.filter(({ path }) => !retainedLocalPaths.has(path));
	const verifiedUploadPredecessors = adoption.adoptionSnapshot
		? new Map<string, PendingMutation>()
		: reconcileBaselines.findVerifiedUploadPredecessors(
				deps,
				operations,
				hashVerifiedPaths,
			);
	if (verifiedUploadPredecessors.size > 0) {
		operations = operations.map((operation) =>
			verifiedUploadPredecessors.has(operation.path)
				? {
						...operation,
						action: "upload",
						reason: "Later local edit supersedes a verified unfinished upload",
					}
				: operation,
		);
	}
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
	operations = operations.map((operation) => {
		if (
			operation.action === "download" ||
			operation.action === "conflict"
		) {
			const listed = listedFiles.get(operation.path);
			const canonical = remoteIndex.files[operation.path];
			const published =
				listed && isPublishedRemoteVersion(listed, canonical);
			const parent = operation.folderTombstonePath;
			const folder = parent && remoteIndex.folderTombstones[parent];
			return {
				...operation,
				folderSurvivor:
					folder && canonical?.deletedByFolder === parent
						? {
								parent: folder.path,
								epoch: remoteIndex.epoch,
								folderRevision: folder.changedRevision,
								fileRevision: canonical.changedRevision,
								sha256: canonical.sha256,
							}
						: undefined,
				remoteMeta: listed,
				expectedDownloadSha256: published
					? canonical?.sha256
					: undefined,
			};
		}
		if (operation.action === "upload") {
			return {
				...operation,
				remoteMeta: remoteFiles.get(operation.path),
			};
		}
		return operation;
	});
	const baselinesChanged = reconcileBaselines.recordConfirmedBaselines(
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

	return {
		operations,
		verifiedMetadataChanged,
		baselinesChanged,
		directoryPages,
		verifiedUploadPredecessors,
		allowPublishedLocalDeletes:
			!adoption.adoptionSnapshot &&
			!hadPendingCausalWork &&
			!remoteIndex.maintenance,
	};
}

/** Apply the classified groups and publish intent before destructive work. */
async function applyFullReconciliation(
	deps: Dependencies,
	options: SyncRunOptions | undefined,
	result: SyncResult,
	{
		operations,
		verifiedMetadataChanged,
		baselinesChanged,
		directoryPages,
		allowPublishedLocalDeletes,
		verifiedUploadPredecessors,
	}: FullPlan,
	hadPendingCausalWork: boolean,
	replayedExactDeletions: ReadonlyMap<string, ReplayedExactDeletion>,
	validationToken?: string,
): Promise<void> {
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
	const canonical = deps.indexManager.getRemoteIndex();
	const expectedEpoch = canonical.epoch;
	for (const { path } of uploads) {
		const deletion = replayedExactDeletions.get(path);
		if (
			deletion &&
			(!deletion.baselineSha256 || deletion.baseRevision === null)
		) {
			throw new Error("Cannot verify the original recreation baseline");
		}
	}
	const fullUploadMutations = prepareFullUploadMutations(
		deps,
		uploads,
		verifiedUploadPredecessors,
		replayedExactDeletions,
	);
	if (fullUploadMutations.length > 0) {
		await deps.indexSaveCallback?.();
	}
	const recreations = planFullRecreations(
		deps,
		uploads,
		fullUploadMutations,
		replayedExactDeletions,
	);
	let indexCommittedBeforeConflicts = false;

	const mtimeStamped = await executeBulkUploads(
		deps,
		uploads.filter((operation) => !recreations.has(operation.path)),
		result,
		(completed) => {
			processedOps = completed;
			deps.reportProgress(processedOps, totalOps);
		},
		"Batch server metadata re-read after uploads failed",
		directoryPages,
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
			"by-size",
		);
		result.downloaded = downloadResults.succeeded;
		result.errors.push(...downloadResults.errors);
		if (downloadResults.errors.length > 0) {
			await deps.indexSaveCallback?.();
			return;
		}
	}

	const retainedPuts = new Set(
		[...recreations.values()].map(({ put }) => put.id),
	);
	const mutationSettlement = settleFullSyncPendingPuts(deps, retainedPuts);
	if (mutationSettlement.noopPuts > 0 && deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}

	if (recreations.size > 0) {
		await prepareRecreationVersions(deps, recreations);
		if (
			!(await prepareFullConflictPredecessors(
				deps,
				result,
				"recreation",
				recreations,
			))
		) {
			return;
		}
		if (
			!(await commitRecreatedFiles(
				deps,
				recreations,
				uploads,
				result,
				options,
				expectedEpoch,
				validationToken,
			))
		) {
			return;
		}
		indexCommittedBeforeConflicts = true;
	}

	if (deletes.length > 0) {
		// Publishing deletion intents also confirms the pending queue.
		if (
			conflicts.length > 0 &&
			!(await prepareFullConflictPredecessors(deps, result, "deletion"))
		) {
			return;
		}
		deps.setSyncPhase("applying", t("status.op.deleting_files"));
		const deletionCommitProof =
			await syncReconciliation.commitDeletionIntents(
				deps.syncReconciliation,
				deletes,
				result,
				Boolean(deps.canonicalReadSession) &&
					allowPublishedLocalDeletes &&
					!options?.skipEncryptionGuard &&
					!options?.skipMaintenanceGuard,
			);
		if (!deletionCommitProof) {
			return;
		}
		if (deletionCommitProof.kind === "committed") {
			await reconcileAcceptedUploads.repairMissingAcceptedUploads(
				deps.syncReconciliation,
				uploads.map((operation) => operation.path),
				deletionCommitProof.proof,
				validationToken,
			);
			indexCommittedBeforeConflicts = true;
		}
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
		if (
			!(await prepareFullConflictPredecessors(deps, result, "conflict"))
		) {
			return;
		}
		if (
			!(await resolveFullConflicts(
				deps,
				conflicts,
				result,
				processedOps,
				totalOps,
			))
		) {
			await deps.indexSaveCallback?.();
			return;
		}
	}

	await commitFullReconciliation(
		deps,
		options,
		result,
		{
			uploads,
			verifiedMetadataChanged,
			baselinesChanged,
			hadPendingCausalWork,
			mtimeStamped,
			pendingWatermarks: mutationSettlement.pendingWatermarks,
			indexCommittedBeforeConflicts,
			hasConflicts: conflicts.length > 0,
		},
		validationToken,
	);
}

interface FullCommitState {
	uploads: SyncOperation[];
	verifiedMetadataChanged: boolean;
	baselinesChanged: boolean;
	hadPendingCausalWork: boolean;
	mtimeStamped: boolean;
	pendingWatermarks: number;
	indexCommittedBeforeConflicts: boolean;
	hasConflicts: boolean;
}

/** Revalidate the active codec before publishing transfers and resuming remaining cleanup. */
async function commitFullReconciliation(
	deps: Dependencies,
	options: SyncRunOptions | undefined,
	result: SyncResult,
	{
		uploads,
		verifiedMetadataChanged,
		baselinesChanged,
		hadPendingCausalWork,
		mtimeStamped,
		pendingWatermarks,
		indexCommittedBeforeConflicts,
		hasConflicts,
	}: FullCommitState,
	validationToken?: string,
): Promise<void> {
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

	// Ordinary full compares canonical state, not transfer counters or local baselines.
	// Other workflows retain their existing commit/guard contract.
	const indexDirty = deps.canonicalReadSession
		? deps.indexManager.hasPendingCanonicalChanges() ||
			tombstonesRemoved ||
			hasConflicts
		: verifiedMetadataChanged ||
			hadOperations ||
			mtimeStamped ||
			tombstonesRemoved ||
			baselinesChanged ||
			pendingWatermarks > 0;
	if (
		!indexDirty &&
		!indexCommittedBeforeConflicts &&
		deps.canonicalReadSession
	) {
		// Preserve applied bytes across failed validation/restart without observing success.
		deps.canonicalReadSession.assertCurrent();
		await deps.indexSaveCallback?.();
		const canonical = await deps.canonicalReadSession(
			async (observation) => {
				const guard = await deps.getSyncGuardResult(
					options?.skipEncryptionGuard,
					validationToken,
					options?.validateThroughExternalEncryptionBlock,
					observation,
				);
				if (guard.blockReason) {
					throw new Error(
						`Sync aborted before saving: ${guard.blockReason}`,
					);
				}
			},
		);
		if (
			deps.indexManager.hasPendingCanonicalChanges() ||
			!sameIndexValue(canonical, deps.indexManager.getRemoteIndex())
		) {
			throw new RemoteIndexConcurrentModificationError(
				"Canonical changed before read-only reconciliation completed",
			);
		}
		logger.debug(
			"[SyncEngine] Canonical unchanged, saving local reconciliation only",
		);
		await settleFullPhysicalWork(deps, result);
		return;
	}

	const strictNoOp =
		!indexDirty && !hadPendingCausalWork && !indexCommittedBeforeConflicts;
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
	if (!indexDirty && !indexCommittedBeforeConflicts) {
		logger.debug(
			"[SyncEngine] No changes detected, skipping remote index save",
		);
		if (deps.indexSaveCallback) {
			await deps.indexSaveCallback();
		}
		await settleFullPhysicalWork(deps, result);
		return;
	}
	if (indexCommittedBeforeConflicts && !hasConflicts) {
		await settleFullPhysicalWork(deps, result);
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
	await reconcileAcceptedUploads.repairMissingAcceptedUploads(
		deps.syncReconciliation,
		uploads.map((operation) => operation.path),
		commitProof,
		validationToken,
	);
	await settleFullPhysicalWork(deps, result);
}

/** Recheck physical actions and moves after final canonical publication. */
async function settleFullPhysicalWork(
	deps: Dependencies,
	result: SyncResult,
): Promise<void> {
	if (
		reconcilePhysicalRecovery.hasPendingPhysicalWork(
			deps.syncReconciliation,
		)
	) {
		deps.setSyncPhase("cleanup");
	}
	await reconcilePhysicalRecovery.resumePendingPhysicalActions(
		deps.syncReconciliation,
		result,
	);
	await reconcilePhysicalRecovery.resumePendingMoves(
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
	const receive = indexManager.getLocalIndex().replacementReceive;
	indexManager.restoreLocalCausalState(snapshot);
	if (receive) {
		indexManager.getLocalIndex().replacementReceive = receive;
	}
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
): Promise<boolean> {
	deps.setSyncPhase("applying", t("status.op.resolving_conflicts"));
	for (const op of conflicts) {
		if (deps.isPaused) {
			result.success = false;
			result.errors.push({
				path: "",
				operation: "none",
				message: "Synchronization interrupted",
			});
			return false;
		}

		deps.setSyncPhase(
			"applying",
			t("status.op.conflict", { path: op.path }),
			{ completed: processedOps, total: totalOps },
		);

		try {
			await reconcileConflictSettlement.handleConflict(
				deps.syncReconciliation,
				op,
			);
			result.conflicts++;
		} catch (e) {
			const error: SyncError = createSyncError(e, op.path, op.action);
			result.errors.push(error);
			logger.error(`Error resolving conflict for ${op.path}:`, {
				error: e,
			});
			return false;
		} finally {
			processedOps++;
			deps.reportProgress(processedOps, totalOps);
		}
	}
	return true;
}
