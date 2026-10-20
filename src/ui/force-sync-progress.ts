import { formatOperationFailure } from "../sync/errors";
import { t } from "../i18n";
import type { ForceFlowState } from "../sync/workflows/force-controller";
import { formatSyncActivity } from "./sync-status-presentation";

/** Format the current Force phase for the foreground Notice. */
export function formatForceActivity(state: ForceFlowState): string {
	const stage = t(`notice.force_phase_${state.phase}`);
	return state.activity?.status === "syncing"
		? `${stage}: ${formatSyncActivity(state.activity)}`
		: stage;
}

/** A committed replacement can require recovery but can never be reported as rolled back. */
export function formatForceResult(state: ForceFlowState): string {
	if (state.outcome === "success") {
		return state.migration
			? t("notice.force_migration_completed")
			: t("notice.force_sync_completed", {
					successful: state.successful ?? 0,
				});
	}
	if (state.failure) {
		const prefix =
			state.outcome === "cleanup-pending"
				? `${t("notice.force_finalization_pending")} `
				: "";
		return prefix + formatOperationFailure(state.failure);
	}
	if (state.outcome === "backup-failed") {
		return t("notice.force_backup_failed");
	}
	if (state.outcome === "cleanup-pending") {
		return t("notice.force_finalization_pending");
	}
	if (state.errorCode === "force-backup-stale") {
		return t("notice.force_backup_stale");
	}
	if (state.errorCode === "force-source-changed") {
		return t("notice.force_source_changed");
	}
	return t("notice.force_flow_failed");
}
