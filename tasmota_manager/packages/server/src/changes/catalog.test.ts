import { settingDef } from '@tm/shared';
import { describe, expect, it } from 'vitest';
import { extractValue, parseRuleState, parseTimer, parseTimersEnabled, readCommand, valuesEqual } from './catalog';

const def = (key: string) => {
  const found = settingDef(key);
  if (!found) throw new Error(key);
  return found;
};

describe('readCommand', () => {
  it('nutzt den Befehl ohne Argument', () => {
    expect(readCommand(def('PowerOnState'))).toBe('PowerOnState');
    expect(readCommand(def('Rule2Enabled'))).toBe('Rule2');
  });
});

describe('extractValue', () => {
  it('liest Zahlen und Texte', () => {
    expect(extractValue(def('PowerOnState'), { PowerOnState: 3 })).toBe('3');
    expect(extractValue(def('MqttHost'), { MqttHost: 'broker' })).toBe('broker');
  });

  it('normalisiert Schalter auf 0/1, auch bei nummerierten Schlüsseln', () => {
    expect(extractValue(def('SetOption65'), { SetOption65: 'ON' })).toBe('1');
    expect(extractValue(def('LedPower'), { LedPower1: 'OFF' })).toBe('0');
    expect(extractValue(def('Timers'), { Timers: 'ON' })).toBe('1');
  });

  it('liest Rules und deren Zustand', () => {
    const response = { Rule1: { State: 'ON', Once: 'OFF', StopOnError: 'OFF', Length: 12, Free: 499, Rules: 'on x do y endon' } };
    expect(extractValue(def('Rule1'), response)).toBe('on x do y endon');
    expect(extractValue(def('Rule1Enabled'), response)).toBe('1');
  });

  it('liest Timer als normalisiertes JSON', () => {
    const response = { Timer2: { Enable: 1, Mode: 0, Time: '06:30', Window: 0, Days: '-MTWTF-', Repeat: 1, Output: 1, Action: 1 } };
    expect(JSON.parse(extractValue(def('Timer2'), response) ?? '')).toEqual({
      Enable: 1,
      Mode: 0,
      Time: '06:30',
      Window: 0,
      Days: '0111110',
      Repeat: 1,
      Output: 1,
      Action: 1,
    });
  });

  it('liefert null ohne passenden Schlüssel', () => {
    expect(extractValue(def('LedState'), { POWER: 'ON' })).toBeNull();
    expect(extractValue(def('LedState'), 'kaputt')).toBeNull();
  });
});

describe('valuesEqual', () => {
  it('vergleicht je nach Art', () => {
    expect(valuesEqual(def('Sleep'), '50', '50')).toBe(true);
    expect(valuesEqual(def('SysLog'), '2', '2 (Active 2)')).toBe(true);
    expect(valuesEqual(def('SetOption53'), '1', '1')).toBe(true);
    expect(valuesEqual(def('SetOption53'), '1', '0')).toBe(false);
    expect(valuesEqual(def('Latitude'), '48.137154', '48.13715')).toBe(true);
    expect(valuesEqual(def('Timezone'), '1', '1')).toBe(true);
    expect(valuesEqual(def('Timezone'), '+01:00', '+01:00')).toBe(true);
    expect(valuesEqual(def('Timezone'), '99', '+01:00')).toBe(false);
    expect(valuesEqual(def('Rule1'), 'ON x DO y ENDON', 'on  x do y endon')).toBe(true);
    expect(valuesEqual(def('LedState'), '1', null)).toBe(false);
  });

  it('vergleicht Timer unabhängig vom Tagesformat', () => {
    const a = JSON.stringify({ Enable: 1, Mode: 0, Time: '06:30', Window: 0, Days: '0111110', Repeat: 1, Output: 1, Action: 1 });
    const b = JSON.stringify({ Enable: 1, Mode: 0, Time: '06:30', Window: 0, Days: '-MTWTF-', Repeat: 1, Output: 1, Action: 1 });
    expect(valuesEqual(def('Timer1'), a, b)).toBe(true);
  });
});

describe('Rules und Timer lesen', () => {
  it('liest den Zustand einer Rule', () => {
    expect(parseRuleState(1, { Rule1: { State: 'OFF', Length: 3, Free: 508, Rules: 'abc' } })).toEqual({
      index: 1,
      enabled: false,
      text: 'abc',
      length: 3,
      free: 508,
    });
    expect(parseRuleState(2, {})).toEqual({ index: 2, enabled: false, text: '', length: 0, free: 511 });
  });

  it('liest Timer und den globalen Schalter', () => {
    expect(parseTimer(1, { Timer1: { Enable: 1, Days: '1111111' } }).Days).toBe('1111111');
    expect(parseTimer(1, {}).Enable).toBe(0);
    expect(parseTimersEnabled({ Timers: 'ON' })).toBe(true);
    expect(parseTimersEnabled({ Timers: 'OFF' })).toBe(false);
  });
});
