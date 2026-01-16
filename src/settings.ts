/**
 * Yandex Disk Sync plugin settings
 */

import { App, PluginSettingTab, Setting, TextAreaComponent } from "obsidian";
import type YandexDiskSyncPlugin from "./main";
import { t } from "./i18n";

export class YandexDiskSyncSettingTab extends PluginSettingTab {
	plugin: YandexDiskSyncPlugin;

	constructor(app: App, plugin: YandexDiskSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}


	display(): void {
		const { containerEl } = this;
		containerEl.empty();

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
					.onClick(async () => {
						// Get current value from settings at click time
						const clientId = this.plugin.settings.clientId?.trim();
						if (clientId) {
							const authUrl = `https://oauth.yandex.ru/authorize?response_type=token&client_id=${encodeURIComponent(clientId)}`;
							window.open(authUrl, "_blank");
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
						// Fully redraw settings to update button state
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
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.debounceDelay = value;
						await this.plugin.saveSettings();
					})
			);

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

		// Test connection button
		new Setting(containerEl)
			.setName(t("settings.test_connection"))
			.setDesc(t("settings.test_connection_desc"))
			.addButton((button) =>
				button.setButtonText(t("settings.test_button")).onClick(async () => {
					button.setDisabled(true);
					button.setButtonText(t("settings.testing_button"));
					try {
						const result = await this.plugin.testConnection();
						if (result.success) {
							button.setButtonText(t("settings.success_button"));
						} else {
							button.setButtonText(t("settings.error_button"));
						}
					} catch {
						button.setButtonText(t("settings.error_button"));
					}
					setTimeout(() => {
						button.setDisabled(false);
						button.setButtonText(t("settings.test_button"));
					}, 2000);
				})
			);
	}
}
