import { sameIndexValue } from "./transaction-rules";
import type { SyncIndex } from "../../types";
import type { YandexDiskClient } from "../../api/yandex-client";
import type { EncryptionCodec } from "../../crypto/encryption";
import { joinPath, REMOTE_INDEX_LOCK_PREFIX } from "../../utils/path-utils";
import { logger, shortenDiagnosticValue } from "../../utils/logger";

import { CURRENT_INDEX_FORMAT } from "../../types";
import { UnsupportedHistoricalDataError } from "../../compatibility-errors";
import {
	CanonicalRecovery,
	INDEX_LOCK_ATTEMPTS,
	INDEX_LOCK_RETRY_MS,
	waitForIndexRetry,
} from "./recovery";
import type {
	CanonicalCommitProof,
	IndexFileSnapshot,
	IndexSnapshotReader,
	IndexTransactionStage,
} from "./transaction";
import {
	RemoteIndexTransactionError,
	RemoteIndexConcurrentModificationError,
	RemoteIndexLockedError,
	RemoteIndexContentMismatchError,
	RemoteIndexRolledBackError,
	AmbiguousRemoteIndexStateError,
} from "./errors";

export interface CanonicalCommitDependencies {
	client: Pick<
		YandexDiskClient,
		| "moveResourceExclusive"
		| "uploadFileWithEncryptionService"
		| "uploadFile"
		| "getResource"
		| "getContentFingerprint"
	> &
		Partial<Pick<YandexDiskClient, "getTransportMetrics">>;
	recovery: Pick<
		CanonicalRecovery,
		| "ensureCanonicalIndex"
		| "wasLockAcquiredDespiteError"
		| "recoverStaleLock"
		| "logSemanticIndexMismatch"
		| "recoverAmbiguousFinalMove"
		| "verifyCanonicalCommit"
		| "isExpectedCanonicalCommitted"
		| "rollbackOwnedLock"
	>;
	assertRemoteScope(): Promise<void>;
	getRemotePath(): string;
	getCanonicalPath(): string;
	getDeviceId(): string;
	createTransactionId(): string;
	getDesired(): { revision: number; epoch: string };
	getLoadedRevision(): number;
	getPendingCounts(): { mutations: number; physicalActions: number };
	getCodecs(): {
		source: EncryptionCodec | null | undefined;
		target: EncryptionCodec | null | undefined;
	};
	isReplacing(): boolean;
	allowLegacyWrite(): boolean;
	assertForceSourceSupported(): Promise<void>;
	assertForceLocksUnchanged(lockPath: string): Promise<void>;
	isLockContention(error: unknown): boolean;
	readSnapshot: IndexSnapshotReader;
	readUnparsedSnapshot(path: string): Promise<IndexFileSnapshot>;
	serialize(index: SyncIndex): string;
	reduceLockedIndex(
		original: IndexFileSnapshot,
		initialized: SyncIndex | null,
		lockPath: string,
		context: Record<string, unknown>,
	): Promise<{ latest: SyncIndex; merged: SyncIndex }>;
	acceptCommit(merged: SyncIndex, proof: CanonicalCommitProof): Promise<void>;
}

/** Retry only the existing conclusive rollback/contention outcomes. */
export async function commitCanonicalIndex(
	deps: CanonicalCommitDependencies,
): Promise<CanonicalCommitProof> {
	let lastError: Error | null = null;
	for (let attempt = 0; attempt < 4; attempt++) {
		const startedAt = Date.now();
		const transportBefore = deps.client.getTransportMetrics?.();
		const stageMs: Record<string, number> = {};
		let currentStage = "scope-validation";
		let stageStartedAt = startedAt;
		let result = "error";
		const enterStage = (next: string) => {
			const now = Date.now();
			stageMs[currentStage] =
				(stageMs[currentStage] ?? 0) + now - stageStartedAt;
			currentStage = next;
			stageStartedAt = now;
		};
		try {
			const proof = await saveRemoteIndexLocked(deps, enterStage);
			result = "proof-returned";
			return proof;
		} catch (e) {
			if (!(e instanceof RemoteIndexTransactionError && e.retryable)) {
				throw e;
			}
			lastError = e;
			logger.warn("Retrying canonical index transaction", {
				attempt: attempt + 1,
				maxAttempts: 4,
				outcome: e.outcome,
				failedStage: e.stage,
				canonicalRevision: deps.getDesired().revision,
				epoch: shortenDiagnosticValue(deps.getDesired().epoch),
				error: e,
			});
			enterStage("retry-delay");
			await waitForIndexRetry(INDEX_LOCK_RETRY_MS + Math.random() * 500);
		} finally {
			enterStage("finished");
			const transportAfter = deps.client.getTransportMetrics?.();
			const transport =
				transportBefore && transportAfter
					? Object.fromEntries(
							Object.entries(transportAfter).map(
								([key, value]) => [
									key,
									value - (transportBefore[key] ?? 0),
								],
							),
						)
					: undefined;
			logger.info("Canonical transaction cost", {
				attempt: attempt + 1,
				result,
				durationMs: Date.now() - startedAt,
				stageMs,
				transport,
			});
		}
	}
	throw (
		lastError ||
		new RemoteIndexConcurrentModificationError(
			"Remote index commit could not be retried",
		)
	);
}

/** Own the exclusive move/write/read-back protocol and its irreversible commit boundary. */
async function saveRemoteIndexLocked(
	deps: CanonicalCommitDependencies,
	enterStage: (stage: string) => void,
): Promise<CanonicalCommitProof> {
	await deps.assertRemoteScope();
	const canonicalPath = deps.getCanonicalPath();
	const transactionId = deps.createTransactionId();
	const lockPath = joinPath(
		deps.getRemotePath(),
		`${REMOTE_INDEX_LOCK_PREFIX}${deps.getDeviceId()}.${transactionId}`,
	);
	const pending = deps.getPendingCounts();
	const transactionStartedAt = Date.now();
	const transactionContext = {
		indexTransactionId: transactionId,
		lockName: lockPath.split("/").pop() ?? lockPath,
		desiredRevision: deps.getDesired().revision,
		loadedRevision: deps.getLoadedRevision(),
		epoch: shortenDiagnosticValue(deps.getDesired().epoch),
		pendingMutations: pending.mutations,
		pendingPhysicalActions: pending.physicalActions,
	};
	logger.info("Canonical index transaction started", transactionContext);

	if (deps.isReplacing()) {
		await deps.assertForceSourceSupported();
	}
	enterStage("prepare-canonical");
	const initializedIndex = await deps.recovery.ensureCanonicalIndex();

	enterStage("acquire-lock");
	let acquired = false;
	for (let attempt = 0; attempt < INDEX_LOCK_ATTEMPTS; attempt++) {
		try {
			await deps.client.moveResourceExclusive(
				canonicalPath,
				lockPath,
				undefined,
				{ existingParentOnly: true },
			);
			acquired = true;
			logger.debug("Canonical index lock acquired", {
				...transactionContext,
				lockAttempt: attempt + 1,
			});
			break;
		} catch (e) {
			if (
				await deps.recovery.wasLockAcquiredDespiteError(
					lockPath,
					canonicalPath,
				)
			) {
				acquired = true;
				logger.warn(
					"Canonical index lock acquisition was ambiguous but ownership was verified",
					{
						...transactionContext,
						lockAttempt: attempt + 1,
					},
				);
				break;
			}
			if (!deps.isLockContention(e)) {
				throw e;
			}
			if (attempt === 0 || (attempt + 1) % 10 === 0) {
				logger.debug("Waiting for canonical index lock", {
					...transactionContext,
					lockAttempt: attempt + 1,
					maxLockAttempts: INDEX_LOCK_ATTEMPTS,
					error: e,
				});
			}
			await waitForIndexRetry(INDEX_LOCK_RETRY_MS + Math.random() * 300);
			await deps.recovery.recoverStaleLock();
		}
	}
	if (!acquired) {
		throw new RemoteIndexLockedError(
			"Timed out waiting for the remote index transaction",
		);
	}

	let stage: IndexTransactionStage = "acquired";
	let originalSnapshot: IndexFileSnapshot | null = null;
	let merged: SyncIndex | null = null;
	let writtenFingerprint: string | null = null;
	try {
		enterStage("read-lock");
		try {
			originalSnapshot = await deps.readSnapshot(
				lockPath,
				true,
				deps.getCodecs().source,
				"source",
			);
		} catch (sourceReadError) {
			originalSnapshot = await deps.readUnparsedSnapshot(lockPath);
			throw sourceReadError;
		}
		enterStage("reduce");
		const reduced = await deps.reduceLockedIndex(
			originalSnapshot,
			initializedIndex,
			lockPath,
			transactionContext,
		);
		const latest = reduced.latest;
		merged = reduced.merged;
		if (deps.allowLegacyWrite() && merged.revision === latest.revision) {
			merged.revision = latest.revision + 1;
		}
		if (merged.revision !== latest.revision) {
			enterStage("write-lock");
			merged.format = CURRENT_INDEX_FORMAT;
			merged.deviceId = deps.getDeviceId();
			merged.lastSyncTime = Date.now();
			const content = deps.serialize(merged);
			let uploadError: unknown;
			try {
				const targetCodec = deps.getCodecs().target;
				if (targetCodec !== undefined) {
					await deps.client.uploadFileWithEncryptionService(
						lockPath,
						content,
						targetCodec,
					);
				} else {
					await deps.client.uploadFile(
						lockPath,
						content,
						true,
						false,
					);
				}
			} catch (error) {
				uploadError = error;
			}
			stage = "written";
			enterStage("verify-lock");
			const verifiedLock = await deps.readSnapshot(
				lockPath,
				deps.allowLegacyWrite(),
				deps.getCodecs().target,
				"target",
			);
			if (!sameIndexValue(verifiedLock.index, merged)) {
				await deps.recovery.logSemanticIndexMismatch(
					merged,
					verifiedLock.index,
					transactionContext,
				);
				if (uploadError) {
					throw uploadError instanceof Error
						? uploadError
						: new Error(
								"Lock upload failed with a non-Error value",
							);
				}
				throw new RemoteIndexContentMismatchError(
					"Written lock revision or contents could not be verified",
					stage,
				);
			}
			writtenFingerprint = verifiedLock.fingerprint;
			stage = "verified";
			logger.debug("Written index lock verified", {
				...transactionContext,
				mergedRevision: merged.revision,
				lockFingerprint: shortenDiagnosticValue(writtenFingerprint),
			});
		}
		if (writtenFingerprint === null) {
			enterStage("lock-fingerprint");
			const writtenLock = await deps.client.getResource(
				lockPath,
				1,
				0,
				true,
			);
			writtenFingerprint = deps.client.getContentFingerprint(writtenLock);
			stage = "verified";
		}
		stage = "move-attempted";
		enterStage("publish");
		if (deps.isReplacing()) {
			await deps.assertForceLocksUnchanged(lockPath);
		}
		let resolvedProof: CanonicalCommitProof | null = null;
		try {
			await deps.client.moveResourceExclusive(
				lockPath,
				canonicalPath,
				undefined,
				{ existingParentOnly: true },
			);
		} catch (error) {
			const recovered = await deps.recovery.recoverAmbiguousFinalMove(
				lockPath,
				canonicalPath,
				merged,
				writtenFingerprint,
			);
			if (recovered.outcome === "concurrent") {
				throw new RemoteIndexConcurrentModificationError(
					"Canonical index changed during the final move",
					stage,
					false,
					error,
				);
			}
			if (recovered.outcome !== "committed") {
				throw new AmbiguousRemoteIndexStateError(
					"Canonical index move could not be resolved safely",
					stage,
					error,
				);
			}
			resolvedProof = recovered.proof;
		}
		enterStage("verify-canonical");
		const canonicalProof =
			resolvedProof ??
			(await deps.recovery.verifyCanonicalCommit(
				lockPath,
				canonicalPath,
				merged,
				writtenFingerprint,
			));
		stage = "committed";
		logger.debug("Canonical index fingerprint verified", {
			...transactionContext,
			committedRevision: merged.revision,
			canonicalFingerprint: shortenDiagnosticValue(
				canonicalProof.contentFingerprint,
			),
		});
		enterStage("accept-commit");
		await deps.acceptCommit(merged, canonicalProof);
		logger.info("Canonical index transaction committed", {
			durationMs: Date.now() - transactionStartedAt,
			...transactionContext,
			outcome: "committed",
			stage,
			committedRevision: merged.revision,
			canonicalFingerprint: shortenDiagnosticValue(
				canonicalProof.contentFingerprint,
			),
		});
		return canonicalProof;
	} catch (e) {
		if (stage === "committed") {
			throw e;
		}
		enterStage("recover-commit");
		const canonicalProof =
			stage === "move-attempted" && merged
				? await deps.recovery.isExpectedCanonicalCommitted(
						lockPath,
						canonicalPath,
						merged,
						writtenFingerprint,
					)
				: null;
		if (merged && canonicalProof) {
			stage = "committed";
			enterStage("accept-commit");
			await deps.acceptCommit(merged, canonicalProof);
			logger.warn(
				"Canonical index commit was confirmed after an ambiguous response",
				{
					...transactionContext,
					outcome: "committed",
					stage,
					committedRevision: merged.revision,
					error: e,
				},
			);
			return canonicalProof;
		}

		enterStage("rollback");
		const rollbackOutcome = originalSnapshot
			? await deps.recovery.rollbackOwnedLock(
					lockPath,
					canonicalPath,
					originalSnapshot,
					transactionContext,
				)
			: "ambiguous";
		logger.error("Canonical index transaction failed", {
			...transactionContext,
			outcome: rollbackOutcome,
			failedStage: stage,
			expectedRevision: merged?.revision,
			actualRevision:
				rollbackOutcome === "rolled-back"
					? originalSnapshot?.index.revision
					: null,
			expectedEpoch: shortenDiagnosticValue(merged?.epoch),
			actualEpoch: shortenDiagnosticValue(
				rollbackOutcome === "rolled-back"
					? originalSnapshot?.index.epoch
					: null,
			),
			expectedFingerprint: shortenDiagnosticValue(writtenFingerprint),
			actualFingerprint: shortenDiagnosticValue(
				rollbackOutcome === "rolled-back"
					? originalSnapshot?.fingerprint
					: null,
			),
			error: e,
		});
		if (rollbackOutcome === "rolled-back") {
			if (e instanceof UnsupportedHistoricalDataError) {
				throw e;
			}
			throw new RemoteIndexRolledBackError(
				e instanceof Error
					? e.message
					: "Canonical index transaction failed",
				stage,
				e,
			);
		}
		if (rollbackOutcome === "concurrent") {
			throw new RemoteIndexConcurrentModificationError(
				"Canonical index changed while the transaction was active",
				stage,
				false,
				e,
			);
		}
		throw new AmbiguousRemoteIndexStateError(
			"Canonical index and lock require explicit recovery",
			stage,
			e,
		);
	}
}
