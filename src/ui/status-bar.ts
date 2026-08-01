/**
 * Synchronization status indicator in status bar
 */

import { setIcon } from "obsidian";
import type { SyncState, SyncStatus } from "../types";
import { SyncEngine } from "../sync/sync-engine";
import { t } from "../i18n";

export class SyncStatusBar {
	private statusBarEl: HTMLElement;
	private syncEngine: SyncEngine;
	private unsubscribe: (() => void) | null = null;

	constructor(statusBarEl: HTMLElement, syncEngine: SyncEngine) {
		this.statusBarEl = statusBarEl;
		this.syncEngine = syncEngine;

		this.setupStatusBar();
		this.subscribeToChanges();
	}

	/**
	 * Setup status bar
	 */
	private setupStatusBar(): void {
		this.statusBarEl.addClass("yandex-sync-status");
		this.updateDisplay(this.syncEngine.getState());
	}

	/**
	 * Subscribe to state changes
	 */
	private subscribeToChanges(): void {
		this.unsubscribe = this.syncEngine.onStateChange((state) => {
			this.updateDisplay(state);
		});
	}

	/**
	 * Update display
	 */
	private updateDisplay(state: SyncState): void {
		const text = this.getStatusText(state);

		this.statusBarEl.empty();
		const iconEl = this.statusBarEl.createSpan({
			cls: "yandex-sync-status-icon",
		});
		setIcon(iconEl, this.getStatusIcon(state.status));
		this.statusBarEl.createSpan({
			cls: "yandex-sync-status-text",
			text,
		});

		// Update the CSS class for styling
		this.statusBarEl.removeClass(
			"sync-idle",
			"sync-syncing",
			"sync-error",
			"sync-paused",
			"sync-offline",
			"sync-initializing",
			"sync-encryption-required"
		);
		this.statusBarEl.addClass(`sync-${state.status}`);

		// Add tooltip
		this.statusBarEl.setAttribute("aria-label", this.getTooltip(state));
	}

	/**
	 * Get status icon
	 */
	private getStatusIcon(status: SyncStatus): string {
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
			default:
				return "cloud";
		}
	}

	/**
	 * Get status text
	 */
	private getStatusText(state: SyncState): string {
		switch (state.status) {
			case "idle":
				if (state.lastSyncTime) {
					return t("status.last_sync", { time: this.formatTime(state.lastSyncTime) });
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

			default:
				return "YD";
		}
	}

	/**
	 * Get tooltip
	 */
	private getTooltip(state: SyncState): string {
		const lines: string[] = ["Yandex Disk Sync"];

		switch (state.status) {
			case "idle":
				lines.push(t("status.tooltip.idle"));
				break;
			case "syncing":
				lines.push(t("status.tooltip.syncing"));
				if (state.sessionKind) {
					lines.push(
						t("status.tooltip.session", {
							session: t(`status.session.${state.sessionKind}`),
						}),
					);
				}
				if (state.currentOperation) {
					lines.push(t("status.tooltip.syncing_current", { operation: state.currentOperation }));
				}
				if (state.progress) {
					lines.push(
						t("status.tooltip.progress", {
							completed: state.progress.completed,
							total: state.progress.total,
						}),
					);
				}
				if (state.startedAt) {
					lines.push(
						t("status.tooltip.started", {
							datetime: this.formatDateTime(state.startedAt),
						}),
					);
				}
				break;
			case "error":
				lines.push(t("status.tooltip.error"));
				if (state.errorMessage) {
					lines.push(t("status.tooltip.error_details", { message: state.errorMessage }));
				}
				break;
			case "paused":
				lines.push(t("status.tooltip.paused"));
				break;
			case "offline":
				lines.push(t("status.tooltip.offline"));
				break;
			case "initializing":
				lines.push(t("status.tooltip.initializing"));
				break;
			case "encryption-required":
				lines.push(t("status.tooltip.encryption_required"));
				if (state.errorMessage) {
					lines.push(state.errorMessage);
				}
				break;
		}

		if (state.lastSyncTime) {
			lines.push(t("status.tooltip.last_sync", { datetime: this.formatDateTime(state.lastSyncTime) }));
		}

		return lines.join("\n");
	}

	/**
	 * Format time (time only)
	 */
	private formatTime(timestamp: number): string {
		const date = new Date(timestamp);
		return date.toLocaleTimeString("en-US", {
			hour: "2-digit",
			minute: "2-digit",
		});
	}

	/**
	 * Format date and time
	 */
	private formatDateTime(timestamp: number): string {
		const date = new Date(timestamp);
		return date.toLocaleString("en-US", {
			day: "2-digit",
			month: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		});
	}

	/**
	 * Cleanup on unload
	 */
	destroy(): void {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
		}
	}
}

/** Format one sync activity consistently for the status bar and Notice. */
export function formatSyncActivity(state: SyncState): string {
	const operation = state.currentOperation ?? t("status.syncing");
	if (!state.progress || state.progress.total <= 0) return operation;
	return `${operation} ${state.progress.completed}/${state.progress.total}`;
}
