/**
 * Synchronization status indicator in status bar
 */

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
		const icon = this.getStatusIcon(state.status);
		const text = this.getStatusText(state);

		this.statusBarEl.empty();
		this.statusBarEl.createSpan({ text: `${icon} ${text}` });

		// Обновляем класс для стилизации
		this.statusBarEl.removeClass(
			"sync-idle",
			"sync-syncing",
			"sync-error",
			"sync-paused"
		);
		this.statusBarEl.addClass(`sync-${state.status}`);

		// Добавляем tooltip
		this.statusBarEl.setAttribute("aria-label", this.getTooltip(state));
	}

	/**
	 * Get status icon
	 */
	private getStatusIcon(status: SyncStatus): string {
		switch (status) {
			case "idle":
				return "[ ]";
			case "syncing":
				return "[~]";
			case "error":
				return "[!]";
			case "paused":
				return "[||]";
			case "offline":
				return "[X]";
			case "initializing":
				return "[...]";
			default:
				return "[-]";
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
				if (state.progress !== undefined) {
					return `YD: ${state.progress}%`;
				}
				return t("status.syncing");

			case "error":
				return t("status.error");

			case "paused":
				return t("status.paused");

			case "offline":
				return t("status.offline");

			case "initializing":
				return t("status.initializing");

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
				if (state.currentOperation) {
					lines.push(t("status.tooltip.syncing_current", { operation: state.currentOperation }));
				}
				if (state.pendingCount > 0) {
					lines.push(t("status.tooltip.syncing_pending", { count: state.pendingCount }));
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
