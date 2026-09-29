import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { intToIp, parseCidr } from '@tm/shared';

export interface MqttConfig {
  url: string;
  username?: string;
  password?: string;
}

export interface AppConfig {
  dataDir: string;
  port: number;
  logLevel: string;
  mqtt: MqttConfig | null;
  /** true unter dem Supervisor: nur Anfragen über den Ingress-Proxy zulassen. */
  ingressOnly: boolean;
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
  return {
    dataDir,
    port: Number(env.TM_PORT ?? 8099),
    logLevel: options.log_level ?? env.TM_LOG_LEVEL ?? 'info',
    mqtt: await resolveMqtt(options, env, fetchFn),
    ingressOnly: Boolean(env.SUPERVISOR_TOKEN),
  };
}

function readOptions(file: string): AddonOptions {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AddonOptions;
  } catch {
    return {};
  }
}

async function resolveMqtt(options: AddonOptions, env: NodeJS.ProcessEnv, fetchFn: typeof fetch): Promise<MqttConfig | null> {
  if (options.mqtt_host) {
    return {
      url: `mqtt://${options.mqtt_host}:${options.mqtt_port ?? 1883}`,
      username: options.mqtt_username || undefined,
      password: options.mqtt_password || undefined,
    };
  }
  if (env.SUPERVISOR_TOKEN) {
    try {
      const res = await fetchFn('http://supervisor/services/mqtt', {
        headers: { Authorization: `Bearer ${env.SUPERVISOR_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const { data } = (await res.json()) as SupervisorMqttService;
        if (data?.host) {
          return {
            url: `${data.ssl ? 'mqtts' : 'mqtt'}://${data.host}:${data.port ?? 1883}`,
            username: data.username,
            password: data.password,
          };
        }
      }
    } catch {
      // Kein MQTT-Dienst verfügbar: HTTP-Modus.
    }
  }
  if (env.TM_MQTT_URL) return { url: env.TM_MQTT_URL };
  return null;
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
