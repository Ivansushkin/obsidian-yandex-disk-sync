import type { SyncState, SyncStatus } from "../types";
import { t } from "../i18n";

/**
 * Get status icon
 */
export function getSyncStatusIcon(status: SyncStatus): string {
	switch (status) {
		case "idle":
			return "cloud-check";
		case "syncing":
			return "refresh-cw";
		case "error":
			return "triangle-alert";
		case "paused":
			return "pause-circle";
		case "offline":
			return "cloud-off";
		case "initializing":
			return "loader-circle";
		case "encryption-required":
			return "lock-keyhole";
		case "migration-required":
			return "replace";
		default:
			return "cloud";
	}
}

/**
 * Get status text
 */
export function getSyncStatusText(state: SyncState): string {
	switch (state.status) {
		case "idle":
			if (state.lastSyncTime) {
				return t("status.last_sync", {
					time: formatTime(state.lastSyncTime),
				});
			}
			return t("status.ready_full");

		case "syncing":
			return `YD: ${formatSyncActivity(state)}`;

		case "error":
			return t("status.error");

		case "paused":
			return t("status.paused");

		case "offline":
			return t("status.offline");

		case "initializing":
			return t("status.initializing");

		case "encryption-required":
			return t("status.encryption_required");

		case "migration-required":
			return t("status.migration_required");

		default:
			return "YD";
	}
}

/**
 * Format time (time only)
 */
function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	return date.toLocaleTimeString("en-US", {
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** Format one sync activity consistently for the shared indicator and Notice. */
export function formatSyncActivity(state: SyncState): string {
	const operation = state.currentOperation ?? t("status.syncing");
	const progress =
		state.progress && state.progress.total > 0
			? ` ${state.progress.completed}/${state.progress.total}`
			: "";
	return `${operation}${progress}${formatSyncRetry(state)}${state.errorMessage ? `\n${state.errorMessage}` : ""}`;
}

/** The same bounded retry progress is visible on desktop, mobile and manual Notice. */
export function formatSyncRetry(state: SyncState): string {
	return state.retry
		? ` · ${t("failure.retry", { attempt: state.retry.attempt, maxAttempts: state.retry.maxAttempts })}`
		: "";
}
