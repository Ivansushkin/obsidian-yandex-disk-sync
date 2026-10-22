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
	>;
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
		try {
			return await saveRemoteIndexLocked(deps);
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
			await waitForIndexRetry(INDEX_LOCK_RETRY_MS + Math.random() * 500);
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
): Promise<CanonicalCommitProof> {
	await deps.assertRemoteScope();
	const canonicalPath = deps.getCanonicalPath();
	const transactionId = deps.createTransactionId();
	const lockPath = joinPath(
		deps.getRemotePath(),
		`${REMOTE_INDEX_LOCK_PREFIX}${deps.getDeviceId()}.${transactionId}`,
	);
	const pending = deps.getPendingCounts();
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
	const initializedIndex = await deps.recovery.ensureCanonicalIndex();

	let acquired = false;
	for (let attempt = 0; attempt < INDEX_LOCK_ATTEMPTS; attempt++) {
		try {
			await deps.client.moveResourceExclusive(canonicalPath, lockPath);
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
		if (deps.isReplacing()) {
			await deps.assertForceLocksUnchanged(lockPath);
		}
		let resolvedProof: CanonicalCommitProof | null = null;
		try {
			await deps.client.moveResourceExclusive(lockPath, canonicalPath);
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
		await deps.acceptCommit(merged, canonicalProof);
		logger.info("Canonical index transaction committed", {
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
