import { EventEmitter } from 'node:events';
import type { Channel, Device } from '@tm/shared';
import { and, eq, ne } from 'drizzle-orm';
import type { Db } from './db';
import { deviceTags, devices, tags } from './db/schema';
import type { DeviceInfo } from './tasmota/parse';

type DeviceRow = typeof devices.$inferSelect;
type DeviceInsert = typeof devices.$inferInsert;

type RegistryEvents = { updated: [Device]; removed: [string] };

export interface UpsertOptions {
  channel?: Channel;
  statusJson?: unknown;
}

const PLACEHOLDER_PREFIX = 'IP-';
export const placeholderId = (host: string): string => `${PLACEHOLDER_PREFIX}${host}`;

export class DeviceRegistry extends EventEmitter<RegistryEvents> {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
  }

  list(): Device[] {
    const tagMap = this.tagMap();
    return this.db
      .select()
      .from(devices)
      .all()
      .map((row) => toDevice(row, tagMap.get(row.id) ?? []))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): Device | null {
    const row = this.row(id);
    return row ? toDevice(row, this.tagsOf(id)) : null;
  }

  getStatus(id: string): unknown {
    return this.row(id)?.statusJson ?? null;
  }

  findByTopic(topic: string): Device | null {
    const row = this.db.select().from(devices).where(eq(devices.mqttTopic, topic)).get();
    return row ? toDevice(row, this.tagsOf(row.id)) : null;
  }

  findByIp(ip: string): Device | null {
    const row = this.db.select().from(devices).where(eq(devices.ip, ip)).get();
    return row ? toDevice(row, this.tagsOf(row.id)) : null;
  }

  upsert(info: DeviceInfo, opts: UpsertOptions = {}): Device {
    const { mac: id, ...rest } = info;
    const fields = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<DeviceInsert>;
    if (opts.statusJson !== undefined) fields.statusJson = opts.statusJson;

    const removedIds: string[] = [];
    const displacedIds: string[] = [];
    let inheritedPassword: string | null = null;
    if (info.ip) {
      const others = this.db
        .select()
        .from(devices)
        .where(and(eq(devices.ip, info.ip), ne(devices.id, id)))
        .all();
      for (const other of others) {
        if (other.id.startsWith(PLACEHOLDER_PREFIX)) {
          inheritedPassword = other.passwordOverride ?? inheritedPassword;
          this.db.delete(devices).where(eq(devices.id, other.id)).run();
          removedIds.push(other.id);
        } else {
          this.db.update(devices).set({ ip: null }).where(eq(devices.id, other.id)).run();
          displacedIds.push(other.id);
        }
      }
    }

    const existing = this.row(id);
    if (existing) {
      if (Object.keys(fields).length > 0) this.db.update(devices).set(fields).where(eq(devices.id, id)).run();
    } else {
      this.db
        .insert(devices)
        .values({ id, name: info.name ?? info.hostname ?? id, ...fields, createdAt: this.now().toISOString() })
        .run();
    }
    if (inheritedPassword && !this.row(id)?.passwordOverride) {
      this.db.update(devices).set({ passwordOverride: inheritedPassword }).where(eq(devices.id, id)).run();
    }

    for (const removedId of removedIds) this.emit('removed', removedId);
    for (const displacedId of displacedIds) this.emitUpdated(displacedId);
    return opts.channel ? this.markReachable(id, opts.channel) : this.emitUpdated(id);
  }

  upsertAuthPlaceholder(host: string): Device {
    const known = this.findByIp(host);
    if (known) return this.setAuthRequired(known.id, true);
    const now = this.now().toISOString();
    const id = placeholderId(host);
    this.db
      .insert(devices)
      .values({ id, name: host, ip: host, authRequired: true, online: true, channels: ['http'], lastSeen: now, createdAt: now })
      .run();
    return this.emitUpdated(id);
  }

  markReachable(id: string, channel: Channel): Device {
    const row = this.requireRow(id);
    const channels = row.channels.includes(channel) ? row.channels : [...row.channels, channel].sort();
    this.db
      .update(devices)
      .set({
        channels,
        online: true,
        lastSeen: this.now().toISOString(),
        ...(channel === 'http' ? { httpFailures: 0, authRequired: false } : {}),
      })
      .where(eq(devices.id, id))
      .run();
    return this.emitUpdated(id);
  }

  markUnreachable(id: string, channel: Channel): Device | null {
    const row = this.row(id);
    if (!row) return null;
    const channels = row.channels.filter((c) => c !== channel);
    this.db.update(devices).set({ channels, online: channels.length > 0 }).where(eq(devices.id, id)).run();
    return this.emitUpdated(id);
  }

  updateRuntime(id: string, values: { rssi?: number; uptimeSec?: number }): Device | null {
    if (!this.row(id)) return null;
    const fields = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
    this.db
      .update(devices)
      .set({ ...fields, lastSeen: this.now().toISOString() })
      .where(eq(devices.id, id))
      .run();
    return this.emitUpdated(id);
  }

  setAuthRequired(id: string, value: boolean): Device {
    this.requireRow(id);
    this.db.update(devices).set({ authRequired: value }).where(eq(devices.id, id)).run();
    return this.emitUpdated(id);
  }

  recordHttpFailure(id: string): number {
    const failures = this.requireRow(id).httpFailures + 1;
    this.db.update(devices).set({ httpFailures: failures }).where(eq(devices.id, id)).run();
    return failures;
  }

  setPasswordOverride(id: string, password: string | null): Device {
    this.requireRow(id);
    this.db
      .update(devices)
      .set({ passwordOverride: password || null })
      .where(eq(devices.id, id))
      .run();
    return this.emitUpdated(id);
  }

  getPasswordOverride(id: string): string | null {
    return this.row(id)?.passwordOverride ?? null;
  }

  setTags(id: string, names: string[]): Device {
    this.requireRow(id);
    const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    this.db.transaction((tx) => {
      tx.delete(deviceTags).where(eq(deviceTags.deviceId, id)).run();
      for (const name of unique) {
        tx.insert(tags).values({ name }).onConflictDoNothing().run();
        const tag = tx.select().from(tags).where(eq(tags.name, name)).get();
        if (tag) tx.insert(deviceTags).values({ deviceId: id, tagId: tag.id }).run();
      }
    });
    return this.emitUpdated(id);
  }

  remove(id: string): boolean {
    const result = this.db.delete(devices).where(eq(devices.id, id)).run();
    if (result.changes === 0) return false;
    this.emit('removed', id);
    return true;
  }

  private row(id: string): DeviceRow | null {
    return this.db.select().from(devices).where(eq(devices.id, id)).get() ?? null;
  }

  private requireRow(id: string): DeviceRow {
    const row = this.row(id);
    if (!row) throw new Error(`Unbekanntes Gerät ${id}`);
    return row;
  }

  private tagsOf(id: string): string[] {
    return this.db
      .select({ name: tags.name })
      .from(deviceTags)
      .innerJoin(tags, eq(deviceTags.tagId, tags.id))
      .where(eq(deviceTags.deviceId, id))
      .all()
      .map((r) => r.name)
      .sort();
  }

  private tagMap(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    const rows = this.db
      .select({ deviceId: deviceTags.deviceId, name: tags.name })
      .from(deviceTags)
      .innerJoin(tags, eq(deviceTags.tagId, tags.id))
      .all();
    for (const { deviceId, name } of rows) map.set(deviceId, [...(map.get(deviceId) ?? []), name].sort());
    return map;
  }

  private emitUpdated(id: string): Device {
    const device = this.get(id);
    if (!device) throw new Error(`Unbekanntes Gerät ${id}`);
    this.emit('updated', device);
    return device;
  }
}

function toDevice(row: DeviceRow, tagNames: string[]): Device {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    ip: row.ip,
    mqttTopic: row.mqttTopic,
    fullTopic: row.fullTopic,
    module: row.module,
    firmware: row.firmware,
    variant: row.variant,
    chip: row.chip,
    flashSize: row.flashSize,
    rssi: row.rssi,
    uptimeSec: row.uptimeSec,
    online: row.online,
    authRequired: row.authRequired,
    channels: row.channels,
    lastSeen: row.lastSeen,
    hasPasswordOverride: Boolean(row.passwordOverride),
    tags: tagNames,
  };
}
