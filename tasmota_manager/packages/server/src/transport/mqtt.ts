import { EventEmitter } from 'node:events';
import type { MqttStatus } from '@tm/shared';
import { type MqttClient, connect } from 'mqtt';
import { buildTopic, isRejected, matchesResponse, splitCommand } from '../tasmota/commands';
import { type DeviceInfo, isObj, parseDiscoveryConfig, parsePower, safeJson } from '../tasmota/parse';
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
  sensor: [topic: string, payload: unknown];
  /** Schaltvorgang, egal wer ihn ausgelöst hat (App, Taster, Home Assistant). */
  power: [topic: string, power: Record<number, boolean>];
};

interface Watch {
  topic: string;
  stat: string;
  tele: string;
  ready: Promise<void>;
}

interface Pending {
  name: string;
  /** Nur bei `Status 0`: sammelt die einzeln eintreffenden Blöcke (STATUS, STATUS1 … STATUS11). */
  blocks?: Record<string, unknown>;
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
    for (const pending of this.pending.values()) pending.reject(new TransportError('offline', 'MQTT was stopped'));
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
    if (!client || this.status !== 'connected') throw new TransportError('offline', 'MQTT broker not connected', false);
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
        () => finish(() => reject(new TransportError('timeout', `No MQTT response within ${timeoutMs} ms`))),
        timeoutMs,
      );
      this.pending.set(target.topic, {
        name,
        blocks: name.toUpperCase() === 'STATUS' && args === '0' ? {} : undefined,
        resolve: (payload) => finish(() => resolve(payload)),
        reject: (err) => finish(() => reject(err)),
      });
      client.publish(cmndTopic, args, (err) => {
        if (err) finish(() => reject(new TransportError('unreachable', 'MQTT publish failed')));
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
        else if (suffix === 'SENSOR') this.emit('sensor', watch.topic, safeJson(text));
        return;
      }
      if (topic.startsWith(watch.stat)) {
        const pending = this.pending.get(watch.topic);
        const payload = safeJson(text);
        const suffix = topic.slice(watch.stat.length);
        if (suffix === 'RESULT') {
          const power = parsePower(payload);
          if (Object.keys(power).length > 0) this.emit('power', watch.topic, power);
        }
        if (pending?.blocks && /^STATUS\d*$/.test(suffix)) {
          // Tasmota beantwortet `Status 0` per MQTT mit einer Nachricht pro Block; STATUS11 schließt die Blöcke ab, die wir auswerten.
          if (isObj(payload)) Object.assign(pending.blocks, payload);
          if (suffix === 'STATUS11') pending.resolve(pending.blocks);
          return;
        }
        if (pending && matchesResponse(pending.name, suffix, payload)) {
          if (isRejected(payload)) pending.reject(new TransportError('rejected', `Device rejects the command "${pending.name}"`));
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
