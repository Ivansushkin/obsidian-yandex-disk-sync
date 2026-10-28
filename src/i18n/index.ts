/** Local interface language selection, independent of synchronization state. */
import { translations, type Language } from "./translations";

export type LanguagePreference = "system" | Language;
export const LANGUAGE_NAMES: Record<Language, string> = {
	en: "English",
	ru: "Русский",
	kk: "Қазақша",
	be: "Беларуская",
	uz: "O‘zbekcha",
};
let currentLanguage: Language = "en";

/** Normalize persisted preferences without rejecting otherwise valid plugin data. */
export function normalizeLanguagePreference(
	value: unknown,
): LanguagePreference {
	return value === "system" ||
		(typeof value === "string" &&
			Object.prototype.hasOwnProperty.call(LANGUAGE_NAMES, value))
		? (value as LanguagePreference)
		: "system";
}

/** Retain the existing Obsidian localStorage source for automatic selection. */
function detectLanguage(): Language {
	try {
		const value = globalThis.localStorage
			?.getItem("language")
			?.toLowerCase()
			.split(/[-_]/)[0];
		if (
			value &&
			Object.prototype.hasOwnProperty.call(LANGUAGE_NAMES, value)
		) {
			return value as Language;
		}
	} catch {
		// An unavailable application preference falls back to English.
	}
	return "en";
}

/** Publish a successfully saved preference; report whether visible text changed. */
export function setLanguagePreference(preference: LanguagePreference): boolean {
	const language = preference === "system" ? detectLanguage() : preference;
	const changed = currentLanguage !== language;
	currentLanguage = language;
	return changed;
}

export function getActiveLanguage(): Language {
	return currentLanguage;
}

/** Initialize fallback text before local plugin data is available. */
export function initI18n(): void {
	setLanguagePreference("system");
	(window as { t?: typeof t }).t = t;
}

/** Translate interface text while retaining literal parameter values. */
export function translate(
	key: string,
	params?: Record<string, string | number>,
): string {
	const dict = translations[currentLanguage] || translations.en;
	let text = dict[key] || translations.en[key] || key;
	if (params) {
		text = text.replace(/\{([^{}]+)\}/g, (placeholder, param: string) =>
			Object.prototype.hasOwnProperty.call(params, param)
				? String(params[param])
				: placeholder,
		);
	}
	return text;
}
export const t = translate;
