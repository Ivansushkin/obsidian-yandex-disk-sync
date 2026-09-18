import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

export type ForceSyncDirection = "from_local" | "from_remote";

export class ForceSyncModal extends Modal {
	private direction: ForceSyncDirection;
	private onAction: (action: "proceed" | "cancel") => void;
	private requireLegacyClientsStopped: boolean;
	private settled = false;

	constructor(
		app: App,
		direction: ForceSyncDirection,
		onAction: (action: "proceed" | "cancel") => void,
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
		let continueButton: { setDisabled(disabled: boolean): unknown } | null = null;
		if (this.requireLegacyClientsStopped) {
			new Setting(contentEl)
				.setName(t("modal.force_sync_legacy_devices_title"))
				.setDesc(t("modal.force_sync_legacy_devices_desc"))
				.addToggle((toggle) =>
					toggle.setValue(false).onChange((value) => {
						legacyClientsStopped = value;
						continueButton?.setDisabled(!value);
					}),
				);
		}

		const setting = new Setting(contentEl)
			.addButton((btn) =>
				(continueButton = btn)
					.setDisabled(this.requireLegacyClientsStopped)
					.setButtonText(t("modal.force_sync_backup_button"))
					.setCta()
					.onClick(() => {
						if (!legacyClientsStopped) return;
						btn.setDisabled(true);
						this.finish("proceed");
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText(t("modal.cancel_button"))
					.onClick(() => {
						this.finish("cancel");
					})
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

	private finish(action: "proceed" | "cancel"): void {
		if (this.settled) return;
		this.settled = true;
		this.onAction(action);
		this.close();
	}
}
