import { EventEmitter } from 'node:events';
import {
  type ChangeSource,
  type PendingChange,
  type PendingDevice,
  type StageRequest,
  type StageResult,
  readFromStatus,
  renderPlaceholders,
  settingDef,
} from '@tm/shared';
import { and, count, eq, inArray, max } from 'drizzle-orm';
import { prettifyError } from 'zod';
import type { Db } from '../db';
import { pendingChanges } from '../db/schema';
import type { DeviceRegistry } from '../registry';
import { valuesEqual } from './catalog';

export class StageError extends Error {}

export const MASK = '••••';

const SECRET_COMMANDS = new Set(['WEBPASSWORD', 'MQTTPASSWORD', 'PASSWORD']);

/**
 * Blendet für die Ausgabe das Argument von Passwort-Befehlen aus, auch innerhalb eines Backlog.
 * Der Name wird wie in der Firmware bestimmt: Er endet am ersten Zeichen außerhalb von [A-Za-z0-9_/],
 * ein Topic-Präfix und angehängte Ziffern (Index) zählen nicht dazu.
 */
export function maskSecrets(command: string): string {
  const trimmed = command.trim();
  const name = /^[A-Za-z0-9_/]+/.exec(trimmed)?.[0] ?? '';
  const rest = trimmed.slice(name.length).trim();
  if (name === '' || rest === '') return command;
  const base = name.slice(name.lastIndexOf('/') + 1).replace(/\d+$/, '').toUpperCase();
  if (base === 'BACKLOG') {
    return `${name} ${rest
      .split(';')
      .map((part) => maskSecrets(part.trim()))
      .join('; ')}`;
  }
  return SECRET_COMMANDS.has(base) ? `${name} ${MASK}` : command;
}

export interface PendingRow {
  id: number;
  deviceId: string;
  kind: 'setting' | 'command';
  key: string | null;
  value: string;
  position: number;
  source: ChangeSource;
  error: string | null;
  updatedAt: string;
}

const sortKey = (row: PendingRow): number =>
  row.kind === 'setting' ? (settingDef(row.key ?? '')?.order ?? 999) : 10_000 + row.position;

export class PendingStore extends EventEmitter<{ changed: [number] }> {
  constructor(
    private readonly db: Db,
    private readonly registry: DeviceRegistry,
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
  }

  /** Validiert alles zuerst; ein Fehler rollt das komplette Vormerken zurück. */
  stage(req: StageRequest): StageResult {
    let staged = 0;
    let skipped = 0;
    const now = this.now().toISOString();
    this.db.transaction((tx) => {
      for (const deviceId of req.deviceIds) {
        const device = this.registry.get(deviceId);
        if (!device) throw new StageError(`Unbekanntes Gerät ${deviceId}`);
        const status = this.registry.getStatus(deviceId);

        for (const [key, raw] of Object.entries(req.settings ?? {})) {
          const def = settingDef(key);
          if (!def) throw new StageError(`Unbekannte Einstellung ${key}`);
          const input = def.kind === 'rule' ? raw.replace(/\s*\n\s*/g, ' ').trim() : raw;
          const parsed = def.schema.safeParse(input);
          if (!parsed.success) throw new StageError(`${key}: ${prettifyError(parsed.error)}`);
          const value = parsed.data;
          const before = readFromStatus(key, status);
          if (before !== null && valuesEqual(def, value, before)) {
            tx.delete(pendingChanges)
              .where(and(eq(pendingChanges.deviceId, deviceId), eq(pendingChanges.key, key)))
              .run();
            skipped++;
            continue;
          }
          tx.insert(pendingChanges)
            .values({ deviceId, kind: 'setting', key, value, source: req.source, createdAt: now, updatedAt: now })
            .onConflictDoUpdate({
              target: [pendingChanges.deviceId, pendingChanges.key],
              set: { value, source: req.source, error: null, updatedAt: now },
            })
            .run();
          staged++;
        }

        let position =
          tx.select({ last: max(pendingChanges.position) }).from(pendingChanges).where(eq(pendingChanges.deviceId, deviceId)).get()
            ?.last ?? 0;
        for (const template of req.commands ?? []) {
          const rendered = renderPlaceholders(template, device);
          if (!rendered.ok) throw new StageError(`Unbekannter Platzhalter {{${rendered.unknown}}}`);
          position += 1;
          tx.insert(pendingChanges)
            .values({ deviceId, kind: 'command', key: null, value: rendered.value, position, source: req.source, createdAt: now, updatedAt: now })
            .run();
          staged++;
        }
      }
    });
    this.changed();
    return { staged, skipped };
  }

  list(): PendingDevice[] {
    const groups = new Map<string, PendingChange[]>();
    for (const row of this.rows()) {
      const def = row.key ? settingDef(row.key) : undefined;
      const writeOnly = def?.writeOnly ?? false;
      const change: PendingChange = {
        id: row.id,
        deviceId: row.deviceId,
        kind: row.kind,
        key: row.key,
        value: writeOnly ? MASK : row.kind === 'command' ? maskSecrets(row.value) : row.value,
        before:
          row.kind === 'setting' && row.key && !writeOnly ? readFromStatus(row.key, this.registry.getStatus(row.deviceId)) : null,
        source: row.source,
        error: row.error,
        updatedAt: row.updatedAt,
      };
      groups.set(row.deviceId, [...(groups.get(row.deviceId) ?? []), change]);
    }
    return [...groups.entries()]
      .map(([deviceId, changes]) => ({ deviceId, deviceName: this.registry.get(deviceId)?.name ?? deviceId, changes }))
      .sort((a, b) => a.deviceName.localeCompare(b.deviceName));
  }

  count(): number {
    return this.db.select({ n: count() }).from(pendingChanges).get()?.n ?? 0;
  }

  counts(): Map<string, number> {
    const rows = this.db
      .select({ deviceId: pendingChanges.deviceId, n: count() })
      .from(pendingChanges)
      .groupBy(pendingChanges.deviceId)
      .all();
    return new Map(rows.map((r) => [r.deviceId, r.n]));
  }

  pendingNames(): Map<string, string> {
    const rows = this.db
      .select({ deviceId: pendingChanges.deviceId, value: pendingChanges.value })
      .from(pendingChanges)
      .where(eq(pendingChanges.key, 'DeviceName'))
      .all();
    return new Map(rows.map((r) => [r.deviceId, r.value]));
  }

  forDevice(deviceId: string): PendingRow[] {
    return this.rows().filter((r) => r.deviceId === deviceId);
  }

  deviceIdsWithChanges(): string[] {
    return [...new Set(this.rows().map((r) => r.deviceId))];
  }

  discard(id: number): boolean {
    const result = this.db.delete(pendingChanges).where(eq(pendingChanges.id, id)).run();
    if (result.changes > 0) this.changed();
    return result.changes > 0;
  }

  discardDevice(deviceId: string): number {
    const result = this.db.delete(pendingChanges).where(eq(pendingChanges.deviceId, deviceId)).run();
    this.changed();
    return result.changes;
  }

  discardAll(): number {
    const result = this.db.delete(pendingChanges).run();
    this.changed();
    return result.changes;
  }

  resolve(ids: number[]): void {
    if (ids.length === 0) return;
    this.db.delete(pendingChanges).where(inArray(pendingChanges.id, ids)).run();
    this.changed();
  }

  /** Löscht nur Einträge, deren Wert noch dem angewendeten entspricht (zwischenzeitlich neu vorgemerkte Werte bleiben). */
  resolveUnchanged(rows: Array<{ id: number; value: string }>): void {
    if (rows.length === 0) return;
    for (const { id, value } of rows) {
      this.db.delete(pendingChanges).where(and(eq(pendingChanges.id, id), eq(pendingChanges.value, value))).run();
    }
    this.changed();
  }

  fail(ids: number[], error: string): void {
    if (ids.length === 0) return;
    this.db
      .update(pendingChanges)
      .set({ error, updatedAt: this.now().toISOString() })
      .where(inArray(pendingChanges.id, ids))
      .run();
    this.changed();
  }

  /** Vermerkt den Fehler nur an Einträgen, deren Wert noch dem angewendeten entspricht; ein neu vorgemerkter Wert wurde nie versucht. */
  failUnchanged(rows: Array<{ id: number; value: string }>, error: string): void {
    if (rows.length === 0) return;
    const updatedAt = this.now().toISOString();
    for (const { id, value } of rows) {
      this.db.update(pendingChanges).set({ error, updatedAt }).where(and(eq(pendingChanges.id, id), eq(pendingChanges.value, value))).run();
    }
    this.changed();
  }

  clearErrors(deviceIds: string[]): void {
    if (deviceIds.length === 0) return;
    this.db.update(pendingChanges).set({ error: null }).where(inArray(pendingChanges.deviceId, deviceIds)).run();
    this.changed();
  }

  private rows(): PendingRow[] {
    const rows = this.db.select().from(pendingChanges).all() as PendingRow[];
    return rows.sort((a, b) => a.deviceId.localeCompare(b.deviceId) || sortKey(a) - sortKey(b) || a.id - b.id);
  }

  private changed(): void {
    this.emit('changed', this.count());
  }
}
