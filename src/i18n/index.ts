/**
 * Internationalization service for Yandex Disk Sync plugin
 * Detects language from Obsidian settings and provides translation functions
 */

import { translations, Language } from './translations';
import { logger } from '../utils/logger';

let currentLanguage: Language = 'en';
let isInitialized = false;

/**
 * Detect language from Obsidian settings
 */
function detectLanguage(): Language {
    try {
        // Use official method getLanguage() from Obsidian API via localStorage
        const obsidianLang = window.localStorage.getItem("language");

        if (obsidianLang && typeof obsidianLang === "string") {
            const lang = obsidianLang.toLowerCase();

            if (lang.startsWith("ru")) {
                return "ru";
            }
        }
    } catch (e) {
        // Log error but don't crash
        logger.warn('[YandexSync i18n] Error detecting language:', { error: e });
    }

    // Default to English
    return "en";
}

/**
 * Initialize i18n service
 */
export function initI18n(): void {
    if (isInitialized) {
        return;
    }

    currentLanguage = detectLanguage();
    isInitialized = true;

    // Make global t() function available
    (window as { t?: typeof t }).t = t;
}

/**
 * Get current language
 */
export function getCurrentLanguage(): Language {
    return currentLanguage;
}

/**
 * Set language manually (for testing)
 */
export function setLanguage(language: Language): void {
    currentLanguage = language;
}

/**
 * Get translated string by key
 */
export function translate(key: string, params?: Record<string, string | number>): string {
    const dict = translations[currentLanguage] || translations.en;
    let text = dict[key] || translations.en[key] || key;

    // Replace parameters
    if (params) {
        for (const [param, value] of Object.entries(params)) {
            text = text.replace(new RegExp(`{${param}}`, 'g'), String(value));
        }
    }

    return text;
}

/**
 * Alias for translate function
 */
export const t = translate;