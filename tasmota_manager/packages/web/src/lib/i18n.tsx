import { type ReactNode, createContext, useCallback, useContext } from 'react';
import { readHaContext } from './ha';
import { type MessageKey, de, en } from './messages';

export type Lang = 'de' | 'en';
type Vars = Record<string, string | number>;

const dictionaries: Record<Lang, Record<MessageKey, string>> = { de, en };
const I18nContext = createContext<Lang>('en');

export function detectLanguage(): Lang {
  const language = (readHaContext().language ?? navigator.language).toLowerCase();
  return language.startsWith('de') ? 'de' : 'en';
}

export function formatMessage(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
}

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  return <I18nContext.Provider value={lang}>{children}</I18nContext.Provider>;
}

export function useT(): (key: MessageKey, vars?: Vars) => string {
  const lang = useContext(I18nContext);
  return useCallback((key: MessageKey, vars?: Vars) => formatMessage(dictionaries[lang][key], vars), [lang]);
}
