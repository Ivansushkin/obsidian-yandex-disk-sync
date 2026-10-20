/**
 * Synchronization status indicator in status bar
 */

import { setIcon } from "obsidian";
import type { SyncState } from "../types";
import { SyncEngine } from "../sync/engine";
import {
	getSyncStatusIcon,
	getSyncStatusText,
	getSyncStatusTooltip,
} from "./sync-status-presentation";

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
		const text = getSyncStatusText(state);

		this.statusBarEl.empty();
		const iconEl = this.statusBarEl.createSpan({
			cls: "yandex-sync-status-icon",
		});
		setIcon(iconEl, getSyncStatusIcon(state.status));
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
			"sync-migration-required",
			"sync-encryption-required",
		);
		this.statusBarEl.addClass(`sync-${state.status}`);

		// Add tooltip
		this.statusBarEl.setAttribute(
			"aria-label",
			getSyncStatusTooltip(state),
		);
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
