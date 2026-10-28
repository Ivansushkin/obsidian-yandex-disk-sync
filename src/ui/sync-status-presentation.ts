import { formatOperationFailure } from "../sync/errors";
import type { RetryProgress } from "../errors";
import type { ForceFlowState } from "../sync/workflows/force-controller";
import type { SyncState, SyncStatus } from "../types";
import { getActiveLanguage, t } from "../i18n";

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
	return date.toLocaleTimeString(getActiveLanguage(), {
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

export interface SyncIndicatorContext {
	sync: SyncState;
	force: ForceFlowState | null;
	foreground: "encryption" | "backup" | null;
	fullSyncInProgress: boolean;
	connection?: { errorMessage?: string; retry?: RetryProgress };
	syncUnavailable: boolean;
	manualSyncRequired?: boolean;
	operationError?: string;
}

export interface SyncPresentation {
	state: SyncState;
	text: string;
	detail: string;
	progress: string;
	busy: boolean;
	icon: string;
}

/** Resolve one display priority for the indicator and settings status Notice. */
export function getSyncPresentation(
	context: SyncIndicatorContext,
): SyncPresentation {
	const {
		sync,
		force,
		foreground,
		fullSyncInProgress,
		connection,
		manualSyncRequired,
	} = context;
	let state = sync;
	let text: string;
	let detail = "";
	let progress = "";

	if (force?.active) {
		state = { ...sync, status: "syncing" };
		text = t(`notice.force_phase_${force.phase}`);
		if (force.activity?.status === "syncing") {
			text += `: ${force.activity.currentOperation ?? t("status.syncing")}`;
			progress =
				progressText(force.activity) + formatSyncRetry(force.activity);
			detail = force.activity.failure
				? formatOperationFailure(force.activity.failure)
				: (force.activity.errorMessage ?? "");
		}
	} else if (sync.status === "syncing") {
		text = sync.currentOperation ?? t("status.syncing");
		progress = progressText(sync) + formatSyncRetry(sync);
		detail = sync.failure
			? formatOperationFailure(sync.failure)
			: (sync.errorMessage ?? "");
	} else if (foreground) {
		state = { ...sync, status: "syncing" };
		text = t(`status.mobile.${foreground}`);
	} else if (connection) {
		state = { ...sync, status: "syncing", retry: connection.retry };
		text = t("status.checking_connection");
		detail = connection.errorMessage ?? "";
		progress = formatSyncRetry(state);
	} else if (
		fullSyncInProgress &&
		(sync.status === "idle" || sync.status === "initializing")
	) {
		state = { ...sync, status: "syncing" };
		text = t("status.syncing");
	} else if (
		manualSyncRequired &&
		(sync.status === "idle" || sync.status === "initializing")
	) {
		state = { ...sync, status: "idle" };
		text = t("status.manual_sync_required");
	} else if (sync.status === "idle") {
		text = t("status.mobile.ready");
		if (sync.lastSyncTime) {
			const time = new Date(sync.lastSyncTime).toLocaleTimeString(
				getActiveLanguage(),
				{
					hour: "2-digit",
					minute: "2-digit",
					hour12: false,
				},
			);
			text = `${t("status.mobile.last_sync")} ${time}`;
		}
	} else {
		text =
			sync.status === "paused" || sync.status === "error"
				? t(`status.mobile.${sync.status}`)
				: getSyncStatusText(sync);
		detail = sync.failure
			? formatOperationFailure(sync.failure)
			: (sync.errorMessage ?? "");
	}
	if (context.operationError && state.status !== "syncing") {
		const wasIdle =
			state.status === "idle" || state.status === "initializing";
		state = {
			...state,
			status: wasIdle ? "error" : state.status,
			errorMessage: context.operationError,
			failure: undefined,
		};
		if (wasIdle) {
			text = t("status.mobile.error");
		}
		detail = context.operationError;
	}
	const busy = state.status === "syncing" || state.status === "initializing";
	let icon = busy ? "cloud" : getSyncStatusIcon(state.status);
	if (busy && force?.active) {
		icon = "replace";
	}
	if (busy && foreground) {
		icon = foreground === "encryption" ? "lock-keyhole" : "archive";
	}
	if (busy && detail) {
		icon = "triangle-alert";
	}
	return { state, text, detail, progress, busy, icon };
}

/** Format known progress without inventing totals for preparation phases. */
function progressText(state: SyncState): string {
	return state.progress && state.progress.total > 0
		? `${state.progress.completed}/${state.progress.total}`
		: "";
}
