/**
 * Yandex Disk Sync plugin settings
 */

import { App, Notice, PluginSettingTab, Setting, TextAreaComponent, ToggleComponent } from "obsidian";
import type YandexDiskSyncPlugin from "./main";
import { t } from "./i18n";
import { BackupListModal } from "./ui/backup-list-modal";
import {
	ChangePasswordModal,
	ConnectEncryptedVaultModal,
	DisableEncryptionModal,
	EnableEncryptionModal,
	VerifyPasswordModal,
} from "./ui/encryption-modals";
import type { BackupInfo, RemoteEncryptionManifest } from "./types";

export class YandexDiskSyncSettingTab extends PluginSettingTab {
	plugin: YandexDiskSyncPlugin;

	constructor(app: App, plugin: YandexDiskSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private async getLastBackupText(): Promise<string> {
		try {
			const backupManager = this.plugin.getBackupManager();
			if (!backupManager) {
				return t("settings.backup_never");
			}
			const backups: BackupInfo[] = await backupManager.listBackups();
			if (backups.length > 0) {
				const backup = backups[0];
				if (backup) {
					return backup.created.toLocaleString();
				}
			}
		} catch {
			// If error loading backups, just show "Never"
		}
		return t("settings.backup_never");
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		void this.renderDisplay();
	}

	private async renderDisplay(): Promise<void> {
		const { containerEl } = this;

		// Connection section
		new Setting(containerEl).setName(t("settings.connection_section")).setHeading();

		// OAuth application management
		const oauthSetting = new Setting(containerEl)
			.setName(t("settings.oauth_apps"))
			.addButton((button) =>
				button
					.setButtonText(t("settings.manage_clients"))
					.setCta()
					.onClick(() => {
						window.open("https://oauth.yandex.ru/", "_blank");
					})
			)
			.addButton((button) =>
				button
					.setButtonText(t("settings.get_token"))
					.setDisabled(!this.plugin.settings.clientId?.trim())
					.onClick(() => {
						const clientId = this.plugin.settings.clientId?.trim();
						if (clientId) {
							const authUrl = `https://oauth.yandex.ru/authorize?response_type=token&client_id=${encodeURIComponent(clientId)}`;
							window.open(authUrl, "_blank");
						}
					})
			)
			.addButton((button) =>
			button.setButtonText(t("settings.sync_button")).onClick(async () => {
				button.setDisabled(true);
				button.setButtonText(t("settings.syncing_button"));
				try {
					const result = await this.plugin.testConnection();
					if (!result.success) {
						return;
					}
					await this.plugin.runFullSync();
				} catch {
					// errors are surfaced via Notice inside runFullSync
				} finally {
					button.setDisabled(false);
					button.setButtonText(t("settings.sync_button"));
				}
			})
			);

		// Create custom description with multiline text
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

		// Client ID
		new Setting(containerEl)
			.setName(t("settings.client_id"))
			.setDesc(t("settings.client_id_desc"))
			.addText((text) =>
				text
					.setPlaceholder(t("settings.client_id_placeholder"))
					.setValue(this.plugin.settings.clientId)
					.onChange(async (value) => {
						this.plugin.settings.clientId = value;
						await this.plugin.saveSettings();
						// eslint-disable-next-line @typescript-eslint/no-deprecated
						this.display();
					})
			);

		// OAuth token
		new Setting(containerEl)
			.setName(t("settings.oauth_token"))
			.setDesc(t("settings.oauth_token_desc"))
			.addText((text) =>
				text
					.setPlaceholder(t("settings.oauth_token_placeholder"))
					.setValue(this.plugin.settings.yandexTokenSecret)
					.onChange(async (value) => {
						this.plugin.settings.yandexTokenSecret = value;
						await this.plugin.saveSettings();
					})
			);

		// Remote path
		new Setting(containerEl)
			.setName(t("settings.remote_path"))
			.setDesc(t("settings.remote_path_desc"))
			.addText((text) =>
				text
					.setPlaceholder(t("settings.remote_path_placeholder"))
					.setValue(this.plugin.settings.remotePath)
					.onChange(async (value) => {
						this.plugin.settings.remotePath = value;
						await this.plugin.saveSettings();
					})
			);

		// Automatic sync section
		new Setting(containerEl).setName(t("settings.automatic_sync_section")).setHeading();

		// Enable real-time sync
		new Setting(containerEl)
			.setName(t("settings.realtime_sync"))
			.setDesc(t("settings.realtime_sync_desc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableRealtimeSync)
					.onChange(async (value) => {
						this.plugin.settings.enableRealtimeSync = value;
						await this.plugin.saveSettings();
					})
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
						this.plugin.settings.syncInterval = value;
						await this.plugin.saveSettings();
					})
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
						this.plugin.settings.debounceDelay = value;
						await this.plugin.saveSettings();
					})
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
						this.plugin.settings.maxConcurrency = value;
						await this.plugin.saveSettings();
					})
			);

		// Force Sync section
		new Setting(containerEl).setName(t("settings.force_sync_section")).setHeading();

		new Setting(containerEl)
			.setDesc(t("settings.force_sync_desc"))
			.addButton((button) =>
				button
					.setButtonText(t("settings.force_sync_from_local_button"))
					.setCta()
					.onClick(() => {
						void this.plugin.runForceSyncFromLocal();
					})
			)
			.addButton((button) =>
				button
					.setButtonText(t("settings.force_sync_from_remote_button"))
					.setCta()
					.onClick(() => {
						void this.plugin.runForceSyncFromRemote();
					})
			);

		// Encryption section
		new Setting(containerEl).setName(t("settings.encryption_section")).setHeading();

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

		let encryptionToggle: ToggleComponent | null = null;

		const showToggleSpinner = (tgl: ToggleComponent): HTMLElement => {
			tgl.setDisabled(true);
			tgl.toggleEl.addClass("encryption-toggle-hidden");
			return tgl.toggleEl.parentElement!.createSpan({ cls: "encryption-toggle-spinner" });
		};

		const hideToggleSpinner = (tgl: ToggleComponent, spinner: HTMLElement): void => {
			spinner.remove();
			tgl.toggleEl.removeClass("encryption-toggle-hidden");
			tgl.setDisabled(false);
		};

		new Setting(containerEl)
			.setName(t("settings.encryption_desc"))
			.addToggle((toggle) => {
				encryptionToggle = toggle;
				return toggle
					.setValue(this.plugin.settings.enableEncryption)
					.onChange(async (value) => {
						showToggleSpinner(toggle);

						if (value && !this.plugin.settings.enableEncryption) {
							let remoteManifest: RemoteEncryptionManifest | null = null;
							try {
								remoteManifest = await this.plugin.getRemoteEncryptionManifest();
							} catch (e) {
								new Notice(e instanceof Error ? e.message : String(e));
								// eslint-disable-next-line @typescript-eslint/no-deprecated
								this.display();
								return;
							}

							if (remoteManifest) {
								if (remoteManifest.state !== "enabled") {
									new Notice(t("notice.encryption_remote_busy"));
									// eslint-disable-next-line @typescript-eslint/no-deprecated
									this.display();
									return;
								}

								const password = await new Promise<string | null>((resolve) => {
									new ConnectEncryptedVaultModal(
										this.app,
										resolve,
										t("modal.encryption_connect_title"),
										t("modal.encryption_connect_desc"),
										t("modal.encryption_connect_button")
									).open();
								});
								if (!password) {
									// eslint-disable-next-line @typescript-eslint/no-deprecated
									this.display();
									return;
								}

								try {
									await this.plugin.connectToRemoteEncryption(password, remoteManifest);
									new Notice(t("notice.encryption_connected"));
								} catch (e) {
									new Notice(e instanceof Error ? e.message : String(e));
								}
								// eslint-disable-next-line @typescript-eslint/no-deprecated
								this.display();
								return;
							}

							const password = await new Promise<string | null>((resolve) => {
								new EnableEncryptionModal(
									this.app,
									resolve,
									() => this.plugin.createBackup()
								).open();
							});
							if (!password) {
								// eslint-disable-next-line @typescript-eslint/no-deprecated
								this.display();
								return;
							}
							const notice = new Notice(t("notice.encryption_syncing"), 0);
							try {
								await this.plugin.enableEncryption(password);
								notice.hide();
								new Notice(t("notice.encryption_enabled"));
							} catch (e) {
								notice.hide();
								new Notice(e instanceof Error ? e.message : String(e));
							}
							// eslint-disable-next-line @typescript-eslint/no-deprecated
							this.display();
						} else if (!value && this.plugin.settings.enableEncryption) {
							const currentPassword = await new Promise<string | null>((resolve) => {
								new VerifyPasswordModal(
									this.app,
									resolve,
									this.plugin.settings.encryptedPassword ?? ""
								).open();
							});
							if (!currentPassword) {
								// eslint-disable-next-line @typescript-eslint/no-deprecated
								this.display();
								return;
							}

							const confirmed = await new Promise<boolean>((resolve) => {
								new DisableEncryptionModal(this.app, resolve).open();
							});
							if (!confirmed) {
								// eslint-disable-next-line @typescript-eslint/no-deprecated
								this.display();
								return;
							}
							const notice = new Notice(t("notice.encryption_disabling"), 0);
							try {
								await this.plugin.disableEncryption({ reuploadPlaintext: true });
								notice.hide();
								new Notice(t("notice.encryption_disabled"));
							} catch (e) {
								notice.hide();
								new Notice(e instanceof Error ? e.message : String(e));
							}
							// eslint-disable-next-line @typescript-eslint/no-deprecated
							this.display();
						}
					})
			});

		if (this.plugin.settings.enableEncryption) {
			new Setting(containerEl)
				.setDesc(t("settings.encryption_status_active"))
				.addButton((button) =>
					button
						.setButtonText(t("settings.encryption_change_password"))
						.onClick(async () => {
							let spinnerEl: HTMLElement | null = null;
							if (encryptionToggle) {
								spinnerEl = showToggleSpinner(encryptionToggle);
							}

							const currentPassword = await new Promise<string | null>((resolve) => {
								new VerifyPasswordModal(
									this.app,
									resolve,
									this.plugin.settings.encryptedPassword ?? ""
								).open();
							});
							if (!currentPassword) {
								if (spinnerEl && encryptionToggle) {
									hideToggleSpinner(encryptionToggle, spinnerEl);
								}
								return;
							}

							const newPassword = await new Promise<string | null>((resolve) => {
								new ChangePasswordModal(this.app, resolve).open();
							});
							if (!newPassword) {
								if (spinnerEl && encryptionToggle) {
									hideToggleSpinner(encryptionToggle, spinnerEl);
								}
								return;
							}
							const notice = new Notice(t("notice.encryption_password_rotating"), 0);
							try {
								await this.plugin.rotateEncryptionPassword(newPassword);
								notice.hide();
								new Notice(t("notice.encryption_password_changed"));
							} catch (e) {
								notice.hide();
								new Notice(e instanceof Error ? e.message : String(e));
							}
							// eslint-disable-next-line @typescript-eslint/no-deprecated
							this.display();
						})
			);
		}

		// File filters section
		new Setting(containerEl).setName(t("settings.file_filters_section")).setHeading();

		// Sync config folder
		new Setting(containerEl)
			.setName(t("settings.sync_config_folder"))
			.setDesc(t("settings.sync_config_folder_desc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncDotObsidian)
					.onChange(async (value) => {
						this.plugin.settings.syncDotObsidian = value;
						await this.plugin.saveSettings();
					})
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
						this.plugin.settings.syncPatterns = value
							.split("\n")
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
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
						this.plugin.settings.excludePatterns = value
							.split("\n")
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 4;
				textArea.inputEl.cols = 30;
			});

		// Information section
		new Setting(containerEl).setName(t("settings.information_section")).setHeading();

		// Device ID
		new Setting(containerEl)
			.setName(t("settings.device_id"))
			.setDesc(t("settings.device_id_desc"))
			.addText((text) =>
				text.setValue(this.plugin.settings.deviceId).setDisabled(true)
			);

		// Backup section
		new Setting(containerEl)
			.setName(t("settings.backup_section"))
			.setDesc(t("settings.backup_desc"))
			.setHeading();

		// Combined backup status and button
		const lastBackupText = await this.getLastBackupText();

		new Setting(containerEl)
			.setName(lastBackupText)
			.addButton((button) =>
				button.setButtonText(t("settings.backup_button")).onClick(async () => {
					button.setDisabled(true);
					button.setButtonText(t("settings.backup_in_progress"));

					try {
						const result = await this.plugin.createBackup();

						if (result.success) {
							button.setButtonText(t("settings.backup_success"));
							// eslint-disable-next-line @typescript-eslint/no-deprecated
							this.display();
						} else {
							button.setButtonText(t("settings.backup_error"));
						}
					} catch (error) {
						button.setButtonText(t("settings.backup_error"));
						console.error("Backup failed:", error);
					}

					setTimeout(() => {
						button.setDisabled(false);
						button.setButtonText(t("settings.backup_button"));
					}, 3000);
				})
			)
			.addButton((button) =>
				button.setButtonText(t("settings.backup_show_all")).onClick(() => {
					new BackupListModal(this.app, this.plugin.getBackupManager()).open();
				})
			);

	}
}
