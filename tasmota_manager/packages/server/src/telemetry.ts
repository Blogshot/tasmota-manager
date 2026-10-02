import { EventEmitter } from 'node:events';
import type { DeviceTelemetry, TelemetrySummary, TelemetryValue } from '@tm/shared';
import { isObj } from './tasmota/parse';

const HOUR_MS = 60 * 60 * 1000;
const MIN_STEP_MS = 5000;
const MAX_POINTS = 720;
const SKIPPED = new Set(['Time', 'TempUnit', 'PressureUnit', 'SpeedUnit']);
const STATE_NUMBERS = new Set(['UptimeSec', 'Heap', 'LoadAvg', 'Sleep']);

const FIXED_UNITS: Record<string, string> = {
  Humidity: '%',
  Power: 'W',
  ApparentPower: 'VA',
  ReactivePower: 'var',
  Voltage: 'V',
  Current: 'A',
  Total: 'kWh',
  Today: 'kWh',
  Yesterday: 'kWh',
  Frequency: 'Hz',
  Illuminance: 'lx',
  Distance: 'mm',
  CO2: 'ppm',
  eCO2: 'ppm',
  TVOC: 'ppb',
  UptimeSec: 's',
  Heap: 'kB',
};

interface DeviceData {
  updatedAt: number | null;
  values: Map<string, TelemetryValue>;
  history: Map<string, Array<[number, number]>>;
  units: { temp: string; pressure: string };
}

function unitFor(key: string, name: string, units: DeviceData['units']): string | null {
  if (key === 'Wifi.Signal') return 'dBm';
  if (key === 'Wifi.RSSI') return '%';
  if (name === 'Temperature' || name === 'DewPoint') return `°${units.temp}`;
  if (name === 'Pressure' || name === 'SeaPressure') return units.pressure;
  return FIXED_UNITS[name] ?? null;
}

/** Telemetrie aller Geräte im Arbeitsspeicher: letzte Werte und Verlauf der letzten Stunde. */
export class TelemetryStore extends EventEmitter<{ updated: [deviceId: string] }> {
  private readonly devices = new Map<string, DeviceData>();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  record(deviceId: string, source: 'sensor' | 'state', payload: unknown): void {
    if (!isObj(payload)) return;
    const body = source === 'sensor' ? (isObj(payload.StatusSNS) ? payload.StatusSNS : payload) : isObj(payload.StatusSTS) ? payload.StatusSTS : payload;
    const data = this.data(deviceId);
    if (typeof body.TempUnit === 'string') data.units.temp = body.TempUnit;
    if (typeof body.PressureUnit === 'string') data.units.pressure = body.PressureUnit;
    const at = this.now();
    const found = source === 'sensor' ? this.flattenSensor(body) : this.flattenState(body);
    if (found.length === 0) return;
    for (const { key, group, name, value } of found) {
      data.values.set(key, { key, group, name, value, unit: typeof value === 'number' ? unitFor(key, name.replace(/ \d+$/, ''), data.units) : null });
      if (typeof value === 'number') this.push(data, key, at, value);
    }
    data.updatedAt = at;
    this.emit('updated', deviceId);
  }

  get(deviceId: string): DeviceTelemetry {
    const data = this.devices.get(deviceId);
    if (!data) return { updatedAt: null, values: [], history: {} };
    return {
      updatedAt: data.updatedAt === null ? null : new Date(data.updatedAt).toISOString(),
      values: [...data.values.values()],
      history: Object.fromEntries([...data.history.entries()].map(([k, v]) => [k, [...v]])),
    };
  }

  headline(deviceId: string): TelemetryValue[] {
    const values = [...(this.devices.get(deviceId)?.values.values() ?? [])].filter(
      (v): v is TelemetryValue & { value: number } => v.group !== 'device' && typeof v.value === 'number',
    );
    const picks: TelemetryValue[] = [];
    const take = (match: (v: TelemetryValue) => boolean) => {
      const found = values.find((v) => match(v) && !picks.includes(v));
      if (found && picks.length < 2) picks.push(found);
    };
    take((v) => v.group === 'ENERGY' && v.name.startsWith('Power') && (v.key === 'ENERGY.Power' || v.key === 'ENERGY.Power.1'));
    take((v) => v.name === 'Temperature');
    take((v) => v.name === 'Humidity');
    take(() => true);
    return picks;
  }

  summary(): TelemetrySummary {
    return Object.fromEntries([...this.devices.keys()].map((id) => [id, this.headline(id)]).filter(([, v]) => v.length > 0));
  }

  remove(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  private data(deviceId: string): DeviceData {
    let data = this.devices.get(deviceId);
    if (!data) {
      data = { updatedAt: null, values: new Map(), history: new Map(), units: { temp: 'C', pressure: 'hPa' } };
      this.devices.set(deviceId, data);
    }
    return data;
  }

  private push(data: DeviceData, key: string, at: number, value: number): void {
    const points = data.history.get(key) ?? [];
    // Der letzte Punkt ist „live“: Er wird ersetzt, solange er selbst noch keine 5 s vom vorletzten entfernt ist.
    // So liegen abgelegte Punkte mindestens 5 s auseinander, und 720 Punkte decken eine Stunde ab.
    const previous = points.at(-2);
    const last = points.at(-1);
    if (previous && last && last[0] - previous[0] < MIN_STEP_MS) points[points.length - 1] = [at, value];
    else points.push([at, value]);
    while (points.length > 0 && (at - (points[0]?.[0] ?? at) > HOUR_MS || points.length > MAX_POINTS)) points.shift();
    data.history.set(key, points);
  }

  private flattenSensor(body: Record<string, unknown>) {
    const out: Array<{ key: string; group: string; name: string; value: number | string }> = [];
    for (const [block, fields] of Object.entries(body)) {
      if (SKIPPED.has(block) || /^ESP32/i.test(block) || !isObj(fields)) continue;
      for (const [name, value] of Object.entries(fields)) {
        if (typeof value === 'number') out.push({ key: `${block}.${name}`, group: block, name, value });
        else if (Array.isArray(value)) {
          value.forEach((v, i) => {
            if (typeof v === 'number') out.push({ key: `${block}.${name}.${i + 1}`, group: block, name: `${name} ${i + 1}`, value: v });
          });
        }
      }
    }
    return out;
  }

  private flattenState(body: Record<string, unknown>) {
    const out: Array<{ key: string; group: string; name: string; value: number | string }> = [];
    for (const [name, value] of Object.entries(body)) {
      if (STATE_NUMBERS.has(name) && typeof value === 'number') out.push({ key: name, group: 'device', name, value });
      else if (/^POWER\d*$/.test(name) && typeof value === 'string') out.push({ key: name, group: 'device', name, value });
    }
    const wifi = body.Wifi;
    if (isObj(wifi)) {
      for (const name of ['Signal', 'RSSI']) {
        const value = wifi[name];
        if (typeof value === 'number') out.push({ key: `Wifi.${name}`, group: 'device', name: `Wifi ${name}`, value });
      }
    }
    return out;
  }
}
