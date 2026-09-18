import { VaultAdapter } from "../../api/vault-adapter";
import { YandexDiskClient } from "../../api/yandex-client";
import type {
	FileMetadata,
	PendingMutation,
	PendingPhysicalAction,
	YandexDiskSyncSettings,
} from "../../types";
import { computeSha256 } from "../../utils/hash-utils";
import { logger, shortenDiagnosticValue } from "../../utils/logger";
import { joinPath } from "../../utils/path-utils";
import { setRecordValue } from "../../utils/record-utils";
import {
	getPhysicalResourceFingerprint,
	matchesPhysicalResourceFingerprint,
} from "../../utils/resource-fingerprint";
import { canApplyDestructiveFolderMutation } from "../canonical/mutation-rules";
import { createConfirmedBaseline } from "../local/baseline-rules";
import * as fileOperations from "./operations";
import { IndexManager } from "../canonical/manager";
import {
	classifyPostFullRename,
	selectFileRenamePlan,
	wasMutationApplied,
	wasPendingPutAccepted,
	wasRenameSourceCausallyLive,
	type DurableFileRenameEvent,
	type FileRenameOutcome,
	type WatcherCausalContext,
} from "../realtime/rules";
import * as remoteMoves from "./remote-moves";
import type { IndexSaveCallback, SyncGuardResult } from "../contracts";
import * as syncReconciliation from "../reconciliation/commits";
export interface Dependencies {
	getWatcherCausalContext: () => WatcherCausalContext;
	vaultAdapter: VaultAdapter;
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
	indexManager: IndexManager;
	epochReplacementPending: boolean;
	indexSaveCallback: IndexSaveCallback | null;
	settings: YandexDiskSyncSettings;
	yandexClient: YandexDiskClient;
	expectWatcherEvent: (
		path: string,
		action: "upload" | "delete" | "rename",
	) => void;
	syncReconciliation: syncReconciliation.Dependencies;
	fileOperations: fileOperations.Dependencies;
	remoteMoves: remoteMoves.Dependencies;
}

/** Resolve a causal rename while retaining unfinished physical moves for recovery. */
export async function renameFileNow(
	deps: Dependencies,
	oldPath: string,
	newPath: string,
	context: WatcherCausalContext = deps.getWatcherCausalContext(),
): Promise<FileRenameOutcome> {
	let targetSnapshot:
		{ content: ArrayBuffer; sha256: string; mtime: number } | undefined;
	if (deps.vaultAdapter.shouldSync(newPath)) {
		if (!deps.vaultAdapter.fileExists(newPath)) {
			return {
				status: "retry",
				canonicalRevision: null,
				epoch: context.epoch,
				reason: "target-missing-before-remote",
				remoteStarted: false,
			};
		}
		try {
			const content = await deps.vaultAdapter.readFile(newPath);
			targetSnapshot = {
				content,
				sha256: await computeSha256(content),
				mtime: deps.vaultAdapter.getFileMtime(newPath) || Date.now(),
			};
		} catch (error) {
			logger.warn("File rename target snapshot is not available", {
				oldPath,
				newPath,
				error,
			});
			return {
				status: "retry",
				canonicalRevision: null,
				epoch: context.epoch,
				reason: "target-read-failed-before-remote",
				remoteStarted: false,
			};
		}
	}
	const { blockReason, validationToken } =
		await deps.getSyncGuardResult(false);
	if (blockReason) {
		logger.warn(`[SyncEngine] Skipping rename ${oldPath}: ${blockReason}`);
		deps.setBlockedState(blockReason);
		return {
			status: "retry",
			canonicalRevision: null,
			epoch: context.epoch,
			reason: blockReason,
			remoteStarted: true,
		};
	}
	deps.realtimeGuardValidationToken = validationToken;

	if (!deps.vaultAdapter.shouldSync(newPath)) {
		if (deps.vaultAdapter.shouldSync(oldPath)) {
			const mutation = deps.indexManager.enqueueMutation(
				"delete-file",
				oldPath,
				context,
			);
			deps.indexManager.markRemoteFileDeleted(
				oldPath,
				undefined,
				mutation.baseRevision ?? 0,
				mutation.seq,
			);
			deps.indexManager.enqueuePhysicalAction("delete-remote", oldPath, {
				expectedFingerprint:
					deps.indexManager.getRemoteIndex().files[oldPath]
						?.remoteFingerprint,
				origin: "exact-delete",
			});
			deps.indexManager.stageMutation(mutation);
			if (
				!(await syncReconciliation.saveRemoteIndexBestEffort(
					deps.syncReconciliation,
				))
			) {
				return {
					status: "retry",
					plan: "delete-source",
					canonicalRevision:
						deps.indexManager.getRemoteIndex().revision,
					epoch: deps.indexManager.getRemoteIndex().epoch,
					reason: deps.epochReplacementPending
						? "epoch-replaced"
						: "canonical-commit-not-confirmed",
					remoteStarted: true,
					requiresFullSync: deps.epochReplacementPending
						? "epoch-replaced"
						: undefined,
				};
			}
			const cleanup = await fileOperations.deleteRemoteFile(
				deps.fileOperations,
				oldPath,
			);
			if (cleanup === "deferred") {
				if (deps.indexSaveCallback) {
					await deps.indexSaveCallback();
				}
				return {
					status: "retry",
					plan: "delete-source",
					canonicalRevision:
						deps.indexManager.getRemoteIndex().revision,
					epoch: deps.indexManager.getRemoteIndex().epoch,
					reason: "physical-cleanup-pending",
					remoteStarted: true,
				};
			}
			deps.indexManager.confirmMutation(mutation.id);
			if (deps.indexSaveCallback) {
				await deps.indexSaveCallback();
			}
		}
		return {
			status: "completed",
			plan: "delete-source",
			canonicalRevision: deps.indexManager.getRemoteIndex().revision,
			epoch: deps.indexManager.getRemoteIndex().epoch,
			remoteStarted: true,
		};
	}

	try {
		const { content, sha256, mtime } = targetSnapshot!;
		const oldLocalMeta = deps.indexManager.getLocalIndex().files[oldPath];
		const canonical = await deps.indexManager.refreshCanonicalForMutation();
		const pendingMove = deps.indexManager
			.getPendingMutations()
			.find(
				(mutation) =>
					mutation.type === "move" &&
					mutation.resourceKind === "file" &&
					mutation.path === oldPath &&
					mutation.targetPath === newPath &&
					mutation.epoch === canonical.epoch,
			);
		const canonicalSource = canonical.files[oldPath];
		const canonicalTarget = canonical.files[newPath];
		const existingMove = Object.values(canonical.moves).find(
			(move) =>
				move.pending &&
				move.kind === "file" &&
				move.fromPath === oldPath &&
				move.toPath === newPath,
		);
		const sourceIsSettled =
			!canonicalSource ||
			canonicalSource.deleted ||
			(context.baseRevision !== null &&
				(canonicalSource.changedRevision ?? 0) > context.baseRevision);
		if (
			canonicalTarget &&
			!existingMove &&
			!canonicalTarget.deleted &&
			canonicalTarget.sha256 === sha256 &&
			sourceIsSettled
		) {
			const remotePath = joinPath(deps.settings.remotePath, newPath);
			const physical =
				await deps.yandexClient.getLogicalResource(remotePath);
			let physicalMatches =
				physical !== null &&
				canonicalTarget.remoteFingerprint !== undefined &&
				matchesPhysicalResourceFingerprint(
					canonicalTarget.remoteFingerprint,
					physical,
				);
			if (physical && !canonicalTarget.remoteFingerprint) {
				const remoteContent =
					await deps.yandexClient.downloadFile(remotePath);
				physicalMatches =
					(await computeSha256(remoteContent)) === sha256;
			}
			if (physical && physicalMatches) {
				setRecordValue(
					deps.indexManager.getRemoteIndex().files,
					newPath,
					{
						...canonicalTarget,
					},
				);
				remoteMoves.stampMovedTarget(
					deps.remoteMoves,
					newPath,
					physical,
					{
						content,
						sha256,
					},
				);
				deps.indexManager.removeFromLocalIndex(oldPath);
				if (deps.indexSaveCallback) {
					await deps.indexSaveCallback();
				}
				logger.info("File rename already applied", {
					oldPath,
					newPath,
					plan: "already-applied",
					canonicalRevision: canonical.revision,
				});
				return {
					status: "completed",
					plan: "already-applied",
					canonicalRevision: canonical.revision,
					epoch: canonical.epoch,
					remoteStarted: true,
					requiresFullSync: deps.epochReplacementPending
						? "epoch-replaced"
						: undefined,
				};
			}
		}
		if (existingMove) {
			setRecordValue(
				deps.indexManager.getRemoteIndex().moves,
				existingMove.id,
				{
					...existingMove,
				},
			);
			for (const path of [oldPath, newPath]) {
				const metadata = canonical.files[path];
				if (metadata) {
					setRecordValue(
						deps.indexManager.getRemoteIndex().files,
						path,
						{
							...metadata,
						},
					);
				}
			}
			const physicalMove = deps.indexManager.enqueuePhysicalAction(
				"move-remote",
				oldPath,
				{
					targetPath: newPath,
					canonicalRevision: canonical.revision,
					expectedFingerprint: canonicalSource?.remoteFingerprint,
					origin: "move",
				},
			);
			await remoteMoves.executeGuardedRemoteMove(
				deps.remoteMoves,
				oldPath,
				newPath,
				physicalMove.id,
				{ content, sha256 },
			);
			await fileOperations.pruneRemoteFolders(deps.fileOperations, [
				oldPath,
			]);
			deps.indexManager.completeMove(existingMove.id);
			const pendingMoveMutation = deps.indexManager
				.getPendingMutations()
				.find(
					(mutation) =>
						mutation.id === existingMove.id &&
						mutation.type === "move",
				);
			if (pendingMoveMutation) {
				deps.indexManager.stageMutation(pendingMoveMutation);
			}
			if (
				!(await syncReconciliation.saveMoveCompletionBestEffort(
					deps.syncReconciliation,
				))
			) {
				throw new Error(
					`Could not commit recovered rename: ${oldPath} -> ${newPath}`,
				);
			}
			if (pendingMoveMutation) {
				deps.indexManager.confirmMutation(pendingMoveMutation.id);
			}
			if (deps.indexSaveCallback) {
				await deps.indexSaveCallback();
			}
			logger.info("Existing file move recovered", {
				oldPath,
				newPath,
				moveId: existingMove.id,
				plan: "materialize-target",
				canonicalRevision: deps.indexManager.getRemoteIndex().revision,
			});
			return {
				status: "completed",
				plan: "materialize-target",
				canonicalRevision: deps.indexManager.getRemoteIndex().revision,
				epoch: deps.indexManager.getRemoteIndex().epoch,
				remoteStarted: true,
				requiresFullSync: deps.epochReplacementPending
					? "epoch-replaced"
					: undefined,
			};
		}
		const pendingPut = [...deps.indexManager.getPendingMutations()]
			.reverse()
			.find(
				(mutation) =>
					mutation.type === "put" && mutation.path === oldPath,
			);
		const pendingPutAccepted = wasPendingPutAccepted(
			pendingPut,
			canonical.appliedMutationSeq,
			canonicalSource,
		);
		const pendingPutApplied =
			pendingPut !== undefined &&
			wasMutationApplied(pendingPut, canonical.appliedMutationSeq);
		if (pendingPutApplied && pendingPut) {
			deps.indexManager.confirmMutationAgainst(
				pendingPut.id,
				canonical.appliedMutationSeq,
			);
			if (deps.indexSaveCallback) {
				await deps.indexSaveCallback();
			}
		}
		const sourceCausallyLive =
			(pendingMove !== undefined &&
				canonicalSource !== undefined &&
				!canonicalSource.deleted &&
				canApplyDestructiveFolderMutation(
					canonicalSource,
					pendingMove.baseRevision ?? 0,
					deps.settings.deviceId,
					pendingMove.seq,
				)) ||
			pendingPutAccepted ||
			wasRenameSourceCausallyLive(
				oldLocalMeta,
				canonicalSource,
				context.baseRevision,
				deps.settings.deviceId,
			);
		const plan = selectFileRenamePlan(
			sourceCausallyLive,
			canonicalSource ?? oldLocalMeta,
			sha256,
		);
		logger.info("File rename planned", {
			oldPath,
			newPath,
			epoch: shortenDiagnosticValue(context.epoch),
			baseRevision: context.baseRevision,
			sourceChangedRevision: canonicalSource?.changedRevision ?? null,
			pendingPutId: pendingPut?.id ?? null,
			pendingPutApplied,
			pendingPutAccepted,
			sourceCausallyLive,
			plan,
		});

		const newMetadata: FileMetadata = {
			path: newPath,
			sha256,
			size: content.byteLength,
			mtime,
			syncedAt: Date.now(),
		};

		if (plan === "put-target") {
			const committed = await putRenamedUnsyncedFile(
				deps,
				oldPath,
				newPath,
				{ content, sha256 },
				context,
			);
			if (!committed) {
				return {
					status: "retry",
					plan,
					canonicalRevision: null,
					epoch: context.epoch,
					reason: deps.epochReplacementPending
						? "epoch-replaced"
						: "index-commit-not-confirmed",
					remoteStarted: true,
				};
			}
			return {
				status: "completed",
				plan,
				canonicalRevision: deps.indexManager.getRemoteIndex().revision,
				epoch: deps.indexManager.getRemoteIndex().epoch,
				remoteStarted: true,
			};
		}

		const mutation =
			pendingMove ??
			deps.indexManager.enqueueMutation("move", oldPath, {
				targetPath: newPath,
				resourceKind: "file",
				epoch: context.epoch,
				baseRevision: context.baseRevision,
			});
		deps.indexManager.recordMove(
			mutation.id,
			oldPath,
			newPath,
			"file",
			mutation.baseRevision ??
				deps.indexManager.getRemoteIndex().revision,
			mutation.seq,
		);
		const physicalMove = deps.indexManager.enqueuePhysicalAction(
			"move-remote",
			oldPath,
			{
				targetPath: newPath,
				canonicalRevision:
					deps.indexManager.getRemoteIndex().revision + 1,
				expectedFingerprint:
					canonicalSource?.remoteFingerprint ??
					deps.indexManager.getRemoteIndex().files[oldPath]
						?.remoteFingerprint,
				origin: "move",
			},
		);
		if (oldLocalMeta) {
			deps.indexManager.markLocalFileDeleted(
				oldPath,
				undefined,
				mutation.seq,
			);
		}
		if (
			canonicalSource &&
			!deps.indexManager.getRemoteIndex().files[oldPath]
		) {
			deps.indexManager.updateRemoteFile(oldPath, {
				...canonicalSource,
			});
		}
		if (canonicalSource) {
			deps.indexManager.markRemoteFileDeleted(
				oldPath,
				undefined,
				mutation.baseRevision ?? 0,
				mutation.seq,
			);
		}
		deps.indexManager.updateLocalFile(newPath, {
			...newMetadata,
			mutationSeq: mutation.seq,
		});
		deps.indexManager.updateRemoteFile(newPath, {
			...newMetadata,
			mutationSeq: mutation.seq,
		});
		if (mutation.baseRevision !== null) {
			deps.indexManager.getRemoteIndex().files[newPath]!.baseRevision =
				mutation.baseRevision;
		}
		stageRenameMutation(deps.indexManager, mutation, newPath);
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
				plan,
				canonicalRevision: null,
				epoch: context.epoch,
				reason: deps.epochReplacementPending
					? "epoch-replaced"
					: "index-commit-not-confirmed",
				remoteStarted: true,
			};
		}
		if (
			deps.indexManager.getRemoteIndex().files[newPath]?.sha256 !==
			newMetadata.sha256
		) {
			throw new Error(`Move target changed concurrently: ${newPath}`);
		}
		if (deps.indexManager.getRemoteIndex().files[newPath]?.deleted) {
			deps.indexManager.enqueuePhysicalAction("delete-local", newPath, {
				origin: "rejected-upload",
			});
			if (deps.indexSaveCallback) {
				await deps.indexSaveCallback();
			}
			const deletion = await fileOperations.deleteLocalFile(
				deps.fileOperations,
				newPath,
			);
			if (deletion !== "completed") {
				if (deps.indexSaveCallback) {
					await deps.indexSaveCallback();
				}
				return {
					status: "retry",
					plan,
					canonicalRevision:
						deps.indexManager.getRemoteIndex().revision,
					epoch: deps.indexManager.getRemoteIndex().epoch,
					reason: "rejected-rename-cleanup-unresolved",
					remoteStarted: true,
				};
			}
			deps.indexManager.markLocalFileDeleted(newPath);
			deps.indexManager.completePhysicalAction(physicalMove.id);
			deps.indexManager.completeMove(mutation.id);
			deps.indexManager.stageMutation(mutation);
			if (
				await syncReconciliation.saveRemoteIndexBestEffort(
					deps.syncReconciliation,
				)
			) {
				deps.indexManager.confirmMutation(mutation.id);
			}
			if (deps.indexSaveCallback) {
				await deps.indexSaveCallback();
			}
			return {
				status: "superseded",
				plan,
				canonicalRevision: deps.indexManager.getRemoteIndex().revision,
				epoch: deps.indexManager.getRemoteIndex().epoch,
				reason: "target-deleted-concurrently",
				remoteStarted: true,
			};
		}

		await remoteMoves.executeGuardedRemoteMove(
			deps.remoteMoves,
			oldPath,
			newPath,
			physicalMove.id,
			{ content, sha256 },
		);

		await fileOperations.pruneRemoteFolders(deps.fileOperations, [oldPath]);

		deps.indexManager.completeMove(mutation.id);
		deps.indexManager.stageMutation(mutation);
		if (
			!(await syncReconciliation.saveMoveCompletionBestEffort(
				deps.syncReconciliation,
			))
		) {
			throw new Error(
				`Could not commit rename completion: ${oldPath} -> ${newPath}`,
			);
		}
		deps.indexManager.confirmAppliedMutations();
		if (deps.indexSaveCallback) {
			await deps.indexSaveCallback();
		}
		logger.info("File rename completed", {
			oldPath,
			newPath,
			plan,
			canonicalRevision: deps.indexManager.getRemoteIndex().revision,
		});
		return {
			status: "completed",
			plan,
			canonicalRevision: deps.indexManager.getRemoteIndex().revision,
			epoch: deps.indexManager.getRemoteIndex().epoch,
			remoteStarted: true,
		};
	} catch (e) {
		if (deps.indexSaveCallback) {
			await deps.indexSaveCallback();
		}
		logger.error(`Error renaming file ${oldPath}:`, { error: e });
		throw e;
	}
}

/** Stage this snapshot and consecutive target puts superseded by the same rename retry. */
function stageRenameMutation(
	index: IndexManager,
	mutation: PendingMutation,
	targetPath: string,
): void {
	index.stageMutation(mutation);
	let sequence = mutation.seq;
	for (const pending of index
		.getPendingMutations()
		.sort((a, b) => a.seq - b.seq)) {
		if (pending.seq <= sequence) {
			continue;
		}
		if (
			pending.seq !== sequence + 1 ||
			pending.epoch !== mutation.epoch ||
			pending.type !== "put" ||
			pending.path !== targetPath
		) {
			break;
		}
		const noop = index.replacePendingPutWithNoop(pending.id);
		if (!noop) {
			break;
		}
		index.stageMutation(noop);
		sequence = pending.seq;
	}
}

/** Retarget an uncommitted source put and materialize only the new path. */
export async function putRenamedUnsyncedFile(
	deps: Dependencies,
	oldPath: string,
	newPath: string,
	snapshot: { content: ArrayBuffer; sha256: string },
	context: WatcherCausalContext,
): Promise<boolean> {
	const oldPendingPut = [...deps.indexManager.getPendingMutations()]
		.reverse()
		.find(
			(mutation) => mutation.type === "put" && mutation.path === oldPath,
		);
	const cleanupAction = oldPendingPut?.sha256
		? await prepareRetargetedUploadCleanup(
				deps,
				oldPath,
				newPath,
				oldPendingPut.sha256,
				snapshot.sha256,
			)
		: undefined;
	const mutation =
		deps.indexManager.retargetPendingPut(
			oldPath,
			newPath,
			snapshot.sha256,
		) ??
		deps.indexManager
			.getPendingMutations()
			.find(
				(pending) =>
					pending.type === "put" &&
					pending.path === newPath &&
					pending.epoch === context.epoch,
			) ??
		deps.indexManager.enqueueMutation("put", newPath, {
			sha256: snapshot.sha256,
			baselineSha256:
				deps.indexManager.getLocalIndex().files[newPath]?.sha256,
			epoch: context.epoch,
			baseRevision: context.baseRevision,
		});
	deps.indexManager.removeFromLocalIndex(oldPath);
	if (deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}
	await fileOperations.uploadFile(
		deps.fileOperations,
		newPath,
		false,
		true,
		snapshot,
	);
	const uploaded = deps.indexManager.getRemoteIndex().files[newPath];
	if (uploaded) {
		uploaded.mutationSeq = mutation.seq;
	}
	stageRenameMutation(deps.indexManager, mutation, newPath);
	const commitProof = await syncReconciliation.saveRemoteIndexBestEffort(
		deps.syncReconciliation,
	);
	if (!commitProof) {
		return false;
	}
	await syncReconciliation.repairMissingAcceptedUploads(
		deps.syncReconciliation,
		[newPath],
		commitProof,
	);
	const local = deps.indexManager.getLocalIndex().files[newPath];
	const canonical = deps.indexManager.getRemoteIndex().files[newPath];
	if (
		local &&
		canonical &&
		!canonical.deleted &&
		local.sha256 === canonical.sha256
	) {
		deps.indexManager.updateLocalFile(
			newPath,
			createConfirmedBaseline(local, canonical, canonical),
		);
	}
	deps.indexManager.confirmAppliedMutations();
	if (deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}
	if (cleanupAction) {
		let cleanupComplete = true;
		try {
			const cleanup = await fileOperations.deleteRemoteFile(
				deps.fileOperations,
				oldPath,
			);
			cleanupComplete = cleanup !== "deferred";
		} catch (error) {
			cleanupComplete = false;
			logger.warn("Retargeted source upload cleanup remains pending", {
				actionId: cleanupAction.id,
				oldPath,
				newPath,
				error,
			});
		}
		if (deps.indexSaveCallback) {
			await deps.indexSaveCallback();
		}
		if (!cleanupComplete) {
			return false;
		}
	}
	logger.info("Unsynced file rename committed as target put", {
		oldPath,
		newPath,
		mutationId: mutation.id,
		mutationSeq: mutation.seq,
		baseRevision: mutation.baseRevision,
	});
	return true;
}

/** Guard cleanup of a source object uploaded before its put was retargeted. */
export async function prepareRetargetedUploadCleanup(
	deps: Dependencies,
	oldPath: string,
	newPath: string,
	expectedOldSha256: string,
	targetSha256: string,
): Promise<PendingPhysicalAction | undefined> {
	const remotePath = joinPath(deps.settings.remotePath, oldPath);
	const resource = await deps.yandexClient.getLogicalResource(remotePath);
	if (!resource) {
		return undefined;
	}
	try {
		const content = await deps.yandexClient.downloadFile(remotePath);
		if ((await computeSha256(content)) !== expectedOldSha256) {
			logger.warn(
				"Retargeted source upload differs from the pending put",
				{
					oldPath,
					newPath,
					expectedSha256: shortenDiagnosticValue(expectedOldSha256),
				},
			);
			return undefined;
		}
	} catch (error) {
		logger.warn("Could not verify retargeted source upload", {
			oldPath,
			newPath,
			error,
		});
		return undefined;
	}
	const fingerprint = getPhysicalResourceFingerprint(resource);
	if (!fingerprint) {
		return undefined;
	}
	return deps.indexManager.enqueuePhysicalAction("delete-remote", oldPath, {
		targetPath: newPath,
		canonicalRevision: deps.indexManager.getRemoteIndex().revision + 1,
		expectedFingerprint: fingerprint,
		baselineSha256: targetSha256,
		origin: "rejected-upload",
	});
}

/** Classify a missing-target watcher rename from the final in-memory state of a successful full reconciliation without performing remote operations. */
export function classifyPostFullRenameOutcome(
	deps: Dependencies,
	event: DurableFileRenameEvent,
): FileRenameOutcome {
	const canonical = deps.indexManager.getRemoteIndex();
	const local = deps.indexManager.getLocalIndex();
	const relatedPaths = new Set([event.path, event.targetPath]);
	const hasPendingWork =
		deps.indexManager
			.getPendingMutations()
			.some(
				(mutation) =>
					relatedPaths.has(mutation.path) ||
					(mutation.targetPath !== undefined &&
						relatedPaths.has(mutation.targetPath)),
			) ||
		deps.indexManager
			.getPendingPhysicalActions()
			.some(
				(action) =>
					relatedPaths.has(action.path) ||
					(action.targetPath !== undefined &&
						relatedPaths.has(action.targetPath)),
			) ||
		Object.values(canonical.moves).some(
			(move) =>
				move.pending &&
				(relatedPaths.has(move.fromPath) ||
					relatedPaths.has(move.toPath)),
		);
	return classifyPostFullRename(event, {
		canonicalEpoch: canonical.epoch,
		canonicalRevision: canonical.revision,
		canonicalSource: canonical.files[event.path],
		canonicalTarget: canonical.files[event.targetPath],
		localTarget: local.files[event.targetPath],
		targetExists:
			deps.vaultAdapter.shouldSync(event.targetPath) &&
			deps.vaultAdapter.fileExists(event.targetPath),
		hasPendingWork,
	});
}
