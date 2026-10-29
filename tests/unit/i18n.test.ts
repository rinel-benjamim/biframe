import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  LOCALES,
  MESSAGES,
  createTranslator,
  isLanguage,
  localeFor,
  type MessageKey,
} from '@shared/i18n';
import { pt } from '@shared/i18n/pt';
import { en } from '@shared/i18n/en';
import { ERROR_CODES, ERROR_DEFINITIONS } from '@shared/errors';

/** Placeholder names used by a template, e.g. `{count}` -> `['count']`. */
function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();
}

describe('message catalogs', () => {
  it('exposes every supported language', () => {
    expect(LANGUAGES).toEqual(['pt', 'en']);
    expect(DEFAULT_LANGUAGE).toBe('pt');
    expect(Object.keys(MESSAGES)).toHaveLength(LANGUAGES.length);
  });

  it('has an English entry for every Portuguese key and nothing extra', () => {
    const ptKeys = Object.keys(pt).sort();
    const enKeys = Object.keys(en).sort();
    expect(enKeys).toEqual(ptKeys);
  });

  it('keeps the same placeholders in both languages', () => {
    for (const key of Object.keys(pt) as MessageKey[]) {
      expect(placeholders(en[key]), `placeholders of ${key}`).toEqual(placeholders(pt[key]));
    }
  });

  it('has no empty message in either language', () => {
    for (const language of LANGUAGES) {
      for (const [key, value] of Object.entries(MESSAGES[language])) {
        expect(value.trim().length, `${language}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('covers every error code with a title and a message', () => {
    for (const code of ERROR_CODES) {
      expect(pt[`error.${code}.title` as MessageKey]).toBeTruthy();
      expect(pt[`error.${code}.message` as MessageKey]).toBeTruthy();
      expect(en[`error.${code}.title` as MessageKey]).toBeTruthy();
      expect(en[`error.${code}.message` as MessageKey]).toBeTruthy();
    }
    expect(ERROR_DEFINITIONS.UNKNOWN_ERROR.title).toBe(pt['error.UNKNOWN_ERROR.title']);
  });
});

describe('createTranslator', () => {
  it('interpolates named parameters', () => {
    const t = createTranslator('en');
    expect(t('progress.capturing', { elapsed: '00:12', total: '00:40' })).toBe('Capturing 00:12 of 00:40');
  });

  it('leaves an unsupplied placeholder visible instead of blanking it', () => {
    const t = createTranslator('en');
    expect(t('progress.capturing', { elapsed: '00:12' })).toBe('Capturing 00:12 of {total}');
  });

  it('speaks the requested language for the same key', () => {
    expect(createTranslator('pt')('progress.completed')).toBe('Vídeo pronto');
    expect(createTranslator('en')('progress.completed')).toBe('Video ready');
  });

  it('falls back to Portuguese for an unknown language value', () => {
    const translator = createTranslator('de' as never);
    expect(translator('progress.completed')).toBe('Vídeo pronto');
  });
});

describe('language helpers', () => {
  it('recognises supported languages only', () => {
    expect(isLanguage('pt')).toBe(true);
    expect(isLanguage('en')).toBe(true);
    expect(isLanguage('fr')).toBe(false);
    expect(isLanguage(42)).toBe(false);
  });

  it('maps each language to its BCP-47 locale', () => {
    expect(localeFor('pt')).toBe('pt-PT');
    expect(localeFor('en')).toBe('en-US');
    expect(LOCALES.pt).toBe(localeFor('pt'));
  });
});
