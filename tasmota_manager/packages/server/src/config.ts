import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { intToIp, parseCidr } from '@tm/shared';

export interface MqttConfig {
  url: string;
  username?: string;
  password?: string;
  /** true, wenn der Broker vom Supervisor-Dienst (also von HA) kommt. */
  onHa?: boolean;
}

export interface HaConfig {
  url: string;
  token: string;
}

export interface AppConfig {
  dataDir: string;
  port: number;
  logLevel: string;
  mqtt: MqttConfig | null;
  /** true unter dem Supervisor: nur Anfragen über den Ingress-Proxy zulassen. */
  ingressOnly: boolean;
  /** Zugang zur Home-Assistant-API (optional). */
  ha?: HaConfig | null;
  /** Grund, warum der MQTT-Dienst des Supervisors nicht ermittelt werden konnte. */
  mqttLookupError?: string;
}

interface AddonOptions {
  log_level?: string;
  mqtt_host?: string;
  mqtt_port?: number;
  mqtt_username?: string;
  mqtt_password?: string;
}

interface SupervisorMqttService {
  data?: { host?: string; port?: number; ssl?: boolean; username?: string; password?: string };
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<AppConfig> {
  const dataDir = env.TM_DATA_DIR ?? '/data';
  const options = readOptions(join(dataDir, 'options.json'));
  const { mqtt, lookupError } = await resolveMqtt(options, env, fetchFn);
  return {
    dataDir,
    port: Number(env.TM_PORT ?? 8099),
    logLevel: options.log_level ?? env.TM_LOG_LEVEL ?? 'info',
    mqtt,
    ingressOnly: Boolean(env.SUPERVISOR_TOKEN),
    ha: resolveHa(env),
    ...(lookupError ? { mqttLookupError: lookupError } : {}),
  };
}

function readOptions(file: string): AddonOptions {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AddonOptions;
  } catch {
    return {};
  }
}

async function resolveMqtt(
  options: AddonOptions,
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch,
): Promise<{ mqtt: MqttConfig | null; lookupError?: string }> {
  if (options.mqtt_host) {
    return {
      mqtt: {
        url: `mqtt://${options.mqtt_host}:${options.mqtt_port ?? 1883}`,
        username: options.mqtt_username || undefined,
        password: options.mqtt_password || undefined,
      },
    };
  }
  let lookupError: string | undefined;
  if (env.SUPERVISOR_TOKEN) {
    try {
      const res = await fetchFn('http://supervisor/services/mqtt', {
        headers: { Authorization: `Bearer ${env.SUPERVISOR_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        lookupError = `Supervisor antwortet mit HTTP ${res.status}`;
      } else {
        const { data } = (await res.json()) as SupervisorMqttService;
        if (data?.host) {
          return {
            mqtt: {
              url: `${data.ssl ? 'mqtts' : 'mqtt'}://${data.host}:${data.port ?? 1883}`,
              username: data.username,
              password: data.password,
              onHa: true,
            },
          };
        }
        lookupError = 'Supervisor meldet keinen MQTT-Dienst';
      }
    } catch (err) {
      // Kein MQTT-Dienst verfügbar: HTTP-Modus.
      lookupError = err instanceof Error ? err.message : String(err);
    }
  }
  if (env.TM_MQTT_URL) return { mqtt: { url: env.TM_MQTT_URL }, lookupError };
  return { mqtt: null, lookupError };
}

const IGNORED_INTERFACES = /^(lo|docker|hassio|veth|br-)/;

/** Ermittelt die LAN-Netze des Hosts als Standard-Scanbereiche (höchstens /24 je Netz). */
export function detectHostCidrs(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const result = new Set<string>();
  for (const [name, addresses] of Object.entries(ifaces)) {
    if (IGNORED_INTERFACES.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal || !address.cidr) continue;
      const [ip, prefixText] = address.cidr.split('/');
      const prefix = Math.max(Number(prefixText), 24);
      const parsed = parseCidr(`${ip}/${prefix}`);
      if (parsed) result.add(`${intToIp(parsed.base)}/${prefix}`);
    }
  }
  return [...result];
}

/** Erste IPv4-Adresse des Hosts im LAN (die App läuft mit host_network). */
export function detectHostIp(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string | null {
  for (const [name, addresses] of Object.entries(ifaces)) {
    if (IGNORED_INTERFACES.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

function resolveHa(env: NodeJS.ProcessEnv): HaConfig | null {
  if (env.SUPERVISOR_TOKEN) return { url: 'ws://supervisor/core/websocket', token: env.SUPERVISOR_TOKEN };
  if (env.TM_HA_URL && env.TM_HA_TOKEN) return { url: env.TM_HA_URL, token: env.TM_HA_TOKEN };
  return null;
}
