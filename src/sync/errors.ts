import { YandexApiError } from "../api/yandex-client";
import { UnsupportedHistoricalDataError } from "../compatibility-errors";
import { findErrorCause } from "../utils/error-utils";
import { StorageScopeError } from "./local/storage-scope";
import {
	AmbiguousRemoteIndexLockError,
	ForceBackupStaleError,
	ForceSourceChangedError,
	IndexEpochMismatchError,
	InvalidCurrentIndexError,
	LegacyIndexFormatError,
	PortablePathCollisionError,
	RemoteMaintenanceActiveError,
	UnreadableRemoteIndexError,
} from "./canonical/manager";

/** Preserve failure priority while inspecting nested transaction causes. */
export function classifySyncError(error: Error): string | undefined {
	if (
		findErrorCause(
			error,
			(candidate) => candidate instanceof StorageScopeError,
		)
	) {
		return "local-state-blocked";
	}
	const apiError = findErrorCause(
		error,
		(candidate): candidate is YandexApiError =>
			candidate instanceof YandexApiError,
	);
	if (apiError && (apiError.status === 401 || apiError.status === 403)) {
		return "authentication";
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
	return undefined;
}
