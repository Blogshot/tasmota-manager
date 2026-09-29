# Tasmota Manager – Plan 2: Änderungspuffer, Batch-Bearbeitung, HA-Anbindung

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Geräteänderungen werden in einem serverseitigen Puffer vorgemerkt und erst durch einen gestarteten Batch-Lauf geschrieben. Dazu kommen ein Einstellungskatalog, freie Befehle, Namensvorschläge, ein Rules/Timer-Editor und Links auf HA-Entitäten und -Automationen.

**Architecture:**
- **Katalog:** Ein Einstellungskatalog in `@tm/shared` beschreibt jede schreibbare Einstellung: Validierung, Befehl, Neustart, write-only und Reihenfolge.
- **Puffer:** `PendingStore` (neue Tabelle `pending_changes`) nimmt Änderungen an. Es gilt immer der zuletzt vorgemerkte Wert, und Einträge, die dem aktuellen Gerätewert entsprechen, werden verworfen.
- **Batch-Lauf:** Der `ApplyRunner` arbeitet die Geräte parallel ab. Pro Gerät plant er die Befehlsfolge (`planDevice`), schreibt sie über das bestehende `DeviceGateway`, bündelt Einstellungen mit Neustart in einem `Backlog` und erkennt den Neustart an einer kleineren `UptimeSec`. Danach prüft er die geschriebenen Werte (Verify).
- **Home Assistant:** Ein `HaClient` liest über den WebSocket von HA die Geräte-, Entitäts- und Bereichsregistry sowie die Automationen.
- **Anreicherung:** Der `DeviceEnricher` ergänzt jedes Gerät um HA-Links, Namensvorschlag und Pufferstatus.

**Tech Stack:** wie Plan 1 (Node 22, pnpm 10, TypeScript 5.9, Fastify 5, mqtt 5, better-sqlite3/Drizzle, zod 4, React 19, shadcn/ui, TanStack Table/Query, Vitest 5). Neu: `ws` als direkte Server-Abhängigkeit (HA-WebSocket) und die shadcn-Komponente `tabs`.

**Spec:** `docs/superpowers/specs/2026-09-29-plan-2-staging-batch-design.md` (bindend). Ergänzend gelten `docs/superpowers/specs/2026-09-29-tasmota-manager-design.md` sowie die offenen Punkte in `docs/superpowers/plans/2026-09-29-plan-1-followups.md`.

**Bewusste Präzisierungen gegenüber der Spec** (bei Umsetzung nicht erneut diskutieren):
1. **Verify in zwei Phasen:** Einstellungen ohne Neustart (inkl. Rules/Timer) werden direkt nach dem Schreiben geprüft, Einstellungen mit Neustart nach dem Neustart. Nur so bleiben bereits geschriebene und geprüfte Werte auch dann erfolgreich, wenn das Gerät nach dem Neustart nicht zurückkommt. Genau das verlangt Spec §5.
2. **Neustart-Erkennung:** Einziges Kriterium ist eine kleinere `UptimeSec` aus `Status 11`. Der MQTT-LWT wird nicht zusätzlich ausgewertet. Er würde nichts ändern: Solange das Gerät weg ist, scheitern die Abfragen ohnehin.
3. **Neustart-Befehle:** Die Liste enthält weder `Template` noch `Upgrade`. `Template` startet nur zusammen mit `Module 0` neu, und `Upgrade` kann länger als 90 s dauern (OTA folgt in Plan 3). Stünde ein Befehl in der Liste, der tatsächlich nicht neu startet, liefe das Warten in den Timeout und der Eintrag würde fälschlich als `offline` markiert.
4. **Längengrenze für Rules:** Server und Editor begrenzen Rules auf 511 Zeichen (`MAX_RULE_LENGTH`). Der Editor zeigt zusätzlich `min(Länge + Free, 511)` an.
5. **Einstellungen in der Detailansicht:** Leere Felder bleiben unverändert. Der aktuelle Wert erscheint als Platzhalter bzw. in der Auswahl „unverändert (Wert)“, das Formular ist also nicht vorausgefüllt. Das verhält sich genauso wie das Batch-Formular.
6. **Unterbrochene Batch-Läufe:** Wird die App während eines Laufs neu gestartet, gelten laufende **und** wartende Job-Items als `interrupted`. Die zugehörigen Puffer-Einträge bleiben mit diesem Fehler stehen.

## Global Constraints

- Alle Befehle laufen im Ordner `tasmota_manager/`, sofern nicht anders angegeben. Git-Befehle funktionieren von dort aus.
- **Node und TypeScript:** Node 22, pnpm 10, TypeScript 5.9 `strict`, ESM, `moduleResolution: Bundler`, Imports ohne Dateiendung.
- **Code-Stil:** Bezeichner auf Englisch, Kommentare sparsam und auf Deutsch, Testnamen auf Deutsch.
- **Puffer-Prinzip:** Alles, was Konfiguration auf einem Gerät ändert, geht über `pending_changes` und wird nur durch `POST /api/changes/apply` geschrieben. Sofort wirksam bleiben Tags, das Passwort pro Gerät, die Konsole, Schalten und Neustart.
- **Passwörter** (`MqttPassword`, Web-Passwörter) sind write-only. Sie erscheinen nie in API-Antworten (Maske `••••`), in Logs oder in Fehlermeldungen.
- **Neustart:**
  - Einstellungen mit `restarts` werden pro Gerät zuletzt geschrieben, gebündelt in genau **einem** `Backlog`.
  - Ein Neustart gilt als erfolgt, wenn `Status 11` eine kleinere `UptimeSec` meldet als vorher.
  - Das Warten auf den Neustart ist auf 90 s begrenzt.
  - Werte, die im Backlog landen, dürfen kein `;` enthalten.
- **Batch-Lauf:**
  - Die Parallelität richtet sich nach `settings.concurrency.command` (Standard 10).
  - Es läuft höchstens ein Batch gleichzeitig, sonst antwortet die API mit 409.
- **Home Assistant:** Die HA-Anbindung ist optional. Ohne `SUPERVISOR_TOKEN` bzw. `TM_HA_URL`+`TM_HA_TOKEN` oder bei einem Fehler läuft die App ohne sie.
- **Scan-Bereiche:** Höchstens /20 pro Bereich. Die Fehlermeldung nennt den Grund und schlägt vor, die Subnetze einzeln einzutragen.
- **Oberfläche:** Sie ist zweisprachig (de/en) und verwendet relative API-URLs. HA-Links öffnen mit `target="_top"`.

## Review Focus

1. **Gerät kommt nach einer MQTT-Änderung nicht zurück** (falscher Broker): Der Lauf endet spätestens nach 90 s. Die MQTT-Einträge bleiben mit `offline` stehen, bereits geprüfte andere Einstellungen verschwinden aus dem Puffer. → Task 8
2. **Dieselbe Einstellung zweimal vorgemerkt oder auf den aktuellen Wert zurückgesetzt:** Es gilt der letzte Wert. Ein Eintrag gleich dem aktuellen Wert wird verworfen, ein bestehender Eintrag dafür entfernt. → Task 4
3. **Backlog-Injektion:** Ein MQTT-Wert mit `;` (z. B. `broker;Reset 1`) wird beim Vormerken mit 400 abgelehnt. → Task 1 und Task 11
4. **MQTT-Passwort:** Es taucht weder in `GET /api/changes` noch in einer Job-Fehlermeldung im Klartext auf. → Task 4 und Task 11
5. **App-Neustart während eines Batch-Laufs:** Die Items werden `interrupted`, die Puffer-Einträge bleiben mit Fehler stehen und lassen sich erneut starten. → Task 8

---
### Task 1: Einstellungskatalog und neue Typen in `@tm/shared`

**Files:**
- Create: `tasmota_manager/packages/shared/src/catalog.ts`
- Modify: `tasmota_manager/packages/shared/src/index.ts`
- Modify: `tasmota_manager/packages/server/src/registry.ts` (Funktion `toDevice`)
- Modify: `tasmota_manager/packages/web/src/test/fixtures.ts`
- Test: `tasmota_manager/packages/shared/src/catalog.test.ts`

**Interfaces:**
- Produces (`@tm/shared`):
  - Typen: `SettingKind`, `SettingGroup`, `SettingDef { key, group, kind, schema: ZodType<string>, command?, restarts, writeOnly, order, batch }`
  - Katalog: `SETTINGS`, `settingDef(key): SettingDef | undefined`, `commandFor(def, value): string`, `readFromStatus(key, status0): string | null`
  - Rules/Timer: `MAX_RULE_LENGTH = 511`, `TimerSchema`/`Timer`, `DEFAULT_TIMER`, `normalizeDays(v): string`, `normalizeTimer(raw): Timer`
  - Platzhalter: `PLACEHOLDERS`, `PlaceholderDevice`, `renderPlaceholders(template, device)`
  - HA: `HaLinkSchema`/`HaLink`
  - `Device` bekommt zusätzlich `setOption4: boolean`, `ha: HaLink | null`, `nameSuggestion: string | null`, `pendingCount: number`, `pendingName: string | null`.
  - Puffer: `ChangeSourceSchema`/`ChangeSource`, `PendingChange`, `PendingDevice`, `StageRequestSchema`/`StageRequest`, `StageResult`, `DeviceIdsRequestSchema`, `ApplyRequestSchema`
  - Jobs: `JobItemStatus`, `JobStep`, `JobItem`, `JobView`, `RuleState`, `TimersState`
  - Neue `WsMessage`-Varianten: `changes:updated`, `job:progress`, `job:done`, `devices:stale`
  - `CidrSchema` erhält eine erklärende Fehlermeldung.

- [ ] **Step 1: Failing Test schreiben**

`tasmota_manager/packages/shared/src/catalog.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  CidrSchema,
  SETTINGS,
  StageRequestSchema,
  TimerSchema,
  commandFor,
  normalizeDays,
  normalizeTimer,
  readFromStatus,
  renderPlaceholders,
  settingDef,
} from './index';

const def = (key: string) => {
  const found = settingDef(key);
  if (!found) throw new Error(`fehlt: ${key}`);
  return found;
};

describe('Einstellungskatalog', () => {
  it('enthält jeden Schlüssel genau einmal', () => {
    const keys = SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('validiert Werte je Einstellung', () => {
    expect(def('PowerOnState').schema.safeParse('3').success).toBe(true);
    expect(def('PowerOnState').schema.safeParse('6').success).toBe(false);
    expect(def('SetOption65').schema.safeParse('1').success).toBe(true);
    expect(def('SetOption65').schema.safeParse('ON').success).toBe(false);
    expect(def('Latitude').schema.safeParse('48.137154').success).toBe(true);
    expect(def('Latitude').schema.safeParse('91').success).toBe(false);
    expect(def('Timezone').schema.safeParse('+01:00').success).toBe(true);
    expect(def('Timezone').schema.safeParse('99').success).toBe(true);
    expect(def('Timezone').schema.safeParse('Europe/Berlin').success).toBe(false);
    expect(def('DeviceName').schema.safeParse('').success).toBe(false);
  });

  it('lehnt Semikolons in MQTT-Werten ab, weil sie im Backlog landen', () => {
    expect(def('MqttHost').schema.safeParse('broker;Reset 1').success).toBe(false);
    expect(def('MqttPassword').schema.safeParse('a;b').success).toBe(false);
  });

  it('markiert nur die MQTT-Gruppe als neustartend und das Passwort als write-only', () => {
    expect(SETTINGS.filter((s) => s.restarts).map((s) => s.key)).toEqual(['MqttHost', 'MqttPort', 'MqttUser', 'MqttPassword']);
    expect(SETTINGS.filter((s) => s.writeOnly).map((s) => s.key)).toEqual(['MqttPassword']);
  });

  it('bietet Namen, Rules und Timer nicht im Batch-Formular an', () => {
    const batch = SETTINGS.filter((s) => s.batch).map((s) => s.key);
    expect(batch).toContain('PowerOnState');
    expect(batch).not.toContain('DeviceName');
    expect(batch).not.toContain('Rule1');
    expect(batch).not.toContain('Timer1');
  });

  it('bildet Befehle', () => {
    expect(commandFor(def('PowerOnState'), '3')).toBe('PowerOnState 3');
    expect(commandFor(def('Rule1Enabled'), '1')).toBe('Rule1 1');
    expect(commandFor(def('Rule2'), '')).toBe('Rule2 ""');
  });

  it('liest bekannte Werte aus Status 0', () => {
    const status = {
      Status: { DeviceName: 'Keller', FriendlyName: ['Licht'], PowerOnState: 3, LedState: 1 },
      StatusPRM: { Sleep: 50 },
      StatusLOG: { SysLog: 0, LogHost: '', TelePeriod: 300 },
      StatusMQT: { MqttHost: 'broker', MqttPort: 1883, MqttUser: 'DVES_USER' },
    };
    expect(readFromStatus('DeviceName', status)).toBe('Keller');
    expect(readFromStatus('FriendlyName1', status)).toBe('Licht');
    expect(readFromStatus('PowerOnState', status)).toBe('3');
    expect(readFromStatus('Sleep', status)).toBe('50');
    expect(readFromStatus('LogHost', status)).toBe('');
    expect(readFromStatus('MqttPort', status)).toBe('1883');
    expect(readFromStatus('Latitude', status)).toBeNull();
    expect(readFromStatus('DeviceName', null)).toBeNull();
  });
});

describe('Timer', () => {
  it('normalisiert Tage und Felder', () => {
    expect(normalizeDays('-MTWTF-')).toBe('0111110');
    expect(normalizeDays('1111111')).toBe('1111111');
    expect(normalizeDays(undefined)).toBe('0000000');
    expect(normalizeTimer({ Enable: '1', Mode: 2, Time: '-00:30', Days: 'SMTWTFS', Output: 2, Action: 1 })).toEqual({
      Enable: 1,
      Mode: 2,
      Time: '-00:30',
      Window: 0,
      Days: '1111111',
      Repeat: 0,
      Output: 2,
      Action: 1,
    });
  });

  it('prüft Timer-JSON im Katalog', () => {
    const timer = { Enable: 1, Mode: 0, Time: '06:30', Window: 0, Days: '0111110', Repeat: 1, Output: 1, Action: 1 };
    expect(def('Timer3').schema.safeParse(JSON.stringify(timer)).success).toBe(true);
    expect(def('Timer3').schema.safeParse('{"Enable":1}').success).toBe(false);
    expect(def('Timer3').schema.safeParse('kein json').success).toBe(false);
    expect(TimerSchema.safeParse({ ...timer, Time: '25:00' }).success).toBe(false);
  });

  it('begrenzt Rules auf 511 Zeichen', () => {
    expect(def('Rule1').schema.safeParse('x'.repeat(511)).success).toBe(true);
    expect(def('Rule1').schema.safeParse('x'.repeat(512)).success).toBe(false);
  });
});

describe('Platzhalter', () => {
  const device = { id: 'AABBCC112233', name: 'Keller', hostname: 'keller-1', mqttTopic: 'keller', ip: '10.0.0.5' };

  it('ersetzt bekannte Platzhalter', () => {
    expect(renderPlaceholders('FriendlyName1 {{name}}-{{mac6}} {{ ip }}', device)).toEqual({
      ok: true,
      value: 'FriendlyName1 Keller-112233 10.0.0.5',
    });
  });

  it('meldet unbekannte Platzhalter', () => {
    expect(renderPlaceholders('X {{foo}}', device)).toEqual({ ok: false, unknown: 'foo' });
  });
});

describe('Requests', () => {
  it('verlangt Einstellungen oder Befehle beim Vormerken', () => {
    expect(StageRequestSchema.safeParse({ deviceIds: ['A'], source: 'form' }).success).toBe(false);
    expect(StageRequestSchema.safeParse({ deviceIds: ['A'], settings: { LedState: '1' }, source: 'form' }).success).toBe(true);
    expect(StageRequestSchema.safeParse({ deviceIds: ['A'], commands: ['Power ON'], source: 'command' }).success).toBe(true);
  });

  it('erklärt abgelehnte Scan-Bereiche', () => {
    const result = CidrSchema.safeParse('10.0.0.0/16');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('/20');
  });
});
```

- [ ] **Step 2: Test ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/shared test
```
Erwartet: FAIL (`SETTINGS` usw. werden nicht exportiert).

- [ ] **Step 3: Katalog implementieren**

`tasmota_manager/packages/shared/src/catalog.ts`:
```ts
import { z } from 'zod';

export type SettingKind = 'text' | 'int' | 'bool' | 'coord' | 'rule' | 'timer';
export type SettingGroup =
  | 'names'
  | 'power'
  | 'led'
  | 'system'
  | 'logging'
  | 'location'
  | 'time'
  | 'telemetry'
  | 'mqtt'
  | 'rules'
  | 'timers';

export interface SettingDef {
  key: string;
  group: SettingGroup;
  kind: SettingKind;
  schema: z.ZodType<string>;
  /** Tasmota-Befehl, falls abweichend vom Schlüssel (z. B. Rule1Enabled → Rule1). */
  command?: string;
  restarts: boolean;
  writeOnly: boolean;
  /** Schreibreihenfolge innerhalb eines Geräts. */
  order: number;
  /** Im Batch-Formular für mehrere Geräte anbieten. */
  batch: boolean;
}

export const MAX_RULE_LENGTH = 511;

const text = (max: number) => z.string().trim().min(1).max(max);
// Werte mit Neustart landen gebündelt in einem Backlog; ein Semikolon würde dort einen eigenen Befehl einschleusen.
const noSemicolon = (schema: z.ZodString) => schema.refine((v) => !v.includes(';'), { message: 'Semikolon ist nicht erlaubt' });
const int = (min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^-?\d+$/, { message: 'Ganzzahl erwartet' })
    .refine((v) => Number(v) >= min && Number(v) <= max, { message: `Erlaubt: ${min}–${max}` });
const bool = z.string().regex(/^[01]$/, { message: '0 oder 1 erwartet' });
const coord = (limit: number) =>
  z
    .string()
    .trim()
    .regex(/^-?\d{1,3}(\.\d{1,6})?$/, { message: 'Dezimalzahl erwartet' })
    .refine((v) => Math.abs(Number(v)) <= limit, { message: `Erlaubt: ±${limit}` });

export const TimerSchema = z.object({
  Enable: z.int().min(0).max(1),
  Mode: z.int().min(0).max(2),
  Time: z.string().regex(/^[+-]?([01]\d|2[0-3]):[0-5]\d$/),
  Window: z.int().min(0).max(15),
  Days: z.string().regex(/^[01]{7}$/),
  Repeat: z.int().min(0).max(1),
  Output: z.int().min(1).max(16),
  Action: z.int().min(0).max(3),
});
export type Timer = z.infer<typeof TimerSchema>;

export const DEFAULT_TIMER: Timer = { Enable: 0, Mode: 0, Time: '00:00', Window: 0, Days: '0000000', Repeat: 0, Output: 1, Action: 0 };

/** Tasmota meldet Wochentage als „1111111“ oder „-MTWTF-“; intern gilt „0“/„1“ ab Sonntag. */
export function normalizeDays(value: unknown): string {
  const s = typeof value === 'string' ? value : '';
  if (s.length !== 7) return DEFAULT_TIMER.Days;
  return [...s].map((c) => (c === '0' || c === '-' ? '0' : '1')).join('');
}

export function normalizeTimer(raw: Record<string, unknown>): Timer {
  const n = (v: unknown, fallback: number) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);
  return {
    Enable: n(raw.Enable, 0),
    Mode: n(raw.Mode, 0),
    Time: typeof raw.Time === 'string' ? raw.Time : DEFAULT_TIMER.Time,
    Window: n(raw.Window, 0),
    Days: normalizeDays(raw.Days),
    Repeat: n(raw.Repeat, 0),
    Output: n(raw.Output, 1),
    Action: n(raw.Action, 0),
  };
}

const timerValue = z.string().refine(
  (v) => {
    try {
      return TimerSchema.safeParse(JSON.parse(v)).success;
    } catch {
      return false;
    }
  },
  { message: 'Ungültiger Timer' },
);
const ruleText = z.string().max(MAX_RULE_LENGTH, { message: `Höchstens ${MAX_RULE_LENGTH} Zeichen` });

const setting = (
  key: string,
  group: SettingGroup,
  kind: SettingKind,
  schema: z.ZodType<string>,
  order: number,
  extra: Partial<SettingDef> = {},
): SettingDef => ({ key, group, kind, schema, order, restarts: false, writeOnly: false, batch: true, ...extra });

export const SETTINGS: readonly SettingDef[] = [
  setting('DeviceName', 'names', 'text', text(32), 10, { batch: false }),
  setting('FriendlyName1', 'names', 'text', text(32), 11, { batch: false }),
  setting('PowerOnState', 'power', 'int', int(0, 5), 20),
  setting('SetOption65', 'power', 'bool', bool, 21),
  setting('LedState', 'led', 'int', int(0, 8), 30),
  setting('LedPower', 'led', 'bool', bool, 31),
  setting('Sleep', 'system', 'int', int(0, 250), 40),
  setting('SetOption53', 'system', 'bool', bool, 41),
  setting('LogHost', 'logging', 'text', text(64), 50),
  setting('SysLog', 'logging', 'int', int(0, 4), 51),
  setting('Latitude', 'location', 'coord', coord(90), 60),
  setting('Longitude', 'location', 'coord', coord(180), 61),
  setting(
    'Timezone',
    'time',
    'text',
    z
      .string()
      .trim()
      .regex(/^(99|[+-]?\d{1,2}|[+-]\d{1,2}:\d{2})$/, { message: '99, Stunden oder ±HH:MM' }),
    70,
  ),
  setting('NtpServer1', 'time', 'text', text(64), 71),
  setting('TelePeriod', 'telemetry', 'int', int(10, 3600), 80),
  setting('MqttHost', 'mqtt', 'text', noSemicolon(text(64)), 90, { restarts: true }),
  setting('MqttPort', 'mqtt', 'int', int(1, 65535), 91, { restarts: true }),
  setting('MqttUser', 'mqtt', 'text', noSemicolon(text(32)), 92, { restarts: true }),
  setting('MqttPassword', 'mqtt', 'text', noSemicolon(text(32)), 93, { restarts: true, writeOnly: true }),
  ...[1, 2, 3].map((n) => setting(`Rule${n}`, 'rules', 'rule', ruleText, 100 + n, { batch: false })),
  ...[1, 2, 3].map((n) => setting(`Rule${n}Enabled`, 'rules', 'bool', bool, 110 + n, { batch: false, command: `Rule${n}` })),
  ...Array.from({ length: 16 }, (_, i) => setting(`Timer${i + 1}`, 'timers', 'timer', timerValue, 201 + i, { batch: false })),
  setting('Timers', 'timers', 'bool', bool, 230, { batch: false }),
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export function settingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

export function commandFor(def: SettingDef, value: string): string {
  return `${def.command ?? def.key} ${value === '' ? '""' : value}`;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const STATUS_READERS: Record<string, (status: Record<string, unknown>) => unknown> = {
  DeviceName: (s) => rec(s.Status).DeviceName,
  FriendlyName1: (s) => {
    const names = rec(s.Status).FriendlyName;
    return Array.isArray(names) ? names[0] : undefined;
  },
  PowerOnState: (s) => rec(s.Status).PowerOnState,
  LedState: (s) => rec(s.Status).LedState,
  Sleep: (s) => rec(s.StatusPRM).Sleep,
  LogHost: (s) => rec(s.StatusLOG).LogHost,
  SysLog: (s) => rec(s.StatusLOG).SysLog,
  TelePeriod: (s) => rec(s.StatusLOG).TelePeriod,
  MqttHost: (s) => rec(s.StatusMQT).MqttHost,
  MqttPort: (s) => rec(s.StatusMQT).MqttPort,
  MqttUser: (s) => rec(s.StatusMQT).MqttUser,
};

/** Aktueller Wert aus dem gespeicherten `Status 0`, soweit er dort enthalten ist. */
export function readFromStatus(key: string, status0: unknown): string | null {
  const reader = STATUS_READERS[key];
  if (!reader) return null;
  const value = reader(rec(status0));
  return value === undefined || value === null ? null : String(value);
}

export const PLACEHOLDERS = ['name', 'hostname', 'topic', 'mac', 'mac6', 'ip'] as const;

export interface PlaceholderDevice {
  id: string;
  name: string;
  hostname: string | null;
  mqttTopic: string | null;
  ip: string | null;
}

export function renderPlaceholders(
  template: string,
  device: PlaceholderDevice,
): { ok: true; value: string } | { ok: false; unknown: string } {
  const values: Record<string, string> = {
    name: device.name,
    hostname: device.hostname ?? '',
    topic: device.mqttTopic ?? '',
    mac: device.id,
    mac6: device.id.slice(-6),
    ip: device.ip ?? '',
  };
  let unknown: string | null = null;
  const value = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    if (!(key in values)) {
      unknown ??= key;
      return '';
    }
    return values[key] ?? '';
  });
  return unknown ? { ok: false, unknown } : { ok: true, value };
}
```

- [ ] **Step 4: `index.ts` erweitern**

In `tasmota_manager/packages/shared/src/index.ts`:

1. Direkt nach `import { z } from 'zod';` einfügen:
```ts
import type { Timer } from './catalog';

export * from './catalog';
```

2. Direkt **vor** `export const DeviceSchema` einfügen:
```ts
export const HaLinkSchema = z.object({
  deviceId: z.string(),
  areaName: z.string().nullable(),
  entities: z.array(z.object({ entityId: z.string(), name: z.string() })),
  automations: z.array(z.object({ id: z.string().nullable(), entityId: z.string(), name: z.string() })),
});
export type HaLink = z.infer<typeof HaLinkSchema>;
```

3. In `DeviceSchema` nach `tags: z.array(z.string()),` einfügen:
```ts
  setOption4: z.boolean(),
  ha: HaLinkSchema.nullable(),
  nameSuggestion: z.string().nullable(),
  pendingCount: z.number(),
  pendingName: z.string().nullable(),
```

4. `CidrSchema` ersetzen durch:
```ts
export const CidrSchema = z
  .string()
  .trim()
  .refine((v) => (parseCidr(v)?.prefix ?? 0) >= MAX_SCAN_PREFIX, {
    message:
      'Ungültiger Bereich oder größer als /20 (höchstens 4096 Adressen). Trage genutzte Subnetze einzeln ein, z. B. 10.0.1.0/24.',
  });
```

5. Die Union `WsMessage` ersetzen durch:
```ts
export type WsMessage =
  | { type: 'device:updated'; device: Device }
  | { type: 'device:removed'; id: string }
  | { type: 'devices:stale' }
  | { type: 'mqtt:status'; status: MqttStatus }
  | ({ type: 'scan:progress' } & ScanProgress)
  | { type: 'scan:done'; found: number }
  | { type: 'changes:updated'; count: number }
  | { type: 'job:progress'; jobId: number; item: JobItem }
  | { type: 'job:done'; job: JobView };
```

6. Am Dateiende anfügen:
```ts
export const ChangeSourceSchema = z.enum(['suggestion', 'form', 'command', 'detail', 'rule', 'timer']);
export type ChangeSource = z.infer<typeof ChangeSourceSchema>;

export interface PendingChange {
  id: number;
  deviceId: string;
  kind: 'setting' | 'command';
  key: string | null;
  /** write-only-Werte als „••••“ */
  value: string;
  /** Aktueller Gerätewert, soweit bekannt */
  before: string | null;
  source: ChangeSource;
  error: string | null;
  updatedAt: string;
}

export interface PendingDevice {
  deviceId: string;
  deviceName: string;
  changes: PendingChange[];
}

export const StageRequestSchema = z
  .object({
    deviceIds: z.array(z.string().min(1)).min(1).max(500),
    settings: z.record(z.string(), z.string()).optional(),
    commands: z.array(z.string().trim().min(1).max(512)).max(50).optional(),
    source: ChangeSourceSchema,
  })
  .refine((b) => Object.keys(b.settings ?? {}).length > 0 || (b.commands?.length ?? 0) > 0, {
    message: 'Keine Änderungen angegeben',
  });
export type StageRequest = z.infer<typeof StageRequestSchema>;

export interface StageResult {
  staged: number;
  skipped: number;
}

export const DeviceIdsRequestSchema = z.object({ deviceIds: z.array(z.string().min(1)).min(1).max(500) });
export const ApplyRequestSchema = z.object({ deviceIds: z.array(z.string().min(1)).max(500).optional() });

export type JobItemStatus = 'pending' | 'running' | 'success' | 'failed';
export type JobStep = 'write' | 'restart' | 'verify';

export interface JobItem {
  deviceId: string;
  deviceName: string;
  status: JobItemStatus;
  step: JobStep | null;
  error: string | null;
}

export interface JobView {
  id: number;
  status: 'running' | 'done';
  createdAt: string;
  finishedAt: string | null;
  items: JobItem[];
}

export interface RuleState {
  index: number;
  enabled: boolean;
  text: string;
  length: number;
  free: number;
}

export interface TimersState {
  enabled: boolean;
  timers: Timer[];
}
```

- [ ] **Step 5: Verbraucher an die erweiterte `Device`-Form anpassen**

`tasmota_manager/packages/server/src/registry.ts`: In `toDevice` nach `tags: tagNames,` einfügen:
```ts
    setOption4: false,
    ha: null,
    nameSuggestion: null,
    pendingCount: 0,
    pendingName: null,
```

`tasmota_manager/packages/web/src/test/fixtures.ts`: Im Objekt von `makeDevice` nach `tags: [],` einfügen:
```ts
    setOption4: false,
    ha: null,
    nameSuggestion: null,
    pendingCount: 0,
    pendingName: null,
```

- [ ] **Step 6: Tests und Typecheck ausführen**

```bash
pnpm --filter @tm/shared test && pnpm typecheck && pnpm test
```
Erwartet: Alles PASS. Die Tests der Server- und Webpakete bleiben grün.

- [ ] **Step 7: Commit**

```bash
git add -A .
git commit -m "feat(shared): add settings catalog, staging, job and HA types"
```

---

### Task 2: Datenbank-Erweiterung und Registry (Sensoren, SetOption4)

**Files:**
- Modify: `tasmota_manager/packages/server/src/db/schema.ts`
- Create: `tasmota_manager/packages/server/drizzle/0001_plan2.sql` (generiert, inkl. `meta/`)
- Modify: `tasmota_manager/packages/server/src/tasmota/parse.ts`
- Modify: `tasmota_manager/packages/server/src/registry.ts`
- Test: `tasmota_manager/packages/server/src/tasmota/parse.test.ts` (ergänzen)
- Test: `tasmota_manager/packages/server/src/registry.test.ts` (ergänzen)

**Interfaces:**
- Consumes: `ChangeSource`, `JobItemStatus`, `JobStep` aus `@tm/shared`
- Produces:
  - Tabellen `pendingChanges`, `jobs`, `jobItems` und die Spalte `devices.sensorsJson`
  - `hasSetOption4(status0: unknown): boolean` (parse.ts)
  - Registry: `UpsertOptions.sensorsJson?: unknown`, `registry.getSensors(id): unknown`, `registry.listRaw(): Array<{ id; statusJson; sensorsJson }>`
  - `Device.setOption4` wird aus dem gespeicherten `Status 0` abgeleitet.

- [ ] **Step 1: Schema erweitern**

In `tasmota_manager/packages/server/src/db/schema.ts`:

1. Die Imports ersetzen durch:
```ts
import type { ChangeSource, Channel, JobItemStatus, JobStep } from '@tm/shared';
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
```

2. In `devices` nach `statusJson: ...,` einfügen:
```ts
  sensorsJson: text('sensors_json', { mode: 'json' }).$type<unknown>(),
```

3. Am Dateiende anfügen:
```ts
export const pendingChanges = sqliteTable(
  'pending_changes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'setting' | 'command'>().notNull(),
    key: text('key'),
    value: text('value').notNull(),
    position: integer('position').notNull().default(0),
    source: text('source').$type<ChangeSource>().notNull(),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  // Pro Gerät und Einstellung gibt es höchstens einen Eintrag (letzter Wert gilt); Befehle haben key = NULL.
  (t) => [uniqueIndex('pending_changes_device_key').on(t.deviceId, t.key)],
);

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  status: text('status').$type<'running' | 'done'>().notNull(),
  createdAt: text('created_at').notNull(),
  finishedAt: text('finished_at'),
});

export const jobItems = sqliteTable('job_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  deviceId: text('device_id').notNull(),
  deviceName: text('device_name').notNull(),
  status: text('status').$type<JobItemStatus>().notNull(),
  step: text('step').$type<JobStep>(),
  error: text('error'),
  changeIds: text('change_ids', { mode: 'json' }).$type<number[]>().notNull(),
});
```

- [ ] **Step 2: Migration generieren**

```bash
cd packages/server && pnpm db:generate --name plan2 && cd ../..
ls packages/server/drizzle
```
Erwartet: `0001_plan2.sql` legt `pending_changes` (mit Unique-Index), `jobs` und `job_items` an und ergänzt `devices.sensors_json`.

- [ ] **Step 3: Failing Tests schreiben**

In `tasmota_manager/packages/server/src/tasmota/parse.test.ts`:
- Den Import um `hasSetOption4` erweitern.
- Am Dateiende anfügen:
```ts
describe('hasSetOption4', () => {
  it('liest Bit 4 aus der ersten SetOption-Maske', () => {
    expect(hasSetOption4({ StatusLOG: { SetOption: ['00008009'] } })).toBe(false);
    expect(hasSetOption4({ StatusLOG: { SetOption: ['00008019'] } })).toBe(true);
    expect(hasSetOption4({ StatusLOG: {} })).toBe(false);
    expect(hasSetOption4(null)).toBe(false);
  });
});
```

In `tasmota_manager/packages/server/src/registry.test.ts` innerhalb von `describe('DeviceRegistry', …)` anfügen:
```ts
  it('speichert Sensordaten und liefert Rohdaten gesammelt', () => {
    registry.upsert({ mac: MAC_A, name: 'A' }, { statusJson: { Status: {} }, sensorsJson: { StatusSNS: { AM2301: { Temperature: 21 } } } });
    expect(registry.getSensors(MAC_A)).toEqual({ StatusSNS: { AM2301: { Temperature: 21 } } });
    expect(registry.listRaw()).toEqual([
      { id: MAC_A, statusJson: { Status: {} }, sensorsJson: { StatusSNS: { AM2301: { Temperature: 21 } } } },
    ]);
  });

  it('leitet SetOption4 aus dem gespeicherten Status ab', () => {
    registry.upsert({ mac: MAC_A, name: 'A' }, { statusJson: { StatusLOG: { SetOption: ['00000010'] } } });
    expect(registry.get(MAC_A)?.setOption4).toBe(true);
    registry.upsert({ mac: MAC_A }, { statusJson: { StatusLOG: { SetOption: ['00000000'] } } });
    expect(registry.get(MAC_A)?.setOption4).toBe(false);
  });
```

- [ ] **Step 4: Tests ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test -- parse registry
```
Erwartet: FAIL (`hasSetOption4`, `sensorsJson`, `getSensors` und `listRaw` fehlen).

- [ ] **Step 5: Implementieren**

In `tasmota_manager/packages/server/src/tasmota/parse.ts` am Dateiende anfügen:
```ts
/** SetOption4 1 lässt Tasmota auf `stat/<topic>/<Befehl>` statt `RESULT` antworten (Bitmaske in StatusLOG). */
export function hasSetOption4(status0: unknown): boolean {
  if (!isObj(status0)) return false;
  const masks = obj(status0.StatusLOG).SetOption;
  const first = Array.isArray(masks) ? masks[0] : undefined;
  if (typeof first !== 'string' || !/^[0-9a-f]+$/i.test(first)) return false;
  return (Number.parseInt(first, 16) & (1 << 4)) !== 0;
}
```

In `tasmota_manager/packages/server/src/registry.ts`:

1. Import ergänzen: `import { type DeviceInfo, hasSetOption4 } from './tasmota/parse';` (ersetzt den bisherigen `DeviceInfo`-Import).

2. `UpsertOptions` erweitern:
```ts
export interface UpsertOptions {
  channel?: Channel;
  statusJson?: unknown;
  sensorsJson?: unknown;
}
```

3. In `upsert` nach `if (opts.statusJson !== undefined) fields.statusJson = opts.statusJson;` einfügen:
```ts
    if (opts.sensorsJson !== undefined) fields.sensorsJson = opts.sensorsJson;
```

4. Nach `getStatus` einfügen:
```ts
  getSensors(id: string): unknown {
    return this.row(id)?.sensorsJson ?? null;
  }

  /** Status- und Sensor-Rohdaten aller Geräte in einer Abfrage (für Namensvorschläge). */
  listRaw(): Array<{ id: string; statusJson: unknown; sensorsJson: unknown }> {
    return this.db.select({ id: devices.id, statusJson: devices.statusJson, sensorsJson: devices.sensorsJson }).from(devices).all();
  }
```

5. In `toDevice` die Zeile `setOption4: false,` ersetzen durch:
```ts
    setOption4: hasSetOption4(row.statusJson),
```

- [ ] **Step 6: Tests und Typecheck ausführen**

```bash
pnpm --filter @tm/server test && pnpm --filter @tm/server typecheck
```
Erwartet: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A .
git commit -m "feat(server): add pending changes and job tables, store sensors, detect SetOption4"
```

---

### Task 3: Werte lesen und vergleichen (serverseitige Katalog-Laufzeit)

**Files:**
- Create: `tasmota_manager/packages/server/src/changes/catalog.ts`
- Test: `tasmota_manager/packages/server/src/changes/catalog.test.ts`

**Interfaces:**
- Consumes: `SettingDef`, `settingDef`, `normalizeTimer`, `MAX_RULE_LENGTH`, `RuleState`, `Timer` aus `@tm/shared`; `isObj` aus `../tasmota/parse`
- Produces:
  - `readCommand(def): string`: Lesebefehl ohne Argument
  - `extractValue(def, response): string | null`: Wert aus der Tasmota-Antwort, normalisiert wie im Puffer (`bool` → `'0'|'1'`, Timer → normalisiertes JSON)
  - `valuesEqual(def, expected, actual: string | null): boolean`
  - `parseRuleState(index, response): RuleState`, `parseTimer(index, response): Timer`, `parseTimersEnabled(response): boolean`

- [ ] **Step 1: Failing Test schreiben**

`tasmota_manager/packages/server/src/changes/catalog.test.ts`:
```ts
import { settingDef } from '@tm/shared';
import { describe, expect, it } from 'vitest';
import { extractValue, parseRuleState, parseTimer, parseTimersEnabled, readCommand, valuesEqual } from './catalog';

const def = (key: string) => {
  const found = settingDef(key);
  if (!found) throw new Error(key);
  return found;
};

describe('readCommand', () => {
  it('nutzt den Befehl ohne Argument', () => {
    expect(readCommand(def('PowerOnState'))).toBe('PowerOnState');
    expect(readCommand(def('Rule2Enabled'))).toBe('Rule2');
  });
});

describe('extractValue', () => {
  it('liest Zahlen und Texte', () => {
    expect(extractValue(def('PowerOnState'), { PowerOnState: 3 })).toBe('3');
    expect(extractValue(def('MqttHost'), { MqttHost: 'broker' })).toBe('broker');
  });

  it('normalisiert Schalter auf 0/1, auch bei nummerierten Schlüsseln', () => {
    expect(extractValue(def('SetOption65'), { SetOption65: 'ON' })).toBe('1');
    expect(extractValue(def('LedPower'), { LedPower1: 'OFF' })).toBe('0');
    expect(extractValue(def('Timers'), { Timers: 'ON' })).toBe('1');
  });

  it('liest Rules und deren Zustand', () => {
    const response = { Rule1: { State: 'ON', Once: 'OFF', StopOnError: 'OFF', Length: 12, Free: 499, Rules: 'on x do y endon' } };
    expect(extractValue(def('Rule1'), response)).toBe('on x do y endon');
    expect(extractValue(def('Rule1Enabled'), response)).toBe('1');
  });

  it('liest Timer als normalisiertes JSON', () => {
    const response = { Timer2: { Enable: 1, Mode: 0, Time: '06:30', Window: 0, Days: '-MTWTF-', Repeat: 1, Output: 1, Action: 1 } };
    expect(JSON.parse(extractValue(def('Timer2'), response) ?? '')).toEqual({
      Enable: 1,
      Mode: 0,
      Time: '06:30',
      Window: 0,
      Days: '0111110',
      Repeat: 1,
      Output: 1,
      Action: 1,
    });
  });

  it('liefert null ohne passenden Schlüssel', () => {
    expect(extractValue(def('LedState'), { POWER: 'ON' })).toBeNull();
    expect(extractValue(def('LedState'), 'kaputt')).toBeNull();
  });
});

describe('valuesEqual', () => {
  it('vergleicht je nach Art', () => {
    expect(valuesEqual(def('Sleep'), '50', '50')).toBe(true);
    expect(valuesEqual(def('SysLog'), '2', '2 (Active 2)')).toBe(true);
    expect(valuesEqual(def('SetOption53'), '1', '1')).toBe(true);
    expect(valuesEqual(def('SetOption53'), '1', '0')).toBe(false);
    expect(valuesEqual(def('Latitude'), '48.137154', '48.13715')).toBe(true);
    expect(valuesEqual(def('Timezone'), '1', '1')).toBe(true);
    expect(valuesEqual(def('Timezone'), '+01:00', '+01:00')).toBe(true);
    expect(valuesEqual(def('Timezone'), '99', '+01:00')).toBe(false);
    expect(valuesEqual(def('Rule1'), 'ON x DO y ENDON', 'on  x do y endon')).toBe(true);
    expect(valuesEqual(def('LedState'), '1', null)).toBe(false);
  });

  it('vergleicht Timer unabhängig vom Tagesformat', () => {
    const a = JSON.stringify({ Enable: 1, Mode: 0, Time: '06:30', Window: 0, Days: '0111110', Repeat: 1, Output: 1, Action: 1 });
    const b = JSON.stringify({ Enable: 1, Mode: 0, Time: '06:30', Window: 0, Days: '-MTWTF-', Repeat: 1, Output: 1, Action: 1 });
    expect(valuesEqual(def('Timer1'), a, b)).toBe(true);
  });
});

describe('Rules und Timer lesen', () => {
  it('liest den Zustand einer Rule', () => {
    expect(parseRuleState(1, { Rule1: { State: 'OFF', Length: 3, Free: 508, Rules: 'abc' } })).toEqual({
      index: 1,
      enabled: false,
      text: 'abc',
      length: 3,
      free: 508,
    });
    expect(parseRuleState(2, {})).toEqual({ index: 2, enabled: false, text: '', length: 0, free: 511 });
  });

  it('liest Timer und den globalen Schalter', () => {
    expect(parseTimer(1, { Timer1: { Enable: 1, Days: '1111111' } }).Days).toBe('1111111');
    expect(parseTimer(1, {}).Enable).toBe(0);
    expect(parseTimersEnabled({ Timers: 'ON' })).toBe(true);
    expect(parseTimersEnabled({ Timers: 'OFF' })).toBe(false);
  });
});
```

- [ ] **Step 2: Test ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test -- changes/catalog
```
Erwartet: FAIL (`./catalog` fehlt).

- [ ] **Step 3: Implementieren**

`tasmota_manager/packages/server/src/changes/catalog.ts`:
```ts
import { MAX_RULE_LENGTH, type RuleState, type SettingDef, type Timer, normalizeTimer } from '@tm/shared';
import { isObj } from '../tasmota/parse';

export function readCommand(def: SettingDef): string {
  return def.command ?? def.key;
}

function onOff(value: unknown): string | null {
  const s = String(value).trim().toUpperCase();
  if (s === 'ON' || s === '1' || s === 'TRUE') return '1';
  if (s === 'OFF' || s === '0' || s === 'FALSE') return '0';
  return null;
}

function findEntry(response: Record<string, unknown>, command: string): unknown {
  const upper = command.toUpperCase();
  const entries = Object.entries(response);
  // Exakter Schlüssel zuerst; nummerierte Varianten (LedPower → LedPower1) als Rückfall.
  const entry = entries.find(([k]) => k.toUpperCase() === upper) ?? entries.find(([k]) => k.toUpperCase().startsWith(upper));
  return entry?.[1];
}

/** Wert aus einer Tasmota-Antwort in der Form, in der er im Puffer steht. */
export function extractValue(def: SettingDef, response: unknown): string | null {
  if (!isObj(response)) return null;
  const raw = findEntry(response, readCommand(def));
  if (raw === undefined || raw === null) return null;
  if (def.kind === 'rule') return isObj(raw) && typeof raw.Rules === 'string' ? raw.Rules : null;
  if (def.kind === 'timer') return isObj(raw) ? JSON.stringify(normalizeTimer(raw)) : null;
  if (def.group === 'rules' && def.kind === 'bool') return isObj(raw) ? onOff(raw.State) : null;
  if (isObj(raw)) return null;
  return def.kind === 'bool' ? onOff(raw) : String(raw);
}

const leadingNumber = (value: string): number => Number.parseFloat(/-?\d+(\.\d+)?/.exec(value)?.[0] ?? 'NaN');
const normalizeRule = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

export function valuesEqual(def: SettingDef, expected: string, actual: string | null): boolean {
  if (actual === null) return false;
  switch (def.kind) {
    case 'int':
      return leadingNumber(expected) === leadingNumber(actual);
    case 'bool':
      return onOff(expected) !== null && onOff(expected) === onOff(actual);
    case 'coord':
      return Math.abs(Number(expected) - Number(actual)) < 1e-4;
    case 'rule':
      return normalizeRule(expected) === normalizeRule(actual);
    case 'timer':
      try {
        return JSON.stringify(normalizeTimer(JSON.parse(expected))) === JSON.stringify(normalizeTimer(JSON.parse(actual)));
      } catch {
        return false;
      }
    default: {
      const a = expected.trim();
      const b = actual.trim();
      if (a === b) return true;
      return a !== '' && b !== '' && Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Number(a) === Number(b);
    }
  }
}

const sub = (response: unknown, key: string): Record<string, unknown> =>
  isObj(response) && isObj(response[key]) ? (response[key] as Record<string, unknown>) : {};

export function parseRuleState(index: number, response: unknown): RuleState {
  const raw = sub(response, `Rule${index}`);
  const text = typeof raw.Rules === 'string' ? raw.Rules : '';
  const length = Number.isFinite(Number(raw.Length)) && raw.Length !== undefined ? Number(raw.Length) : text.length;
  const free = Number.isFinite(Number(raw.Free)) && raw.Free !== undefined ? Number(raw.Free) : Math.max(MAX_RULE_LENGTH - length, 0);
  return { index, enabled: String(raw.State).toUpperCase() === 'ON', text, length, free };
}

export function parseTimer(index: number, response: unknown): Timer {
  return normalizeTimer(sub(response, `Timer${index}`));
}

export function parseTimersEnabled(response: unknown): boolean {
  return isObj(response) && String(response.Timers).toUpperCase() === 'ON';
}
```

- [ ] **Step 4: Tests und Typecheck ausführen**

```bash
pnpm --filter @tm/server test && pnpm --filter @tm/server typecheck
```
Erwartet: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A .
git commit -m "feat(server): read and compare Tasmota setting values"
```

---

### Task 4: Änderungspuffer (`PendingStore`)

**Files:**
- Create: `tasmota_manager/packages/server/src/changes/store.ts`
- Test: `tasmota_manager/packages/server/src/changes/store.test.ts`

**Interfaces:**
- Consumes:
  - `Db`, `pendingChanges`, `DeviceRegistry`
  - aus `@tm/shared`: `settingDef`, `readFromStatus`, `renderPlaceholders`, `StageRequest`, `StageResult`, `PendingDevice`, `PendingChange`
  - `valuesEqual` (Task 3)
- Produces:
  - `class StageError extends Error`
  - `interface PendingRow { id; deviceId; kind: 'setting' | 'command'; key: string | null; value; position; source; error: string | null; updatedAt }`
  - `const MASK = '••••'`
  - `class PendingStore extends EventEmitter<{ changed: [number] }>` mit folgenden Methoden:

| Methode | Rückgabe / Zweck |
|---|---|
| `stage(req: StageRequest)` | `StageResult`; wirft `StageError` |
| `list()` | `PendingDevice[]` |
| `count()` | `number` |
| `counts()` | `Map<deviceId, number>` |
| `pendingNames()` | `Map<deviceId, string>` |
| `forDevice(deviceId)` | `PendingRow[]` |
| `deviceIdsWithChanges()` | `string[]` |
| `discard(id)` | `boolean` |
| `discardDevice(deviceId)` | `number` |
| `discardAll()` | `number` |
| `resolve(ids: number[])` | Einträge entfernen |
| `fail(ids: number[], error: string)` | Fehler an Einträgen vermerken |
| `clearErrors(deviceIds: string[])` | Fehler zurücksetzen |

Jede schreibende Methode sendet das Ereignis `changed` mit der neuen Gesamtzahl.

- [ ] **Step 1: Failing Test schreiben**

`tasmota_manager/packages/server/src/changes/store.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/helpers';
import { DeviceRegistry } from '../registry';
import { MASK, PendingStore, StageError } from './store';

const A = 'AABBCC000001';
const B = 'AABBCC000002';
const STATUS = {
  Status: { DeviceName: 'Keller', FriendlyName: ['Keller'], PowerOnState: 3, LedState: 1 },
  StatusMQT: { MqttHost: 'broker', MqttPort: 1883, MqttUser: 'DVES_USER' },
};

describe('PendingStore', () => {
  let registry: DeviceRegistry;
  let store: PendingStore;
  let events: number[];

  beforeEach(() => {
    const db = testDb();
    registry = new DeviceRegistry(db);
    registry.upsert({ mac: A, name: 'Keller', hostname: 'keller-1', mqttTopic: 'keller', ip: '10.0.0.5' }, { statusJson: STATUS });
    registry.upsert({ mac: B, name: 'Bad' }, { statusJson: STATUS });
    store = new PendingStore(db, registry);
    events = [];
    store.on('changed', (n) => events.push(n));
  });

  it('merkt Einstellungen für mehrere Geräte vor und zeigt Vorher/Nachher', () => {
    expect(store.stage({ deviceIds: [A, B], settings: { PowerOnState: '1', Latitude: '48.1' }, source: 'form' })).toEqual({
      staged: 4,
      skipped: 0,
    });
    const [bad, keller] = store.list();
    expect(bad?.deviceName).toBe('Bad');
    expect(keller?.changes.map((c) => [c.key, c.before, c.value])).toEqual([
      ['PowerOnState', '3', '1'],
      ['Latitude', null, '48.1'],
    ]);
    expect(events).toEqual([4]);
  });

  it('überschreibt bei erneutem Vormerken (letzter Wert gilt)', () => {
    store.stage({ deviceIds: [A], settings: { LedState: '2' }, source: 'form' });
    store.stage({ deviceIds: [A], settings: { LedState: '5' }, source: 'detail' });
    const changes = store.list()[0]?.changes ?? [];
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ key: 'LedState', value: '5', source: 'detail' });
  });

  it('verwirft Werte gleich dem aktuellen Gerätewert und entfernt dafür bestehende Einträge', () => {
    store.stage({ deviceIds: [A], settings: { PowerOnState: '1' }, source: 'form' });
    expect(store.stage({ deviceIds: [A], settings: { PowerOnState: '3' }, source: 'form' })).toEqual({ staged: 0, skipped: 1 });
    expect(store.count()).toBe(0);
  });

  it('ist atomar: ein ungültiger Wert verhindert das ganze Vormerken', () => {
    expect(() => store.stage({ deviceIds: [A], settings: { LedState: '2', PowerOnState: '9' }, source: 'form' })).toThrow(StageError);
    expect(() => store.stage({ deviceIds: [A], settings: { Unbekannt: '1' }, source: 'form' })).toThrow(/Unbekannte Einstellung/);
    expect(() => store.stage({ deviceIds: ['GIBTSNICHT'], settings: { LedState: '2' }, source: 'form' })).toThrow(/Unbekanntes Gerät/);
    expect(() => store.stage({ deviceIds: [A], settings: { MqttHost: 'x;Reset 1' }, source: 'form' })).toThrow(StageError);
    expect(store.count()).toBe(0);
  });

  it('gibt das MQTT-Passwort nie aus', () => {
    store.stage({ deviceIds: [A], settings: { MqttPassword: 'geheim' }, source: 'form' });
    const change = store.list()[0]?.changes[0];
    expect(change).toMatchObject({ key: 'MqttPassword', value: MASK, before: null });
    expect(JSON.stringify(store.list())).not.toContain('geheim');
    expect(store.forDevice(A)[0]?.value).toBe('geheim');
  });

  it('rendert Platzhalter in Befehlen und hängt sie in Reihenfolge an', () => {
    store.stage({ deviceIds: [A], commands: ['FriendlyName1 {{name}}-{{mac6}}', 'Power ON'], source: 'command' });
    store.stage({ deviceIds: [A], commands: ['Restart 1'], source: 'command' });
    expect(store.forDevice(A).map((r) => r.value)).toEqual(['FriendlyName1 Keller-000001', 'Power ON', 'Restart 1']);
    expect(() => store.stage({ deviceIds: [A], commands: ['X {{foo}}'], source: 'command' })).toThrow(/Platzhalter/);
  });

  it('sortiert Einstellungen nach Katalog-Reihenfolge vor Befehlen', () => {
    store.stage({ deviceIds: [A], commands: ['Power ON'], source: 'command' });
    store.stage({ deviceIds: [A], settings: { TelePeriod: '60', PowerOnState: '1' }, source: 'form' });
    expect(store.list()[0]?.changes.map((c) => c.key ?? c.value)).toEqual(['PowerOnState', 'TelePeriod', 'Power ON']);
  });

  it('fasst Zeilenumbrüche in Rules zusammen', () => {
    store.stage({ deviceIds: [A], settings: { Rule1: 'ON Power1#State DO\n  Publish x\nENDON' }, source: 'rule' });
    expect(store.forDevice(A)[0]?.value).toBe('ON Power1#State DO Publish x ENDON');
  });

  it('verwirft, löst auf und vermerkt Fehler', () => {
    store.stage({ deviceIds: [A, B], settings: { LedState: '2', TelePeriod: '60' }, source: 'form' });
    const [first, second] = store.forDevice(A);
    expect(store.counts().get(A)).toBe(2);
    store.fail([first?.id ?? 0], 'offline: weg');
    expect(store.forDevice(A)[0]?.error).toBe('offline: weg');
    store.clearErrors([A]);
    expect(store.forDevice(A)[0]?.error).toBeNull();
    store.resolve([second?.id ?? 0]);
    expect(store.forDevice(A)).toHaveLength(1);
    expect(store.discard(first?.id ?? 0)).toBe(true);
    expect(store.discard(first?.id ?? 0)).toBe(false);
    expect(store.deviceIdsWithChanges()).toEqual([B]);
    expect(store.discardDevice(B)).toBe(2);
    store.stage({ deviceIds: [A], settings: { LedState: '2' }, source: 'form' });
    expect(store.discardAll()).toBe(1);
    expect(store.count()).toBe(0);
  });

  it('liefert vorgemerkte Namen', () => {
    store.stage({ deviceIds: [A], settings: { DeviceName: 'Klima Bad', FriendlyName1: 'Klima Bad' }, source: 'suggestion' });
    expect(store.pendingNames().get(A)).toBe('Klima Bad');
  });
});
```

- [ ] **Step 2: Test ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test -- changes/store
```
Erwartet: FAIL (`./store` fehlt).

- [ ] **Step 3: Implementieren**

`tasmota_manager/packages/server/src/changes/store.ts`:
```ts
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
        value: writeOnly ? MASK : row.value,
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

  fail(ids: number[], error: string): void {
    if (ids.length === 0) return;
    this.db
      .update(pendingChanges)
      .set({ error, updatedAt: this.now().toISOString() })
      .where(inArray(pendingChanges.id, ids))
      .run();
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
```

- [ ] **Step 4: Tests und Typecheck ausführen**

```bash
pnpm --filter @tm/server test && pnpm --filter @tm/server typecheck
```
Erwartet: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A .
git commit -m "feat(server): add pending changes store with last-value-wins semantics"
```

---

### Task 5: Erweitertes Test-Gerät, Sensoren und SetOption4

**Files:**
- Modify (vollständig ersetzen): `tasmota_manager/packages/server/test/fakes/fakeTasmota.ts`
- Create: `tasmota_manager/packages/server/test/fakes/fakeTasmota.test.ts`
- Modify: `tasmota_manager/packages/server/src/tasmota/commands.ts` (`matchesResponse`)
- Modify: `tasmota_manager/packages/server/src/tasmota/commands.test.ts`
- Modify: `tasmota_manager/packages/server/src/discovery/identify.ts`
- Modify: `tasmota_manager/packages/server/src/discovery/mqttDiscovery.ts`
- Modify: `tasmota_manager/packages/server/src/gateway.ts`
- Test: `tasmota_manager/packages/server/src/discovery/scanner.test.ts`, `tasmota_manager/packages/server/src/gateway.test.ts` (ergänzen)

**Interfaces:**
- Consumes: `registry.upsert(..., { sensorsJson })` (Task 2), `Device.setOption4` (Task 2)
- Produces:
  - `FakeTasmota` mit neuen Optionen `sensors`, `relays`, `extraState`, `setOption4`, `advertiseIp`, `restartDelayMs`, `downtimeMs`, `ignore`
  - neue Felder `rules`, `timers`, `timersEnabled`, `restarts`, `down`
  - Befehle `Status 10`, `Status 11`, `RuleN`, `TimerN`, `Timers`, `Backlog` und realistischer Neustart
  - `execute(command)` liefert jetzt ein Array von Antworten (wegen `Backlog`)
  - `matchesResponse('Backlog', 'RESULT', …)` ist `true`
  - `identifyHost` und die MQTT-Discovery speichern `Status 10` als `sensorsJson`
  - Das Gateway nutzt MQTT nicht für Geräte mit `setOption4`.

- [ ] **Step 1: Test-Gerät ersetzen**

`tasmota_manager/packages/server/test/fakes/fakeTasmota.ts` (vollständiger Inhalt):
```ts
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
const result = (payload: Json): FakeResult => ({ suffix: 'RESULT', payload });

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
        for (const r of results) void client.publishAsync(`${stat}${r.suffix}`, JSON.stringify(r.payload)).catch(() => undefined);
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
    const key = Object.keys(this.values).find((k) => k.toUpperCase() === upper);
    if (!key) return result({ Command: 'Unknown' });
    if (args && !(this.opts.ignore ?? []).includes(key)) {
      const current = this.values[key];
      this.values[key] = current === 'ON' || current === 'OFF' ? (isOn(args) ? 'ON' : 'OFF') : unquote(args);
      if (RESTART_KEYS.has(upper)) this.scheduleRestart();
    }
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
```

- [ ] **Step 2: Failing Tests schreiben**

`tasmota_manager/packages/server/test/fakes/fakeTasmota.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { HttpTransport } from '../../src/transport/http';
import { waitFor } from '../helpers';
import { FakeTasmota } from './fakeTasmota';

const http = new HttpTransport(1000);
let fake: FakeTasmota;

afterEach(async () => {
  await fake.stop();
});

const send = (command: string) => http.send({ host: fake.host, password: null }, command);

describe('FakeTasmota', () => {
  it('liefert Sensoren (Status 10) und Laufzeit (Status 11)', async () => {
    fake = await new FakeTasmota({ mac: 'AABBCC000001', sensors: { AM2301: { Temperature: 21.3 } } }).start();
    expect(await send('Status 10')).toMatchObject({ StatusSNS: { AM2301: { Temperature: 21.3 } } });
    expect(await send('Status 11')).toMatchObject({ StatusSTS: { UptimeSec: 100 } });
  });

  it('verwaltet Rules und Timer', async () => {
    fake = await new FakeTasmota({ mac: 'AABBCC000001' }).start();
    await send('Rule1 ON Power1#State DO Publish x ENDON');
    await send('Rule1 1');
    expect(await send('Rule1')).toMatchObject({ Rule1: { State: 'ON', Rules: 'ON Power1#State DO Publish x ENDON' } });
    await send('Timer3 {"Enable":1,"Time":"06:30"}');
    expect(await send('Timer3')).toMatchObject({ Timer3: { Enable: 1, Time: '06:30' } });
    expect(await send('Timers 0')).toEqual({ Timers: 'OFF' });
  });

  it('startet nach einem Backlog mit MQTT-Einstellungen genau einmal neu', async () => {
    fake = await new FakeTasmota({ mac: 'AABBCC000001', restartDelayMs: 20, downtimeMs: 100 }).start();
    await send('Backlog MqttHost neu.local; MqttUser u1');
    expect(fake.values.MqttHost).toBe('neu.local');
    await waitFor(() => fake.down);
    await expect(send('Status 11')).rejects.toMatchObject({ code: 'unreachable' });
    await waitFor(() => fake.restarts === 1);
    expect(await send('Status 11')).toMatchObject({ StatusSTS: { UptimeSec: 0 } });
  });

  it('bestätigt ignorierte Einstellungen, ohne sie zu übernehmen', async () => {
    fake = await new FakeTasmota({ mac: 'AABBCC000001', ignore: ['LedState'] }).start();
    expect(await send('LedState 5')).toEqual({ LedState: '1' });
  });
});
```

In `tasmota_manager/packages/server/src/tasmota/commands.test.ts` im Block `describe('matchesResponse', …)` anfügen:
```ts
  it('akzeptiert für Backlog die erste RESULT-Nachricht', () => {
    expect(matchesResponse('Backlog', 'RESULT', { MqttHost: 'x' })).toBe(true);
    expect(matchesResponse('Backlog', 'STATUS0', {})).toBe(false);
  });
```

In `tasmota_manager/packages/server/src/discovery/scanner.test.ts` einen weiteren Test im Block `describe('HttpScanner', …)` anfügen:
```ts
  it('speichert die Sensoren aus Status 10', async () => {
    const sensorFake = await new FakeTasmota({ mac: 'AABBCC000007', sensors: { ENERGY: { Power: 5 } } }).start();
    fakes.push(sensorFake);
    const scanner = new HttpScanner(http, registry, () => null, () => null, { port: sensorFake.port, timeoutMs: 500 });
    await scanner.probe('127.0.0.1');
    expect(registry.getSensors('AABBCC000007')).toMatchObject({ StatusSNS: { ENERGY: { Power: 5 } } });
  });
```

In `tasmota_manager/packages/server/src/gateway.test.ts` im Block `describe('DeviceGateway', …)` anfügen:
```ts
  it('meidet MQTT bei Geräten mit SetOption4', async () => {
    registry.upsert({ mac: MAC }, { statusJson: { StatusLOG: { SetOption: ['00000010'] } } });
    expect((await gateway.send(MAC, 'Power')).channel).toBe('http');
    expect(mqtt.calls).toEqual([]);
  });
```

- [ ] **Step 3: Tests ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test
```
Erwartet: FAIL. Betroffen sind der Backlog-Match, Sensoren im Scanner und SetOption4 im Gateway. Die Fake-Tests laufen bereits grün, weil Step 1 das Test-Gerät schon ersetzt.

- [ ] **Step 4: Implementieren**

`tasmota_manager/packages/server/src/tasmota/commands.ts`: In `matchesResponse` direkt nach der Zeile `const base = name.replace(/\d+$/, '');` einfügen:
```ts
  // Tasmota beantwortet einen Backlog mit einer RESULT-Nachricht pro Teilbefehl; die erste genügt als Bestätigung.
  if (base === 'BACKLOG') return true;
```
(Die Prüfung auf `suffix !== 'RESULT'` steht davor, `STATUS*` wird also weiterhin abgelehnt.)

`tasmota_manager/packages/server/src/discovery/identify.ts`: Die letzte Zeile (`return registry.upsert(...)`) ersetzen durch:
```ts
  let sensors: unknown;
  try {
    sensors = await http.send({ host, password }, 'Status 10', timeoutMs);
  } catch {
    // Sensoren sind optional (nur für Namensvorschläge).
  }
  return registry.upsert(info, { channel: 'http', statusJson: payload, sensorsJson: sensors });
```

`tasmota_manager/packages/server/src/discovery/mqttDiscovery.ts`: In `refresh` die Zeile
`if (info) this.registry.upsert(info, { statusJson: payload });` ersetzen durch:
```ts
      if (!info) return;
      const sensors = await this.mqtt.send(target, 'Status 10').catch(() => undefined);
      this.registry.upsert(info, { statusJson: payload, sensorsJson: sensors });
```

`tasmota_manager/packages/server/src/gateway.ts`: In `channelsFor` die MQTT-Bedingung ersetzen durch:
```ts
    // Mit SetOption4 1 antwortet Tasmota nicht auf RESULT; die Antwortzuordnung per MQTT funktioniert dann nicht.
    if (!device.setOption4 && this.deps.mqtt?.status === 'connected' && device.mqttTopic && device.channels.includes('mqtt')) {
      channels.push('mqtt');
    }
```

- [ ] **Step 5: Tests und Typecheck ausführen**

```bash
pnpm --filter @tm/server test && pnpm --filter @tm/server typecheck
```
Erwartet: PASS, einschließlich aller bestehenden Tests aus Plan 1. Scheitert ein älterer Test an der neuen `execute`-Rückgabe (Array statt Objekt), passe ihn an. `grep -rn "\.execute(" packages/server` zeigt die Stellen, bisher gibt es nur die im Fake selbst.

- [ ] **Step 6: Commit**

```bash
git add -A .
git commit -m "feat(server): fetch sensors, avoid MQTT with SetOption4, extend Tasmota fake with rules, timers and restarts"
```

---

### Task 6: Befehlsplanung pro Gerät (`planDevice`)

**Files:**
- Create: `tasmota_manager/packages/server/src/changes/planner.ts`
- Test: `tasmota_manager/packages/server/src/changes/planner.test.ts`

**Interfaces:**
- Consumes: `PendingRow` (Task 4), `settingDef`, `commandFor`, `SettingDef` aus `@tm/shared`, `splitCommand`, `isQuery` aus `../tasmota/commands`
- Produces:
  - `interface SendStep { command: string; changeIds: number[]; restarts: boolean; idempotent: boolean }`
  - `interface VerifyItem { changeId: number; def: SettingDef; expected: string }`
  - `interface DevicePlan { settings: SendStep[]; verifySettings: VerifyItem[]; commands: SendStep[]; restartBundle: SendStep | null; verifyRestart: VerifyItem[] }`
  - `isRestartCommand(command): boolean`
  - `planDevice(rows: readonly PendingRow[]): DevicePlan`

- [ ] **Step 1: Failing Test schreiben**

`tasmota_manager/packages/server/src/changes/planner.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isRestartCommand, planDevice } from './planner';
import type { PendingRow } from './store';

let nextId = 1;
const setting = (key: string, value: string): PendingRow => ({
  id: nextId++,
  deviceId: 'A',
  kind: 'setting',
  key,
  value,
  position: 0,
  source: 'form',
  error: null,
  updatedAt: 'now',
});
const command = (value: string, position: number): PendingRow => ({ ...setting('', value), kind: 'command', key: null, position });

describe('isRestartCommand', () => {
  it('erkennt Neustart-Befehle nur mit Argument', () => {
    expect(isRestartCommand('Restart 1')).toBe(true);
    expect(isRestartCommand('Topic keller')).toBe(true);
    expect(isRestartCommand('MqttHost')).toBe(false);
    expect(isRestartCommand('Template {"NAME":"x"}')).toBe(false);
    expect(isRestartCommand('Power ON')).toBe(false);
  });
});

describe('planDevice', () => {
  it('schreibt Einstellungen in Katalog-Reihenfolge, Befehle danach, Neustart-Einstellungen gebündelt zuletzt', () => {
    const rows = [
      setting('MqttUser', 'u1'),
      command('Power ON', 2),
      setting('TelePeriod', '60'),
      setting('MqttHost', 'neu.local'),
      command('Restart 1', 1),
      setting('PowerOnState', '1'),
      setting('MqttPassword', 'geheim'),
    ];
    const plan = planDevice(rows);
    expect(plan.settings.map((s) => s.command)).toEqual(['PowerOnState 1', 'TelePeriod 60']);
    expect(plan.commands.map((s) => [s.command, s.restarts, s.idempotent])).toEqual([
      ['Restart 1', true, false],
      ['Power ON', false, false],
    ]);
    expect(plan.restartBundle?.command).toBe('Backlog MqttHost neu.local; MqttUser u1; MqttPassword geheim');
    expect(plan.restartBundle?.changeIds).toHaveLength(3);
    expect(plan.verifySettings.map((v) => v.def.key)).toEqual(['PowerOnState', 'TelePeriod']);
    // Das Passwort ist write-only und wird nicht zurückgelesen.
    expect(plan.verifyRestart.map((v) => v.def.key)).toEqual(['MqttHost', 'MqttUser']);
  });

  it('setzt den Rule-Text vor dem Aktivieren', () => {
    const plan = planDevice([setting('Rule1Enabled', '1'), setting('Rule1', 'ON x DO y ENDON')]);
    expect(plan.settings.map((s) => s.command)).toEqual(['Rule1 ON x DO y ENDON', 'Rule1 1']);
  });

  it('liefert einen leeren Plan ohne Einträge', () => {
    expect(planDevice([])).toEqual({ settings: [], verifySettings: [], commands: [], restartBundle: null, verifyRestart: [] });
  });
});
```

- [ ] **Step 2: Test ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test -- planner
```
Erwartet: FAIL (`./planner` fehlt).

- [ ] **Step 3: Implementieren**

`tasmota_manager/packages/server/src/changes/planner.ts`:
```ts
import { type SettingDef, commandFor, settingDef } from '@tm/shared';
import { isQuery, splitCommand } from '../tasmota/commands';
import type { PendingRow } from './store';

export interface SendStep {
  command: string;
  changeIds: number[];
  /** Nach dem Befehl auf den Neustart warten. */
  restarts: boolean;
  /** Darf nach einem Timeout wiederholt werden. */
  idempotent: boolean;
}

export interface VerifyItem {
  changeId: number;
  def: SettingDef;
  expected: string;
}

export interface DevicePlan {
  /** Einstellungen ohne Neustart inkl. Rules und Timer, in Katalog-Reihenfolge. */
  settings: SendStep[];
  verifySettings: VerifyItem[];
  commands: SendStep[];
  /** Alle Einstellungen mit Neustart als ein einziger Backlog. */
  restartBundle: SendStep | null;
  verifyRestart: VerifyItem[];
}

// Befehle, nach denen Tasmota zuverlässig neu startet. Template (nur mit Module 0) und Upgrade (OTA, kann > 90 s dauern) fehlen bewusst.
const RESTART_COMMANDS = new Set([
  'RESTART',
  'MODULE',
  'TOPIC',
  'FULLTOPIC',
  'GROUPTOPIC',
  'HOSTNAME',
  'WIFICONFIG',
  'SSID1',
  'SSID2',
  'PASSWORD1',
  'PASSWORD2',
  'IPADDRESS1',
  'IPADDRESS2',
  'IPADDRESS3',
  'IPADDRESS4',
  'MQTTHOST',
  'MQTTPORT',
  'MQTTUSER',
  'MQTTPASSWORD',
  'MQTTCLIENT',
  'RESET',
]);

export function isRestartCommand(command: string): boolean {
  const { name, args } = splitCommand(command);
  return args !== '' && RESTART_COMMANDS.has(name.toUpperCase());
}

interface SettingRow {
  row: PendingRow;
  def: SettingDef;
}

const toVerify = (list: SettingRow[]): VerifyItem[] =>
  list.filter((s) => !s.def.writeOnly).map((s) => ({ changeId: s.row.id, def: s.def, expected: s.row.value }));

export function planDevice(rows: readonly PendingRow[]): DevicePlan {
  const settings: SettingRow[] = rows
    .filter((r) => r.kind === 'setting' && r.key)
    .flatMap((row) => {
      const def = settingDef(row.key ?? '');
      return def ? [{ row, def }] : [];
    })
    .sort((a, b) => a.def.order - b.def.order);
  const plain = settings.filter((s) => !s.def.restarts);
  const restarting = settings.filter((s) => s.def.restarts);

  return {
    settings: plain.map((s) => ({ command: commandFor(s.def, s.row.value), changeIds: [s.row.id], restarts: false, idempotent: true })),
    verifySettings: toVerify(plain),
    commands: rows
      .filter((r) => r.kind === 'command')
      .sort((a, b) => a.position - b.position || a.id - b.id)
      .map((r) => ({ command: r.value, changeIds: [r.id], restarts: isRestartCommand(r.value), idempotent: isQuery(r.value) })),
    restartBundle:
      restarting.length === 0
        ? null
        : {
            command: `Backlog ${restarting.map((s) => commandFor(s.def, s.row.value)).join('; ')}`,
            changeIds: restarting.map((s) => s.row.id),
            restarts: true,
            idempotent: true,
          },
    verifyRestart: toVerify(restarting),
  };
}
```

- [ ] **Step 4: Tests und Typecheck ausführen**

```bash
pnpm --filter @tm/server test && pnpm --filter @tm/server typecheck
```
Erwartet: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A .
git commit -m "feat(server): plan per-device write order with single restart bundle"
```

---

### Task 7: Geräteoperationen (Neustart erkennen, Wiederholen)

**Files:**
- Create: `tasmota_manager/packages/server/src/changes/deviceOps.ts`
- Test: `tasmota_manager/packages/server/src/changes/deviceOps.test.ts`

**Interfaces:**
- Consumes: `DeviceGateway.send(id, command, timeoutMs?) → Promise<SendResult>`, `TransportError`, `isObj`
- Produces:
  - `interface DeviceOpsOptions { restartTimeoutMs?: number; pollIntervalMs?: number; commandTimeoutMs?: number }` mit den Standardwerten 90 000, 2000 und 10 000 ms
  - `class DeviceOps` mit folgenden Methoden:

| Methode | Verhalten |
|---|---|
| `uptime(deviceId, timeoutMs?)` | `Promise<number>` aus `Status 11` |
| `waitForRestart(deviceId, uptimeBefore)` | `Promise<void>`; nach 90 s `TransportError('offline')` |
| `send(deviceId, command, idempotent)` | `Promise<SendResult>`; wiederholt mit steigenden Pausen innerhalb des 90-s-Fensters bei `unreachable`/`offline` und, falls `idempotent`, bei `timeout` |
| `query(deviceId, command)` | `Promise<unknown>`; genau ein Versuch |

- [ ] **Step 1: Failing Test schreiben**

`tasmota_manager/packages/server/src/changes/deviceOps.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { FakeTasmota } from '../../test/fakes/fakeTasmota';
import { testDb } from '../../test/helpers';
import { identifyHost } from '../discovery/identify';
import { DeviceGateway, type SendResult } from '../gateway';
import { DeviceRegistry } from '../registry';
import { TransportError } from '../transport/errors';
import { HttpTransport } from '../transport/http';
import { DeviceOps } from './deviceOps';

const MAC = 'AABBCC112233';
const http = new HttpTransport(500);
let fake: FakeTasmota | null = null;

afterEach(async () => {
  await fake?.stop();
  fake = null;
});

async function withFake(downtimeMs: number) {
  fake = await new FakeTasmota({ mac: MAC, restartDelayMs: 20, downtimeMs }).start();
  const registry = new DeviceRegistry(testDb());
  await identifyHost(http, registry, fake.host, null);
  const gateway = new DeviceGateway({ registry, http, mqtt: null, globalPassword: () => null });
  return new DeviceOps(gateway, { restartTimeoutMs: 1500, pollIntervalMs: 30, commandTimeoutMs: 300 });
}

class StubGateway {
  calls = 0;
  constructor(private readonly outcomes: Array<TransportError | unknown>) {}
  async send(): Promise<SendResult> {
    const outcome = this.outcomes[Math.min(this.calls, this.outcomes.length - 1)];
    this.calls++;
    if (outcome instanceof TransportError) throw outcome;
    return { channel: 'http', response: outcome };
  }
}

describe('DeviceOps', () => {
  it('liest die Laufzeit', async () => {
    const ops = await withFake(100);
    expect(await ops.uptime(MAC)).toBe(100);
  });

  it('erkennt einen Neustart an der kleineren Laufzeit', async () => {
    const ops = await withFake(150);
    const before = await ops.uptime(MAC);
    await ops.send(MAC, 'Restart 1', false);
    await ops.waitForRestart(MAC, before);
    expect(fake?.restarts).toBe(1);
  });

  it('meldet offline, wenn das Gerät nicht zurückkommt', async () => {
    const ops = await withFake(60_000);
    const before = await ops.uptime(MAC);
    await ops.send(MAC, 'Restart 1', false);
    await expect(ops.waitForRestart(MAC, before)).rejects.toMatchObject({ code: 'offline' });
  });

  it('wiederholt bei nicht erreichbarem Gerät', async () => {
    const gateway = new StubGateway([new TransportError('unreachable', 'x'), new TransportError('unreachable', 'x'), { ok: 1 }]);
    const ops = new DeviceOps(gateway as unknown as DeviceGateway, { restartTimeoutMs: 1000, pollIntervalMs: 10 });
    expect((await ops.send(MAC, 'LedState 1', true)).response).toEqual({ ok: 1 });
    expect(gateway.calls).toBe(3);
  });

  it('wiederholt nicht idempotente Befehle nach einem Timeout nicht', async () => {
    const gateway = new StubGateway([new TransportError('timeout', 'x'), { ok: 1 }]);
    const ops = new DeviceOps(gateway as unknown as DeviceGateway, { restartTimeoutMs: 1000, pollIntervalMs: 10 });
    await expect(ops.send(MAC, 'Power TOGGLE', false)).rejects.toMatchObject({ code: 'timeout' });
    expect(gateway.calls).toBe(1);
  });

  it('gibt abgelehnte Befehle sofort weiter', async () => {
    const gateway = new StubGateway([new TransportError('rejected', 'x')]);
    const ops = new DeviceOps(gateway as unknown as DeviceGateway, { restartTimeoutMs: 1000, pollIntervalMs: 10 });
    await expect(ops.send(MAC, 'Foo', true)).rejects.toMatchObject({ code: 'rejected' });
    expect(gateway.calls).toBe(1);
  });
});
```

- [ ] **Step 2: Test ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test -- deviceOps
```
Erwartet: FAIL (`./deviceOps` fehlt).

- [ ] **Step 3: Implementieren**

`tasmota_manager/packages/server/src/changes/deviceOps.ts`:
```ts
import type { DeviceGateway, SendResult } from '../gateway';
import { isObj } from '../tasmota/parse';
import { TransportError } from '../transport/errors';

export interface DeviceOpsOptions {
  restartTimeoutMs?: number;
  pollIntervalMs?: number;
  commandTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MAX_BACKOFF_MS = 10_000;

export class DeviceOps {
  readonly restartTimeoutMs: number;
  private readonly pollMs: number;
  private readonly commandTimeoutMs: number;

  constructor(
    private readonly gateway: Pick<DeviceGateway, 'send'>,
    opts: DeviceOpsOptions = {},
  ) {
    this.restartTimeoutMs = opts.restartTimeoutMs ?? 90_000;
    this.pollMs = opts.pollIntervalMs ?? 2000;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 10_000;
  }

  async uptime(deviceId: string, timeoutMs = this.commandTimeoutMs): Promise<number> {
    const { response } = await this.gateway.send(deviceId, 'Status 11', timeoutMs);
    const sts = isObj(response) && isObj(response.StatusSTS) ? response.StatusSTS : null;
    const uptime = sts ? Number(sts.UptimeSec) : Number.NaN;
    if (!Number.isFinite(uptime)) throw new TransportError('rejected', 'Status 11 enthält keine UptimeSec');
    return uptime;
  }

  /** Der Online-Status allein reicht nicht: Tasmota startet erst 1–2 s nach dem Befehl neu. */
  async waitForRestart(deviceId: string, uptimeBefore: number): Promise<void> {
    const deadline = Date.now() + this.restartTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.pollMs);
      try {
        if ((await this.uptime(deviceId, Math.min(this.commandTimeoutMs, 3000))) < uptimeBefore) return;
      } catch {
        // Gerät startet noch neu.
      }
    }
    throw new TransportError(
      'offline',
      `Gerät ist nach dem Neustart nicht innerhalb von ${Math.round(this.restartTimeoutMs / 1000)} s zurückgekommen`,
    );
  }

  /** Sendet mit Wiederholungen, falls der Befehl sicher nicht ausgeführt wurde (oder gefahrlos wiederholbar ist). */
  async send(deviceId: string, command: string, idempotent: boolean): Promise<SendResult> {
    const deadline = Date.now() + this.restartTimeoutMs;
    let delay = this.pollMs;
    for (;;) {
      try {
        return await this.gateway.send(deviceId, command, this.commandTimeoutMs);
      } catch (err) {
        if (!(err instanceof TransportError)) throw err;
        const retriable = err.code === 'unreachable' || err.code === 'offline' || (err.code === 'timeout' && idempotent);
        if (!retriable || Date.now() + delay > deadline) throw err;
        await sleep(delay);
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      }
    }
  }

  async query(deviceId: string, command: string): Promise<unknown> {
    return (await this.gateway.send(deviceId, command, this.commandTimeoutMs)).response;
  }
}
```

- [ ] **Step 4: Tests und Typecheck ausführen**

```bash
pnpm --filter @tm/server test && pnpm --filter @tm/server typecheck
```
Erwartet: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A .
git commit -m "feat(server): detect device restarts via uptime and retry safe commands"
```

---

### Task 8: Jobs und Batch-Ausführung (`JobRepo`, `ApplyRunner`)

**Files:**
- Create: `tasmota_manager/packages/server/src/changes/jobs.ts`
- Create: `tasmota_manager/packages/server/src/changes/runner.ts`
- Test: `tasmota_manager/packages/server/src/changes/jobs.test.ts`
- Test: `tasmota_manager/packages/server/src/changes/runner.test.ts`

**Interfaces:**
- Consumes:
  - `PendingStore` (Task 4), `planDevice`/`SendStep`/`VerifyItem` (Task 6), `DeviceOps` (Task 7)
  - `extractValue`, `readCommand`, `valuesEqual` (Task 3)
  - `DeviceRegistry`, `parseStatus0`, `TransportError`, `mapLimit`
- Produces:
  - `INTERRUPTED` (Fehlertext)
  - `interface NewJobItem { deviceId; deviceName; changeIds: number[] }`
  - `class JobRepo`:

| Methode | Rückgabe |
|---|---|
| `create(items)` | `JobView` |
| `changeIdsOf(jobId, deviceId)` | `number[]` |
| `updateItem(jobId, deviceId, patch)` | `JobItem` |
| `finish(jobId)` | `JobView` |
| `get(jobId)` | `JobView \| null` |
| `latest()` | `JobView \| null` |
| `recoverInterrupted()` | `number[]` (betroffene Change-IDs) |

  - `class RunnerBusyError`, `class NothingToApplyError`
  - `interface RunnerDeps { store; jobs; registry; ops; concurrency: () => number; log: Logger }`
  - `class ApplyRunner extends EventEmitter<{ progress: [number, JobItem]; done: [JobView] }>` mit `running: boolean`, `start(deviceIds?): JobView` und `waitIdle(): Promise<void>`

- [ ] **Step 1: Failing Tests schreiben**

`tasmota_manager/packages/server/src/changes/jobs.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { testDb } from '../../test/helpers';
import { INTERRUPTED, JobRepo } from './jobs';

describe('JobRepo', () => {
  it('legt Jobs an, aktualisiert Items und schließt ab', () => {
    const jobs = new JobRepo(testDb(), () => new Date('2026-09-29T12:00:00Z'));
    const job = jobs.create([{ deviceId: 'A', deviceName: 'Keller', changeIds: [1, 2] }]);
    expect(job).toMatchObject({ status: 'running', items: [{ deviceId: 'A', deviceName: 'Keller', status: 'pending', step: null, error: null }] });
    expect(jobs.changeIdsOf(job.id, 'A')).toEqual([1, 2]);
    expect(jobs.updateItem(job.id, 'A', { status: 'running', step: 'write' })).toMatchObject({ status: 'running', step: 'write' });
    expect(jobs.finish(job.id)).toMatchObject({ status: 'done', finishedAt: '2026-09-29T12:00:00.000Z' });
    expect(jobs.latest()?.id).toBe(job.id);
  });

  it('markiert beim Start unterbrochene Jobs', () => {
    const jobs = new JobRepo(testDb());
    const job = jobs.create([
      { deviceId: 'A', deviceName: 'A', changeIds: [1] },
      { deviceId: 'B', deviceName: 'B', changeIds: [2, 3] },
      { deviceId: 'C', deviceName: 'C', changeIds: [4] },
    ]);
    jobs.updateItem(job.id, 'A', { status: 'success' });
    jobs.updateItem(job.id, 'B', { status: 'running' });
    expect(jobs.recoverInterrupted().sort()).toEqual([2, 3, 4]);
    const recovered = jobs.get(job.id);
    expect(recovered?.status).toBe('done');
    expect(recovered?.items.map((i) => [i.deviceId, i.status, i.error])).toEqual([
      ['A', 'success', null],
      ['B', 'failed', INTERRUPTED],
      ['C', 'failed', INTERRUPTED],
    ]);
    expect(jobs.recoverInterrupted()).toEqual([]);
  });
});
```

`tasmota_manager/packages/server/src/changes/runner.test.ts`:
```ts
import type { StageRequest } from '@tm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { startBroker } from '../../test/fakes/broker';
import { FakeTasmota, type FakeTasmotaOptions } from '../../test/fakes/fakeTasmota';
import { silentLogger, testDb, waitFor } from '../../test/helpers';
import { identifyHost } from '../discovery/identify';
import { MqttDiscovery } from '../discovery/mqttDiscovery';
import { DeviceGateway } from '../gateway';
import { DeviceRegistry } from '../registry';
import { HttpTransport } from '../transport/http';
import { MqttTransport } from '../transport/mqtt';
import { DeviceOps } from './deviceOps';
import { INTERRUPTED, JobRepo } from './jobs';
import { ApplyRunner, NothingToApplyError, RunnerBusyError } from './runner';
import { PendingStore } from './store';

const MAC = 'AABBCC112233';
const http = new HttpTransport(500);

interface Ctx {
  fake: FakeTasmota;
  registry: DeviceRegistry;
  store: PendingStore;
  jobs: JobRepo;
  runner: ApplyRunner;
  cleanup: () => Promise<void>;
}

let ctx: Ctx | null = null;

afterEach(async () => {
  await ctx?.runner.waitIdle();
  await ctx?.cleanup();
  ctx = null;
});

async function httpSetup(fakeOpts: Partial<FakeTasmotaOptions> = {}, restartTimeoutMs = 3000): Promise<Ctx> {
  const db = testDb();
  const registry = new DeviceRegistry(db);
  const fake = await new FakeTasmota({ mac: MAC, restartDelayMs: 20, downtimeMs: 150, ...fakeOpts }).start();
  await identifyHost(http, registry, fake.host, null);
  const gateway = new DeviceGateway({ registry, http, mqtt: null, globalPassword: () => null });
  const ops = new DeviceOps(gateway, { restartTimeoutMs, pollIntervalMs: 30, commandTimeoutMs: 300 });
  const store = new PendingStore(db, registry);
  const jobs = new JobRepo(db);
  const runner = new ApplyRunner({ store, jobs, registry, ops, concurrency: () => 5, log: silentLogger });
  ctx = { fake, registry, store, jobs, runner, cleanup: () => fake.stop() };
  return ctx;
}

async function run(c: Ctx, req: Omit<StageRequest, 'deviceIds'>) {
  c.store.stage({ deviceIds: [MAC], ...req } as StageRequest);
  c.runner.start();
  await c.runner.waitIdle();
  return c.jobs.latest()?.items[0];
}

describe('ApplyRunner über HTTP', () => {
  it('schreibt Einstellungen ohne Neustart, prüft sie und leert den Puffer', async () => {
    const c = await httpSetup();
    const item = await run(c, { settings: { PowerOnState: '1', LedState: '0', Rule1: 'ON x DO y ENDON', Rule1Enabled: '1' }, source: 'form' });
    expect(item).toMatchObject({ status: 'success', error: null, step: null });
    expect(c.fake.values.PowerOnState).toBe('1');
    expect(c.fake.values.LedState).toBe('0');
    expect(c.fake.rules[0]).toEqual({ state: true, text: 'ON x DO y ENDON' });
    expect(c.fake.restarts).toBe(0);
    expect(c.store.count()).toBe(0);
  });

  it('bündelt Einstellungen mit Neustart in einem Backlog und startet genau einmal neu', async () => {
    const c = await httpSetup();
    const item = await run(c, { settings: { MqttHost: 'neu.local', MqttUser: 'u1', MqttPassword: 'pw', TelePeriod: '60' }, source: 'form' });
    expect(item?.status).toBe('success');
    expect(c.fake.values.MqttHost).toBe('neu.local');
    expect(c.fake.values.TelePeriod).toBe('60');
    expect(c.fake.restarts).toBe(1);
    expect(c.fake.received.filter((cmd) => cmd.startsWith('Backlog'))).toEqual(['Backlog MqttHost neu.local; MqttUser u1; MqttPassword pw']);
    expect(c.store.count()).toBe(0);
  });

  it('wartet nach Neustart-Befehlen unter den freien Befehlen', async () => {
    const c = await httpSetup();
    const item = await run(c, { commands: ['Restart 1', 'FriendlyName1 Danach'], source: 'command' });
    expect(item?.status).toBe('success');
    expect(c.fake.restarts).toBe(1);
    expect(c.fake.values.FriendlyName1).toBe('Danach');
  });

  it('markiert abgelehnte Befehle und macht mit den übrigen weiter', async () => {
    const c = await httpSetup();
    c.store.stage({ deviceIds: [MAC], commands: ['Foo'], source: 'command' });
    const item = await run(c, { settings: { LedState: '2' }, source: 'form' });
    expect(item?.status).toBe('failed');
    expect(c.fake.values.LedState).toBe('2');
    const remaining = c.store.forDevice(MAC);
    expect(remaining.map((r) => r.value)).toEqual(['Foo']);
    expect(remaining[0]?.error).toMatch(/^rejected/);
  });

  it('lässt Einträge stehen, wenn das Gerät nach dem Neustart nicht zurückkommt', async () => {
    const c = await httpSetup({ downtimeMs: 60_000 }, 400);
    const item = await run(c, { settings: { TelePeriod: '60', MqttHost: 'weg.local' }, source: 'form' });
    expect(item?.status).toBe('failed');
    const remaining = c.store.forDevice(MAC);
    expect(remaining.map((r) => r.key)).toEqual(['MqttHost']);
    expect(remaining[0]?.error).toMatch(/^offline/);
  });

  it('meldet Abweichungen beim Prüfen', async () => {
    const c = await httpSetup({ ignore: ['LedState'] });
    const item = await run(c, { settings: { LedState: '5' }, source: 'form' });
    expect(item?.status).toBe('failed');
    expect(c.store.forDevice(MAC)[0]?.error).toBe('verify_mismatch: Soll „5“, Ist „1“');
  });

  it('verhindert parallele Läufe und leere Starts', async () => {
    const c = await httpSetup();
    expect(() => c.runner.start()).toThrow(NothingToApplyError);
    c.store.stage({ deviceIds: [MAC], settings: { LedState: '2' }, source: 'form' });
    c.runner.start();
    expect(c.runner.running).toBe(true);
    expect(() => c.runner.start()).toThrow(RunnerBusyError);
    await c.runner.waitIdle();
    expect(c.runner.running).toBe(false);
  });

  it('meldet Fortschritt pro Gerät', async () => {
    const c = await httpSetup();
    const steps: string[] = [];
    c.runner.on('progress', (_jobId, item) => steps.push(`${item.status}:${item.step ?? '-'}`));
    const done: number[] = [];
    c.runner.on('done', (job) => done.push(job.id));
    await run(c, { settings: { LedState: '2' }, source: 'form' });
    expect(steps[0]).toBe('running:write');
    expect(steps).toContain('running:verify');
    expect(steps.at(-1)).toBe('success:-');
    expect(done).toHaveLength(1);
  });

  it('übernimmt beim App-Start unterbrochene Läufe als Fehler', async () => {
    const c = await httpSetup();
    c.store.stage({ deviceIds: [MAC], settings: { LedState: '2' }, source: 'form' });
    const ids = c.store.forDevice(MAC).map((r) => r.id);
    const job = c.jobs.create([{ deviceId: MAC, deviceName: 'Tasmota', changeIds: ids }]);
    c.jobs.updateItem(job.id, MAC, { status: 'running' });
    c.store.fail(c.jobs.recoverInterrupted(), INTERRUPTED);
    expect(c.store.forDevice(MAC)[0]?.error).toBe(INTERRUPTED);
    expect(c.jobs.get(job.id)?.status).toBe('done');
  });
});

describe('ApplyRunner über MQTT', () => {
  it('schreibt über MQTT, wartet den Neustart ab und kommt nach dem Reconnect weiter', async () => {
    const broker = await startBroker();
    const db = testDb();
    const registry = new DeviceRegistry(db);
    const mqtt = new MqttTransport({ url: broker.url, timeoutMs: 500 });
    new MqttDiscovery(mqtt, registry, silentLogger).start();
    mqtt.start();
    await waitFor(() => mqtt.status === 'connected');
    const fake = new FakeTasmota({ mac: MAC, topic: 'keller', advertiseIp: false, restartDelayMs: 20, downtimeMs: 200 });
    await fake.connectMqtt(broker.url);
    await waitFor(() => registry.get(MAC)?.channels.includes('mqtt') && registry.get(MAC)?.chip);

    const gateway = new DeviceGateway({ registry, http, mqtt, globalPassword: () => null });
    const ops = new DeviceOps(gateway, { restartTimeoutMs: 5000, pollIntervalMs: 50, commandTimeoutMs: 500 });
    const store = new PendingStore(db, registry);
    const jobs = new JobRepo(db);
    const runner = new ApplyRunner({ store, jobs, registry, ops, concurrency: () => 5, log: silentLogger });
    ctx = {
      fake,
      registry,
      store,
      jobs,
      runner,
      cleanup: async () => {
        await mqtt.stop();
        await fake.stop();
        await broker.close();
      },
    };

    store.stage({ deviceIds: [MAC], settings: { LedState: '2', MqttUser: 'neu' }, source: 'form' });
    runner.start();
    await runner.waitIdle();
    expect(jobs.latest()?.items[0]?.status).toBe('success');
    expect(fake.values.LedState).toBe('2');
    expect(fake.values.MqttUser).toBe('neu');
    expect(fake.restarts).toBe(1);
    expect(store.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Tests ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test -- changes/jobs changes/runner
```
Erwartet: FAIL (`./jobs` und `./runner` fehlen).

- [ ] **Step 3: `JobRepo` implementieren**

`tasmota_manager/packages/server/src/changes/jobs.ts`:
```ts
import type { JobItem, JobItemStatus, JobStep, JobView } from '@tm/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { jobItems, jobs } from '../db/schema';

export const INTERRUPTED = 'interrupted: Die App wurde während des Batch-Laufs neu gestartet';

export interface NewJobItem {
  deviceId: string;
  deviceName: string;
  changeIds: number[];
}

type JobRow = typeof jobs.$inferSelect;
type JobItemRow = typeof jobItems.$inferSelect;
export type JobItemPatch = Partial<{ status: JobItemStatus; step: JobStep | null; error: string | null }>;

const toItem = (row: JobItemRow): JobItem => ({
  deviceId: row.deviceId,
  deviceName: row.deviceName,
  status: row.status,
  step: row.step,
  error: row.error,
});

export class JobRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(items: NewJobItem[]): JobView {
    const job = this.db.insert(jobs).values({ type: 'apply', status: 'running', createdAt: this.now().toISOString() }).returning().get();
    for (const item of items) {
      this.db.insert(jobItems).values({ jobId: job.id, ...item, status: 'pending' }).run();
    }
    return this.view(job);
  }

  changeIdsOf(jobId: number, deviceId: string): number[] {
    return this.itemRow(jobId, deviceId)?.changeIds ?? [];
  }

  updateItem(jobId: number, deviceId: string, patch: JobItemPatch): JobItem {
    this.db
      .update(jobItems)
      .set(patch)
      .where(and(eq(jobItems.jobId, jobId), eq(jobItems.deviceId, deviceId)))
      .run();
    const row = this.itemRow(jobId, deviceId);
    if (!row) throw new Error(`Unbekanntes Job-Item ${jobId}/${deviceId}`);
    return toItem(row);
  }

  finish(jobId: number): JobView {
    this.db.update(jobs).set({ status: 'done', finishedAt: this.now().toISOString() }).where(eq(jobs.id, jobId)).run();
    const view = this.get(jobId);
    if (!view) throw new Error(`Unbekannter Job ${jobId}`);
    return view;
  }

  get(jobId: number): JobView | null {
    const row = this.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row ? this.view(row) : null;
  }

  latest(): JobView | null {
    const row = this.db.select().from(jobs).orderBy(desc(jobs.id)).limit(1).get();
    return row ? this.view(row) : null;
  }

  /** Nach einem App-Neustart: offene Items als unterbrochen markieren und deren Change-IDs liefern. */
  recoverInterrupted(): number[] {
    const changeIds: number[] = [];
    for (const job of this.db.select().from(jobs).where(eq(jobs.status, 'running')).all()) {
      for (const item of this.db.select().from(jobItems).where(eq(jobItems.jobId, job.id)).all()) {
        if (item.status !== 'pending' && item.status !== 'running') continue;
        changeIds.push(...item.changeIds);
        this.db.update(jobItems).set({ status: 'failed', step: null, error: INTERRUPTED }).where(eq(jobItems.id, item.id)).run();
      }
      this.db.update(jobs).set({ status: 'done', finishedAt: this.now().toISOString() }).where(eq(jobs.id, job.id)).run();
    }
    return changeIds;
  }

  private itemRow(jobId: number, deviceId: string): JobItemRow | undefined {
    return this.db
      .select()
      .from(jobItems)
      .where(and(eq(jobItems.jobId, jobId), eq(jobItems.deviceId, deviceId)))
      .get();
  }

  private view(row: JobRow): JobView {
    const items = this.db.select().from(jobItems).where(eq(jobItems.jobId, row.id)).orderBy(asc(jobItems.id)).all();
    return { id: row.id, status: row.status, createdAt: row.createdAt, finishedAt: row.finishedAt, items: items.map(toItem) };
  }
}
```

- [ ] **Step 4: `ApplyRunner` implementieren**

`tasmota_manager/packages/server/src/changes/runner.ts`:
```ts
import { EventEmitter } from 'node:events';
import type { JobItem, JobView } from '@tm/shared';
import type { Logger } from 'pino';
import type { DeviceRegistry } from '../registry';
import { parseStatus0 } from '../tasmota/parse';
import { TransportError } from '../transport/errors';
import { mapLimit } from '../util/mapLimit';
import { extractValue, readCommand, valuesEqual } from './catalog';
import type { DeviceOps } from './deviceOps';
import type { JobItemPatch, JobRepo } from './jobs';
import { type SendStep, type VerifyItem, planDevice } from './planner';
import type { PendingStore } from './store';

export class RunnerBusyError extends Error {}
export class NothingToApplyError extends Error {}

export interface RunnerDeps {
  store: PendingStore;
  jobs: JobRepo;
  registry: DeviceRegistry;
  ops: DeviceOps;
  concurrency: () => number;
  log: Logger;
}

const describe = (err: unknown): string =>
  err instanceof TransportError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);

/** Ergebnis eines Geräts während eines Laufs. */
class DeviceRun {
  readonly done = new Set<number>();
  readonly failed = new Map<number, string>();
  aborted: string | null = null;

  succeed(ids: number[]): void {
    for (const id of ids) this.done.add(id);
  }

  fail(ids: number[], message: string): void {
    for (const id of ids) {
      this.done.delete(id);
      this.failed.set(id, message);
    }
  }

  failuresByMessage(): Map<string, number[]> {
    const grouped = new Map<string, number[]>();
    for (const [id, message] of this.failed) grouped.set(message, [...(grouped.get(message) ?? []), id]);
    return grouped;
  }

  firstError(): string | null {
    const first = this.failed.values().next();
    return first.done ? null : first.value;
  }
}

export class ApplyRunner extends EventEmitter<{ progress: [number, JobItem]; done: [JobView] }> {
  private current: Promise<void> | null = null;

  constructor(private readonly deps: RunnerDeps) {
    super();
  }

  get running(): boolean {
    return this.current !== null;
  }

  async waitIdle(): Promise<void> {
    await this.current;
  }

  start(deviceIds?: string[]): JobView {
    if (this.current) throw new RunnerBusyError('Es läuft bereits ein Batch');
    const { store, jobs, registry } = this.deps;
    const ids = (deviceIds ?? store.deviceIdsWithChanges()).filter((id) => store.forDevice(id).length > 0);
    if (ids.length === 0) throw new NothingToApplyError('Keine ausstehenden Änderungen');
    store.clearErrors(ids);
    const job = jobs.create(
      ids.map((id) => ({ deviceId: id, deviceName: registry.get(id)?.name ?? id, changeIds: store.forDevice(id).map((r) => r.id) })),
    );
    this.current = mapLimit(ids, this.deps.concurrency(), (id) => this.runSafe(job.id, id))
      .then(() => {
        this.emit('done', jobs.finish(job.id));
      })
      .catch((err: unknown) => this.deps.log.error({ err }, 'Batch-Lauf fehlgeschlagen'))
      .finally(() => {
        this.current = null;
      });
    return job;
  }

  private async runSafe(jobId: number, deviceId: string): Promise<void> {
    try {
      await this.runDevice(jobId, deviceId);
    } catch (err) {
      this.deps.log.error({ err, deviceId }, 'Batch-Lauf für ein Gerät abgebrochen');
      const message = describe(err);
      this.deps.store.fail(this.deps.jobs.changeIdsOf(jobId, deviceId), message);
      this.progress(jobId, deviceId, { status: 'failed', step: null, error: message });
    }
  }

  private async runDevice(jobId: number, deviceId: string): Promise<void> {
    const { store, registry } = this.deps;
    const ids = new Set(this.deps.jobs.changeIdsOf(jobId, deviceId));
    const plan = planDevice(store.forDevice(deviceId).filter((r) => ids.has(r.id)));
    const run = new DeviceRun();
    this.progress(jobId, deviceId, { status: 'running', step: 'write', error: null });

    // 1. Einstellungen ohne Neustart (inkl. Rules/Timer) schreiben und sofort prüfen.
    for (const step of plan.settings) await this.execute(jobId, deviceId, step, run);
    await this.verify(jobId, deviceId, plan.verifySettings, run);
    // 2. Freie Befehle, 3. alle Einstellungen mit Neustart in einem Backlog.
    for (const step of plan.commands) await this.execute(jobId, deviceId, step, run);
    if (plan.restartBundle) await this.execute(jobId, deviceId, plan.restartBundle, run);
    // 4. Nach MQTT-Änderungen nur prüfen, wenn das Gerät auch per HTTP erreichbar ist.
    const canVerifyRestart = plan.restartBundle === null || Boolean(registry.get(deviceId)?.ip);
    if (canVerifyRestart) await this.verify(jobId, deviceId, plan.verifyRestart, run);

    if (!run.aborted) await this.refreshStatus(deviceId);
    store.resolve([...run.done]);
    for (const [message, changeIds] of run.failuresByMessage()) store.fail(changeIds, message);
    this.progress(jobId, deviceId, { status: run.failed.size > 0 ? 'failed' : 'success', step: null, error: run.firstError() });
  }

  private async execute(jobId: number, deviceId: string, step: SendStep, run: DeviceRun): Promise<void> {
    if (run.aborted) {
      run.fail(step.changeIds, run.aborted);
      return;
    }
    const { ops } = this.deps;
    try {
      const before = step.restarts ? await ops.uptime(deviceId) : 0;
      await ops.send(deviceId, step.command, step.idempotent);
      if (step.restarts) {
        this.progress(jobId, deviceId, { step: 'restart' });
        await ops.waitForRestart(deviceId, before);
        this.progress(jobId, deviceId, { step: 'write' });
      }
      run.succeed(step.changeIds);
    } catch (err) {
      const message = describe(err);
      run.fail(step.changeIds, message);
      // Ein abgelehnter Befehl betrifft nur ihn selbst; alles andere (offline, timeout, auth) beendet das Gerät.
      if (!(err instanceof TransportError && err.code === 'rejected')) run.aborted = message;
    }
  }

  private async verify(jobId: number, deviceId: string, items: VerifyItem[], run: DeviceRun): Promise<void> {
    const open = items.filter((item) => run.done.has(item.changeId));
    if (open.length === 0) return;
    this.progress(jobId, deviceId, { step: 'verify' });
    for (const item of open) {
      if (run.aborted) {
        run.fail([item.changeId], run.aborted);
        continue;
      }
      try {
        const { response } = await this.deps.ops.send(deviceId, readCommand(item.def), true);
        const actual = extractValue(item.def, response);
        if (!valuesEqual(item.def, item.expected, actual)) {
          run.fail([item.changeId], `verify_mismatch: Soll „${item.expected}“, Ist „${actual ?? '—'}“`);
        }
      } catch (err) {
        const message = describe(err);
        run.fail([item.changeId], message);
        run.aborted = message;
      }
    }
    this.progress(jobId, deviceId, { step: 'write' });
  }

  /** Aktualisiert den gespeicherten Status, damit „vorher“-Werte stimmen. Die bekannte Adresse bleibt erhalten. */
  private async refreshStatus(deviceId: string): Promise<void> {
    try {
      const payload = await this.deps.ops.query(deviceId, 'Status 0');
      const info = parseStatus0(payload);
      if (!info) return;
      info.ip = undefined;
      this.deps.registry.upsert(info, { statusJson: payload });
    } catch {
      // Nicht kritisch; der nächste Poll bzw. Status-Refresh holt es nach.
    }
  }

  private progress(jobId: number, deviceId: string, patch: JobItemPatch): void {
    this.emit('progress', jobId, this.deps.jobs.updateItem(jobId, deviceId, patch));
  }
}
```

- [ ] **Step 5: Tests und Typecheck ausführen**

```bash
pnpm --filter @tm/server test && pnpm --filter @tm/server typecheck
```
Erwartet: PASS. Führe die Runner-Tests dreimal hintereinander aus (`pnpm --filter @tm/server test -- changes/runner`), um die Stabilität der Neustart-Tests zu prüfen. Timing-Probleme an der Ursache beheben, nicht durch längere Timeouts.

- [ ] **Step 6: Commit**

```bash
git add -A .
git commit -m "feat(server): run staged changes as persisted batch jobs with restart handling and verify"
```

---

### Task 9: Home-Assistant-Client

**Files:**
- Modify: `tasmota_manager/packages/server/package.json` (Abhängigkeit `ws`)
- Modify: `tasmota_manager/packages/server/src/config.ts`
- Modify: `tasmota_manager/packages/server/src/config.test.ts`
- Create: `tasmota_manager/packages/server/src/ha/client.ts`
- Create: `tasmota_manager/packages/server/test/fakes/haServer.ts`
- Test: `tasmota_manager/packages/server/src/ha/client.test.ts`

**Interfaces:**
- Consumes: `HaLink` aus `@tm/shared`, `normalizeMac`, `isObj`, pino `Logger`
- Produces:
  - `interface HaConfig { url: string; token: string }`
  - `AppConfig.ha?: HaConfig | null` in config.ts. Quelle ist `SUPERVISOR_TOKEN` → `ws://supervisor/core/websocket`, sonst `TM_HA_URL` + `TM_HA_TOKEN`.
  - `macOfHaDevice(device): string | null`
  - `class HaClient extends EventEmitter<{ changed: [] }>` mit folgenden Mitgliedern:

| Mitglied | Zweck |
|---|---|
| `link(mac): HaLink \| null` | Verknüpfung zu einem Tasmota |
| `start()` | Verbindung aufbauen |
| `stop(): Promise<void>` | Verbindung beenden |
| `refresh(): Promise<void>` | Registrys neu laden |
| `ready: boolean` | angemeldet und bereit |

  - Optionen: `{ refreshMs?: number; debounceMs?: number; requestTimeoutMs?: number }`
  - Test-Helfer `FakeHa`

- [ ] **Step 1: Abhängigkeit hinzufügen**

```bash
pnpm --filter @tm/server add ws@^8.18.0
```

- [ ] **Step 2: Failing Tests schreiben**

`tasmota_manager/packages/server/test/fakes/haServer.ts`:
```ts
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';

export interface FakeHaData {
  devices: Array<Record<string, unknown>>;
  entities: Array<Record<string, unknown>>;
  areas: Array<Record<string, unknown>>;
  related: Record<string, { automation?: string[] }>;
}

/** Minimaler Home-Assistant-WebSocket für Tests (Auth, Registrys, search/related, Events). */
export class FakeHa {
  readonly requests: string[] = [];
  connections = 0;
  port = 0;
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();

  constructor(
    public data: FakeHaData,
    private readonly token = 'geheim',
  ) {}

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  async start(): Promise<this> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.wss = wss;
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    this.port = (wss.address() as AddressInfo).port;
    wss.on('connection', (ws) => this.accept(ws));
    return this;
  }

  emitEvent(eventType: string): void {
    for (const ws of this.clients) ws.send(JSON.stringify({ id: 1, type: 'event', event: { event_type: eventType, data: {} } }));
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) ws.terminate();
    const wss = this.wss;
    this.wss = null;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  private accept(ws: WebSocket): void {
    this.connections++;
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.9.0' }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id?: number; type: string; access_token?: string; item_id?: string };
      if (msg.type === 'auth') {
        if (msg.access_token === this.token) {
          ws.send(JSON.stringify({ type: 'auth_ok', ha_version: '2026.9.0' }));
        } else {
          ws.send(JSON.stringify({ type: 'auth_invalid', message: 'Invalid access token or password' }));
          ws.close();
        }
        return;
      }
      this.requests.push(msg.type);
      const ok = (result: unknown) => ws.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result }));
      switch (msg.type) {
        case 'subscribe_events':
          ok(null);
          break;
        case 'config/device_registry/list':
          ok(this.data.devices);
          break;
        case 'config/entity_registry/list':
          ok(this.data.entities);
          break;
        case 'config/area_registry/list':
          ok(this.data.areas);
          break;
        case 'search/related':
          ok(this.data.related[msg.item_id ?? ''] ?? {});
          break;
        default:
          ws.send(JSON.stringify({ id: msg.id, type: 'result', success: false, error: { code: 'unknown_command', message: 'Unknown command.' } }));
      }
    });
  }
}
```

`tasmota_manager/packages/server/src/ha/client.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHa, type FakeHaData } from '../../test/fakes/haServer';
import { silentLogger, waitFor } from '../../test/helpers';
import { HaClient, macOfHaDevice } from './client';

const data = (): FakeHaData => ({
  devices: [
    { id: 'dev1', area_id: 'bad', connections: [['mac', 'aa:bb:cc:11:22:33']], identifiers: [] },
    { id: 'dev2', area_id: null, connections: [], identifiers: [['tasmota', 'AABBCC000002']] },
  ],
  entities: [
    { entity_id: 'switch.bad', device_id: 'dev1', unique_id: 'x', name: null, original_name: 'Bad Schalter' },
    { entity_id: 'sensor.bad_temp', device_id: 'dev1', unique_id: 'y', name: 'Temperatur Bad', original_name: 'Temperature' },
    { entity_id: 'automation.licht_bad', device_id: null, unique_id: '1700000000', name: null, original_name: 'Licht Bad' },
    { entity_id: 'automation.yaml_ohne_id', device_id: null, unique_id: null, name: null, original_name: null },
  ],
  areas: [{ area_id: 'bad', name: 'Bad' }],
  related: { dev1: { automation: ['automation.licht_bad', 'automation.yaml_ohne_id'] } },
});

let ha: FakeHa | null = null;
let client: HaClient | null = null;

afterEach(async () => {
  await client?.stop();
  await ha?.stop();
  client = null;
  ha = null;
});

describe('macOfHaDevice', () => {
  it('liest die MAC aus connections oder Tasmota-Identifiern', () => {
    expect(macOfHaDevice({ connections: [['mac', 'aa:bb:cc:11:22:33']] })).toBe('AABBCC112233');
    expect(macOfHaDevice({ identifiers: [['tasmota', 'AABBCC000002']] })).toBe('AABBCC000002');
    expect(macOfHaDevice({ identifiers: [['zha', 'x']] })).toBeNull();
  });
});

describe('HaClient', () => {
  it('ordnet Geräte zu und liefert Entitäten, Bereich und Automationen', async () => {
    ha = await new FakeHa(data()).start();
    client = new HaClient({ url: ha.url, token: 'geheim' }, silentLogger, { debounceMs: 20 });
    client.start();
    const link = await waitFor(() => client?.link('AABBCC112233'));
    expect(link).toEqual({
      deviceId: 'dev1',
      areaName: 'Bad',
      entities: [
        { entityId: 'switch.bad', name: 'Bad Schalter' },
        { entityId: 'sensor.bad_temp', name: 'Temperatur Bad' },
      ],
      automations: [
        { id: '1700000000', entityId: 'automation.licht_bad', name: 'Licht Bad' },
        { id: null, entityId: 'automation.yaml_ohne_id', name: 'automation.yaml_ohne_id' },
      ],
    });
    expect(client.link('AABBCC000002')).toMatchObject({ deviceId: 'dev2', areaName: null, entities: [], automations: [] });
  });

  it('lädt bei Registry-Events neu und meldet Änderungen', async () => {
    ha = await new FakeHa(data()).start();
    client = new HaClient({ url: ha.url, token: 'geheim' }, silentLogger, { debounceMs: 20 });
    let changed = 0;
    client.on('changed', () => changed++);
    client.start();
    await waitFor(() => client?.link('AABBCC112233'));
    ha.data.areas = [{ area_id: 'bad', name: 'Badezimmer' }];
    ha.emitEvent('area_registry_updated');
    await waitFor(() => client?.link('AABBCC112233')?.areaName === 'Badezimmer');
    expect(changed).toBeGreaterThanOrEqual(2);
  });

  it('gibt bei ungültigem Token auf, statt ständig neu zu verbinden', async () => {
    ha = await new FakeHa(data()).start();
    client = new HaClient({ url: ha.url, token: 'falsch' }, silentLogger, { debounceMs: 20 });
    client.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.ready).toBe(false);
    expect(client.link('AABBCC112233')).toBeNull();
    expect(ha.connections).toBe(1);
  });
});
```

In `tasmota_manager/packages/server/src/config.test.ts` im Block `describe('loadConfig', …)` anfügen:
```ts
  it('nutzt die HA-API des Supervisors bzw. TM_HA_URL', async () => {
    const supervised = await loadConfig({ TM_DATA_DIR: dataDir(), SUPERVISOR_TOKEN: 'tok' }, vi.fn().mockRejectedValue(new Error('x')));
    expect(supervised.ha).toEqual({ url: 'ws://supervisor/core/websocket', token: 'tok' });
    const local = await loadConfig({ TM_DATA_DIR: dataDir(), TM_HA_URL: 'ws://ha:8123/api/websocket', TM_HA_TOKEN: 't2' }, vi.fn());
    expect(local.ha).toEqual({ url: 'ws://ha:8123/api/websocket', token: 't2' });
    expect((await loadConfig({ TM_DATA_DIR: dataDir() }, vi.fn())).ha).toBeNull();
  });
```

- [ ] **Step 3: Tests ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test -- ha/client config
```
Erwartet: FAIL (`./client` fehlt, `ha` ist nicht in der Konfiguration).

- [ ] **Step 4: Konfiguration erweitern**

In `tasmota_manager/packages/server/src/config.ts`:

1. Nach `export interface MqttConfig …` einfügen:
```ts
export interface HaConfig {
  url: string;
  token: string;
}
```

2. In `AppConfig` nach `ingressOnly: boolean;` einfügen:
```ts
  /** Zugang zur Home-Assistant-API (optional). */
  ha?: HaConfig | null;
```

3. In `loadConfig` in das zurückgegebene Objekt aufnehmen (neben `ingressOnly`):
```ts
    ha: resolveHa(env),
```

4. Neue Funktion am Dateiende:
```ts
function resolveHa(env: NodeJS.ProcessEnv): HaConfig | null {
  if (env.SUPERVISOR_TOKEN) return { url: 'ws://supervisor/core/websocket', token: env.SUPERVISOR_TOKEN };
  if (env.TM_HA_URL && env.TM_HA_TOKEN) return { url: env.TM_HA_URL, token: env.TM_HA_TOKEN };
  return null;
}
```

Das Rückgabeobjekt von `loadConfig` wird im Code eventuell über eine Hilfsvariable zusammengesetzt (seit der Korrekturrunde gibt es `mqttLookupError`). Füge `ha` dort ein, wo die übrigen Felder gesetzt werden.

- [ ] **Step 5: `HaClient` implementieren**

`tasmota_manager/packages/server/src/ha/client.ts`:
```ts
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
```

- [ ] **Step 6: Tests und Typecheck ausführen**

```bash
pnpm --filter @tm/server test && pnpm --filter @tm/server typecheck
```
Erwartet: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A .
git commit -m "feat(server): read HA device, entity, area registries and related automations"
```

---

### Task 10: Namensvorschläge und Anreicherung der Geräte

**Files:**
- Create: `tasmota_manager/packages/server/src/naming.ts`
- Create: `tasmota_manager/packages/server/src/enrich.ts`
- Test: `tasmota_manager/packages/server/src/naming.test.ts`
- Test: `tasmota_manager/packages/server/src/enrich.test.ts`

**Interfaces:**
- Consumes:
  - `DeviceRegistry.list()` und `listRaw()` (Task 2)
  - `PendingStore.counts()` und `pendingNames()` (Task 4)
  - `HaClient.link()` (Task 9)
- Produces:
  - `isGenericName(name, module, hostname): boolean`
  - `relayCount(status0): number`
  - `deviceType(status0, sensors, module): string | null`
  - `interface NamingInput { id; name; hostname; module; status; sensors; areaName }`
  - `suggestNames(inputs): Map<id, string>`
  - `interface HaLookup { link(mac: string): HaLink | null }`
  - `class DeviceEnricher { all(): Device[]; one(id): Device | null }`

- [ ] **Step 1: Failing Tests schreiben**

`tasmota_manager/packages/server/src/naming.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { type NamingInput, deviceType, isGenericName, relayCount, suggestNames } from './naming';

const status = (sts: Record<string, unknown>) => ({ StatusSTS: sts });
const sensors = (sns: Record<string, unknown>) => ({ StatusSNS: sns });

describe('isGenericName', () => {
  it('erkennt generische Namen', () => {
    expect(isGenericName('Tasmota', null, null)).toBe(true);
    expect(isGenericName('tasmota_A1B2C3', null, null)).toBe(true);
    expect(isGenericName('', null, null)).toBe(true);
    expect(isGenericName('Sonoff Basic', 'Sonoff Basic', null)).toBe(true);
    expect(isGenericName('keller-1234', null, 'keller-1234')).toBe(true);
    expect(isGenericName('Keller Licht', 'Sonoff Basic', 'keller-1234')).toBe(false);
  });
});

describe('deviceType', () => {
  it('leitet den Typ aus Sensoren und Relais ab', () => {
    expect(relayCount(status({ POWER1: 'ON', POWER2: 'OFF', UptimeSec: 1 }))).toBe(2);
    expect(deviceType(status({ POWER: 'ON' }), sensors({ AM2301: { Temperature: 21, Humidity: 40 } }), null)).toBe('Klima');
    expect(deviceType(status({ POWER: 'ON' }), sensors({ ENERGY: { Power: 5 } }), null)).toBe('Steckdose');
    expect(deviceType(status({}), sensors({ ENERGY: { Power: 5 } }), null)).toBe('Energiezähler');
    expect(deviceType(status({ POWER: 'ON', Dimmer: 40 }), sensors({}), null)).toBe('Licht');
    expect(deviceType(status({ POWER: 'ON' }), sensors({}), 'Sonoff Basic')).toBe('Schalter');
    expect(deviceType(status({ POWER1: 'ON', POWER2: 'ON', POWER3: 'ON', POWER4: 'ON' }), sensors({}), null)).toBe('Schalter 4-fach');
    expect(deviceType(status({}), sensors({}), null)).toBeNull();
  });
});

describe('suggestNames', () => {
  const input = (partial: Partial<NamingInput> & { id: string }): NamingInput => ({
    name: 'Tasmota',
    hostname: null,
    module: null,
    status: status({ POWER: 'ON' }),
    sensors: sensors({}),
    areaName: null,
    ...partial,
  });

  it('kombiniert Typ und Bereich und nummeriert Kollisionen', () => {
    const result = suggestNames([
      input({ id: 'A', areaName: 'Küche', sensors: sensors({ ENERGY: {} }) }),
      input({ id: 'B', areaName: 'Küche', sensors: sensors({ ENERGY: {} }) }),
      input({ id: 'C', name: 'Steckdose Bad' }),
      input({ id: 'D', areaName: 'Bad', sensors: sensors({ ENERGY: {} }) }),
      input({ id: 'E' }),
    ]);
    expect(result.get('A')).toBe('Steckdose Küche');
    expect(result.get('B')).toBe('Steckdose Küche 2');
    expect(result.has('C')).toBe(false);
    expect(result.get('D')).toBe('Steckdose Bad 2');
    expect(result.get('E')).toBe('Schalter');
  });
});
```

`tasmota_manager/packages/server/src/enrich.test.ts`:
```ts
import type { HaLink } from '@tm/shared';
import { describe, expect, it } from 'vitest';
import { testDb } from '../test/helpers';
import { PendingStore } from './changes/store';
import { DeviceEnricher } from './enrich';
import { DeviceRegistry } from './registry';

describe('DeviceEnricher', () => {
  it('ergänzt HA-Links, Namensvorschläge und Pufferstatus', () => {
    const db = testDb();
    const registry = new DeviceRegistry(db);
    const store = new PendingStore(db, registry);
    registry.upsert(
      { mac: 'AABBCC000001', name: 'Tasmota' },
      { statusJson: { StatusSTS: { POWER: 'ON' } }, sensorsJson: { StatusSNS: { AM2301: { Temperature: 21 } } } },
    );
    registry.upsert({ mac: 'AABBCC000002', name: 'Tasmota' }, { statusJson: { StatusSTS: { POWER: 'ON' } } });
    const link: HaLink = { deviceId: 'dev1', areaName: 'Bad', entities: [], automations: [] };
    const enricher = new DeviceEnricher(registry, store, { link: (mac) => (mac === 'AABBCC000001' ? link : null) });

    store.stage({ deviceIds: ['AABBCC000002'], settings: { DeviceName: 'Flur', TelePeriod: '60' }, source: 'form' });
    const [first, second] = enricher.all().sort((a, b) => a.id.localeCompare(b.id));
    expect(first).toMatchObject({ id: 'AABBCC000001', ha: link, nameSuggestion: 'Klima Bad', pendingCount: 0, pendingName: null });
    expect(second).toMatchObject({ id: 'AABBCC000002', ha: null, nameSuggestion: null, pendingCount: 2, pendingName: 'Flur' });
    expect(enricher.one('AABBCC000001')?.nameSuggestion).toBe('Klima Bad');
    expect(enricher.one('GIBTSNICHT')).toBeNull();
  });
});
```

- [ ] **Step 2: Tests ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test -- naming enrich
```
Erwartet: FAIL (Module fehlen).

- [ ] **Step 3: Implementieren**

`tasmota_manager/packages/server/src/naming.ts`:
```ts
import { isObj } from './tasmota/parse';

const GENERIC = /^tasmota[_-][0-9a-f]{4,6}$/i;
const MAX_NAME = 32;

const rec = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});

export function isGenericName(name: string, module: string | null, hostname: string | null): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return (
    lower === 'tasmota' ||
    GENERIC.test(trimmed) ||
    (module !== null && lower === module.toLowerCase()) ||
    (hostname !== null && lower === hostname.toLowerCase())
  );
}

export function relayCount(status0: unknown): number {
  return Object.keys(rec(rec(status0).StatusSTS)).filter((k) => /^POWER\d*$/.test(k)).length;
}

function hasClimateSensor(sns: Record<string, unknown>): boolean {
  return Object.entries(sns).some(
    ([key, value]) => key === 'Temperature' || key === 'Humidity' || (isObj(value) && ('Temperature' in value || 'Humidity' in value)),
  );
}

function isLight(status0: unknown, module: string | null): boolean {
  const sts = rec(rec(status0).StatusSTS);
  return 'Dimmer' in sts || 'Color' in sts || 'CT' in sts || (module !== null && /dimmer|bulb|light|led|rgb/i.test(module));
}

/** Gerätetyp aus Sensoren (Status 10), Relais und Modul; erste passende Regel gewinnt. */
export function deviceType(status0: unknown, sensors: unknown, module: string | null): string | null {
  const sns = rec(rec(sensors).StatusSNS);
  const relays = relayCount(status0);
  if (hasClimateSensor(sns)) return 'Klima';
  if ('ENERGY' in sns) return relays > 0 ? 'Steckdose' : 'Energiezähler';
  if (isLight(status0, module)) return 'Licht';
  if (relays === 1) return 'Schalter';
  if (relays > 1) return `Schalter ${relays}-fach`;
  return null;
}

export interface NamingInput {
  id: string;
  /** Aktueller bzw. bereits vorgemerkter Name */
  name: string;
  hostname: string | null;
  module: string | null;
  status: unknown;
  sensors: unknown;
  areaName: string | null;
}

export function suggestNames(inputs: readonly NamingInput[]): Map<string, string> {
  const generic = (d: NamingInput) => isGenericName(d.name, d.module, d.hostname);
  const taken = new Set(inputs.filter((d) => !generic(d)).map((d) => d.name.trim().toLowerCase()));
  const result = new Map<string, string>();
  for (const device of [...inputs].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!generic(device)) continue;
    const type = deviceType(device.status, device.sensors, device.module);
    if (!type) continue;
    // Platz für die Nummerierung lassen; Tasmota erlaubt höchstens 32 Zeichen.
    const base = (device.areaName ? `${type} ${device.areaName}` : type).slice(0, MAX_NAME - 3).trim();
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} ${n}`;
    taken.add(candidate.toLowerCase());
    result.set(device.id, candidate);
  }
  return result;
}
```

`tasmota_manager/packages/server/src/enrich.ts`:
```ts
import type { Device, HaLink } from '@tm/shared';
import type { PendingStore } from './changes/store';
import { suggestNames } from './naming';
import type { DeviceRegistry } from './registry';

export interface HaLookup {
  link(mac: string): HaLink | null;
}

/** Ergänzt die Registry-Geräte um HA-Links, Namensvorschläge und Pufferstatus. */
export class DeviceEnricher {
  constructor(
    private readonly registry: DeviceRegistry,
    private readonly store: PendingStore,
    private readonly ha: HaLookup | null,
  ) {}

  all(): Device[] {
    const devices = this.registry.list();
    const raw = new Map(this.registry.listRaw().map((r) => [r.id, r]));
    const counts = this.store.counts();
    const pendingNames = this.store.pendingNames();
    const links = new Map(devices.map((d) => [d.id, this.ha?.link(d.id) ?? null]));
    const suggestions = suggestNames(
      devices.map((d) => ({
        id: d.id,
        name: pendingNames.get(d.id) ?? d.name,
        hostname: d.hostname,
        module: d.module,
        status: raw.get(d.id)?.statusJson,
        sensors: raw.get(d.id)?.sensorsJson,
        areaName: links.get(d.id)?.areaName ?? null,
      })),
    );
    return devices.map((d) => {
      const pendingName = pendingNames.get(d.id) ?? null;
      const suggestion = suggestions.get(d.id) ?? null;
      return {
        ...d,
        ha: links.get(d.id) ?? null,
        pendingCount: counts.get(d.id) ?? 0,
        pendingName,
        nameSuggestion: pendingName || suggestion === d.name ? null : suggestion,
      };
    });
  }

  one(id: string): Device | null {
    return this.all().find((d) => d.id === id) ?? null;
  }
}
```

- [ ] **Step 4: Tests und Typecheck ausführen**

```bash
pnpm --filter @tm/server test && pnpm --filter @tm/server typecheck
```
Erwartet: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A .
git commit -m "feat(server): suggest names from sensors and HA area, enrich devices"
```

---

### Task 11: REST-API, Live-Events und Verdrahtung

**Files:**
- Create: `tasmota_manager/packages/server/src/api/changes.ts`
- Modify: `tasmota_manager/packages/server/src/api/app.ts`
- Modify: `tasmota_manager/packages/server/src/api/devices.ts`
- Modify: `tasmota_manager/packages/server/src/api/hub.ts`
- Modify: `tasmota_manager/packages/server/src/server.ts`
- Modify: `tasmota_manager/config.yaml`
- Create: `tasmota_manager/packages/server/test/appSetup.ts`
- Modify: `tasmota_manager/packages/server/src/api/app.test.ts` (auf den gemeinsamen Helfer umstellen)
- Test: `tasmota_manager/packages/server/src/api/changes.test.ts`

**Interfaces:**
- Consumes: `PendingStore`, `StageError` (Task 4), `JobRepo`, `INTERRUPTED` (Task 8), `ApplyRunner`, `RunnerBusyError`, `NothingToApplyError` (Task 8), `DeviceOps` (Task 7), `DeviceEnricher` (Task 10), `HaClient` (Task 9), `parseRuleState`, `parseTimer`, `parseTimersEnabled` (Task 3)
- Produces:

| Endpunkt | Antwort |
|---|---|
| `GET /api/changes` | `PendingDevice[]` |
| `POST /api/changes` | `StageResult`; 400 bei ungültigen Werten |
| `POST /api/changes/suggestions` | `StageResult` |
| `DELETE /api/changes/:id` | 204 / 404 / 409 |
| `DELETE /api/changes?deviceId=` und `DELETE /api/changes` | 204 / 409 |
| `POST /api/changes/apply` | 202 `JobView`; 409 bei laufendem Batch, 422 ohne Einträge |
| `GET /api/jobs/current` | `{ job: JobView \| null }` |
| `GET /api/devices/:id/rules` | `RuleState[]` |
| `GET /api/devices/:id/timers` | `TimersState` (502 bei Gerätefehler) |

  - Alle Geräte-Endpunkte liefern angereicherte `Device`-Objekte.
  - `AppDeps` bekommt zusätzlich `store`, `runner`, `jobs` und `enricher`.
  - `wireLiveEvents` bekommt zusätzlich `store`, `runner`, `ha` und `enricher`.
  - Test-Helfer `setupApp(opts)` und `cleanupApps()`.

- [ ] **Step 1: Gemeinsamen Test-Helfer anlegen**

`tasmota_manager/packages/server/test/appSetup.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app';
import { WsHub, wireLiveEvents } from '../src/api/hub';
import { DeviceOps } from '../src/changes/deviceOps';
import { JobRepo } from '../src/changes/jobs';
import { ApplyRunner } from '../src/changes/runner';
import { PendingStore } from '../src/changes/store';
import { HttpScanner } from '../src/discovery/scanner';
import { DeviceEnricher } from '../src/enrich';
import { DeviceGateway } from '../src/gateway';
import { DeviceRegistry } from '../src/registry';
import { SettingsStore, defaultSettings } from '../src/settings';
import { HttpTransport } from '../src/transport/http';
import { FakeTasmota, type FakeTasmotaOptions } from './fakes/fakeTasmota';
import { silentLogger, testDb } from './helpers';

export interface SetupOptions {
  allowedIps?: string[];
  webDir?: string;
  fakePassword?: string;
  fake?: Partial<FakeTasmotaOptions>;
}

const cleanups: Array<() => Promise<void>> = [];

export async function cleanupApps(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) await cleanup();
}

export async function setupApp(opts: SetupOptions = {}) {
  const db = testDb();
  const registry = new DeviceRegistry(db);
  const settings = new SettingsStore(db, defaultSettings(['192.168.1.0/24']));
  const http = new HttpTransport(2000);
  const gateway = new DeviceGateway({ registry, http, mqtt: null, globalPassword: () => settings.get().globalPassword });
  const fake = await new FakeTasmota({
    mac: 'AABBCC112233',
    name: 'Keller',
    password: opts.fakePassword,
    restartDelayMs: 20,
    downtimeMs: 150,
    ...opts.fake,
  }).start();
  const scanner = new HttpScanner(
    http,
    registry,
    (id) => gateway.passwordFor(id),
    () => settings.get().globalPassword || null,
    { port: fake.port, timeoutMs: 500 },
  );
  const store = new PendingStore(db, registry);
  const jobs = new JobRepo(db);
  const ops = new DeviceOps(gateway, { restartTimeoutMs: 3000, pollIntervalMs: 30, commandTimeoutMs: 500 });
  const runner = new ApplyRunner({ store, jobs, registry, ops, concurrency: () => 5, log: silentLogger });
  const enricher = new DeviceEnricher(registry, store, null);
  const hub = new WsHub();
  wireLiveEvents({ hub, registry, scanner, mqtt: null, store, runner, ha: null, enricher });
  const app: FastifyInstance = await buildApp({
    registry,
    gateway,
    scanner,
    settings,
    hub,
    store,
    runner,
    jobs,
    enricher,
    version: 'test',
    mqttStatus: () => 'disabled',
    allowedIps: opts.allowedIps,
    webDir: opts.webDir,
  });
  cleanups.push(async () => {
    await runner.waitIdle();
    await app.close();
    await fake.stop();
  });
  return { app, registry, settings, hub, fake, store, runner, jobs };
}
```

`tasmota_manager/packages/server/src/api/app.test.ts` umstellen:
- Die Imports von `HttpScanner`, `DeviceGateway`, `DeviceRegistry`, `SettingsStore`/`defaultSettings`, `HttpTransport`, `FakeTasmota`, `buildApp` und `WsHub`/`wireLiveEvents` entfernen, soweit sie danach ungenutzt sind (der Typecheck zeigt es).
- `testDb` aus dem Import von `../../test/helpers` entfernen, `waitFor` behalten.
- Die Blöcke `interface SetupOptions`, `const cleanups …`, `afterEach(…)` und `async function setup(…)` löschen.
- Stattdessen einfügen:
```ts
import { cleanupApps, setupApp as setup } from '../../test/appSetup';

afterEach(cleanupApps);
```
Die Tests selbst bleiben unverändert.

- [ ] **Step 2: Failing Test schreiben**

`tasmota_manager/packages/server/src/api/changes.test.ts`:
```ts
import type { Device, JobView, PendingDevice, WsMessage } from '@tm/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupApps, setupApp } from '../../test/appSetup';
import { waitFor } from '../../test/helpers';

afterEach(cleanupApps);

const MAC = 'AABBCC112233';

async function addFake(app: FastifyInstance): Promise<Device> {
  const res = await app.inject({ method: 'POST', url: '/api/devices', payload: { ip: '127.0.0.1' } });
  expect(res.statusCode).toBe(201);
  return res.json<Device>();
}

const stage = (app: FastifyInstance, payload: unknown) => app.inject({ method: 'POST', url: '/api/changes', payload });

describe('Änderungs-API', () => {
  it('merkt vor, listet mit Vorher/Nachher und maskiert Passwörter', async () => {
    const { app } = await setupApp();
    await addFake(app);
    const res = await stage(app, { deviceIds: [MAC], settings: { PowerOnState: '1', MqttPassword: 'geheim' }, source: 'form' });
    expect(res.json()).toEqual({ staged: 2, skipped: 0 });
    const list = (await app.inject('/api/changes')).json<PendingDevice[]>();
    expect(list[0]?.changes.map((c) => [c.key, c.before, c.value])).toEqual([
      ['PowerOnState', '3', '1'],
      ['MqttPassword', null, '••••'],
    ]);
    expect(JSON.stringify(list)).not.toContain('geheim');
  });

  it('lehnt ungültige Werte und Backlog-Injektion mit 400 ab', async () => {
    const { app } = await setupApp();
    await addFake(app);
    expect((await stage(app, { deviceIds: [MAC], settings: { Unbekannt: '1' }, source: 'form' })).statusCode).toBe(400);
    const injected = await stage(app, { deviceIds: [MAC], settings: { MqttHost: 'broker;Reset 1' }, source: 'form' });
    expect(injected.statusCode).toBe(400);
    expect(injected.json()).toMatchObject({ code: 'validation' });
    expect((await stage(app, { deviceIds: [MAC], source: 'form' })).statusCode).toBe(400);
  });

  it('zeigt Pufferstatus und Namensvorschläge an den Geräten und übernimmt Vorschläge', async () => {
    const { app } = await setupApp({ fake: { name: 'Tasmota', sensors: { AM2301: { Temperature: 21, Humidity: 40 } } } });
    await addFake(app);
    let device = (await app.inject('/api/devices')).json<Device[]>()[0];
    expect(device).toMatchObject({ nameSuggestion: 'Klima', pendingCount: 0, pendingName: null, setOption4: false, ha: null });
    const res = await app.inject({ method: 'POST', url: '/api/changes/suggestions', payload: { deviceIds: [MAC] } });
    expect(res.json()).toEqual({ staged: 2, skipped: 0 });
    device = (await app.inject(`/api/devices/${MAC}`)).json<Device>();
    expect(device).toMatchObject({ nameSuggestion: null, pendingCount: 2, pendingName: 'Klima' });
  });

  it('startet den Batch, liefert den Job und leert den Puffer', async () => {
    const { app, fake, runner } = await setupApp();
    await addFake(app);
    await stage(app, { deviceIds: [MAC], settings: { LedState: '0', MqttHost: 'neu.local' }, source: 'form' });
    const started = await app.inject({ method: 'POST', url: '/api/changes/apply', payload: {} });
    expect(started.statusCode).toBe(202);
    expect(started.json<JobView>().items[0]).toMatchObject({ deviceId: MAC, status: 'pending' });
    expect((await app.inject({ method: 'POST', url: '/api/changes/apply', payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: '/api/changes' })).statusCode).toBe(409);
    await runner.waitIdle();
    const job = (await app.inject('/api/jobs/current')).json<{ job: JobView }>().job;
    expect(job).toMatchObject({ status: 'done', items: [{ status: 'success' }] });
    expect(fake.values.LedState).toBe('0');
    expect(fake.values.MqttHost).toBe('neu.local');
    expect(fake.restarts).toBe(1);
    expect((await app.inject('/api/changes')).json()).toEqual([]);
    expect((await app.inject({ method: 'POST', url: '/api/changes/apply', payload: {} })).statusCode).toBe(422);
  });

  it('verwirft einzelne Einträge, Geräte und alles', async () => {
    const { app } = await setupApp();
    await addFake(app);
    await stage(app, { deviceIds: [MAC], settings: { LedState: '0', TelePeriod: '60' }, source: 'form' });
    const id = (await app.inject('/api/changes')).json<PendingDevice[]>()[0]?.changes[0]?.id;
    expect((await app.inject({ method: 'DELETE', url: `/api/changes/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/changes/${id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/changes?deviceId=${MAC}` })).statusCode).toBe(204);
    expect((await app.inject('/api/changes')).json()).toEqual([]);
  });

  it('liest Rules und Timer live vom Gerät', async () => {
    const { app, fake } = await setupApp();
    await addFake(app);
    fake.execute('Rule2 ON x DO y ENDON');
    fake.execute('Timer1 {"Enable":1,"Time":"06:30","Days":"1111111"}');
    const rules = (await app.inject(`/api/devices/${MAC}/rules`)).json();
    expect(rules[1]).toEqual({ index: 2, enabled: false, text: 'ON x DO y ENDON', length: 15, free: 496 });
    const timers = (await app.inject(`/api/devices/${MAC}/timers`)).json();
    expect(timers.enabled).toBe(true);
    expect(timers.timers).toHaveLength(16);
    expect(timers.timers[0]).toMatchObject({ Enable: 1, Time: '06:30', Days: '1111111' });
    expect((await app.inject('/api/devices/GIBTSNICHT/rules')).statusCode).toBe(404);
  });

  it('meldet Pufferänderungen per WebSocket', async () => {
    const { app, hub } = await setupApp();
    await addFake(app);
    await app.ready();
    const ws = await app.injectWS('/api/ws');
    await waitFor(() => hub.size === 1);
    const messages: WsMessage[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await stage(app, { deviceIds: [MAC], settings: { LedState: '0' }, source: 'form' });
    await waitFor(() => messages.some((m) => m.type === 'changes:updated'));
    expect(messages.find((m) => m.type === 'changes:updated')).toEqual({ type: 'changes:updated', count: 1 });
    ws.terminate();
  });
});
```

- [ ] **Step 3: Test ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test -- api
```
Erwartet: FAIL (Routen und Helfer-Abhängigkeiten fehlen, der Typecheck des Helfers scheitert).

- [ ] **Step 4: Routen implementieren**

`tasmota_manager/packages/server/src/api/changes.ts`:
```ts
import { ApplyRequestSchema, DeviceIdsRequestSchema, StageRequestSchema, type StageResult } from '@tm/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { NothingToApplyError, RunnerBusyError } from '../changes/runner';
import { StageError } from '../changes/store';
import type { AppDeps } from './app';
import { notFound, parseBody } from './validate';

export function registerChangeRoutes(app: FastifyInstance, { store, runner, jobs, enricher }: AppDeps): void {
  const busy = (reply: FastifyReply) => reply.code(409).send({ code: 'busy', message: 'Es läuft gerade ein Batch' });

  app.get('/api/changes', async () => store.list());

  app.post('/api/changes', async (req, reply) => {
    const body = parseBody(StageRequestSchema, req.body, reply);
    if (!body) return reply;
    try {
      return store.stage(body);
    } catch (err) {
      if (err instanceof StageError) return reply.code(400).send({ code: 'validation', message: err.message });
      throw err;
    }
  });

  app.post('/api/changes/suggestions', async (req, reply) => {
    const body = parseBody(DeviceIdsRequestSchema, req.body, reply);
    if (!body) return reply;
    const wanted = new Set(body.deviceIds);
    const total: StageResult = { staged: 0, skipped: 0 };
    for (const device of enricher.all()) {
      if (!wanted.has(device.id) || !device.nameSuggestion) continue;
      const name = device.nameSuggestion;
      const result = store.stage({ deviceIds: [device.id], settings: { DeviceName: name, FriendlyName1: name }, source: 'suggestion' });
      total.staged += result.staged;
      total.skipped += result.skipped;
    }
    return total;
  });

  app.delete<{ Params: { id: string } }>('/api/changes/:id', async (req, reply) => {
    if (runner.running) return busy(reply);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !store.discard(id)) return reply.code(404).send(notFound('Änderung'));
    return reply.code(204).send();
  });

  app.delete<{ Querystring: { deviceId?: string } }>('/api/changes', async (req, reply) => {
    if (runner.running) return busy(reply);
    if (req.query.deviceId) store.discardDevice(req.query.deviceId);
    else store.discardAll();
    return reply.code(204).send();
  });

  app.post('/api/changes/apply', async (req, reply) => {
    const body = parseBody(ApplyRequestSchema, req.body, reply);
    if (!body) return reply;
    try {
      return reply.code(202).send(runner.start(body.deviceIds));
    } catch (err) {
      if (err instanceof RunnerBusyError) return busy(reply);
      if (err instanceof NothingToApplyError) return reply.code(422).send({ code: 'nothing_to_apply', message: err.message });
      throw err;
    }
  });

  app.get('/api/jobs/current', async () => ({ job: jobs.latest() }));
}
```

In `tasmota_manager/packages/server/src/api/devices.ts`:

1. Imports ergänzen:
```ts
import type { RuleState, TimersState } from '@tm/shared';
import { parseRuleState, parseTimer, parseTimersEnabled } from '../changes/catalog';
```

2. In `registerDeviceRoutes` die Destrukturierung auf `{ registry, gateway, scanner, enricher }` erweitern.

3. `GET /api/devices` ersetzen durch `app.get('/api/devices', async () => enricher.all());`

4. In `POST /api/devices` `return reply.code(201).send(device);` ersetzen durch `return reply.code(201).send(enricher.one(device.id) ?? device);`

5. In `GET /api/devices/:id` die Zeile `const device = registry.get(req.params.id);` ersetzen durch `const device = enricher.one(req.params.id);`

6. In `PATCH /api/devices/:id` die letzte Zeile `return device;` ersetzen durch `return enricher.one(device.id) ?? device;`

7. Am Ende von `registerDeviceRoutes` anfügen:
```ts
  app.get<IdParams>('/api/devices/:id/rules', async (req, reply) => {
    const id = req.params.id;
    if (!registry.get(id)) return reply.code(404).send(notFound());
    try {
      const rules: RuleState[] = [];
      for (const index of [1, 2, 3]) rules.push(parseRuleState(index, (await gateway.send(id, `Rule${index}`)).response));
      return rules;
    } catch (err) {
      if (err instanceof TransportError) return reply.code(502).send({ code: err.code, message: err.message });
      throw err;
    }
  });

  app.get<IdParams>('/api/devices/:id/timers', async (req, reply) => {
    const id = req.params.id;
    if (!registry.get(id)) return reply.code(404).send(notFound());
    try {
      const enabled = parseTimersEnabled((await gateway.send(id, 'Timers')).response);
      const timers: TimersState['timers'] = [];
      for (let index = 1; index <= 16; index++) timers.push(parseTimer(index, (await gateway.send(id, `Timer${index}`)).response));
      return { enabled, timers } satisfies TimersState;
    } catch (err) {
      if (err instanceof TransportError) return reply.code(502).send({ code: err.code, message: err.message });
      throw err;
    }
  });
```

In `tasmota_manager/packages/server/src/api/app.ts`:
- Imports ergänzen:
```ts
import type { JobRepo } from '../changes/jobs';
import type { ApplyRunner } from '../changes/runner';
import type { PendingStore } from '../changes/store';
import type { DeviceEnricher } from '../enrich';
import { registerChangeRoutes } from './changes';
```
- In `AppDeps` nach `hub: WsHub;` einfügen:
```ts
  store: PendingStore;
  runner: ApplyRunner;
  jobs: JobRepo;
  enricher: DeviceEnricher;
```
- Nach `registerLiveRoutes(app, deps);` einfügen: `registerChangeRoutes(app, deps);`

`tasmota_manager/packages/server/src/api/hub.ts`: `wireLiveEvents` ersetzen durch:
```ts
export function wireLiveEvents(deps: {
  hub: WsHub;
  registry: DeviceRegistry;
  scanner: HttpScanner;
  mqtt: MqttTransport | null;
  store: PendingStore;
  runner: ApplyRunner;
  ha: HaClient | null;
  enricher: DeviceEnricher;
}): void {
  const { hub } = deps;
  deps.registry.on('updated', (device) => hub.broadcast({ type: 'device:updated', device: deps.enricher.one(device.id) ?? device }));
  deps.registry.on('removed', (id) => hub.broadcast({ type: 'device:removed', id }));
  deps.scanner.on('progress', (progress) => hub.broadcast({ type: 'scan:progress', ...progress }));
  deps.scanner.on('done', ({ found }) => hub.broadcast({ type: 'scan:done', found }));
  deps.mqtt?.on('status', (status) => hub.broadcast({ type: 'mqtt:status', status }));
  deps.store.on('changed', (count) => hub.broadcast({ type: 'changes:updated', count }));
  deps.runner.on('progress', (jobId, item) => hub.broadcast({ type: 'job:progress', jobId, item }));
  deps.runner.on('done', (job) => hub.broadcast({ type: 'job:done', job }));
  deps.ha?.on('changed', () => hub.broadcast({ type: 'devices:stale' }));
}
```
und die Imports ergänzen:
```ts
import type { ApplyRunner } from '../changes/runner';
import type { PendingStore } from '../changes/store';
import type { DeviceEnricher } from '../enrich';
import type { HaClient } from '../ha/client';
```

- [ ] **Step 5: Server verdrahten**

In `tasmota_manager/packages/server/src/server.ts`:

1. Imports ergänzen:
```ts
import { DeviceOps } from './changes/deviceOps';
import { INTERRUPTED, JobRepo } from './changes/jobs';
import { ApplyRunner } from './changes/runner';
import { PendingStore } from './changes/store';
import { DeviceEnricher } from './enrich';
import { HaClient } from './ha/client';
```

2. Die Zeile `wireLiveEvents({ hub, registry, scanner, mqtt });` ersetzen durch:
```ts
  const store = new PendingStore(db, registry);
  const jobs = new JobRepo(db);
  // Ein Batch, der beim letzten Beenden lief, gilt als unterbrochen; seine Einträge bleiben mit Fehler stehen.
  const interrupted = jobs.recoverInterrupted();
  if (interrupted.length > 0) store.fail(interrupted, INTERRUPTED);
  const runner = new ApplyRunner({
    store,
    jobs,
    registry,
    ops: new DeviceOps(gateway),
    concurrency: () => settings.get().concurrency.command,
    log,
  });
  const ha = config.ha ? new HaClient(config.ha, log) : null;
  const enricher = new DeviceEnricher(registry, store, ha);
  wireLiveEvents({ hub, registry, scanner, mqtt, store, runner, ha, enricher });
  ha?.start();
```

3. Im Aufruf `buildApp({ … })` nach `hub,` ergänzen: `store, runner, jobs, enricher,`

4. In `stop` nach `poller.stop();` einfügen: `await ha?.stop();`

In `tasmota_manager/config.yaml`:
- `version: "0.1.0"` → `version: "0.2.0"`
- nach `host_network: true` einfügen: `homeassistant_api: true`

- [ ] **Step 6: Tests, Typecheck und Build ausführen**

```bash
pnpm --filter @tm/server test && pnpm --filter @tm/server typecheck && pnpm --filter @tm/server build
```
Erwartet: PASS. Der Build bündelt `ws` mit. Steht `ws` optional auf den nativen Modulen `bufferutil`/`utf-8-validate` und meldet esbuild sie als nicht auflösbar, ergänze beide in `build.mjs` unter `external`. `ws` fängt ihr Fehlen zur Laufzeit selbst ab.

- [ ] **Step 7: Bundle kurz starten**

```bash
mkdir -p .data && TM_DATA_DIR=.data TM_PORT=8096 node packages/server/dist/server.js &
sleep 2
curl -s localhost:8096/api/changes
curl -s localhost:8096/api/jobs/current
kill %1
```
Erwartet: `[]` und `{"job":null}` (oder der letzte Job aus einem früheren lokalen Lauf).

- [ ] **Step 8: Commit**

```bash
git add -A .
git commit -m "feat(server): expose staging, apply and job API, wire HA client and live events"
```

---

### Task 12: Web-Grundlagen (API-Client, Live-Events, Texte, Hilfsfunktionen)

**Files:**
- Modify: `tasmota_manager/packages/web/src/lib/api.ts`
- Modify: `tasmota_manager/packages/web/src/lib/live.ts`
- Modify: `tasmota_manager/packages/web/src/lib/messages.ts`
- Modify: `tasmota_manager/packages/web/src/test/setup.ts`
- Modify: `tasmota_manager/packages/web/src/features/settings/SettingsPage.test.tsx`
- Create: `tasmota_manager/packages/web/src/features/changes/labels.ts`
- Create: `tasmota_manager/packages/web/src/features/changes/useStage.ts`
- Test: `tasmota_manager/packages/web/src/lib/lib.test.ts` (ergänzen)
- Test: `tasmota_manager/packages/web/src/features/changes/labels.test.ts`

**Interfaces:**
- Consumes: Typen aus `@tm/shared` (Task 1), Endpunkte aus Task 11
- Produces:
  - `api` erhält `changes()`, `stage(req)`, `stageSuggestions(deviceIds)`, `discardChange(id)`, `discardDevice(deviceId)`, `discardAll()`, `apply(deviceIds?)`, `currentJob()`, `rules(id)` und `timers(id)`.
  - `applyMessage` verarbeitet `changes:updated`, `devices:stale`, `job:progress` und `job:done`.
  - Query-Keys: `['changes']`, `['job']`, `['rules', id]`, `['timers', id]`
  - `settingLabel(t, key): string`
  - `useStage(onDone?)`: Mutation für `api.stage` mit Meldung und Invalidierung
  - alle neuen Übersetzungsschlüssel (de/en)

- [ ] **Step 1: Failing Tests schreiben**

In `tasmota_manager/packages/web/src/lib/lib.test.ts`:
- Den Import aus `@tm/shared` um `JobView` erweitern (`import type { Device, JobView, StatusResponse } from '@tm/shared';`).
- Im Block `describe('applyMessage', …)` anfügen:
```ts
  it('invalidiert Puffer und Geräte bei Pufferänderungen', () => {
    const qc = new QueryClient();
    qc.setQueryData(['changes'], []);
    qc.setQueryData<Device[]>(['devices'], []);
    applyMessage(qc, { type: 'changes:updated', count: 3 });
    expect(qc.getQueryState(['changes'])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['devices'])?.isInvalidated).toBe(true);
  });

  it('aktualisiert den Fortschritt des laufenden Jobs', () => {
    const qc = new QueryClient();
    const job: JobView = {
      id: 7,
      status: 'running',
      createdAt: 'x',
      finishedAt: null,
      items: [{ deviceId: 'A', deviceName: 'A', status: 'pending', step: null, error: null }],
    };
    qc.setQueryData(['job'], { job });
    applyMessage(qc, { type: 'job:progress', jobId: 7, item: { deviceId: 'A', deviceName: 'A', status: 'running', step: 'restart', error: null } });
    expect(qc.getQueryData<{ job: JobView }>(['job'])?.job.items[0]).toMatchObject({ status: 'running', step: 'restart' });
    applyMessage(qc, { type: 'job:done', job: { ...job, status: 'done' } });
    expect(qc.getQueryData<{ job: JobView }>(['job'])?.job.status).toBe('done');
  });
```

`tasmota_manager/packages/web/src/features/changes/labels.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { formatMessage } from '@/lib/i18n';
import { de, type MessageKey } from '@/lib/messages';
import { settingLabel } from './labels';

const t = (key: MessageKey, vars?: Record<string, string | number>) => formatMessage(de[key], vars);

describe('settingLabel', () => {
  it('beschriftet Katalog-, Rule- und Timer-Einträge', () => {
    expect(settingLabel(t, 'PowerOnState')).toBe('Zustand nach Stromausfall');
    expect(settingLabel(t, 'Rule2')).toBe('Rule 2');
    expect(settingLabel(t, 'Rule2Enabled')).toBe('Rule 2 · Aktiv');
    expect(settingLabel(t, 'Timer12')).toBe('Timer 12');
    expect(settingLabel(t, 'Timers')).toBe('Timer global aktiv');
    expect(settingLabel(t, 'Unbekannt')).toBe('Unbekannt');
  });
});
```

In `tasmota_manager/packages/web/src/features/settings/SettingsPage.test.tsx` im Test „lehnt zu große Scan-Bereiche ab“ die Erwartung ersetzen durch:
```ts
    expect(screen.getByText(/Ungültiger oder zu großer Bereich: 10\.0\.0\.0\/8/)).toBeInTheDocument();
```

- [ ] **Step 2: Tests ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/web test
```
Erwartet: FAIL (neue Nachrichtentypen, `labels.ts` und die neuen Texte fehlen).

- [ ] **Step 3: API-Client erweitern**

`tasmota_manager/packages/web/src/lib/api.ts`:

1. Den Typ-Import ersetzen durch:
```ts
import type {
  CommandResult,
  Device,
  DeviceDetail,
  DeviceUpdateRequest,
  JobView,
  PendingDevice,
  RuleState,
  Settings,
  SettingsUpdateRequest,
  StageRequest,
  StageResult,
  StatusResponse,
  TimersState,
} from '@tm/shared';
```

2. Im Objekt `api` nach `scan: …,` anfügen:
```ts
  changes: () => request<PendingDevice[]>('changes'),
  stage: (req: StageRequest) => request<StageResult>('changes', json('POST', req)),
  stageSuggestions: (deviceIds: string[]) => request<StageResult>('changes/suggestions', json('POST', { deviceIds })),
  discardChange: (id: number) => request<void>(`changes/${id}`, { method: 'DELETE' }),
  discardDevice: (deviceId: string) => request<void>(`changes?deviceId=${encodeURIComponent(deviceId)}`, { method: 'DELETE' }),
  discardAll: () => request<void>('changes', { method: 'DELETE' }),
  apply: (deviceIds?: string[]) => request<JobView>('changes/apply', json('POST', deviceIds ? { deviceIds } : {})),
  currentJob: () => request<{ job: JobView | null }>('jobs/current'),
  rules: (id: string) => request<RuleState[]>(`${deviceUrl(id)}/rules`),
  timers: (id: string) => request<TimersState>(`${deviceUrl(id)}/timers`),
```

- [ ] **Step 4: Live-Events erweitern**

In `tasmota_manager/packages/web/src/lib/live.ts`:
- Den Typ-Import ersetzen durch `import type { Device, JobView, StatusResponse, WsMessage } from '@tm/shared';`
- Im `switch` von `applyMessage` vor der schließenden Klammer anfügen:
```ts
    case 'devices:stale':
      void qc.invalidateQueries({ queryKey: ['devices'] });
      break;
    case 'changes:updated':
      void qc.invalidateQueries({ queryKey: ['changes'] });
      void qc.invalidateQueries({ queryKey: ['devices'] });
      break;
    case 'job:progress': {
      const current = qc.getQueryData<{ job: JobView | null }>(['job'])?.job;
      if (!current || current.id !== msg.jobId) {
        void qc.invalidateQueries({ queryKey: ['job'] });
        break;
      }
      qc.setQueryData<{ job: JobView | null }>(['job'], {
        job: { ...current, items: current.items.map((i) => (i.deviceId === msg.item.deviceId ? msg.item : i)) },
      });
      break;
    }
    case 'job:done':
      qc.setQueryData(['job'], { job: msg.job });
      void qc.invalidateQueries({ queryKey: ['changes'] });
      void qc.invalidateQueries({ queryKey: ['devices'] });
      break;
```

- [ ] **Step 5: Texte ergänzen**

In `tasmota_manager/packages/web/src/lib/messages.ts`:

1. Im Objekt `de` den Wert von `'settings.invalidCidr'` ersetzen durch:
```ts
  'settings.invalidCidr': 'Ungültiger oder zu großer Bereich: {cidr}. Erlaubt ist höchstens /20 (4096 Adressen) – trage genutzte Subnetze einzeln ein, z. B. 10.0.1.0/24.',
```

2. Im Objekt `de` vor `} as const;` einfügen:
```ts
  'nav.pending': 'Ausstehend',
  'devices.col.entities': 'Entitäten',
  'devices.col.automations': 'Automationen',
  'devices.suggestion.title': 'Namensvorschlag übernehmen (wird vorgemerkt)',
  'devices.pendingDot': '{count} ausstehende Änderungen',
  'devices.so4': 'SetOption4 ist aktiv – das Gerät wird per HTTP angesprochen',
  'devices.staged': '{staged} Änderungen vorgemerkt',
  'devices.stagedSkipped': '{staged} Änderungen vorgemerkt, {skipped} bereits aktuell',
  'edit.menu': 'Bearbeiten',
  'edit.settings': 'Einstellungen …',
  'edit.commands': 'Befehle …',
  'edit.suggestions': 'Namensvorschläge übernehmen',
  'edit.rule': 'Rule setzen …',
  'edit.timer': 'Timer setzen …',
  'edit.stage': 'Vormerken',
  'edit.forDevices': 'Für {count} Geräte. Leere Felder bleiben unverändert.',
  'edit.unchanged': 'unverändert',
  'edit.nothing': 'Keine Änderungen eingetragen',
  'edit.commands.label': 'Befehle',
  'edit.commands.hint': 'Ein Befehl pro Zeile. Platzhalter: {{name}}, {{hostname}}, {{topic}}, {{mac}}, {{mac6}}, {{ip}}',
  'edit.commands.preview': 'Vorschau für {name}',
  'edit.commands.unknown': 'Unbekannter Platzhalter: {placeholder}',
  'edit.suggestions.none': 'Für die Auswahl gibt es keine Namensvorschläge',
  'edit.rule.slot': 'Rule-Nummer',
  'edit.timer.slot': 'Timer-Nummer',
  'edit.timer.enableAll': 'Timer global aktivieren',
  'group.names': 'Namen',
  'group.power': 'Stromausfall',
  'group.led': 'LED',
  'group.system': 'System',
  'group.logging': 'Logging',
  'group.location': 'Standort',
  'group.time': 'Zeit',
  'group.telemetry': 'Telemetrie',
  'group.mqtt': 'MQTT (löst einen Neustart aus)',
  'setting.DeviceName': 'Gerätename',
  'setting.FriendlyName1': 'Friendly Name 1',
  'setting.PowerOnState': 'Zustand nach Stromausfall',
  'setting.SetOption65': 'Reset durch schnelles Aus/An verhindern (SetOption65)',
  'setting.LedState': 'LED-Modus (LedState 0–8)',
  'setting.LedPower': 'Status-LED an (LedPower)',
  'setting.Sleep': 'Sleep in ms (0–250)',
  'setting.SetOption53': 'Hostname und IP in der Oberfläche (SetOption53)',
  'setting.LogHost': 'Syslog-Host',
  'setting.SysLog': 'Syslog-Level (0–4)',
  'setting.Latitude': 'Breitengrad',
  'setting.Longitude': 'Längengrad',
  'setting.Timezone': 'Zeitzone (99 = Sommerzeitregeln, sonst z. B. +01:00)',
  'setting.NtpServer1': 'NTP-Server 1',
  'setting.TelePeriod': 'Telemetrie-Intervall in s (10–3600)',
  'setting.MqttHost': 'MQTT-Host',
  'setting.MqttPort': 'MQTT-Port',
  'setting.MqttUser': 'MQTT-Benutzer',
  'setting.MqttPassword': 'MQTT-Passwort',
  'powerOn.0': '0 – Aus',
  'powerOn.1': '1 – An',
  'powerOn.2': '2 – Gegenteil des letzten Zustands',
  'powerOn.3': '3 – Letzter Zustand (Standard)',
  'powerOn.4': '4 – An, Schalten gesperrt',
  'powerOn.5': '5 – An nach PulseTime',
  'bool.on': 'An',
  'bool.off': 'Aus',
  'pending.title': 'Ausstehende Änderungen',
  'pending.empty': 'Keine ausstehenden Änderungen. Änderungen aus der Geräteübersicht werden hier gesammelt und erst beim Start geschrieben.',
  'pending.apply': 'Batch starten ({count} Geräte)',
  'pending.retry': 'Fehlgeschlagene erneut starten',
  'pending.discardAll': 'Alle verwerfen',
  'pending.discardAllConfirm': 'Alle ausstehenden Änderungen verwerfen?',
  'pending.discardDevice': 'Gerät verwerfen',
  'pending.discard': 'Verwerfen',
  'pending.command': 'Befehl',
  'pending.unknown': 'unbekannt',
  'pending.loadCurrent': 'Aktuellen Wert laden',
  'pending.running': 'Batch läuft …',
  'pending.started': 'Batch gestartet',
  'job.status.pending': 'Wartet',
  'job.status.running': 'Läuft',
  'job.status.success': 'Erfolgreich',
  'job.status.failed': 'Fehlgeschlagen',
  'job.step.write': 'Schreiben',
  'job.step.restart': 'Warte auf Neustart',
  'job.step.verify': 'Prüfen',
  'rules.rule': 'Rule {n}',
  'rules.enabled': 'Aktiv',
  'rules.length': '{length} / {max} Zeichen',
  'rules.tooLong': 'Die Rule ist zu lang.',
  'rules.loadError': 'Rules konnten nicht gelesen werden: {message}',
  'timers.enabled': 'Timer global aktiv',
  'timers.timer': 'Timer {n}',
  'timers.active': 'Aktiv',
  'timers.inactive': 'inaktiv',
  'timers.mode': 'Modus',
  'timers.mode.0': 'Uhrzeit',
  'timers.mode.1': 'Sonnenaufgang',
  'timers.mode.2': 'Sonnenuntergang',
  'timers.time': 'Zeit (HH:MM)',
  'timers.offset': 'Versatz (±HH:MM)',
  'timers.window': 'Zufallsfenster in min (0–15)',
  'timers.days': 'Tage',
  'timers.repeat': 'Wiederholen',
  'timers.output': 'Ausgang',
  'timers.action': 'Aktion',
  'timers.action.0': 'Aus',
  'timers.action.1': 'An',
  'timers.action.2': 'Umschalten',
  'timers.action.3': 'Rule auslösen',
  'timers.sunHint': 'Für Sonnenzeiten müssen Breiten- und Längengrad gesetzt sein.',
  'timers.invalid': 'Timer {n} ist ungültig',
  'timers.loadError': 'Timer konnten nicht gelesen werden: {message}',
  'days.short': 'So,Mo,Di,Mi,Do,Fr,Sa',
  'detail.tab.info': 'Info',
  'detail.tab.settings': 'Einstellungen',
  'detail.tab.rules': 'Rules',
  'detail.tab.timers': 'Timer',
  'detail.tab.console': 'Konsole',
  'detail.pendingHint': 'Änderungen werden vorgemerkt und erst unter „Ausstehend“ geschrieben.',
```

3. Im Objekt `en` den Wert von `'settings.invalidCidr'` ersetzen durch:
```ts
  'settings.invalidCidr': 'Invalid or too large range: {cidr}. At most /20 (4096 addresses) is allowed – enter the subnets you use individually, e.g. 10.0.1.0/24.',
```

4. Im Objekt `en` vor der schließenden `};` einfügen:
```ts
  'nav.pending': 'Pending',
  'devices.col.entities': 'Entities',
  'devices.col.automations': 'Automations',
  'devices.suggestion.title': 'Apply name suggestion (staged)',
  'devices.pendingDot': '{count} pending changes',
  'devices.so4': 'SetOption4 is enabled – the device is addressed via HTTP',
  'devices.staged': '{staged} changes staged',
  'devices.stagedSkipped': '{staged} changes staged, {skipped} already current',
  'edit.menu': 'Edit',
  'edit.settings': 'Settings …',
  'edit.commands': 'Commands …',
  'edit.suggestions': 'Apply name suggestions',
  'edit.rule': 'Set rule …',
  'edit.timer': 'Set timer …',
  'edit.stage': 'Stage',
  'edit.forDevices': 'For {count} devices. Empty fields stay unchanged.',
  'edit.unchanged': 'unchanged',
  'edit.nothing': 'No changes entered',
  'edit.commands.label': 'Commands',
  'edit.commands.hint': 'One command per line. Placeholders: {{name}}, {{hostname}}, {{topic}}, {{mac}}, {{mac6}}, {{ip}}',
  'edit.commands.preview': 'Preview for {name}',
  'edit.commands.unknown': 'Unknown placeholder: {placeholder}',
  'edit.suggestions.none': 'There are no name suggestions for the selection',
  'edit.rule.slot': 'Rule number',
  'edit.timer.slot': 'Timer number',
  'edit.timer.enableAll': 'Enable timers globally',
  'group.names': 'Names',
  'group.power': 'Power loss',
  'group.led': 'LED',
  'group.system': 'System',
  'group.logging': 'Logging',
  'group.location': 'Location',
  'group.time': 'Time',
  'group.telemetry': 'Telemetry',
  'group.mqtt': 'MQTT (triggers a restart)',
  'setting.DeviceName': 'Device name',
  'setting.FriendlyName1': 'Friendly name 1',
  'setting.PowerOnState': 'State after power loss',
  'setting.SetOption65': 'Prevent reset by fast power cycling (SetOption65)',
  'setting.LedState': 'LED mode (LedState 0–8)',
  'setting.LedPower': 'Status LED on (LedPower)',
  'setting.Sleep': 'Sleep in ms (0–250)',
  'setting.SetOption53': 'Hostname and IP in the web UI (SetOption53)',
  'setting.LogHost': 'Syslog host',
  'setting.SysLog': 'Syslog level (0–4)',
  'setting.Latitude': 'Latitude',
  'setting.Longitude': 'Longitude',
  'setting.Timezone': 'Timezone (99 = DST rules, otherwise e.g. +01:00)',
  'setting.NtpServer1': 'NTP server 1',
  'setting.TelePeriod': 'Telemetry interval in s (10–3600)',
  'setting.MqttHost': 'MQTT host',
  'setting.MqttPort': 'MQTT port',
  'setting.MqttUser': 'MQTT user',
  'setting.MqttPassword': 'MQTT password',
  'powerOn.0': '0 – Off',
  'powerOn.1': '1 – On',
  'powerOn.2': '2 – Opposite of last state',
  'powerOn.3': '3 – Last state (default)',
  'powerOn.4': '4 – On, switching locked',
  'powerOn.5': '5 – On after PulseTime',
  'bool.on': 'On',
  'bool.off': 'Off',
  'pending.title': 'Pending changes',
  'pending.empty': 'No pending changes. Changes from the device overview are collected here and only written when you start the batch.',
  'pending.apply': 'Start batch ({count} devices)',
  'pending.retry': 'Retry failed',
  'pending.discardAll': 'Discard all',
  'pending.discardAllConfirm': 'Discard all pending changes?',
  'pending.discardDevice': 'Discard device',
  'pending.discard': 'Discard',
  'pending.command': 'Command',
  'pending.unknown': 'unknown',
  'pending.loadCurrent': 'Load current value',
  'pending.running': 'Batch running …',
  'pending.started': 'Batch started',
  'job.status.pending': 'Waiting',
  'job.status.running': 'Running',
  'job.status.success': 'Succeeded',
  'job.status.failed': 'Failed',
  'job.step.write': 'Writing',
  'job.step.restart': 'Waiting for restart',
  'job.step.verify': 'Verifying',
  'rules.rule': 'Rule {n}',
  'rules.enabled': 'Enabled',
  'rules.length': '{length} / {max} characters',
  'rules.tooLong': 'The rule is too long.',
  'rules.loadError': 'Could not read rules: {message}',
  'timers.enabled': 'Timers enabled globally',
  'timers.timer': 'Timer {n}',
  'timers.active': 'Active',
  'timers.inactive': 'inactive',
  'timers.mode': 'Mode',
  'timers.mode.0': 'Time',
  'timers.mode.1': 'Sunrise',
  'timers.mode.2': 'Sunset',
  'timers.time': 'Time (HH:MM)',
  'timers.offset': 'Offset (±HH:MM)',
  'timers.window': 'Random window in min (0–15)',
  'timers.days': 'Days',
  'timers.repeat': 'Repeat',
  'timers.output': 'Output',
  'timers.action': 'Action',
  'timers.action.0': 'Off',
  'timers.action.1': 'On',
  'timers.action.2': 'Toggle',
  'timers.action.3': 'Trigger rule',
  'timers.sunHint': 'Sun-based times require latitude and longitude to be set.',
  'timers.invalid': 'Timer {n} is invalid',
  'timers.loadError': 'Could not read timers: {message}',
  'days.short': 'Su,Mo,Tu,We,Th,Fr,Sa',
  'detail.tab.info': 'Info',
  'detail.tab.settings': 'Settings',
  'detail.tab.rules': 'Rules',
  'detail.tab.timers': 'Timers',
  'detail.tab.console': 'Console',
  'detail.pendingHint': 'Changes are staged and only written from “Pending”.',
```

- [ ] **Step 6: Hilfsfunktionen und jsdom-Polyfills**

`tasmota_manager/packages/web/src/features/changes/labels.ts`:
```ts
import { type MessageKey, de } from '@/lib/messages';

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Beschriftung eines Puffer-Schlüssels; Rules und Timer werden aus ihrer Nummer gebildet. */
export function settingLabel(t: T, key: string): string {
  const rule = /^Rule(\d)(Enabled)?$/.exec(key);
  if (rule) return rule[2] ? `${t('rules.rule', { n: rule[1] ?? '' })} · ${t('rules.enabled')}` : t('rules.rule', { n: rule[1] ?? '' });
  const timer = /^Timer(\d{1,2})$/.exec(key);
  if (timer) return t('timers.timer', { n: timer[1] ?? '' });
  if (key === 'Timers') return t('timers.enabled');
  const label = `setting.${key}`;
  return label in de ? t(label as MessageKey) : key;
}
```

`tasmota_manager/packages/web/src/features/changes/useStage.ts`:
```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { StageRequest } from '@tm/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

/** Merkt Änderungen vor, meldet das Ergebnis und aktualisiert Puffer und Geräte. */
export function useStage(onDone?: () => void) {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: StageRequest) => api.stage(req),
    onSuccess: (result) => {
      toast.success(
        result.skipped > 0
          ? t('devices.stagedSkipped', { staged: result.staged, skipped: result.skipped })
          : t('devices.staged', { staged: result.staged }),
      );
      void qc.invalidateQueries({ queryKey: ['changes'] });
      void qc.invalidateQueries({ queryKey: ['devices'] });
      onDone?.();
    },
    onError: (err: Error) => toast.error(t('common.error', { message: err.message })),
  });
}
```

`tasmota_manager/packages/web/src/test/setup.ts`: am Dateiende anfügen:
```ts
// Radix-Popper, Menüs und Tabs erwarten Browser-APIs, die jsdom nicht mitbringt.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => undefined;
Element.prototype.scrollIntoView ??= () => undefined;
```

- [ ] **Step 7: Tests, Typecheck und Build ausführen**

```bash
pnpm --filter @tm/web test && pnpm --filter @tm/web build
```
Erwartet: PASS. Der bestehende Paritätstest (de/en) stellt sicher, dass beide Wörterbücher dieselben Schlüssel haben.

- [ ] **Step 8: Commit**

```bash
git add -A .
git commit -m "feat(web): add staging API client, live job events and translations"
```

---

### Task 13: Gerätetabelle – HA-Links, Namensvorschlag, Pufferstatus

**Files:**
- Create: `tasmota_manager/packages/web/src/features/devices/HaLinks.tsx`
- Create: `tasmota_manager/packages/web/src/features/devices/NameCell.tsx`
- Modify: `tasmota_manager/packages/web/src/features/devices/columns.tsx`
- Test: `tasmota_manager/packages/web/src/features/devices/DeviceTable.test.tsx`

**Interfaces:**
- Consumes: `Device.ha`, `nameSuggestion`, `pendingName`, `pendingCount` und `setOption4` (Task 1), `api.stageSuggestions` (Task 12)
- Produces:
  - `HaEntityLinks({ device })` und `HaAutomationLinks({ device })`
  - `NameCell({ device })`: Name, Vorschlagslabel (Klick merkt vor), Punkt bei ausstehenden Änderungen, SO4-Hinweis
  - neue Spalten `entities` und `automations`

- [ ] **Step 1: Failing Test schreiben**

`tasmota_manager/packages/web/src/features/devices/DeviceTable.test.tsx`:
```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { makeDevice } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { DeviceTable } from './DeviceTable';

vi.mock('@/lib/api', () => ({ api: { stageSuggestions: vi.fn() }, ApiError: class extends Error {} }));

const devices = [
  makeDevice({
    id: 'A',
    name: 'Tasmota',
    nameSuggestion: 'Klima Bad',
    ha: {
      deviceId: 'dev1',
      areaName: 'Bad',
      entities: [{ entityId: 'sensor.bad_temp', name: 'Temperatur Bad' }],
      automations: [
        { id: '1700000000', entityId: 'automation.licht_bad', name: 'Licht Bad' },
        { id: null, entityId: 'automation.yaml', name: 'YAML-Automation' },
      ],
    },
  }),
  makeDevice({ id: 'B', name: 'Garage', pendingName: 'Garage Tor', pendingCount: 2, setOption4: true }),
];

function renderTable(onOpen = vi.fn()) {
  renderWithProviders(<DeviceTable devices={devices} rowSelection={{}} onRowSelectionChange={vi.fn()} onOpen={onOpen} />);
  return onOpen;
}

describe('DeviceTable', () => {
  it('verlinkt HA-Entitäten und Automationen im Hauptfenster', () => {
    renderTable();
    const entity = screen.getByRole('link', { name: 'Temperatur Bad' });
    expect(entity).toHaveAttribute('href', '/config/entities?search=sensor.bad_temp');
    expect(entity).toHaveAttribute('target', '_top');
    expect(screen.getByRole('link', { name: 'Licht Bad' })).toHaveAttribute('href', '/config/automation/edit/1700000000');
    // Automationen ohne ID (YAML) sind nicht verlinkbar.
    expect(screen.queryByRole('link', { name: 'YAML-Automation' })).not.toBeInTheDocument();
    expect(screen.getByText('YAML-Automation')).toBeInTheDocument();
  });

  it('merkt den Namensvorschlag per Klick vor, ohne die Detailansicht zu öffnen', async () => {
    vi.mocked(api.stageSuggestions).mockResolvedValue({ staged: 2, skipped: 0 });
    const user = userEvent.setup();
    const onOpen = renderTable();
    await user.click(screen.getByRole('button', { name: /Klima Bad/ }));
    await waitFor(() => expect(api.stageSuggestions).toHaveBeenCalledWith(['A']));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('zeigt vorgemerkte Namen, ausstehende Änderungen und SetOption4', () => {
    renderTable();
    expect(screen.getByText('Garage')).toHaveClass('line-through');
    expect(screen.getByText('Garage Tor')).toBeInTheDocument();
    expect(screen.getByTitle('2 ausstehende Änderungen')).toBeInTheDocument();
    expect(screen.getByText('SO4')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Test ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/web test -- DeviceTable
```
Erwartet: FAIL (keine Links, keine Vorschlagsschaltfläche).

- [ ] **Step 3: Komponenten implementieren**

`tasmota_manager/packages/web/src/features/devices/HaLinks.tsx`:
```tsx
import type { Device } from '@tm/shared';
import type { MouseEvent } from 'react';

const chipClass = 'inline-flex max-w-48 truncate rounded-md border px-1.5 py-0.5 text-xs hover:bg-accent';
const stop = (e: MouseEvent) => e.stopPropagation();

export function HaEntityLinks({ device }: { device: Device }) {
  const entities = device.ha?.entities ?? [];
  if (entities.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {entities.map((e) => (
        <a
          key={e.entityId}
          href={`/config/entities?search=${encodeURIComponent(e.entityId)}`}
          target="_top"
          title={e.entityId}
          className={chipClass}
          onClick={stop}
        >
          {e.name}
        </a>
      ))}
    </div>
  );
}

export function HaAutomationLinks({ device }: { device: Device }) {
  const automations = device.ha?.automations ?? [];
  if (automations.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {automations.map((a) =>
        a.id ? (
          <a
            key={a.entityId}
            href={`/config/automation/edit/${encodeURIComponent(a.id)}`}
            target="_top"
            title={a.entityId}
            className={chipClass}
            onClick={stop}
          >
            {a.name}
          </a>
        ) : (
          <span key={a.entityId} title={a.entityId} className={`${chipClass} text-muted-foreground`}>
            {a.name}
          </span>
        ),
      )}
    </div>
  );
}
```

`tasmota_manager/packages/web/src/features/devices/NameCell.tsx`:
```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Device } from '@tm/shared';
import { TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

export function NameCell({ device }: { device: Device }) {
  const t = useT();
  const qc = useQueryClient();
  const stage = useMutation({
    mutationFn: () => api.stageSuggestions([device.id]),
    onSuccess: (result) => {
      toast.success(t('devices.staged', { staged: result.staged }));
      void qc.invalidateQueries({ queryKey: ['devices'] });
      void qc.invalidateQueries({ queryKey: ['changes'] });
    },
    onError: (err: Error) => toast.error(t('common.error', { message: err.message })),
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {device.pendingName ? (
        <>
          <span className="text-muted-foreground line-through">{device.name}</span>
          <span className="font-medium">{device.pendingName}</span>
        </>
      ) : (
        <span className="font-medium">{device.name}</span>
      )}
      {device.pendingCount > 0 && (
        <span title={t('devices.pendingDot', { count: device.pendingCount })} className="size-2 rounded-full bg-sky-500" />
      )}
      {device.nameSuggestion && (
        <button
          type="button"
          title={t('devices.suggestion.title')}
          disabled={stage.isPending}
          onClick={(e) => {
            e.stopPropagation();
            stage.mutate();
          }}
          className="inline-flex items-center gap-1 rounded-md border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
        >
          <TriangleAlert className="size-3" aria-hidden />
          {device.nameSuggestion}
        </button>
      )}
      {device.setOption4 && (
        <Badge variant="outline" title={t('devices.so4')}>
          SO4
        </Badge>
      )}
    </div>
  );
}
```

In `tasmota_manager/packages/web/src/features/devices/columns.tsx`:
- Imports ergänzen:
```tsx
import { HaAutomationLinks, HaEntityLinks } from './HaLinks';
import { NameCell } from './NameCell';
```
- Die Spalte `name` ersetzen durch:
```tsx
      { accessorKey: 'name', header: t('devices.col.name'), cell: ({ row }) => <NameCell device={row.original} /> },
```
- Direkt nach der Spalte `tags` einfügen:
```tsx
      {
        id: 'entities',
        header: t('devices.col.entities'),
        accessorFn: (d) => d.ha?.entities.length ?? 0,
        cell: ({ row }) => <HaEntityLinks device={row.original} />,
      },
      {
        id: 'automations',
        header: t('devices.col.automations'),
        accessorFn: (d) => d.ha?.automations.length ?? 0,
        cell: ({ row }) => <HaAutomationLinks device={row.original} />,
      },
```

- [ ] **Step 4: Tests und Build ausführen**

```bash
pnpm --filter @tm/web test && pnpm --filter @tm/web build
```
Erwartet: PASS. Das bestehende `DevicesPage.test.tsx` bleibt grün.

- [ ] **Step 5: Commit**

```bash
git add -A .
git commit -m "feat(web): show HA links, name suggestions and pending state in the device table"
```

---

### Task 14: Bearbeiten-Menü mit Einstellungsformular, Befehlen und Namensvorschlägen

**Files:**
- Create: `tasmota_manager/packages/web/src/features/changes/SettingsFields.tsx`
- Create: `tasmota_manager/packages/web/src/features/devices/BatchSettingsDialog.tsx`
- Create: `tasmota_manager/packages/web/src/features/devices/BatchCommandsDialog.tsx`
- Create: `tasmota_manager/packages/web/src/features/devices/EditMenu.tsx`
- Modify: `tasmota_manager/packages/web/src/features/devices/DevicesPage.tsx`
- Test: `tasmota_manager/packages/web/src/features/devices/EditMenu.test.tsx`
- Test: `tasmota_manager/packages/web/src/features/changes/SettingsFields.test.ts`

**Interfaces:**
- Consumes: `SETTINGS`, `SettingDef`, `renderPlaceholders` aus `@tm/shared`, `useStage` (Task 12), `api.stageSuggestions`
- Produces:
  - `SettingsFields({ defs, values, errors, onChange, current?, idPrefix })`
  - `collectSettings(defs, values): { settings: Record<string, string>; errors: Record<string, string> }`
  - `BatchSettingsDialog({ devices, open, onOpenChange })`
  - `BatchCommandsDialog({ devices, open, onOpenChange })`
  - `EditMenu({ devices })`. Task 16 fügt hier Rule und Timer hinzu.

- [ ] **Step 1: Failing Tests schreiben**

`tasmota_manager/packages/web/src/features/changes/SettingsFields.test.ts`:
```ts
import { SETTINGS } from '@tm/shared';
import { describe, expect, it } from 'vitest';
import { collectSettings } from './SettingsFields';

describe('collectSettings', () => {
  it('übernimmt nur ausgefüllte Felder und meldet ungültige', () => {
    const defs = SETTINGS.filter((d) => d.batch);
    const { settings, errors } = collectSettings(defs, { PowerOnState: '1', Sleep: '', TelePeriod: '5', LedPower: '0' });
    expect(settings).toEqual({ PowerOnState: '1', LedPower: '0' });
    expect(Object.keys(errors)).toEqual(['TelePeriod']);
  });
});
```

`tasmota_manager/packages/web/src/features/devices/EditMenu.test.tsx`:
```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { makeDevice } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { EditMenu } from './EditMenu';

vi.mock('@/lib/api', () => ({
  api: { stage: vi.fn(), stageSuggestions: vi.fn() },
  ApiError: class extends Error {},
}));

const devices = [makeDevice({ id: 'A', name: 'Keller' }), makeDevice({ id: 'B', name: 'Bad' })];

describe('EditMenu', () => {
  beforeEach(() => {
    vi.mocked(api.stage).mockResolvedValue({ staged: 2, skipped: 0 });
    vi.mocked(api.stageSuggestions).mockResolvedValue({ staged: 0, skipped: 0 });
  });

  it('merkt Einstellungen aus dem Formular für alle ausgewählten Geräte vor', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EditMenu devices={devices} />);
    await user.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Einstellungen …' }));
    await user.selectOptions(await screen.findByLabelText('Zustand nach Stromausfall'), '1');
    await user.type(screen.getByLabelText('Telemetrie-Intervall in s (10–3600)'), '60');
    await user.click(screen.getByRole('button', { name: 'Vormerken' }));
    await waitFor(() =>
      expect(api.stage).toHaveBeenCalledWith({ deviceIds: ['A', 'B'], settings: { PowerOnState: '1', TelePeriod: '60' }, source: 'form' }),
    );
  });

  it('zeigt Feldfehler statt ungültige Werte vorzumerken', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EditMenu devices={devices} />);
    await user.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Einstellungen …' }));
    await user.type(await screen.findByLabelText('Telemetrie-Intervall in s (10–3600)'), '5');
    await user.click(screen.getByRole('button', { name: 'Vormerken' }));
    expect(await screen.findByText('Erlaubt: 10–3600')).toBeInTheDocument();
    expect(api.stage).not.toHaveBeenCalled();
  });

  it('merkt freie Befehle mit Platzhaltern vor und zeigt eine Vorschau', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EditMenu devices={devices} />);
    await user.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Befehle …' }));
    await user.click(await screen.findByLabelText('Befehle'));
    await user.paste('FriendlyName1 {{name}}\nPower ON');
    expect(screen.getByText(/FriendlyName1 Keller/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Vormerken' }));
    await waitFor(() =>
      expect(api.stage).toHaveBeenCalledWith({
        deviceIds: ['A', 'B'],
        commands: ['FriendlyName1 {{name}}', 'Power ON'],
        source: 'command',
      }),
    );
  });

  it('übernimmt Namensvorschläge für die Auswahl', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EditMenu devices={devices} />);
    await user.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Namensvorschläge übernehmen' }));
    await waitFor(() => expect(api.stageSuggestions).toHaveBeenCalledWith(['A', 'B']));
  });
});
```

- [ ] **Step 2: Tests ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/web test -- EditMenu SettingsFields
```
Erwartet: FAIL (Module fehlen).

- [ ] **Step 3: Formularbausteine implementieren**

`tasmota_manager/packages/web/src/features/changes/SettingsFields.tsx`:
```tsx
import type { SettingDef } from '@tm/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/lib/i18n';
import type { MessageKey } from '@/lib/messages';
import { selectClass } from '@/lib/styles';

export type FieldValues = Record<string, string>;

interface Props {
  defs: readonly SettingDef[];
  values: FieldValues;
  errors: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** Aktuelle Werte eines Geräts (Detailansicht); erscheinen als Platzhalter. */
  current?: Record<string, string | null>;
  idPrefix: string;
}

const POWER_ON_STATES = ['0', '1', '2', '3', '4', '5'] as const;

/** Leere Felder bedeuten „unverändert“. */
export function SettingsFields({ defs, values, errors, onChange, current, idPrefix }: Props) {
  const t = useT();
  const groups = [...new Set(defs.map((d) => d.group))];
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <fieldset key={group} className="space-y-3">
          <legend className="text-sm font-medium">{t(`group.${group}` as MessageKey)}</legend>
          {defs
            .filter((d) => d.group === group)
            .map((def) => {
              const id = `${idPrefix}-${def.key}`;
              const value = values[def.key] ?? '';
              const currentValue = current?.[def.key] ?? null;
              const unchanged = currentValue !== null ? `${t('edit.unchanged')} (${currentValue})` : t('edit.unchanged');
              const isSelect = def.kind === 'bool' || def.key === 'PowerOnState';
              return (
                <div key={def.key} className="space-y-1">
                  <Label htmlFor={id}>{t(`setting.${def.key}` as MessageKey)}</Label>
                  {isSelect ? (
                    <select id={id} className={`${selectClass} w-full`} value={value} onChange={(e) => onChange(def.key, e.target.value)}>
                      <option value="">{unchanged}</option>
                      {def.kind === 'bool' ? (
                        <>
                          <option value="1">{t('bool.on')}</option>
                          <option value="0">{t('bool.off')}</option>
                        </>
                      ) : (
                        POWER_ON_STATES.map((v) => (
                          <option key={v} value={v}>
                            {t(`powerOn.${v}` as MessageKey)}
                          </option>
                        ))
                      )}
                    </select>
                  ) : (
                    <Input
                      id={id}
                      type={def.writeOnly ? 'password' : 'text'}
                      autoComplete={def.writeOnly ? 'new-password' : 'off'}
                      value={value}
                      placeholder={unchanged}
                      onChange={(e) => onChange(def.key, e.target.value)}
                    />
                  )}
                  {errors[def.key] && <p className="text-xs text-destructive">{errors[def.key]}</p>}
                </div>
              );
            })}
        </fieldset>
      ))}
    </div>
  );
}

/** Validiert die ausgefüllten Felder mit dem Katalog-Schema. */
export function collectSettings(
  defs: readonly SettingDef[],
  values: FieldValues,
): { settings: Record<string, string>; errors: Record<string, string> } {
  const settings: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const def of defs) {
    const raw = values[def.key];
    if (raw === undefined || raw.trim() === '') continue;
    const parsed = def.schema.safeParse(raw);
    if (parsed.success) settings[def.key] = parsed.data;
    else errors[def.key] = parsed.error.issues[0]?.message ?? 'ungültig';
  }
  return { settings, errors };
}
```

`tasmota_manager/packages/web/src/features/devices/BatchSettingsDialog.tsx`:
```tsx
import { type Device, SETTINGS } from '@tm/shared';
import { type FormEvent, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { type FieldValues, SettingsFields, collectSettings } from '@/features/changes/SettingsFields';
import { useStage } from '@/features/changes/useStage';
import { useT } from '@/lib/i18n';

interface Props {
  devices: Device[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BatchSettingsDialog({ devices, open, onOpenChange }: Props) {
  const t = useT();
  const defs = useMemo(() => SETTINGS.filter((d) => d.batch), []);
  const [values, setValues] = useState<FieldValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const stage = useStage(() => {
    setValues({});
    onOpenChange(false);
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const result = collectSettings(defs, values);
    setErrors(result.errors);
    if (Object.keys(result.errors).length > 0) return;
    if (Object.keys(result.settings).length === 0) {
      toast.error(t('edit.nothing'));
      return;
    }
    stage.mutate({ deviceIds: devices.map((d) => d.id), settings: result.settings, source: 'form' });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('edit.settings')}</DialogTitle>
          <DialogDescription>{t('edit.forDevices', { count: devices.length })}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <SettingsFields
            idPrefix="batch"
            defs={defs}
            values={values}
            errors={errors}
            onChange={(key, value) => setValues((v) => ({ ...v, [key]: value }))}
          />
          <DialogFooter>
            <Button type="submit" disabled={stage.isPending}>
              {t('edit.stage')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

`tasmota_manager/packages/web/src/features/devices/BatchCommandsDialog.tsx`:
```tsx
import { type Device, renderPlaceholders } from '@tm/shared';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useStage } from '@/features/changes/useStage';
import { useT } from '@/lib/i18n';

interface Props {
  devices: Device[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BatchCommandsDialog({ devices, open, onOpenChange }: Props) {
  const t = useT();
  const [text, setText] = useState('');
  const stage = useStage(() => {
    setText('');
    onOpenChange(false);
  });
  const commands = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const sample = devices[0];
  const preview = sample ? commands.map((c) => renderPlaceholders(c, sample)) : [];
  const unknown = preview.find((p) => !p.ok);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (commands.length === 0) {
      toast.error(t('edit.nothing'));
      return;
    }
    if (unknown && !unknown.ok) {
      toast.error(t('edit.commands.unknown', { placeholder: `{{${unknown.unknown}}}` }));
      return;
    }
    stage.mutate({ deviceIds: devices.map((d) => d.id), commands, source: 'command' });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('edit.commands')}</DialogTitle>
          <DialogDescription>{t('edit.forDevices', { count: devices.length })}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Label htmlFor="batch-commands">{t('edit.commands.label')}</Label>
          <Textarea id="batch-commands" rows={6} className="font-mono" value={text} onChange={(e) => setText(e.target.value)} />
          <p className="text-xs text-muted-foreground">{t('edit.commands.hint')}</p>
          {sample && commands.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t('edit.commands.preview', { name: sample.name })}</p>
              <pre className="rounded-md border bg-muted/30 p-2 font-mono text-xs whitespace-pre-wrap">
                {preview.map((p) => (p.ok ? p.value : `⚠ {{${p.unknown}}}`)).join('\n')}
              </pre>
            </div>
          )}
          <DialogFooter>
            <Button type="submit" disabled={stage.isPending}>
              {t('edit.stage')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

`tasmota_manager/packages/web/src/features/devices/EditMenu.tsx`:
```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Device } from '@tm/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { BatchCommandsDialog } from './BatchCommandsDialog';
import { BatchSettingsDialog } from './BatchSettingsDialog';

type DialogKind = 'settings' | 'commands' | null;

export function EditMenu({ devices }: { devices: Device[] }) {
  const t = useT();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const suggestions = useMutation({
    mutationFn: () => api.stageSuggestions(devices.map((d) => d.id)),
    onSuccess: (result) => {
      if (result.staged === 0) toast(t('edit.suggestions.none'));
      else toast.success(t('devices.staged', { staged: result.staged }));
      void qc.invalidateQueries({ queryKey: ['devices'] });
      void qc.invalidateQueries({ queryKey: ['changes'] });
    },
    onError: (err: Error) => toast.error(t('common.error', { message: err.message })),
  });
  const onOpenChange = (open: boolean) => {
    if (!open) setDialog(null);
  };

  return (
    <>
      {/* modal={false}: sonst blockiert das Menü beim Öffnen eines Dialogs die Zeiger-Ereignisse. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button size="sm">{t('edit.menu')}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => setDialog('settings')}>{t('edit.settings')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('commands')}>{t('edit.commands')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => suggestions.mutate()}>{t('edit.suggestions')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <BatchSettingsDialog devices={devices} open={dialog === 'settings'} onOpenChange={onOpenChange} />
      <BatchCommandsDialog devices={devices} open={dialog === 'commands'} onOpenChange={onOpenChange} />
    </>
  );
}
```

- [ ] **Step 4: In die Übersicht einbinden**

In `tasmota_manager/packages/web/src/features/devices/DevicesPage.tsx`:
- Import ergänzen: `import { EditMenu } from './EditMenu';`
- Die Zeile `const selectedCount = devices.filter((d) => rowSelection[d.id]).length;` ersetzen durch:
```tsx
  const selected = devices.filter((d) => rowSelection[d.id]);
  const selectedCount = selected.length;
```
- In der Auswahlleiste direkt nach `<span>{t('devices.selected', { count: selectedCount })}</span>` einfügen:
```tsx
          <EditMenu devices={selected} />
```

- [ ] **Step 5: Tests und Build ausführen**

```bash
pnpm --filter @tm/web test && pnpm --filter @tm/web build
```
Erwartet: PASS. Öffnet sich das Radix-Menü in jsdom nicht, liegt es meist an fehlenden Pointer-APIs. Die Polyfills aus Task 12 decken `hasPointerCapture` und `ResizeObserver` ab. Ergänze fehlende APIs dort und nicht im Test.

- [ ] **Step 6: Commit**

```bash
git add -A .
git commit -m "feat(web): add batch edit menu with settings form, commands and name suggestions"
```

---

### Task 15: Seite „Ausstehend“ mit Batch-Start und Fortschritt

**Files:**
- Create: `tasmota_manager/packages/web/src/features/pending/PendingPage.tsx`
- Create: `tasmota_manager/packages/web/src/features/pending/JobProgress.tsx`
- Create: `tasmota_manager/packages/web/src/features/pending/liveValue.ts`
- Modify: `tasmota_manager/packages/web/src/lib/route.ts`
- Modify: `tasmota_manager/packages/web/src/App.tsx`
- Test: `tasmota_manager/packages/web/src/features/pending/PendingPage.test.tsx`
- Test: `tasmota_manager/packages/web/src/features/pending/liveValue.test.ts`

**Interfaces:**
- Consumes: `api.changes`, `api.currentJob`, `api.apply`, `api.discardChange`, `api.discardDevice`, `api.discardAll`, `api.rules` und `api.timers` (Task 12), `settingLabel` (Task 12)
- Produces:
  - `PendingPage` und `JobProgress({ job })`
  - `liveKind(key): 'rules' | 'timers' | null` und `liveValue(key, data): string | null`
  - Route `'pending'` in `ROUTES` (Reihenfolge `devices`, `pending`, `settings`)
  - Zähler im Menüpunkt „Ausstehend“

- [ ] **Step 1: Failing Tests schreiben**

`tasmota_manager/packages/web/src/features/pending/liveValue.test.ts`:
```ts
import { DEFAULT_TIMER } from '@tm/shared';
import { describe, expect, it } from 'vitest';
import { liveKind, liveValue } from './liveValue';

describe('liveValue', () => {
  it('ordnet Schlüssel Rules oder Timern zu', () => {
    expect(liveKind('Rule2')).toBe('rules');
    expect(liveKind('Rule2Enabled')).toBe('rules');
    expect(liveKind('Timer16')).toBe('timers');
    expect(liveKind('Timers')).toBe('timers');
    expect(liveKind('LedState')).toBeNull();
  });

  it('liest den passenden aktuellen Wert', () => {
    const rules = [1, 2, 3].map((index) => ({ index, enabled: index === 2, text: `rule ${index}`, length: 6, free: 505 }));
    expect(liveValue('Rule2', rules)).toBe('rule 2');
    expect(liveValue('Rule2Enabled', rules)).toBe('1');
    const timers = { enabled: false, timers: Array.from({ length: 16 }, () => DEFAULT_TIMER) };
    expect(liveValue('Timers', timers)).toBe('0');
    expect(JSON.parse(liveValue('Timer3', timers) ?? '')).toEqual(DEFAULT_TIMER);
  });
});
```

`tasmota_manager/packages/web/src/features/pending/PendingPage.test.tsx`:
```tsx
import type { JobView, PendingDevice } from '@tm/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { renderWithProviders } from '@/test/render';
import { PendingPage } from './PendingPage';

vi.mock('@/lib/api', () => ({
  api: {
    changes: vi.fn(),
    currentJob: vi.fn(),
    apply: vi.fn(),
    discardChange: vi.fn(),
    discardDevice: vi.fn(),
    discardAll: vi.fn(),
    rules: vi.fn(),
    timers: vi.fn(),
  },
  ApiError: class extends Error {},
}));

const change = (partial: Partial<PendingDevice['changes'][number]>) => ({
  id: 1,
  deviceId: 'A',
  kind: 'setting' as const,
  key: 'PowerOnState',
  value: '1',
  before: '3',
  source: 'form' as const,
  error: null,
  updatedAt: 'x',
  ...partial,
});

const GROUPS: PendingDevice[] = [
  {
    deviceId: 'A',
    deviceName: 'Keller',
    changes: [
      change({ id: 1 }),
      change({ id: 2, key: 'Rule1', value: 'ON x DO y ENDON', before: null }),
      change({ id: 3, kind: 'command', key: null, value: 'Power ON', before: null, error: 'rejected: Gerät lehnt ab' }),
    ],
  },
  { deviceId: 'B', deviceName: 'Bad', changes: [change({ id: 4, deviceId: 'B', key: 'MqttPassword', value: '••••', before: null })] },
];

const JOB: JobView = {
  id: 1,
  status: 'running',
  createdAt: 'x',
  finishedAt: null,
  items: [
    { deviceId: 'A', deviceName: 'Keller', status: 'running', step: 'restart', error: null },
    { deviceId: 'B', deviceName: 'Bad', status: 'success', step: null, error: null },
  ],
};

describe('PendingPage', () => {
  beforeEach(() => {
    vi.mocked(api.changes).mockResolvedValue(GROUPS);
    vi.mocked(api.currentJob).mockResolvedValue({ job: null });
    vi.mocked(api.apply).mockResolvedValue({ ...JOB, status: 'running' });
    vi.mocked(api.discardChange).mockResolvedValue(undefined);
    vi.mocked(api.rules).mockResolvedValue([
      { index: 1, enabled: false, text: 'alt', length: 3, free: 508 },
      { index: 2, enabled: false, text: '', length: 0, free: 511 },
      { index: 3, enabled: false, text: '', length: 0, free: 511 },
    ]);
  });

  it('zeigt Änderungen gruppiert mit Vorher/Nachher und Fehlern', async () => {
    renderWithProviders(<PendingPage />);
    const keller = await screen.findByTestId('pending-A');
    expect(within(keller).getByText('Zustand nach Stromausfall')).toBeInTheDocument();
    expect(within(keller).getByText('3')).toHaveClass('line-through');
    expect(within(keller).getByText('Power ON')).toBeInTheDocument();
    expect(within(keller).getByText('rejected: Gerät lehnt ab')).toBeInTheDocument();
    expect(within(screen.getByTestId('pending-B')).getByText('••••')).toBeInTheDocument();
  });

  it('lädt den aktuellen Wert einer Rule bei Bedarf', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PendingPage />);
    const keller = await screen.findByTestId('pending-A');
    await user.click(within(keller).getByRole('button', { name: 'Aktuellen Wert laden' }));
    expect(await within(keller).findByText('alt')).toBeInTheDocument();
    expect(api.rules).toHaveBeenCalledWith('A');
  });

  it('startet den Batch für alle Geräte', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PendingPage />);
    await user.click(await screen.findByRole('button', { name: 'Batch starten (2 Geräte)' }));
    await waitFor(() => expect(api.apply).toHaveBeenCalledWith(undefined));
  });

  it('startet fehlgeschlagene Geräte erneut', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PendingPage />);
    await user.click(await screen.findByRole('button', { name: 'Fehlgeschlagene erneut starten' }));
    await waitFor(() => expect(api.apply).toHaveBeenCalledWith(['A']));
  });

  it('verwirft einzelne Einträge', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PendingPage />);
    const keller = await screen.findByTestId('pending-A');
    await user.click(within(keller).getAllByRole('button', { name: 'Verwerfen' })[0] as HTMLElement);
    await waitFor(() => expect(api.discardChange).toHaveBeenCalledWith(1));
  });

  it('zeigt den Fortschritt eines laufenden Batches und sperrt den Start', async () => {
    vi.mocked(api.currentJob).mockResolvedValue({ job: JOB });
    renderWithProviders(<PendingPage />);
    expect(await screen.findByText('Warte auf Neustart')).toBeInTheDocument();
    expect(screen.getByText('Erfolgreich')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Batch läuft …' })).toBeDisabled();
  });

  it('zeigt einen Hinweis ohne ausstehende Änderungen', async () => {
    vi.mocked(api.changes).mockResolvedValue([]);
    renderWithProviders(<PendingPage />);
    expect(await screen.findByText(/Keine ausstehenden Änderungen/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Tests ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/web test -- pending
```
Erwartet: FAIL (Module fehlen).

- [ ] **Step 3: Implementieren**

`tasmota_manager/packages/web/src/features/pending/liveValue.ts`:
```ts
import type { RuleState, TimersState } from '@tm/shared';

export type LiveKind = 'rules' | 'timers';

/** Rules und Timer stehen nicht im gespeicherten Status; ihr aktueller Wert wird bei Bedarf vom Gerät geladen. */
export function liveKind(key: string | null): LiveKind | null {
  if (!key) return null;
  if (/^Rule\d(Enabled)?$/.test(key)) return 'rules';
  if (/^Timer\d{1,2}$/.test(key) || key === 'Timers') return 'timers';
  return null;
}

export function liveValue(key: string, data: RuleState[] | TimersState): string | null {
  const rule = /^Rule(\d)(Enabled)?$/.exec(key);
  if (rule && Array.isArray(data)) {
    const state = data.find((r) => r.index === Number(rule[1]));
    if (!state) return null;
    return rule[2] ? (state.enabled ? '1' : '0') : state.text;
  }
  if (!Array.isArray(data)) {
    if (key === 'Timers') return data.enabled ? '1' : '0';
    const timer = /^Timer(\d{1,2})$/.exec(key);
    const value = timer ? data.timers[Number(timer[1]) - 1] : undefined;
    return value ? JSON.stringify(value) : null;
  }
  return null;
}
```

`tasmota_manager/packages/web/src/features/pending/JobProgress.tsx`:
```tsx
import type { JobItemStatus, JobView } from '@tm/shared';
import { Card, CardContent } from '@/components/ui/card';
import { useT } from '@/lib/i18n';

const STATUS_CLASS: Record<JobItemStatus, string> = {
  pending: 'text-muted-foreground',
  running: 'text-sky-600 dark:text-sky-400',
  success: 'text-emerald-600 dark:text-emerald-400',
  failed: 'text-destructive',
};

export function JobProgress({ job }: { job: JobView }) {
  const t = useT();
  const finished = job.items.filter((i) => i.status === 'success' || i.status === 'failed').length;
  const percent = Math.round((finished / Math.max(job.items.length, 1)) * 100);
  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="h-2 w-full overflow-hidden rounded bg-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
        </div>
        <ul className="space-y-1 text-sm">
          {job.items.map((item) => (
            <li key={item.deviceId} className="flex flex-wrap gap-2">
              <span className="font-medium">{item.deviceName}</span>
              <span className={STATUS_CLASS[item.status]}>{t(`job.status.${item.status}`)}</span>
              {item.step && <span className="text-muted-foreground">{t(`job.step.${item.step}`)}</span>}
              {item.error && <span className="w-full text-xs text-destructive">{item.error}</span>}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
```

`tasmota_manager/packages/web/src/features/pending/PendingPage.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PendingChange, PendingDevice } from '@tm/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { settingLabel } from '@/features/changes/labels';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { JobProgress } from './JobProgress';
import { liveKind, liveValue } from './liveValue';

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['changes'] });
    void qc.invalidateQueries({ queryKey: ['devices'] });
  };
}

export function PendingPage() {
  const t = useT();
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  const { data: groups = [] } = useQuery({ queryKey: ['changes'], queryFn: api.changes });
  const { data: jobData } = useQuery({ queryKey: ['job'], queryFn: api.currentJob });
  const job = jobData?.job ?? null;
  const running = job?.status === 'running';
  const onError = (err: Error) => toast.error(t('common.error', { message: err.message }));

  const apply = useMutation({
    mutationFn: (deviceIds?: string[]) => api.apply(deviceIds),
    onSuccess: (started) => {
      qc.setQueryData(['job'], { job: started });
      toast.success(t('pending.started'));
    },
    onError,
  });
  const discardAll = useMutation({ mutationFn: () => api.discardAll(), onSuccess: invalidate, onError });
  const failedDeviceIds = groups.filter((g) => g.changes.some((c) => c.error)).map((g) => g.deviceId);
  const locked = running || apply.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold">{t('pending.title')}</h1>
        {failedDeviceIds.length > 0 && (
          <Button variant="outline" disabled={locked} onClick={() => apply.mutate(failedDeviceIds)}>
            {t('pending.retry')}
          </Button>
        )}
        {groups.length > 0 && (
          <Button
            variant="outline"
            disabled={locked}
            onClick={() => window.confirm(t('pending.discardAllConfirm')) && discardAll.mutate()}
          >
            {t('pending.discardAll')}
          </Button>
        )}
        <Button disabled={groups.length === 0 || locked} onClick={() => apply.mutate(undefined)}>
          {running ? t('pending.running') : t('pending.apply', { count: groups.length })}
        </Button>
      </div>
      {job && <JobProgress job={job} />}
      {groups.length === 0 ? (
        <p className="text-muted-foreground">{t('pending.empty')}</p>
      ) : (
        groups.map((group) => <PendingGroup key={group.deviceId} group={group} disabled={locked} />)
      )}
    </div>
  );
}

function PendingGroup({ group, disabled }: { group: PendingDevice; disabled: boolean }) {
  const t = useT();
  const invalidate = useInvalidate();
  const discard = useMutation({
    mutationFn: () => api.discardDevice(group.deviceId),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(t('common.error', { message: err.message })),
  });
  return (
    <Card data-testid={`pending-${group.deviceId}`}>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{group.deviceName}</CardTitle>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => discard.mutate()}>
          {t('pending.discardDevice')}
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {group.changes.map((change) => (
            <PendingRow key={change.id} change={change} disabled={disabled} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function PendingRow({ change, disabled }: { change: PendingChange; disabled: boolean }) {
  const t = useT();
  const invalidate = useInvalidate();
  const discard = useMutation({
    mutationFn: () => api.discardChange(change.id),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(t('common.error', { message: err.message })),
  });
  const label = change.kind === 'command' ? t('pending.command') : settingLabel(t, change.key ?? '');
  return (
    <li className="flex flex-wrap items-center gap-2 py-2 text-sm">
      <span className="w-56 shrink-0 text-muted-foreground">{label}</span>
      {change.kind === 'setting' && (
        <>
          <BeforeValue change={change} />
          <span aria-hidden>→</span>
        </>
      )}
      <span className="font-mono break-all">{change.value}</span>
      <Button variant="ghost" size="sm" className="ml-auto" disabled={disabled} onClick={() => discard.mutate()}>
        {t('pending.discard')}
      </Button>
      {change.error && <span className="w-full text-xs text-destructive">{change.error}</span>}
    </li>
  );
}

function BeforeValue({ change }: { change: PendingChange }) {
  const t = useT();
  const [load, setLoad] = useState(false);
  const kind = liveKind(change.key);
  const query = useQuery({
    queryKey: [kind ?? 'none', change.deviceId],
    queryFn: () => (kind === 'rules' ? api.rules(change.deviceId) : api.timers(change.deviceId)),
    enabled: load && kind !== null,
  });
  const struck = 'font-mono text-muted-foreground line-through break-all';
  if (change.before !== null) return <span className={struck}>{change.before === '' ? '""' : change.before}</span>;
  if (!kind) return <span className="text-muted-foreground">{t('pending.unknown')}</span>;
  if (!load) {
    return (
      <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setLoad(true)}>
        {t('pending.loadCurrent')}
      </Button>
    );
  }
  if (!query.data) return <span className="text-muted-foreground">…</span>;
  return <span className={struck}>{liveValue(change.key ?? '', query.data) ?? '—'}</span>;
}
```

`tasmota_manager/packages/web/src/lib/route.ts`: `ROUTES` ersetzen durch:
```ts
export const ROUTES = ['devices', 'pending', 'settings'] as const;
```

`tasmota_manager/packages/web/src/App.tsx`:
- Imports ergänzen:
```tsx
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { PendingPage } from '@/features/pending/PendingPage';
import { api } from '@/lib/api';
```
- In `App` nach `const [route, navigate] = useHashRoute();` einfügen:
```tsx
  const { data: changes = [] } = useQuery({ queryKey: ['changes'], queryFn: api.changes });
  const pendingTotal = changes.reduce((sum, group) => sum + group.changes.length, 0);
```
- Den Inhalt des Navigations-Buttons ersetzen durch:
```tsx
            {t(`nav.${r}`)}
            {r === 'pending' && pendingTotal > 0 && <Badge className="ml-auto">{pendingTotal}</Badge>}
```
- Die Zeile `{route === 'devices' ? <DevicesPage /> : <SettingsPage />}` ersetzen durch:
```tsx
        {route === 'devices' ? <DevicesPage /> : route === 'pending' ? <PendingPage /> : <SettingsPage />}
```

- [ ] **Step 4: Tests und Build ausführen**

```bash
pnpm --filter @tm/web test && pnpm --filter @tm/web build
```
Erwartet: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A .
git commit -m "feat(web): add pending changes page with batch start, retry and progress"
```

---

### Task 16: Rule-Editor, Timer-Formular und Batch-Dialoge

**Files:**
- Create: `tasmota_manager/packages/web/src/features/rules/RuleEditor.tsx`
- Create: `tasmota_manager/packages/web/src/features/timers/TimerForm.tsx`
- Create: `tasmota_manager/packages/web/src/features/devices/BatchRuleDialog.tsx`
- Create: `tasmota_manager/packages/web/src/features/devices/BatchTimerDialog.tsx`
- Modify: `tasmota_manager/packages/web/src/features/devices/EditMenu.tsx`
- Test: `tasmota_manager/packages/web/src/features/rules/RuleEditor.test.tsx`
- Test: `tasmota_manager/packages/web/src/features/timers/TimerForm.test.tsx`
- Test: `tasmota_manager/packages/web/src/features/devices/EditMenu.test.tsx` (ergänzen)

**Interfaces:**
- Consumes: `MAX_RULE_LENGTH`, `Timer`, `TimerSchema`, `DEFAULT_TIMER` aus `@tm/shared`, `useStage` (Task 12)
- Produces:
  - `highlightRule(text): ReactNode[]`
  - `RuleEditor({ id, value, onChange, max? })`
  - `TimerForm({ id, value, onChange })`
  - `timerSummary(timer, t): string`
  - `toggleDay(days, index, on): string`
  - `BatchRuleDialog({ devices, open, onOpenChange })` und `BatchTimerDialog({ devices, open, onOpenChange })`
  - `EditMenu` mit den Einträgen „Rule setzen …“ und „Timer setzen …“

- [ ] **Step 1: Failing Tests schreiben**

`tasmota_manager/packages/web/src/features/rules/RuleEditor.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { RuleEditor, highlightRule } from './RuleEditor';

function Harness({ initial, max }: { initial: string; max?: number }) {
  const [value, setValue] = useState(initial);
  return (
    <I18nProvider lang="de">
      <label htmlFor="rule">Rule</label>
      <RuleEditor id="rule" value={value} onChange={setValue} max={max} />
    </I18nProvider>
  );
}

describe('highlightRule', () => {
  it('markiert Schlüsselwörter, Variablen und Speicher', () => {
    render(<pre>{highlightRule('ON Power1#State DO Var1 %value% ENDON')}</pre>);
    expect(screen.getByText('ON')).toHaveAttribute('data-token', 'keyword');
    expect(screen.getByText('DO')).toHaveAttribute('data-token', 'keyword');
    expect(screen.getByText('%value%')).toHaveAttribute('data-token', 'variable');
    expect(screen.getByText('Var1')).toHaveAttribute('data-token', 'memory');
  });
});

describe('RuleEditor', () => {
  it('zählt Zeichen und warnt bei Überlänge', async () => {
    const user = userEvent.setup();
    render(<Harness initial="abc" max={5} />);
    expect(screen.getByText('3 / 5 Zeichen')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Rule'), 'def');
    expect(screen.getByText(/6 \/ 5 Zeichen – Die Rule ist zu lang\./)).toBeInTheDocument();
  });
});
```

`tasmota_manager/packages/web/src/features/timers/TimerForm.test.tsx`:
```tsx
import { DEFAULT_TIMER, type Timer } from '@tm/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { I18nProvider, formatMessage } from '@/lib/i18n';
import { de } from '@/lib/messages';
import { TimerForm, timerSummary, toggleDay } from './TimerForm';

function Harness({ onChange }: { onChange: (t: Timer) => void }) {
  const [value, setValue] = useState<Timer>(DEFAULT_TIMER);
  return (
    <I18nProvider lang="de">
      <TimerForm
        id="t1"
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
    </I18nProvider>
  );
}

describe('TimerForm', () => {
  it('setzt Tage, Modus und Aktion', async () => {
    const user = userEvent.setup();
    const changes: Timer[] = [];
    render(<Harness onChange={(t) => changes.push(t)} />);
    await user.click(screen.getByRole('checkbox', { name: 'Aktiv' }));
    await user.click(screen.getByRole('checkbox', { name: 'Mo' }));
    await user.selectOptions(screen.getByLabelText('Modus'), '2');
    await user.selectOptions(screen.getByLabelText('Aktion'), '1');
    expect(changes.at(-1)).toMatchObject({ Enable: 1, Days: '0100000', Mode: 2, Action: 1 });
    expect(screen.getByText('Für Sonnenzeiten müssen Breiten- und Längengrad gesetzt sein.')).toBeInTheDocument();
    expect(screen.getByLabelText('Versatz (±HH:MM)')).toBeInTheDocument();
  });

  it('fasst Timer zusammen', () => {
    const t = (key: keyof typeof de, vars?: Record<string, string | number>) => formatMessage(de[key], vars);
    expect(toggleDay('0000000', 6, true)).toBe('0000001');
    expect(timerSummary(DEFAULT_TIMER, t)).toBe('inaktiv');
    expect(timerSummary({ ...DEFAULT_TIMER, Enable: 1, Time: '06:30', Days: '0111110', Action: 1, Output: 2 }, t)).toBe(
      'Uhrzeit 06:30 · Mo, Di, Mi, Do, Fr · An → 2',
    );
  });
});
```

In `tasmota_manager/packages/web/src/features/devices/EditMenu.test.tsx` im Block `describe('EditMenu', …)` anfügen:
```ts
  it('setzt eine Rule für alle ausgewählten Geräte', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EditMenu devices={devices} />);
    await user.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rule setzen …' }));
    await user.selectOptions(await screen.findByLabelText('Rule-Nummer'), '2');
    await user.click(screen.getByLabelText('Rule 2'));
    await user.paste('ON Power1#State DO Publish x ENDON');
    await user.click(screen.getByRole('button', { name: 'Vormerken' }));
    await waitFor(() =>
      expect(api.stage).toHaveBeenCalledWith({
        deviceIds: ['A', 'B'],
        settings: { Rule2: 'ON Power1#State DO Publish x ENDON', Rule2Enabled: '1' },
        source: 'rule',
      }),
    );
  });

  it('setzt einen Timer für alle ausgewählten Geräte', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EditMenu devices={devices} />);
    await user.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Timer setzen …' }));
    await user.selectOptions(await screen.findByLabelText('Timer-Nummer'), '4');
    const time = screen.getByLabelText('Zeit (HH:MM)');
    await user.clear(time);
    await user.type(time, '06:45');
    await user.click(screen.getByRole('button', { name: 'Vormerken' }));
    await waitFor(() => expect(api.stage).toHaveBeenCalled());
    const request = vi.mocked(api.stage).mock.calls.at(-1)?.[0];
    expect(request?.source).toBe('timer');
    expect(request?.settings?.Timers).toBe('1');
    expect(JSON.parse(request?.settings?.Timer4 ?? '')).toMatchObject({ Enable: 1, Time: '06:45', Days: '1111111', Repeat: 1 });
  });
```

- [ ] **Step 2: Tests ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/web test -- RuleEditor TimerForm EditMenu
```
Erwartet: FAIL (Module und Menüeinträge fehlen).

- [ ] **Step 3: Editoren implementieren**

`tasmota_manager/packages/web/src/features/rules/RuleEditor.tsx`:
```tsx
import { MAX_RULE_LENGTH } from '@tm/shared';
import type { ReactNode } from 'react';
import { useT } from '@/lib/i18n';

const TOKEN = /(\b(?:on|do|endon|break|if|else|elseif|endif|and|or)\b)|(%[^%\s]+%)|(\b(?:var|mem)\d+\b)/gi;

/** Einfache Syntax-Hervorhebung für Tasmota-Rules. */
export function highlightRule(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    const [token, keyword, variable] = match;
    const kind = keyword ? 'keyword' : variable ? 'variable' : 'memory';
    const className =
      kind === 'keyword'
        ? 'font-semibold text-sky-600 dark:text-sky-400'
        : kind === 'variable'
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-emerald-600 dark:text-emerald-400';
    nodes.push(
      <span key={key++} data-token={kind} className={className}>
        {token}
      </span>,
    );
    last = index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

interface Props {
  id: string;
  value: string;
  onChange: (value: string) => void;
  max?: number;
}

/** Textarea über einer hervorgehobenen Kopie desselben Texts (gleiche Schrift und Abstände). */
export function RuleEditor({ id, value, onChange, max = MAX_RULE_LENGTH }: Props) {
  const t = useT();
  const tooLong = value.length > max;
  return (
    <div className="space-y-1">
      <div className="relative font-mono text-sm">
        <pre aria-hidden className="pointer-events-none min-h-24 rounded-md border border-transparent px-3 py-2 break-words whitespace-pre-wrap">
          {highlightRule(value)}
          {'\n'}
        </pre>
        <textarea
          id={id}
          value={value}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-transparent caret-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <p className={`text-xs ${tooLong ? 'text-destructive' : 'text-muted-foreground'}`}>
        {t('rules.length', { length: value.length, max })}
        {tooLong ? ` – ${t('rules.tooLong')}` : ''}
      </p>
    </div>
  );
}
```

`tasmota_manager/packages/web/src/features/timers/TimerForm.tsx`:
```tsx
import type { Timer } from '@tm/shared';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/lib/i18n';
import type { MessageKey } from '@/lib/messages';
import { selectClass } from '@/lib/styles';

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

export const toggleDay = (days: string, index: number, on: boolean): string =>
  days.slice(0, index) + (on ? '1' : '0') + days.slice(index + 1);

/** Kurzfassung für Listen, z. B. „Uhrzeit 06:30 · Mo, Di · An → 1“. */
export function timerSummary(timer: Timer, t: T): string {
  if (timer.Enable !== 1) return t('timers.inactive');
  const names = t('days.short').split(',');
  const days = [...timer.Days].flatMap((c, i) => (c === '1' ? [names[i] ?? ''] : [])).join(', ');
  const mode = t(`timers.mode.${timer.Mode}` as MessageKey);
  const action = t(`timers.action.${timer.Action}` as MessageKey);
  return `${mode} ${timer.Time} · ${days || '—'} · ${action} → ${timer.Output}`;
}

interface Props {
  id: string;
  value: Timer;
  onChange: (timer: Timer) => void;
}

export function TimerForm({ id, value, onChange }: Props) {
  const t = useT();
  const set = <K extends keyof Timer>(key: K, v: Timer[K]) => onChange({ ...value, [key]: v });
  const sun = value.Mode !== 0;
  const days = t('days.short').split(',');
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={value.Enable === 1} onCheckedChange={(v) => set('Enable', v ? 1 : 0)} aria-label={t('timers.active')} />
        {t('timers.active')}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={value.Repeat === 1} onCheckedChange={(v) => set('Repeat', v ? 1 : 0)} aria-label={t('timers.repeat')} />
        {t('timers.repeat')}
      </label>
      <div className="space-y-1">
        <Label htmlFor={`${id}-mode`}>{t('timers.mode')}</Label>
        <select id={`${id}-mode`} className={`${selectClass} w-full`} value={value.Mode} onChange={(e) => set('Mode', Number(e.target.value))}>
          {[0, 1, 2].map((m) => (
            <option key={m} value={m}>
              {t(`timers.mode.${m}` as MessageKey)}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-time`}>{sun ? t('timers.offset') : t('timers.time')}</Label>
        <Input id={`${id}-time`} value={value.Time} placeholder={sun ? '+00:30' : '06:30'} onChange={(e) => set('Time', e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-window`}>{t('timers.window')}</Label>
        <Input
          id={`${id}-window`}
          type="number"
          min={0}
          max={15}
          value={value.Window}
          onChange={(e) => set('Window', Number(e.target.value))}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-output`}>{t('timers.output')}</Label>
        <Input
          id={`${id}-output`}
          type="number"
          min={1}
          max={16}
          value={value.Output}
          onChange={(e) => set('Output', Number(e.target.value))}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-action`}>{t('timers.action')}</Label>
        <select id={`${id}-action`} className={`${selectClass} w-full`} value={value.Action} onChange={(e) => set('Action', Number(e.target.value))}>
          {[0, 1, 2, 3].map((a) => (
            <option key={a} value={a}>
              {t(`timers.action.${a}` as MessageKey)}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1 sm:col-span-2">
        <span className="text-sm font-medium">{t('timers.days')}</span>
        <div className="flex flex-wrap gap-3">
          {days.map((day, index) => (
            <label key={day} className="flex items-center gap-1 text-sm">
              <Checkbox
                checked={value.Days[index] === '1'}
                onCheckedChange={(v) => set('Days', toggleDay(value.Days, index, Boolean(v)))}
                aria-label={day}
              />
              {day}
            </label>
          ))}
        </div>
      </div>
      {sun && <p className="text-xs text-muted-foreground sm:col-span-2">{t('timers.sunHint')}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Batch-Dialoge implementieren und ins Menü aufnehmen**

`tasmota_manager/packages/web/src/features/devices/BatchRuleDialog.tsx`:
```tsx
import { type Device, MAX_RULE_LENGTH } from '@tm/shared';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useStage } from '@/features/changes/useStage';
import { RuleEditor } from '@/features/rules/RuleEditor';
import { useT } from '@/lib/i18n';
import { selectClass } from '@/lib/styles';

interface Props {
  devices: Device[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BatchRuleDialog({ devices, open, onOpenChange }: Props) {
  const t = useT();
  const [slot, setSlot] = useState(1);
  const [text, setText] = useState('');
  const [enabled, setEnabled] = useState(true);
  const stage = useStage(() => {
    setText('');
    onOpenChange(false);
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.length > MAX_RULE_LENGTH) {
      toast.error(t('rules.tooLong'));
      return;
    }
    stage.mutate({
      deviceIds: devices.map((d) => d.id),
      settings: { [`Rule${slot}`]: text, [`Rule${slot}Enabled`]: enabled ? '1' : '0' },
      source: 'rule',
    });
  };
  const editorId = 'batch-rule-text';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('edit.rule')}</DialogTitle>
          <DialogDescription>{t('edit.forDevices', { count: devices.length })}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label htmlFor="batch-rule-slot">{t('edit.rule.slot')}</Label>
              <select id="batch-rule-slot" className={selectClass} value={slot} onChange={(e) => setSlot(Number(e.target.value))}>
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(Boolean(v))} aria-label={t('rules.enabled')} />
              {t('rules.enabled')}
            </label>
          </div>
          <Label htmlFor={editorId}>{t('rules.rule', { n: slot })}</Label>
          <RuleEditor id={editorId} value={text} onChange={setText} />
          <DialogFooter>
            <Button type="submit" disabled={stage.isPending}>
              {t('edit.stage')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

`tasmota_manager/packages/web/src/features/devices/BatchTimerDialog.tsx`:
```tsx
import { DEFAULT_TIMER, type Device, type Timer, TimerSchema } from '@tm/shared';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useStage } from '@/features/changes/useStage';
import { TimerForm } from '@/features/timers/TimerForm';
import { useT } from '@/lib/i18n';
import { selectClass } from '@/lib/styles';

interface Props {
  devices: Device[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const INITIAL: Timer = { ...DEFAULT_TIMER, Enable: 1, Days: '1111111', Repeat: 1, Action: 1 };

export function BatchTimerDialog({ devices, open, onOpenChange }: Props) {
  const t = useT();
  const [slot, setSlot] = useState(1);
  const [timer, setTimer] = useState<Timer>(INITIAL);
  const [enableAll, setEnableAll] = useState(true);
  const stage = useStage(() => onOpenChange(false));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!TimerSchema.safeParse(timer).success) {
      toast.error(t('timers.invalid', { n: slot }));
      return;
    }
    const settings: Record<string, string> = { [`Timer${slot}`]: JSON.stringify(timer) };
    if (enableAll) settings.Timers = '1';
    stage.mutate({ deviceIds: devices.map((d) => d.id), settings, source: 'timer' });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('edit.timer')}</DialogTitle>
          <DialogDescription>{t('edit.forDevices', { count: devices.length })}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label htmlFor="batch-timer-slot">{t('edit.timer.slot')}</Label>
              <select id="batch-timer-slot" className={selectClass} value={slot} onChange={(e) => setSlot(Number(e.target.value))}>
                {Array.from({ length: 16 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={enableAll} onCheckedChange={(v) => setEnableAll(Boolean(v))} aria-label={t('edit.timer.enableAll')} />
              {t('edit.timer.enableAll')}
            </label>
          </div>
          <TimerForm id="batch-timer" value={timer} onChange={setTimer} />
          <DialogFooter>
            <Button type="submit" disabled={stage.isPending}>
              {t('edit.stage')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

In `tasmota_manager/packages/web/src/features/devices/EditMenu.tsx`:
- Imports ergänzen:
```tsx
import { BatchRuleDialog } from './BatchRuleDialog';
import { BatchTimerDialog } from './BatchTimerDialog';
```
- `type DialogKind = 'settings' | 'commands' | null;` ersetzen durch `type DialogKind = 'settings' | 'commands' | 'rule' | 'timer' | null;`
- Nach dem Menüeintrag „Befehle …“ einfügen:
```tsx
          <DropdownMenuItem onSelect={() => setDialog('rule')}>{t('edit.rule')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('timer')}>{t('edit.timer')}</DropdownMenuItem>
```
- Nach `<BatchCommandsDialog … />` einfügen:
```tsx
      <BatchRuleDialog devices={devices} open={dialog === 'rule'} onOpenChange={onOpenChange} />
      <BatchTimerDialog devices={devices} open={dialog === 'timer'} onOpenChange={onOpenChange} />
```

- [ ] **Step 5: Tests und Build ausführen**

```bash
pnpm --filter @tm/web test && pnpm --filter @tm/web build
```
Erwartet: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A .
git commit -m "feat(web): add rule editor, timer form and batch rule/timer dialogs"
```

---

### Task 17: Detailansicht mit Tabs (Info, Einstellungen, Rules, Timer, Konsole)

**Files:**
- Create: `tasmota_manager/packages/web/src/components/ui/tabs.tsx` (über die shadcn-CLI)
- Create: `tasmota_manager/packages/web/src/features/devices/detail/SettingsTab.tsx`
- Create: `tasmota_manager/packages/web/src/features/devices/detail/RulesTab.tsx`
- Create: `tasmota_manager/packages/web/src/features/devices/detail/TimersTab.tsx`
- Modify: `tasmota_manager/packages/web/src/features/devices/DeviceSheet.tsx`
- Test: `tasmota_manager/packages/web/src/features/devices/detail/DetailTabs.test.tsx`

**Interfaces:**
- Consumes:
  - `SettingsFields` und `collectSettings` (Task 14), `RuleEditor` (Task 16), `TimerForm` und `timerSummary` (Task 16), `useStage` (Task 12)
  - `readFromStatus`, `SETTINGS`, `MAX_RULE_LENGTH` und `TimerSchema` aus `@tm/shared`
  - `api.rules` und `api.timers`
- Produces:
  - `SettingsTab({ device, status })`, `RulesTab({ deviceId })`, `TimersTab({ deviceId })`
  - `DeviceSheet` mit den Tabs Info · Einstellungen · Rules · Timer · Konsole. Info enthält die bisherigen Inhalte außer der Konsole.

- [ ] **Step 1: shadcn-Tabs hinzufügen**

```bash
cd packages/web
npx -y shadcn@latest add -y tabs
rm -f package-lock.json
cd ../..
pnpm install
ls packages/web/src/components/ui/tabs.tsx
```
Erwartet: Die Datei existiert und exportiert `Tabs`, `TabsList`, `TabsTrigger` und `TabsContent`.

- [ ] **Step 2: Failing Test schreiben**

`tasmota_manager/packages/web/src/features/devices/detail/DetailTabs.test.tsx`:
```tsx
import { DEFAULT_TIMER } from '@tm/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { makeDevice } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { DeviceSheet } from '../DeviceSheet';

vi.mock('@/lib/api', () => ({
  api: {
    devices: vi.fn(),
    device: vi.fn(),
    updateDevice: vi.fn(),
    removeDevice: vi.fn(),
    command: vi.fn(),
    stage: vi.fn(),
    rules: vi.fn(),
    timers: vi.fn(),
  },
  ApiError: class extends Error {},
}));

const device = makeDevice({ id: 'A', name: 'Keller' });

describe('Detail-Tabs', () => {
  beforeEach(() => {
    vi.mocked(api.devices).mockResolvedValue([device]);
    vi.mocked(api.device).mockResolvedValue({ ...device, status: { Status: { PowerOnState: 3 } } });
    vi.mocked(api.stage).mockResolvedValue({ staged: 1, skipped: 0 });
    vi.mocked(api.rules).mockResolvedValue([
      { index: 1, enabled: false, text: 'ON x DO y ENDON', length: 15, free: 496 },
      { index: 2, enabled: false, text: '', length: 0, free: 511 },
      { index: 3, enabled: false, text: '', length: 0, free: 511 },
    ]);
    vi.mocked(api.timers).mockResolvedValue({ enabled: true, timers: Array.from({ length: 16 }, () => DEFAULT_TIMER) });
  });

  const open = async (tab: string) => {
    const user = userEvent.setup();
    renderWithProviders(<DeviceSheet deviceId="A" onClose={vi.fn()} onSwitch={vi.fn()} />);
    await user.click(await screen.findByRole('tab', { name: tab }));
    return user;
  };

  it('merkt Einstellungen eines Geräts vor und zeigt den aktuellen Wert', async () => {
    const user = await open('Einstellungen');
    const select = await screen.findByLabelText('Zustand nach Stromausfall');
    expect(select).toHaveDisplayValue('unverändert (3)');
    await user.selectOptions(select, '1');
    await user.click(screen.getByRole('button', { name: 'Vormerken' }));
    await waitFor(() =>
      expect(api.stage).toHaveBeenCalledWith({ deviceIds: ['A'], settings: { PowerOnState: '1' }, source: 'detail' }),
    );
  });

  it('bearbeitet Rules und merkt nur Geänderte vor', async () => {
    const user = await open('Rules');
    await user.click(await screen.findByRole('checkbox', { name: 'Rule 1 Aktiv' }));
    await user.click(screen.getAllByRole('button', { name: 'Vormerken' })[0] as HTMLElement);
    await waitFor(() =>
      expect(api.stage).toHaveBeenCalledWith({ deviceIds: ['A'], settings: { Rule1Enabled: '1' }, source: 'rule' }),
    );
  });

  it('bearbeitet Timer und merkt nur Geänderte vor', async () => {
    const user = await open('Timer');
    await user.click(await screen.findByRole('button', { name: /Timer 2/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Aktiv' }));
    await user.click(screen.getByRole('button', { name: 'Vormerken' }));
    await waitFor(() => expect(api.stage).toHaveBeenCalled());
    const request = vi.mocked(api.stage).mock.calls.at(-1)?.[0];
    expect(Object.keys(request?.settings ?? {})).toEqual(['Timer2']);
    expect(JSON.parse(request?.settings?.Timer2 ?? '')).toMatchObject({ Enable: 1 });
  });

  it('zeigt Lesefehler von Rules an', async () => {
    vi.mocked(api.rules).mockRejectedValue(new Error('offline'));
    await open('Rules');
    expect(await screen.findByText('Rules konnten nicht gelesen werden: offline')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Test ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/web test -- DetailTabs
```
Erwartet: FAIL (keine Tabs).

- [ ] **Step 4: Tabs implementieren**

`tasmota_manager/packages/web/src/features/devices/detail/SettingsTab.tsx`:
```tsx
import { type Device, SETTINGS, readFromStatus } from '@tm/shared';
import { type FormEvent, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { type FieldValues, SettingsFields, collectSettings } from '@/features/changes/SettingsFields';
import { useStage } from '@/features/changes/useStage';
import { useT } from '@/lib/i18n';

const DEFS = SETTINGS.filter((d) => d.group !== 'rules' && d.group !== 'timers');

export function SettingsTab({ device, status }: { device: Device; status: unknown }) {
  const t = useT();
  const current = useMemo(() => Object.fromEntries(DEFS.map((d) => [d.key, readFromStatus(d.key, status)])), [status]);
  const [values, setValues] = useState<FieldValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const stage = useStage(() => setValues({}));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const result = collectSettings(DEFS, values);
    setErrors(result.errors);
    if (Object.keys(result.errors).length > 0) return;
    if (Object.keys(result.settings).length === 0) {
      toast.error(t('edit.nothing'));
      return;
    }
    stage.mutate({ deviceIds: [device.id], settings: result.settings, source: 'detail' });
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-xs text-muted-foreground">{t('detail.pendingHint')}</p>
      <SettingsFields
        idPrefix={`detail-${device.id}`}
        defs={DEFS}
        values={values}
        errors={errors}
        current={current}
        onChange={(key, value) => setValues((v) => ({ ...v, [key]: value }))}
      />
      <Button type="submit" disabled={stage.isPending}>
        {t('edit.stage')}
      </Button>
    </form>
  );
}
```

`tasmota_manager/packages/web/src/features/devices/detail/RulesTab.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query';
import { MAX_RULE_LENGTH, type RuleState } from '@tm/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useStage } from '@/features/changes/useStage';
import { RuleEditor } from '@/features/rules/RuleEditor';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

export function RulesTab({ deviceId }: { deviceId: string }) {
  const t = useT();
  const { data, error } = useQuery({ queryKey: ['rules', deviceId], queryFn: () => api.rules(deviceId) });
  if (error) return <p className="text-sm text-destructive">{t('rules.loadError', { message: error.message })}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">…</p>;
  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">{t('detail.pendingHint')}</p>
      {data.map((rule) => (
        <RuleSlot key={rule.index} deviceId={deviceId} rule={rule} />
      ))}
    </div>
  );
}

function RuleSlot({ deviceId, rule }: { deviceId: string; rule: RuleState }) {
  const t = useT();
  const [text, setText] = useState(rule.text);
  const [enabled, setEnabled] = useState(rule.enabled);
  const stage = useStage();
  const max = Math.min(rule.length + rule.free, MAX_RULE_LENGTH);
  const changed = text !== rule.text || enabled !== rule.enabled;
  const title = t('rules.rule', { n: rule.index });
  const editorId = `detail-rule-${rule.index}`;
  const submit = () => {
    const settings: Record<string, string> = {};
    if (text !== rule.text) settings[`Rule${rule.index}`] = text;
    if (enabled !== rule.enabled) settings[`Rule${rule.index}Enabled`] = enabled ? '1' : '0';
    stage.mutate({ deviceIds: [deviceId], settings, source: 'rule' });
  };
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-3">
        <label htmlFor={editorId} className="font-medium">
          {title}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(Boolean(v))} aria-label={`${title} ${t('rules.enabled')}`} />
          {t('rules.enabled')}
        </label>
        <Button size="sm" className="ml-auto" disabled={!changed || text.length > max || stage.isPending} onClick={submit}>
          {t('edit.stage')}
        </Button>
      </div>
      <RuleEditor id={editorId} value={text} onChange={setText} max={max} />
    </section>
  );
}
```

`tasmota_manager/packages/web/src/features/devices/detail/TimersTab.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query';
import { type Timer, TimerSchema, type TimersState } from '@tm/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useStage } from '@/features/changes/useStage';
import { TimerForm, timerSummary } from '@/features/timers/TimerForm';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

export function TimersTab({ deviceId }: { deviceId: string }) {
  const t = useT();
  const { data, error } = useQuery({ queryKey: ['timers', deviceId], queryFn: () => api.timers(deviceId) });
  if (error) return <p className="text-sm text-destructive">{t('timers.loadError', { message: error.message })}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">…</p>;
  return <TimersEditor deviceId={deviceId} initial={data} />;
}

function TimersEditor({ deviceId, initial }: { deviceId: string; initial: TimersState }) {
  const t = useT();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [timers, setTimers] = useState<Timer[]>(initial.timers);
  const [open, setOpen] = useState<number | null>(null);
  const stage = useStage();
  const submit = () => {
    const invalid = timers.findIndex((timer) => !TimerSchema.safeParse(timer).success);
    if (invalid >= 0) {
      toast.error(t('timers.invalid', { n: invalid + 1 }));
      return;
    }
    const settings: Record<string, string> = {};
    if (enabled !== initial.enabled) settings.Timers = enabled ? '1' : '0';
    timers.forEach((timer, i) => {
      if (JSON.stringify(timer) !== JSON.stringify(initial.timers[i])) settings[`Timer${i + 1}`] = JSON.stringify(timer);
    });
    if (Object.keys(settings).length === 0) {
      toast.error(t('edit.nothing'));
      return;
    }
    stage.mutate({ deviceIds: [deviceId], settings, source: 'timer' });
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('detail.pendingHint')}</p>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(Boolean(v))} aria-label={t('timers.enabled')} />
        {t('timers.enabled')}
      </label>
      <ul className="divide-y rounded-md border">
        {timers.map((timer, i) => (
          <li key={`timer-${i + 1}`} className="p-2">
            <button type="button" className="flex w-full items-center gap-2 text-left text-sm" onClick={() => setOpen(open === i ? null : i)}>
              <span className="font-medium">{t('timers.timer', { n: i + 1 })}</span>
              <span className="text-muted-foreground">{timerSummary(timer, t)}</span>
            </button>
            {open === i && (
              <div className="pt-3">
                <TimerForm
                  id={`detail-timer-${i + 1}`}
                  value={timer}
                  onChange={(next) => setTimers((list) => list.map((x, j) => (j === i ? next : x)))}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
      <Button onClick={submit} disabled={stage.isPending}>
        {t('edit.stage')}
      </Button>
    </div>
  );
}
```

`tasmota_manager/packages/web/src/features/devices/DeviceSheet.tsx` umbauen:

1. Imports ergänzen:
```tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RulesTab } from './detail/RulesTab';
import { SettingsTab } from './detail/SettingsTab';
import { TimersTab } from './detail/TimersTab';
```

2. In `DeviceDetail` das JSX nach `</SheetHeader>` bis vor das schließende `</div>` der Komponente so ordnen: Die bestehenden Abschnitte Informationen, Aktionen, `DeviceSettingsForm` (Tags und Passwort) und der Entfernen-Knopf wandern in den Tab „Info“, die Konsole in den Tab „Konsole“:
```tsx
      <Tabs defaultValue="info" className="space-y-4">
        <TabsList className="flex-wrap">
          <TabsTrigger value="info">{t('detail.tab.info')}</TabsTrigger>
          <TabsTrigger value="settings">{t('detail.tab.settings')}</TabsTrigger>
          <TabsTrigger value="rules">{t('detail.tab.rules')}</TabsTrigger>
          <TabsTrigger value="timers">{t('detail.tab.timers')}</TabsTrigger>
          <TabsTrigger value="console">{t('detail.tab.console')}</TabsTrigger>
        </TabsList>
        <TabsContent value="info" className="space-y-6">
          {/* bisherige Abschnitte: Informationen, Aktionen, DeviceSettingsForm, Entfernen-Knopf (unverändert) */}
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab device={device} status={detail?.status ?? null} />
        </TabsContent>
        <TabsContent value="rules">
          <RulesTab deviceId={device.id} />
        </TabsContent>
        <TabsContent value="timers">
          <TimersTab deviceId={device.id} />
        </TabsContent>
        <TabsContent value="console">
          <Console key={device.id} deviceId={device.id} />
        </TabsContent>
      </Tabs>
```
Den Platzhalter-Kommentar ersetzt du durch die vier bestehenden JSX-Blöcke in ihrer bisherigen Reihenfolge: die `<section>` mit `detail.info`, die `<section>` mit `detail.actions`, `<DeviceSettingsForm … />` und den `<Button variant="destructive">`. Die alte `<section>` mit `console.title` entfällt, weil die Konsole jetzt im eigenen Tab liegt.

Radix-`TabsContent` hängt inaktive Tabs aus dem DOM aus. Rules und Timer werden deshalb erst beim Öffnen des Tabs vom Gerät gelesen.

- [ ] **Step 5: Tests und Build ausführen**

```bash
pnpm --filter @tm/web test && pnpm --filter @tm/web build
```
Erwartet: PASS. Auch `DeviceSheet.test.tsx` aus Plan 1 bleibt grün: Info ist der Standard-Tab mit Gerätedaten, Tags, Passwort und „Schalten“.

- [ ] **Step 6: Commit**

```bash
git add -A .
git commit -m "feat(web): add device detail tabs for settings, rules, timers and console"
```

---

### Task 18: Dokumentation, Version und Gesamtprüfung

**Files:**
- Modify: `tasmota_manager/DOCS.md`
- Modify: `tasmota_manager/packages/server/build.mjs` (nur falls in Task 11 nötig geworden)
- Modify: `docs/superpowers/plans/2026-09-29-plan-1-followups.md` (erledigte Punkte markieren)

**Interfaces:**
- Consumes: alles aus Task 1–17
- Produces: eine dokumentierte App in Version 0.2.0 und ein gebautes Image

- [ ] **Step 1: DOCS.md ergänzen**

In `tasmota_manager/DOCS.md` vor dem Abschnitt `## Sicherheit` einfügen:
```markdown
## Änderungen vormerken und im Batch schreiben

Alle Änderungen an Geräten werden zuerst **vorgemerkt** und erst unter **Ausstehend → Batch starten** geschrieben:

- **Einstellungen:** Wähle Geräte in der Tabelle aus und öffne **Bearbeiten → Einstellungen …**. Nur ausgefüllte Felder werden vorgemerkt.
- **Befehle:** Unter **Bearbeiten → Befehle …** gibst du freie Tasmota-Befehle ein, mit Platzhaltern wie `{{name}}` oder `{{mac6}}`.
- **Rules und Timer:** Du setzt sie pro Gerät in der Detailansicht oder für mehrere Geräte über **Bearbeiten**.
- **Namensvorschläge:** Heißt ein Gerät nur „Tasmota“, schlägt die App anhand seiner Sensoren und seines HA-Bereichs einen Namen vor. Ein Klick auf das ⚠-Label merkt ihn vor.

Beim Batch-Lauf gilt:

- Einstellungen, die einen Neustart auslösen (MQTT), schreibt die App pro Gerät gebündelt und zuletzt.
- Danach wartet sie höchstens 90 Sekunden, bis das Gerät neu gestartet ist.
- Jeder Wert wird zurückgelesen und geprüft.
- Fehlgeschlagene Änderungen bleiben mit ihrer Fehlermeldung stehen und lassen sich erneut starten.

## Verknüpfung mit Home Assistant

Die App liest über die Home-Assistant-API, welche Entitäten und Automationen zu einem Tasmota-Gerät gehören, und verlinkt sie in der Geräteübersicht. Den Bereich des Geräts in Home Assistant nutzt sie außerdem für Namensvorschläge.
```

- [ ] **Step 2: Offene Nacharbeiten aktualisieren**

In `docs/superpowers/plans/2026-09-29-plan-1-followups.md` ans Ende anfügen:
```markdown

## Durch Plan 2 erledigt

- Batch-Bearbeitung mehrerer Geräte (Änderungspuffer, Job-Engine)
- Erklärende Fehlermeldung bei zu großen Scan-Bereichen
- Geräte mit `SetOption4 1` werden erkannt und per HTTP angesprochen
```

- [ ] **Step 3: Gesamtprüfung**

```bash
pnpm typecheck && pnpm test && pnpm build
```
Erwartet: alles PASS.

- [ ] **Step 4: Image bauen und prüfen**

Im Repository-Wurzelverzeichnis:
```bash
docker build -t tasmota-manager:dev tasmota_manager
docker run --rm -d --name tm-plan2 -p 8099:8099 -e TM_DATA_DIR=/tmp/tm tasmota-manager:dev
sleep 3
curl -s localhost:8099/api/status
curl -s localhost:8099/api/changes
curl -s localhost:8099/api/jobs/current
docker stop tm-plan2
```
Erwartet: `{"mqtt":"disabled",…}`, `[]` und `{"job":null}`. Scheitert der Start an einem fehlenden Modul (z. B. `bufferutil`), trage es in `build.mjs` unter `external` ein. Nur wenn es zur Laufzeit wirklich benötigt wird, kommt es zusätzlich ins Dockerfile.

- [ ] **Step 5: Commit**

```bash
git add -A .
git commit -m "docs: describe staging, batch runs and HA links; release 0.2.0"
```

- [ ] **Step 6: Manuell in Home Assistant prüfen**

Nach dem Merge und Push aktualisiert der Supervisor die App auf Version 0.2.0. Prüfe danach:

- **HA-Links:** Die Spalten Entitäten und Automationen zeigen Links, und ein Klick öffnet die HA-Seite im Hauptfenster.
- **Namensvorschläge:** Ein Gerät namens „Tasmota“ mit Sensor zeigt einen Vorschlag. Der Klick merkt ihn vor, und er erscheint unter „Ausstehend“.
- **Batch-Lauf:** Setze bei zwei Testgeräten `LedState` und starte den Batch. Beide Geräte sind erfolgreich, und der Puffer ist leer.
- **MQTT-Änderung:** Eine Änderung der MQTT-Einstellung (z. B. `MqttUser` auf einen bekannten Wert) führt zu genau einem Neustart pro Gerät.
