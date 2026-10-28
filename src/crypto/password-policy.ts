import { t } from "../i18n";

export const NEW_ENCRYPTION_PASSWORD_LIMITS = { min: 4, max: 30 } as const;

/** Validate new credentials only; existing passwords retain their exact bytes. */
export function getNewEncryptionPasswordError(password: string): string | null {
	const { min, max } = NEW_ENCRYPTION_PASSWORD_LIMITS;
	// A code point occupies at most two UTF-16 units; bound allocation before counting.
	const length = password.length > max * 2 ? max + 1 : [...password].length;
	return length < min || length > max
		? t("modal.encryption_password_length", NEW_ENCRYPTION_PASSWORD_LIMITS)
		: null;
}
