import {
	App,
	ButtonComponent,
	Modal,
	Notice,
	Setting,
	TextAreaComponent,
} from "obsidian";
import { logger } from "../utils/logger";
import { t } from "../i18n";
import { createSyncFailure, formatOperationFailure } from "../sync/errors";
import { DecisionModal } from "./decision-modal";

let clearingLogs = false;

/** Share one explicit clear decision across settings and the viewer. */
export async function clearLogsWithConfirmation(
	app: App,
	isCurrent: () => boolean,
): Promise<boolean> {
	if (clearingLogs || !isCurrent()) {
		return false;
	}
	clearingLogs = true;
	try {
		const confirmed = await new Promise<boolean>((resolve) => {
			new DecisionModal(
				app,
				t("modal.clear_logs_title"),
				t("modal.clear_logs_description"),
				[
					{ label: t("modal.cancel_button"), value: "cancel" },
					{
						label: t("settings.clear_logs_button"),
						value: "clear",
						warning: true,
					},
				],
				"cancel",
				(choice) => resolve(choice === "clear"),
			).open();
		});
		if (!confirmed || !isCurrent()) {
			return false;
		}
		await logger.clearLogs();
		if (isCurrent()) {
			new Notice(t("notice.logs_cleared"));
		}
		return true;
	} catch (error) {
		if (isCurrent()) {
			new Notice(
				formatOperationFailure(
					createSyncFailure(error, {
						stage: "persisting",
						action: "local",
					}).summary,
				),
			);
		}
		return false;
	} finally {
		clearingLogs = false;
	}
}

/** Inspect logs independently of synchronization, with lifecycle-scoped async results. */
export class LogViewerModal extends Modal {
	private logContent = "";
	private textArea: TextAreaComponent | null = null;
	private closed = true;
	private generation = 0;
	private busy = false;
	private buttons: ButtonComponent[] = [];

	constructor(
		app: App,
		private readonly isAvailable: () => boolean = () => true,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.closed = false;
		this.generation++;
		this.busy = false;
		this.buttons = [];
		this.contentEl.empty();
		this.titleEl.setText(t("modal.log_viewer_title"));
		const field = new Setting(this.contentEl)
			.setName(t("modal.log_viewer_label"))
			.setDesc(t("modal.log_viewer_desc"))
			.addTextArea((textArea) => {
				this.textArea = textArea;
				textArea.inputEl.readOnly = true;
				textArea.inputEl.rows = 24;
				textArea.inputEl.addClass("log-viewer-textarea");
			});
		field.settingEl.addClass("log-viewer-field");
		const actions = new Setting(this.contentEl);
		for (const action of ["refresh", "copy", "clear"] as const) {
			actions.addButton((button) => {
				this.buttons.push(button);
				button.setButtonText(t(`modal.log_viewer_${action}`));
				if (action === "clear") {
					// eslint-disable-next-line @typescript-eslint/no-deprecated
					button.setWarning();
				}
				button.onClick(() => this.runAction(button, action));
			});
		}
		actions.settingEl.addClass("sync-modal-actions");
		await this.runAction(this.buttons[0]!, "refresh");
	}

	private isCurrent(generation: number): boolean {
		return (
			!this.closed && generation === this.generation && this.isAvailable()
		);
	}

	private async runAction(
		button: ButtonComponent,
		action: "refresh" | "copy" | "clear",
	): Promise<void> {
		if (this.busy || this.closed || !this.isAvailable()) {
			return;
		}
		const generation = this.generation;
		this.busy = true;
		for (const control of this.buttons) {
			control.setDisabled(true);
		}
		button.buttonEl.setAttribute("aria-busy", "true");
		button.buttonEl.addClass("sync-button-active");
		try {
			if (
				action === "clear" &&
				!(await clearLogsWithConfirmation(this.app, () =>
					this.isCurrent(generation),
				))
			) {
				return;
			}
			const content = await logger.getLogContents();
			if (!this.isCurrent(generation)) {
				return;
			}
			this.logContent = content;
			this.textArea?.setValue(content);
			if (action === "copy") {
				await navigator.clipboard.writeText(this.logContent);
			}
		} catch (error) {
			if (this.isCurrent(generation)) {
				new Notice(
					formatOperationFailure(
						createSyncFailure(error, {
							stage: "diagnostics",
							action: "local",
						}).summary,
					),
				);
			}
		} finally {
			if (this.isCurrent(generation)) {
				this.busy = false;
				for (const control of this.buttons) {
					control.setDisabled(false);
				}
				button.buttonEl.setAttribute("aria-busy", "false");
				button.buttonEl.removeClass("sync-button-active");
			}
		}
	}

	onClose(): void {
		this.closed = true;
		this.generation++;
		this.textArea = null;
		this.buttons = [];
		this.logContent = "";
		this.contentEl.empty();
	}
}
