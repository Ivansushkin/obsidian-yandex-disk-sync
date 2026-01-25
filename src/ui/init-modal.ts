/**
 * Synchronization status modal
 */

import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

export class SyncStatusModal extends Modal {
	private lastSyncTime: number | undefined;
	private uploaded: number;
	private downloaded: number;
	private deleted: number;
	private errors: number;

	constructor(
		app: App,
		stats: {
			lastSyncTime?: number;
			uploaded: number;
			downloaded: number;
			deleted: number;
			errors: number;
		}
	) {
		super(app);
		this.lastSyncTime = stats.lastSyncTime;
		this.uploaded = stats.uploaded;
		this.downloaded = stats.downloaded;
		this.deleted = stats.deleted;
		this.errors = stats.errors;
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl("h2", { text: t("modal.status_title") });

		const statsEl = contentEl.createDiv("sync-status-stats");

		if (this.lastSyncTime) {
			const date = new Date(this.lastSyncTime);
			statsEl.createEl("p", {
				text: t("modal.status_last_sync", { time: date.toLocaleString() }),
			});
		} else {
			statsEl.createEl("p", {
				text: t("modal.status_no_sync"),
			});
		}

		statsEl.createEl("p", { text: t("modal.status_uploaded", { count: this.uploaded }) });
		statsEl.createEl("p", { text: t("modal.status_downloaded", { count: this.downloaded }) });
		statsEl.createEl("p", { text: t("modal.status_deleted", { count: this.deleted }) });
		statsEl.createEl("p", { text: t("modal.status_errors", { count: this.errors }) });

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText(t("modal.close_button")).onClick(() => {
				this.close();
			})
		);
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Action confirmation modal
 */
export class ConfirmModal extends Modal {
	private message: string;
	private onConfirm: (confirmed: boolean) => void;

	constructor(
		app: App,
		message: string,
		onConfirm: (confirmed: boolean) => void
	) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl("p", { text: this.message });

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(t("modal.confirm_button"))
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm(true);
					})
			)
			.addButton((btn) =>
				btn.setButtonText(t("modal.cancel_button")).onClick(() => {
					this.close();
					this.onConfirm(false);
				})
			);
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}
