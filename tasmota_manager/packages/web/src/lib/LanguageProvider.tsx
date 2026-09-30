import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect } from 'react';
import { api } from './api';
import { I18nProvider, detectLanguage } from './i18n';

/** Wählt die Sprache aus den Einstellungen; bis sie geladen sind (und bei „Automatisch") gilt die Sprache des HA-Profils. */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const lang = detectLanguage(settings?.language ?? 'auto');
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return <I18nProvider lang={lang}>{children}</I18nProvider>;
}
