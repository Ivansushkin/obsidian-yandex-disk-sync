import type { PreparedForceReplacement } from "../sync/workflows/force-replacement";
import type { OperationBackupChoice } from "../backup/operation-backup-choice";
import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";
import { createSyncFailure, formatOperationFailure } from "../sync/errors";

export type ForceSyncDirection = "from_local" | "from_remote";

/** One destructive confirmation; an optional archive failure remains in this dialog. */
export class ForceSyncModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly direction: ForceSyncDirection,
		private readonly onAction: (action: OperationBackupChoice) => void,
		_requireLegacyClientsStopped = false,
		private readonly replacement?: PreparedForceReplacement,
		private readonly prepareArchive?: () => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: t("modal.force_sync_title") });
		contentEl.createEl("p", {
			text: t(
				this.direction === "from_local"
					? "modal.force_sync_from_local_text"
					: "modal.force_sync_from_remote_text",
			),
		});
		if (this.replacement) {
			const state = this.replacement.recovery;
			contentEl.createEl("p", {
				text: t("force.confirm_details", {
					source:
						this.direction === "from_local"
							? this.app.vault.getName()
							: state.remotePath,
					target:
						this.direction === "from_local"
							? state.remotePath
							: this.app.vault.getName(),
					count: state.source.length,
					mode: t(
						state.target.enabled
							? "force.encrypted"
							: "force.plaintext",
					),
				}),
			});
			if (state.source.length === 0) {
				contentEl.createEl("p", {
					text: t("force.empty_source"),
					cls: "force-sync-warning",
				});
			}
		}
		contentEl.createEl("p", {
			text: t(
				this.direction === "from_local"
					? "force.preserved_remote"
					: "force.preserved_local",
			),
		});
		contentEl.createEl("p", { text: t("force.filters_ignored") });
		contentEl.createEl("p", {
			text: t("modal.force_sync_warning"),
			cls: "force-sync-warning",
		});
		let withArchive = false;
		const archive = new Setting(contentEl)
			.setName(t("force.optional_archive"))
			.addToggle((toggle) =>
				toggle.setValue(false).onChange((value) => {
					withArchive = value;
				}),
			);
		const errorEl = contentEl.createDiv({ cls: "force-sync-warning" });
		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText(
						t(
							this.direction === "from_local"
								? "force.replace_remote"
								: "force.replace_local",
						),
					)
					.setDestructive()
					.onClick(async () => {
						button.setDisabled(true);
						archive.setDisabled(true);
						errorEl.empty();
						try {
							if (withArchive && this.prepareArchive) {
								await this.prepareArchive();
							}
							if (!this.settled) {
								this.finish(
									withArchive
										? "with-backup"
										: "without-backup",
								);
							}
						} catch (error) {
							if (!this.settled) {
								errorEl.setText(
									formatOperationFailure(
										createSyncFailure(error, {
											stage: "creating-backup",
											action: "write",
											outcome: "stopped-before-write",
										}).summary,
										t("force.archive_retry_inline"),
									),
								);
								button.setDisabled(false);
								archive.setDisabled(false);
							}
						}
					}),
			)
			.addButton((button) =>
				button
					.setButtonText(t("modal.cancel_button"))
					.onClick(() => this.finish("cancel")),
			);
	}

	onClose(): void {
		this.contentEl.empty();
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
