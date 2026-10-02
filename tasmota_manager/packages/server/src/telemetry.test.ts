import { describe, expect, it } from 'vitest';
import { TelemetryStore } from './telemetry';

const SENSOR = {
  Time: '2026-10-02T12:00:00',
  AM2301: { Temperature: 21.3, Humidity: 48.2, DewPoint: 9.9 },
  ENERGY: { TotalStartTime: '2026-01-01T00:00:00', Total: 12.5, Power: [12.1, 0, 3.4], Voltage: 230 },
  ESP32: { Temperature: 44 },
  TempUnit: 'C',
};
const STATE = { Time: 'x', UptimeSec: 3600, Heap: 25, LoadAvg: 19, POWER: 'ON', Wifi: { RSSI: 80, Signal: -60, SSId: 'iot' } };

function store(start = 1_000_000) {
  let t = start;
  const s = new TelemetryStore(() => t);
  return { s, advance: (ms: number) => (t += ms) };
}

describe('TelemetryStore', () => {
  it('klopft SENSOR flach, vergibt Einheiten und lässt Chip-Temperatur und Zeitfelder weg', () => {
    const { s } = store();
    s.record('A', 'sensor', SENSOR);
    const byKey = Object.fromEntries(s.get('A').values.map((v) => [v.key, v]));
    expect(byKey['AM2301.Temperature']).toEqual({ key: 'AM2301.Temperature', group: 'AM2301', name: 'Temperature', value: 21.3, unit: '°C' });
    expect(byKey['AM2301.Humidity']?.unit).toBe('%');
    expect(byKey['ENERGY.Power.1']).toMatchObject({ value: 12.1, unit: 'W', name: 'Power 1' });
    expect(byKey['ENERGY.Power.3']).toMatchObject({ value: 3.4 });
    expect(byKey['ENERGY.Total']?.unit).toBe('kWh');
    expect(byKey['ENERGY.TotalStartTime']).toBeUndefined();
    expect(byKey['ESP32.Temperature']).toBeUndefined();
    expect(byKey.Time).toBeUndefined();
  });

  it('übernimmt STATE in die Gruppe „device“, Schaltzustände als Text ohne Verlauf', () => {
    const { s } = store();
    s.record('A', 'state', STATE);
    const t = s.get('A');
    const byKey = Object.fromEntries(t.values.map((v) => [v.key, v]));
    expect(byKey.UptimeSec).toMatchObject({ group: 'device', value: 3600, unit: 's' });
    expect(byKey['Wifi.Signal']).toMatchObject({ group: 'device', value: -60, unit: 'dBm' });
    expect(byKey['Wifi.RSSI']?.unit).toBe('%');
    expect(byKey.POWER).toMatchObject({ value: 'ON', unit: null });
    expect(byKey['Wifi.SSId']).toBeUndefined();
    expect(t.history.POWER).toBeUndefined();
  });

  it('nimmt Status-10/11-Antworten mit Hülle an', () => {
    const { s } = store();
    s.record('A', 'sensor', { StatusSNS: SENSOR });
    s.record('A', 'state', { StatusSTS: STATE });
    expect(s.get('A').values.some((v) => v.key === 'AM2301.Temperature')).toBe(true);
    expect(s.get('A').values.some((v) => v.key === 'UptimeSec')).toBe(true);
  });

  it('führt einen Verlauf: höchstens ein Punkt je 5 s, 60 Minuten, höchstens 720 Punkte', () => {
    const { s, advance } = store();
    s.record('A', 'sensor', { AM2301: { Temperature: 20 } });
    advance(2000);
    s.record('A', 'sensor', { AM2301: { Temperature: 21 } });
    advance(2000);
    s.record('A', 'sensor', { AM2301: { Temperature: 22 } });
    // Innerhalb von 5 s nach dem vorletzten Punkt ersetzt ein neuer Wert den letzten.
    expect(s.get('A').history['AM2301.Temperature']).toEqual([
      [1_000_000, 20],
      [1_004_000, 22],
    ]);
    for (let i = 0; i < 2000; i++) {
      advance(1000);
      s.record('A', 'sensor', { AM2301: { Temperature: i } });
    }
    const points = s.get('A').history['AM2301.Temperature'] ?? [];
    expect(points.length).toBeLessThanOrEqual(720);
    const newest = points.at(-1)?.[0] ?? 0;
    expect(points.every(([t]) => newest - t <= 60 * 60 * 1000)).toBe(true);
  });

  it('wählt bis zu zwei Hauptwerte in fester Rangfolge, nie aus „device“', () => {
    const { s } = store();
    s.record('A', 'sensor', SENSOR);
    s.record('A', 'state', STATE);
    expect(s.headline('A').map((v) => v.key)).toEqual(['ENERGY.Power.1', 'AM2301.Temperature']);
    s.record('B', 'state', STATE);
    expect(s.headline('B')).toEqual([]);
    s.record('C', 'sensor', { VL53L0X: { Distance: 120 } });
    expect(s.headline('C').map((v) => v.key)).toEqual(['VL53L0X.Distance']);
    expect(s.summary()).toMatchObject({ C: [{ key: 'VL53L0X.Distance', unit: 'mm' }] });
  });

  it('meldet Aktualisierungen und vergisst entfernte Geräte', () => {
    const { s } = store();
    const seen: string[] = [];
    s.on('updated', (id) => seen.push(id));
    s.record('A', 'sensor', { AM2301: { Temperature: 20 } });
    s.record('A', 'sensor', 'kaputt');
    expect(seen).toEqual(['A']);
    expect(s.get('A').updatedAt).toBe(new Date(1_000_000).toISOString());
    s.remove('A');
    expect(s.get('A')).toEqual({ updatedAt: null, values: [], history: {} });
  });
});
