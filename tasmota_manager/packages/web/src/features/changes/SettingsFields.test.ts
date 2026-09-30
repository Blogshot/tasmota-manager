import { SETTINGS } from '@tm/shared';
import { describe, expect, it } from 'vitest';
import { collectSettings } from './SettingsFields';

describe('collectSettings', () => {
  it('übernimmt nur ausgefüllte Felder und meldet ungültige', () => {
    const defs = SETTINGS.filter((d) => d.batch);
    const { settings, errors } = collectSettings(defs, { PowerOnState: '1', Sleep: '', TelePeriod: '5', LedPower: '0' });
    expect(settings).toEqual({ PowerOnState: '1', LedPower: '0' });
    expect(Object.keys(errors)).toEqual(['TelePeriod']);
  });
});
