import { formatOperationFailure } from "../sync/errors";
import { t } from "../i18n";
import type { ForceFlowState } from "../sync/workflows/force-controller";
import { formatSyncActivity } from "./sync-status-presentation";

/** Format the current Force phase for the foreground Notice. */
export function formatForceActivity(state: ForceFlowState): string {
	if (state.phase === "preflight" && state.failure) {
		return t("force.preparation_failed");
	}
	if (state.phase === "preflight" && state.sourceProgress) {
		return t("force.source_progress", state.sourceProgress);
	}
	const stage = t(`notice.force_phase_${state.phase}`);
	return state.activity?.status === "syncing"
		? `${stage}: ${formatSyncActivity(state.activity)}`
		: stage;
}

/** A committed replacement can require recovery but can never be reported as rolled back. */
export function formatForceResult(state: ForceFlowState): string {
	if (state.outcome === "success") {
		if (state.direct && state.direction === "from_remote") {
			return (
				t("notice.force_sync_completed", {
					successful: state.successful ?? 0,
				}) +
				" " +
				t("force.restart_required")
			);
		}
		return state.migration
			? t("notice.force_migration_completed")
			: t("notice.force_sync_completed", {
					successful: state.successful ?? 0,
				});
	}
	if (state.failure) {
		if (state.direct) {
			return formatOperationFailure(
				state.failure,
				t(
					state.outcome === "recovery-pending"
						? "force.partial_result"
						: "force.not_started",
					{
						successful: state.successful ?? 0,
						failed: state.failed ?? 1,
					},
				),
			);
		}
		if (state.outcome === "recovery-pending") {
			return formatOperationFailure(
				state.failure,
				t("notice.force_resume_pending"),
			);
		}
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
	if (state.outcome === "recovery-pending") {
		return t("notice.force_resume_pending");
	}
	if (state.errorCode === "force-backup-stale") {
		return t("notice.force_backup_stale");
	}
	if (state.errorCode === "force-source-changed") {
		return t("notice.force_source_changed");
	}
	return t("notice.force_flow_failed");
}
