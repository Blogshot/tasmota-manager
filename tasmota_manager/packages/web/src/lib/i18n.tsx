import { type Language, type LanguageSetting, resolveLanguage } from '@tm/shared';
import { type ReactNode, createContext, useCallback, useContext } from 'react';
import { readHaContext } from './ha';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { it } from './locales/it';
import { nl } from './locales/nl';
import { type MessageKey, de, en } from './messages';

export type Lang = Language;
type Vars = Record<string, string | number>;
export type Translate = (key: MessageKey, vars?: Vars) => string;

export const dictionaries: Record<Lang, Record<MessageKey, string>> = { en, de, fr, es, it, nl };

/** Sprachnamen in der jeweiligen Sprache, damit man die eigene auch in fremder Oberfläche findet. */
export const LANGUAGE_NAMES: Record<Lang, string> = {
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  it: 'Italiano',
  nl: 'Nederlands',
};

const I18nContext = createContext<Lang>('en');

/** Feste Auswahl aus den Einstellungen; bei „auto" die Sprache des HA-Profils, sonst die des Browsers, sonst Englisch. */
export function detectLanguage(setting: LanguageSetting = 'auto'): Lang {
  return resolveLanguage(setting, readHaContext().language ?? navigator.language);
}

export function formatMessage(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
}

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  return <I18nContext.Provider value={lang}>{children}</I18nContext.Provider>;
}

export function useT(): Translate {
  const lang = useContext(I18nContext);
  return useCallback((key: MessageKey, vars?: Vars) => formatMessage(dictionaries[lang][key], vars), [lang]);
}
