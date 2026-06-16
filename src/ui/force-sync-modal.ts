import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

export type ForceSyncDirection = "from_local" | "from_remote";

export class ForceSyncModal extends Modal {
	private direction: ForceSyncDirection;
	private onBackup: () => Promise<{ success: boolean }>;
	private onAction: (action: "proceed" | "cancel") => void;

	constructor(
		app: App,
		direction: ForceSyncDirection,
		onBackup: () => Promise<{ success: boolean }>,
		onAction: (action: "proceed" | "cancel") => void
	) {
		super(app);
		this.direction = direction;
		this.onBackup = onBackup;
		this.onAction = onAction;
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl("h2", { text: t("modal.force_sync_title") });

		const text =
			this.direction === "from_local"
				? t("modal.force_sync_from_local_text")
				: t("modal.force_sync_from_remote_text");

		contentEl.createEl("p", { text });

		const warningEl = contentEl.createDiv({ cls: "force-sync-warning" });
		warningEl.createEl("strong", { text: t("modal.force_sync_warning") });

		contentEl.createEl("p", {
			text: t("modal.force_sync_recommend_backup"),
		});

		const setting = new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(t("modal.force_sync_backup_button"))
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText(t("settings.backup_in_progress"));
						await this.onBackup();
						this.close();
						this.onAction("proceed");
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText(t("modal.force_sync_proceed_button"))
					.onClick(() => {
						this.close();
						this.onAction("proceed");
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText(t("modal.cancel_button"))
					.onClick(() => {
						this.close();
						this.onAction("cancel");
					})
			);
		setting.settingEl.addClass("force-sync-modal-buttons");
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}
