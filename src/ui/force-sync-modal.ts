import type { OperationBackupChoice } from "../backup/operation-backup-choice";
import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

export type ForceSyncDirection = "from_local" | "from_remote";

export class ForceSyncModal extends Modal {
	private direction: ForceSyncDirection;
	private onAction: (action: OperationBackupChoice) => void;
	private requireLegacyClientsStopped: boolean;
	private settled = false;

	constructor(
		app: App,
		direction: ForceSyncDirection,
		onAction: (action: OperationBackupChoice) => void,
		requireLegacyClientsStopped = false,
	) {
		super(app);
		this.direction = direction;
		this.onAction = onAction;
		this.requireLegacyClientsStopped = requireLegacyClientsStopped;
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
		let legacyClientsStopped = !this.requireLegacyClientsStopped;
		const continueButtons: { setDisabled(disabled: boolean): unknown }[] =
			[];
		if (this.requireLegacyClientsStopped) {
			new Setting(contentEl)
				.setName(t("modal.force_sync_legacy_devices_title"))
				.setDesc(t("modal.force_sync_legacy_devices_desc"))
				.addToggle((toggle) =>
					toggle.setValue(false).onChange((value) => {
						legacyClientsStopped = value;
						for (const button of continueButtons) {
							button.setDisabled(!value);
						}
					}),
				);
		}

		const setting = new Setting(contentEl)
			.addButton((btn) =>
				(continueButtons.push(btn), btn)
					.setDisabled(this.requireLegacyClientsStopped)
					.setButtonText(t("modal.force_sync_backup_button"))
					.setCta()
					.onClick(() => {
						if (!legacyClientsStopped) {
							return;
						}
						btn.setDisabled(true);
						this.finish("with-backup");
					}),
			)
			.addButton((btn) => {
				continueButtons.push(btn);
				btn.setDisabled(this.requireLegacyClientsStopped)
					.setButtonText(t("modal.continue_without_backup"))
					.onClick(() => {
						if (legacyClientsStopped) {
							this.finish("without-backup");
						}
					});
			})
			.addButton((btn) =>
				btn.setButtonText(t("modal.cancel_button")).onClick(() => {
					this.finish("cancel");
				}),
			);
		setting.settingEl.addClass("force-sync-modal-buttons");
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.onAction("cancel");
		}
	}

	private finish(action: OperationBackupChoice): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.onAction(action);
		this.close();
	}
}
