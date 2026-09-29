import { describe, expect, it } from 'vitest';
import {
  CidrSchema,
  SETTINGS,
  StageRequestSchema,
  TimerSchema,
  commandFor,
  normalizeDays,
  normalizeTimer,
  readFromStatus,
  renderPlaceholders,
  settingDef,
} from './index';

const def = (key: string) => {
  const found = settingDef(key);
  if (!found) throw new Error(`fehlt: ${key}`);
  return found;
};

describe('Einstellungskatalog', () => {
  it('enthält jeden Schlüssel genau einmal', () => {
    const keys = SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('validiert Werte je Einstellung', () => {
    expect(def('PowerOnState').schema.safeParse('3').success).toBe(true);
    expect(def('PowerOnState').schema.safeParse('6').success).toBe(false);
    expect(def('SetOption65').schema.safeParse('1').success).toBe(true);
    expect(def('SetOption65').schema.safeParse('ON').success).toBe(false);
    expect(def('Latitude').schema.safeParse('48.137154').success).toBe(true);
    expect(def('Latitude').schema.safeParse('91').success).toBe(false);
    expect(def('Timezone').schema.safeParse('+01:00').success).toBe(true);
    expect(def('Timezone').schema.safeParse('99').success).toBe(true);
    expect(def('Timezone').schema.safeParse('Europe/Berlin').success).toBe(false);
    expect(def('DeviceName').schema.safeParse('').success).toBe(false);
  });

  it('lehnt Semikolons in MQTT-Werten ab, weil sie im Backlog landen', () => {
    expect(def('MqttHost').schema.safeParse('broker;Reset 1').success).toBe(false);
    expect(def('MqttPassword').schema.safeParse('a;b').success).toBe(false);
  });

  it('markiert nur die MQTT-Gruppe als neustartend und das Passwort als write-only', () => {
    expect(SETTINGS.filter((s) => s.restarts).map((s) => s.key)).toEqual(['MqttHost', 'MqttPort', 'MqttUser', 'MqttPassword']);
    expect(SETTINGS.filter((s) => s.writeOnly).map((s) => s.key)).toEqual(['MqttPassword']);
  });

  it('bietet Namen, Rules und Timer nicht im Batch-Formular an', () => {
    const batch = SETTINGS.filter((s) => s.batch).map((s) => s.key);
    expect(batch).toContain('PowerOnState');
    expect(batch).not.toContain('DeviceName');
    expect(batch).not.toContain('Rule1');
    expect(batch).not.toContain('Timer1');
  });

  it('bildet Befehle', () => {
    expect(commandFor(def('PowerOnState'), '3')).toBe('PowerOnState 3');
    expect(commandFor(def('Rule1Enabled'), '1')).toBe('Rule1 1');
    expect(commandFor(def('Rule2'), '')).toBe('Rule2 ""');
  });

  it('liest bekannte Werte aus Status 0', () => {
    const status = {
      Status: { DeviceName: 'Keller', FriendlyName: ['Licht'], PowerOnState: 3, LedState: 1 },
      StatusPRM: { Sleep: 50 },
      StatusLOG: { SysLog: 0, LogHost: '', TelePeriod: 300 },
      StatusMQT: { MqttHost: 'broker', MqttPort: 1883, MqttUser: 'DVES_USER' },
    };
    expect(readFromStatus('DeviceName', status)).toBe('Keller');
    expect(readFromStatus('FriendlyName1', status)).toBe('Licht');
    expect(readFromStatus('PowerOnState', status)).toBe('3');
    expect(readFromStatus('Sleep', status)).toBe('50');
    expect(readFromStatus('LogHost', status)).toBe('');
    expect(readFromStatus('MqttPort', status)).toBe('1883');
    expect(readFromStatus('Latitude', status)).toBeNull();
    expect(readFromStatus('DeviceName', null)).toBeNull();
  });

  it('schützt vor Prototyp-Schlüsseln beim Lesen', () => {
    expect(readFromStatus('constructor', {})).toBeNull();
  });
});

describe('Timer', () => {
  it('normalisiert Tage und Felder', () => {
    expect(normalizeDays('-MTWTF-')).toBe('0111110');
    expect(normalizeDays('1111111')).toBe('1111111');
    expect(normalizeDays(undefined)).toBe('0000000');
    expect(normalizeTimer({ Enable: '1', Mode: 2, Time: '-00:30', Days: 'SMTWTFS', Output: 2, Action: 1 })).toEqual({
      Enable: 1,
      Mode: 2,
      Time: '-00:30',
      Window: 0,
      Days: '1111111',
      Repeat: 0,
      Output: 2,
      Action: 1,
    });
  });

  it('prüft Timer-JSON im Katalog', () => {
    const timer = { Enable: 1, Mode: 0, Time: '06:30', Window: 0, Days: '0111110', Repeat: 1, Output: 1, Action: 1 };
    expect(def('Timer3').schema.safeParse(JSON.stringify(timer)).success).toBe(true);
    expect(def('Timer3').schema.safeParse('{"Enable":1}').success).toBe(false);
    expect(def('Timer3').schema.safeParse('kein json').success).toBe(false);
    expect(TimerSchema.safeParse({ ...timer, Time: '25:00' }).success).toBe(false);
  });

  it('begrenzt Rules auf 511 Zeichen', () => {
    expect(def('Rule1').schema.safeParse('x'.repeat(511)).success).toBe(true);
    expect(def('Rule1').schema.safeParse('x'.repeat(512)).success).toBe(false);
  });
});

describe('Platzhalter', () => {
  const device = { id: 'AABBCC112233', name: 'Keller', hostname: 'keller-1', mqttTopic: 'keller', ip: '10.0.0.5' };

  it('ersetzt bekannte Platzhalter', () => {
    expect(renderPlaceholders('FriendlyName1 {{name}}-{{mac6}} {{ ip }}', device)).toEqual({
      ok: true,
      value: 'FriendlyName1 Keller-112233 10.0.0.5',
    });
  });

  it('meldet unbekannte Platzhalter', () => {
    expect(renderPlaceholders('X {{foo}}', device)).toEqual({ ok: false, unknown: 'foo' });
  });

  it('schützt vor Prototyp-Schlüsseln', () => {
    expect(renderPlaceholders('X {{constructor}}', device)).toEqual({ ok: false, unknown: 'constructor' });
  });
});

describe('Requests', () => {
  it('verlangt Einstellungen oder Befehle beim Vormerken', () => {
    expect(StageRequestSchema.safeParse({ deviceIds: ['A'], source: 'form' }).success).toBe(false);
    expect(StageRequestSchema.safeParse({ deviceIds: ['A'], settings: { LedState: '1' }, source: 'form' }).success).toBe(true);
    expect(StageRequestSchema.safeParse({ deviceIds: ['A'], commands: ['Power ON'], source: 'command' }).success).toBe(true);
  });

  it('erklärt abgelehnte Scan-Bereiche', () => {
    const result = CidrSchema.safeParse('10.0.0.0/16');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('/20');
  });
});
