import { describe, expect, it } from 'vitest';
import { buildFastRule } from './fastRule';

const sns = (blocks: Record<string, unknown>) => ({ StatusSNS: { Time: '2026-10-01T12:00:00', TempUnit: 'C', ...blocks } });

describe('buildFastRule', () => {
  it('erzeugt einen Auslöser pro Sensorblock mit dessen erstem Messwert', () => {
    expect(buildFastRule(sns({ AM2301: { Temperature: 21, Humidity: 40 }, VL53L0X: { Distance: 120 } }))).toEqual({
      rule: 'ON AM2301#Temperature DO TelePeriod 1 ENDON ON VL53L0X#Distance DO TelePeriod 1 ENDON',
      included: ['AM2301', 'VL53L0X'],
      omitted: [],
    });
  });
  it('lässt ENERGY und Chip-Temperaturen aus', () => {
    expect(buildFastRule(sns({ ENERGY: { Power: 5 }, ESP32: { Temperature: 40 }, DS18B20: { Temperature: 20 } }))).toEqual({
      rule: 'ON DS18B20#Temperature DO TelePeriod 1 ENDON',
      included: ['DS18B20'],
      omitted: ['ENERGY', 'ESP32'],
    });
  });
  it('liefert ohne passende Sensoren keine Regel', () => {
    expect(buildFastRule(sns({ ENERGY: { Power: 5 } })).rule).toBeNull();
    expect(buildFastRule(undefined).rule).toBeNull();
  });
  it('hält die Grenze von 511 Zeichen ein', () => {
    const blocks = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`DS18B20-${i + 1}`, { Temperature: 20 }]));
    const result = buildFastRule(sns(blocks));
    expect(result.rule?.length).toBeLessThanOrEqual(511);
    expect(result.included.length + result.omitted.length).toBe(20);
    expect(result.omitted.length).toBeGreaterThan(0);
  });
});
