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
    expect(deviceType(status({ POWER: 'ON' }), sensors({ AM2301: { Temperature: 21, Humidity: 40 } }), null)).toBe('Klima');
    expect(deviceType(status({ POWER: 'ON' }), sensors({ ENERGY: { Power: 5 } }), null)).toBe('Steckdose');
    expect(deviceType(status({}), sensors({ ENERGY: { Power: 5 } }), null)).toBe('Energiezähler');
    expect(deviceType(status({ POWER: 'ON', Dimmer: 40 }), sensors({}), null)).toBe('Licht');
    expect(deviceType(status({ POWER: 'ON' }), sensors({}), 'Sonoff Basic')).toBe('Schalter');
    expect(deviceType(status({ POWER1: 'ON', POWER2: 'ON', POWER3: 'ON', POWER4: 'ON' }), sensors({}), null)).toBe('Schalter 4-fach');
    expect(deviceType(status({}), sensors({}), null)).toBeNull();
    expect(deviceType(status({ POWER: 'ON' }), sensors({ ESP32: { Temperature: 40.1 } }), null)).toBe('Schalter');
    expect(deviceType(status({ POWER: 'ON' }), sensors({ ESP32: { Temperature: 40 }, ENERGY: { Power: 5, Temperature: 30 } }), null)).toBe('Steckdose');
    expect(deviceType(status({ POWER: 'ON' }), sensors({ ESP32: { Temperature: 40 }, DS18B20: { Temperature: 21 } }), null)).toBe('Klima');
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
    ]);
    expect(result.get('A')).toBe('Steckdose Küche');
    expect(result.get('B')).toBe('Steckdose Küche 2');
    expect(result.has('C')).toBe(false);
    expect(result.get('D')).toBe('Steckdose Bad 2');
    expect(result.get('E')).toBe('Schalter');
  });
});
