import type { Capability } from '@tm/shared';
import { isObj } from './tasmota/parse';

const rec = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});

export function relayCount(status0: unknown): number {
  return Object.keys(rec(rec(status0).StatusSTS)).filter((k) => /^POWER\d*$/.test(k)).length;
}

export function hasClimateSensor(sns: Record<string, unknown>): boolean {
  return Object.entries(sns).some(([key, value]) => {
    // Interne Chip-Temperatur (ESP32 …) und ENERGY-Blöcke zählen nicht.
    if (/^ESP32/i.test(key) || key === 'ENERGY') return false;
    if (key === 'Temperature' || key === 'Humidity') return true;
    return isObj(value) && ('Temperature' in value || 'Humidity' in value);
  });
}

export function isLight(status0: unknown, module: string | null): boolean {
  const sts = rec(rec(status0).StatusSTS);
  return 'Dimmer' in sts || 'Color' in sts || 'CT' in sts || (module !== null && /dimmer|bulb|light|led|rgb/i.test(module));
}

/** Fähigkeiten eines Geräts aus gespeichertem Status 0 und Status 10. */
export function capabilitiesOf(status0: unknown, sensors: unknown, module: string | null): Capability[] {
  const sns = rec(rec(sensors).StatusSNS);
  const relays = relayCount(status0);
  const result: Capability[] = [];
  if ('ENERGY' in sns) result.push('energy');
  if (isLight(status0, module)) result.push('light');
  if (relays > 0) result.push('relay');
  if (relays > 1) result.push('multiRelay');
  if (hasClimateSensor(sns)) result.push('climate');
  return result;
}
