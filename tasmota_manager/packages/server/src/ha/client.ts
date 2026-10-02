import { EventEmitter } from 'node:events';
import type { HaLink, HaLocation } from '@tm/shared';
import type { Logger } from 'pino';
import WebSocket from 'ws';
import type { HaConfig } from '../config';
import { isObj, normalizeMac } from '../tasmota/parse';

export interface HaClientOptions {
  refreshMs?: number;
  debounceMs?: number;
  requestTimeoutMs?: number;
  /** Anfangsverzögerung für Neuverbindungen (Standard 1000). */
  reconnectMs?: number;
}

export interface RegistryDevice {
  id?: string;
  area_id?: string | null;
  name_by_user?: string | null;
  manufacturer?: string | null;
  connections?: Array<[string, string]>;
  identifiers?: Array<[string, string]>;
}

export interface RegistryEntity {
  entity_id: string;
  device_id?: string | null;
  unique_id?: string | null;
  name?: string | null;
  original_name?: string | null;
  entity_category?: string | null;
  disabled_by?: string | null;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** HA hat die Anfrage beantwortet, aber mit einem Fehler. */
class HaResultError extends Error {}

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

/**
 * Ordnet jeder MAC genau ein HA-Gerät zu. HA kann mehrere Geräte mit derselben MAC führen,
 * z. B. das Tasmota-Gerät und einen Netzwerk-Tracker (UniFi, Fritz!Box); gewählt wird dann das
 * Gerät mit Tasmota-Identifier, sonst mit Hersteller Tasmota, sonst das mit den meisten Entitäten.
 */
export function pickDevicePerMac(devices: RegistryDevice[], entities: RegistryEntity[]): Map<string, RegistryDevice & { id: string }> {
  const entityCount = new Map<string, number>();
  for (const e of entities) if (e.device_id) entityCount.set(e.device_id, (entityCount.get(e.device_id) ?? 0) + 1);
  const score = (d: RegistryDevice & { id: string }): [number, number, number] => [
    (d.identifiers ?? []).some(([domain]) => domain === 'tasmota') ? 1 : 0,
    d.manufacturer === 'Tasmota' ? 1 : 0,
    entityCount.get(d.id) ?? 0,
  ];
  const better = (a: [number, number, number], b: [number, number, number]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const picked = new Map<string, RegistryDevice & { id: string }>();
  for (const device of devices) {
    const mac = macOfHaDevice(device);
    if (!mac || !device.id) continue;
    const candidate = device as RegistryDevice & { id: string };
    const current = picked.get(mac);
    if (!current || better(score(candidate), score(current)) > 0) picked.set(mac, candidate);
  }
  return picked;
}

const entityName = (e: RegistryEntity): string => e.name ?? e.original_name ?? e.entity_id;

/** Nur Entitäten, die HA auf der Geräteseite unter Steuerelemente und Sensoren führt. */
const isPrimary = (e: RegistryEntity): boolean => !e.entity_category && !e.disabled_by;

/** Liest Geräte, Entitäten, Bereiche und Automationen über den HA-WebSocket; Daten nur im Speicher. */
export class HaClient extends EventEmitter<{ changed: [] }> {
  ready = false;
  /** Mindestens einmal vollständig geladen; erst dann ist „nicht in HA“ aussagekräftig. */
  linksLoaded = false;
  /** Systemsprache von Home Assistant (z. B. "de"); null, solange sie nicht gelesen wurde. */
  language: string | null = null;
  /** Zeitzone, Land und Einheit aus der HA-Konfiguration; null, solange unbekannt. */
  config: { timeZone: string | null; country: string | null; fahrenheit: boolean | null } = { timeZone: null, country: null, fahrenheit: null };
  /** Standort des Heims aus der HA-Konfiguration; null, solange unbekannt. */
  location: HaLocation | null = null;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private links = new Map<string, HaLink>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs: number;
  private stopped = false;

  constructor(
    private readonly conn: HaConfig,
    private readonly log: Logger,
    private readonly opts: HaClientOptions = {},
  ) {
    super();
    this.backoffMs = opts.reconnectMs ?? 1000;
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
    for (const [mac, device] of pickDevicePerMac(devices, entities)) {
      let automationIds: string[] = [];
      try {
        const related = await this.call('search/related', { item_type: 'device', item_id: device.id });
        automationIds = isObj(related) && Array.isArray(related.automation) ? (related.automation as string[]) : [];
      } catch (err) {
        // Nur eine Fehlerantwort von HA ist tolerierbar; Verbindungsverlust, Timeout oder stop() brechen ab.
        if (!(err instanceof HaResultError)) throw err;
        this.log.debug({ err, device: device.id }, 'Automationen konnten nicht ermittelt werden');
      }
      next.set(mac, {
        deviceId: device.id,
        areaName: device.area_id ? (areaNames.get(device.area_id) ?? null) : null,
        nameByUser: device.name_by_user ?? null,
        entities: entities.filter((e) => e.device_id === device.id && isPrimary(e)).map((e) => ({ entityId: e.entity_id, name: entityName(e) })),
        automations: automationIds.map((entityId) => {
          const entity = byEntityId.get(entityId);
          return { id: entity?.unique_id ?? null, entityId, name: entity ? entityName(entity) : entityId };
        }),
      });
    }
    const config = await this.call('get_config').then(
      (result) => (isObj(result) ? result : null),
      (err: unknown) => {
        if (!(err instanceof HaResultError)) throw err;
        return null;
      },
    );
    if (this.stopped) return;
    if (typeof config?.language === 'string') this.language = config.language;
    if (config) {
      const unit = isObj(config.unit_system) ? config.unit_system.temperature : undefined;
      this.config = {
        timeZone: typeof config.time_zone === 'string' ? config.time_zone : null,
        country: typeof config.country === 'string' ? config.country : null,
        fahrenheit: typeof unit === 'string' ? unit.includes('F') : null,
      };
    }
    const { latitude, longitude } = config ?? {};
    // HA setzt bei neuen Installationen 0/0, wenn kein Standort eingetragen ist.
    if (typeof latitude === 'number' && typeof longitude === 'number' && (latitude !== 0 || longitude !== 0)) {
      this.location = { latitude, longitude };
    }
    this.links = next;
    this.linksLoaded = true;
    this.emit('changed');
  }

  private connect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.conn.url);
    } catch (err) {
      // Eine fehlerhafte URL repariert sich nicht von selbst.
      this.log.error({ err: err instanceof Error ? err.message : String(err) }, 'Ungültige Home-Assistant-URL');
      this.stopped = true;
      return;
    }
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
        void this.afterAuth(ws);
        break;
      case 'result':
        this.settle(msg);
        break;
      case 'event':
        this.scheduleRefresh();
        break;
    }
  }

  private async afterAuth(ws: WebSocket): Promise<void> {
    try {
      for (const eventType of EVENT_TYPES) await this.call('subscribe_events', { event_type: eventType });
      await this.refresh();
    } catch (err) {
      this.log.warn({ err }, 'HA-Daten konnten nicht geladen werden');
    }
    if (this.stopped || this.ws !== ws) return;
    this.refreshTimer ??= setInterval(() => {
      this.refresh().catch((err: unknown) => this.log.warn({ err }, 'HA-Aktualisierung fehlgeschlagen'));
    }, this.opts.refreshMs ?? 300_000);
  }

  private onClose(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ready = false;
    this.ws = null;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
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
    else pending.reject(new HaResultError(String((isObj(msg.error) && msg.error.message) || 'HA-Fehler')));
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
