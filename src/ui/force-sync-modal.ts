import type { PreparedForceReplacement } from "../sync/workflows/force-replacement";
import type { OperationBackupChoice } from "../backup/operation-backup-choice";
import type { ForceFlowState } from "../sync/workflows/force-controller";
import type { FailureSummary } from "../errors";
import { App, Modal, Setting, type ButtonComponent } from "obsidian";
import { t } from "../i18n";
import { createSyncFailure, formatOperationFailure } from "../sync/errors";
import { formatForceResult } from "./force-sync-progress";

export type ForceSyncDirection = "from_local" | "from_remote";

/** Present one reserved Force invocation; passwords never enter published flow state. */
export class ForceSyncModal extends Modal {
	private closed = false;
	private confirmed = false;
	private state?: ForceFlowState;
	private bodyEl!: HTMLElement;
	private controlsEl!: HTMLElement;
	private actionsEl!: HTMLElement;
	private passwordResult?: (value: string | null) => void;
	private retryResult?: (value: boolean) => void;
	private choiceResult?: (value: OperationBackupChoice) => void;

	constructor(
		app: App,
		private readonly direction: ForceSyncDirection,
		private readonly remotePath: string,
		private readonly cancel: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("force-sync-modal");
		this.titleEl.setText(t("modal.force_sync_title"));
		this.contentEl.empty();
		this.contentEl.createEl("p", {
			cls: "force-sync-paths",
			text: t("force.paths", {
				source:
					this.direction === "from_local"
						? this.app.vault.getName()
						: this.remotePath,
				target:
					this.direction === "from_local"
						? this.remotePath
						: this.app.vault.getName(),
			}),
		});
		this.bodyEl = this.contentEl.createDiv({ cls: "force-sync-body" });
		const footer = this.contentEl.createDiv({ cls: "force-sync-footer" });
		this.controlsEl = footer.createDiv({ cls: "force-sync-options" });
		this.actionsEl = footer.createDiv();
		this.showChecking();
	}

	/** Keep active progress in the Notice and show the final result in this dialog. */
	render(state: ForceFlowState): void {
		if (this.closed) {
			return;
		}
		this.state = state;
		if (!state.active) {
			if (state.outcome === "cancelled") {
				this.close();
				return;
			}
			this.bodyEl.empty();
			this.controlsEl.empty();
			this.bodyEl.createDiv({
				text: formatForceResult(state),
				cls: "force-sync-stage",
				attr: { role: "status", "aria-live": "polite" },
			});
			this.renderActions();
			return;
		}
	}

	/** Ask for one password candidate; verification and retry belong to source preparation. */
	requestPassword(create: boolean, invalid = false): Promise<string | null> {
		if (this.closed) {
			return Promise.resolve(null);
		}
		this.bodyEl.empty();
		this.controlsEl.empty();
		this.bodyEl.createEl("p", {
			text: t(create ? "force.password_create" : "force.source_password"),
		});
		const input = this.bodyEl.createEl("input", {
			type: "password",
			cls: "encryption-password-input",
			attr: {
				"aria-label": t("modal.encryption_password_label"),
				autocomplete: create ? "new-password" : "current-password",
			},
		});
		const confirmation = create
			? this.bodyEl.createEl("input", {
					type: "password",
					cls: "encryption-password-input",
					attr: {
						"aria-label": t("modal.encryption_confirm_label"),
						autocomplete: "new-password",
					},
				})
			: null;
		const errorEl = this.bodyEl.createDiv({
			cls: "force-sync-warning",
			attr: { role: "alert" },
		});
		if (invalid) {
			errorEl.setText(t("notice.encryption_wrong_password"));
		}
		return new Promise((resolve) => {
			this.passwordResult = resolve;
			this.renderActions(t("force.check_password"), () => {
				if (
					!input.value ||
					(confirmation && input.value !== confirmation.value)
				) {
					errorEl.setText(t("modal.encryption_password_mismatch"));
					return;
				}
				const password = input.value;
				input.value = "";
				if (confirmation) {
					confirmation.value = "";
				}
				this.passwordResult = undefined;
				this.showChecking();
				resolve(password);
			});
			input.focus();
		});
	}

	/** Keep preparation failures in the same window, without allowing replacement. */
	retryPreparation(failure: FailureSummary): Promise<boolean> {
		if (this.closed) {
			return Promise.resolve(false);
		}
		this.bodyEl.empty();
		this.controlsEl.empty();
		this.bodyEl.createDiv({
			cls: "force-sync-warning",
			text: formatOperationFailure(failure),
			attr: { role: "alert" },
		});
		return new Promise((resolve) => {
			this.retryResult = resolve;
			this.renderActions(t("force.retry"), () => {
				this.retryResult = undefined;
				this.showChecking();
				resolve(true);
			});
		});
	}

	/** Archive verification completes before resolving the explicit destructive choice. */
	confirm(
		replacement?: PreparedForceReplacement,
		prepareArchive?: () => Promise<void>,
	): Promise<OperationBackupChoice> {
		if (this.closed) {
			return Promise.resolve("cancel");
		}
		this.bodyEl.empty();
		this.controlsEl.empty();
		const summary = this.bodyEl.createDiv({ cls: "force-sync-summary" });
		if (replacement) {
			const state = replacement.recovery;
			summary.createEl("p", {
				text: t(
					this.direction === "from_local"
						? "force.local_source_details"
						: "force.remote_source_details",
					{
						count: state.source.length,
						mode: t(
							state.target.enabled
								? "force.encrypted"
								: "force.plaintext",
						),
					},
				),
			});
		}
		summary.createEl("p", {
			cls: "force-sync-note",
			text: `${t("force.filters_applied")} ${t(
				this.direction === "from_local"
					? "force.preserved_remote"
					: "force.preserved_local",
			)}`,
		});
		const warning = this.bodyEl.createEl("p", {
			cls: "force-sync-consequences",
			text: t(
				this.direction === "from_local"
					? "modal.force_sync_from_local_text"
					: "modal.force_sync_from_remote_text",
			),
		});
		warning.createEl("strong", {
			text: ` ${t("modal.force_sync_warning")}`,
		});
		if (replacement?.recovery.source.length === 0) {
			this.bodyEl.createEl("p", {
				text: t("force.empty_source"),
				cls: "force-sync-warning",
			});
		}
		let withArchive = false;
		const archive = new Setting(this.controlsEl)
			.setName(
				t(
					this.direction === "from_remote"
						? "force.archive_local"
						: "force.archive_remote",
				),
			)
			.setDesc(
				t("force.archive_destination", {
					path: `${this.remotePath}/.backup`,
				}),
			)
			.addToggle((toggle) =>
				toggle.setValue(false).onChange((value) => {
					withArchive = value;
				}),
			);
		archive.settingEl.addClass("force-sync-modal-archive");
		const errorEl = this.bodyEl.createDiv({
			cls: "force-sync-warning",
			attr: { role: "alert" },
		});
		return new Promise((resolve) => {
			this.choiceResult = resolve;
			const buttons = this.renderActions(
				t(
					this.direction === "from_local"
						? "force.replace_remote"
						: "force.replace_local",
				),
				async () => {
					buttons?.setDisabled(true);
					archive.setDisabled(true);
					errorEl.empty();
					try {
						if (withArchive && prepareArchive) {
							await prepareArchive();
						}
						if (!this.closed) {
							this.confirmed = true;
							this.choiceResult = undefined;
							this.bodyEl.empty();
							this.controlsEl.empty();
							this.renderActions();
							resolve(
								withArchive ? "with-backup" : "without-backup",
							);
						}
					} catch (error) {
						if (!this.closed) {
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
							buttons?.setDisabled(false);
							archive.setDisabled(false);
							errorEl.scrollIntoView({ block: "nearest" });
						}
					}
				},
				true,
			);
		});
	}

	onClose(): void {
		this.closed = true;
		if (!this.confirmed && this.state?.active !== false) {
			this.cancel();
		}
		this.passwordResult?.(null);
		this.retryResult?.(false);
		this.choiceResult?.("cancel");
		this.passwordResult = undefined;
		this.retryResult = undefined;
		this.choiceResult = undefined;
		for (const input of Array.from(
			this.contentEl.querySelectorAll<HTMLInputElement>(
				'input[type="password"]',
			),
		)) {
			input.value = "";
		}
		this.contentEl.empty();
	}

	private showChecking(): void {
		this.bodyEl.empty();
		this.controlsEl.empty();
		const checking = this.bodyEl.createEl("p", {
			cls: "force-sync-checking",
			attr: { role: "status", "aria-live": "polite" },
		});
		checking.createEl("span", {
			cls: "force-sync-checking-spinner",
			attr: { "aria-hidden": "true" },
		});
		checking.createEl("span", { text: t("force.source_checking") });
		this.renderActions();
	}

	private renderActions(
		label?: string,
		action?: () => void | Promise<void>,
		destructive = false,
	): ButtonComponent | undefined {
		this.actionsEl.empty();
		const row = new Setting(this.actionsEl);
		row.settingEl.addClass("sync-modal-actions");

		let primary: ButtonComponent | undefined;
		if (label && action) {
			row.addButton((button) => {
				primary = button;
				button.setButtonText(label).onClick(action);
				if (destructive) {
					button.setDestructive();
				} else {
					button.setCta();
				}
			});
		}
		row.addButton((button) =>
			button
				.setButtonText(
					t(
						this.confirmed || this.state?.active === false
							? "modal.close_button"
							: "modal.cancel_button",
					),
				)
				.onClick(() => this.close()),
		);
		return primary;
	}
}
