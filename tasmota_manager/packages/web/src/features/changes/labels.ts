import { type MessageKey, de } from '@/lib/messages';

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Beschriftung eines Puffer-Schlüssels; Rules und Timer werden aus ihrer Nummer gebildet. */
export function settingLabel(t: T, key: string): string {
  const rule = /^Rule(\d)(Enabled)?$/.exec(key);
  if (rule) return rule[2] ? `${t('rules.rule', { n: rule[1] ?? '' })} · ${t('rules.enabled')}` : t('rules.rule', { n: rule[1] ?? '' });
  const timer = /^Timer(\d{1,2})$/.exec(key);
  if (timer) return t('timers.timer', { n: timer[1] ?? '' });
  if (key === 'Timers') return t('timers.enabled');
  const label = `setting.${key}`;
  return label in de ? t(label as MessageKey) : key;
}
