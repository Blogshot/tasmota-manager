import type { Translate } from './i18n';
import { type MessageKey, de } from './messages';

const has = (key: string): key is MessageKey => Object.hasOwn(de, key);

/** Übersetzt Validierungsschlüssel des Servers (`invalid.range|0|5`), auch eingebettet in längeren Text. */
export function validationText(t: Translate, message: string): string {
  return message.replace(/invalid\.(\w+)((?:\|[^\s|]+)*)/g, (match, name: string, rest: string) => {
    const key = `validation.${name}`;
    if (!has(key)) return match;
    const [a = '', b = ''] = rest.split('|').slice(1);
    return t(key, { a, b });
  });
}

/**
 * Macht aus einem Fehler des Servers einen Text in der Sprache der Oberfläche.
 * Der Server liefert einen Code (`timeout`, `verify_mismatch` …) und englischen Rohtext; unbekannte Codes bleiben Rohtext.
 */
export function errorText(t: Translate, error: string | { code?: string; message: string }): string {
  const raw = typeof error === 'string' ? error : error.message;
  const prefixed = /^([a-z_]+)(?::\s*([\s\S]*))?$/.exec(raw);
  const code = typeof error === 'string' || !error.code ? prefixed?.[1] : error.code;
  if (code === 'validation') return validationText(t, raw);
  if (code === 'verify_mismatch') {
    const values = /expected "([\s\S]*)", got "([\s\S]*)"$/.exec(raw);
    if (values) return t('error.verify_mismatch', { expected: values[1] ?? '', actual: values[2] ?? '' });
  }
  const key = `error.${code}`;
  return code && has(key) ? t(key) : validationText(t, raw);
}
