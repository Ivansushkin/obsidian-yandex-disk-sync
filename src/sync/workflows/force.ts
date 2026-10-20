import { VaultAdapter } from "../../api/vault-adapter";
import { YandexDiskClient, isRemoteReadTimeout } from "../../api/yandex-client";
import {
	captureLogicalVaultSnapshot,
	captureRemoteRawSnapshot,
} from "../../backup/backup-snapshot";
import { t } from "../../i18n";
import type {
	FileMetadata,
	IndexMaintenance,
	SyncError,
	SyncOperation,
	SyncPhase,
	SyncProgress,
	SyncResult,
	YandexDiskSyncSettings,
} from "../../types";
import { computeSha256 } from "../../utils/hash-utils";
import { logger } from "../../utils/logger";
import { joinPath } from "../../utils/path-utils";
import { createSafeRecord, setRecordValue } from "../../utils/record-utils";
import {
	getPhysicalResourceFingerprint,
	matchesPhysicalResourceFingerprint,
} from "../../utils/resource-fingerprint";
import { runWithConcurrencySettled } from "../../utils/semaphore";
import { createSyncError } from "../errors";
import * as fileOperations from "../files/operations";
import {
	ForceBackupStaleError,
	ForceSourceChangedError,
	IndexManager,
} from "../canonical/manager";
import type {
	ForcePreflightProof,
	IndexSaveCallback,
	SyncRunOptions,
} from "../contracts";
import * as syncReconciliation from "../reconciliation/commits";
export interface Dependencies {
	yandexClient: YandexDiskClient;
	settings: YandexDiskSyncSettings;
	indexManager: IndexManager;
	vaultAdapter: VaultAdapter;
	setSyncPhase: (
		phase: SyncPhase,
		currentOperation?: string,
		progress?: SyncProgress,
	) => void;
	reportProgress: (processedOps: number, totalOps: number) => void;
	indexSaveCallback: IndexSaveCallback | null;
	fileOperations: fileOperations.Dependencies;
	syncReconciliation: syncReconciliation.Dependencies;
}
export interface ForceRunContext {
	bootstrapStarted: boolean;
}

/** Revalidate protected data independently of the user's archive choice. */
export async function assertForcePreflightProof(
	deps: Dependencies,
	direction: ForcePreflightProof["direction"],
	options?: SyncRunOptions,
): Promise<void> {
	if (options?.forcePreflightProof && options.forceBackupProof) {
		throw new ForceBackupStaleError("Conflicting Force proofs");
	}
	const legacy = options?.forceBackupProof;
	const proof =
		options?.forcePreflightProof ??
		(legacy
			? {
					direction: legacy.direction,
					canonical: legacy.canonical,
					snapshotDigest: legacy.snapshotDigest,
					backup: {
						backupName: legacy.backupName,
						backupSha256: legacy.backupSha256,
					},
				}
			: undefined);
	if (
		!proof ||
		proof.direction !== direction ||
		!proof.snapshotDigest ||
		proof.backup === undefined
	) {
		throw new ForceBackupStaleError(
			"Force requires a verified preflight proof",
		);
	}
	if (proof.backup !== null) {
		if (!proof.backup.backupName || !proof.backup.backupSha256) {
			throw new ForceBackupStaleError("Incomplete backup proof");
		}
		const backup = await deps.yandexClient.downloadStableRawFile(
			joinPath(
				deps.settings.remotePath,
				".backup",
				proof.backup.backupName,
			),
		);
		if (
			!backup ||
			(await computeSha256(backup.raw)) !== proof.backup.backupSha256
		) {
			throw new ForceBackupStaleError(
				"Verified Force backup is missing or changed",
			);
		}
	}
	await deps.indexManager.assertForceCanonicalProof(proof.canonical);
	const snapshot =
		direction === "from_local"
			? await captureRemoteRawSnapshot(
					deps.yandexClient,
					deps.settings.remotePath,
				)
			: await captureLogicalVaultSnapshot(deps.vaultAdapter);
	if (snapshot.digest !== proof.snapshotDigest) {
		throw new ForceBackupStaleError(
			"Protected data changed after Force preflight",
		);
	}
	await deps.indexManager.assertForceCanonicalProof(proof.canonical);
}

/** Initialize one Force epoch while preserving resumable cleanup metadata. */
export async function prepareForceBootstrap(
	deps: Dependencies,
): Promise<IndexMaintenance | undefined> {
	deps.yandexClient.clearFolderCache();
	const inheritedCleanup = deps.indexManager.getMaintenance();
	deps.indexManager.beginForceBootstrap(true);
	if (inheritedCleanup?.phase === "cleanup") {
		deps.indexManager.setMaintenance(inheritedCleanup);
	}
	deps.setSyncPhase("checking-remote");
	if (!(await deps.indexManager.remotePathExists())) {
		await deps.indexManager.createRemotePath();
	}
	return inheritedCleanup;
}

/** Upload only bytes that still match the local Force source snapshot. */
export async function executeForceLocalUploads(
	deps: Dependencies,
	uploads: SyncOperation[],
	result: SyncResult,
	onProgress: (completed: number) => void,
): Promise<void> {
	if (uploads.length === 0) {
		return;
	}
	deps.setSyncPhase("applying", t("status.op.uploading_files"));
	const outcomes = await runWithConcurrencySettled(
		uploads.map((operation) => async () => {
			const expected = operation.localMeta;
			if (!expected) {
				throw new ForceSourceChangedError();
			}
			const content = await deps.vaultAdapter.readFile(operation.path);
			const sha256 = await computeSha256(content);
			if (sha256 !== expected.sha256) {
				throw new ForceSourceChangedError();
			}
			await fileOperations.uploadFile(
				deps.fileOperations,
				operation.path,
				true,
				false,
				{
					content,
					sha256,
				},
			);
		}),
		Math.max(1, deps.settings.maxConcurrency || 5),
		onProgress,
	);
	collectForceOperationOutcomes(uploads, outcomes, result);
	if (result.errors.length > 0) {
		return;
	}
	try {
		const liveRemote = await deps.indexManager.getRemoteFiles();
		deps.indexManager.applyServerMtimes(liveRemote);
	} catch (error) {
		logger.warn(
			"Batch server metadata re-read after Force uploads failed",
			{ error },
		);
	}
}

/** Download each Force source file only after a stable metadata proof. */
export async function executeForceRemoteDownloads(
	deps: Dependencies,
	downloads: SyncOperation[],
	onProgress: (completed: number) => void,
): Promise<{ succeeded: number; errors: SyncError[] }> {
	const outcomes = await runWithConcurrencySettled(
		downloads.map((operation) => async () => {
			if (!operation.remoteMeta) {
				throw new ForceSourceChangedError();
			}
			await downloadStableForceRemoteFile(
				deps,
				operation.path,
				operation.remoteMeta,
				operation.localMeta?.sha256 ?? null,
			);
		}),
		Math.max(1, deps.settings.maxConcurrency || 5),
		onProgress,
		{
			stopOnError: isRemoteReadTimeout,
			onError: (reason, index) => {
				const operation = downloads[index];
				if (operation) {
					const error =
						reason instanceof Error
							? reason
							: new Error(String(reason));
					deps.fileOperations.onOperationError?.(
						createSyncError(
							error,
							operation.path,
							operation.action,
						),
					);
				}
			},
		},
	);
	const result = { succeeded: 0, errors: [] as SyncError[] };
	for (let index = 0; index < outcomes.length; index++) {
		const outcome = outcomes[index];
		const operation = downloads[index];
		if (!outcome || !operation) {
			continue;
		}
		if (outcome.status === "fulfilled") {
			result.succeeded++;
		} else {
			result.errors.push(
				createSyncError(
					outcome.reason,
					operation.path,
					operation.action,
				),
			);
		}
	}
	return result;
}

/** Read a stable Force source before performing the first local write. */
export async function downloadStableForceRemoteFile(
	deps: Dependencies,
	path: string,
	expected: FileMetadata,
	expectedLocalSha?: string | null,
): Promise<void> {
	const localSha =
		expectedLocalSha === undefined
			? await fileOperations.readLocalDownloadIdentity(
					deps.fileOperations,
					path,
				)
			: expectedLocalSha;
	const remotePath = joinPath(deps.settings.remotePath, path);
	const snapshot =
		await deps.yandexClient.downloadStableLogicalFile(remotePath);
	if (
		!snapshot ||
		!matchesPhysicalResourceFingerprint(
			expected.remoteFingerprint,
			snapshot.resource,
		)
	) {
		throw new ForceSourceChangedError();
	}
	const serverMtime = new Date(snapshot.resource.modified).getTime();
	await fileOperations.applyDownloadedContent(
		deps.fileOperations,
		path,
		snapshot.content,
		{
			serverMtime: Number.isFinite(serverMtime) ? serverMtime : undefined,
			remoteFingerprint:
				getPhysicalResourceFingerprint(snapshot.resource) ?? undefined,
		},
		localSha,
	);
}

/** Retain each failed path while counting only verified transfers. */
export function collectForceOperationOutcomes(
	operations: SyncOperation[],
	outcomes: Awaited<ReturnType<typeof runWithConcurrencySettled<void>>>,
	result: SyncResult,
): void {
	for (let index = 0; index < outcomes.length; index++) {
		const outcome = outcomes[index];
		const operation = operations[index];
		if (!outcome || !operation) {
			continue;
		}
		if (outcome.status === "fulfilled") {
			result.uploaded++;
			continue;
		}
		result.errors.push({
			path: operation.path,
			operation: operation.action,
			message:
				outcome.reason instanceof Error
					? outcome.reason.message
					: String(outcome.reason),
		});
	}
}

/** Compare local source paths, sizes and plaintext hashes independent of order. */
export function getForceLocalSourceIdentity(
	files: Map<string, FileMetadata>,
): string {
	return JSON.stringify(
		[...files.entries()]
			.map(
				([path, metadata]) =>
					[path, metadata.sha256, metadata.size] as const,
			)
			.sort(([left], [right]) => left.localeCompare(right)),
	);
}

/** Compare physical source identities without relying on client clocks. */
export function getForceRemoteSourceIdentity(
	files: Map<string, FileMetadata>,
): string {
	return JSON.stringify(
		[...files.entries()]
			.map(
				([path, metadata]) =>
					[
						path,
						metadata.remoteFingerprint ?? null,
						metadata.remoteMtime ?? null,
						metadata.size,
					] as const,
			)
			.sort(([left], [right]) => left.localeCompare(right)),
	);
}

/** Reject replacement when its local source snapshot has drifted. */
export function assertForceLocalSourceUnchanged(
	expectedIdentity: string,
	current: Map<string, FileMetadata>,
): void {
	if (getForceLocalSourceIdentity(current) !== expectedIdentity) {
		throw new ForceSourceChangedError();
	}
}

/** Reject replacement when its remote source snapshot has drifted. */
export function assertForceRemoteSourceUnchanged(
	expectedIdentity: string,
	current: Map<string, FileMetadata>,
): void {
	if (getForceRemoteSourceIdentity(current) !== expectedIdentity) {
		throw new ForceSourceChangedError();
	}
}

/** Build a replacement epoch from verified local bytes before guarded cleanup. */
export async function reconcileForceLocal(
	deps: Dependencies,
	options: SyncRunOptions | undefined,
	force: ForceRunContext,
	result: SyncResult,
	validationToken?: string,
): Promise<void> {
	await assertForcePreflightProof(deps, "from_local", options);

	// 2. Build local index
	deps.setSyncPhase("scanning-local");
	const localFiles = await deps.indexManager.buildLocalIndex();
	const sourceIdentity = getForceLocalSourceIdentity(localFiles);

	// 3. Get remote files list
	deps.setSyncPhase("scanning-remote");
	const remoteFiles = await deps.indexManager.getRemoteFiles();

	// 4. Generate operations manually: all local → upload, remote-only → delete_remote
	deps.setSyncPhase("analyzing");
	const operations: SyncOperation[] = [];

	for (const [path, meta] of localFiles) {
		operations.push({
			action: "upload",
			path,
			reason: "Force sync from local",
			localMeta: meta,
		});
	}

	if (!options?.skipRemoteDeletes) {
		for (const [path, meta] of remoteFiles) {
			if (!localFiles.has(path)) {
				operations.push({
					action: "delete_remote",
					path,
					reason: "Force sync from local: file not present locally",
					remoteMeta: meta,
				});
			}
		}
	}
	await assertForcePreflightProof(deps, "from_local", options);
	await options?.beforeForceMutation?.();
	force.bootstrapStarted = true;
	const inheritedCleanup = await prepareForceBootstrap(deps);
	if (inheritedCleanup) {
		deps.indexManager.clearMaintenance(inheritedCleanup.id);
	}

	logger.info(
		`Force sync from local: ${operations.length} synchronization operations`,
	);

	// 5. Preflight: Create all necessary folders
	await fileOperations.prepareOperationFolders(
		deps.fileOperations,
		operations,
	);

	// 6. Execute operations in parallel by type
	const totalOps = operations.length;
	let processedOps = 0;

	const uploads = operations.filter((op) => op.action === "upload");
	const deletes = operations.filter((op) => op.action === "delete_remote");

	await executeForceLocalUploads(deps, uploads, result, (completed) => {
		processedOps = completed;
		deps.reportProgress(processedOps, totalOps);
	});
	if (result.errors.length > 0) {
		return;
	}

	await options?.beforeIndexCommit?.();
	const finalLocalFiles = await deps.indexManager.buildLocalIndex();
	assertForceLocalSourceUnchanged(sourceIdentity, finalLocalFiles);

	for (const operation of deletes) {
		if (!operation.remoteMeta) {
			continue;
		}
		deps.indexManager.updateRemoteFile(
			operation.path,
			operation.remoteMeta,
		);
		deps.indexManager.markRemoteFileDeleted(
			operation.path,
			undefined,
			0,
			0,
		);
		deps.indexManager.enqueuePhysicalAction(
			"delete-remote",
			operation.path,
			{
				canonicalRevision:
					deps.indexManager.getRemoteIndex().revision + 1,
				expectedFingerprint: operation.remoteMeta.remoteFingerprint,
				origin: "force-reset",
			},
		);
	}
	if (deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}

	// 7. Commit all live entries and replacement tombstones before delete.
	deps.setSyncPhase("saving-index");
	deps.indexManager.updateSyncTime();
	const commitProof = await syncReconciliation.saveRemoteIndexOrAbort(
		deps.syncReconciliation,
		result,
		false,
	);
	if (!commitProof) {
		return;
	}
	result.replacementCommitted = true;
	await syncReconciliation.repairMissingAcceptedUploads(
		deps.syncReconciliation,
		uploads.map((operation) => operation.path),
		commitProof,
		validationToken,
	);

	if (deletes.length > 0) {
		deps.setSyncPhase("applying", t("status.op.deleting_remote_files"));
		const deleteResults = await fileOperations.executeOperationsParallel(
			deps.fileOperations,
			deletes,
			(completed) => {
				processedOps = uploads.length + completed;
				deps.reportProgress(processedOps, totalOps);
			},
		);
		result.deleted = deleteResults.succeeded;
		result.errors.push(...deleteResults.errors);
		if (deps.indexSaveCallback) {
			await deps.indexSaveCallback();
		}
		try {
			await fileOperations.pruneRemoteFolders(
				deps.fileOperations,
				deletes.map((op) => op.path),
			);
		} catch (error) {
			logger.warn("Failed to prune remote folders after Force", {
				error,
			});
		}
	}
}

/** Apply stable remote snapshots and commit replacement before local deletion. */
export async function reconcileForceRemote(
	deps: Dependencies,
	options: SyncRunOptions | undefined,
	force: ForceRunContext,
	result: SyncResult,
): Promise<void> {
	await assertForcePreflightProof(deps, "from_remote", options);

	// 2. Build local index (to know what to delete)
	deps.setSyncPhase("scanning-local");
	const localFiles = await deps.indexManager.buildLocalIndex();

	// 3. Read the authoritative physical remote snapshot. Force
	// remote intentionally does not trust a legacy or ambiguous
	// canonical index.
	deps.setSyncPhase("scanning-remote");
	const remoteFiles = await deps.indexManager.getRemoteFiles();
	fileOperations.assertPortableLocalTree(deps.fileOperations, [
		...localFiles.keys(),
		...remoteFiles.keys(),
	]);
	const sourceIdentity = getForceRemoteSourceIdentity(remoteFiles);

	// 4. Generate operations manually: all remote → download,
	// local-only → delete locally.
	deps.setSyncPhase("analyzing");
	const operations: SyncOperation[] = [];

	for (const [path, meta] of remoteFiles) {
		operations.push({
			action: "download",
			path,
			reason: "Force sync from remote",
			localMeta: localFiles.get(path),
			remoteMeta: meta,
		});
	}

	for (const [path, meta] of localFiles) {
		if (!remoteFiles.has(path)) {
			operations.push({
				action: "delete_local",
				path,
				reason: "Force sync from remote: file not present on disk",
				localMeta: meta,
			});
		}
	}
	await assertForcePreflightProof(deps, "from_remote", options);
	await options?.beforeForceMutation?.();
	force.bootstrapStarted = true;
	const inheritedCleanup = await prepareForceBootstrap(deps);
	if (inheritedCleanup) {
		deps.indexManager.clearMaintenance(inheritedCleanup.id);
	}

	logger.info(
		`Force sync from remote: ${operations.length} synchronization operations`,
	);

	// 5. Preflight: Create all necessary folders
	await fileOperations.prepareOperationFolders(
		deps.fileOperations,
		operations,
	);

	// 6. Execute operations in parallel by type
	const totalOps = operations.length;
	let processedOps = 0;

	const downloads = operations.filter((op) => op.action === "download");
	const deletes = operations.filter((op) => op.action === "delete_local");

	if (downloads.length > 0) {
		deps.setSyncPhase("applying", t("status.op.downloading_files"), {
			completed: 0,
			total: totalOps,
		});
		const downloadResults = await executeForceRemoteDownloads(
			deps,
			downloads,
			(completed) => {
				processedOps = completed;
				deps.reportProgress(processedOps, totalOps);
			},
		);
		result.downloaded = downloadResults.succeeded;
		result.errors.push(...downloadResults.errors);
		if (downloadResults.errors.length > 0) {
			return;
		}
	}

	await options?.beforeIndexCommit?.();
	const finalRemoteFiles = await deps.indexManager.getRemoteFiles();
	assertForceRemoteSourceUnchanged(sourceIdentity, finalRemoteFiles);

	for (const operation of deletes) {
		if (!operation.localMeta) {
			continue;
		}
		deps.indexManager.updateRemoteFile(operation.path, operation.localMeta);
		deps.indexManager.markRemoteFileDeleted(
			operation.path,
			undefined,
			0,
			0,
		);
		deps.indexManager.enqueuePhysicalAction(
			"delete-local",
			operation.path,
			{
				canonicalRevision:
					deps.indexManager.getRemoteIndex().revision + 1,
				baselineSha256: operation.localMeta.sha256,
				origin: "force-reset",
			},
		);
	}
	if (deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}

	// 7. Sync indexes: local becomes a copy of remote (only for
	// downloads that actually succeeded). Entries whose download failed
	// are left out of the local index so the next sync retries them and
	// the local state does not falsely claim a file is present.
	deps.setSyncPhase("saving-index");
	const localIndex = deps.indexManager.getLocalIndex();
	const remoteIndex = deps.indexManager.getRemoteIndex();
	const failedPaths = new Set(
		result.errors.map((e) => e.path).filter(Boolean),
	);
	const newLocalFiles = createSafeRecord<FileMetadata>();
	for (const [p, meta] of Object.entries(remoteIndex.files)) {
		if (failedPaths.has(p)) {
			continue;
		}
		setRecordValue(newLocalFiles, p, meta);
	}
	localIndex.files = newLocalFiles;
	deps.indexManager.updateSyncTime();
	if (
		!(await syncReconciliation.saveRemoteIndexOrAbort(
			deps.syncReconciliation,
			result,
			false,
		))
	) {
		return;
	}
	result.replacementCommitted = true;

	if (deletes.length > 0) {
		deps.setSyncPhase("applying", t("status.op.deleting_local_files"));
		const deleteResults = await fileOperations.executeOperationsParallel(
			deps.fileOperations,
			deletes,
			(completed) => {
				processedOps = downloads.length + completed;
				deps.reportProgress(processedOps, totalOps);
			},
		);
		result.deleted = deleteResults.succeeded;
		result.errors.push(...deleteResults.errors);
		if (deps.indexSaveCallback) {
			await deps.indexSaveCallback();
		}
	}
}
