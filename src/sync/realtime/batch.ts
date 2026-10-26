import { VaultAdapter } from "../../api/vault-adapter";
import { t } from "../../i18n";
import type {
	FileMetadata,
	PendingMutation,
	SyncIndex,
	SyncPhase,
	SyncProgress,
	YandexDiskSyncSettings,
} from "../../types";
import { computeSha256 } from "../../utils/hash-utils";
import { logger, shortenDiagnosticValue } from "../../utils/logger";
import { runWithConcurrencySettled } from "../../utils/semaphore";
import { joinPath } from "../../utils/path-utils";
import {
	getStableContentFingerprint,
	isHashStableContentFingerprint,
	matchesStableContentFingerprint,
} from "../../utils/resource-fingerprint";
import { IndexManager } from "../canonical/manager";
import type { IndexSaveCallback, SyncGuardResult } from "../contracts";
import * as fileOperations from "../files/operations";
import * as reconcileAcceptedUploads from "../reconciliation/accepted-uploads";
import * as syncReconciliation from "../reconciliation/commits";
import * as reconciliationContext from "../reconciliation/context";
import {
	createRealtimeBatchResult,
	isMissingUploadSuperseded,
	isUploadEventApplied,
	matchesUploadReceiptContent,
	wasMutationApplied,
	type RealtimeBatchResult,
	type RealtimeFileEvent,
	type UploadCausalReceipt,
} from "./rules";
export { isUploadEventApplied } from "./rules";

// Internal retained-plaintext policy, not a whole-heap or single-file cap.
const MAX_REALTIME_WINDOW_EVENTS = 32;
const REALTIME_WINDOW_BYTES = 8 * 1024 * 1024;

export interface Dependencies {
	readCanonical?: () => Promise<SyncIndex>;
	assertCurrent?: () => void;
	indexManager: IndexManager;
	settings: YandexDiskSyncSettings;
	getSyncGuardResult: (
		skipGuard?: boolean,
		validationToken?: string,
		validateThroughExternalBlock?: boolean,
	) => Promise<SyncGuardResult>;
	isPaused: boolean;
	setBlockedState: (
		reason: string,
		status?: "error" | "migration-required" | "encryption-required",
	) => void;
	realtimeGuardValidationToken: string | undefined;
	setSyncPhase: (
		phase: SyncPhase,
		currentOperation?: string,
		progress?: SyncProgress,
	) => void;
	vaultAdapter: VaultAdapter;
	indexSaveCallback: IndexSaveCallback | null;
	fileOperations: fileOperations.Dependencies;
	syncReconciliation: reconciliationContext.Dependencies;
	settleWindow?: (result: RealtimeBatchResult) => Promise<void>;
}
interface PreparedRealtimeItem {
	id: string;
	path: string;
	action: "upload" | "delete" | "noop";
	mutation: PendingMutation;
	snapshot?: { content: ArrayBuffer; sha256: string };
	event?: RealtimeFileEvent;
	uploadedMetadata?: FileMetadata;
}

/** Keep an uncommitted put available for its durable rename successor. */
export function recordPendingUploadHandoff(
	result: RealtimeBatchResult,
	item: PreparedRealtimeItem,
): void {
	if (!result.superseded.includes(item.id)) {
		result.superseded.push(item.id);
	}
	if (!result.uploadReceipts.some((receipt) => receipt.eventId === item.id)) {
		result.uploadReceipts.push({
			eventId: item.id,
			path: item.path,
			status: "pending-put",
			reason: "coalesced",
			epoch: item.mutation.epoch,
			canonicalRevision: null,
			mutationId: item.mutation.id,
			mutationSeq: item.mutation.seq,
			sha256: item.mutation.sha256,
		});
	}
	logger.info("Realtime upload retargeted before canonical commit", {
		eventId: item.id,
		path: item.path,
		mutationId: item.mutation.id,
		mutationSeq: item.mutation.seq,
		state: "pending-put",
	});
}

/** Recognize an upload whose causal receipt belongs to a later rename. */
export function isUploadHandedOffToRename(
	event: RealtimeFileEvent | undefined,
): boolean {
	return event?.superseded === true && Boolean(event.supersededByRenameId);
}

/** Reconstruct an in-flight upload outcome after restart or late rename. */
export async function recoverUploadCausalReceipt(
	deps: Dependencies,
	event: RealtimeFileEvent,
): Promise<UploadCausalReceipt> {
	const fallback: UploadCausalReceipt = {
		eventId: event.id,
		path: event.path,
		status: "rejected-put",
		reason: "coalesced",
		epoch: event.epoch,
		canonicalRevision: null,
		mutationId: event.mutationId,
		mutationSeq: event.mutationSeq,
		sha256: event.snapshotSha256,
	};
	if (
		!event.mutationId ||
		event.mutationSeq === undefined ||
		!event.snapshotSha256
	) {
		return fallback;
	}
	const canonical = await deps.indexManager.readCanonicalIndex();
	const pending = deps.indexManager
		.getPendingMutations()
		.find((mutation) => mutation.id === event.mutationId);
	const applied = isUploadEventApplied(event, canonical.appliedMutationSeq);
	const source = canonical.files[event.path];
	if (
		applied &&
		canonical.epoch === event.epoch &&
		source &&
		matchesUploadReceiptContent(source, event.snapshotSha256)
	) {
		deps.indexManager.updateLocalFile(event.path, {
			...source,
			path: event.path,
		});
		return {
			...fallback,
			status: "accepted-put",
			reason: "idempotent",
			epoch: canonical.epoch,
			canonicalRevision: canonical.revision,
		};
	}
	if (pending && !applied && pending.type === "put") {
		return {
			...fallback,
			status: "pending-put",
			reason: event.supersededByRenameId ? "coalesced" : "unresolved",
		};
	}
	const separator = event.mutationId.lastIndexOf(":");
	const eventDevice =
		separator > 0 ? event.mutationId.slice(0, separator) : null;
	if (
		applied &&
		eventDevice &&
		source?.lastModifiedBy === eventDevice &&
		(source.mutationSeq ?? -1) > event.mutationSeq
	) {
		return {
			...fallback,
			reason: "stale-same-device",
			epoch: canonical.epoch,
			canonicalRevision: canonical.revision,
		};
	}
	if (
		applied &&
		source &&
		!source.deleted &&
		eventDevice &&
		source.lastModifiedBy !== eventDevice
	) {
		return {
			...fallback,
			reason: "foreign-conflict",
			epoch: canonical.epoch,
			canonicalRevision: canonical.revision,
		};
	}
	return {
		...fallback,
		reason: "unresolved",
		epoch: canonical.epoch,
		canonicalRevision: canonical.revision,
	};
}

/** Classify a just-committed upload using canonical watermark and content. */
export function createCommittedUploadReceipt(
	deps: Dependencies,
	item: PreparedRealtimeItem,
): UploadCausalReceipt {
	const canonical = deps.indexManager.getRemoteIndex();
	const source = canonical.files[item.path];
	const accepted =
		isUploadEventApplied(
			item.event ?? {
				id: item.id,
				path: item.path,
				action: "upload",
				createdAt: item.mutation.createdAt,
				epoch: item.mutation.epoch,
				baseRevision: item.mutation.baseRevision,
				mutationId: item.mutation.id,
				mutationSeq: item.mutation.seq,
				snapshotSha256: item.mutation.sha256,
			},
			canonical.appliedMutationSeq,
		) &&
		canonical.epoch === item.mutation.epoch &&
		matchesUploadReceiptContent(source, item.snapshot?.sha256);
	let reason: UploadCausalReceipt["reason"] = "unresolved";
	if (accepted) {
		reason = "accepted-put";
	} else if (
		source?.lastModifiedBy === deps.settings.deviceId &&
		(source.mutationSeq ?? -1) > item.mutation.seq
	) {
		reason = "stale-same-device";
	} else if (
		source &&
		!source.deleted &&
		source.lastModifiedBy !== deps.settings.deviceId
	) {
		reason = "foreign-conflict";
	}
	return {
		eventId: item.id,
		path: item.path,
		status: accepted ? "accepted-put" : "rejected-put",
		reason,
		epoch: canonical.epoch,
		canonicalRevision: canonical.revision,
		mutationId: item.mutation.id,
		mutationSeq: item.mutation.seq,
		sha256: item.snapshot?.sha256,
	};
}

/** Recover terminal upload work from the current canonical watermark. */
export function classifyAppliedUploadEvent(
	deps: Dependencies,
	event: RealtimeFileEvent,
): UploadCausalReceipt | null {
	if (
		!event.mutationId ||
		event.mutationSeq === undefined ||
		!event.snapshotSha256
	) {
		return null;
	}
	const canonical = deps.indexManager.getRemoteIndex();
	if (
		canonical.epoch !== event.epoch ||
		!isUploadEventApplied(event, canonical.appliedMutationSeq)
	) {
		return null;
	}
	const separator = event.mutationId.lastIndexOf(":");
	if (separator <= 0) {
		return null;
	}
	const deviceId = event.mutationId.slice(0, separator);
	const source = canonical.files[event.path];
	let status: UploadCausalReceipt["status"] = "rejected-put";
	let reason: UploadCausalReceipt["reason"] = "unresolved";
	if (source && matchesUploadReceiptContent(source, event.snapshotSha256)) {
		status = "accepted-put";
		reason = "idempotent";
		deps.indexManager.updateLocalFile(event.path, source);
	} else if (
		source?.lastModifiedBy === deviceId &&
		(source.mutationSeq ?? -1) > event.mutationSeq
	) {
		reason = "stale-same-device";
	} else if (
		source &&
		!source.deleted &&
		source.lastModifiedBy !== deviceId
	) {
		reason = "foreign-conflict";
	}
	return {
		eventId: event.id,
		path: event.path,
		status,
		reason,
		epoch: canonical.epoch,
		canonicalRevision: canonical.revision,
		mutationId: event.mutationId,
		mutationSeq: event.mutationSeq,
		sha256: event.snapshotSha256,
	};
}

/** Reuse durable file work without allocating a second FIFO sequence. */
export function reusePendingFileMutation(
	deps: Dependencies,
	event: RealtimeFileEvent,
	type: "put" | "delete-file",
	sha256?: string,
): ReturnType<IndexManager["enqueueMutation"]> | undefined {
	const appliedMutationSeq =
		deps.indexManager.getRemoteIndex().appliedMutationSeq;
	const byEventId = event.mutationId
		? deps.indexManager
				.getPendingMutations()
				.find(
					(mutation) =>
						mutation.id === event.mutationId &&
						mutation.type === type,
				)
		: undefined;
	if (byEventId && !wasMutationApplied(byEventId, appliedMutationSeq)) {
		if (type === "put" && sha256) {
			return (
				deps.indexManager.retargetPendingPut(
					byEventId.path,
					event.path,
					sha256,
				) ?? byEventId
			);
		}
		return byEventId;
	}
	const existing = [...deps.indexManager.getPendingMutations()]
		.reverse()
		.find(
			(mutation) =>
				mutation.type === type &&
				mutation.path === event.path &&
				mutation.epoch === event.epoch &&
				!wasMutationApplied(mutation, appliedMutationSeq),
		);
	if (!existing) {
		return undefined;
	}
	if (type === "put" && sha256) {
		return (
			deps.indexManager.retargetPendingPut(
				event.path,
				event.path,
				sha256,
			) ?? existing
		);
	}
	return existing;
}

/** Apply current events while keeping superseded work and receipts causal. */
export async function reconcileRealtimeBatch(
	deps: Dependencies,
	events: RealtimeFileEvent[],
): Promise<RealtimeBatchResult> {
	const batchResult = createRealtimeBatchResult();
	const { blockReason, validationToken } =
		await deps.getSyncGuardResult(false);
	if (blockReason || deps.isPaused) {
		if (blockReason) {
			deps.setBlockedState(blockReason);
		}
		batchResult.retry.push(...events.map((event) => event.id));
		return batchResult;
	}
	deps.realtimeGuardValidationToken = validationToken;
	deps.setSyncPhase("applying", t("status.op.applying_realtime"), {
		completed: 0,
		total: events.length,
	});

	let cursor = 0;
	while (cursor < events.length) {
		const result = createRealtimeBatchResult();
		const windowStartedAt = Date.now();
		if (cursor > 0) {
			const guard = await deps.getSyncGuardResult(false, validationToken);
			if (guard.blockReason || deps.isPaused) {
				if (guard.blockReason) {
					deps.setBlockedState(guard.blockReason);
				}
				result.retry.push(
					...events.slice(cursor).map((event) => event.id),
				);
				await deps.settleWindow?.(result);
				batchResult.retry.push(...result.retry);
				break;
			}
		}
		const { prepared, consumed } = await prepareRealtimeEvents(
			deps,
			events.slice(cursor, cursor + MAX_REALTIME_WINDOW_EVENTS),
			result,
		);
		try {
			await applyPreparedRealtimeWindow(deps, prepared, result);
			cursor += consumed;
			if (result.retry.length > 0) {
				result.retry.push(
					...events.slice(cursor).map((event) => event.id),
				);
			}
			await deps.settleWindow?.(result);
			batchResult.completed.push(...result.completed);
			batchResult.superseded.push(...result.superseded);
			batchResult.retry.push(...result.retry);
			batchResult.uploadReceipts.push(...result.uploadReceipts);
			if (result.requiresFullSync) {
				batchResult.requiresFullSync = result.requiresFullSync;
			}
		} finally {
			logger.info("Realtime window released", {
				durationMs: Date.now() - windowStartedAt,
				events: consumed,
				retainedSnapshotBytes: prepared.reduce(
					(sum, item) =>
						sum + (item.snapshot?.content.byteLength ?? 0),
					0,
				),
				completed: result.completed.length,
				retry: result.retry.length,
			});
			// Repair and durable settlement have finished, or retry must recapture bytes.
			for (const item of prepared) {
				delete item.snapshot;
			}
			prepared.length = 0;
		}
		deps.setSyncPhase("applying", t("status.op.applying_realtime"), {
			completed:
				batchResult.completed.length + batchResult.superseded.length,
			total: events.length,
		});
		if (result.retry.length > 0) {
			break;
		}
	}
	if (batchResult.retry.length > 0) {
		logger.warn("Realtime file batch completed with retry events", {
			completed: batchResult.completed.length,
			superseded: batchResult.superseded.length,
			retry: batchResult.retry.length,
		});
	}
	return batchResult;
}

/** Commit and repair a bounded prefix before its snapshots can be released. */
async function applyPreparedRealtimeWindow(
	deps: Dependencies,
	prepared: PreparedRealtimeItem[],
	batchResult: RealtimeBatchResult,
): Promise<RealtimeBatchResult> {
	if (deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}

	if (prepared.length === 0) {
		return batchResult;
	}

	const ready: typeof prepared = [];
	const accepted: typeof prepared = [];
	for (let index = 0; index < prepared.length; index++) {
		const item = prepared[index]!;
		try {
			if (item.action === "upload") {
				const source =
					deps.indexManager.getRemoteIndex().files[item.path];
				if (
					isUploadHandedOffToRename(item.event) &&
					(!source || source.deleted)
				) {
					recordPendingUploadHandoff(batchResult, item);
					continue;
				}
				item.uploadedMetadata =
					await fileOperations.materializeUploadedFile(
						deps.fileOperations,
						item.path,
						item.snapshot!,
						false,
						true,
					);
				if (
					isUploadHandedOffToRename(item.event) &&
					(!source || source.deleted)
				) {
					recordPendingUploadHandoff(batchResult, item);
					continue;
				}
			} else if (item.action === "delete") {
				deps.indexManager.markLocalFileDeleted(
					item.path,
					undefined,
					item.mutation.seq,
				);
				deps.indexManager.markRemoteFileDeleted(
					item.path,
					undefined,
					item.mutation.baseRevision ?? 0,
					item.mutation.seq,
				);
				deps.indexManager.enqueuePhysicalAction(
					"delete-remote",
					item.path,
					{
						canonicalRevision:
							deps.indexManager.getRemoteIndex().revision + 1,
						expectedFingerprint:
							deps.indexManager.getRemoteIndex().files[item.path]
								?.remoteFingerprint,
						origin: "exact-delete",
					},
				);
			}
			ready.push(item);
		} catch (e) {
			logger.error(`Realtime batch stopped at ${item.path}:`, {
				eventId: item.id,
				error: e,
			});
			batchResult.retry.push(
				...prepared.slice(index).map((event) => event.id),
			);
			break;
		}
	}
	if (ready.length === 0) {
		return batchResult;
	}
	if (deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}
	for (const item of ready) {
		const source = deps.indexManager.getRemoteIndex().files[item.path];
		if (
			item.action === "upload" &&
			isUploadHandedOffToRename(item.event) &&
			(!source || source.deleted)
		) {
			recordPendingUploadHandoff(batchResult, item);
			continue;
		}
		if (item.action === "upload") {
			fileOperations.applyUploadedFileMetadata(
				deps.fileOperations,
				item.path,
				item.uploadedMetadata!,
				item.mutation,
			);
		}
		deps.indexManager.stageMutation(item.mutation);
		accepted.push(item);
	}
	if (accepted.length === 0) {
		return batchResult;
	}
	deps.setSyncPhase("saving-index");
	const commitProof = await syncReconciliation.saveRemoteIndexBestEffort(
		deps.syncReconciliation,
	);
	if (!commitProof) {
		batchResult.retry.push(
			...accepted
				.map((event) => event.id)
				.filter((id) => !batchResult.retry.includes(id)),
		);
		return batchResult;
	}
	await reconcileAcceptedUploads.repairMissingAcceptedUploads(
		deps.syncReconciliation,
		accepted
			.filter((item) => item.action === "upload")
			.map((item) => ({
				path: item.path,
				snapshot: item.snapshot,
			})),
		commitProof,
	);
	for (const item of accepted.filter((event) => event.action === "upload")) {
		batchResult.uploadReceipts.push(
			createCommittedUploadReceipt(deps, item),
		);
	}
	for (const item of accepted) {
		deps.indexManager.confirmMutation(item.mutation.id);
	}

	const deletes = accepted.filter((item) => item.action === "delete");
	if (deletes.length > 0) {
		deps.setSyncPhase("cleanup");
	}
	const deleteResults = await runWithConcurrencySettled(
		deletes.map((item) => async () => {
			return await fileOperations.deleteRemoteFile(
				deps.fileOperations,
				item.path,
			);
		}),
		Math.max(1, deps.settings.maxConcurrency || 5),
	);
	for (const item of accepted.filter((event) => event.action === "upload")) {
		batchResult.completed.push(item.id);
	}
	for (const item of accepted.filter((event) => event.action === "noop")) {
		batchResult.superseded.push(item.id);
	}
	for (const [i, item] of deletes.entries()) {
		const outcome = deleteResults[i];
		if (outcome?.status === "fulfilled" && outcome.value !== "deferred") {
			batchResult.completed.push(item.id);
		} else {
			batchResult.retry.push(item.id);
		}
	}
	if (deletes.length > 0) {
		await fileOperations.pruneRemoteFolders(
			deps.fileOperations,
			deletes.map((item) => item.path),
		);
	}
	if (
		deletes.length > 0 &&
		deleteResults.every(
			(outcome) =>
				outcome.status === "fulfilled" && outcome.value !== "deferred",
		)
	) {
		deps.indexManager.markRemoteObserved();
	}
	if (deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}

	return batchResult;
}

/** Confirm a redundant notification without allocating or acknowledging a put sequence. */
async function confirmUnchangedUpload(
	deps: Dependencies,
	event: RealtimeFileEvent,
	sha256: string,
	recordDecision: (reason: string) => void,
): Promise<UploadCausalReceipt | null> {
	const baseline = deps.indexManager.getLocalIndex().files[event.path];
	const skip = (reason: string) => {
		recordDecision(reason);
		return null;
	};
	if (!deps.readCanonical) {
		return skip("no-canonical-reader");
	}
	if (event.mutationId || event.mutationSeq !== undefined) {
		return skip("allocated-mutation");
	}
	if (event.superseded) {
		return skip("superseded-event");
	}
	if (!baseline || baseline.deleted) {
		return skip("missing-baseline");
	}
	if (baseline.sha256 !== sha256) {
		return skip("local-content-differs");
	}
	if (
		typeof baseline.changedRevision !== "number" ||
		typeof baseline.mutationSeq !== "number"
	) {
		return skip("incomplete-causal-baseline");
	}
	if (deps.indexManager.hasPendingCanonicalChanges()) {
		return skip("pending-canonical-work");
	}
	const matches = (index: SyncIndex) => {
		const current = index.files[event.path];
		return (
			!index.maintenance &&
			!Object.values(index.moves).some((move) => move.pending) &&
			index.epoch === event.epoch &&
			index.epoch === deps.indexManager.getObservedEpoch() &&
			current &&
			!current.deleted &&
			current.sha256 === sha256 &&
			current.changedRevision === baseline.changedRevision &&
			current.lastModifiedBy === baseline.lastModifiedBy &&
			current.mutationSeq === baseline.mutationSeq
		);
	};
	const canonical = await deps.readCanonical();
	if (!matches(canonical)) {
		return skip("canonical-identity-differs");
	}
	const client = deps.fileOperations.yandexClient;
	const remotePath = joinPath(deps.settings.remotePath, event.path);
	const resource = await client.getLogicalResource(remotePath);
	const fingerprint = getStableContentFingerprint(resource);
	const physicalMatches =
		resource &&
		isHashStableContentFingerprint(fingerprint) &&
		matchesStableContentFingerprint(fingerprint, resource) &&
		canonical.files[event.path]?.remoteFingerprint ===
			(resource.sha256 ?? resource.md5);
	if (!physicalMatches) {
		const snapshot = await client.downloadStableLogicalFile(remotePath);
		if (!snapshot || (await computeSha256(snapshot.content)) !== sha256) {
			return skip("physical-content-differs");
		}
	}
	const guard = await deps.getSyncGuardResult(
		false,
		deps.realtimeGuardValidationToken,
	);
	if (guard.blockReason) {
		recordDecision("guard-blocked");
		deps.setBlockedState(guard.blockReason);
		throw new Error(guard.blockReason);
	}
	const latest = await deps.readCanonical();
	deps.assertCurrent?.();
	if (!matches(latest)) {
		return skip("canonical-changed-during-check");
	}
	if (
		event.superseded ||
		!deps.vaultAdapter.fileExists(event.path) ||
		(await computeSha256(await deps.vaultAdapter.readFile(event.path))) !==
			sha256
	) {
		return skip("local-changed-during-check");
	}
	deps.assertCurrent?.();
	recordDecision("confirmed-unchanged");
	return {
		eventId: event.id,
		path: event.path,
		status: "confirmed-unchanged",
		reason: "idempotent",
		epoch: latest.epoch,
		canonicalRevision: latest.revision,
		sha256,
	};
}

/** Snapshot current watcher events and retain causal receipts before physical application. */
async function prepareRealtimeEvents(
	deps: Dependencies,
	events: RealtimeFileEvent[],
	batchResult: RealtimeBatchResult,
): Promise<{ prepared: PreparedRealtimeItem[]; consumed: number }> {
	const prepared: PreparedRealtimeItem[] = [];
	const unchangedDecisions: Record<string, number> = {};
	let consumed = 0;
	let retainedBytes = 0;
	for (const event of events) {
		consumed++;
		if (!deps.vaultAdapter.shouldSync(event.path)) {
			batchResult.completed.push(event.id);
			continue;
		}
		if (event.action === "upload") {
			const recovered = classifyAppliedUploadEvent(deps, event);
			if (recovered) {
				batchResult.uploadReceipts.push(recovered);
				if (recovered.status === "accepted-put") {
					batchResult.completed.push(event.id);
				} else if (recovered.reason === "stale-same-device") {
					batchResult.superseded.push(event.id);
				} else {
					batchResult.retry.push(event.id);
					break;
				}
				logger.info("Realtime upload recovered before physical write", {
					eventId: event.id,
					path: event.path,
					mutationId: event.mutationId ?? null,
					mutationSeq: event.mutationSeq ?? null,
					reason: recovered.reason,
					canonicalRevision: recovered.canonicalRevision,
				});
				continue;
			}
			if (event.superseded) {
				const receipt = await recoverUploadCausalReceipt(deps, event);
				if (
					receipt.status === "pending-put" &&
					!event.supersededByRenameId &&
					event.mutationId
				) {
					const noop = deps.indexManager.replacePendingPutWithNoop(
						event.mutationId,
					);
					if (noop) {
						prepared.push({
							...event,
							action: "noop",
							mutation: noop,
						});
						logger.debug(
							"Superseded upload retained as FIFO no-op",
							{
								eventId: event.id,
								path: event.path,
								mutationId: noop.id,
								mutationSeq: noop.seq,
							},
						);
						continue;
					}
				}
				batchResult.uploadReceipts.push(receipt);
				if (
					receipt.reason === "foreign-conflict" ||
					(receipt.reason === "unresolved" &&
						receipt.status !== "pending-put")
				) {
					batchResult.retry.push(event.id);
					break;
				} else if (receipt.status === "accepted-put") {
					batchResult.completed.push(event.id);
				} else {
					batchResult.superseded.push(event.id);
				}
				logger.debug("Realtime upload event superseded", {
					eventId: event.id,
					path: event.path,
					reason: receipt.reason,
					epoch: shortenDiagnosticValue(event.epoch),
					baseRevision: event.baseRevision,
				});
				continue;
			}
			if (!deps.vaultAdapter.fileExists(event.path)) {
				const remoteIndex = deps.indexManager.getRemoteIndex();
				if (
					isMissingUploadSuperseded(
						event,
						remoteIndex.files[event.path],
						remoteIndex.moves,
					)
				) {
					batchResult.superseded.push(event.id);
					logger.debug("Realtime upload event superseded", {
						eventId: event.id,
						path: event.path,
						reason: "canonical-replacement",
						epoch: shortenDiagnosticValue(event.epoch),
						baseRevision: event.baseRevision,
					});
				} else {
					batchResult.retry.push(event.id);
					logger.warn(
						"Realtime upload path is missing without a causal replacement",
						{
							eventId: event.id,
							path: event.path,
							epoch: shortenDiagnosticValue(event.epoch),
							baseRevision: event.baseRevision,
						},
					);
					break;
				}
				continue;
			}
			try {
				const estimate =
					deps.vaultAdapter.getFile(event.path)?.stat.size ?? 0;
				if (
					consumed > 1 &&
					(estimate > REALTIME_WINDOW_BYTES ||
						retainedBytes + estimate > REALTIME_WINDOW_BYTES)
				) {
					consumed--;
					break;
				}
				const content = await deps.vaultAdapter.readFile(event.path);
				if (
					consumed > 1 &&
					(content.byteLength > REALTIME_WINDOW_BYTES ||
						retainedBytes + content.byteLength >
							REALTIME_WINDOW_BYTES)
				) {
					// Discard an underestimated read; the next window captures fresh bytes/SHA.
					consumed--;
					break;
				}
				const sha256 = await computeSha256(content);
				const unchanged = await confirmUnchangedUpload(
					deps,
					event,
					sha256,
					(reason) => {
						unchangedDecisions[reason] =
							(unchangedDecisions[reason] ?? 0) + 1;
					},
				);
				if (unchanged) {
					event.snapshotSha256 = sha256;
					batchResult.uploadReceipts.push(unchanged);
					batchResult.completed.push(event.id);
					continue;
				}
				retainedBytes += content.byteLength;
				const mutation =
					reusePendingFileMutation(deps, event, "put", sha256) ??
					deps.indexManager.enqueueMutation("put", event.path, {
						sha256,
						baselineSha256:
							deps.indexManager.getLocalIndex().files[event.path]
								?.sha256,
						epoch: event.epoch,
						baseRevision: event.baseRevision,
					});
				event.mutationId = mutation.id;
				event.mutationSeq = mutation.seq;
				event.snapshotSha256 = sha256;
				prepared.push({
					id: event.id,
					path: event.path,
					action: event.action,
					mutation,
					snapshot: { content, sha256 },
					event,
				});
				if (retainedBytes >= REALTIME_WINDOW_BYTES) {
					break;
				}
			} catch (e) {
				logger.warn(
					`Could not prepare realtime upload ${event.path}:`,
					{ eventId: event.id, error: e },
				);
				batchResult.retry.push(event.id);
				break;
			}
			continue;
		}
		const pendingPut = reusePendingFileMutation(deps, event, "put");
		const canonicalSource =
			deps.indexManager.getRemoteIndex().files[event.path];
		const baselineSource =
			deps.indexManager.getLocalIndex().files[event.path];
		const pendingPutApplied =
			pendingPut !== undefined &&
			wasMutationApplied(
				pendingPut,
				deps.indexManager.getRemoteIndex().appliedMutationSeq,
			);
		if (
			pendingPut &&
			!pendingPutApplied &&
			(!canonicalSource || canonicalSource.deleted) &&
			(!baselineSource || baselineSource.deleted)
		) {
			const noop = deps.indexManager.replacePendingPutWithNoop(
				pendingPut.id,
			);
			if (noop) {
				prepared.push({
					...event,
					action: "noop",
					mutation: noop,
				});
				continue;
			}
		}
		if (
			!pendingPut &&
			(!canonicalSource || canonicalSource.deleted) &&
			(!baselineSource || baselineSource.deleted)
		) {
			batchResult.superseded.push(event.id);
			logger.debug("Realtime delete reduced to local no-op", {
				eventId: event.id,
				path: event.path,
				reason: "source-never-causally-live",
			});
			continue;
		}
		deps.indexManager.markLocalFileDeleted(event.path);
		prepared.push({
			...event,
			mutation:
				(pendingPut
					? deps.indexManager.replacePendingPutWithDelete(
							pendingPut.id,
						)
					: undefined) ??
				reusePendingFileMutation(deps, event, "delete-file") ??
				deps.indexManager.enqueueMutation("delete-file", event.path, {
					epoch: event.epoch,
					baseRevision: event.baseRevision,
				}),
		});
	}
	if (Object.keys(unchangedDecisions).length > 0) {
		logger.info("Realtime unchanged checks completed", {
			decisions: unchangedDecisions,
		});
	}
	return { prepared, consumed };
}
