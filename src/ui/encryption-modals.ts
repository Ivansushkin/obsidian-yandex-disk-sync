import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n";

/** Resolve a modal promise exactly once and provide a close fallback. */
abstract class ResolvableModal<T> extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly resolveResult: (value: T) => void,
		private readonly closeFallback: T,
	) {
		super(app);
	}

	protected finish(value: T): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolveResult(value);
	}

	onClose(): void {
		this.finish(this.closeFallback);
		this.contentEl.empty();
	}
}

/** Share password input, confirmation, submit, and cancel behavior. */
abstract class PasswordModal extends ResolvableModal<string | null> {
	private passwordInput!: HTMLInputElement;
	private confirmInput: HTMLInputElement | null = null;
	private errorEl: HTMLElement | null = null;

	constructor(app: App, resolve: (value: string | null) => void) {
		super(app, resolve, null);
	}

	protected renderPasswordFields(confirm: boolean): void {
		this.passwordInput = this.contentEl.createEl("input", {
			type: "password",
			placeholder: t("modal.encryption_password_label"),
		});
		this.passwordInput.addClass("encryption-password-input");
		if (!confirm) return;

		this.confirmInput = this.contentEl.createEl("input", {
			type: "password",
			placeholder: t("modal.encryption_confirm_label"),
		});
		this.confirmInput.addClass("encryption-password-input");
		this.errorEl = this.contentEl.createEl("p", {
			text: t("modal.encryption_password_mismatch"),
		});
		this.errorEl.addClass("encryption-password-error");
	}

	protected getPassword(): string | null {
		const password = this.passwordInput.value;
		if (
			!password ||
			(this.confirmInput !== null &&
				password !== this.confirmInput.value)
		) {
			this.errorEl?.addClass("is-visible");
			return null;
		}
		return password;
	}

	protected getPasswordInput(): HTMLInputElement {
		return this.passwordInput;
	}

	protected addSubmitButtons(
		buttonText: string,
		onSubmit: (password: string) => boolean | Promise<boolean>,
	): void {
		const setting = new Setting(this.contentEl)
			.addButton((button) =>
				button
					.setButtonText(buttonText)
					.setCta()
					.onClick(async () => {
						const password = this.getPassword();
						if (!password || !(await onSubmit(password))) return;
						this.finish(password);
						this.close();
					}),
			)
			.addButton((button) =>
				button
					.setButtonText(t("modal.cancel_button"))
					.onClick(() => this.cancel()),
			);
		setting.settingEl.addClass("force-sync-modal-buttons");
	}

	protected cancel(): void {
		this.finish(null);
		this.close();
	}
}

export class EnableEncryptionModal extends PasswordModal {
	private createBackup: () => Promise<{ success: boolean; backupName?: string; error?: string }>;

	constructor(
		app: App,
		resolve: (value: string | null) => void,
		createBackup: () => Promise<{ success: boolean; backupName?: string; error?: string }>
	) {
		super(app, resolve);
		this.createBackup = createBackup;
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

		this.renderPasswordFields(true);

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
					.onClick(() => this.cancel())
			);
		setting.settingEl.addClass("force-sync-modal-buttons");
	}

}

export class DisableEncryptionModal extends ResolvableModal<boolean> {
	constructor(app: App, resolve: (value: boolean) => void) {
		super(app, resolve, false);
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

}

export class VerifyPasswordModal extends PasswordModal {
	private verifyPassword: (password: string) => Promise<boolean>;

	constructor(
		app: App,
		resolve: (value: string | null) => void,
		verifyPassword: (password: string) => Promise<boolean>
	) {
		super(app, resolve);
		this.verifyPassword = verifyPassword;
	}

	private clearError(): void {
		this.getPasswordInput().removeClass("is-error");
	}

	private setError(): void {
		const input = this.getPasswordInput();
		input.addClass("is-error");
		input.value = "";
		input.focus();
		new Notice(t("notice.encryption_wrong_password"));
	}

	onOpen(): void {
		const { contentEl } = this;

		this.titleEl.setText(t("modal.encryption_change_password_title"));

		contentEl.createEl("p", {
			text: t("modal.encryption_enter_current_password"),
		});

		this.renderPasswordFields(false);
		this.getPasswordInput().oninput = () => this.clearError();
		this.addSubmitButtons(t("generic.confirm"), async (password) => {
			if (await this.verifyPassword(password)) return true;
			this.setError();
			return false;
		});
	}

}

export class ChangePasswordModal extends PasswordModal {
	constructor(app: App, resolve: (value: string | null) => void) {
		super(app, resolve);
	}

	onOpen(): void {
		const { contentEl } = this;

		this.titleEl.setText(t("modal.encryption_change_password_title"));

		contentEl.createEl("p", {
			text: t("modal.encryption_enter_password"),
		});

		this.renderPasswordFields(true);
		this.addSubmitButtons(
			t("modal.encryption_change_password_button"),
			() => true,
		);
	}

}

export class ConnectEncryptedVaultModal extends PasswordModal {
	private title: string;
	private description: string;
	private buttonText: string;

	constructor(
		app: App,
		resolve: (value: string | null) => void,
		title: string,
		description: string,
		buttonText: string
	) {
		super(app, resolve);
		this.title = title;
		this.description = description;
		this.buttonText = buttonText;
	}

	onOpen(): void {
		const { contentEl } = this;

		this.titleEl.setText(this.title);

		contentEl.createEl("p", { text: this.description });
		contentEl.createEl("p", {
			text: t("modal.encryption_connect_privacy"),
		});

		this.renderPasswordFields(false);
		this.addSubmitButtons(this.buttonText, () => true);
	}

}
