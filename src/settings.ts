import type { UserSettingsPatch } from "./settings-workflow";
/**
 * Yandex Disk Sync plugin settings
 */

import {
	App,
	type BaseComponent,
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
import { createSyncFailure, formatOperationFailure } from "./sync/errors";
import { BackupListModal } from "./ui/backup-list-modal";
import {
	LogViewerModal,
	clearLogsWithConfirmation,
} from "./ui/log-viewer-modal";
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
import { DecisionModal } from "./ui/decision-modal";
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
	private controlsEl: HTMLElement | null = null;
	private controls: {
		component: BaseComponent;
		diagnostic: boolean;
		disabled: boolean;
	}[] = [];
	private backupButton: ButtonComponent | null = null;
	private encryptionButton: ButtonComponent | null = null;
	private clearLogsButton: ButtonComponent | null = null;
	private clearingLogs = false;
	private encryptionToggle: ToggleComponent | null = null;
	private encryptionSpinner: HTMLElement | null = null;
	private pendingAction = false;
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

	/** Retain each control's own admission restrictions while applying activity locks. */
	private trackControl(component: BaseComponent, diagnostic = false): void {
		this.controls.push({
			component,
			diagnostic,
			disabled: component.disabled,
		});
		this.updateActivity();
	}

	private isActionUnavailable(): boolean {
		return (
			this.pendingAction ||
			this.plugin.isConfigurationBusy() ||
			this.plugin.isPluginUnloaded()
		);
	}

	/** Use the same accessible running state for every operation button. */
	private setButtonActivity(
		button: ButtonComponent | null,
		active: boolean,
		label: string,
	): void {
		if (!button) {
			return;
		}
		button.setButtonText(label);
		button.buttonEl.setAttribute("aria-busy", String(active));
		button.buttonEl.toggleClass("sync-button-active", active);
	}

	/** Update controls in place so progress never replaces focused settings. */
	private updateActivity(): void {
		const busy = this.isActionUnavailable();
		this.controlsEl?.setAttribute("aria-busy", String(busy));
		for (const { component, diagnostic, disabled } of this.controls) {
			component.setDisabled(
				disabled ||
					this.plugin.isPluginUnloaded() ||
					(!diagnostic && busy),
			);
		}
		const state = this.plugin.getForceSyncController().getState();
		const foreground = this.plugin.getForegroundOperation();
		const checkingConnection = Boolean(this.plugin.getConnectionActivity());
		const fullActive =
			(this.plugin.isFullSyncInProgress() || checkingConnection) &&
			!state?.active &&
			!foreground;
		this.setButtonActivity(
			this.syncButton,
			fullActive,
			t(
				checkingConnection
					? "status.checking_connection"
					: fullActive
						? "settings.syncing_button"
						: "settings.sync_button",
			),
		);
		for (const { button, direction } of this.forceButtons) {
			const active =
				state?.active === true && state.direction === direction;
			button.setDisabled(busy || this.plugin.isForceSyncUnavailable());
			this.setButtonActivity(
				button,
				active,
				t(
					active
						? "settings.operation_in_progress"
						: direction === "from_local"
							? "settings.force_sync_from_local_button"
							: "settings.force_sync_from_remote_button",
				),
			);
		}
		const passwordChange =
			this.plugin.isEncryptionPasswordChangeInProgress();
		this.encryptionToggle?.toggleEl.setAttribute(
			"aria-busy",
			String(foreground === "encryption" && !passwordChange),
		);
		if (this.encryptionSpinner) {
			this.encryptionSpinner.hidden =
				foreground !== "encryption" || passwordChange;
		}
		this.setButtonActivity(
			this.backupButton,
			foreground === "backup",
			t(
				foreground === "backup"
					? "settings.backup_in_progress"
					: "settings.backup_button",
			),
		);
		this.setButtonActivity(
			this.encryptionButton,
			passwordChange,
			t(
				passwordChange
					? "settings.operation_in_progress"
					: "settings.encryption_change_password",
			),
		);
		if (this.clearLogsButton) {
			this.clearLogsButton.setDisabled(
				this.clearingLogs || this.plugin.isPluginUnloaded(),
			);
			this.setButtonActivity(
				this.clearLogsButton,
				this.clearingLogs,
				t(
					this.clearingLogs
						? "settings.operation_in_progress"
						: "settings.clear_logs_button",
				),
			);
		}
	}

	/** Keep one settings flow alive across its dialogs; recheck context after each prompt. */
	private async runSettingsAction(
		action: (isCurrent: () => boolean) => Promise<void>,
	): Promise<void> {
		if (this.isActionUnavailable()) {
			return;
		}
		const generation = this.renderGeneration;
		const configuration = this.plugin
			.getBackupManager()
			.getConfigurationGeneration();
		this.pendingAction = true;
		this.updateActivity();
		const isCurrent = () =>
			this.displayed &&
			generation === this.renderGeneration &&
			!this.plugin.isPluginUnloaded() &&
			!this.plugin.isConfigurationBusy() &&
			configuration ===
				this.plugin.getBackupManager().getConfigurationGeneration();
		try {
			await action(isCurrent);
		} catch (error) {
			if (this.displayed && !this.plugin.isPluginUnloaded()) {
				new Notice(
					formatOperationFailure(
						createSyncFailure(error, {
							stage: "preflight",
							action: "local",
						}).summary,
					),
				);
			}
		} finally {
			this.pendingAction = false;
			this.updateActivity();
		}
	}

	private async applyDraft(patch: UserSettingsPatch): Promise<void> {
		try {
			await this.plugin.applySettingsPatch(patch);
		} catch (error) {
			if (this.plugin.isPluginUnloaded()) {
				return;
			}
			new Notice(
				formatOperationFailure(
					createSyncFailure(error, {
						stage: "persisting",
						action: "local",
					}).summary,
				),
			);
			this.renderSettings();
		}
	}

	private async enableEncryptionFlow(
		isCurrent: () => boolean,
	): Promise<void> {
		let remoteManifest: RemoteEncryptionManifest | null = null;
		try {
			remoteManifest = await this.plugin.getRemoteEncryptionManifest();
		} catch (error) {
			if (!isCurrent()) {
				return;
			}
			new Notice(
				error instanceof UnsupportedHistoricalDataError
					? t("notice.unsupported_historical_data")
					: formatOperationFailure(
							createSyncFailure(error, {
								stage: "preflight",
								action: "read",
							}).summary,
						),
			);
			return;
		}

		if (!isCurrent()) {
			return;
		}
		if (remoteManifest) {
			const password = await this.promptConnectEncryptionPassword();
			if (!password || !isCurrent()) {
				return;
			}

			try {
				await this.plugin.connectToRemoteEncryption(
					password,
					remoteManifest,
				);
				if (!this.plugin.isPluginUnloaded()) {
					new Notice(t("notice.encryption_connected"));
				}
			} catch (error) {
				if (!this.plugin.isPluginUnloaded()) {
					new Notice(
						formatOperationFailure(
							createSyncFailure(error, {
								stage: "preflight",
								action: "read",
							}).summary,
						),
					);
				}
			}
			return;
		}

		const password = await this.promptNewEncryptionPassword();
		if (!password || !isCurrent()) {
			return;
		}

		try {
			await this.plugin.enableEncryption(password);
		} catch {
			// The plugin owns the single progress and result Notice.
		}
	}

	private async disableEncryptionFlow(
		isCurrent: () => boolean,
	): Promise<void> {
		const currentPassword = await this.promptCurrentEncryptionPassword();
		if (!currentPassword || !isCurrent()) {
			return;
		}

		const confirmed = await new Promise<boolean>((resolve) => {
			new DisableEncryptionModal(this.app, resolve).open();
		});
		if (!confirmed || !isCurrent()) {
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
		this.backupButton = null;
		this.encryptionButton = null;
		this.clearLogsButton = null;
		this.encryptionToggle = null;
		this.encryptionSpinner = null;
		this.controls = [];
		this.forceButtons = [];
		this.plugin.encryptionStateChangeCallback = () => {
			this.renderSettings();
		};
		const { containerEl } = this;
		containerEl.empty();
		this.controlsEl = containerEl.createEl("div", {
			cls: "force-settings-controls",
		});
		// Guard stale native/custom events as well as disabling each Obsidian component.
		for (const event of ["click", "keydown", "input", "change"]) {
			this.controlsEl.addEventListener(
				event,
				(e) => {
					if (
						!this.isActionUnavailable() ||
						(e.target instanceof Element &&
							e.target.closest(".sync-diagnostic-controls"))
					) {
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
			.then((control) => this.trackControl(control))
			.onClick(() => {
				if (this.isActionUnavailable()) {
					return;
				}
				window.open("https://oauth.yandex.ru/", "_blank");
			});

		controlEl.createEl("label", { text: t("settings.client_id") });
		new TextComponent(controlEl)
			.setPlaceholder(t("settings.client_id_placeholder"))
			.setValue(this.plugin.settings.clientId)
			.then((control) => this.trackControl(control))
			.onChange(async (value) => {
				if (this.isActionUnavailable()) {
					return;
				}
				await this.applyDraft({ clientId: value });
				this.renderSettings();
			});

		new ButtonComponent(controlEl)
			.setButtonText(t("settings.get_token"))
			.setDisabled(!this.plugin.settings.clientId?.trim())
			.then((control) => this.trackControl(control))
			.onClick(() => {
				if (this.isActionUnavailable()) {
					return;
				}
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
			.then((control) => this.trackControl(control))
			.onChange(async (value) => {
				if (this.isActionUnavailable()) {
					return;
				}
				await this.applyDraft({ yandexTokenSecret: value });
			});

		this.syncButton = new ButtonComponent(controlEl)
			.setButtonText(t("settings.sync_button"))
			.setCta();
		this.trackControl(this.syncButton);
		this.syncButton.onClick(async () => {
			if (this.isActionUnavailable()) {
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
					.then((control) => this.trackControl(control))
					.onChange(async (value) => {
						if (this.isActionUnavailable()) {
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
					.then((control) => this.trackControl(control))
					.onChange(async (value) => {
						if (this.isActionUnavailable()) {
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
					.then((control) => this.trackControl(control))
					.onChange(async (value) => {
						if (this.isActionUnavailable()) {
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
					.then((control) => this.trackControl(control))
					.onChange(async (value) => {
						if (this.isActionUnavailable()) {
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
					.setLimits(1, 40, 1)
					.setValue(this.plugin.settings.maxConcurrency)
					// eslint-disable-next-line @typescript-eslint/no-deprecated
					.setDynamicTooltip()
					.then((control) => this.trackControl(control))
					.onChange(async (value) => {
						if (this.isActionUnavailable()) {
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
					.then((control) => this.trackControl(control))
					.onClick(() => {
						if (this.isActionUnavailable()) {
							return;
						}
						void this.plugin.runForceSyncFromLocal();
					});
			})
			.addButton((button) => {
				this.forceButtons.push({ button, direction: "from_remote" });
				return button
					.setButtonText(t("settings.force_sync_from_remote_button"))
					.setCta()
					.then((control) => this.trackControl(control))
					.onClick(() => {
						if (this.isActionUnavailable()) {
							return;
						}
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

		new Setting(containerEl)
			.setName(t("settings.encryption_desc"))
			.addToggle((toggle) => {
				this.encryptionToggle = toggle;
				this.encryptionSpinner =
					toggle.toggleEl.parentElement!.createSpan({
						cls: "encryption-toggle-spinner",
					});
				this.encryptionSpinner.hidden = true;
				return toggle
					.setValue(this.plugin.settings.enableEncryption)
					.setDisabled(migrationPending)
					.then((control) => this.trackControl(control))
					.onChange(async (value) => {
						toggle.setValue(this.plugin.settings.enableEncryption);
						if (this.isActionUnavailable()) {
							return;
						}
						await this.runSettingsAction(async (isCurrent) => {
							try {
								if (
									value &&
									!this.plugin.settings.enableEncryption
								) {
									await this.enableEncryptionFlow(isCurrent);
								} else if (
									!value &&
									this.plugin.settings.enableEncryption
								) {
									await this.disableEncryptionFlow(isCurrent);
								}
							} finally {
								toggle.setValue(
									this.plugin.settings.enableEncryption,
								);
							}
						});
					});
			});

		if (this.plugin.settings.enableEncryption) {
			new Setting(containerEl)
				.setDesc(t("settings.encryption_status_active"))
				.addButton((button) =>
					button
						.setButtonText(t("settings.encryption_change_password"))
						.then((control) => {
							this.encryptionButton = control;
							this.trackControl(control);
						})
						.onClick(async () => {
							if (this.isActionUnavailable()) {
								return;
							}
							await this.runSettingsAction(async (isCurrent) => {
								const currentPassword =
									await this.promptCurrentEncryptionPassword();
								if (!currentPassword || !isCurrent()) {
									return;
								}
								const password = await new Promise<
									string | null
								>((resolve) =>
									new ChangePasswordModal(
										this.app,
										resolve,
									).open(),
								);
								if (!password || !isCurrent()) {
									return;
								}
								try {
									await this.plugin.rotateEncryptionPassword(
										password,
									);
								} catch {
									// The plugin owns the single progress and result Notice.
								}
							});
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
					.then((control) => this.trackControl(control))
					.onChange(async (value) => {
						if (this.isActionUnavailable()) {
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
					.then((control) => this.trackControl(control))
					.onChange(async (value) => {
						if (this.isActionUnavailable()) {
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
					.then((control) => this.trackControl(control))
					.onChange(async (value) => {
						if (this.isActionUnavailable()) {
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

		// Logging remains available during every synchronization operation.
		const loggingEl = containerEl.createDiv({
			cls: "sync-diagnostic-controls",
		});
		new Setting(loggingEl)
			.setName(t("settings.logging_section"))
			.setHeading();

		// Enable debug logging
		new Setting(loggingEl)
			.setName(t("settings.enable_debug_logging"))
			.setDesc(t("settings.enable_debug_logging_desc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableDebugLogging)
					.setDisabled(migrationPending)
					.then((control) => this.trackControl(control, true))
					.onChange(async (value) => {
						if (this.plugin.isPluginUnloaded()) {
							return;
						}
						await this.applyDraft({ enableDebugLogging: value });
					}),
			);

		// Write logs to file
		new Setting(loggingEl)
			.setName(t("settings.log_to_file"))
			.setDesc(t("settings.log_to_file_desc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.logToFile)
					.setDisabled(migrationPending)
					.then((control) => this.trackControl(control, true))
					.onChange(async (value) => {
						if (this.plugin.isPluginUnloaded()) {
							return;
						}
						await this.applyDraft({ logToFile: value });
					}),
			);

		// View logs button
		new Setting(loggingEl)
			.addButton((button) =>
				button
					.setButtonText(t("settings.view_logs_button"))
					.setCta()
					.then((control) => this.trackControl(control, true))
					.onClick(() => {
						if (this.plugin.isPluginUnloaded()) {
							return;
						}
						new LogViewerModal(
							this.app,
							() => !this.plugin.isPluginUnloaded(),
						).open();
					}),
			)
			.addButton((button) =>
				button
					.setButtonText(t("settings.clear_logs_button"))
					// eslint-disable-next-line @typescript-eslint/no-deprecated
					.setWarning()
					.then((control) => {
						this.clearLogsButton = control;
						this.trackControl(control, true);
					})
					.onClick(async () => {
						if (
							this.clearingLogs ||
							this.plugin.isPluginUnloaded()
						) {
							return;
						}
						const generation = this.renderGeneration;
						this.clearingLogs = true;
						this.updateActivity();
						try {
							await clearLogsWithConfirmation(
								this.app,
								() =>
									this.displayed &&
									generation === this.renderGeneration &&
									!this.plugin.isPluginUnloaded(),
							);
						} finally {
							this.clearingLogs = false;
							this.updateActivity();
						}
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
					.then((control) => {
						this.backupButton = control;
						this.trackControl(control);
					})
					.onClick(async () => {
						await this.runSettingsAction(async (isCurrent) => {
							const confirmed = await new Promise<boolean>(
								(resolve) =>
									new DecisionModal(
										this.app,
										t("modal.create_backup_title"),
										t("modal.create_backup_description", {
											path: `${this.plugin.settings.remotePath}/.backup`,
											mode: t(
												this.plugin.settings
													.enableEncryption
													? "modal.backup_mode_encrypted"
													: "modal.backup_mode_plaintext",
											),
										}),
										[
											{
												label: t("modal.cancel_button"),
												value: "cancel",
											},
											{
												label: t(
													"settings.backup_button",
												),
												value: "create",
												cta: true,
											},
										],
										"cancel",
										(choice) =>
											resolve(choice === "create"),
									).open(),
							);
							if (!confirmed || !isCurrent()) {
								return;
							}
							const result = await this.plugin.createBackup();
							if (this.plugin.isPluginUnloaded()) {
								return;
							}
							if (result.success) {
								this.renderSettings();
							} else {
								new Notice(
									result.error ?? t("settings.backup_error"),
								);
							}
						});
					}),
			)
			.addButton((button) =>
				button
					.setButtonText(t("settings.backup_show_all"))
					.then((control) => this.trackControl(control))
					.onClick(() => {
						if (this.isActionUnavailable()) {
							return;
						}
						new BackupListModal(
							this.app,
							this.plugin.getBackupManager(),
							{
								isUnavailable: () => this.isActionUnavailable(),
								isCurrent: () =>
									!this.plugin.isPluginUnloaded(),
								subscribe: (update) =>
									this.plugin.onSyncActivityChange(update),
							},
						).open();
					}),
			);

		this.updateActivity();
	}
}
