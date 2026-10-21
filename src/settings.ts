import type { UserSettingsPatch } from "./settings-workflow";
/**
 * Yandex Disk Sync plugin settings
 */

import {
	App,
	ButtonComponent,
	Notice,
	PluginSettingTab,
	Setting,
	TextAreaComponent,
	TextComponent,
	ToggleComponent,
} from "obsidian";
import type YandexDiskSyncPlugin from "./main";
import { t } from "./i18n/index";
import { logger } from "./utils/logger";
import { BackupListModal } from "./ui/backup-list-modal";
import { LogViewerModal } from "./ui/log-viewer-modal";
import {
	ChangePasswordModal,
	ConnectEncryptedVaultModal,
	DisableEncryptionModal,
	EnableEncryptionModal,
	VerifyPasswordModal,
} from "./ui/encryption-modals";
import type { BackupInfo, RemoteEncryptionManifest } from "./types";
import { YandexApiError } from "./api/yandex-client";
import { UnsupportedHistoricalDataError } from "./compatibility-errors";
import type { ForceDirection } from "./sync/workflows/force-controller";

export class YandexDiskSyncSettingTab extends PluginSettingTab {
	plugin: YandexDiskSyncPlugin;
	private backupStatusPromise: Promise<string> | null = null;
	private activityUnsubscribers: (() => void)[] = [];
	private syncButton: ButtonComponent | null = null;
	private forceButtons: {
		button: ButtonComponent;
		direction: ForceDirection;
	}[] = [];
	private controlsEl: HTMLFieldSetElement | null = null;
	private renderGeneration = 0;
	private displayed = false;

	constructor(app: App, plugin: YandexDiskSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private async getLastBackupText(): Promise<string> {
		if (!this.plugin.settings.yandexTokenSecret.trim()) {
			return t("settings.backup_unavailable");
		}
		if (this.backupStatusPromise) {
			return await this.backupStatusPromise;
		}
		this.backupStatusPromise = this.loadLastBackupText().finally(() => {
			this.backupStatusPromise = null;
		});
		return await this.backupStatusPromise;
	}

	private async loadLastBackupText(): Promise<string> {
		try {
			const backups: BackupInfo[] = await this.plugin
				.getBackupManager()
				.listBackups();
			return (
				backups[0]?.created.toLocaleString() ??
				t("settings.backup_never")
			);
		} catch (error) {
			if (
				!(error instanceof YandexApiError) ||
				(error.status !== 401 && error.status !== 403)
			) {
				logger.debug("Passive backup status is unavailable", { error });
			}
			return t("settings.backup_unavailable");
		}
	}

	hide(): void {
		this.displayed = false;
		this.detachActivity();
		this.renderGeneration++;
		this.plugin.encryptionStateChangeCallback = null;
		super.hide();
	}

	private detachActivity(): void {
		for (const unsubscribe of this.activityUnsubscribers) {
			unsubscribe();
		}
		this.activityUnsubscribers = [];
	}

	/** Update existing controls without rebuilding focused settings on every progress event. */
	private updateActivity(): void {
		const busy = this.plugin.isConfigurationBusy();
		if (this.controlsEl) {
			this.controlsEl.disabled = busy;
			this.controlsEl.setAttribute("aria-busy", String(busy));
		}
		if (this.syncButton) {
			const active = this.plugin.isFullSyncInProgress();
			this.syncButton.setDisabled(busy);
			this.syncButton.setButtonText(
				t(active ? "settings.syncing_button" : "settings.sync_button"),
			);
			this.syncButton.buttonEl.setAttribute("aria-busy", String(active));
			this.syncButton.buttonEl.toggleClass("sync-button-active", active);
		}
		const state = this.plugin.getForceSyncController().getState();
		const forceUnavailable = this.plugin.isForceSyncUnavailable();
		for (const { button, direction } of this.forceButtons) {
			const active =
				state?.active === true && state.direction === direction;
			button.setDisabled(forceUnavailable);
			button.buttonEl.setAttribute("aria-busy", String(active));
			button.buttonEl.toggleClass("force-sync-button-active", active);
		}
	}

	private async applyDraft(patch: UserSettingsPatch): Promise<void> {
		try {
			await this.plugin.applySettingsPatch(patch);
		} catch (error) {
			new Notice(error instanceof Error ? error.message : String(error));
			this.renderSettings();
		}
	}

	private showToggleSpinner(tgl: ToggleComponent): HTMLElement {
		tgl.setDisabled(true);
		tgl.toggleEl.addClass("encryption-toggle-hidden");
		return tgl.toggleEl.parentElement!.createSpan({
			cls: "encryption-toggle-spinner",
		});
	}

	private hideToggleSpinner(
		tgl: ToggleComponent,
		spinner: HTMLElement,
	): void {
		spinner.remove();
		tgl.toggleEl.removeClass("encryption-toggle-hidden");
		tgl.setDisabled(false);
	}

	private async enableEncryptionFlow(): Promise<void> {
		let remoteManifest: RemoteEncryptionManifest | null = null;
		try {
			remoteManifest = await this.plugin.getRemoteEncryptionManifest();
		} catch (e) {
			new Notice(
				e instanceof UnsupportedHistoricalDataError
					? t("notice.unsupported_historical_data")
					: e instanceof Error
						? e.message
						: String(e),
			);
			return;
		}

		if (remoteManifest) {
			const password = await this.promptConnectEncryptionPassword();
			if (!password) {
				return;
			}

			try {
				await this.plugin.connectToRemoteEncryption(
					password,
					remoteManifest,
				);
				new Notice(t("notice.encryption_connected"));
			} catch (e) {
				new Notice(e instanceof Error ? e.message : String(e));
			}
			return;
		}

		const password = await this.promptNewEncryptionPassword();
		if (!password) {
			return;
		}

		try {
			await this.plugin.enableEncryption(password);
		} catch {
			// The plugin owns the single progress and result Notice.
		}
	}

	private async disableEncryptionFlow(): Promise<void> {
		const currentPassword = await this.promptCurrentEncryptionPassword();
		if (!currentPassword) {
			return;
		}

		const confirmed = await new Promise<boolean>((resolve) => {
			new DisableEncryptionModal(this.app, resolve).open();
		});
		if (!confirmed) {
			return;
		}

		try {
			await this.plugin.disableEncryption({ reuploadPlaintext: true });
		} catch {
			// The plugin owns the single progress and result Notice.
		}
	}

	private async promptNewEncryptionPassword(): Promise<string | null> {
		return await new Promise<string | null>((resolve) => {
			new EnableEncryptionModal(this.app, resolve).open();
		});
	}

	private async promptConnectEncryptionPassword(): Promise<string | null> {
		return await new Promise<string | null>((resolve) => {
			new ConnectEncryptedVaultModal(
				this.app,
				resolve,
				t("modal.encryption_connect_title"),
				t("modal.encryption_connect_desc"),
				t("modal.encryption_connect_button"),
			).open();
		});
	}

	private async promptCurrentEncryptionPassword(): Promise<string | null> {
		return await new Promise<string | null>((resolve) => {
			new VerifyPasswordModal(this.app, resolve, async (pw) =>
				this.plugin.verifyEncryptionPassword(pw),
			).open();
		});
	}

	display(): void {
		this.displayed = true;
		this.renderSettings();
	}

	private renderSettings(): void {
		if (!this.displayed) {
			return;
		}
		this.detachActivity();
		this.renderGeneration++;
		this.syncButton = null;
		this.forceButtons = [];
		this.plugin.encryptionStateChangeCallback = () => {
			this.renderSettings();
		};
		const { containerEl } = this;
		containerEl.empty();
		this.controlsEl = containerEl.createEl("fieldset", {
			cls: "force-settings-controls",
		});
		// Obsidian toggles are custom elements; native fieldset disabling alone is insufficient.
		for (const event of ["click", "keydown", "input", "change"]) {
			this.controlsEl.addEventListener(
				event,
				(e) => {
					if (!this.plugin.isForceSyncBusy()) {
						return;
					}
					if (e instanceof KeyboardEvent && e.key === "Tab") {
						return;
					}
					e.preventDefault();
					e.stopImmediatePropagation();
				},
				true,
			);
		}
		this.activityUnsubscribers = [
			this.plugin
				.getForceSyncController()
				.subscribe(() => this.updateActivity()),
			this.plugin.onSyncActivityChange(() => this.updateActivity()),
		];
		this.updateActivity();
		void this.renderDisplay(this.controlsEl, this.renderGeneration);
	}

	private async renderDisplay(
		containerEl: HTMLElement,
		generation: number,
	): Promise<void> {
		const migrationPending = this.plugin.isStableMigrationPending();

		// Connection section
		new Setting(containerEl)
			.setName(t("settings.connection_section"))
			.setHeading();

		const connectionBlock = containerEl.createDiv({
			cls: "connection-block",
		});

		const oauthSetting = new Setting(connectionBlock);

		const descEl = oauthSetting.descEl;
		descEl.empty();
		const instructionDiv = descEl.createDiv({ cls: "oauth-instruction" });
		instructionDiv.createDiv({ text: t("settings.oauth_instruction_1") });
		instructionDiv.createDiv({ text: t("settings.oauth_instruction_2") });
		instructionDiv.createDiv({ text: t("settings.oauth_instruction_3") });
		instructionDiv.createDiv({ text: t("settings.oauth_instruction_4") });
		instructionDiv.createDiv({ text: t("settings.oauth_instruction_5") });
		instructionDiv.createDiv({ text: t("settings.oauth_instruction_6") });
		instructionDiv.createDiv({ text: t("settings.oauth_instruction_7") });

		const controlEl = oauthSetting.controlEl;

		new ButtonComponent(controlEl)
			.setButtonText(t("settings.manage_clients"))
			.setCta()
			.onClick(() => {
				window.open("https://oauth.yandex.ru/", "_blank");
			});

		controlEl.createEl("label", { text: t("settings.client_id") });
		new TextComponent(controlEl)
			.setPlaceholder(t("settings.client_id_placeholder"))
			.setValue(this.plugin.settings.clientId)
			.onChange(async (value) => {
				if (this.plugin.isForceSyncBusy()) {
					return;
				}
				await this.applyDraft({ clientId: value });
				this.renderSettings();
			});

		new ButtonComponent(controlEl)
			.setButtonText(t("settings.get_token"))
			.setDisabled(!this.plugin.settings.clientId?.trim())
			.onClick(() => {
				const clientId = this.plugin.settings.clientId?.trim();
				if (clientId) {
					const authUrl = `https://oauth.yandex.ru/authorize?response_type=token&client_id=${encodeURIComponent(clientId)}`;
					window.open(authUrl, "_blank");
				}
			});

		controlEl.createEl("label", { text: t("settings.oauth_token") });
		new TextComponent(controlEl)
			.setPlaceholder(t("settings.oauth_token_placeholder"))
			.setValue(this.plugin.settings.yandexTokenSecret)
			.onChange(async (value) => {
				if (this.plugin.isForceSyncBusy()) {
					return;
				}
				await this.applyDraft({ yandexTokenSecret: value });
			});

		this.syncButton = new ButtonComponent(controlEl)
			.setButtonText(t("settings.sync_button"))
			.setCta();
		this.syncButton.onClick(async () => {
			if (this.plugin.isConfigurationBusy()) {
				return;
			}
			try {
				await this.plugin.runFullSync();
			} catch {
				// errors are surfaced via Notice inside runFullSync
			}
		});
		this.updateActivity();

		// Remote path
		new Setting(containerEl)
			.setName(t("settings.remote_path"))
			.setDesc(t("settings.remote_path_desc"))
			.addText((text) =>
				text
					.setPlaceholder(t("settings.remote_path_placeholder"))
					.setValue(this.plugin.settings.remotePath)
					.onChange(async (value) => {
						if (this.plugin.isForceSyncBusy()) {
							return;
						}
						await this.applyDraft({ remotePath: value });
					}),
			);

		// Automatic sync section
		new Setting(containerEl)
			.setName(t("settings.automatic_sync_section"))
			.setHeading();

		// Enable real-time sync
		new Setting(containerEl)
			.setName(t("settings.realtime_sync"))
			.setDesc(t("settings.realtime_sync_desc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableRealtimeSync)
					.onChange(async (value) => {
						if (this.plugin.isForceSyncBusy()) {
							return;
						}
						await this.applyDraft({ enableRealtimeSync: value });
					}),
			);

		// Sync interval
		new Setting(containerEl)
			.setName(t("settings.full_sync_interval"))
			.setDesc(t("settings.full_sync_interval_desc"))
			.addSlider((slider) =>
				slider
					.setLimits(0, 60, 1)
					.setValue(this.plugin.settings.syncInterval)
					// eslint-disable-next-line @typescript-eslint/no-deprecated
					.setDynamicTooltip()
					.onChange(async (value) => {
						if (this.plugin.isForceSyncBusy()) {
							return;
						}
						await this.applyDraft({ syncInterval: value });
					}),
			);

		// Debounce delay
		new Setting(containerEl)
			.setName(t("settings.sync_delay"))
			.setDesc(t("settings.sync_delay_desc"))
			.addSlider((slider) =>
				slider
					.setLimits(500, 10000, 500)
					.setValue(this.plugin.settings.debounceDelay)
					// eslint-disable-next-line @typescript-eslint/no-deprecated
					.setDynamicTooltip()
					.onChange(async (value) => {
						if (this.plugin.isForceSyncBusy()) {
							return;
						}
						await this.applyDraft({ debounceDelay: value });
					}),
			);

		// Max concurrency
		new Setting(containerEl)
			.setName(t("settings.max_concurrency"))
			.setDesc(t("settings.max_concurrency_desc"))
			.addSlider((slider) =>
				slider
					.setLimits(1, 20, 1)
					.setValue(this.plugin.settings.maxConcurrency)
					// eslint-disable-next-line @typescript-eslint/no-deprecated
					.setDynamicTooltip()
					.onChange(async (value) => {
						if (this.plugin.isForceSyncBusy()) {
							return;
						}
						await this.applyDraft({ maxConcurrency: value });
					}),
			);

		// Force Sync section
		new Setting(containerEl)
			.setName(t("settings.force_sync_section"))
			.setHeading();

		new Setting(containerEl)
			.setDesc(t("settings.force_sync_desc"))
			.addButton((button) => {
				this.forceButtons.push({ button, direction: "from_local" });
				return button
					.setButtonText(t("settings.force_sync_from_local_button"))
					.setCta()
					.onClick(() => {
						void this.plugin.runForceSyncFromLocal();
					});
			})
			.addButton((button) => {
				this.forceButtons.push({ button, direction: "from_remote" });
				return button
					.setButtonText(t("settings.force_sync_from_remote_button"))
					.setCta()
					.onClick(() => {
						void this.plugin.runForceSyncFromRemote();
					});
			});
		this.updateActivity();

		// Encryption section
		new Setting(containerEl)
			.setName(t("settings.encryption_section"))
			.setHeading();

		const infoSetting = new Setting(containerEl)
			.setName(t("settings.encryption_info_title"))
			.setDesc(t("settings.encryption_info_how"));

		infoSetting.descEl.createEl("p", {
			text: t("settings.encryption_info_warning"),
			cls: "encryption-info-warning",
		});

		infoSetting.descEl.createEl("p", {
			text: t("settings.encryption_info_password"),
		});
		if (migrationPending) {
			infoSetting.descEl.createEl("p", {
				text: t("settings.migration_features_locked"),
				cls: "encryption-info-warning",
			});
		}

		let encryptionToggle: ToggleComponent | null = null;

		new Setting(containerEl)
			.setName(t("settings.encryption_desc"))
			.addToggle((toggle) => {
				encryptionToggle = toggle;
				return toggle
					.setValue(this.plugin.settings.enableEncryption)
					.setDisabled(migrationPending)
					.onChange(async (value) => {
						if (this.plugin.isForceSyncBusy()) {
							return;
						}
						const spinner = this.showToggleSpinner(toggle);
						try {
							if (
								value &&
								!this.plugin.settings.enableEncryption
							) {
								await this.enableEncryptionFlow();
							} else if (
								!value &&
								this.plugin.settings.enableEncryption
							) {
								await this.disableEncryptionFlow();
							}
						} finally {
							this.hideToggleSpinner(toggle, spinner);
							this.renderSettings();
						}
					});
			});

		if (this.plugin.settings.enableEncryption) {
			new Setting(containerEl)
				.setDesc(t("settings.encryption_status_active"))
				.addButton((button) =>
					button
						.setButtonText(t("settings.encryption_change_password"))
						.onClick(async () => {
							if (this.plugin.isForceSyncBusy()) {
								return;
							}
							const spinner = encryptionToggle
								? this.showToggleSpinner(encryptionToggle)
								: null;
							try {
								const currentPassword =
									await this.promptCurrentEncryptionPassword();
								if (!currentPassword) {
									return;
								}

								const newPassword = await new Promise<
									string | null
								>((resolve) =>
									new ChangePasswordModal(
										this.app,
										resolve,
									).open(),
								);
								if (!newPassword) {
									return;
								}

								try {
									await this.plugin.rotateEncryptionPassword(
										newPassword,
									);
								} catch {
									// The plugin owns the single progress and result Notice.
								}
							} finally {
								if (spinner && encryptionToggle) {
									this.hideToggleSpinner(
										encryptionToggle,
										spinner,
									);
								}
								this.renderSettings();
							}
						}),
				);
		}

		// File filters section
		new Setting(containerEl)
			.setName(t("settings.file_filters_section"))
			.setHeading();

		// Sync config folder
		new Setting(containerEl)
			.setName(t("settings.sync_config_folder"))
			.setDesc(t("settings.sync_config_folder_desc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncDotObsidian)
					.onChange(async (value) => {
						if (this.plugin.isForceSyncBusy()) {
							return;
						}
						await this.applyDraft({ syncDotObsidian: value });
					}),
			);

		// Include patterns
		new Setting(containerEl)
			.setName(t("settings.include_patterns"))
			.setDesc(t("settings.include_patterns_desc"))
			.addTextArea((textArea: TextAreaComponent) => {
				textArea
					.setPlaceholder(t("settings.include_patterns_placeholder"))
					.setValue(this.plugin.settings.syncPatterns.join("\n"))
					.onChange(async (value) => {
						if (this.plugin.isForceSyncBusy()) {
							return;
						}
						await this.applyDraft({
							syncPatterns: value
								.split("\n")
								.map((s) => s.trim())
								.filter((s) => s.length > 0),
						});
					});
				textArea.inputEl.rows = 4;
				textArea.inputEl.cols = 30;
			});

		// Exclude patterns
		new Setting(containerEl)
			.setName(t("settings.exclude_patterns"))
			.setDesc(t("settings.exclude_patterns_desc"))
			.addTextArea((textArea: TextAreaComponent) => {
				textArea
					.setPlaceholder(t("settings.exclude_patterns_placeholder"))
					.setValue(this.plugin.settings.excludePatterns.join("\n"))
					.onChange(async (value) => {
						if (this.plugin.isForceSyncBusy()) {
							return;
						}
						await this.applyDraft({
							excludePatterns: value
								.split("\n")
								.map((s) => s.trim())
								.filter((s) => s.length > 0),
						});
					});
				textArea.inputEl.rows = 4;
				textArea.inputEl.cols = 30;
			});

		// Logging section
		new Setting(containerEl)
			.setName(t("settings.logging_section"))
			.setHeading();

		// Enable debug logging
		new Setting(containerEl)
			.setName(t("settings.enable_debug_logging"))
			.setDesc(t("settings.enable_debug_logging_desc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableDebugLogging)
					.setDisabled(migrationPending)
					.onChange(async (value) => {
						if (this.plugin.isForceSyncBusy()) {
							return;
						}
						await this.applyDraft({ enableDebugLogging: value });
					}),
			);

		// Write logs to file
		new Setting(containerEl)
			.setName(t("settings.log_to_file"))
			.setDesc(t("settings.log_to_file_desc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.logToFile)
					.setDisabled(migrationPending)
					.onChange(async (value) => {
						if (this.plugin.isForceSyncBusy()) {
							return;
						}
						await this.applyDraft({ logToFile: value });
					}),
			);

		// View logs button
		new Setting(containerEl)
			.addButton((button) =>
				button
					.setButtonText(t("settings.view_logs_button"))
					.setCta()
					.onClick(() => {
						new LogViewerModal(this.app).open();
					}),
			)
			.addButton((button) =>
				button
					.setButtonText(t("settings.clear_logs_button"))
					// eslint-disable-next-line @typescript-eslint/no-deprecated
					.setWarning()
					.onClick(async () => {
						if (this.plugin.isForceSyncBusy()) {
							return;
						}
						await logger.clearLogs();
						new Notice(t("notice.logs_cleared"));
					}),
			);

		// Information section
		new Setting(containerEl)
			.setName(t("settings.information_section"))
			.setHeading();

		// Device ID
		new Setting(containerEl)
			.setName(t("settings.device_id"))
			.setDesc(t("settings.device_id_desc"))
			.addText((text) =>
				text.setValue(this.plugin.settings.deviceId).setDisabled(true),
			);

		// Backup section
		new Setting(containerEl)
			.setName(t("settings.backup_section"))
			.setDesc(t("settings.backup_desc"))
			.setHeading();

		// Combined backup status and button
		const lastBackupText = await this.getLastBackupText();
		if (generation !== this.renderGeneration) {
			return;
		}

		new Setting(containerEl)
			.setName(lastBackupText)
			.addButton((button) =>
				button
					.setButtonText(t("settings.backup_button"))
					.onClick(async () => {
						if (this.plugin.isForceSyncBusy()) {
							return;
						}
						button.setDisabled(true);
						button.setButtonText(t("settings.backup_in_progress"));

						try {
							const result = await this.plugin.createBackup();

							if (result.success) {
								button.setButtonText(
									t("settings.backup_success"),
								);
								this.renderSettings();
							} else {
								button.setButtonText(
									t("settings.backup_error"),
								);
							}
						} catch (error) {
							button.setButtonText(t("settings.backup_error"));
							logger.error("Backup failed:", { error });
						}

						setTimeout(() => {
							button.setDisabled(false);
							button.setButtonText(t("settings.backup_button"));
						}, 3000);
					}),
			)
			.addButton((button) =>
				button
					.setButtonText(t("settings.backup_show_all"))
					.onClick(() => {
						new BackupListModal(
							this.app,
							this.plugin.getBackupManager(),
						).open();
					}),
			);

		this.updateActivity();
	}
}
