import { YandexApiError } from "../../errors";
import { findErrorCause } from "../../utils/error-utils";
import {
	shouldRetryIndexTransaction,
	type IndexCodec,
	type IndexTransactionOutcome,
	type IndexTransactionStage,
} from "./transaction";

type IndexDecodeStage = "decrypt" | "json";

export interface IndexDecodeAttempt {
	codec: IndexCodec;
	stage: IndexDecodeStage;
	errorName: string;
}

function isTransientIndexCause(error: unknown): boolean {
	const semantic = findErrorCause(
		error,
		(
			candidate,
		): candidate is
			IndexEpochMismatchError | RemoteMaintenanceActiveError =>
			candidate instanceof IndexEpochMismatchError ||
			candidate instanceof RemoteMaintenanceActiveError,
	);
	if (semantic) {
		return false;
	}
	const apiError = findErrorCause(
		error,
		(candidate): candidate is YandexApiError =>
			candidate instanceof YandexApiError,
	);
	if (apiError) {
		return [409, 423, 429, 503].includes(apiError.status);
	}
	return (
		findErrorCause(
			error,
			(candidate) =>
				candidate instanceof TypeError ||
				candidate.name === "AbortError" ||
				candidate.name === "TimeoutError" ||
				/(?:network|fetch|timed? out|econn|socket)/i.test(
					candidate.message,
				),
		) !== null
	);
}

export class RemoteIndexTransactionError extends Error {
	readonly retryable: boolean;
	readonly cause?: unknown;

	constructor(
		message: string,
		name: string,
		readonly outcome: IndexTransactionOutcome,
		readonly stage: IndexTransactionStage,
		lockContention: boolean,
		cause?: unknown,
		retryableOverride?: boolean,
	) {
		super(message);
		this.name = name;
		this.retryable =
			retryableOverride ??
			shouldRetryIndexTransaction(outcome, lockContention);
		this.cause = cause;
	}
}

/**
 * Thrown when another writer conclusively changed canonical index state.
 */
export class RemoteIndexConcurrentModificationError extends RemoteIndexTransactionError {
	constructor(
		message: string,
		stage: IndexTransactionStage = "acquired",
		lockContention = true,
		cause?: unknown,
	) {
		super(
			message,
			"RemoteIndexConcurrentModificationError",
			"concurrent",
			stage,
			lockContention,
			cause,
		);
	}
}

export class ForceBackupStaleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ForceBackupStaleError";
	}
}

export class ForceSourceChangedError extends Error {
	constructor() {
		super(
			"Force source changed after verification; create a new backup and retry",
		);
		this.name = "ForceSourceChangedError";
	}
}

export class PortablePathCollisionError extends Error {
	constructor() {
		super(
			"Remote paths collide under Unicode normalization or case folding",
		);
		this.name = "PortablePathCollisionError";
	}
}

export class LegacyPluginDataExposureError extends Error {
	constructor() {
		super(
			"Stable 1.1 remote data may contain this plugin's local settings. Remove the remote plugin directory and replace the OAuth token before migration",
		);
		this.name = "LegacyPluginDataExposureError";
	}
}

export class LegacyServicePathCollisionError extends Error {
	constructor() {
		super(
			"A stable 1.1 user path conflicts with a current service name or path rule and must be renamed before migration",
		);
		this.name = "LegacyServicePathCollisionError";
	}
}

export class RemoteIndexContentMismatchError extends RemoteIndexTransactionError {
	constructor(message: string, stage: IndexTransactionStage) {
		super(
			message,
			"RemoteIndexContentMismatchError",
			"ambiguous",
			stage,
			false,
		);
	}
}

export class RemoteIndexRolledBackError extends RemoteIndexTransactionError {
	constructor(
		message: string,
		stage: IndexTransactionStage,
		cause?: unknown,
	) {
		super(
			message,
			"RemoteIndexRolledBackError",
			"rolled-back",
			stage,
			false,
			cause,
			isTransientIndexCause(cause),
		);
	}
}

export class AmbiguousRemoteIndexStateError extends RemoteIndexTransactionError {
	constructor(
		message: string,
		stage: IndexTransactionStage,
		cause?: unknown,
	) {
		super(
			message,
			"AmbiguousRemoteIndexStateError",
			"ambiguous",
			stage,
			false,
			cause,
		);
	}
}

export class RemoteIndexLockedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RemoteIndexLockedError";
	}
}

export class LegacyIndexFormatError extends Error {
	constructor() {
		super(
			"A stable 1.x synchronization index requires one explicit Force sync with a verified backup.",
		);
		this.name = "LegacyIndexFormatError";
	}
}

export class InvalidCurrentIndexError extends Error {
	constructor(
		readonly section: string,
		reason: string,
	) {
		super(`Current remote sync index is invalid in ${section}: ${reason}.`);
		this.name = "InvalidCurrentIndexError";
	}
}

export class UnreadableRemoteIndexError extends Error {
	readonly rawSize: number;
	readonly fingerprint: string | null;
	readonly rawSha256: string;
	readonly attempts: IndexDecodeAttempt[];

	constructor(details: {
		rawSize: number;
		fingerprint: string | null;
		rawSha256: string;
		attempts: IndexDecodeAttempt[];
	}) {
		super(
			"Remote sync index could not be decoded with any permitted codec.",
		);
		this.name = "UnreadableRemoteIndexError";
		this.rawSize = details.rawSize;
		this.fingerprint = details.fingerprint;
		this.rawSha256 = details.rawSha256;
		this.attempts = details.attempts.map((attempt) => ({ ...attempt }));
	}
}

export class AmbiguousRemoteIndexLockError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AmbiguousRemoteIndexLockError";
	}
}

export class IndexEpochMismatchError extends Error {
	constructor(
		readonly observedEpoch: string,
		readonly canonicalEpoch: string,
	) {
		super(
			"Canonical sync history changed and requires a full reconciliation.",
		);
		this.name = "IndexEpochMismatchError";
	}
}

export class RemoteMaintenanceActiveError extends Error {
	constructor(
		public readonly transitionId: string,
		public readonly initiatedBy: string,
	) {
		super(
			`Remote encryption maintenance ${transitionId} is owned by ${initiatedBy}`,
		);
		this.name = "RemoteMaintenanceActiveError";
	}
}
