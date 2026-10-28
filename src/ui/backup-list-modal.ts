/**
 * Modal for displaying and managing available backups
 */

import { App, Modal, Notice } from "obsidian";
import type { BackupInfo } from "../types";
import {
	BackupManager,
	BackupPasswordRequiredError,
} from "../backup/backup-manager";
import { getActiveLanguage, t } from "../i18n";
import { logger } from "../utils/logger";
import { ConnectEncryptedVaultModal } from "./encryption-modals";
import { UnsupportedHistoricalDataError } from "../compatibility-errors";

export class BackupListModal extends Modal {
	private backupManager: BackupManager;
	private closed = false;
	private renderGeneration = 0;
	private configurationGeneration: number;
	private backups: BackupInfo[] = [];
	private downloadButtons: HTMLButtonElement[] = [];
	private downloading = false;
	private unsubscribe: (() => void) | null = null;

	constructor(
		app: App,
		backupManager: BackupManager,
		private readonly activity?: {
			isUnavailable(): boolean;
			isCurrent(): boolean;
			subscribe(update: () => void): () => void;
		},
	) {
		super(app);
		this.backupManager = backupManager;
		this.configurationGeneration =
			backupManager.getConfigurationGeneration();
		this.setTitle(t("backup_list.title"));
	}

	async onOpen(): Promise<void> {
		this.closed = false;
		this.downloading = false;
		this.unsubscribe =
			this.activity?.subscribe(() => this.updateActivity()) ?? null;
		const { contentEl } = this;
		contentEl.empty();

		await this.renderContent();
	}

	private updateActivity(): void {
		for (const button of this.downloadButtons) {
			button.disabled =
				this.downloading || (this.activity?.isUnavailable() ?? false);
		}
	}

	private assertCurrentSelection(generation = this.renderGeneration): void {
		if (
			this.closed ||
			generation !== this.renderGeneration ||
			this.activity?.isCurrent() === false
		) {
			throw new Error("Backup list was closed");
		}
		this.backupManager.assertConfigurationGeneration(
			this.configurationGeneration,
		);
	}

	private async renderContent(): Promise<void> {
		const generation = ++this.renderGeneration;
		this.downloadButtons = [];
		const { contentEl } = this;
		contentEl.empty();

		const loadingEl = contentEl.createDiv({ cls: "backup-list-loading" });
		loadingEl.setText(t("backup_list.loading"));

		try {
			this.configurationGeneration =
				this.backupManager.getConfigurationGeneration();
			const backups = await this.backupManager.listBackups();
			if (this.closed || generation !== this.renderGeneration) {
				return;
			}
			this.assertCurrentSelection();
			this.backups = backups;
		} catch (error) {
			if (this.closed || generation !== this.renderGeneration) {
				return;
			}
			logger.error("Error loading backups:", { error });
			contentEl.empty();

			const errorEl = contentEl.createDiv({ cls: "backup-list-error" });
			errorEl.setText(t("notice.backup_list_load_failed"));

			const actions = contentEl.createDiv({ cls: "sync-modal-actions" });
			const retryButton = actions.createEl("button", {
				cls: "mod-cta",
				text: t("force.retry"),
			});
			this.downloadButtons.push(retryButton);
			this.updateActivity();
			retryButton.onclick = () => {
				if (
					retryButton.disabled ||
					this.closed ||
					this.activity?.isUnavailable()
				) {
					return;
				}
				retryButton.disabled = true;
				void this.renderContent();
			};

			return;
		}

		contentEl.empty();

		if (this.backups.length === 0) {
			const emptyEl = contentEl.createDiv({ cls: "backup-list-empty" });
			emptyEl.setText(t("backup_list.no_backups"));
			return;
		}

		// Create table
		const table = contentEl.createEl("table", { cls: "backup-list-table" });

		// Table header
		const thead = table.createEl("thead");
		const headerRow = thead.createEl("tr");
		headerRow.createEl("th", { text: t("backup_list.date") });
		headerRow.createEl("th", { text: t("backup_list.size") });
		headerRow.createEl("th", { text: t("backup_list.actions") });

		// Table body
		const tbody = table.createEl("tbody");
		for (const backup of this.backups) {
			const row = tbody.createEl("tr");

			// Date cell
			const dateCell = row.createEl("td");
			dateCell.setText(this.formatDate(backup.created));

			// Size cell
			const sizeCell = row.createEl("td");
			sizeCell.setText(this.formatSize(backup.size));

			// Actions cell
			const actionsCell = row.createEl("td");
			const downloadBtn = actionsCell.createEl("button", {
				cls: "mod-cta backup-download-btn",
				text: t("backup_list.download"),
			});
			this.downloadButtons.push(downloadBtn);

			downloadBtn.onclick = async () => {
				await this.handleDownload(backup, downloadBtn);
			};
		}
		this.updateActivity();
	}

	private async handleDownload(
		backup: BackupInfo,
		button: HTMLButtonElement,
	): Promise<void> {
		if (
			button.disabled ||
			this.downloading ||
			this.activity?.isUnavailable()
		) {
			return;
		}
		const generation = this.renderGeneration;
		try {
			this.assertCurrentSelection(generation);
			this.downloading = true;
			this.updateActivity();
			button.setAttribute("aria-busy", "true");
			button.addClass("sync-button-active");
			button.setText(t("settings.backup_in_progress"));

			new Notice(t("notice.backup_download_started"));

			let content: ArrayBuffer;
			try {
				content = await this.backupManager.downloadBackup(
					backup.remotePath,
				);
			} catch (error) {
				if (!(error instanceof BackupPasswordRequiredError)) {
					throw error;
				}
				this.assertCurrentSelection(generation);
				const password = await this.promptBackupPassword();
				if (
					!password ||
					this.closed ||
					this.activity?.isUnavailable()
				) {
					return;
				}
				this.assertCurrentSelection(generation);
				content = await this.backupManager.downloadBackup(
					backup.remotePath,
					password,
				);
			}

			this.assertCurrentSelection(generation);
			// Create blob and download
			const blob = new Blob([content], { type: "application/zip" });
			const url = URL.createObjectURL(blob);

			// Create download link
			const a = document.createElement("a");
			a.href = url;
			const downloadName = this.backupManager.getSuggestedDownloadName(
				backup.name,
			);
			a.download = downloadName;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);

			URL.revokeObjectURL(url);

			new Notice(
				t("notice.backup_download_completed", { name: downloadName }),
			);
		} catch (error) {
			if (this.closed || generation !== this.renderGeneration) {
				return;
			}
			logger.error("Error downloading backup:", { error });
			const message =
				error instanceof UnsupportedHistoricalDataError
					? t("notice.unsupported_historical_data")
					: t("notice.backup_download_failed");
			new Notice(message);
		} finally {
			if (!this.closed && generation === this.renderGeneration) {
				this.downloading = false;
				this.updateActivity();
				button.setAttribute("aria-busy", "false");
				button.removeClass("sync-button-active");
				button.setText(t("backup_list.download"));
			}
		}
	}

	private async promptBackupPassword(): Promise<string | null> {
		return await new Promise<string | null>((resolve) => {
			new ConnectEncryptedVaultModal(
				this.app,
				resolve,
				t("modal.backup_password_title"),
				t("modal.backup_password_desc"),
				t("modal.backup_password_button"),
			).open();
		});
	}

	private formatDate(date: Date): string {
		return date.toLocaleString(getActiveLanguage());
	}

	private formatSize(bytes: number): string {
		if (bytes === 0) {
			return `${(0).toLocaleString(getActiveLanguage())} ${t("units.byte")}`;
		}

		const k = 1024;
		const sizes = ["byte", "kilobyte", "megabyte", "gigabyte"];
		const i = Math.min(
			sizes.length - 1,
			Math.floor(Math.log(bytes) / Math.log(k)),
		);

		return (
			(bytes / Math.pow(k, i)).toLocaleString(getActiveLanguage(), {
				maximumFractionDigits: 2,
			}) +
			" " +
			t(`units.${sizes[i]}`)
		);
	}

	onClose(): void {
		this.closed = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.downloadButtons = [];
		this.renderGeneration++;
		const { contentEl } = this;
		contentEl.empty();
	}
}
