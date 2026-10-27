import { App, Modal, Setting } from "obsidian";
import type { StorageBindingChoice } from "../sync/local/storage-binding";
import { t } from "../i18n";

/** Ask once before an unbound history gains permission to affect a remote root. */
export class StorageBindingModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly path: string,
		private readonly canKeepHistory: boolean,
		private readonly resolve: (choice: StorageBindingChoice) => void,
		private readonly canAdoptReplacement = false,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h2", { text: t("storage.title") });
		this.contentEl.createEl("p", {
			text: t(
				this.canKeepHistory
					? "storage.confirm_previous"
					: "storage.confirm_new",
				{ path: this.path },
			),
		});
		if (this.canAdoptReplacement) {
			this.contentEl.createEl("p", {
				text: t("storage.replacement_description"),
			});
		}
		const buttons = new Setting(this.contentEl);
		buttons.settingEl.addClass("sync-modal-actions");
		if (this.canAdoptReplacement) {
			buttons.addButton((button) =>
				button
					.setButtonText(t("storage.replacement"))
					.onClick(() => this.finish("replacement")),
			);
		}
		if (this.canKeepHistory) {
			buttons.addButton((button) =>
				button
					.setButtonText(t("storage.same"))
					.setCta()
					.onClick(() => this.finish("same")),
			);
		}
		buttons.addButton((button) =>
			button
				.setButtonText(t("storage.new"))
				.onClick(() => this.finish("new")),
		);
		buttons.addButton((button) =>
			button
				.setButtonText(t("modal.cancel_button"))
				.onClick(() => this.finish("cancel")),
		);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.resolve("cancel");
		}
	}

	private finish(choice: StorageBindingChoice): void {
		if (!this.settled) {
			this.settled = true;
			this.resolve(choice);
			this.close();
		}
	}
}
