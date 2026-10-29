/**
 * The one translation entry point, shared by the render engine, the Electron
 * main process and the React interface.
 *
 * The engine and the main process produce *sentences* (progress, diagnostics,
 * validation labels) that cross IPC as plain strings, so they must be built in
 * the language the application is wearing when they are produced. The interface
 * uses the same catalogs for its own copy, which keeps one source of truth for
 * every user-facing word in the product.
 *
 * Nothing here may import Electron, React or Node built-ins.
 */
import { en } from './en';
import { pt } from './pt';

export const LANGUAGES = ['pt', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Portuguese is the product's default, matching the project's origin. */
export const DEFAULT_LANGUAGE: Language = 'pt';

export type MessageKey = keyof typeof pt;
export type MessageParams = Record<string, string | number>;
export type Translator = (key: MessageKey, params?: MessageParams) => string;

export const MESSAGES: Record<Language, Record<MessageKey, string>> = { pt, en };

/** BCP-47 locale used by `Intl` formatters for a given interface language. */
export const LOCALES: Record<Language, string> = { pt: 'pt-PT', en: 'en-US' };

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

export function localeFor(language: Language): string {
  return LOCALES[language];
}

/**
 * Builds a translator for one language. Missing parameters are left as the
 * literal `{name}` so an untranslated placeholder is visible in review instead
 * of silently rendering an empty gap.
 */
export function createTranslator(language: Language): Translator {
  const messages = MESSAGES[language] ?? MESSAGES[DEFAULT_LANGUAGE];
  return (key, params) => {
    const template: string = messages[key] ?? MESSAGES[DEFAULT_LANGUAGE][key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
    );
  };
}

/** A translator for code that must run before settings are known (logs, tests). */
export const defaultTranslator: Translator = createTranslator(DEFAULT_LANGUAGE);
