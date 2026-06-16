import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n";

export class EnableEncryptionModal extends Modal {
	private resolve: (value: string | null) => void;
	private resolved = false;
	private createBackup: () => Promise<{ success: boolean; backupName?: string; error?: string }>;
	private passwordInput: HTMLInputElement;
	private confirmInput: HTMLInputElement;
	private errorEl: HTMLElement;

	constructor(
		app: App,
		resolve: (value: string | null) => void,
		createBackup: () => Promise<{ success: boolean; backupName?: string; error?: string }>
	) {
		super(app);
		this.resolve = resolve;
		this.createBackup = createBackup;
	}

	private finish(value: string | null): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(value);
	}

	private getPassword(): string | null {
		const pw = this.passwordInput.value;
		const confirmPw = this.confirmInput.value;
		if (!pw || pw !== confirmPw) {
			// eslint-disable-next-line obsidianmd/no-static-styles-assignment
			this.errorEl.style.display = "block";
			return null;
		}
		return pw;
	}

	onOpen(): void {
		const { contentEl } = this;

		this.titleEl.setText(t("modal.encryption_enable_title"));

		contentEl.createEl("p", {
			text: t("modal.encryption_enable_warning"),
		});

		contentEl.createEl("p", {
			text: t("modal.encryption_enter_password"),
		});

		this.passwordInput = contentEl.createEl("input", {
			type: "password",
			placeholder: t("modal.encryption_password_label"),
		});
		this.passwordInput.addClass("encryption-password-input");

		this.confirmInput = contentEl.createEl("input", {
			type: "password",
			placeholder: t("modal.encryption_confirm_label"),
		});
		this.confirmInput.addClass("encryption-password-input");

		this.errorEl = contentEl.createEl("p", {
			text: t("modal.encryption_password_mismatch"),
		});
		this.errorEl.addClass("encryption-password-error");
		// eslint-disable-next-line obsidianmd/no-static-styles-assignment
		this.errorEl.style.display = "none";

		const setting = new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(t("modal.encryption_enable_with_backup"))
					.setCta()
					.onClick(async () => {
						const pw = this.getPassword();
						if (!pw) return;
						await this.createBackup();
						this.finish(pw);
						this.close();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText(t("modal.encryption_enable_without_backup"))
					.onClick(() => {
						const pw = this.getPassword();
						if (!pw) return;
						this.finish(pw);
						this.close();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText(t("modal.cancel_button"))
					.onClick(() => {
						this.finish(null);
						this.close();
					})
			);
		setting.settingEl.addClass("force-sync-modal-buttons");
	}

	onClose(): void {
		this.finish(null);
		const { contentEl } = this;
		contentEl.empty();
	}
}

export class DisableEncryptionModal extends Modal {
	private resolve: (value: boolean) => void;
	private resolved = false;

	constructor(app: App, resolve: (value: boolean) => void) {
		super(app);
		this.resolve = resolve;
	}

	private finish(value: boolean): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(value);
	}

	onOpen(): void {
		const { contentEl } = this;

		this.titleEl.setText(t("modal.encryption_disable_title"));

		contentEl.createEl("p", {
			text: t("modal.encryption_disable_warning"),
		});

		const setting = new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(t("generic.yes"))
					.setCta()
					.onClick(() => {
						this.finish(true);
						this.close();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText(t("modal.cancel_button"))
					.onClick(() => {
						this.finish(false);
						this.close();
					})
			);
		setting.settingEl.addClass("force-sync-modal-buttons");
	}

	onClose(): void {
		this.finish(false);
		const { contentEl } = this;
		contentEl.empty();
	}
}

export class VerifyPasswordModal extends Modal {
	private resolve: (value: string | null) => void;
	private resolved = false;
	private correctPassword: string;
	private input: HTMLInputElement;

	constructor(app: App, resolve: (value: string | null) => void, correctPassword: string) {
		super(app);
		this.resolve = resolve;
		this.correctPassword = correctPassword;
	}

	private finish(value: string | null): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(value);
	}

	private clearError(): void {
		this.input.removeClass("is-error");
	}

	private setError(): void {
		this.input.addClass("is-error");
		this.input.value = "";
		this.input.focus();
		new Notice(t("notice.encryption_wrong_password"));
	}

	onOpen(): void {
		const { contentEl } = this;

		this.titleEl.setText(t("modal.encryption_change_password_title"));

		contentEl.createEl("p", {
			text: t("modal.encryption_enter_current_password"),
		});

		this.input = contentEl.createEl("input", {
			type: "password",
			placeholder: t("modal.encryption_password_label"),
		});
		this.input.addClass("encryption-password-input");
		this.input.oninput = () => this.clearError();

		const setting = new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(t("generic.confirm"))
					.setCta()
					.onClick(() => {
						const pw = this.input.value;
						if (!pw) return;
						if (pw !== this.correctPassword) {
							this.setError();
							return;
						}
						this.finish(pw);
						this.close();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText(t("modal.cancel_button"))
					.onClick(() => {
						this.finish(null);
						this.close();
					})
			);
		setting.settingEl.addClass("force-sync-modal-buttons");
	}

	onClose(): void {
		this.finish(null);
		const { contentEl } = this;
		contentEl.empty();
	}
}

export class ChangePasswordModal extends Modal {
	private resolve: (value: string | null) => void;
	private resolved = false;
	private passwordInput: HTMLInputElement;
	private confirmInput: HTMLInputElement;
	private errorEl: HTMLElement;

	constructor(app: App, resolve: (value: string | null) => void) {
		super(app);
		this.resolve = resolve;
	}

	private finish(value: string | null): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(value);
	}

	private getPassword(): string | null {
		const pw = this.passwordInput.value;
		const confirmPw = this.confirmInput.value;
		if (!pw || pw !== confirmPw) {
			// eslint-disable-next-line obsidianmd/no-static-styles-assignment
			this.errorEl.style.display = "block";
			return null;
		}
		return pw;
	}

	onOpen(): void {
		const { contentEl } = this;

		this.titleEl.setText(t("modal.encryption_change_password_title"));

		contentEl.createEl("p", {
			text: t("modal.encryption_enter_password"),
		});

		this.passwordInput = contentEl.createEl("input", {
			type: "password",
			placeholder: t("modal.encryption_password_label"),
		});
		this.passwordInput.addClass("encryption-password-input");

		this.confirmInput = contentEl.createEl("input", {
			type: "password",
			placeholder: t("modal.encryption_confirm_label"),
		});
		this.confirmInput.addClass("encryption-password-input");

		this.errorEl = contentEl.createEl("p", {
			text: t("modal.encryption_password_mismatch"),
		});
		this.errorEl.addClass("encryption-password-error");
		// eslint-disable-next-line obsidianmd/no-static-styles-assignment
		this.errorEl.style.display = "none";

		const setting = new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(t("modal.encryption_change_password_button"))
					.setCta()
					.onClick(() => {
						const pw = this.getPassword();
						if (!pw) return;
						this.finish(pw);
						this.close();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText(t("modal.cancel_button"))
					.onClick(() => {
						this.finish(null);
						this.close();
					})
			);
		setting.settingEl.addClass("force-sync-modal-buttons");
	}

	onClose(): void {
		this.finish(null);
		const { contentEl } = this;
		contentEl.empty();
	}
}

export class PasswordPromptModal extends Modal {
	private resolve: (value: string | null) => void;
	private resolved = false;
	private createBackup: () => Promise<{ success: boolean; backupName?: string; error?: string }>;
	private input: HTMLInputElement;
	private promptText: string;

	constructor(
		app: App,
		resolve: (value: string | null) => void,
		createBackup: () => Promise<{ success: boolean; backupName?: string; error?: string }>,
		promptText: string
	) {
		super(app);
		this.resolve = resolve;
		this.createBackup = createBackup;
		this.promptText = promptText;
	}

	private finish(value: string | null): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(value);
	}

	private getPassword(): string | null {
		const pw = this.input.value;
		if (!pw) return null;
		return pw;
	}

	onOpen(): void {
		const { contentEl } = this;

		this.titleEl.setText(t("modal.encryption_enable_title"));

		contentEl.createEl("p", { text: this.promptText });

		this.input = contentEl.createEl("input", {
			type: "password",
			placeholder: t("modal.encryption_password_label"),
		});
		this.input.addClass("encryption-password-input");

		const setting = new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(t("modal.encryption_enable_with_backup"))
					.setCta()
					.onClick(async () => {
						const pw = this.getPassword();
						if (!pw) return;
						await this.createBackup();
						this.finish(pw);
						this.close();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText(t("modal.encryption_enable_without_backup"))
					.onClick(() => {
						const pw = this.getPassword();
						if (!pw) return;
						this.finish(pw);
						this.close();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText(t("modal.cancel_button"))
					.onClick(() => {
						this.finish(null);
						this.close();
					})
			);
		setting.settingEl.addClass("force-sync-modal-buttons");
	}

	onClose(): void {
		this.finish(null);
		const { contentEl } = this;
		contentEl.empty();
	}
}
