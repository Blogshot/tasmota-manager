import { type HaSuggestions, readFromStatus } from '@tm/shared';
import type { MqttConfig } from './config';
import type { DeviceRegistry } from './registry';
import { tasmotaTimezone } from './timezone';

/** Werksvorgabe der Tasmota-Firmware; als Benutzername nie ein sinnvoller Vorschlag. */
const FIRMWARE_DEFAULT_MQTT_USER = 'DVES_USER';

export interface HaSuggestionInput {
  timeZone: string | null;
  country: string | null;
  fahrenheit: boolean | null;
  mqttOnHa: boolean;
  mqttPort: number | null;
  /** Der Broker verlangt TLS (`mqtts:`); Standard-Tasmota-Builds können das nicht. */
  mqttTls?: boolean;
  /** Benutzer des MQTT-Dienstes selbst; gehört dem Dienst, nicht den Geräten. */
  mqttServiceUser?: string | null;
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
    mqtt: input.mqttOnHa && !input.mqttTls && input.hostIp && input.mqttPort ? { host: input.hostIp, port: input.mqttPort } : null,
    mqttUser: mostCommon(input.deviceMqttUsers.filter((u) => u !== FIRMWARE_DEFAULT_MQTT_USER && u !== input.mqttServiceUser)),
    fahrenheit: input.fahrenheit,
  };
}

export interface HaSuggestionsDeps {
  ha: { config: { timeZone: string | null; country: string | null; fahrenheit: boolean | null } } | null;
  mqtt: MqttConfig | null;
  registry: Pick<DeviceRegistry, 'listRaw'>;
  hostIp: string | null;
  log: { warn: (obj: object, msg: string) => void };
}

/** Verbindet HA-Konfiguration, MQTT-Dienst und Geräte zur Vorschlagsquelle des Servers. */
export function haSuggestionsFrom({ ha, mqtt, registry, hostIp, log }: HaSuggestionsDeps): () => HaSuggestions {
  const warnedZones = new Set<string>();
  return () => {
    const config = ha?.config ?? { timeZone: null, country: null, fahrenheit: null };
    const suggestions = buildHaSuggestions({
      ...config,
      mqttOnHa: mqtt?.onHa ?? false,
      mqttPort: mqtt ? Number(new URL(mqtt.url).port || 1883) : null,
      mqttTls: mqtt ? new URL(mqtt.url).protocol === 'mqtts:' : false,
      mqttServiceUser: mqtt?.username ?? null,
      hostIp,
      deviceMqttUsers: registry
        .listRaw()
        .map((r) => readFromStatus('MqttUser', r.statusJson))
        .filter((u): u is string => u !== null),
    });
    if (config.timeZone && !suggestions.timezone && !warnedZones.has(config.timeZone)) {
      warnedZones.add(config.timeZone);
      log.warn({ zone: config.timeZone }, 'Zeitzone von Home Assistant lässt sich nicht in Tasmota-Regeln umrechnen, kein Vorschlag');
    }
    return suggestions;
  };
}
