import { describe, expect, it } from 'vitest';
import { errorText, validationText } from './errors';
import { dictionaries, formatMessage } from './i18n';
import type { MessageKey } from './messages';

const t = (lang: keyof typeof dictionaries) => (key: MessageKey, vars?: Record<string, string | number>) =>
  formatMessage(dictionaries[lang][key], vars);

describe('errorText', () => {
  it('übersetzt Fehler aus dem Puffer anhand des Codes', () => {
    expect(errorText(t('de'), 'timeout: No MQTT response within 500 ms')).toBe('Keine Antwort vom Gerät');
    expect(errorText(t('en'), 'offline')).toBe('Device not reachable');
    expect(errorText(t('fr'), 'interrupted: The app was restarted during the batch run')).toBe('L’application a été redémarrée pendant le lot');
  });

  it('setzt Soll und Ist einer Abweichung ein', () => {
    expect(errorText(t('de'), 'verify_mismatch: expected "5", got "1"')).toBe('Wert nicht übernommen: Soll „5“, Ist „1“');
  });

  it('nutzt bei API-Fehlern den Code und lässt Unbekanntes unverändert', () => {
    expect(errorText(t('de'), { code: 'busy', message: 'A batch is currently running' })).toBe('Es läuft bereits ein Vorgang');
    expect(errorText(t('de'), { code: 'seltsam', message: 'Something odd' })).toBe('Something odd');
    expect(errorText(t('de'), new Error('Failed to fetch'))).toBe('Failed to fetch');
  });

  it('übersetzt Validierungsschlüssel mit Parametern', () => {
    expect(validationText(t('de'), 'invalid.range|0|5')).toBe('Erlaubt: 0–5');
    expect(errorText(t('en'), { code: 'validation', message: 'PowerOnState: ✖ invalid.range|0|5' })).toBe('PowerOnState: ✖ Allowed: 0–5');
    expect(validationText(t('de'), 'invalid.gibtsnicht')).toBe('invalid.gibtsnicht');
  });
});

describe('Wörterbücher', () => {
  const keys = Object.keys(dictionaries.en) as MessageKey[];
  const placeholders = (text: string) => [...text.matchAll(/\{\{?\w+\}?\}/g)].map((m) => m[0]).sort();

  it.each(Object.keys(dictionaries) as Array<keyof typeof dictionaries>)('%s enthält alle Schlüssel mit denselben Platzhaltern', (lang) => {
    expect(Object.keys(dictionaries[lang]).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(dictionaries[lang][key].trim(), key).not.toBe('');
      expect(placeholders(dictionaries[lang][key]), key).toEqual(placeholders(dictionaries.en[key]));
    }
  });

  it('nennt sieben Wochentage, beginnend mit Sonntag', () => {
    for (const lang of Object.keys(dictionaries) as Array<keyof typeof dictionaries>) {
      expect(dictionaries[lang]['days.short'].split(',')).toHaveLength(7);
    }
  });
});
