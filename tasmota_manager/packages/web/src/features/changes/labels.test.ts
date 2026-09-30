import { describe, expect, it } from 'vitest';
import { formatMessage } from '@/lib/i18n';
import { de, type MessageKey } from '@/lib/messages';
import { settingLabel } from './labels';

const t = (key: MessageKey, vars?: Record<string, string | number>) => formatMessage(de[key], vars);

describe('settingLabel', () => {
  it('beschriftet Katalog-, Rule- und Timer-Einträge', () => {
    expect(settingLabel(t, 'PowerOnState')).toBe('Zustand nach Stromausfall');
    expect(settingLabel(t, 'Rule2')).toBe('Rule 2');
    expect(settingLabel(t, 'Rule2Enabled')).toBe('Rule 2 · Aktiv');
    expect(settingLabel(t, 'Timer12')).toBe('Timer 12');
    expect(settingLabel(t, 'Timers')).toBe('Timer global aktiv');
    expect(settingLabel(t, 'Unbekannt')).toBe('Unbekannt');
  });
});
