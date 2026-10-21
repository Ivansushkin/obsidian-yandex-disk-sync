import { VaultAdapter, LocalFileChangedError } from "../../api/vault-adapter";
import {
	YandexDiskClient,
	type StableLogicalFileSnapshot,
} from "../../api/yandex-client";
import type {
	FileMetadata,
	IndexMove,
	PendingMutation,
	SyncOperation,
	SyncResult,
	SyncIndex,
	YandexDiskSyncSettings,
} from "../../types";
import { findErrorCause } from "../../utils/error-utils";
import { computeSha256 } from "../../utils/hash-utils";
import { logger, shortenDiagnosticValue } from "../../utils/logger";
import { getExtension, joinPath } from "../../utils/path-utils";
import { setRecordValue } from "../../utils/record-utils";
import {
	getPhysicalResourceFingerprint,
	matchesPhysicalResourceFingerprint,
} from "../../utils/resource-fingerprint";
import { runWithConcurrencySettled } from "../../utils/semaphore";
import { createConfirmedBaseline } from "../local/baseline-rules";
import { ConflictResolver } from "./conflicts";
import * as fileOperations from "../files/operations";
import {
	IndexEpochMismatchError,
	IndexManager,
	RemoteIndexTransactionError,
} from "../canonical/manager";
import { canApplyDestructiveFolderMutation } from "../canonical/mutation-rules";
import type { CanonicalCommitProof } from "../canonical/transaction";
import * as remoteMoves from "../files/remote-moves";
import type { IndexSaveCallback, SyncGuardResult } from "../contracts";
import * as syncErrors from "../errors";
export interface Dependencies {
	indexManager: IndexManager;
	indexSaveCallback: IndexSaveCallback | null;
	realtimeGuardValidationToken: string | undefined;
	getSyncGuardResult: (
		skipGuard?: boolean,
		validationToken?: string,
		validateThroughExternalBlock?: boolean,
	) => Promise<SyncGuardResult>;
	setBlockedState: (
		reason: string,
		status?: "error" | "migration-required" | "encryption-required",
	) => void;
	epochReplacementPending: boolean;
	vaultAdapter: VaultAdapter;
	settings: YandexDiskSyncSettings;
	yandexClient: YandexDiskClient;
	conflictResolver: ConflictResolver;
	expectWatcherEvent: (
		path: string,
		action: "upload" | "delete" | "rename",
	) => void;
	fileOperations: fileOperations.Dependencies;
	remoteMoves: remoteMoves.Dependencies;
}

/** Verify one plaintext version while canonical authority and codec remain stable. */
async function readVerifiedRemoteVersion(
	deps: Dependencies,
	path: string,
): Promise<{
	canonical: SyncIndex;
	snapshot: StableLogicalFileSnapshot;
	sha256: string;
}> {
	const guard = await deps.getSyncGuardResult(false);
	if (guard.blockReason) {
		throw new Error(guard.blockReason);
	}
	const before = await deps.indexManager.readCanonicalIndex();
	const snapshot = await deps.yandexClient.downloadStableLogicalFile(
		joinPath(deps.settings.remotePath, path),
	);
	if (!snapshot) {
		throw new Error("Remote conflict version is not physically available");
	}
	const canonical = await deps.indexManager.readCanonicalIndex();
	const expected = before.files[path];
	const current = canonical.files[path];
	if (
		before.epoch !== canonical.epoch ||
		expected?.sha256 !== current?.sha256 ||
		expected?.changedRevision !== current?.changedRevision ||
		expected?.deleted !== current?.deleted
	) {
		throw new Error("Canonical changed during content verification");
	}
	const unchanged = await deps.getSyncGuardResult(
		false,
		guard.validationToken,
	);
	if (unchanged.blockReason) {
		throw new Error(unchanged.blockReason);
	}
	return {
		canonical,
		snapshot,
		sha256: await computeSha256(snapshot.content),
	};
}

/** Require accepted logical and physical copy bytes before replacing another version. */
async function assertRetainedConflictCopy(
	deps: Dependencies,
	path: string,
	sha256: string,
	epoch: string,
): Promise<void> {
	const retained = await readVerifiedRemoteVersion(deps, path);
	const canonical = retained.canonical.files[path];
	if (
		retained.canonical.epoch !== epoch ||
		!canonical ||
		canonical.deleted ||
		canonical.sha256 !== sha256 ||
		retained.sha256 !== sha256
	) {
		throw new Error(
			"Conflict copy was not retained by canonical and physical storage",
		);
	}
}

/** Resolve metadata uncertainty using stable plaintext without retaining vault-sized buffers. */
export async function verifyRemoteContentCandidates(
	deps: Dependencies,
	localFiles: Map<string, FileMetadata>,
	remoteFiles: Map<string, FileMetadata>,
): Promise<boolean> {
	let changed = false;
	const index = deps.indexManager.getRemoteIndex();
	let guard: SyncGuardResult | undefined;
	for (const [path, local] of localFiles) {
		const remote = remoteFiles.get(path);
		const canonical = index.files[path];
		if (
			!remote ||
			canonical?.deleted ||
			(local.sha256 === remote.sha256 &&
				canonical?.sha256 === local.sha256 &&
				canonical.remoteFingerprint === remote.remoteFingerprint &&
				canonical.remoteMtime === remote.remoteMtime)
		) {
			continue;
		}
		if (
			canonical &&
			remote.sha256 &&
			canonical.remoteFingerprint === remote.sha256 &&
			canonical.remoteMtime === remote.remoteMtime
		) {
			remoteFiles.set(path, { ...remote, sha256: canonical.sha256 });
			continue;
		}
		guard ??= await deps.getSyncGuardResult(false);
		if (guard.blockReason) {
			throw new Error(guard.blockReason);
		}
		const snapshot = await deps.yandexClient.downloadStableLogicalFile(
			joinPath(deps.settings.remotePath, path),
		);
		if (!snapshot) {
			throw new Error(
				"Remote content cannot be verified for reconciliation",
			);
		}
		const sha256 = await computeSha256(snapshot.content);
		await fileOperations.assertDownloadLocalUnchanged(
			deps.fileOperations,
			path,
			local.sha256,
		);
		remoteFiles.set(path, {
			...remote,
			sha256,
			remoteFingerprint:
				getPhysicalResourceFingerprint(snapshot.resource) ?? undefined,
			remoteMtime: new Date(snapshot.resource.modified).getTime(),
		});
		if (canonical && canonical.sha256 === sha256) {
			const verified = remoteFiles.get(path)!;
			if (
				canonical.remoteFingerprint !== verified.remoteFingerprint ||
				canonical.remoteMtime !== verified.remoteMtime
			) {
				index.files[path] = {
					...canonical,
					remoteFingerprint: verified.remoteFingerprint,
					remoteMtime: verified.remoteMtime,
				};
				changed = true;
			}
		}
	}
	if (!guard) {
		return changed;
	}
	const current = await deps.getSyncGuardResult(false, guard.validationToken);
	if (current.blockReason) {
		throw new Error(current.blockReason);
	}
	await deps.indexManager.assertCanonicalEpoch(index.epoch);
	return changed;
}

/** Return whether a full session still has guarded physical work to resume. */
export function hasPendingPhysicalWork(deps: Dependencies): boolean {
	return (
		deps.indexManager.getPendingPhysicalActions().length > 0 ||
		Object.values(deps.indexManager.getRemoteIndex().moves).some(
			(move) => move.pending,
		)
	);
}

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
		const proof = await deps.indexManager.saveRemoteIndex();
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

/** Repair only a missing physical object after its put won the canonical merge. A changed existing object is left for causal reconciliation. */
export async function repairMissingAcceptedUploads(
	deps: Dependencies,
	items: Array<
		| string
		| {
				path: string;
				snapshot?: { content: ArrayBuffer; sha256: string };
		  }
	>,
	commitProof?: CanonicalCommitProof,
	validationToken = deps.realtimeGuardValidationToken,
): Promise<void> {
	if (items.length === 0) {
		return;
	}
	const canonical =
		await deps.indexManager.readCanonicalIndexForRepair(commitProof);
	let repaired = false;
	const snapshots = new Map<
		string,
		{ content: ArrayBuffer; sha256: string }
	>();
	for (const item of items) {
		if (typeof item !== "string" && item.snapshot) {
			snapshots.set(item.path, item.snapshot);
		}
	}
	const paths = new Set(
		items.map((item) => (typeof item === "string" ? item : item.path)),
	);
	for (const path of paths) {
		let accepted = canonical.files[path];
		if (!accepted || accepted.deleted) {
			continue;
		}
		let snapshot = snapshots.get(path);
		if (!snapshot && deps.vaultAdapter.fileExists(path)) {
			const content = await deps.vaultAdapter.readFile(path);
			snapshot = { content, sha256: await computeSha256(content) };
		}
		if (!snapshot || snapshot.sha256 !== accepted.sha256) {
			continue;
		}
		const remotePath = joinPath(deps.settings.remotePath, path);
		const physical = await deps.yandexClient.getLogicalResource(remotePath);
		let repairFingerprint =
			getPhysicalResourceFingerprint(physical) ?? undefined;
		let retainedCopy: { path: string; sha256: string } | undefined;
		const physicalMatches =
			physical !== null &&
			accepted.remoteFingerprint !== undefined &&
			matchesPhysicalResourceFingerprint(
				accepted.remoteFingerprint,
				physical,
			);
		if (physicalMatches) {
			continue;
		}
		const freshCanonical = await deps.indexManager.readCanonicalIndex();
		const currentlyAuthorized = freshCanonical.files[path];
		if (freshCanonical.maintenance !== undefined) {
			throw new Error(
				"Encryption maintenance started before physical upload repair",
			);
		}
		if (
			freshCanonical.epoch !== canonical.epoch ||
			!currentlyAuthorized ||
			currentlyAuthorized.deleted ||
			currentlyAuthorized.sha256 !== accepted.sha256
		) {
			logger.info(
				"Post-commit upload repair cancelled by newer canonical state",
				{
					committedEpoch: shortenDiagnosticValue(canonical.epoch),
					currentEpoch: shortenDiagnosticValue(freshCanonical.epoch),
					committedRevision: canonical.revision,
					currentRevision: freshCanonical.revision,
				},
			);
			continue;
		}
		if (validationToken !== undefined) {
			const guard = await deps.getSyncGuardResult(false, validationToken);
			if (guard.blockReason) {
				throw new Error(
					"Encryption state changed before physical upload repair",
				);
			}
		}
		accepted = currentlyAuthorized;
		if (physical) {
			const verified = await readVerifiedRemoteVersion(deps, path);
			repairFingerprint =
				getPhysicalResourceFingerprint(verified.snapshot.resource) ??
				undefined;
			const remoteContent = verified.snapshot.content;
			const remoteSha256 = verified.sha256;
			if (remoteSha256 !== accepted.sha256) {
				const conflictPath = await preserveLocalConflictCopy(
					deps,
					path,
					remoteContent,
				);
				await uploadCausalConflictCopy(
					deps,
					conflictPath,
					remoteContent,
				);
				if (!(await saveRemoteIndexBestEffort(deps))) {
					throw new Error(
						"Physical repair conflict copy was not committed",
					);
				}
				retainedCopy = { path: conflictPath, sha256: remoteSha256 };
			} else {
				const remoteFingerprint =
					getPhysicalResourceFingerprint(physical) ?? undefined;
				const remoteMtime = new Date(physical.modified).getTime();
				setRecordValue(deps.indexManager.getRemoteIndex().files, path, {
					...accepted,
					remoteMtime: Number.isFinite(remoteMtime)
						? remoteMtime
						: accepted.remoteMtime,
					remoteFingerprint,
				});
				repaired = true;
				continue;
			}
		}
		setRecordValue(deps.indexManager.getRemoteIndex().files, path, {
			...accepted,
		});
		const uploadGuard = await deps.getSyncGuardResult(
			false,
			validationToken,
		);
		if (uploadGuard.blockReason) {
			throw new Error(uploadGuard.blockReason);
		}
		const uploadValidationToken =
			validationToken ?? uploadGuard.validationToken;
		const assertAuthority = async () => {
			if (retainedCopy) {
				await assertRetainedConflictCopy(
					deps,
					retainedCopy.path,
					retainedCopy.sha256,
					canonical.epoch,
				);
			}
			const guard = await deps.getSyncGuardResult(
				false,
				uploadValidationToken,
			);
			if (guard.blockReason) {
				throw new Error(guard.blockReason);
			}
			const latest = await deps.indexManager.readCanonicalIndex();
			const current = latest.files[path];
			if (
				latest.maintenance ||
				latest.epoch !== canonical.epoch ||
				!current ||
				current.deleted ||
				current.sha256 !== accepted.sha256 ||
				current.changedRevision !== accepted.changedRevision
			) {
				throw new Error("Canonical changed before corrective upload");
			}
		};
		const uploaded = await fileOperations.materializeUploadedFile(
			deps.fileOperations,
			path,
			snapshot,
			false,
			true,
			async () => {
				await assertAuthority();
				const actual =
					await deps.yandexClient.getLogicalResource(remotePath);
				if (
					physical
						? !matchesPhysicalResourceFingerprint(
								repairFingerprint,
								actual,
							)
						: actual !== null
				) {
					throw new Error(
						"Physical version changed before corrective upload",
					);
				}
			},
			() =>
				fileOperations.confirmUploadedSnapshot(
					deps.fileOperations,
					path,
					snapshot.sha256,
					assertAuthority,
					uploadValidationToken,
				),
		);
		deps.indexManager.updateLocalFile(
			path,
			createConfirmedBaseline(uploaded, uploaded, accepted),
		);
		setRecordValue(deps.indexManager.getRemoteIndex().files, path, {
			...accepted,
			remoteFingerprint: uploaded.remoteFingerprint,
			remoteMtime: uploaded.remoteMtime,
		});
		repaired = true;
	}
	if (repaired && !(await saveMoveCompletionBestEffort(deps))) {
		throw new Error(
			"Repaired uploads could not be confirmed in canonical index",
		);
	}
}

/** Remove a put rejected by a concurrent tombstone only when the live server object is still the exact upload that lost the merge. */
export async function cleanupRejectedUploads(
	deps: Dependencies,
): Promise<void> {
	for (const rejected of deps.indexManager.consumeRejectedPuts()) {
		if (rejected.reason === "conflict") {
			await preserveRejectedConcurrentPut(deps, rejected.path);
			continue;
		}
		if (deps.vaultAdapter.fileExists(rejected.path)) {
			deps.indexManager.enqueuePhysicalAction(
				"delete-local",
				rejected.path,
				{
					canonicalRevision:
						deps.indexManager.getRemoteIndex().revision,
					origin: "rejected-upload",
					baselineSha256: rejected.baselineSha256,
				},
			);
			if (deps.indexSaveCallback) {
				await deps.indexSaveCallback();
			}
			const outcome = await fileOperations.deleteLocalFile(
				deps.fileOperations,
				rejected.path,
			);
			if (outcome === "completed") {
				deps.indexManager.markLocalFileDeleted(rejected.path);
			}
			if (deps.indexSaveCallback) {
				await deps.indexSaveCallback();
			}
			if (outcome !== "completed") {
				continue;
			}
		}
		try {
			deps.indexManager.enqueuePhysicalAction(
				"delete-remote",
				rejected.path,
				{
					canonicalRevision:
						deps.indexManager.getRemoteIndex().revision,
					expectedFingerprint: rejected.remoteFingerprint,
					origin: "rejected-upload",
				},
			);
			await fileOperations.deleteRemoteFile(
				deps.fileOperations,
				rejected.path,
			);
		} catch (e) {
			logger.warn(
				`Could not clean up rejected upload ${rejected.path}:`,
				{ error: e },
			);
		}
	}
}

/** Preserve the losing side of a concurrent live put as a conflict copy, then restore the canonical winner at the original path. */
export async function preserveRejectedConcurrentPut(
	deps: Dependencies,
	path: string,
): Promise<void> {
	if (!deps.vaultAdapter.fileExists(path)) {
		return;
	}
	const localContent = await deps.vaultAdapter.readFile(path);
	const localSha256 = await computeSha256(localContent);
	const currentCanonical = await deps.indexManager.readCanonicalIndex();
	const conflictPath = await preserveLocalConflictCopy(
		deps,
		path,
		localContent,
	);
	const retained = currentCanonical.files[conflictPath];
	if (!retained || retained.deleted || retained.sha256 !== localSha256) {
		const mutation = await uploadCausalConflictCopy(
			deps,
			conflictPath,
			localContent,
		);
		if (!(await saveRemoteIndexBestEffort(deps))) {
			throw new Error(`Could not commit conflict copy for ${path}`);
		}
		if (mutation) {
			deps.indexManager.confirmMutation(mutation.id);
		}
	}

	await assertRetainedConflictCopy(
		deps,
		conflictPath,
		localSha256,
		currentCanonical.epoch,
	);
	const canonical = await deps.indexManager.readCanonicalIndex();
	const winner = canonical.files[path];
	if (!winner || winner.deleted) {
		return;
	}
	const remotePath = joinPath(deps.settings.remotePath, path);
	const physical = await deps.yandexClient.getLogicalResource(remotePath);
	if (
		!physical ||
		(winner.remoteFingerprint &&
			!matchesPhysicalResourceFingerprint(
				winner.remoteFingerprint,
				physical,
			))
	) {
		throw new Error(
			`Canonical winner for ${path} is not physically available yet`,
		);
	}
	await fileOperations.downloadFile(
		deps.fileOperations,
		path,
		new Date(physical.modified).getTime(),
	);
}

/** Handle conflict */
export async function handleConflict(
	deps: Dependencies,
	op: SyncOperation,
): Promise<void> {
	logger.warn(`Handling conflict: ${op.path}`);

	if (!op.localMeta || !op.remoteMeta) {
		return;
	}
	const localContent = await deps.vaultAdapter.readFile(op.path);
	const localSha256 = await computeSha256(localContent);
	if (localSha256 !== op.localMeta.sha256) {
		throw new Error("Local file changed after conflict classification");
	}
	logger.debug("Conflict stage", { stage: "read-remote-version" });
	const remote = await readVerifiedRemoteVersion(deps, op.path);
	if (remote.canonical.files[op.path]?.deleted) {
		throw new Error("Canonical deletion superseded the conflict");
	}
	if (remote.sha256 === localSha256) {
		logger.debug("Conflict stage", { stage: "apply-winner" });
		await fileOperations.applyDownloadedContent(
			deps.fileOperations,
			op.path,
			remote.snapshot.content,
			{
				remoteFingerprint:
					getPhysicalResourceFingerprint(remote.snapshot.resource) ??
					undefined,
				serverMtime: new Date(
					remote.snapshot.resource.modified,
				).getTime(),
			},
			localSha256,
		);
		return;
	}
	logger.debug("Conflict stage", { stage: "preserve-local-copy" });
	const conflictPath = await preserveLocalConflictCopy(
		deps,
		op.path,
		localContent,
	);
	logger.debug("Conflict stage", { stage: "upload-copy" });
	await uploadCausalConflictCopy(deps, conflictPath, localContent);
	logger.debug("Conflict stage", { stage: "commit-copy" });
	if (!(await saveRemoteIndexBestEffort(deps))) {
		throw new Error("Conflict copy could not be committed");
	}
	logger.debug("Conflict stage", { stage: "verify-copy" });
	await assertRetainedConflictCopy(
		deps,
		conflictPath,
		localSha256,
		remote.canonical.epoch,
	);
	logger.debug("Conflict stage", { stage: "reread-winner" });
	const winner = await readVerifiedRemoteVersion(deps, op.path);
	if (
		winner.canonical.epoch !== remote.canonical.epoch ||
		winner.canonical.files[op.path]?.deleted ||
		winner.sha256 !== remote.sha256
	) {
		throw new Error("Winner changed after preserving conflict copy");
	}
	logger.debug("Conflict stage", { stage: "apply-winner" });
	await fileOperations.applyDownloadedContent(
		deps.fileOperations,
		op.path,
		winner.snapshot.content,
		{
			remoteFingerprint:
				getPhysicalResourceFingerprint(winner.snapshot.resource) ??
				undefined,
			serverMtime: new Date(winner.snapshot.resource.modified).getTime(),
		},
		localSha256,
	);
	logger.info(`Conflict resolved, copy retained: ${conflictPath}`);
}

/** Preserve a local version without overwriting a conflict copy edited since its canonical commit. */
export async function preserveLocalConflictCopy(
	deps: Dependencies,
	path: string,
	content: ArrayBuffer,
): Promise<string> {
	const sha256 = await computeSha256(content);
	const canonical = await deps.indexManager.readCanonicalIndex();
	const key = await computeSha256(
		new TextEncoder().encode(`${path}\0${sha256}`).buffer,
	);
	const base = deps.conflictResolver.generateConflictName(path, key);
	const extension = getExtension(base);
	const suffix = extension ? base.slice(-(extension.length + 1)) : "";
	const stem = suffix ? base.slice(0, -suffix.length) : base;
	for (let attempt = 0; attempt < 32; attempt++) {
		const candidate = attempt === 0 ? base : `${stem}_${attempt}${suffix}`;
		if (deps.vaultAdapter.folderExists(candidate)) {
			continue;
		}
		const physical = await deps.yandexClient.getLogicalResource(
			joinPath(deps.settings.remotePath, candidate),
		);
		if (physical?.type === "dir") {
			continue;
		}
		if (physical) {
			const verified = await deps.yandexClient.downloadStableLogicalFile(
				joinPath(deps.settings.remotePath, candidate),
				physical,
			);
			if (!verified) {
				throw new Error(
					"Conflict candidate changed while being reserved",
				);
			}
			if ((await computeSha256(verified.content)) !== sha256) {
				continue;
			}
		}
		if (deps.vaultAdapter.fileExists(candidate)) {
			if (
				(await computeSha256(
					await deps.vaultAdapter.readFile(candidate),
				)) === sha256 &&
				(!canonical.files[candidate] ||
					(!canonical.files[candidate]?.deleted &&
						canonical.files[candidate]?.sha256 === sha256))
			) {
				return candidate;
			}
			continue;
		}
		if (
			canonical.files[candidate] &&
			(canonical.files[candidate]?.deleted ||
				canonical.files[candidate]?.sha256 !== sha256)
		) {
			continue;
		}
		try {
			await deps.vaultAdapter.writeFile(candidate, content, {
				expectedSha256: null,
				validateBeforeWrite: () =>
					deps.indexManager.assertRemoteScope(),
				beforeWrite: () => deps.expectWatcherEvent(candidate, "upload"),
			});
			return candidate;
		} catch (error) {
			if (!(error instanceof LocalFileChangedError)) {
				throw error;
			}
			if (
				deps.vaultAdapter.fileExists(candidate) &&
				(await computeSha256(
					await deps.vaultAdapter.readFile(candidate),
				)) === sha256
			) {
				return candidate;
			}
		}
	}
	throw new Error("Could not reserve a free conflict path");
}

/** Confirm one retained version without replacing a competing physical copy. */
export async function uploadCausalConflictCopy(
	deps: Dependencies,
	path: string,
	content: ArrayBuffer,
): Promise<PendingMutation | null> {
	const sha256 = await computeSha256(content);
	const canonical = await deps.indexManager.readCanonicalIndex();
	const retained = canonical.files[path];
	if (retained?.deleted || (retained && retained.sha256 !== sha256)) {
		throw new Error(
			"Conflict path is reserved by another canonical version",
		);
	}
	const remotePath = joinPath(deps.settings.remotePath, path);
	let physical =
		await deps.yandexClient.downloadStableLogicalFile(remotePath);
	if (!physical) {
		try {
			await deps.yandexClient.uploadFileExclusive(remotePath, content);
		} catch (error) {
			physical =
				await deps.yandexClient.downloadStableLogicalFile(remotePath);
			if (!physical) {
				throw error;
			}
		}
		physical ??=
			await deps.yandexClient.downloadStableLogicalFile(remotePath);
	}
	if (!physical || (await computeSha256(physical.content)) !== sha256) {
		throw new Error("Conflict copy changed before confirmation");
	}
	const existing = deps.indexManager
		.getPendingMutations()
		.find(
			(item) =>
				item.type === "put" &&
				item.path === path &&
				item.sha256 === sha256,
		);
	if (retained && !existing) {
		deps.indexManager.updateLocalFile(path, retained);
		return null;
	}
	const mutation =
		existing ?? deps.indexManager.enqueueMutation("put", path, { sha256 });
	const metadata: FileMetadata = {
		path,
		sha256,
		size: content.byteLength,
		mtime: deps.vaultAdapter.getFileMtime(path) || Date.now(),
		syncedAt: Date.now(),
		remoteFingerprint:
			getPhysicalResourceFingerprint(physical.resource) ?? undefined,
		remoteMtime: new Date(physical.resource.modified).getTime(),
		mutationSeq: mutation.seq,
	};
	deps.indexManager.updateLocalFile(path, metadata);
	deps.indexManager.updateRemoteFile(path, {
		...metadata,
		baseRevision: mutation.baseRevision ?? canonical.revision,
	});
	deps.indexManager.stageMutation(mutation);
	if (deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}
	return mutation;
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
export function stageRecoveredMoveMutation(
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

/** Persist a local baseline for every path whose two live copies were confirmed equal and canonicalize an untracked physical match. */
export function recordConfirmedBaselines(
	deps: Dependencies,
	localFiles: Map<string, FileMetadata>,
	remoteFiles: Map<string, FileMetadata>,
	operations: SyncOperation[],
): boolean {
	const operatedPaths = new Set(
		operations.map((operation) => operation.path),
	);
	const remoteIndex = deps.indexManager.getRemoteIndex();
	let canonicalChanged = false;

	for (const [path, localMeta] of localFiles) {
		if (operatedPaths.has(path)) {
			continue;
		}
		const remoteMeta = remoteFiles.get(path);
		if (!remoteMeta) {
			continue;
		}
		const canonical = remoteIndex.files[path];
		const previousBaseline = deps.indexManager.getLocalIndex().files[path];
		const baseline = createConfirmedBaseline(
			localMeta,
			remoteMeta,
			canonical,
		);
		deps.indexManager.updateLocalFile(path, baseline);
		if (
			!canonical ||
			canonical.deleted ||
			canonical.sha256 !== baseline.sha256
		) {
			const existing = [...deps.indexManager.getPendingMutations()]
				.reverse()
				.find(
					(mutation) =>
						mutation.type === "put" &&
						mutation.path === path &&
						mutation.sha256 === baseline.sha256,
				);
			const mutation =
				existing ??
				deps.indexManager.enqueueMutation("put", path, {
					sha256: baseline.sha256,
					baselineSha256: previousBaseline?.sha256,
					baseRevision: remoteIndex.revision,
				});
			const causalBaseline = {
				...baseline,
				lastModifiedBy: deps.settings.deviceId,
				mutationSeq: mutation.seq,
				baseRevision: mutation.baseRevision ?? 0,
			};
			deps.indexManager.updateLocalFile(path, causalBaseline);
			deps.indexManager.updateRemoteFile(path, causalBaseline);
			canonicalChanged = true;
		}
	}
	return canonicalChanged;
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
