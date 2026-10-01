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
  /** Inhalt von StatusSNS (Status 10), z. B. { AM2301: { Temperature: 21.3, Humidity: 40 } }. */
  sensors?: Record<string, unknown>;
  /** Anzahl Relais (Standard 1). */
  relays?: number;
  /** Zusätzliche StatusSTS-Felder, z. B. { Dimmer: 50 }. */
  extraState?: Record<string, unknown>;
  setOption4?: boolean;
  /** IP in Discovery und Status 0 melden (Standard: ja). */
  advertiseIp?: boolean;
  /** Verzögerung bis zum Neustart nach einem auslösenden Befehl (Standard 50 ms). */
  restartDelayMs?: number;
  /** So lange ist das Gerät beim Neustart nicht erreichbar (Standard 200 ms). */
  downtimeMs?: number;
  /** Diese Einstellungen werden bestätigt, aber nicht übernommen (für Verify-Tests). */
  ignore?: string[];
}

type Json = Record<string, unknown>;
export interface FakeResult {
  suffix: string;
  payload: Json;
}

interface FakeRule {
  state: boolean;
  text: string;
}

const RESTART_KEYS = new Set(['MQTTHOST', 'MQTTPORT', 'MQTTUSER', 'MQTTPASSWORD', 'TOPIC', 'HOSTNAME']);
const isOn = (arg: string): boolean => ['1', 'ON', 'TRUE'].includes(arg.toUpperCase());
const unquote = (arg: string): string => (arg === '""' ? '' : arg);
/** Zahlenwerte meldet die Firmware als Zahl, nicht als Text. */
const NUMERIC = new Set(['POWERDELTA1', 'ENERGYRES', 'WATTRES', 'SPEED', 'TEMPRES', 'HUMRES', 'TEMPOFFSET', 'HUMOFFSET']);
const result = (payload: Json): FakeResult => ({ suffix: 'RESULT', payload });

const STATUS0_SUFFIXES: Record<string, string> = {
  Status: 'STATUS',
  StatusPRM: 'STATUS1',
  StatusFWR: 'STATUS2',
  StatusLOG: 'STATUS3',
  StatusMEM: 'STATUS4',
  StatusNET: 'STATUS5',
  StatusMQT: 'STATUS6',
  StatusTIM: 'STATUS7',
  StatusSNS: 'STATUS10',
  StatusSTS: 'STATUS11',
};

/** Per MQTT beantwortet die Firmware `Status 0` nicht in einer Nachricht, sondern mit einer pro Block (STATUS, STATUS1 … STATUS11). */
function splitStatus0(r: FakeResult): FakeResult[] {
  if (r.suffix !== 'STATUS0') return [r];
  const blocks = r.payload as Record<string, Json>;
  return Object.entries(STATUS0_SUFFIXES)
    .filter(([key]) => key in blocks)
    .map(([key, suffix]) => ({ suffix, payload: { [key]: blocks[key] } as Json }));
}
const pad = (n: number): string => String(n).padStart(2, '0');

/** Wie CmndTimezone: Stunden -13…14 mit optionalen Minuten, alles ab 15 wird zu 99; gemeldet wird „+01:00" bzw. 99. */
function firmwareTimezone(args: string, current: string): string {
  const hours = Number.parseInt(args, 10);
  if (!Number.isFinite(hours) || hours < -13) return current;
  if (hours >= 15) return '99';
  const minutes = Math.min(Number.parseInt(args.split(':')[1] ?? '', 10) || 0, 59);
  return `${hours < 0 ? '-' : '+'}${pad(Math.abs(hours))}:${pad(minutes)}`;
}

/**
 * Wie die Timer-Firmware: gespeichert werden Minuten, ein „-" bedeutet +12 h. Gemeldet wird bei Sonnenauf-/-untergang
 * (Modus 1/2) ein negativer Versatz mit „-", ein positiver ohne Vorzeichen; bei Modus 0 nie ein Vorzeichen.
 */
function firmwareTimerTime(time: unknown, mode: unknown): string {
  const [rawHours = '', rawMinutes = ''] = String(time ?? '').split(':');
  const negative = rawHours.includes('-');
  let hours = (Number.parseInt(rawHours.replace('-', ''), 10) || 0) + (negative ? 12 : 0);
  if (hours > 23) hours = 23;
  const minutes = Math.min(Math.max(Number.parseInt(rawMinutes, 10) || 0, 0), 59);
  const sun = Number(mode) === 1 || Number(mode) === 2;
  if (sun && hours > 11) return `-${pad(hours - 12)}:${pad(minutes)}`;
  return `${pad(hours)}:${pad(minutes)}`;
}

/** Simuliert ein Tasmota-Gerät mit HTTP-API (/cm), MQTT-Anbindung und Neustart-Verhalten. */
export class FakeTasmota {
  readonly received: string[] = [];
  readonly values: Record<string, string>;
  readonly rules: FakeRule[] = [1, 2, 3].map(() => ({ state: false, text: '' }));
  readonly timers: Json[] = Array.from({ length: 16 }, () => ({
    Enable: 0,
    Mode: 0,
    Time: '00:00',
    Window: 0,
    Days: '0000000',
    Repeat: 0,
    Output: 1,
    Action: 0,
  }));
  timersEnabled = true;
  restarts = 0;
  down = false;
  readonly mac: string;
  readonly topic: string;
  readonly fullTopic: string;
  readonly bindHost: string;
  port = 0;
  private server: Server | null = null;
  private client: MqttClient | null = null;
  private mqttUrl: string | null = null;
  private bootAt = Date.now();
  private uptimeBase = 100;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private dimmerRange = { Min: 0, Max: 100 };
  private timeRules: Record<'TIMESTD' | 'TIMEDST', number[]> = { TIMESTD: [0, 0, 10, 1, 3, 60], TIMEDST: [0, 0, 3, 1, 2, 120] };

  constructor(private readonly opts: FakeTasmotaOptions) {
    this.mac = opts.mac;
    this.topic = opts.topic ?? `tasmota_${opts.mac.slice(-6)}`;
    this.fullTopic = opts.fullTopic ?? '%prefix%/%topic%/';
    this.bindHost = opts.bindHost ?? '127.0.0.1';
    const name = opts.name ?? 'Tasmota';
    this.values = {
      DeviceName: name,
      FriendlyName1: name,
      Timezone: '99',
      MqttHost: 'broker.local',
      MqttPort: '1883',
      MqttUser: 'DVES_USER',
      MqttPassword: 'secret',
      SetOption19: 'OFF',
      SetOption4: opts.setOption4 ? 'ON' : 'OFF',
      TelePeriod: '300',
      PowerOnState: '3',
      SetOption65: 'OFF',
      LedState: '1',
      LedPower: 'ON',
      Sleep: '50',
      SetOption53: 'OFF',
      LogHost: '',
      SysLog: '0',
      Latitude: '0.000000',
      Longitude: '0.000000',
      NtpServer1: 'pool.ntp.org',
      PowerDelta1: '0',
      EnergyRes: '3',
      WattRes: '0',
      Fade: 'OFF',
      Speed: '1',
      SetOption20: 'OFF',
      SetOption0: 'ON',
      Interlock: 'OFF',
      TempRes: '1',
      HumRes: '1',
      SetOption8: 'OFF',
      TempOffset: '0',
      HumOffset: '0',
    };
    for (const key of this.relayKeys()) this.values[key] = 'OFF';
  }

  get host(): string {
    return `${this.bindHost}:${this.port}`;
  }

  uptimeSec(): number {
    return this.uptimeBase + Math.floor((Date.now() - this.bootAt) / 1000);
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
    this.mqttUrl = url;
    const lwt = `${buildTopic(this.fullTopic, 'tele', this.topic)}LWT`;
    const cmnd = buildTopic(this.fullTopic, 'cmnd', this.topic);
    const stat = buildTopic(this.fullTopic, 'stat', this.topic);
    const client = await connectAsync(url, { will: { topic: lwt, payload: Buffer.from('Offline'), retain: true, qos: 1 } });
    this.client = client;
    await client.subscribeAsync(`${cmnd}#`);
    client.on('message', (topic, message) => {
      if (!topic.startsWith(cmnd) || this.down) return;
      const name = topic.slice(cmnd.length);
      const command = message.length > 0 ? `${name} ${message.toString()}` : name;
      const results = this.execute(command);
      setTimeout(() => {
        for (const r of results.flatMap(splitStatus0)) {
          void client.publishAsync(`${stat}${r.suffix}`, JSON.stringify(r.payload)).catch(() => undefined);
        }
      }, this.opts.responseDelayMs ?? 0);
    });
    await client.publishAsync(`tasmota/discovery/${this.mac}/config`, JSON.stringify(this.discoveryConfig()), { retain: true });
    await client.publishAsync(lwt, 'Online', { retain: true });
  }

  async publishState(): Promise<void> {
    const tele = buildTopic(this.fullTopic, 'tele', this.topic);
    await this.client?.publishAsync(`${tele}STATE`, JSON.stringify({ UptimeSec: 200, Wifi: { Signal: -55 }, POWER: this.values.POWER }));
  }

  /** Schaltet wie ein Tastendruck am Gerät und meldet das Ergebnis per MQTT. */
  async pressButton(): Promise<void> {
    this.values.POWER = this.values.POWER === 'ON' ? 'OFF' : 'ON';
    const stat = buildTopic(this.fullTopic, 'stat', this.topic);
    await this.client?.publishAsync(`${stat}RESULT`, JSON.stringify({ POWER: this.values.POWER }));
  }

  async disconnectMqtt(): Promise<void> {
    const lwt = `${buildTopic(this.fullTopic, 'tele', this.topic)}LWT`;
    await this.client?.publishAsync(lwt, 'Offline', { retain: true });
    await this.client?.endAsync();
    this.client = null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    await this.client?.endAsync(true);
    this.client = null;
    const server = this.server;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.server = null;
    }
  }

  /** Führt einen Befehl aus; `Backlog` liefert eine Antwort pro Teilbefehl. */
  execute(command: string): FakeResult[] {
    this.received.push(command);
    const { name, args } = splitCommand(command);
    if (name.toUpperCase() === 'BACKLOG') {
      return args
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .flatMap((part) => this.execute(part));
    }
    return [this.executeOne(name.toUpperCase(), args)];
  }

  status0(): Json {
    const macColons = this.mac.match(/../g)?.join(':') ?? this.mac;
    return {
      Status: {
        Module: 1,
        DeviceName: this.values.DeviceName,
        FriendlyName: [this.values.FriendlyName1],
        Topic: this.topic,
        Power: this.values.POWER === 'ON' ? '1' : '0',
        PowerOnState: Number(this.values.PowerOnState),
        LedState: Number(this.values.LedState),
      },
      StatusPRM: { Sleep: Number(this.values.Sleep) },
      StatusFWR: { Version: this.opts.firmware ?? '14.2.0(release-tasmota)', Hardware: 'ESP8266EX' },
      StatusLOG: {
        SysLog: Number(this.values.SysLog),
        LogHost: this.values.LogHost,
        TelePeriod: Number(this.values.TelePeriod),
        SetOption: [this.values.SetOption4 === 'ON' ? '00000010' : '00000000'],
      },
      StatusMQT: { MqttHost: this.values.MqttHost, MqttPort: Number(this.values.MqttPort), MqttUser: this.values.MqttUser },
      StatusNET: {
        Hostname: `${this.topic}-1234`,
        IPAddress: this.opts.advertiseIp === false ? '0.0.0.0' : this.bindHost,
        Mac: macColons,
      },
      StatusMEM: { FlashSize: 4096 },
      StatusSTS: this.statusSts(),
    };
  }

  private relayKeys(): string[] {
    const n = this.opts.relays ?? 1;
    return n === 1 ? ['POWER'] : Array.from({ length: n }, (_, i) => `POWER${i + 1}`);
  }

  private statusSts(): Json {
    const power = Object.fromEntries(this.relayKeys().map((k) => [k, this.values[k] ?? 'OFF']));
    return { UptimeSec: this.uptimeSec(), Wifi: { Signal: -60 }, ...power, ...this.opts.extraState };
  }

  private executeOne(upper: string, args: string): FakeResult {
    if (upper === 'STATUS') {
      if (args === '0') return { suffix: 'STATUS0', payload: this.status0() };
      if (args === '10') return { suffix: 'STATUS10', payload: { StatusSNS: { Time: '2026-09-29T12:00:00', ...this.opts.sensors } } };
      if (args === '11') return { suffix: 'STATUS11', payload: { StatusSTS: this.statusSts() } };
    }
    if (upper === 'MODULE' && !args) return result({ Module: { '1': this.opts.module ?? 'Sonoff Basic' } });
    if (upper === 'RESTART') {
      if (args) this.scheduleRestart();
      return result({ Restart: 'Restarting' });
    }
    if (upper === 'POWER' || upper === 'POWER1') {
      const current = this.values.POWER ?? 'OFF';
      const arg = args.toUpperCase();
      const next = !arg ? current : arg === 'TOGGLE' ? (current === 'ON' ? 'OFF' : 'ON') : isOn(arg) ? 'ON' : 'OFF';
      this.values.POWER = next;
      return result({ POWER: next });
    }
    const rule = /^RULE([1-3])$/.exec(upper);
    if (rule) return result(this.rule(Number(rule[1]), args));
    const timer = /^TIMER(\d{1,2})$/.exec(upper);
    if (timer && Number(timer[1]) >= 1 && Number(timer[1]) <= 16) return result(this.timer(Number(timer[1]), args));
    if (upper === 'TIMERS') {
      if (args) this.timersEnabled = isOn(args);
      return result({ Timers: this.timersEnabled ? 'ON' : 'OFF' });
    }
    if (upper === 'DIMMERRANGE') {
      const m = /^(\d+),(\d+)$/.exec(args.replace(/\s/g, ''));
      if (args && !m) return result({ Command: 'Error' });
      if (m) this.dimmerRange = { Min: Number(m[1]), Max: Number(m[2]) };
      return result({ DimmerRange: { ...this.dimmerRange } });
    }
    if (upper === 'TIMESTD' || upper === 'TIMEDST') {
      const parts = args.split(',').map((p) => Number(p.trim()));
      if (args && (parts.length !== 6 || parts.some((n) => !Number.isFinite(n)))) return result({ Command: 'Error' });
      if (args) this.timeRules[upper] = parts;
      const [Hemisphere, Week, Month, Day, Hour, Offset] = this.timeRules[upper];
      return result({ [upper === 'TIMESTD' ? 'TimeStd' : 'TimeDst']: { Hemisphere, Week, Month, Day, Hour, Offset } });
    }
    const key = Object.keys(this.values).find((k) => k.toUpperCase() === upper);
    if (!key) return result({ Command: 'Unknown' });
    if (args && !(this.opts.ignore ?? []).includes(key)) {
      const current = this.values[key];
      if (key === 'Timezone') this.values[key] = firmwareTimezone(args, current ?? '99');
      else this.values[key] = current === 'ON' || current === 'OFF' ? (isOn(args) ? 'ON' : 'OFF') : unquote(args);
      if (RESTART_KEYS.has(upper)) this.scheduleRestart();
    }
    if (key === 'Timezone' && this.values[key] === '99') return result({ Timezone: 99 });
    if (NUMERIC.has(upper)) return result({ [key]: Number(this.values[key]) });
    return result({ [key]: key === 'MqttPassword' ? '****' : this.values[key] });
  }

  private rule(index: number, args: string): Json {
    const rule = this.rules[index - 1] as FakeRule;
    const upper = args.toUpperCase();
    if (upper === '1' || upper === 'ON') rule.state = true;
    else if (upper === '0' || upper === 'OFF') rule.state = false;
    else if (args) rule.text = unquote(args);
    return {
      [`Rule${index}`]: {
        State: rule.state ? 'ON' : 'OFF',
        Once: 'OFF',
        StopOnError: 'OFF',
        Length: rule.text.length,
        Free: 511 - rule.text.length,
        Rules: rule.text,
      },
    };
  }

  private timer(index: number, args: string): Json {
    const timer = this.timers[index - 1] as Json;
    if (args) {
      try {
        Object.assign(timer, JSON.parse(args));
      } catch {
        return { Command: 'Error' };
      }
    }
    timer.Time = firmwareTimerTime(timer.Time, timer.Mode);
    return { [`Timer${index}`]: { ...timer } };
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopped) return;
    this.restartTimer = setTimeout(() => void this.restart(), this.opts.restartDelayMs ?? 50);
  }

  private async restart(): Promise<void> {
    this.down = true;
    const url = this.mqttUrl;
    if (this.client) await this.disconnectMqtt().catch(() => undefined);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopped) return;
      this.down = false;
      this.restarts++;
      this.bootAt = Date.now();
      this.uptimeBase = 0;
      if (url) void this.connectMqtt(url).catch(() => undefined);
    }, this.opts.downtimeMs ?? 200);
  }

  private discoveryConfig(): Json {
    return {
      ip: this.opts.advertiseIp === false ? '' : this.bindHost,
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
    if (this.down) {
      // Neustart: Verbindung hart abbrechen wie ein nicht erreichbares Gerät.
      req.socket.destroy();
      return;
    }
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
    const results = this.execute(url.searchParams.get('cmnd') ?? '');
    const payload = results.length === 1 ? results[0]?.payload : Object.assign({}, ...results.map((r) => r.payload));
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    }, this.opts.responseDelayMs ?? 0);
  }
}
