import { describe, expect, it } from 'vitest';
import { type NamingInput, deviceType, isGenericName, relayCount, suggestNames } from './naming';

const status = (sts: Record<string, unknown>) => ({ StatusSTS: sts });
const sensors = (sns: Record<string, unknown>) => ({ StatusSNS: sns });

describe('isGenericName', () => {
  it('erkennt generische Namen', () => {
    expect(isGenericName('Tasmota', null, null)).toBe(true);
    expect(isGenericName('tasmota_A1B2C3', null, null)).toBe(true);
    expect(isGenericName('', null, null)).toBe(true);
    expect(isGenericName('Sonoff Basic', 'Sonoff Basic', null)).toBe(true);
    expect(isGenericName('keller-1234', null, 'keller-1234')).toBe(true);
    expect(isGenericName('Keller Licht', 'Sonoff Basic', 'keller-1234')).toBe(false);
  });
});

describe('deviceType', () => {
  it('leitet den Typ aus Sensoren und Relais ab', () => {
    expect(relayCount(status({ POWER1: 'ON', POWER2: 'OFF', UptimeSec: 1 }))).toBe(2);
    expect(deviceType(status({ POWER: 'ON' }), sensors({ AM2301: { Temperature: 21, Humidity: 40 } }), null, 'de')).toBe('Klima');
    expect(deviceType(status({ POWER: 'ON' }), sensors({ ENERGY: { Power: 5 } }), null, 'de')).toBe('Steckdose');
    expect(deviceType(status({}), sensors({ ENERGY: { Power: 5 } }), null, 'de')).toBe('Energiezähler');
    expect(deviceType(status({ POWER: 'ON', Dimmer: 40 }), sensors({}), null, 'de')).toBe('Licht');
    expect(deviceType(status({ POWER: 'ON' }), sensors({}), 'Sonoff Basic', 'de')).toBe('Schalter');
    expect(deviceType(status({ POWER1: 'ON', POWER2: 'ON', POWER3: 'ON', POWER4: 'ON' }), sensors({}), null, 'de')).toBe('Schalter 4-fach');
    expect(deviceType(status({}), sensors({}), null, 'de')).toBeNull();
    expect(deviceType(status({ POWER: 'ON' }), sensors({ ESP32: { Temperature: 40.1 } }), null, 'de')).toBe('Schalter');
    expect(deviceType(status({ POWER: 'ON' }), sensors({ ESP32: { Temperature: 40 }, ENERGY: { Power: 5, Temperature: 30 } }), null, 'de')).toBe('Steckdose');
    expect(deviceType(status({ POWER: 'ON' }), sensors({ ESP32: { Temperature: 40 }, DS18B20: { Temperature: 21 } }), null, 'de')).toBe('Klima');
  });
});

describe('suggestNames', () => {
  const input = (partial: Partial<NamingInput> & { id: string }): NamingInput => ({
    name: 'Tasmota',
    hostname: null,
    module: null,
    status: status({ POWER: 'ON' }),
    sensors: sensors({}),
    areaName: null,
    ...partial,
  });

  it('kombiniert Typ und Bereich und nummeriert Kollisionen', () => {
    const result = suggestNames([
      input({ id: 'A', areaName: 'Küche', sensors: sensors({ ENERGY: {} }) }),
      input({ id: 'B', areaName: 'Küche', sensors: sensors({ ENERGY: {} }) }),
      input({ id: 'C', name: 'Steckdose Bad' }),
      input({ id: 'D', areaName: 'Bad', sensors: sensors({ ENERGY: {} }) }),
      input({ id: 'E' }),
    ], 'de');
    expect(result.get('A')).toBe('Steckdose Küche');
    expect(result.get('B')).toBe('Steckdose Küche 2');
    expect(result.has('C')).toBe(false);
    expect(result.get('D')).toBe('Steckdose Bad 2');
    expect(result.get('E')).toBe('Schalter');
  });

  it('nutzt die Typwörter der gewählten Sprache, Englisch als Standard', () => {
    const plug = [input({ id: 'A', areaName: 'Kitchen', sensors: sensors({ ENERGY: {} }) })];
    expect(suggestNames(plug).get('A')).toBe('Plug Kitchen');
    expect(suggestNames(plug, 'fr').get('A')).toBe('Prise Kitchen');
    expect(suggestNames([input({ id: 'B', status: status({ POWER1: 'ON', POWER2: 'OFF' }) })], 'nl').get('B')).toBe('Schakelaar 2-voudig');
  });
});
