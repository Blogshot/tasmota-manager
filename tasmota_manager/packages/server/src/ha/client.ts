import { EventEmitter } from 'node:events';
import type { HaLink } from '@tm/shared';
import type { Logger } from 'pino';
import WebSocket from 'ws';
import type { HaConfig } from '../config';
import { isObj, normalizeMac } from '../tasmota/parse';

export interface HaClientOptions {
  refreshMs?: number;
  debounceMs?: number;
  requestTimeoutMs?: number;
}

interface RegistryDevice {
  id?: string;
  area_id?: string | null;
  connections?: Array<[string, string]>;
  identifiers?: Array<[string, string]>;
}

interface RegistryEntity {
  entity_id: string;
  device_id?: string | null;
  unique_id?: string | null;
  name?: string | null;
  original_name?: string | null;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const EVENT_TYPES = ['device_registry_updated', 'entity_registry_updated', 'area_registry_updated'];
const MAX_BACKOFF_MS = 60_000;

export function macOfHaDevice(device: RegistryDevice): string | null {
  for (const [kind, value] of device.connections ?? []) {
    if (kind === 'mac') {
      const mac = normalizeMac(value);
      if (mac) return mac;
    }
  }
  for (const [domain, value] of device.identifiers ?? []) {
    if (domain === 'tasmota') {
      const mac = normalizeMac(value);
      if (mac) return mac;
    }
  }
  return null;
}

const entityName = (e: RegistryEntity): string => e.name ?? e.original_name ?? e.entity_id;

/** Liest Geräte, Entitäten, Bereiche und Automationen über den HA-WebSocket; Daten nur im Speicher. */
export class HaClient extends EventEmitter<{ changed: [] }> {
  ready = false;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private links = new Map<string, HaLink>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = 1000;
  private stopped = false;

  constructor(
    private readonly conn: HaConfig,
    private readonly log: Logger,
    private readonly opts: HaClientOptions = {},
  ) {
    super();
  }

  link(mac: string): HaLink | null {
    return this.links.get(mac) ?? null;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.refreshTimer = this.debounceTimer = this.reconnectTimer = null;
    this.rejectAll(new Error('HA-Verbindung beendet'));
    this.ws?.terminate();
    this.ws = null;
  }

  async refresh(): Promise<void> {
    const [devices, entities, areas] = (await Promise.all([
      this.call('config/device_registry/list'),
      this.call('config/entity_registry/list'),
      this.call('config/area_registry/list'),
    ])) as [RegistryDevice[], RegistryEntity[], Array<{ area_id: string; name: string }>];
    const areaNames = new Map(areas.map((a) => [a.area_id, a.name]));
    const byEntityId = new Map(entities.map((e) => [e.entity_id, e]));
    const next = new Map<string, HaLink>();
    for (const device of devices) {
      const mac = macOfHaDevice(device);
      if (!mac || !device.id) continue;
      let automationIds: string[] = [];
      try {
        const related = await this.call('search/related', { item_type: 'device', item_id: device.id });
        automationIds = isObj(related) && Array.isArray(related.automation) ? (related.automation as string[]) : [];
      } catch (err) {
        this.log.debug({ err, device: device.id }, 'Automationen konnten nicht ermittelt werden');
      }
      next.set(mac, {
        deviceId: device.id,
        areaName: device.area_id ? (areaNames.get(device.area_id) ?? null) : null,
        entities: entities.filter((e) => e.device_id === device.id).map((e) => ({ entityId: e.entity_id, name: entityName(e) })),
        automations: automationIds.map((entityId) => {
          const entity = byEntityId.get(entityId);
          return { id: entity?.unique_id ?? null, entityId, name: entity ? entityName(entity) : entityId };
        }),
      });
    }
    this.links = next;
    this.emit('changed');
  }

  private connect(): void {
    const ws = new WebSocket(this.conn.url);
    this.ws = ws;
    ws.on('message', (data) => this.onMessage(ws, data.toString()));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', (err) => this.log.debug({ err }, 'HA-WebSocket-Fehler'));
  }

  private onMessage(ws: WebSocket, text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObj(msg)) return;
    switch (msg.type) {
      case 'auth_required':
        ws.send(JSON.stringify({ type: 'auth', access_token: this.conn.token }));
        break;
      case 'auth_invalid':
        // Ein falsches Token wird nicht besser; kein Reconnect.
        this.log.error('Home Assistant hat das Zugriffstoken abgelehnt');
        this.stopped = true;
        ws.close();
        break;
      case 'auth_ok':
        this.backoffMs = 1000;
        this.ready = true;
        void this.afterAuth();
        break;
      case 'result':
        this.settle(msg);
        break;
      case 'event':
        this.scheduleRefresh();
        break;
    }
  }

  private async afterAuth(): Promise<void> {
    try {
      for (const eventType of EVENT_TYPES) await this.call('subscribe_events', { event_type: eventType });
      await this.refresh();
    } catch (err) {
      this.log.warn({ err }, 'HA-Daten konnten nicht geladen werden');
    }
    this.refreshTimer ??= setInterval(() => {
      this.refresh().catch((err: unknown) => this.log.warn({ err }, 'HA-Aktualisierung fehlgeschlagen'));
    }, this.opts.refreshMs ?? 300_000);
  }

  private onClose(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ready = false;
    this.ws = null;
    this.rejectAll(new Error('HA-Verbindung getrennt'));
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.refresh().catch((err: unknown) => this.log.warn({ err }, 'HA-Aktualisierung fehlgeschlagen'));
    }, this.opts.debounceMs ?? 2000);
  }

  private call(type: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    const ws = this.ws;
    if (!ws || !this.ready || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('HA nicht verbunden'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`HA-Anfrage ${type} ohne Antwort`));
      }, this.opts.requestTimeoutMs ?? 10_000);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, type, ...extra }));
    });
  }

  private settle(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'number' ? msg.id : -1;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (msg.success) pending.resolve(msg.result);
    else pending.reject(new Error(String((isObj(msg.error) && msg.error.message) || 'HA-Fehler')));
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
