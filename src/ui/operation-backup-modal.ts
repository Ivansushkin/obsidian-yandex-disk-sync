import { App, Modal, Setting } from "obsidian";
import type { OperationBackupChoice } from "../backup/operation-backup-choice";
import { t } from "../i18n";

/** Resolve exactly one archive choice, including dismissal of the dialog. */
export class OperationBackupModal extends Modal {
	private settled = false;
	constructor(
		app: App,
		private readonly resolve: (choice: OperationBackupChoice) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h2", {
			text: t("modal.operation_backup_title"),
		});
		this.contentEl.createEl("p", {
			text: t("modal.operation_backup_description"),
		});
		const buttons = new Setting(this.contentEl)
			.addButton((button) =>
				button
					.setButtonText(t("modal.force_sync_backup_button"))
					.setCta()
					.onClick(() => this.finish("with-backup")),
			)
			.addButton((button) =>
				button
					.setButtonText(t("modal.continue_without_backup"))
					.onClick(() => this.finish("without-backup")),
			)
			.addButton((button) =>
				button
					.setButtonText(t("modal.cancel_button"))
					.onClick(() => this.finish("cancel")),
			);
		buttons.settingEl.addClass("sync-modal-actions");
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.resolve("cancel");
		}
	}

	private finish(choice: OperationBackupChoice): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.resolve(choice);
		this.close();
	}
}
