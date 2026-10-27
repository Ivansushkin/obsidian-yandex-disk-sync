import {
	ForceRecoveryPendingError,
	ForceSourceFormatError,
	ForceScopeConflictError,
} from "./workflows/force-state";
import {
	OperationFailure,
	RemoteReadInterruptedError,
	type FailureContext,
	type FailureSummary,
} from "../errors";
import { UnsupportedHistoricalDataError } from "../compatibility-errors";
import { findErrorCause } from "../utils/error-utils";
import { LocalFileChangedError } from "../api/vault-adapter";
import { StorageScopeError } from "./local/storage-scope";
import { t } from "../i18n";
import type { SyncError, SyncResult } from "../types";

import {
	AmbiguousRemoteIndexStateError,
	RemoteIndexContentMismatchError,
	RemoteIndexLockedError,
	RemoteIndexTransactionError,
	LegacyPluginDataExposureError,
	LegacyServicePathCollisionError,
	AmbiguousRemoteIndexLockError,
	ForceBackupStaleError,
	ForceSourceChangedError,
	IndexEpochMismatchError,
	InvalidCurrentIndexError,
	LegacyIndexFormatError,
	PortablePathCollisionError,
	RemoteMaintenanceActiveError,
	UnreadableRemoteIndexError,
} from "./canonical/errors";

/** Format one sanitized failure for Notice, desktop, mobile and dialogs. */
export function formatOperationFailure(
	failure: FailureSummary,
	nextAction?: string,
): string {
	const location = failure.path ? ` · ${failure.path}` : "";
	const stageKey = `failure.stage.${failure.stage}`;
	const translated = t(stageKey);
	const stage = translated === stageKey ? failure.stage : translated;
	const message =
		failure.code === "force-source-format"
			? t("force.source_format_error")
			: failure.code === "force-scope-conflict"
				? t("force.scope_conflict")
				: failure.message;
	const nextKey =
		failure.code === "force-source-format"
			? "force-source-format"
			: failure.code === "force-scope-conflict"
				? "force-scope-conflict"
				: failure.code === "local-persistence"
					? "local-persistence"
					: failure.category;
	return `${t(`failure.category.${failure.category}`)} [${failure.code}] · ${t("failure.stage", { stage })}${location}: ${message}. ${t(`failure.outcome.${failure.outcome ?? "unknown"}`)} ${nextAction ?? t(`failure.next.${nextKey}`)}`;
}

/** Preserve the first reason and total failures without exposing raw exceptions. */
export function formatSyncErrorSummary(errors: readonly SyncError[]): string {
	const count = t("status.error_count", { errors: errors.length });
	const first = errors[0];
	if (!first) {
		return count;
	}
	const failure =
		first.failure ??
		new OperationFailure(
			new Error(first.message),
			{
				stage: first.operation,
				path: first.path,
				action: "unknown",
			},
			first.code ? { category: "safety", code: first.code } : undefined,
		).summary;
	return `${formatOperationFailure(failure)} (${count})`;
}

/** Adapt domain guards before considering any nested transport exception. */
export function createSyncFailure(
	error: unknown,
	context: FailureContext,
): OperationFailure {
	const code =
		error instanceof Error ? classifyDomainError(error) : undefined;
	return new OperationFailure(
		error,
		context,
		code ? { category: "safety", code } : undefined,
	);
}

/** Keep legacy SyncError fields alongside the safe shared projection. */
export function createSyncError(
	error: unknown,
	path: string,
	operation: SyncError["operation"],
	stage: string = operation,
): SyncError {
	const failure = createSyncFailure(error, {
		stage,
		path,
		action:
			operation === "download"
				? "read"
				: operation === "delete_local"
					? "local"
					: operation === "upload"
						? "put"
						: operation === "none"
							? "unknown"
							: "write",
	});
	return {
		path,
		operation,
		message: failure.summary.message,
		code: classifySyncError(failure),
		failure: failure.summary,
		failureCause: failure,
	};
}

/** Preserve failure priority while inspecting nested transaction causes. */
export function classifySyncError(error: Error): string | undefined {
	const domain = classifyDomainError(error);
	if (domain) {
		return domain;
	}
	const { code } = new OperationFailure(error, {
		stage: "classify",
		action: "unknown",
	}).summary;
	return code === "unknown" ? undefined : code;
}

function classifyDomainError(error: Error): string | undefined {
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof RemoteReadInterruptedError,
		)
	) {
		return "sync-interrupted";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof ForceScopeConflictError,
		)
	) {
		return "force-scope-conflict";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof ForceSourceFormatError,
		)
	) {
		return "force-source-format";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof ForceRecoveryPendingError,
		)
	) {
		return "force-recovery-pending";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof LocalFileChangedError,
		)
	) {
		return "local-file-changed";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof StorageScopeError,
		)
	) {
		return "local-state-blocked";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof UnsupportedHistoricalDataError,
		)
	) {
		return "unsupported-historical";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof LegacyIndexFormatError,
		)
	) {
		return "legacy-index";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof UnreadableRemoteIndexError,
		)
	) {
		return "unreadable-index";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof InvalidCurrentIndexError,
		)
	) {
		return "invalid-index";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof IndexEpochMismatchError,
		)
	) {
		return "epoch-replaced-during-sync";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof AmbiguousRemoteIndexLockError,
		)
	) {
		return "ambiguous-index-lock";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof RemoteMaintenanceActiveError,
		)
	) {
		return "remote-maintenance";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof ForceBackupStaleError,
		)
	) {
		return "force-backup-stale";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof ForceSourceChangedError,
		)
	) {
		return "force-source-changed";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof PortablePathCollisionError,
		)
	) {
		return "portable-path-collision";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof AmbiguousRemoteIndexStateError,
		)
	) {
		return "ambiguous-index-state";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof RemoteIndexContentMismatchError,
		)
	) {
		return "index-content-mismatch";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof RemoteIndexLockedError,
		)
	) {
		return "remote-index-locked";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof LegacyPluginDataExposureError,
		)
	) {
		return "legacy-plugin-data-exposure";
	}
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof LegacyServicePathCollisionError,
		)
	) {
		return "legacy-service-path-collision";
	}
	const transaction = findErrorCause(
		error,
		(candidate): candidate is RemoteIndexTransactionError =>
			candidate instanceof RemoteIndexTransactionError,
	);
	if (transaction) {
		return `canonical-${transaction.outcome}`;
	}
	const inherited = findErrorCause(
		error,
		(candidate): candidate is OperationFailure =>
			candidate instanceof OperationFailure &&
			candidate.summary.category === "safety",
	);
	return inherited?.summary.code;
}

/** Publish a coherent first failure and partial outcome after all started work settles. */
export function summarizeSyncFailure(result: SyncResult, stage: string): void {
	const partial =
		result.uploaded +
			result.downloaded +
			result.deleted +
			result.conflicts >
		0;
	for (const error of result.errors) {
		if (!error.failure) {
			const failure = new OperationFailure(
				error.failureCause ?? new Error(error.message),
				{ stage, path: error.path, action: "unknown" },
				error.code
					? { category: "safety", code: error.code }
					: undefined,
			);
			error.failure = failure.summary;
			error.failureCause = failure;
		}
		if (partial) {
			error.failure = { ...error.failure, outcome: "partial" };
		}
	}
	result.failure = result.errors[0]?.failure;
	result.failureCause = result.errors[0]?.failureCause;
}
