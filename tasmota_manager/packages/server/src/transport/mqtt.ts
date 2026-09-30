import { EventEmitter } from 'node:events';
import type { MqttStatus } from '@tm/shared';
import { type MqttClient, connect } from 'mqtt';
import { buildTopic, isRejected, matchesResponse, splitCommand } from '../tasmota/commands';
import { type DeviceInfo, parseDiscoveryConfig, safeJson } from '../tasmota/parse';
import { TransportError } from './errors';

export interface MqttTarget {
  topic: string;
  fullTopic: string | null;
}

export interface MqttOptions {
  url: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
}

export interface MqttSender {
  readonly status: MqttStatus;
  send(target: MqttTarget, command: string, timeoutMs?: number): Promise<unknown>;
}

type MqttEvents = {
  status: [MqttStatus];
  discovery: [DeviceInfo];
  lwt: [topic: string, online: boolean];
  state: [topic: string, payload: unknown];
};

interface Watch {
  topic: string;
  stat: string;
  tele: string;
  ready: Promise<void>;
}

interface Pending {
  name: string;
  resolve: (payload: unknown) => void;
  reject: (err: TransportError) => void;
}

const DISCOVERY_TOPIC = 'tasmota/discovery/+/config';
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

export class MqttTransport extends EventEmitter<MqttEvents> implements MqttSender {
  status: MqttStatus = 'disabled';
  private client: MqttClient | null = null;
  private readonly watches = new Map<string, Watch>();
  private readonly pending = new Map<string, Pending>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private backoffMs = MIN_BACKOFF_MS;

  constructor(private readonly opts: MqttOptions) {
    super();
  }

  start(): void {
    this.setStatus('connecting');
    const client = connect(this.opts.url, {
      username: this.opts.username,
      password: this.opts.password,
      reconnectPeriod: MIN_BACKOFF_MS,
      connectTimeout: 10_000,
      clientId: `tasmota-manager-${Math.random().toString(16).slice(2, 10)}`,
    });
    this.client = client;
    client.on('connect', () => {
      this.backoffMs = MIN_BACKOFF_MS;
      client.options.reconnectPeriod = MIN_BACKOFF_MS;
      this.setStatus('connected');
    });
    client.on('reconnect', () => {
      this.setStatus('connecting');
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      client.options.reconnectPeriod = this.backoffMs;
    });
    client.on('close', () => {
      if (this.status !== 'disabled') this.setStatus('disconnected');
    });
    client.on('error', () => {
      // Verbindungsfehler führen zu 'close' und Reconnect; hier nichts werfen.
    });
    client.on('message', (topic, payload) => this.onMessage(topic, payload));
    const topics = [DISCOVERY_TOPIC, ...[...this.watches.values()].flatMap((w) => [`${w.stat}+`, `${w.tele}+`])];
    client.subscribe(topics);
  }

  async stop(): Promise<void> {
    this.setStatus('disabled');
    for (const pending of this.pending.values()) pending.reject(new TransportError('offline', 'MQTT wurde beendet'));
    this.pending.clear();
    const client = this.client;
    this.client = null;
    await client?.endAsync(true);
  }

  watch(target: MqttTarget): Promise<void> {
    const stat = buildTopic(target.fullTopic, 'stat', target.topic);
    const tele = buildTopic(target.fullTopic, 'tele', target.topic);
    const existing = this.watches.get(target.topic);
    if (existing && existing.stat === stat) return existing.ready;
    if (existing) this.client?.unsubscribe([`${existing.stat}+`, `${existing.tele}+`]);

    const ready = this.client
      ? this.client.subscribeAsync([`${stat}+`, `${tele}+`]).then(
          () => undefined,
          (err: unknown) => {
            this.watches.delete(target.topic);
            throw err;
          },
        )
      : Promise.resolve();
    this.watches.set(target.topic, { topic: target.topic, stat, tele, ready });
    return ready;
  }

  async send(target: MqttTarget, command: string, timeoutMs = this.opts.timeoutMs ?? 5000): Promise<unknown> {
    const client = this.client;
    if (!client || this.status !== 'connected') throw new TransportError('offline', 'MQTT-Broker nicht verbunden', false);
    await this.watch(target);
    return this.withLock(target.topic, () => this.sendLocked(client, target, command, timeoutMs));
  }

  private sendLocked(client: MqttClient, target: MqttTarget, command: string, timeoutMs: number): Promise<unknown> {
    const { name, args } = splitCommand(command);
    const cmndTopic = `${buildTopic(target.fullTopic, 'cmnd', target.topic)}${name}`;
    return new Promise((resolve, reject) => {
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        this.pending.delete(target.topic);
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new TransportError('timeout', `Keine MQTT-Antwort innerhalb von ${timeoutMs} ms`))),
        timeoutMs,
      );
      this.pending.set(target.topic, {
        name,
        resolve: (payload) => finish(() => resolve(payload)),
        reject: (err) => finish(() => reject(err)),
      });
      client.publish(cmndTopic, args, (err) => {
        if (err) finish(() => reject(new TransportError('unreachable', 'MQTT-Publish fehlgeschlagen')));
      });
    });
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    this.locks.set(key, run);
    void run
      .finally(() => {
        if (this.locks.get(key) === run) this.locks.delete(key);
      })
      .catch(() => undefined);
    return run;
  }

  private onMessage(topic: string, buffer: Buffer): void {
    const text = buffer.toString();
    if (topic.startsWith('tasmota/discovery/') && topic.endsWith('/config')) {
      const info = parseDiscoveryConfig(safeJson(text));
      if (info) this.emit('discovery', info);
      return;
    }
    for (const watch of this.watches.values()) {
      if (topic.startsWith(watch.tele)) {
        const suffix = topic.slice(watch.tele.length);
        if (suffix === 'LWT') this.emit('lwt', watch.topic, text === 'Online');
        else if (suffix === 'STATE') this.emit('state', watch.topic, safeJson(text));
        return;
      }
      if (topic.startsWith(watch.stat)) {
        const pending = this.pending.get(watch.topic);
        const payload = safeJson(text);
        if (pending && matchesResponse(pending.name, topic.slice(watch.stat.length), payload)) {
          if (isRejected(payload)) pending.reject(new TransportError('rejected', `Gerät lehnt den Befehl "${pending.name}" ab`));
          else pending.resolve(payload);
        }
        return;
      }
    }
  }

  private setStatus(status: MqttStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }
}
