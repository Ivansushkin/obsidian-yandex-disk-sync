/**
 * Initial synchronization modal
 */

import { App, Modal, Setting } from "obsidian";
import type { InitMode } from "../types";
import { t } from "../i18n";

export class InitSyncModal extends Modal {
	private result: InitMode | null = null;
	private onSubmit: (mode: InitMode | null) => void;
	private remoteHasFiles: boolean;
	private localHasFiles: boolean;

	constructor(
		app: App,
		remoteHasFiles: boolean,
		localHasFiles: boolean,
		onSubmit: (mode: InitMode | null) => void
	) {
		super(app);
		this.remoteHasFiles = remoteHasFiles;
		this.localHasFiles = localHasFiles;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl("h2", { text: t("modal.init_title") });

		contentEl.createEl("p", {
			text: t("modal.init_description"),
		});

		// State information
		const infoEl = contentEl.createDiv("init-sync-info");
		infoEl.createEl("p", {
			text: t("modal.init_local_files", { status: t(this.localHasFiles ? "generic.exists" : "generic.none") }),
		});
		infoEl.createEl("p", {
			text: t("modal.init_remote_files", { status: t(this.remoteHasFiles ? "generic.exists" : "generic.none") }),
		});

		// Options
		new Setting(contentEl)
			.setName(t("modal.init_download_desc"))
			.setDesc(t("modal.init_download_desc"))
			.addButton((btn) =>
				btn
					.setButtonText(t("modal.init_download_button"))
					.setCta()
					.onClick(() => {
						this.result = "download";
						this.close();
					})
			);

		new Setting(contentEl)
			.setName(t("modal.init_upload_desc"))
			.setDesc(t("modal.init_upload_desc"))
			.addButton((btn) =>
				btn.setButtonText(t("modal.init_upload_button")).onClick(() => {
					this.result = "upload";
					this.close();
				})
			);

		new Setting(contentEl)
			.setName(t("modal.init_merge_desc"))
			.setDesc(t("modal.init_merge_desc"))
			.addButton((btn) =>
				btn
					.setButtonText(t("modal.init_merge_button"))
					.setCta()
					.onClick(() => {
						this.result = "merge";
						this.close();
					})
			);

		// Cancel button
		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText(t("modal.init_cancel_button")).onClick(() => {
				this.result = null;
				this.close();
			})
		);
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.onSubmit(this.result);
	}
}

/**
 * Synchronization status modal
 */
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
