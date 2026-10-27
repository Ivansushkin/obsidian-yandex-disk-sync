import { VaultAdapter } from "../../api/vault-adapter";
import { YandexDiskClient, isRemoteReadTimeout } from "../../api/yandex-client";
import type {
	FileMetadata,
	PendingMutation,
	PendingPhysicalAction,
	SyncError,
	SyncOperation,
	SyncPhase,
	SyncProgress,
	YandexDiskSyncSettings,
} from "../../types";
import { computeSha256 } from "../../utils/hash-utils";
import { logger, shortenDiagnosticValue } from "../../utils/logger";
import {
	getDirectory,
	hasPortablePathCollision,
	joinPath,
} from "../../utils/path-utils";
import {
	getPhysicalResourceFingerprint,
	matchesPhysicalResourceFingerprint,
} from "../../utils/resource-fingerprint";
import { runWithConcurrencySettled } from "../../utils/semaphore";
import { createConfirmedBaseline } from "../local/baseline-rules";
import {
	IndexManager,
	type CanonicalReadSession,
	type RemoteAuthorityObservation,
} from "../canonical/manager";
import { PortablePathCollisionError } from "../canonical/errors";
import {
	classifyPhysicalDeleteResource,
	isPhysicalDeleteAuthorized,
	shouldBackupLocalDelete,
} from "./action-rules";
import type { SyncGuardCallback } from "../contracts";
import { createSyncError } from "../errors";
export interface Dependencies {
	canonicalReadSession?: CanonicalReadSession;
	validationToken?: string;
	getSyncGuardResult: SyncGuardCallback;
	vaultAdapter: VaultAdapter;
	yandexClient: YandexDiskClient;
	settings: YandexDiskSyncSettings;
	indexManager: IndexManager;
	expectWatcherEvent: (
		path: string,
		action: "upload" | "delete" | "rename",
	) => void;
	setSyncPhase: (
		phase: SyncPhase,
		currentOperation?: string,
		progress?: SyncProgress,
	) => void;
	isPaused: boolean;
	onOperationError?: (error: SyncError) => void;
}

/** Upload file to Yandex Disk.  When `stampRemoteMtime` is true (default) the server-side mtime of the just-uploaded resource is fetched and stored on the remote index entry so the next sync can detect external remote changes via server-mtime comparison. Set it to false for bulk upload flows that perform a single batch re-read of the remote file list afterwards (see `IndexManager.applyServerMtimes`); this saves one `getResource` API call per uploaded file. */
export async function uploadFile(
	deps: Dependencies,
	path: string,
	skipFolderCheck = false,
	stampRemoteMtime = true,
	snapshot?: { content: ArrayBuffer; sha256: string },
	beforeAttempt?: () => Promise<void>,
	confirmAmbiguousResult?: () => Promise<boolean>,
): Promise<void> {
	const content =
		snapshot?.content ?? (await deps.vaultAdapter.readFile(path));
	const sha256 = snapshot?.sha256 ?? (await computeSha256(content));
	const metadata = await materializeUploadedFile(
		deps,
		path,
		{ content, sha256 },
		skipFolderCheck,
		stampRemoteMtime,
		beforeAttempt,
		confirmAmbiguousResult,
	);
	applyUploadedFileMetadata(deps, path, metadata);
}

/** Upload a stable snapshot without publishing it in either sync index. */
export async function materializeUploadedFile(
	deps: Dependencies,
	path: string,
	snapshot: { content: ArrayBuffer; sha256: string },
	skipFolderCheck: boolean,
	stampRemoteMtime: boolean,
	beforeAttempt?: () => Promise<void>,
	confirmAmbiguousResult?: () => Promise<boolean>,
): Promise<FileMetadata> {
	logger.debug(`Uploading file: ${path}`);
	await deps.yandexClient.uploadFile(
		joinPath(deps.settings.remotePath, path),
		snapshot.content,
		skipFolderCheck,
		false,
		true,
		beforeAttempt,
		confirmAmbiguousResult,
	);
	const remoteStamp = stampRemoteMtime
		? await fetchRemoteStamp(deps, path)
		: {};
	return {
		path,
		sha256: snapshot.sha256,
		size: snapshot.content.byteLength,
		mtime: deps.vaultAdapter.getFileMtime(path) || Date.now(),
		syncedAt: Date.now(),
		...remoteStamp,
	};
}

/** Confirm an ambiguous sent PUT without granting permission for another write. */
export async function confirmUploadedSnapshot(
	deps: Dependencies,
	path: string,
	sha256: string,
	assertAuthority: () => Promise<void>,
	validationToken?: string,
): Promise<boolean> {
	const before = await deps.getSyncGuardResult(validationToken);
	if (before.blockReason) {
		throw new Error(before.blockReason);
	}
	await assertAuthority();
	const snapshot = await deps.yandexClient.downloadStableLogicalFile(
		joinPath(deps.settings.remotePath, path),
	);
	await assertAuthority();
	const after = await deps.getSyncGuardResult(
		validationToken ?? before.validationToken,
	);
	if (after.blockReason) {
		throw new Error(after.blockReason);
	}
	return (
		snapshot !== null && (await computeSha256(snapshot.content)) === sha256
	);
}

/** Publish metadata only after a realtime upload is still causally current. */
export function applyUploadedFileMetadata(
	deps: Dependencies,
	path: string,
	metadata: FileMetadata,
	mutation?: PendingMutation,
): void {
	const causalMetadata = mutation
		? { ...metadata, mutationSeq: mutation.seq }
		: metadata;
	deps.indexManager.updateLocalFile(path, causalMetadata);
	const pendingBaseRevision =
		deps.indexManager.getPendingPutBaseRevision(path);
	deps.indexManager.updateRemoteFile(path, {
		...causalMetadata,
		baseRevision:
			pendingBaseRevision === undefined
				? deps.indexManager.getCausalBaseRevision()
				: (pendingBaseRevision ??
					deps.indexManager.getRemoteIndex().revision),
	});
}

/** Capture the local precondition before retrieving remote bytes. */
export async function downloadFile(
	deps: Dependencies,
	path: string,
	serverMtime?: number,
	expectedLocalSha?: string | null,
): Promise<void> {
	logger.debug(`Downloading file: ${path}`);

	const remotePath = joinPath(deps.settings.remotePath, path);
	const localSha =
		expectedLocalSha === undefined
			? await readLocalDownloadIdentity(deps, path)
			: expectedLocalSha;
	const content = await deps.yandexClient.downloadFile(remotePath);
	await applyDownloadedContent(
		deps,
		path,
		content,
		{ serverMtime },
		localSha,
	);
}

/** Observe local content before an asynchronous download can replace it. */
export async function readLocalDownloadIdentity(
	deps: Dependencies,
	path: string,
): Promise<string | null> {
	return deps.vaultAdapter.fileExists(path)
		? await computeSha256(await deps.vaultAdapter.readFile(path))
		: null;
}

/** Leave late local edits for reconciliation instead of applying stale bytes. */
export async function assertDownloadLocalUnchanged(
	deps: Dependencies,
	path: string,
	expected: string | null,
): Promise<void> {
	if ((await readLocalDownloadIdentity(deps, path)) !== expected) {
		throw new Error(
			"Local file changed during download; reconciliation required",
		);
	}
}

/** Reject conflicting logical tree shapes before touching local objects. */
export function assertPortableLocalTree(
	deps: Dependencies,
	paths: string[],
): void {
	const local = deps.vaultAdapter.getLocalPathEntries?.();
	if (
		hasPortablePathCollision(
			[...paths, ...(local?.files ?? [])],
			local?.folders,
		)
	) {
		throw new PortablePathCollisionError();
	}
}

/** Apply already verified remote bytes and update both local/canonical views. */
export async function applyDownloadedContent(
	deps: Dependencies,
	path: string,
	content: ArrayBuffer,
	verified?: {
		serverMtime?: number;
		remoteFingerprint?: string;
	},
	expectedLocalSha?: string | null,
	validateAuthority?: () => Promise<void>,
): Promise<void> {
	await deps.indexManager.assertRemoteScope();
	await validateAuthority?.();
	const expected =
		expectedLocalSha === undefined
			? await readLocalDownloadIdentity(deps, path)
			: expectedLocalSha;
	await assertDownloadLocalUnchanged(deps, path, expected);

	const localIndexMeta = deps.indexManager.getLocalIndex().files[path];
	if (deps.vaultAdapter.fileExists(path)) {
		const existing = await deps.vaultAdapter.readFile(path);
		const existingSha = await computeSha256(existing);
		if (
			existingSha !== (await computeSha256(content)) &&
			existingSha !== localIndexMeta?.sha256
		) {
			await deps.vaultAdapter.backupOverwrittenFile(path, existing);
		}
	}

	await assertDownloadLocalUnchanged(deps, path, expected);
	assertPortableLocalTree(deps, [path]);
	await deps.vaultAdapter.writeFile(path, content, {
		expectedSha256: expected,
		validateBeforeWrite: async () => {
			await deps.indexManager.assertRemoteScope();
			await validateAuthority?.();
		},
		beforeWrite: () => deps.expectWatcherEvent(path, "upload"),
	});

	// Update indexes
	const sha256 = await computeSha256(content);
	const mtime = deps.vaultAdapter.getFileMtime(path) || Date.now();
	const remoteStamp = verified?.remoteFingerprint
		? {
				remoteMtime: verified.serverMtime,
				remoteFingerprint: verified.remoteFingerprint,
			}
		: await fetchRemoteStamp(deps, path);
	const remoteMtime = verified?.serverMtime ?? remoteStamp.remoteMtime;

	const metadata: FileMetadata = {
		path,
		sha256,
		size: content.byteLength,
		mtime,
		syncedAt: Date.now(),
		remoteMtime,
		remoteFingerprint: remoteStamp.remoteFingerprint,
	};
	const canonicalMetadata = deps.indexManager.getRemoteIndex().files[path];
	if (
		canonicalMetadata &&
		!canonicalMetadata.deleted &&
		canonicalMetadata.sha256 === sha256
	) {
		deps.indexManager.updateLocalFile(
			path,
			createConfirmedBaseline(metadata, metadata, canonicalMetadata),
		);
		return;
	}
	const externalMutation =
		deps.indexManager.findPendingMatchingPut(path, sha256, "last") ??
		deps.indexManager.enqueueMutation("put", path, {
			sha256,
			baselineSha256: canonicalMetadata?.sha256,
		});

	deps.indexManager.updateLocalFile(path, {
		...metadata,
		mutationSeq: externalMutation.seq,
	});
	deps.indexManager.updateRemoteFile(path, {
		...metadata,
		mutationSeq: externalMutation.seq,
	});
	deps.indexManager.stageMutation(externalMutation);
}

/** Fetch the server-side modification time for a remote file. Returns undefined when the resource cannot be read (e.g. it was concurrently deleted) or the modified timestamp is not parseable. Callers treat undefined as "no remoteMtime known" and fall back to legacy logic. */
export async function fetchRemoteStamp(
	deps: Dependencies,
	path: string,
): Promise<{
	remoteMtime?: number;
	remoteFingerprint?: string;
}> {
	try {
		const remotePath = joinPath(deps.settings.remotePath, path);
		const resource = await deps.yandexClient.getLogicalResource(remotePath);
		if (!resource) {
			return {};
		}
		const ts = new Date(resource.modified).getTime();
		return {
			remoteMtime: Number.isFinite(ts) ? ts : undefined,
			remoteFingerprint:
				getPhysicalResourceFingerprint(resource) ?? undefined,
		};
	} catch (e) {
		logger.debug(`Failed to fetch remote stamp for ${path}:`, {
			error: e,
		});
		return {};
	}
}

export type PhysicalActionOutcome = "completed" | "cancelled" | "deferred";

/** Stop a retried request without confusing revoked authority with a transport error. */
class PhysicalActionStopped extends Error {
	constructor(readonly outcome: PhysicalActionOutcome) {
		super(`Physical action ${outcome}`);
	}
}

/** Delete only while every attempt has current canonical and physical authority. */
export async function deleteRemoteFile(
	deps: Dependencies,
	path: string,
): Promise<PhysicalActionOutcome> {
	const action = requirePhysicalAction(deps, "delete-remote", path);
	const remotePath = joinPath(deps.settings.remotePath, path);
	const revalidate = async (): Promise<void> => {
		const canonical = await deps.indexManager.readCanonicalIndex();
		if (canonical.maintenance) {
			throw new PhysicalActionStopped("deferred");
		}
		if (!isPhysicalDeleteAuthorized(action, canonical)) {
			const waitsForTarget =
				action.origin === "rejected-upload" &&
				action.epoch === canonical.epoch &&
				canonical.files[path] === undefined &&
				action.targetPath !== undefined &&
				canonical.files[action.targetPath] === undefined;
			if (!waitsForTarget) {
				deps.indexManager.completePhysicalAction(action.id);
			}
			throw new PhysicalActionStopped(
				waitsForTarget ? "deferred" : "cancelled",
			);
		}
		const resource = await deps.yandexClient.getLogicalResource(remotePath);
		if (!resource) {
			deps.indexManager.completePhysicalAction(action.id);
			throw new PhysicalActionStopped("completed");
		}
		if (
			classifyPhysicalDeleteResource(
				action.expectedFingerprint,
				resource,
			) !== "match"
		) {
			throw new PhysicalActionStopped("deferred");
		}
	};
	try {
		await deps.yandexClient.deleteResource(
			remotePath,
			false,
			false,
			revalidate,
		);
	} catch (error) {
		if (error instanceof PhysicalActionStopped) {
			return error.outcome;
		}
		throw error;
	}
	if (await deps.yandexClient.getLogicalResource(remotePath)) {
		throw new Error(`Remote deletion of ${path} was not confirmed`);
	}
	deps.indexManager.completePhysicalAction(action.id);
	logger.info(
		"Remote physical deletion confirmed",
		getPhysicalActionLogContext(action, path),
	);
	return "completed";
}

/** Delete local file */
export async function deleteLocalFile(
	deps: Dependencies,
	path: string,
	validateAuthority?: () => Promise<void>,
): Promise<PhysicalActionOutcome> {
	const physicalAction = requirePhysicalAction(deps, "delete-local", path);
	const actionContext = {
		...getPhysicalActionLogContext(physicalAction, path),
		expectedChangedRevision: physicalAction.expectedChangedRevision,
		baselineSha256: shortenDiagnosticValue(physicalAction.baselineSha256),
		path,
	};
	logger.info("Local physical deletion started", actionContext);
	const canonical = await deps.indexManager.readCanonicalIndex();
	if (!isPhysicalDeleteAuthorized(physicalAction, canonical)) {
		deps.indexManager.completePhysicalAction(physicalAction.id);
		logger.warn("Cancelled obsolete local deletion", {
			...actionContext,
			currentEpoch: shortenDiagnosticValue(canonical.epoch),
			currentRevision: canonical.revision,
			currentChangedRevision: canonical.files[path]?.changedRevision,
			currentDeleted: canonical.files[path]?.deleted ?? null,
		});
		return "cancelled";
	}

	const expected = await readLocalDownloadIdentity(deps, path);
	const baseline = deps.indexManager.getLocalIndex().files[path];
	if (deps.vaultAdapter.fileExists(path)) {
		try {
			const content = await deps.vaultAdapter.readFile(path);
			const sha256 = await computeSha256(content);
			const baselineSha256 =
				physicalAction.baselineSha256 ??
				(physicalAction.origin === "rejected-upload"
					? undefined
					: baseline?.sha256);
			if (shouldBackupLocalDelete(sha256, baselineSha256)) {
				logger.info("Backing up changed local file before deletion", {
					...actionContext,
					currentSha256: shortenDiagnosticValue(sha256),
				});
				await deps.vaultAdapter.backupOverwrittenFile(path, content);
			}
		} catch (e) {
			throw new Error(
				`Could not safely delete ${path}: ${(e as Error).message}`,
			);
		}
	}
	const latest = await deps.indexManager.readCanonicalIndex();
	if (!isPhysicalDeleteAuthorized(physicalAction, latest)) {
		deps.indexManager.completePhysicalAction(physicalAction.id);
		return "cancelled";
	}
	await validateAuthority?.();
	if ((await readLocalDownloadIdentity(deps, path)) !== expected) {
		return "deferred";
	}
	if (expected === null) {
		deps.indexManager.completePhysicalAction(physicalAction.id);
		return "completed";
	}
	deps.expectWatcherEvent(path, "delete");
	await deps.vaultAdapter.deleteFile(path);
	if (deps.vaultAdapter.fileExists(path)) {
		throw new Error(`Local deletion of ${path} was not confirmed`);
	}
	deps.indexManager.completePhysicalAction(physicalAction.id);
	logger.info("Local physical deletion confirmed", actionContext);

	// Prune local ancestor folders that became empty after this deletion,
	// so the local tree mirrors the remote tree after a delete sync. Only
	// truly empty folders are trashed (recoverable).
	try {
		await deps.vaultAdapter.pruneEmptyLocalAncestors(path);
	} catch (e) {
		logger.warn(`Failed to prune empty local ancestors for ${path}:`, {
			error: e,
		});
	}
	return "completed";
}

/** Return a durable physical action or fail before destructive work. */
export function requirePhysicalAction(
	deps: Dependencies,
	type: PendingPhysicalAction["type"],
	path: string,
): PendingPhysicalAction {
	const action = deps.indexManager.getPendingPhysicalAction(type, path);
	if (!action) {
		throw new Error(
			`Refusing to process ${path} without a pending physical action`,
		);
	}
	return action;
}

/** Build the common secret-safe physical-action log context. */
export function getPhysicalActionLogContext(
	action: PendingPhysicalAction,
	path: string,
): Record<string, unknown> {
	return {
		actionId: action.id,
		actionType: action.type,
		origin: action.origin,
		epoch: shortenDiagnosticValue(action.epoch),
		canonicalRevision: action.canonicalRevision,
		path,
	};
}

/** Update progress and ensure upload destination folders exist. */
export async function prepareOperationFolders(
	deps: Dependencies,
	operations: SyncOperation[],
): Promise<void> {
	deps.setSyncPhase("creating-folders");
	await ensureFoldersExist(deps, operations);
}

/** Ensure all necessary folders exist before operations. */
export async function ensureFoldersExist(
	deps: Dependencies,
	operations: SyncOperation[],
	concurrency = 1,
): Promise<void> {
	const folders = new Set<string>();

	for (const op of operations) {
		// Only uploads need their destination folders ensured on remote — the
		// source folder for a download already exists by definition, and
		// creating it here wastes API calls and, under encryption, creates
		// no-op encrypted folder entries. Conflict copies create their own
		// folder at upload time (uploadFile with default skipFolderCheck).
		if (op.action === "upload") {
			const remotePath = joinPath(deps.settings.remotePath, op.path);
			const dir = getDirectory(remotePath);
			if (dir) {
				folders.add(dir);
			}
		}
	}

	if (folders.size > 0) {
		logger.info(`Ensuring ${folders.size} folders exist...`);
		const folderPaths: string[] = [];
		folders.forEach((folder: string) => {
			folderPaths.push(folder);
		});
		await deps.yandexClient.ensureFoldersExist(folderPaths, concurrency);
	}
}

/** Remote recursive deletion cannot preserve descendants arriving after an emptiness check. */
export async function pruneRemoteFolders(
	_deps: Dependencies,
	_localPaths: string[],
): Promise<void> {
	// Keep ordinary file settlement independent from optional, unsafe directory pruning.
}

/** Execute operations in parallel with concurrency control */
export async function executeOperationsParallel(
	deps: Dependencies,
	operations: SyncOperation[],
	onProgress?: (completed: number) => void,
): Promise<{ succeeded: number; errors: SyncError[] }> {
	const tasks = operations.map((op) => async () => {
		if (deps.isPaused) {
			throw new Error("Synchronization interrupted");
		}

		let outcome: PhysicalActionOutcome = "completed";
		switch (op.action) {
			case "upload": {
				// Skip folder check since we pre-created all folders, and
				// skip per-file server mtime fetch — the caller performs a
				// single batch re-read of the remote file list after the
				// upload group via `applyServerMtimes`.
				const expected =
					deps.indexManager.getRemoteIndex().files[op.path];
				const expectedEpoch = deps.indexManager.getRemoteIndex().epoch;
				const guard = await deps.getSyncGuardResult(
					deps.validationToken,
				);
				if (guard.blockReason) {
					throw new Error(guard.blockReason);
				}
				const content = await deps.vaultAdapter.readFile(op.path);
				const sha256 = await computeSha256(content);
				if (op.localMeta && sha256 !== op.localMeta.sha256) {
					throw new Error("Local file changed after full scan");
				}
				const assertAuthority = async () => {
					const validate = async (
						observation?: RemoteAuthorityObservation,
					) => {
						const currentGuard = await deps.getSyncGuardResult(
							guard.validationToken,
							observation,
						);
						if (currentGuard.blockReason) {
							throw new Error(currentGuard.blockReason);
						}
					};
					let canonical;
					if (deps.canonicalReadSession) {
						canonical = await deps.canonicalReadSession(validate);
					} else {
						await validate();
						canonical =
							await deps.indexManager.readCanonicalIndex();
					}
					const current = canonical.files[op.path];
					if (
						canonical.epoch !== expectedEpoch ||
						current?.sha256 !== expected?.sha256 ||
						current?.changedRevision !==
							expected?.changedRevision ||
						current?.deleted !== expected?.deleted
					) {
						throw new Error("Canonical changed before full upload");
					}
				};
				await uploadFile(
					deps,
					op.path,
					true,
					false,
					{ content, sha256 },
					async () => {
						await assertAuthority();
						const physical =
							await deps.yandexClient.getLogicalResource(
								joinPath(deps.settings.remotePath, op.path),
							);
						if (
							op.remoteMeta
								? !matchesPhysicalResourceFingerprint(
										op.remoteMeta.remoteFingerprint,
										physical,
									)
								: physical !== null
						) {
							throw new Error(
								"Physical file changed before full upload",
							);
						}
						deps.canonicalReadSession?.assertCurrent();
					},
					() =>
						confirmUploadedSnapshot(
							deps,
							op.path,
							sha256,
							assertAuthority,
							guard.validationToken,
						),
				);
				break;
			}
			case "download":
				await downloadFile(
					deps,
					op.path,
					op.remoteMeta?.remoteMtime ?? op.remoteMeta?.mtime,
					op.localMeta?.sha256 ?? null,
				);
				break;
			case "delete_remote":
				outcome = await deleteRemoteFile(deps, op.path);
				break;
			case "delete_local":
				outcome = await deleteLocalFile(deps, op.path);
				if (op.remoteMeta && outcome === "completed") {
					outcome = await deleteRemoteFile(deps, op.path);
				}
				break;
		}
		if (outcome === "deferred") {
			throw new Error("Physical action remains unresolved");
		}
		return outcome === "completed";
	});

	const concurrency: number =
		typeof deps.settings.maxConcurrency === "number"
			? deps.settings.maxConcurrency
			: 5;
	const results = await runWithConcurrencySettled(
		tasks,
		concurrency,
		onProgress,
		{
			stopOnError: isRemoteReadTimeout,
			onError: (reason, index) => {
				const operation = operations[index];
				if (operation) {
					const error =
						reason instanceof Error
							? reason
							: new Error(String(reason));
					deps.onOperationError?.(
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

	const errors: SyncError[] = [];
	let succeeded = 0;

	for (let i = 0; i < results.length; i++) {
		const res = results[i];
		const op = operations[i];

		if (!res || !op) {
			continue;
		}

		if (res.status === "rejected") {
			errors.push(createSyncError(res.reason, op.path, op.action));
			logger.error(
				`Error executing ${op.action} operation for ${op.path}:`,
				{ error: res.reason },
			);
		} else if (res.value) {
			succeeded++;
		}
	}

	return { succeeded, errors };
}
