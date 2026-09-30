import type { Language } from '@tm/shared';
import { isObj } from './tasmota/parse';

const GENERIC = /^tasmota[_-][0-9a-f]{4,6}$/i;
const MAX_NAME = 32;

const rec = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});

export function isGenericName(name: string, module: string | null, hostname: string | null): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return (
    lower === 'tasmota' ||
    GENERIC.test(trimmed) ||
    (module !== null && lower === module.toLowerCase()) ||
    (hostname !== null && lower === hostname.toLowerCase())
  );
}

export function relayCount(status0: unknown): number {
  return Object.keys(rec(rec(status0).StatusSTS)).filter((k) => /^POWER\d*$/.test(k)).length;
}

function hasClimateSensor(sns: Record<string, unknown>): boolean {
  return Object.entries(sns).some(
    ([key, value]) => {
      // Ignore internal chip temperature (ESP32, ESP32-S2, etc.) and ENERGY blocks
      if (/^ESP32/i.test(key) || key === 'ENERGY') return false;
      // Top-level Temperature/Humidity keys count
      if (key === 'Temperature' || key === 'Humidity') return true;
      // Temperature/Humidity in other sensor blocks (e.g., DS18B20)
      return isObj(value) && ('Temperature' in value || 'Humidity' in value);
    },
  );
}

function isLight(status0: unknown, module: string | null): boolean {
  const sts = rec(rec(status0).StatusSTS);
  return 'Dimmer' in sts || 'Color' in sts || 'CT' in sts || (module !== null && /dimmer|bulb|light|led|rgb/i.test(module));
}

interface TypeWords {
  climate: string;
  plug: string;
  energyMeter: string;
  light: string;
  switch: string;
  multiSwitch: (relays: number) => string;
}

// Ohne Apostrophe und Sonderzeichen, die in Tasmota-Namen oder MQTT-Topics stören könnten.
const TYPE_WORDS: Record<Language, TypeWords> = {
  en: { climate: 'Climate', plug: 'Plug', energyMeter: 'Energy meter', light: 'Light', switch: 'Switch', multiSwitch: (n) => `Switch ${n}-gang` },
  de: { climate: 'Klima', plug: 'Steckdose', energyMeter: 'Energiezähler', light: 'Licht', switch: 'Schalter', multiSwitch: (n) => `Schalter ${n}-fach` },
  fr: { climate: 'Climat', plug: 'Prise', energyMeter: 'Compteur énergie', light: 'Lumière', switch: 'Interrupteur', multiSwitch: (n) => `Interrupteur ${n} voies` },
  es: { climate: 'Clima', plug: 'Enchufe', energyMeter: 'Medidor de energía', light: 'Luz', switch: 'Interruptor', multiSwitch: (n) => `Interruptor ${n} canales` },
  it: { climate: 'Clima', plug: 'Presa', energyMeter: 'Contatore energia', light: 'Luce', switch: 'Interruttore', multiSwitch: (n) => `Interruttore ${n} canali` },
  nl: { climate: 'Klimaat', plug: 'Stekker', energyMeter: 'Energiemeter', light: 'Lamp', switch: 'Schakelaar', multiSwitch: (n) => `Schakelaar ${n}-voudig` },
};

/** Gerätetyp aus Sensoren (Status 10), Relais und Modul; erste passende Regel gewinnt. */
export function deviceType(status0: unknown, sensors: unknown, module: string | null, language: Language = 'en'): string | null {
  const words = TYPE_WORDS[language];
  const sns = rec(rec(sensors).StatusSNS);
  const relays = relayCount(status0);
  if (hasClimateSensor(sns)) return words.climate;
  if ('ENERGY' in sns) return relays > 0 ? words.plug : words.energyMeter;
  if (isLight(status0, module)) return words.light;
  if (relays === 1) return words.switch;
  if (relays > 1) return words.multiSwitch(relays);
  return null;
}

export interface NamingInput {
  id: string;
  /** Aktueller bzw. bereits vorgemerkter Name */
  name: string;
  hostname: string | null;
  module: string | null;
  status: unknown;
  sensors: unknown;
  areaName: string | null;
}

export function suggestNames(inputs: readonly NamingInput[], language: Language = 'en'): Map<string, string> {
  const generic = (d: NamingInput) => isGenericName(d.name, d.module, d.hostname);
  const taken = new Set(inputs.filter((d) => !generic(d)).map((d) => d.name.trim().toLowerCase()));
  const result = new Map<string, string>();
  for (const device of [...inputs].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!generic(device)) continue;
    const type = deviceType(device.status, device.sensors, device.module, language);
    if (!type) continue;
    // Platz für die Nummerierung lassen; Tasmota erlaubt höchstens 32 Zeichen.
    const base = (device.areaName ? `${type} ${device.areaName}` : type).slice(0, MAX_NAME - 3).trim();
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} ${n}`;
    taken.add(candidate.toLowerCase());
    result.set(device.id, candidate);
  }
  return result;
}
