import { DEFAULT_TIMER } from '@tm/shared';
import { describe, expect, it } from 'vitest';
import { liveKind, liveValue } from './liveValue';

describe('liveValue', () => {
  it('ordnet Schlüssel Rules oder Timern zu', () => {
    expect(liveKind('Rule2')).toBe('rules');
    expect(liveKind('Rule2Enabled')).toBe('rules');
    expect(liveKind('Timer16')).toBe('timers');
    expect(liveKind('Timers')).toBe('timers');
    expect(liveKind('LedState')).toBeNull();
  });

  it('liest den passenden aktuellen Wert', () => {
    const rules = [1, 2, 3].map((index) => ({ index, enabled: index === 2, text: `rule ${index}`, length: 6, free: 505 }));
    expect(liveValue('Rule2', rules)).toBe('rule 2');
    expect(liveValue('Rule2Enabled', rules)).toBe('1');
    const timers = { enabled: false, timers: Array.from({ length: 16 }, () => DEFAULT_TIMER) };
    expect(liveValue('Timers', timers)).toBe('0');
    expect(JSON.parse(liveValue('Timer3', timers) ?? '')).toEqual(DEFAULT_TIMER);
  });
});
