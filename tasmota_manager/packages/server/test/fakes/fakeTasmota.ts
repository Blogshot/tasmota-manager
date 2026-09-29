import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type MqttClient, connectAsync } from 'mqtt';
import { buildTopic, splitCommand } from '../../src/tasmota/commands';

export interface FakeTasmotaOptions {
  mac: string;
  name?: string;
  topic?: string;
  fullTopic?: string;
  password?: string;
  firmware?: string;
  module?: string;
  bindHost?: string;
  port?: number;
  responseDelayMs?: number;
}

/** Simuliert ein Tasmota-Gerät mit HTTP-API (/cm) und MQTT-Anbindung. */
export class FakeTasmota {
  readonly received: string[] = [];
  readonly values: Record<string, string>;
  readonly mac: string;
  readonly topic: string;
  readonly fullTopic: string;
  readonly bindHost: string;
  port = 0;
  private server: Server | null = null;
  private client: MqttClient | null = null;

  constructor(private readonly opts: FakeTasmotaOptions) {
    this.mac = opts.mac;
    this.topic = opts.topic ?? `tasmota_${opts.mac.slice(-6)}`;
    this.fullTopic = opts.fullTopic ?? '%prefix%/%topic%/';
    this.bindHost = opts.bindHost ?? '127.0.0.1';
    const name = opts.name ?? 'Tasmota';
    this.values = {
      POWER: 'OFF',
      DeviceName: name,
      FriendlyName1: name,
      Timezone: '99',
      MqttHost: '',
      SetOption19: 'OFF',
      TelePeriod: '300',
    };
  }

  get host(): string {
    return `${this.bindHost}:${this.port}`;
  }

  async start(): Promise<this> {
    const server = createServer((req, res) => this.handleHttp(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port ?? 0, this.bindHost, () => resolve());
    });
    this.port = (server.address() as AddressInfo).port;
    return this;
  }

  async connectMqtt(url: string): Promise<void> {
    const lwt = `${buildTopic(this.fullTopic, 'tele', this.topic)}LWT`;
    const cmnd = buildTopic(this.fullTopic, 'cmnd', this.topic);
    const stat = buildTopic(this.fullTopic, 'stat', this.topic);
    const client = await connectAsync(url, { will: { topic: lwt, payload: Buffer.from('Offline'), retain: true, qos: 1 } });
    this.client = client;
    await client.subscribeAsync(`${cmnd}#`);
    client.on('message', (topic, message) => {
      if (!topic.startsWith(cmnd)) return;
      const name = topic.slice(cmnd.length);
      const command = message.length > 0 ? `${name} ${message.toString()}` : name;
      const { suffix, payload } = this.execute(command);
      setTimeout(() => {
        void client.publishAsync(`${stat}${suffix}`, JSON.stringify(payload)).catch(() => undefined);
      }, this.opts.responseDelayMs ?? 0);
    });
    await client.publishAsync(`tasmota/discovery/${this.mac}/config`, JSON.stringify(this.discoveryConfig()), { retain: true });
    await client.publishAsync(lwt, 'Online', { retain: true });
  }

  async publishState(): Promise<void> {
    const tele = buildTopic(this.fullTopic, 'tele', this.topic);
    await this.client?.publishAsync(`${tele}STATE`, JSON.stringify({ UptimeSec: 200, Wifi: { Signal: -55 }, POWER: this.values.POWER }));
  }

  async disconnectMqtt(): Promise<void> {
    const lwt = `${buildTopic(this.fullTopic, 'tele', this.topic)}LWT`;
    await this.client?.publishAsync(lwt, 'Offline', { retain: true });
    await this.client?.endAsync();
    this.client = null;
  }

  async stop(): Promise<void> {
    await this.client?.endAsync(true);
    this.client = null;
    const server = this.server;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.server = null;
    }
  }

  execute(command: string): { suffix: string; payload: Record<string, unknown> } {
    this.received.push(command);
    const { name, args } = splitCommand(command);
    const upper = name.toUpperCase();
    if (upper === 'STATUS' && args === '0') return { suffix: 'STATUS0', payload: this.status0() };
    if (upper === 'MODULE' && !args) return { suffix: 'RESULT', payload: { Module: { '1': this.opts.module ?? 'Sonoff Basic' } } };
    if (upper === 'RESTART') return { suffix: 'RESULT', payload: { Restart: 'Restarting' } };
    if (upper === 'POWER' || upper === 'POWER1') {
      const current = this.values.POWER;
      const arg = args.toUpperCase();
      const next = !arg ? current : arg === 'TOGGLE' ? (current === 'ON' ? 'OFF' : 'ON') : arg === 'ON' || arg === '1' ? 'ON' : 'OFF';
      this.values.POWER = next ?? 'OFF';
      return { suffix: 'RESULT', payload: { POWER: this.values.POWER } };
    }
    const key = Object.keys(this.values).find((k) => k.toUpperCase() === upper);
    if (!key) return { suffix: 'RESULT', payload: { Command: 'Unknown' } };
    if (args) this.values[key] = args;
    return { suffix: 'RESULT', payload: { [key]: this.values[key] } };
  }

  status0(): Record<string, unknown> {
    const macColons = this.mac.match(/../g)?.join(':') ?? this.mac;
    return {
      Status: {
        Module: 1,
        DeviceName: this.values.DeviceName,
        FriendlyName: [this.values.FriendlyName1],
        Topic: this.topic,
        Power: this.values.POWER === 'ON' ? '1' : '0',
      },
      StatusFWR: { Version: this.opts.firmware ?? '14.2.0(release-tasmota)', Hardware: 'ESP8266EX' },
      StatusNET: { Hostname: `${this.topic}-1234`, IPAddress: this.bindHost, Mac: macColons },
      StatusMEM: { FlashSize: 4096 },
      StatusSTS: { UptimeSec: 100, Wifi: { Signal: -60 } },
    };
  }

  private discoveryConfig(): Record<string, unknown> {
    return {
      ip: this.bindHost,
      dn: this.values.DeviceName,
      fn: [this.values.FriendlyName1, null, null],
      hn: `${this.topic}-1234`,
      mac: this.mac,
      md: this.opts.module ?? 'Sonoff Basic',
      ofln: 'Offline',
      onln: 'Online',
      sw: (this.opts.firmware ?? '14.2.0(release-tasmota)').replace(/\(.*$/, ''),
      t: this.topic,
      ft: this.fullTopic,
      tp: ['cmnd', 'stat', 'tele'],
    };
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (url.pathname !== '/cm') {
      res.writeHead(404).end();
      return;
    }
    const password = this.opts.password;
    if (password && (url.searchParams.get('user') !== 'admin' || url.searchParams.get('password') !== password)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ WARNING: 'Need user=<username>&password=<password>' }));
      return;
    }
    const { payload } = this.execute(url.searchParams.get('cmnd') ?? '');
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    }, this.opts.responseDelayMs ?? 0);
  }
}
