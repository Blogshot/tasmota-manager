import type { HaSuggestions } from '@tm/shared';
import { tasmotaTimezone } from './timezone';

export interface HaSuggestionInput {
  timeZone: string | null;
  country: string | null;
  fahrenheit: boolean | null;
  mqttOnHa: boolean;
  mqttPort: number | null;
  hostIp: string | null;
  deviceMqttUsers: string[];
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return best && best[1] >= 2 ? best[0] : null;
}

/** Leitet Einstellungsvorschläge aus HA-Konfiguration, Broker-Lage und den Geräten ab. Nie mit Zugangsdaten. */
export function buildHaSuggestions(input: HaSuggestionInput): HaSuggestions {
  const tz = input.timeZone ? tasmotaTimezone(input.timeZone) : null;
  return {
    timezone: tz && input.timeZone ? { zone: input.timeZone, ...tz } : null,
    ntpServer: input.country && /^[A-Za-z]{2}$/.test(input.country) ? `${input.country.toLowerCase()}.pool.ntp.org` : 'pool.ntp.org',
    mqtt: input.mqttOnHa && input.hostIp && input.mqttPort ? { host: input.hostIp, port: input.mqttPort } : null,
    mqttUser: mostCommon(input.deviceMqttUsers),
    fahrenheit: input.fahrenheit,
  };
}
