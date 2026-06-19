/**
 * Modal for viewing plugin debug logs.
 */

import { App, Modal, Setting, TextAreaComponent } from "obsidian";
import { logger } from "../utils/logger";
import { t } from "../i18n";

export class LogViewerModal extends Modal {
	private logContent = "";
	private textArea: TextAreaComponent | null = null;

	constructor(app: App) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();

		this.titleEl.setText(t("modal.log_viewer_title"));

		this.logContent = await logger.getLogContents();

		new Setting(contentEl)
			.setName(t("modal.log_viewer_label"))
			.setDesc(t("modal.log_viewer_desc"))
			.addTextArea((textArea: TextAreaComponent) => {
				this.textArea = textArea;
				textArea
					.setValue(this.logContent)
					.setDisabled(true);
				textArea.inputEl.rows = 24;
				textArea.inputEl.addClass("log-viewer-textarea");
			});

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText(t("modal.log_viewer_refresh"))
					.onClick(async () => {
						this.logContent = await logger.getLogContents();
						if (this.textArea) {
							this.textArea.setValue(this.logContent);
						}
					})
			)
			.addButton((button) =>
				button
					.setButtonText(t("modal.log_viewer_copy"))
					.onClick(async () => {
						await navigator.clipboard.writeText(this.logContent);
					})
			)
			.addButton((button) =>
				button
					.setButtonText(t("modal.log_viewer_clear"))
					// eslint-disable-next-line @typescript-eslint/no-deprecated
					.setWarning()
					.onClick(async () => {
						await logger.clearLogs();
						this.logContent = "";
						if (this.textArea) {
							this.textArea.setValue("");
						}
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
