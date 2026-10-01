# Gerätespezifische Einstellungen und Vorschläge aus HA – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Einstellungen für Energiemessung, Licht, Relais und Klima, die im Batch nur auf passende Geräte geschrieben werden; dazu Vorschläge aus Home Assistant (Zeitzone, NTP, MQTT, Einheit, Gerätename) und eine automatisch erzeugte Regel für sofortige Sensor-Updates.

**Architecture:** `@tm/shared` erweitert den Einstellungskatalog um `appliesTo`, `perDevice`, `hint` und neue Wertearten. Der Server leitet pro Gerät Fähigkeiten ab (`capabilities.ts`), überspringt beim Vormerken unpassende Geräte, rechnet HA-Zeitzonen in Tasmota-Regeln um (`timezone.ts`), erzeugt Sofort-Regeln (`fastRule.ts`) und liefert HA-Vorschläge über `/api/status`. Die Oberfläche filtert Formularfelder nach Fähigkeiten, zeigt Hinweise und Vorschläge und bietet die Sofort-Regel an.

**Tech Stack:** TypeScript 5.9 strict, ESM, zod 4, Fastify 5, better-sqlite3 + Drizzle, Vitest, React 19, TanStack Query, Tailwind 4, shadcn/ui (radix).

**Spec:** `docs/superpowers/specs/2026-10-01-device-specific-settings-design.md`

## Global Constraints

- Arbeitsverzeichnis für alle Befehle: `tasmota_manager/` (pnpm-Workspace). Tests: `pnpm test`, Typecheck: `pnpm typecheck`; einzelne Datei: `pnpm --filter @tm/<paket> exec vitest run <pfad>`.
- Jede Geräteänderung geht über den Änderungspuffer (`PendingStore`) und wird erst im Batch-Lauf geschrieben. Lesen (Abfragen ohne Argument) ist jederzeit erlaubt.
- Oberflächentexte nur über Wörterbuchschlüssel. Jede neue Taste in alle sechs Wörterbücher: `web/src/lib/messages.ts` (`de`, `en`) und `web/src/lib/locales/{fr,es,it,nl}.ts`. Der Test `web/src/lib/errors.test.ts` prüft Vollständigkeit und gleiche Platzhalter. Für fr/es/it/nl die Begriffe der vorhandenen Einträge derselben Datei übernehmen.
- Validierungstexte im Katalog als Schlüssel über `issue('<name>', ...args)`; Übersetzung unter `validation.<name>` mit `{a}`, `{b}` für Parameter.
- Server-Fehlertexte auf Englisch, mit Code (`validation`, `not_found`, …).
- Commit-Nachrichten auf Deutsch, mit Schlusszeile `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Das Fake-Gerät (`server/test/fakes/fakeTasmota.ts`) bildet echte Firmware nach, nicht die Erwartung der App.
- Nie die Zugangsdaten des MQTT-Dienstes (Supervisor) in API-Antworten oder Vorschlägen.

## Review Focus

- Gerät ohne gespeicherten Status oder Sensoren (`capabilities` leer) in einer Batch-Auswahl: Gerätespezifische Einstellungen werden dort nicht vorgemerkt, und das Gerät zählt in `incompatible` – kein stilles Verschwinden, kein Vormerken. Test in Task 4.
- Gemischte Auswahl (Steckdose + Lampe) mit `PowerDelta` und `Fade` zugleich: jede Einstellung nur beim passenden Gerät, beide Geräte zählen in `incompatible`. Test in Task 4.
- Zeitzone mit mehr als zwei Wechseln im Jahr oder ohne Sommerzeit: kein `99`, sondern fester Versatz bzw. kein Vorschlag; Südhalbkugel mit Hemisphäre 1. Test in Task 5.
- Sofort-Regel, wenn alle drei Rule-Slots belegt sind oder das Gerät nicht erreichbar ist: kein Überschreiben, Grund pro Gerät, kein Abbruch für die anderen Geräte. Test in Task 6.
- `/api/status` ohne HA-Zugriff und mit MQTT aus dem Supervisor: alle HA-Vorschläge `null`, aber nie das Passwort des MQTT-Dienstes in der Antwort. Test in Task 7.

---

### Task 1: Katalog und gemeinsame Typen

**Files:**
- Modify: `packages/shared/src/catalog.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/catalog.test.ts`

**Interfaces:**
- Produces:
  - `type Capability = 'energy' | 'light' | 'relay' | 'multiRelay' | 'climate'` und `CAPABILITIES: readonly Capability[]` (in `catalog.ts`, über `index.ts` exportiert)
  - `SettingKind` zusätzlich `'dimmerRange' | 'timeRule' | 'decimal'`
  - `SettingGroup` zusätzlich `'energy' | 'light' | 'relay' | 'climate'`
  - `SettingDef` zusätzlich `appliesTo: readonly Capability[]` (leer = alle), `perDevice: boolean`, `hint: boolean`
  - `settingApplies(def: SettingDef, capabilities: readonly Capability[]): boolean`
  - `DeviceSchema` zusätzlich `capabilities: z.array(CapabilitySchema)`; `HaLinkSchema` zusätzlich `nameByUser: z.string().nullable()`
  - `StageResult` zusätzlich `incompatible: number`
  - `HaSuggestions` und `StatusResponse.haSuggestions: HaSuggestions`
  - `FastRulePreview`, `FastRuleRequestSchema`

- [ ] **Step 1: Failing tests schreiben**

In `packages/shared/src/catalog.test.ts` am Ende anfügen (Importe `settingApplies`, `settingDef`, `commandFor` ergänzen, falls nicht vorhanden):

```ts
describe('gerätespezifische Einstellungen', () => {
  it('ordnet Einstellungen Fähigkeiten zu', () => {
    const powerDelta = settingDef('PowerDelta');
    expect(powerDelta?.appliesTo).toEqual(['energy']);
    expect(settingApplies(powerDelta!, ['energy', 'relay'])).toBe(true);
    expect(settingApplies(powerDelta!, ['light'])).toBe(false);
    expect(settingApplies(powerDelta!, [])).toBe(false);
    // Ohne appliesTo gilt eine Einstellung für jedes Gerät, auch ohne bekannte Fähigkeiten.
    expect(settingApplies(settingDef('LedState')!, [])).toBe(true);
    expect(settingDef('Interlock')?.appliesTo).toEqual(['multiRelay']);
    expect(settingDef('TempOffset')).toMatchObject({ perDevice: true, batch: false });
  });

  it('schreibt PowerDelta als PowerDelta1', () => {
    expect(commandFor(settingDef('PowerDelta')!, '110')).toBe('PowerDelta1 110');
  });

  it('prüft DimmerRange und Zeitregeln', () => {
    const range = settingDef('DimmerRange')!.schema;
    expect(range.safeParse('10,100').success).toBe(true);
    expect(range.safeParse('100,10').error?.issues[0]?.message).toBe('invalid.dimmerRange');
    expect(range.safeParse('10').success).toBe(false);
    const rule = settingDef('TimeStd')!.schema;
    expect(rule.safeParse('0,0,10,1,3,60').success).toBe(true);
    expect(rule.safeParse('1,1,4,1,3,600').success).toBe(true);
    expect(rule.safeParse('0,0,13,1,3,60').error?.issues[0]?.message).toBe('invalid.timeRule');
  });

  it('prüft Kalibrierwerte als Dezimalzahl', () => {
    const offset = settingDef('TempOffset')!.schema;
    expect(offset.safeParse('-1.5').success).toBe(true);
    expect(offset.safeParse('13').error?.issues[0]?.message).toBe('invalid.maxAbs|12.6');
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `pnpm --filter @tm/shared exec vitest run src/catalog.test.ts`
Expected: FAIL (`settingApplies` nicht exportiert, `settingDef('PowerDelta')` undefined)

- [ ] **Step 3: Katalog erweitern**

In `packages/shared/src/catalog.ts`:

```ts
export type SettingKind = 'text' | 'int' | 'bool' | 'coord' | 'timezone' | 'rule' | 'timer' | 'dimmerRange' | 'timeRule' | 'decimal';
export type SettingGroup =
  | 'names'
  | 'power'
  | 'led'
  | 'system'
  | 'logging'
  | 'location'
  | 'time'
  | 'telemetry'
  | 'energy'
  | 'light'
  | 'relay'
  | 'climate'
  | 'mqtt'
  | 'rules'
  | 'timers';

/** Fähigkeiten eines Geräts, abgeleitet aus Status 0 und Status 10 (Server: capabilities.ts). */
export const CAPABILITIES = ['energy', 'light', 'relay', 'multiRelay', 'climate'] as const;
export type Capability = (typeof CAPABILITIES)[number];
```

In `SettingDef` nach `batch` ergänzen:

```ts
  /** Nur für Geräte mit einer dieser Fähigkeiten; leer = für alle Geräte. */
  appliesTo: readonly Capability[];
  /** Gerätespezifischer Wert (Kalibrierung): nie für mehrere Geräte zugleich vormerken. */
  perDevice: boolean;
  /** Erklärender Text unter dem Feld (Wörterbuch `hint.<key>`). */
  hint: boolean;
```

Neue Schema-Helfer nach `coord`:

```ts
const decimal = (limit: number) =>
  z
    .string()
    .trim()
    .regex(/^-?\d{1,2}(\.\d)?$/, { message: issue('decimal') })
    .refine((v) => Math.abs(Number(v)) <= limit, { message: issue('maxAbs', limit) });
const dimmerRange = z
  .string()
  .trim()
  .regex(/^\d{1,3},\d{1,3}$/, { message: issue('dimmerRange') })
  .refine(
    (v) => {
      const [min, max] = v.split(',').map(Number) as [number, number];
      return min < max && max <= 100;
    },
    { message: issue('dimmerRange') },
  );
// Tasmota: Hemisphäre (0 Nord, 1 Süd), Woche (0 = letzte, 1–4), Monat, Tag (1 = Sonntag), Stunde, Versatz in Minuten.
const timeRule = z
  .string()
  .trim()
  .regex(/^[01],[0-4],(1[0-2]|[1-9]),[1-7],(2[0-3]|1?\d),-?\d{1,4}$/, { message: issue('timeRule') });
```

`setting()` mit Standardwerten für die neuen Felder:

```ts
): SettingDef => ({
  key, group, kind, schema, order,
  restarts: false, writeOnly: false, batch: true, appliesTo: [], perDevice: false, hint: false,
  ...extra,
});
```

In `SETTINGS` nach `TelePeriod` (Order 80) einfügen und `TelePeriod` selbst `{ hint: true }` geben:

```ts
  setting('TelePeriod', 'telemetry', 'int', int(10, 3600), 80, { hint: true }),
  setting('TimeStd', 'time', 'timeRule', timeRule, 72),
  setting('TimeDst', 'time', 'timeRule', timeRule, 73),
  setting('PowerDelta', 'energy', 'int', int(0, 32000), 82, { appliesTo: ['energy'], hint: true, command: 'PowerDelta1' }),
  setting('EnergyRes', 'energy', 'int', int(0, 5), 83, { appliesTo: ['energy'] }),
  setting('WattRes', 'energy', 'int', int(0, 3), 84, { appliesTo: ['energy'] }),
  setting('Fade', 'light', 'bool', bool, 85, { appliesTo: ['light'] }),
  setting('Speed', 'light', 'int', int(1, 40), 86, { appliesTo: ['light'] }),
  setting('DimmerRange', 'light', 'dimmerRange', dimmerRange, 87, { appliesTo: ['light'], hint: true }),
  setting('SetOption20', 'light', 'bool', bool, 88, { appliesTo: ['light'], hint: true }),
  setting('SetOption0', 'relay', 'bool', bool, 89, { appliesTo: ['relay'], hint: true }),
  setting('Interlock', 'relay', 'bool', bool, 90, { appliesTo: ['multiRelay'], hint: true }),
  setting('TempRes', 'climate', 'int', int(0, 3), 91, { appliesTo: ['climate'] }),
  setting('HumRes', 'climate', 'int', int(0, 3), 92, { appliesTo: ['climate'] }),
  setting('SetOption8', 'climate', 'bool', bool, 93, { appliesTo: ['climate'], hint: true }),
  setting('TempOffset', 'climate', 'decimal', decimal(12.6), 94, { appliesTo: ['climate'], batch: false, perDevice: true }),
  setting('HumOffset', 'climate', 'decimal', decimal(10), 95, { appliesTo: ['climate'], batch: false, perDevice: true }),
```

Die MQTT-Einstellungen haben bisher Order 90–93; auf 96–99 verschieben, damit sie weiterhin nach allem anderen kommen (Neustart-Bündel zuletzt):

```ts
  setting('MqttHost', 'mqtt', 'text', noSemicolon(text(64)), 96, { restarts: true }),
  setting('MqttPort', 'mqtt', 'int', int(1, 65535), 97, { restarts: true }),
  setting('MqttUser', 'mqtt', 'text', noSemicolon(text(32)), 98, { restarts: true }),
  setting('MqttPassword', 'mqtt', 'text', noSemicolon(text(32)), 99, { restarts: true, writeOnly: true }),
```

Nach `settingDef` anfügen:

```ts
export function settingApplies(def: SettingDef, capabilities: readonly Capability[]): boolean {
  return def.appliesTo.length === 0 || def.appliesTo.some((c) => capabilities.includes(c));
}
```

- [ ] **Step 4: Gemeinsame Typen in `index.ts`**

Nach `ChannelSchema`:

```ts
export const CapabilitySchema = z.enum(CAPABILITIES);
```

`CAPABILITIES` dafür aus `./catalog` importieren (`import { CAPABILITIES, type Timer } from './catalog';`).

In `HaLinkSchema` nach `areaName`:

```ts
  /** In HA vergebener Gerätename (name_by_user); null, wenn nicht umbenannt. */
  nameByUser: z.string().nullable(),
```

In `DeviceSchema` nach `power`:

```ts
  capabilities: z.array(CapabilitySchema),
```

`StageResult`:

```ts
export interface StageResult {
  staged: number;
  skipped: number;
  /** Geräte, bei denen mindestens eine Einstellung nicht zum Gerätetyp passte und übersprungen wurde. */
  incompatible: number;
}
```

Nach `HaLocation`:

```ts
/** Vorschläge aus Home Assistant für das Einstellungsformular; null, wenn die Quelle fehlt. */
export interface HaSuggestions {
  /** HA-Zeitzone und daraus berechnete Tasmota-Werte. timeStd/timeDst null bei Zonen ohne Sommerzeit. */
  timezone: { zone: string; timezone: string; timeStd: string | null; timeDst: string | null } | null;
  ntpServer: string;
  /** Broker auf dem HA-Host, mit dessen LAN-Adresse. */
  mqtt: { host: string; port: number } | null;
  /** Häufigster MqttUser der eigenen Geräte (mindestens zwei). */
  mqttUser: string | null;
  /** true bei °F in HA, false bei °C, null ohne HA. */
  fahrenheit: boolean | null;
}
```

`StatusResponse` um `haSuggestions: HaSuggestions;` ergänzen.

Am Ende:

```ts
export const FastRuleRequestSchema = z.object({ deviceIds: z.array(z.string().min(1)).min(1).max(500) });

/** Vorschau einer Sofort-Regel pro Gerät (siehe Server fastRule.ts). */
export interface FastRulePreview {
  deviceId: string;
  deviceName: string;
  /** Regeltext oder null, wenn keine Regel möglich ist. */
  rule: string | null;
  /** Freier Rule-Slot (1–3) oder null. */
  slot: number | null;
  /** Sensorblöcke in der Regel bzw. weggelassen (Platz, ENERGY, Chip-Temperatur). */
  included: string[];
  omitted: string[];
  reason: 'ok' | 'noSensors' | 'noSlot' | 'unreachable';
}
```

- [ ] **Step 5: Tests laufen lassen**

Run: `pnpm --filter @tm/shared exec vitest run`
Expected: PASS. (Server und Web kompilieren erst nach Task 2/8 wieder vollständig; `pnpm --filter @tm/shared typecheck` muss grün sein.)

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): Fähigkeiten, gerätespezifische Einstellungen und Typen für HA-Vorschläge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Fähigkeiten pro Gerät

**Files:**
- Create: `packages/server/src/capabilities.ts`
- Create: `packages/server/src/capabilities.test.ts`
- Modify: `packages/server/src/naming.ts` (nutzt `capabilities.ts`)
- Modify: `packages/server/src/enrich.ts`, `packages/server/src/registry.ts` (`toDevice`), `packages/server/src/ha/client.ts` (`nameByUser`)
- Modify: `packages/web/src/test/fixtures.ts` (`capabilities: []`), Test-Fixtures mit `HaLink` (`nameByUser: null`)

**Interfaces:**
- Consumes: `Capability` aus Task 1.
- Produces: `capabilitiesOf(status0: unknown, sensors: unknown, module: string | null): Capability[]` – Reihenfolge wie `CAPABILITIES`. `Device.capabilities` wird im Enricher gesetzt; `toDevice` setzt `[]`.

- [ ] **Step 1: Failing test**

`packages/server/src/capabilities.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { capabilitiesOf } from './capabilities';

const status = (sts: Record<string, unknown>) => ({ StatusSTS: sts });
const sensors = (sns: Record<string, unknown>) => ({ StatusSNS: sns });

describe('capabilitiesOf', () => {
  it('erkennt Steckdose mit Energiemessung', () => {
    expect(capabilitiesOf(status({ POWER: 'ON' }), sensors({ ENERGY: { Power: 5 } }), null)).toEqual(['energy', 'relay']);
  });
  it('erkennt Licht über Dimmer, Farbe oder Modulnamen', () => {
    expect(capabilitiesOf(status({ POWER: 'ON', Dimmer: 40 }), sensors({}), null)).toEqual(['light', 'relay']);
    expect(capabilitiesOf(status({ POWER: 'ON' }), sensors({}), 'Sonoff B1 Bulb')).toEqual(['light', 'relay']);
  });
  it('erkennt Mehrfach-Relais', () => {
    expect(capabilitiesOf(status({ POWER1: 'ON', POWER2: 'OFF' }), sensors({}), null)).toEqual(['relay', 'multiRelay']);
  });
  it('erkennt Klima, aber nicht die Chip-Temperatur', () => {
    expect(capabilitiesOf(status({}), sensors({ AM2301: { Temperature: 21, Humidity: 40 } }), null)).toEqual(['climate']);
    expect(capabilitiesOf(status({ POWER: 'ON' }), sensors({ ESP32: { Temperature: 40 } }), null)).toEqual(['relay']);
  });
  it('liefert ohne Status nichts', () => {
    expect(capabilitiesOf(undefined, undefined, null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Fehlschlag bestätigen**

Run: `pnpm --filter @tm/server exec vitest run src/capabilities.test.ts`
Expected: FAIL (Modul fehlt)

- [ ] **Step 3: `capabilities.ts` anlegen und `naming.ts` umstellen**

`packages/server/src/capabilities.ts` – die Funktionen `relayCount`, `hasClimateSensor` und `isLight` werden aus `naming.ts` hierher verschoben (Code unverändert übernehmen):

```ts
import type { Capability } from '@tm/shared';
import { isObj } from './tasmota/parse';

const rec = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});

export function relayCount(status0: unknown): number {
  return Object.keys(rec(rec(status0).StatusSTS)).filter((k) => /^POWER\d*$/.test(k)).length;
}

export function hasClimateSensor(sns: Record<string, unknown>): boolean {
  return Object.entries(sns).some(([key, value]) => {
    // Interne Chip-Temperatur (ESP32 …) und ENERGY-Blöcke zählen nicht.
    if (/^ESP32/i.test(key) || key === 'ENERGY') return false;
    if (key === 'Temperature' || key === 'Humidity') return true;
    return isObj(value) && ('Temperature' in value || 'Humidity' in value);
  });
}

export function isLight(status0: unknown, module: string | null): boolean {
  const sts = rec(rec(status0).StatusSTS);
  return 'Dimmer' in sts || 'Color' in sts || 'CT' in sts || (module !== null && /dimmer|bulb|light|led|rgb/i.test(module));
}

/** Fähigkeiten eines Geräts aus gespeichertem Status 0 und Status 10. */
export function capabilitiesOf(status0: unknown, sensors: unknown, module: string | null): Capability[] {
  const sns = rec(rec(sensors).StatusSNS);
  const relays = relayCount(status0);
  const result: Capability[] = [];
  if ('ENERGY' in sns) result.push('energy');
  if (isLight(status0, module)) result.push('light');
  if (relays > 0) result.push('relay');
  if (relays > 1) result.push('multiRelay');
  if (hasClimateSensor(sns)) result.push('climate');
  return result;
}
```

In `naming.ts` die drei Funktionen löschen und `import { hasClimateSensor, isLight, relayCount } from './capabilities';` ergänzen. `relayCount` weiterhin aus `naming.ts` re-exportieren (`export { relayCount } from './capabilities';`), weil `naming.test.ts` es von dort importiert.

- [ ] **Step 4: Gerätemodell**

`registry.ts`, `toDevice`: nach `power` ergänzen `capabilities: [],`.

`enrich.ts`, im `return devices.map(...)`-Objekt:

```ts
        capabilities: capabilitiesOf(raw.get(d.id)?.statusJson, raw.get(d.id)?.sensorsJson, d.module),
```

mit `import { capabilitiesOf } from './capabilities';`.

`ha/client.ts`: `RegistryDevice` um `name_by_user?: string | null;` ergänzen; in `next.set(mac, { … })` nach `areaName` ergänzen: `nameByUser: device.name_by_user ?? null,`.

`packages/web/src/test/fixtures.ts`: `capabilities: [],` nach `power`. In allen Web-Tests, die ein `ha`-Objekt bauen (`grep -rn "areaName:" packages/web/src`), `nameByUser: null` ergänzen. Im Server `ha/client.test.ts` erwarten die `toEqual`-Vergleiche dann `nameByUser: null`; dort ergänzen.

Enricher-Test (`enrich.test.ts`) um eine Erwartung erweitern:

```ts
    expect(first?.capabilities).toEqual(['relay', 'climate']);
```

(im ersten Test, Gerät `AABBCC000001` mit `POWER` und `AM2301`).

- [ ] **Step 5: Alles prüfen**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages
git commit -m "feat(server): Gerätefähigkeiten ableiten und an Geräten ausliefern

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Neue Einstellungen lesen, vergleichen und im Fake-Gerät nachbilden

**Files:**
- Modify: `packages/server/src/changes/catalog.ts`
- Modify: `packages/server/test/fakes/fakeTasmota.ts`
- Test: `packages/server/src/changes/catalog.test.ts`, `packages/server/src/changes/runner.test.ts`

**Interfaces:**
- Consumes: neue `SettingKind`s aus Task 1.
- Produces: `extractValue`/`valuesEqual` verstehen `dimmerRange`, `timeRule`, `decimal`.

Antwortformate laut Tasmota-Doku (nicht an Hardware geprüft): `DimmerRange` → `{"DimmerRange":{"Min":10,"Max":100}}`; `TimeStd` → `{"TimeStd":{"Hemisphere":0,"Week":0,"Month":10,"Day":1,"Hour":3,"Offset":60}}` (TimeDst analog); `PowerDelta1` → `{"PowerDelta1":110}`; `TempOffset` → `{"TempOffset":-1.5}`.

- [ ] **Step 1: Failing tests**

In `packages/server/src/changes/catalog.test.ts`:

```ts
describe('neue Wertearten', () => {
  const def = (key: string) => settingDef(key)!;

  it('liest DimmerRange und Zeitregeln aus Objekt-Antworten', () => {
    expect(extractValue(def('DimmerRange'), { DimmerRange: { Min: 10, Max: 100 } })).toBe('10,100');
    expect(extractValue(def('TimeStd'), { TimeStd: { Hemisphere: 0, Week: 0, Month: 10, Day: 1, Hour: 3, Offset: 60 } })).toBe(
      '0,0,10,1,3,60',
    );
    expect(extractValue(def('PowerDelta'), { PowerDelta1: 110 })).toBe('110');
  });

  it('vergleicht die neuen Arten tolerant', () => {
    expect(valuesEqual(def('DimmerRange'), '10,100', '10, 100')).toBe(true);
    expect(valuesEqual(def('DimmerRange'), '10,100', '5,100')).toBe(false);
    expect(valuesEqual(def('TimeDst'), '0,0,3,1,2,120', '0,0,3,1,2,120')).toBe(true);
    expect(valuesEqual(def('TimeDst'), '0,0,3,1,2,120', '0,0,3,1,2,60')).toBe(false);
    expect(valuesEqual(def('TempOffset'), '-1.5', '-1.5')).toBe(true);
    expect(valuesEqual(def('TempOffset'), '1', '1.0')).toBe(true);
  });
});
```

In `runner.test.ts` (im ersten `describe` mit HTTP-Fake, analog zu vorhandenen Tests mit `setup()`):

```ts
  it('schreibt und prüft gerätespezifische Einstellungen', async () => {
    const c = await setup();
    c.store.stage({
      deviceIds: [MAC],
      settings: { PowerDelta: '110', DimmerRange: '10,90', TimeStd: '0,0,10,1,3,60', TempOffset: '-1.5' },
      source: 'form',
    });
    c.runner.start();
    await c.runner.waitIdle();
    expect(c.jobs.latest()?.items[0]?.status).toBe('success');
    expect(c.store.count()).toBe(0);
  });
```

Hinweis: `setup()` legt ein Gerät ohne Sensoren an. Der Store überspringt `PowerDelta`, `DimmerRange` und `TempOffset` erst ab Task 4; dieser Test läuft deshalb vor Task 4 direkt gegen den Store, ist aber nach Task 4 nur grün, wenn das Fake-Gerät passende Fähigkeiten meldet. Darum in diesem Test `setup({ fake: { sensors: { ENERGY: { Power: 5 }, AM2301: { Temperature: 21 } }, extraState: { Dimmer: 50 } } })` verwenden (Optionen existieren im Fake; falls `setup` keine Fake-Optionen weiterreicht, den Aufruf an die vorhandene Signatur anpassen).

- [ ] **Step 2: Fehlschlag bestätigen**

Run: `pnpm --filter @tm/server exec vitest run src/changes/catalog.test.ts src/changes/runner.test.ts`
Expected: FAIL (`extractValue` liefert null für Objekte; Fake kennt die Befehle nicht → `rejected`)

- [ ] **Step 3: `catalog.ts` erweitern**

In `extractValue` vor `if (isObj(raw)) return null;`:

```ts
  if (def.kind === 'dimmerRange') return isObj(raw) ? `${raw.Min},${raw.Max}` : null;
  if (def.kind === 'timeRule') {
    if (!isObj(raw)) return null;
    return [raw.Hemisphere, raw.Week, raw.Month, raw.Day, raw.Hour, raw.Offset].map((v) => String(v)).join(',');
  }
```

In `valuesEqual` im `switch` ergänzen:

```ts
    case 'dimmerRange':
    case 'timeRule': {
      const parts = (v: string) => v.split(',').map((p) => Number(p.trim()));
      const a = parts(expected);
      const b = parts(actual);
      return a.length === b.length && a.every((n, i) => Number.isFinite(n) && n === b[i]);
    }
    case 'decimal':
      return Math.abs(Number(expected) - Number(actual)) < 0.05;
```

- [ ] **Step 4: Fake-Gerät**

In `fakeTasmota.ts`, `this.values` ergänzen:

```ts
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
```

Zusätzliche Felder in der Klasse:

```ts
  private dimmerRange = { Min: 0, Max: 100 };
  private timeRules: Record<'TIMESTD' | 'TIMEDST', number[]> = { TIMESTD: [0, 0, 10, 1, 3, 60], TIMEDST: [0, 0, 3, 1, 2, 120] };
```

In `executeOne` vor der generischen `const key = …`-Suche:

```ts
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
```

Die Firmware meldet Zahlenwerte als Zahlen; die generische Antwort am Ende von `executeOne` gibt für `PowerDelta1`, `EnergyRes`, `WattRes`, `Speed`, `TempRes`, `HumRes`, `TempOffset`, `HumOffset` deshalb `Number(this.values[key])` zurück:

```ts
    const NUMERIC = new Set(['POWERDELTA1', 'ENERGYRES', 'WATTRES', 'SPEED', 'TEMPRES', 'HUMRES', 'TEMPOFFSET', 'HUMOFFSET']);
    const value = this.values[key];
    if (NUMERIC.has(upper)) return result({ [key]: Number(value) });
```

(`NUMERIC` als Modul-Konstante oben in der Datei anlegen, die beiden anderen Zeilen direkt vor dem bestehenden `return result({ [key]: … })`.)

- [ ] **Step 5: Tests**

Run: `pnpm --filter @tm/server exec vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server
git commit -m "feat(server): neue Einstellungen lesen und prüfen, Fake-Gerät erweitert

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Unpassende Geräte beim Vormerken überspringen

**Files:**
- Modify: `packages/server/src/changes/store.ts`
- Modify: `packages/server/src/api/changes.ts` (Vorschläge-Endpunkt summiert `incompatible`)
- Test: `packages/server/src/changes/store.test.ts`, `packages/server/src/api/changes.test.ts`

**Interfaces:**
- Consumes: `settingApplies`, `capabilitiesOf` (Task 1/2), `registry.getStatus(id)`, `registry.getSensors(id)`.
- Produces: `stage()` liefert `{ staged, skipped, incompatible }`; wirft `StageError` bei `perDevice` und mehr als einem Gerät.

- [ ] **Step 1: Failing tests**

In `store.test.ts` (der Test-Aufbau legt Geräte über `registry.upsert` an; Status und Sensoren über die Optionen `statusJson`/`sensorsJson`):

```ts
  it('merkt gerätespezifische Einstellungen nur bei passenden Geräten vor', () => {
    registry.upsert({ mac: 'AABBCC0000E1', name: 'Steckdose' }, { statusJson: { StatusSTS: { POWER: 'ON' } }, sensorsJson: { StatusSNS: { ENERGY: { Power: 5 } } } });
    registry.upsert({ mac: 'AABBCC0000L1', name: 'Lampe' }, { statusJson: { StatusSTS: { POWER: 'ON', Dimmer: 50 } }, sensorsJson: { StatusSNS: {} } });
    registry.upsert({ mac: 'AABBCC0000U1', name: 'Unbekannt' });
    const result = store.stage({
      deviceIds: ['AABBCC0000E1', 'AABBCC0000L1', 'AABBCC0000U1'],
      settings: { PowerDelta: '110', Fade: '1', LedState: '2' },
      source: 'form',
    });
    expect(result).toEqual({ staged: 5, skipped: 0, incompatible: 3 });
    expect(store.forDevice('AABBCC0000E1').map((r) => r.key).sort()).toEqual(['LedState', 'PowerDelta']);
    expect(store.forDevice('AABBCC0000L1').map((r) => r.key).sort()).toEqual(['Fade', 'LedState']);
    // Ohne bekannte Fähigkeiten nur die allgemeinen Einstellungen.
    expect(store.forDevice('AABBCC0000U1').map((r) => r.key)).toEqual(['LedState']);
  });

  it('lehnt gerätespezifische Kalibrierwerte für mehrere Geräte ab', () => {
    const climate = { statusJson: { StatusSTS: {} }, sensorsJson: { StatusSNS: { AM2301: { Temperature: 21 } } } };
    registry.upsert({ mac: 'AABBCC0000C1', name: 'Bad' }, climate);
    registry.upsert({ mac: 'AABBCC0000C2', name: 'Flur' }, climate);
    expect(() => store.stage({ deviceIds: ['AABBCC0000C1', 'AABBCC0000C2'], settings: { TempOffset: '-1' }, source: 'form' })).toThrow(
      /TempOffset/,
    );
    expect(store.stage({ deviceIds: ['AABBCC0000C1'], settings: { TempOffset: '-1' }, source: 'detail' })).toMatchObject({ staged: 1 });
  });
```

Bestehende Tests, die `toEqual({ staged, skipped })` erwarten, um `incompatible: 0` ergänzen (`grep -rn "skipped:" packages/server/src`).

- [ ] **Step 2: Fehlschlag bestätigen**

Run: `pnpm --filter @tm/server exec vitest run src/changes/store.test.ts`
Expected: FAIL

- [ ] **Step 3: `stage()` erweitern**

In `store.ts` (Importe: `settingApplies` aus `@tm/shared`, `capabilitiesOf` aus `../capabilities`):

Vor der Transaktion:

```ts
    for (const key of Object.keys(req.settings ?? {})) {
      if (settingDef(key)?.perDevice && req.deviceIds.length > 1) throw new StageError(`${key} can only be set per device`);
    }
    let incompatible = 0;
```

In der Geräteschleife nach `const status = …`:

```ts
        const capabilities = capabilitiesOf(status, this.registry.getSensors(deviceId), device.module);
        let deviceIncompatible = false;
```

In der Einstellungsschleife direkt nach der `Unknown setting`-Prüfung:

```ts
          if (!settingApplies(def, capabilities)) {
            deviceIncompatible = true;
            continue;
          }
```

Nach der Einstellungsschleife: `if (deviceIncompatible) incompatible++;`. Rückgabe: `return { staged, skipped, incompatible };`.

In `api/changes.ts`, Endpunkt `/api/changes/suggestions`: `const total: StageResult = { staged: 0, skipped: 0, incompatible: 0 };` und `total.incompatible += result.incompatible;`.

- [ ] **Step 4: API-Test**

In `api/changes.test.ts`:

```ts
  it('meldet übersprungene Geräte und lehnt Kalibrierwerte für mehrere Geräte ab', async () => {
    const { app } = await setupApp();
    await addFake(app);
    const res = await stage(app, { deviceIds: [MAC], settings: { PowerDelta: '110' }, source: 'form' });
    expect(res.json()).toEqual({ staged: 0, skipped: 0, incompatible: 1 });
  });
```

(Das Fake aus `setupApp()` hat keine Energiemessung.)

- [ ] **Step 5: Tests**

Run: `pnpm --filter @tm/server exec vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server
git commit -m "feat(server): unpassende Geräte beim Vormerken überspringen, Kalibrierwerte nur pro Gerät

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: HA-Zeitzone in Tasmota-Regeln umrechnen

**Files:**
- Create: `packages/server/src/timezone.ts`
- Create: `packages/server/src/timezone.test.ts`

**Interfaces:**
- Produces: `tasmotaTimezone(zone: string, year?: number): { timezone: string; timeStd: string | null; timeDst: string | null } | null`

Tasmota-Format `Hemisphäre,Woche,Monat,Tag,Stunde,Versatz`: Hemisphäre 0 = Nord, 1 = Süd; Woche 0 = letzte, 1–4 = erste bis vierte; Tag 1 = Sonntag; Stunde = lokale Uhrzeit vor dem Wechsel; Versatz = UTC-Versatz in Minuten nach dem Wechsel (`TimeStd` = Normalzeit, `TimeDst` = Sommerzeit). Erwartungswerte aus der Tasmota-Doku (Berlin) und eigener Rechnung, nicht an Hardware geprüft.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { tasmotaTimezone } from './timezone';

describe('tasmotaTimezone', () => {
  it('rechnet Europe/Berlin um', () => {
    expect(tasmotaTimezone('Europe/Berlin', 2026)).toEqual({ timezone: '99', timeStd: '0,0,10,1,3,60', timeDst: '0,0,3,1,2,120' });
  });
  it('rechnet America/New_York um (zweiter Sonntag im März, erster im November)', () => {
    expect(tasmotaTimezone('America/New_York', 2026)).toEqual({ timezone: '99', timeStd: '0,1,11,1,2,-300', timeDst: '0,2,3,1,2,-240' });
  });
  it('erkennt die Südhalbkugel (Australia/Sydney)', () => {
    expect(tasmotaTimezone('Australia/Sydney', 2026)).toEqual({ timezone: '99', timeStd: '1,1,4,1,3,600', timeDst: '1,1,10,1,2,660' });
  });
  it('nutzt ohne Sommerzeit einen festen Versatz', () => {
    expect(tasmotaTimezone('Asia/Tokyo', 2026)).toEqual({ timezone: '+09:00', timeStd: null, timeDst: null });
    expect(tasmotaTimezone('Asia/Kolkata', 2026)).toEqual({ timezone: '+05:30', timeStd: null, timeDst: null });
  });
  it('liefert null für unbekannte Zonen', () => {
    expect(tasmotaTimezone('Mars/Olympus', 2026)).toBeNull();
  });
});
```

- [ ] **Step 2: Fehlschlag bestätigen**

Run: `pnpm --filter @tm/server exec vitest run src/timezone.test.ts`
Expected: FAIL (Modul fehlt)

- [ ] **Step 3: Implementierung**

```ts
/** UTC-Versatz einer Zone in Minuten zum Zeitpunkt `at`. */
function offsetMinutes(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((local - Math.floor(at / 60_000) * 60_000) / 60_000);
}

interface Transition {
  at: number;
  before: number;
  after: number;
}

const HOUR = 3_600_000;

function transitions(zone: string, year: number): Transition[] {
  const result: Transition[] = [];
  const end = Date.UTC(year + 1, 0, 1);
  let previous = offsetMinutes(zone, Date.UTC(year, 0, 1));
  for (let t = Date.UTC(year, 0, 1) + HOUR; t <= end; t += HOUR) {
    const current = offsetMinutes(zone, t);
    if (current === previous) continue;
    // Auf die Minute genau suchen (manche Zonen wechseln zur halben Stunde).
    let at = t - HOUR;
    while (offsetMinutes(zone, at) === previous) at += 60_000;
    result.push({ at, before: previous, after: current });
    previous = current;
  }
  return result;
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function rule(t: Transition, hemisphere: number): string {
  // Lokale Zeit vor dem Wechsel: Tasmota-Regeln beziehen sich auf die bis dahin gültige Uhrzeit.
  const local = new Date(t.at + t.before * 60_000);
  const day = local.getUTCDate();
  const month = local.getUTCMonth() + 1;
  const daysInMonth = new Date(Date.UTC(local.getUTCFullYear(), month, 0)).getUTCDate();
  const week = day + 7 > daysInMonth ? 0 : Math.ceil(day / 7);
  return [hemisphere, week, month, local.getUTCDay() + 1, local.getUTCHours(), t.after].join(',');
}

/** IANA-Zone → Tasmota: `Timezone 99` mit TimeStd/TimeDst, ohne Sommerzeit ein fester Versatz; null, wenn nicht abbildbar. */
export function tasmotaTimezone(
  zone: string,
  year = new Date().getUTCFullYear(),
): { timezone: string; timeStd: string | null; timeDst: string | null } | null {
  let found: Transition[];
  try {
    found = transitions(zone, year);
  } catch {
    return null;
  }
  if (found.length === 0) return { timezone: formatOffset(offsetMinutes(zone, Date.UTC(year, 0, 1))), timeStd: null, timeDst: null };
  if (found.length !== 2) return null;
  const toDst = found.find((t) => t.after > t.before);
  const toStd = found.find((t) => t.after < t.before);
  if (!toDst || !toStd) return null;
  // Nordhalbkugel: Sommerzeit beginnt im Jahr vor ihrem Ende.
  const hemisphere = toDst.at < toStd.at ? 0 : 1;
  return { timezone: '99', timeStd: rule(toStd, hemisphere), timeDst: rule(toDst, hemisphere) };
}
```

- [ ] **Step 4: Tests**

Run: `pnpm --filter @tm/server exec vitest run src/timezone.test.ts`
Expected: PASS. Schlägt ein Erwartungswert fehl, zuerst prüfen, ob der Test oder der Code falsch rechnet (Kalender 2026: 29. März, 25. Oktober, 8. März, 1. November, 5. April, 4. Oktober sind Sonntage), und das Ergebnis im Bericht begründen.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/timezone.ts packages/server/src/timezone.test.ts
git commit -m "feat(server): HA-Zeitzone in Tasmota-Sommerzeitregeln umrechnen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Sofort-Regel erzeugen und vormerken

**Files:**
- Create: `packages/server/src/fastRule.ts`
- Create: `packages/server/src/fastRule.test.ts`
- Create: `packages/server/src/api/fastRule.ts` (Routen), in `packages/server/src/api/app.ts` registrieren wie die übrigen Routen-Module
- Test: `packages/server/src/api/changes.test.ts`

**Interfaces:**
- Consumes: `FastRulePreview`, `FastRuleRequestSchema` (Task 1); `gateway.send(id, cmd)`; `parseRuleState` aus `changes/catalog.ts`; `registry.getSensors(id)`; `store.stage(...)`.
- Produces:
  - `buildFastRule(sensors: unknown): { rule: string | null; included: string[]; omitted: string[] }`
  - `POST /api/fast-rule/preview` → `FastRulePreview[]`
  - `POST /api/fast-rule/stage` → `StageResult` (merkt pro Gerät mit `reason: 'ok'` die Settings `Rule<slot>`, `Rule<slot>Enabled: '1'`, `TelePeriod: '10'` vor, Quelle `rule`)

- [ ] **Step 1: Failing unit test**

```ts
import { describe, expect, it } from 'vitest';
import { buildFastRule } from './fastRule';

const sns = (blocks: Record<string, unknown>) => ({ StatusSNS: { Time: '2026-10-01T12:00:00', TempUnit: 'C', ...blocks } });

describe('buildFastRule', () => {
  it('erzeugt einen Auslöser pro Sensorblock mit dessen erstem Messwert', () => {
    expect(buildFastRule(sns({ AM2301: { Temperature: 21, Humidity: 40 }, VL53L0X: { Distance: 120 } }))).toEqual({
      rule: 'ON AM2301#Temperature DO TelePeriod 1 ENDON ON VL53L0X#Distance DO TelePeriod 1 ENDON',
      included: ['AM2301', 'VL53L0X'],
      omitted: [],
    });
  });
  it('lässt ENERGY und Chip-Temperaturen aus', () => {
    expect(buildFastRule(sns({ ENERGY: { Power: 5 }, ESP32: { Temperature: 40 }, DS18B20: { Temperature: 20 } }))).toEqual({
      rule: 'ON DS18B20#Temperature DO TelePeriod 1 ENDON',
      included: ['DS18B20'],
      omitted: ['ENERGY', 'ESP32'],
    });
  });
  it('liefert ohne passende Sensoren keine Regel', () => {
    expect(buildFastRule(sns({ ENERGY: { Power: 5 } })).rule).toBeNull();
    expect(buildFastRule(undefined).rule).toBeNull();
  });
  it('hält die Grenze von 511 Zeichen ein', () => {
    const blocks = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`DS18B20-${i + 1}`, { Temperature: 20 }]));
    const result = buildFastRule(sns(blocks));
    expect(result.rule?.length).toBeLessThanOrEqual(511);
    expect(result.included.length + result.omitted.length).toBe(20);
    expect(result.omitted.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Fehlschlag bestätigen**

Run: `pnpm --filter @tm/server exec vitest run src/fastRule.test.ts`
Expected: FAIL

- [ ] **Step 3: `fastRule.ts`**

```ts
import { MAX_RULE_LENGTH } from '@tm/shared';
import { isObj } from './tasmota/parse';

const SKIPPED = (key: string) => key === 'ENERGY' || /^ESP32/i.test(key);

/** Eine Regel, die bei jeder Messung eines Sensorblocks sofort Telemetrie sendet (`TelePeriod 1`). */
export function buildFastRule(sensors: unknown): { rule: string | null; included: string[]; omitted: string[] } {
  const sns = isObj(sensors) && isObj(sensors.StatusSNS) ? sensors.StatusSNS : {};
  const included: string[] = [];
  const omitted: string[] = [];
  const lines: string[] = [];
  for (const [block, values] of Object.entries(sns)) {
    if (!isObj(values)) continue;
    if (SKIPPED(block)) {
      omitted.push(block);
      continue;
    }
    const field = Object.entries(values).find(([, v]) => typeof v === 'number')?.[0];
    if (!field) continue;
    const line = `ON ${block}#${field} DO TelePeriod 1 ENDON`;
    if ([...lines, line].join(' ').length > MAX_RULE_LENGTH) {
      omitted.push(block);
      continue;
    }
    lines.push(line);
    included.push(block);
  }
  return { rule: lines.length > 0 ? lines.join(' ') : null, included, omitted };
}
```

- [ ] **Step 4: Routen**

`packages/server/src/api/fastRule.ts`:

```ts
import { type FastRulePreview, FastRuleRequestSchema, type StageResult } from '@tm/shared';
import type { FastifyInstance } from 'fastify';
import { parseRuleState } from '../changes/catalog';
import { buildFastRule } from '../fastRule';
import { TransportError } from '../transport/errors';
import type { AppDeps } from './app';
import { parseBody } from './validate';

async function preview(deps: AppDeps, deviceId: string): Promise<FastRulePreview | null> {
  const device = deps.registry.get(deviceId);
  if (!device) return null;
  const built = buildFastRule(deps.registry.getSensors(deviceId));
  const base = { deviceId, deviceName: device.name, rule: built.rule, included: built.included, omitted: built.omitted };
  if (!built.rule) return { ...base, slot: null, reason: 'noSensors' };
  try {
    for (const index of [1, 2, 3]) {
      // Nur lesen; ein belegter Slot wird nie überschrieben.
      const state = parseRuleState(index, (await deps.gateway.send(deviceId, `Rule${index}`)).response);
      if (state.text.trim() === '') return { ...base, slot: index, reason: 'ok' };
    }
    return { ...base, slot: null, reason: 'noSlot' };
  } catch (err) {
    if (err instanceof TransportError) return { ...base, slot: null, reason: 'unreachable' };
    throw err;
  }
}

export function registerFastRuleRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/api/fast-rule/preview', async (req, reply) => {
    const body = parseBody(FastRuleRequestSchema, req.body, reply);
    if (!body) return reply;
    const results = await Promise.all(body.deviceIds.map((id) => preview(deps, id)));
    return results.filter((r): r is FastRulePreview => r !== null);
  });

  app.post('/api/fast-rule/stage', async (req, reply) => {
    const body = parseBody(FastRuleRequestSchema, req.body, reply);
    if (!body) return reply;
    const total: StageResult = { staged: 0, skipped: 0, incompatible: 0 };
    for (const id of body.deviceIds) {
      const p = await preview(deps, id);
      if (!p || p.reason !== 'ok' || !p.rule || !p.slot) continue;
      const result = deps.store.stage({
        deviceIds: [id],
        settings: { [`Rule${p.slot}`]: p.rule, [`Rule${p.slot}Enabled`]: '1', TelePeriod: '10' },
        source: 'rule',
      });
      total.staged += result.staged;
      total.skipped += result.skipped;
    }
    return total;
  });
}
```

Registrierung in `buildApp` (`api/app.ts`) neben den übrigen `register…Routes`-Aufrufen: `registerFastRuleRoutes(app, deps);`. Falls die übrigen Routen-Module eine andere Signatur haben, dieselbe Form übernehmen. Prüfen, dass `'rule'` ein erlaubter Wert von `ChangeSourceSchema` ist (`grep -n "ChangeSourceSchema" packages/shared/src/index.ts`); falls nicht, `'rule'` dort ergänzen.

- [ ] **Step 5: API-Test**

In `api/changes.test.ts`:

```ts
  it('schlägt eine Sofort-Regel vor und merkt sie im freien Slot vor', async () => {
    const { app, store } = await setupApp({ fake: { sensors: { AM2301: { Temperature: 21, Humidity: 40 } } } });
    await addFake(app);
    const preview = await app.inject({ method: 'POST', url: '/api/fast-rule/preview', payload: { deviceIds: [MAC] } });
    expect(preview.json()).toEqual([
      expect.objectContaining({ rule: 'ON AM2301#Temperature DO TelePeriod 1 ENDON', slot: 1, reason: 'ok' }),
    ]);
    const staged = await app.inject({ method: 'POST', url: '/api/fast-rule/stage', payload: { deviceIds: [MAC] } });
    expect(staged.json()).toMatchObject({ staged: 3 });
    expect(store.forDevice(MAC).map((r) => r.key).sort()).toEqual(['Rule1', 'Rule1Enabled', 'TelePeriod']);
  });

  it('überschreibt keine belegten Rule-Slots', async () => {
    const { app, fake } = await setupApp({ fake: { sensors: { AM2301: { Temperature: 21 } } } });
    await addFake(app);
    for (const n of [1, 2, 3]) fake.execute(`Rule${n} ON System#Boot DO Power 1 ENDON`);
    const preview = await app.inject({ method: 'POST', url: '/api/fast-rule/preview', payload: { deviceIds: [MAC] } });
    expect(preview.json()).toEqual([expect.objectContaining({ slot: null, reason: 'noSlot' })]);
  });

  it('meldet nicht erreichbare Geräte, ohne die anderen abzubrechen', async () => {
    const { app, fake } = await setupApp({ fake: { sensors: { AM2301: { Temperature: 21 } } } });
    await addFake(app);
    await fake.stop();
    const preview = await app.inject({ method: 'POST', url: '/api/fast-rule/preview', payload: { deviceIds: [MAC, 'GIBTSNICHT'] } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual([expect.objectContaining({ deviceId: MAC, slot: null, reason: 'unreachable' })]);
  });
```

(`fake.execute` ist im Fake öffentlich; falls nicht, über die vorhandene Befehlsschnittstelle des Fakes setzen.)

- [ ] **Step 6: Tests**

Run: `pnpm --filter @tm/server exec vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages
git commit -m "feat(server): Sofort-Regel aus Sensoren erzeugen, Vorschau und Vormerken

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Vorschläge aus Home Assistant und HA-Gerätename

**Files:**
- Modify: `packages/server/src/ha/client.ts` (`config`-Daten speichern)
- Modify: `packages/server/src/config.ts` (`MqttConfig.onHa`, `detectHostIp`)
- Create: `packages/server/src/haSuggestions.ts`
- Create: `packages/server/src/haSuggestions.test.ts`
- Modify: `packages/server/src/api/app.ts`, `packages/server/src/api/live.ts`, `packages/server/src/server.ts`, `packages/server/test/appSetup.ts`
- Modify: `packages/server/src/enrich.ts`, `packages/server/src/enrich.test.ts`
- Modify: Web-Test-Fixtures mit `StatusResponse` (`haSuggestions` ergänzen)

**Interfaces:**
- Consumes: `tasmotaTimezone` (Task 5), `HaSuggestions` (Task 1), `HaLink.nameByUser` (Task 2).
- Produces:
  - `HaClient.config: { timeZone: string | null; country: string | null; fahrenheit: boolean | null }` (neben `language`, `location`)
  - `MqttConfig.onHa?: boolean` (true, wenn der Broker vom Supervisor-Dienst kommt)
  - `detectHostIp(ifaces?): string | null`
  - `buildHaSuggestions(input: { timeZone: string | null; country: string | null; fahrenheit: boolean | null; mqttOnHa: boolean; mqttPort: number | null; hostIp: string | null; deviceMqttUsers: string[] }): HaSuggestions`
  - `AppDeps.haSuggestions?: () => HaSuggestions`

- [ ] **Step 1: Failing tests**

`packages/server/src/haSuggestions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildHaSuggestions } from './haSuggestions';

const base = { timeZone: null, country: null, fahrenheit: null, mqttOnHa: false, mqttPort: null, hostIp: null, deviceMqttUsers: [] };

describe('buildHaSuggestions', () => {
  it('liefert ohne Quellen nur den allgemeinen NTP-Server', () => {
    expect(buildHaSuggestions(base)).toEqual({ timezone: null, ntpServer: 'pool.ntp.org', mqtt: null, mqttUser: null, fahrenheit: null });
  });
  it('nutzt Zeitzone, Land und Einheit aus HA', () => {
    const s = buildHaSuggestions({ ...base, timeZone: 'Europe/Berlin', country: 'DE', fahrenheit: false });
    expect(s.timezone).toMatchObject({ zone: 'Europe/Berlin', timezone: '99' });
    expect(s.ntpServer).toBe('de.pool.ntp.org');
    expect(s.fahrenheit).toBe(false);
  });
  it('schlägt den Broker nur vor, wenn er auf HA läuft und die Adresse bekannt ist', () => {
    expect(buildHaSuggestions({ ...base, mqttOnHa: true, mqttPort: 1883, hostIp: '192.168.1.5' }).mqtt).toEqual({ host: '192.168.1.5', port: 1883 });
    expect(buildHaSuggestions({ ...base, mqttOnHa: false, mqttPort: 1883, hostIp: '192.168.1.5' }).mqtt).toBeNull();
    expect(buildHaSuggestions({ ...base, mqttOnHa: true, mqttPort: 1883, hostIp: null }).mqtt).toBeNull();
  });
  it('schlägt den häufigsten MQTT-Benutzer der Geräte vor, ab zwei Geräten', () => {
    expect(buildHaSuggestions({ ...base, deviceMqttUsers: ['tasmota', 'tasmota', 'DVES_USER'] }).mqttUser).toBe('tasmota');
    expect(buildHaSuggestions({ ...base, deviceMqttUsers: ['tasmota'] }).mqttUser).toBeNull();
  });
});
```

Im `app.test.ts` den Status-Test anpassen und ergänzen:

```ts
  it('gibt in den HA-Vorschlägen nie die Zugangsdaten des MQTT-Dienstes aus', async () => {
    const { app } = await setup();
    const body = (await app.inject('/api/status')).body;
    expect(JSON.parse(body)).toMatchObject({ haSuggestions: { ntpServer: 'pool.ntp.org', mqtt: null } });
  });
```

Den vorhandenen Test „liefert den Status“ auf `toMatchObject({ mqtt: 'disabled', version: 'test', scanning: false, haLocation: null })` umstellen.

Im `enrich.test.ts`:

```ts
  it('schlägt den in HA vergebenen Namen vor, auch für eigene Namen', () => {
    const db = testDb();
    const registry = new DeviceRegistry(db);
    const store = new PendingStore(db, registry);
    registry.upsert({ mac: 'AABBCC000001', name: 'Keller' }, { statusJson: { StatusSTS: { POWER: 'ON' } } });
    const link: HaLink = { deviceId: 'dev1', areaName: null, nameByUser: 'Kellerlicht', entities: [], automations: [] };
    const enricher = new DeviceEnricher(registry, store, { link: () => link }, () => 'de');
    expect(enricher.one('AABBCC000001')?.nameSuggestion).toBe('Kellerlicht');
  });
```

- [ ] **Step 2: Fehlschlag bestätigen**

Run: `pnpm --filter @tm/server exec vitest run src/haSuggestions.test.ts src/enrich.test.ts`
Expected: FAIL

- [ ] **Step 3: `haSuggestions.ts`**

```ts
import type { HaSuggestions } from '@tm/shared';
import { tasmotaTimezone } from './timezone';

export interface HaSuggestionInput {
  timeZone: string | null;
  country: string | null;
  fahrenheit: boolean | null;
  mqttOnHa: boolean;
  mqttPort: number | null;
  hostIp: string | null;
  deviceMqttUsers: string[];
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return best && best[1] >= 2 ? best[0] : null;
}

export function buildHaSuggestions(input: HaSuggestionInput): HaSuggestions {
  const tz = input.timeZone ? tasmotaTimezone(input.timeZone) : null;
  return {
    timezone: tz && input.timeZone ? { zone: input.timeZone, ...tz } : null,
    ntpServer: input.country && /^[A-Za-z]{2}$/.test(input.country) ? `${input.country.toLowerCase()}.pool.ntp.org` : 'pool.ntp.org',
    mqtt: input.mqttOnHa && input.hostIp && input.mqttPort ? { host: input.hostIp, port: input.mqttPort } : null,
    mqttUser: mostCommon(input.deviceMqttUsers),
    fahrenheit: input.fahrenheit,
  };
}
```

- [ ] **Step 4: Quellen anbinden**

`ha/client.ts`: Feld

```ts
  /** Zeitzone, Land und Einheit aus der HA-Konfiguration; null, solange unbekannt. */
  config: { timeZone: string | null; country: string | null; fahrenheit: boolean | null } = { timeZone: null, country: null, fahrenheit: null };
```

In `refresh()` nach dem Setzen von `language`:

```ts
    if (config) {
      const unit = isObj(config.unit_system) ? config.unit_system.temperature : undefined;
      this.config = {
        timeZone: typeof config.time_zone === 'string' ? config.time_zone : null,
        country: typeof config.country === 'string' ? config.country : null,
        fahrenheit: typeof unit === 'string' ? unit.includes('F') : null,
      };
    }
```

Im HA-Fake (`test/fakes/haServer.ts`) die `get_config`-Antwort um `time_zone: 'Europe/Berlin', country: 'DE', unit_system: { temperature: '°C' }` ergänzen und in `ha/client.test.ts` prüfen: `expect(client.config).toEqual({ timeZone: 'Europe/Berlin', country: 'DE', fahrenheit: false });`.

`config.ts`: `MqttConfig` um `onHa?: boolean` ergänzen; im Zweig mit `data.host` (Supervisor-Dienst) `onHa: true` setzen. Neue Funktion neben `detectHostCidrs`:

```ts
/** Erste IPv4-Adresse des Hosts im LAN (die App läuft mit host_network). */
export function detectHostIp(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string | null {
  for (const [name, addresses] of Object.entries(ifaces)) {
    if (IGNORED_INTERFACES.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}
```

Test in `config.test.ts` analog zum vorhandenen `detectHostCidrs`-Test (gleiche Fake-Interfaces): erwartete Adresse der ersten nicht ignorierten Schnittstelle.

`api/app.ts`: `AppDeps` um `haSuggestions?: () => HaSuggestions;`. `api/live.ts`: im Status-Objekt

```ts
    haSuggestions:
      deps.haSuggestions?.() ?? { timezone: null, ntpServer: 'pool.ntp.org', mqtt: null, mqttUser: null, fahrenheit: null },
```

`server.ts`: in den `buildApp`-Deps

```ts
    haSuggestions: () =>
      buildHaSuggestions({
        ...(ha?.config ?? { timeZone: null, country: null, fahrenheit: null }),
        mqttOnHa: config.mqtt?.onHa ?? false,
        mqttPort: config.mqtt ? Number(new URL(config.mqtt.url).port || 1883) : null,
        hostIp: detectHostIp(),
        deviceMqttUsers: registry
          .listRaw()
          .map((r) => readFromStatus('MqttUser', r.statusJson))
          .filter((u): u is string => u !== null),
      }),
```

(Importe: `buildHaSuggestions`, `detectHostIp`, `readFromStatus` aus `@tm/shared`.)

`enrich.ts`: im `return devices.map(...)` den Vorschlag bestimmen:

```ts
      const haName = d.suggestionDismissed ? null : (links.get(d.id)?.nameByUser ?? null);
      const suggestion = haName ?? suggestions.get(d.id) ?? null;
```

(statt der bisherigen Zeile `const suggestion = suggestions.get(d.id) ?? null;`).

Web-Fixtures: alle Stellen mit `haLocation: null` in Web-Tests (`grep -rln "haLocation" packages/web/src`) um `haSuggestions: { timezone: null, ntpServer: 'pool.ntp.org', mqtt: null, mqttUser: null, fahrenheit: null }` ergänzen.

- [ ] **Step 5: Tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages
git commit -m "feat(server): Vorschläge aus Home Assistant (Zeitzone, NTP, MQTT, Einheit, Gerätename)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Formular nach Gerätetyp filtern, Hinweise und TelePeriod-Warnungen

**Files:**
- Modify: `packages/web/src/features/changes/SettingsFields.tsx`
- Modify: `packages/web/src/features/devices/BatchSettingsDialog.tsx`, `packages/web/src/features/devices/detail/SettingsTab.tsx`
- Modify: `packages/web/src/features/changes/useStage.ts`
- Modify: Wörterbücher (6 Dateien)
- Test: `packages/web/src/features/devices/EditMenu.test.tsx` (oder neue Datei `packages/web/src/features/changes/SettingsFields.view.test.tsx`)

**Interfaces:**
- Consumes: `Device.capabilities`, `settingApplies`, `StageResult.incompatible`.
- Produces: `SettingsFields` bekommt die Prop `devices: Device[]` (betroffene Geräte) und rendert nur Gruppen/Felder, die für mindestens eines passen; zeigt „gilt für X von Y“ bei mehr als einem Gerät; zeigt `hint.<Key>`; zeigt TelePeriod-Warnungen. Die Prop `onFastRule?: () => void` (für Task 10) wird hier schon angenommen und beim Wert unter 10 als Button angeboten.

Neue Wörterbuchschlüssel (de / en; fr, es, it, nl übersetzen):

| Schlüssel | de | en |
|---|---|---|
| `group.energy` | Energiemessung | Energy monitoring |
| `group.light` | Licht | Light |
| `group.relay` | Relais | Relays |
| `group.climate` | Klima-Sensoren | Climate sensors |
| `setting.PowerDelta` | Sofortmeldung bei Leistungsänderung (PowerDelta) | Report on power change (PowerDelta) |
| `setting.EnergyRes` | Nachkommastellen Energie (0–5) | Energy decimals (0–5) |
| `setting.WattRes` | Nachkommastellen Leistung (0–3) | Power decimals (0–3) |
| `setting.Fade` | Weich ein- und ausblenden (Fade) | Fade in and out (Fade) |
| `setting.Speed` | Blendtempo (1–40) | Fade speed (1–40) |
| `setting.DimmerRange` | Dimmbereich (Min,Max) | Dimmer range (min,max) |
| `setting.SetOption20` | Helligkeit ändern ohne Einschalten (SetOption20) | Change brightness without switching on (SetOption20) |
| `setting.SetOption0` | Schaltzustand speichern (SetOption0) | Save power state (SetOption0) |
| `setting.Interlock` | Gegenseitige Verriegelung (Interlock) | Interlock |
| `setting.TempRes` | Nachkommastellen Temperatur (0–3) | Temperature decimals (0–3) |
| `setting.HumRes` | Nachkommastellen Feuchte (0–3) | Humidity decimals (0–3) |
| `setting.TempOffset` | Temperatur-Korrektur (±12,6) | Temperature offset (±12.6) |
| `setting.HumOffset` | Feuchte-Korrektur (±10) | Humidity offset (±10) |
| `setting.SetOption8` | Temperatur in °F (SetOption8) | Temperature in °F (SetOption8) |
| `setting.TimeStd` | Regel Normalzeit (TimeStd) | Standard time rule (TimeStd) |
| `setting.TimeDst` | Regel Sommerzeit (TimeDst) | Daylight saving rule (TimeDst) |
| `hint.TelePeriod` | Wie oft das Gerät Messwerte sendet. | How often the device sends readings. |
| `hint.PowerDelta` | 101 = 1 W, 110 = 10 W, 1–100 = Prozent, 0 = aus | 101 = 1 W, 110 = 10 W, 1–100 = percent, 0 = off |
| `hint.DimmerRange` | Gegen Flackern bei LED-Lampen, z. B. 10,100 | Against flickering LED lamps, e.g. 10,100 |
| `hint.SetOption20` | Ein Dimmbefehl schaltet die Lampe dann nicht ein. | A dimming command then does not switch the lamp on. |
| `hint.SetOption0` | Häufiges Schalten belastet den Flash-Speicher. | Frequent switching wears the flash memory. |
| `hint.Interlock` | Nur ein Relais gleichzeitig, z. B. für Rollläden. Gilt für alle Relais des Geräts. | Only one relay at a time, e.g. for blinds. Applies to all relays of the device. |
| `hint.SetOption8` | Passend zur Einheit in Home Assistant wählen. | Choose to match the unit in Home Assistant. |
| `validation.dimmerRange` | Min,Max zwischen 0 und 100, Min kleiner als Max | Min,max between 0 and 100, min below max |
| `validation.timeRule` | Format: Hemisphäre,Woche,Monat,Tag,Stunde,Versatz | Format: hemisphere,week,month,day,hour,offset |
| `edit.appliesTo` | gilt für {count} von {total} | applies to {count} of {total} |
| `edit.unknownType` | {count} Geräte mit unbekanntem Typ werden bei gerätespezifischen Einstellungen übersprungen. | {count} devices of unknown type are skipped for device-specific settings. |
| `devices.stagedIncompatible` | {staged} Änderungen vorgemerkt, {incompatible} Geräte übersprungen (passt nicht zum Gerätetyp) | {staged} changes staged, {incompatible} devices skipped (does not match the device type) |
| `telePeriod.dbWarning` | Kurze Intervalle füllen die Datenbank von Home Assistant. | Short intervals fill the Home Assistant database. |
| `telePeriod.powerDelta` | Für schnelle Leistungswerte besser PowerDelta verwenden. | For fast power readings, use PowerDelta instead. |
| `telePeriod.tooShort` | Tasmota sendet höchstens alle 10 s. Stattdessen eine Regel anlegen, die bei jeder Sensormessung sofort sendet? | Tasmota sends at most every 10 s. Create a rule instead that sends on every sensor reading? |
| `telePeriod.offerRule` | Regel vorschlagen | Suggest a rule |

- [ ] **Step 1: Failing test**

Neue Datei `packages/web/src/features/changes/SettingsFields.view.test.tsx`:

```tsx
import { SETTINGS } from '@tm/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { makeDevice } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { type FieldValues, SettingsFields } from './SettingsFields';

vi.mock('@/lib/api', () => ({ api: { status: vi.fn().mockResolvedValue({ haLocation: null, haSuggestions: { timezone: null, ntpServer: 'pool.ntp.org', mqtt: null, mqttUser: null, fahrenheit: null } }) }, ApiError: class extends Error {} }));

function Harness({ devices, onFastRule }: { devices: ReturnType<typeof makeDevice>[]; onFastRule?: () => void }) {
  const [values, setValues] = useState<FieldValues>({});
  return (
    <SettingsFields
      idPrefix="t"
      defs={SETTINGS.filter((d) => d.batch)}
      devices={devices}
      values={values}
      errors={{}}
      onFastRule={onFastRule}
      onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))}
    />
  );
}

const plug = makeDevice({ id: 'P', capabilities: ['energy', 'relay'] });
const lamp = makeDevice({ id: 'L', capabilities: ['light', 'relay'] });

describe('SettingsFields nach Gerätetyp', () => {
  it('zeigt nur passende Gruppen und wie viele Geräte betroffen sind', () => {
    renderWithProviders(<Harness devices={[plug, lamp]} />);
    expect(screen.getByText('Energiemessung')).toBeInTheDocument();
    expect(screen.getByText('Licht')).toBeInTheDocument();
    expect(screen.queryByText('Klima-Sensoren')).not.toBeInTheDocument();
    expect(screen.getAllByText('gilt für 1 von 2').length).toBeGreaterThan(0);
  });

  it('warnt bei kurzer TelePeriod und nennt PowerDelta nur bei Energiemessung', async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<Harness devices={[plug]} />);
    await user.type(screen.getByLabelText(/Telemetrie-Intervall/), '30');
    expect(screen.getByText('Kurze Intervalle füllen die Datenbank von Home Assistant.')).toBeInTheDocument();
    expect(screen.getByText('Für schnelle Leistungswerte besser PowerDelta verwenden.')).toBeInTheDocument();
    unmount();
    renderWithProviders(<Harness devices={[lamp]} />);
    await user.type(screen.getByLabelText(/Telemetrie-Intervall/), '30');
    expect(screen.queryByText('Für schnelle Leistungswerte besser PowerDelta verwenden.')).not.toBeInTheDocument();
  });

  it('bietet unter 10 s eine Regel an', async () => {
    const user = userEvent.setup();
    const onFastRule = vi.fn();
    renderWithProviders(<Harness devices={[plug]} onFastRule={onFastRule} />);
    await user.type(screen.getByLabelText(/Telemetrie-Intervall/), '5');
    await user.click(screen.getByRole('button', { name: 'Regel vorschlagen' }));
    expect(onFastRule).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Fehlschlag bestätigen**

Run: `pnpm --filter @tm/web exec vitest run src/features/changes/SettingsFields.view.test.tsx`
Expected: FAIL

- [ ] **Step 3: `SettingsFields` erweitern**

Props ergänzen:

```ts
  /** Betroffene Geräte; bestimmt sichtbare Felder und „gilt für X von Y“. */
  devices: Device[];
  /** Wird angeboten, wenn TelePeriod unter 10 s eingegeben wird. */
  onFastRule?: () => void;
```

Am Anfang der Komponente:

```ts
  const applying = (def: SettingDef) => devices.filter((d) => settingApplies(def, d.capabilities)).length;
  const visible = defs.filter((d) => applying(d) > 0);
  const groups = [...new Set(visible.map((d) => d.group))];
  const unknownType = devices.filter((d) => d.capabilities.length === 0).length;
  const hasEnergy = devices.some((d) => d.capabilities.includes('energy'));
```

Über den Gruppen, nur bei mehr als einem Gerät und `unknownType > 0`:

```tsx
      {devices.length > 1 && unknownType > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-300">{t('edit.unknownType', { count: unknownType })}</p>
      )}
```

Die Feldschleife iteriert über `visible` statt `defs`. Neben dem `<Label>`:

```tsx
                  <div className="flex items-baseline justify-between gap-2">
                    <Label htmlFor={id}>{t(`setting.${def.key}` as MessageKey)}</Label>
                    {devices.length > 1 && def.appliesTo.length > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {t('edit.appliesTo', { count: applying(def), total: devices.length })}
                      </span>
                    )}
                  </div>
```

Unter dem Eingabefeld, vor der Fehlermeldung:

```tsx
                  {def.hint && (
                    <p className={`text-xs ${def.key === 'Interlock' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`}>
                      {t(`hint.${def.key}` as MessageKey)}
                    </p>
                  )}
                  {def.key === 'TelePeriod' && <TelePeriodNotes value={value} energy={hasEnergy} onFastRule={onFastRule} />}
```

Hilfskomponente in derselben Datei:

```tsx
function TelePeriodNotes({ value, energy, onFastRule }: { value: string; energy: boolean; onFastRule?: () => void }) {
  const t = useT();
  const seconds = Number(value);
  if (value.trim() === '' || !Number.isFinite(seconds) || seconds >= 60) return null;
  return (
    <div className="space-y-1 text-xs text-amber-700 dark:text-amber-300">
      <p>{t('telePeriod.dbWarning')}</p>
      {energy && <p>{t('telePeriod.powerDelta')}</p>}
      {seconds < 10 && (
        <p className="flex flex-wrap items-center gap-2">
          {t('telePeriod.tooShort')}
          {onFastRule && (
            <Button type="button" size="sm" variant="outline" onClick={onFastRule}>
              {t('telePeriod.offerRule')}
            </Button>
          )}
        </p>
      )}
    </div>
  );
}
```

(Importe: `Device`, `settingApplies` aus `@tm/shared`, `Button` aus `@/components/ui/button`.)

`collectSettings(defs, values)` bleibt; die Dialoge übergeben ihr nur die sichtbaren Definitionen nicht – nicht sichtbare Felder haben keinen Wert und werden ohnehin übersprungen.

- [ ] **Step 4: Dialoge und Hook**

`BatchSettingsDialog.tsx`: `<SettingsFields … devices={devices} />`. `SettingsTab.tsx`: `devices={[device]}`; `DEFS` schließt zusätzlich nichts weiter aus (Kalibrierwerte sind `batch: false`, aber in der Detailansicht erlaubt – `DEFS` filtert nur `rules`/`timers`).

`useStage.ts`:

```ts
    onSuccess: (result) => {
      toast.success(
        result.incompatible > 0
          ? t('devices.stagedIncompatible', { staged: result.staged, incompatible: result.incompatible })
          : result.skipped > 0
            ? t('devices.stagedSkipped', { staged: result.staged, skipped: result.skipped })
            : t('devices.staged', { staged: result.staged }),
      );
```

und `onError: (err: Error) => toast.error(t('common.error', { message: errorText(t, err) })),` (Import `errorText` aus `@/lib/errors`).

Alle Mocks/Fixtures, die `StageResult` zurückgeben (`grep -rn "skipped:" packages/web/src`), um `incompatible: 0` ergänzen.

- [ ] **Step 5: Wörterbücher**

Alle Schlüssel aus der Tabelle oben in `messages.ts` (`de` und `en`) und in `locales/{fr,es,it,nl}.ts` eintragen.

- [ ] **Step 6: Tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/web
git commit -m "feat(web): Einstellungen nach Gerätetyp filtern, Hinweise und TelePeriod-Warnungen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: HA-Vorschläge an den Feldern

**Files:**
- Create: `packages/web/src/features/changes/HaFieldSuggestions.tsx`
- Create: `packages/web/src/features/changes/HaFieldSuggestions.test.tsx`
- Modify: `packages/web/src/features/changes/SettingsFields.tsx`
- Modify: Wörterbücher (6 Dateien)

**Interfaces:**
- Consumes: `api.status()` → `haSuggestions` (Task 7); `SettingsFields` (Task 8).
- Produces: `HaFieldSuggestions({ fieldKey, visibleKeys, onFill }: { fieldKey: string; visibleKeys: Set<string>; onFill: (values: Record<string, string>) => void })` – rendert 0–1 Chip für das Feld.

Neue Schlüssel:

| Schlüssel | de | en |
|---|---|---|
| `suggest.timezone` | Aus Home Assistant: {zone} | From Home Assistant: {zone} |
| `suggest.ntp` | Vorschlag: {server} | Suggestion: {server} |
| `suggest.mqtt` | Broker auf Home Assistant: {host}:{port} | Broker on Home Assistant: {host}:{port} |
| `suggest.mqttUser` | Wie bei deinen anderen Geräten: {user} | As on your other devices: {user} |
| `suggest.unit` | Wie in Home Assistant: {unit} | As in Home Assistant: {unit} |

- [ ] **Step 1: Failing test**

```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { renderWithProviders } from '@/test/render';
import { HaFieldSuggestions } from './HaFieldSuggestions';

vi.mock('@/lib/api', () => ({ api: { status: vi.fn() }, ApiError: class extends Error {} }));

const all = new Set(['Timezone', 'TimeStd', 'TimeDst', 'NtpServer1', 'MqttHost', 'MqttPort', 'MqttUser', 'SetOption8']);

describe('HaFieldSuggestions', () => {
  it('füllt Zeitzone samt Sommerzeitregeln', async () => {
    vi.mocked(api.status).mockResolvedValue({
      mqtt: 'connected', version: 'x', scanning: false, haLocation: null,
      haSuggestions: {
        timezone: { zone: 'Europe/Berlin', timezone: '99', timeStd: '0,0,10,1,3,60', timeDst: '0,0,3,1,2,120' },
        ntpServer: 'de.pool.ntp.org', mqtt: { host: '192.168.1.5', port: 1883 }, mqttUser: 'tasmota', fahrenheit: false,
      },
    });
    const onFill = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<HaFieldSuggestions fieldKey="Timezone" visibleKeys={all} onFill={onFill} />);
    await user.click(await screen.findByRole('button', { name: /Europe\/Berlin/ }));
    expect(onFill).toHaveBeenCalledWith({ Timezone: '99', TimeStd: '0,0,10,1,3,60', TimeDst: '0,0,3,1,2,120' });
  });

  it('füllt MQTT-Host und -Port gemeinsam', async () => {
    const onFill = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<HaFieldSuggestions fieldKey="MqttHost" visibleKeys={all} onFill={onFill} />);
    await user.click(await screen.findByRole('button', { name: /192\.168\.1\.5:1883/ }));
    expect(onFill).toHaveBeenCalledWith({ MqttHost: '192.168.1.5', MqttPort: '1883' });
  });

  it('zeigt nichts für Felder ohne Vorschlag', () => {
    renderWithProviders(<HaFieldSuggestions fieldKey="LedState" visibleKeys={all} onFill={vi.fn()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Fehlschlag bestätigen**

Run: `pnpm --filter @tm/web exec vitest run src/features/changes/HaFieldSuggestions.test.tsx`
Expected: FAIL

- [ ] **Step 3: Komponente**

```tsx
import { useQuery } from '@tanstack/react-query';
import type { HaSuggestions } from '@tm/shared';
import { House } from 'lucide-react';
import { api } from '@/lib/api';
import { type Translate, useT } from '@/lib/i18n';

interface Suggestion {
  label: string;
  values: Record<string, string>;
}

function suggestionFor(key: string, s: HaSuggestions, t: Translate): Suggestion | null {
  switch (key) {
    case 'Timezone': {
      if (!s.timezone) return null;
      const values: Record<string, string> = { Timezone: s.timezone.timezone };
      if (s.timezone.timeStd) values.TimeStd = s.timezone.timeStd;
      if (s.timezone.timeDst) values.TimeDst = s.timezone.timeDst;
      return { label: t('suggest.timezone', { zone: s.timezone.zone }), values };
    }
    case 'NtpServer1':
      return { label: t('suggest.ntp', { server: s.ntpServer }), values: { NtpServer1: s.ntpServer } };
    case 'MqttHost':
      return s.mqtt
        ? { label: t('suggest.mqtt', { host: s.mqtt.host, port: s.mqtt.port }), values: { MqttHost: s.mqtt.host, MqttPort: String(s.mqtt.port) } }
        : null;
    case 'MqttUser':
      return s.mqttUser ? { label: t('suggest.mqttUser', { user: s.mqttUser }), values: { MqttUser: s.mqttUser } } : null;
    case 'SetOption8':
      return s.fahrenheit === null
        ? null
        : { label: t('suggest.unit', { unit: s.fahrenheit ? '°F' : '°C' }), values: { SetOption8: s.fahrenheit ? '1' : '0' } };
    default:
      return null;
  }
}

/** Vorschlag aus Home Assistant für ein Feld; füllt nur Felder, die im Formular sichtbar sind. */
export function HaFieldSuggestions({
  fieldKey,
  visibleKeys,
  onFill,
}: {
  fieldKey: string;
  visibleKeys: Set<string>;
  onFill: (values: Record<string, string>) => void;
}) {
  const t = useT();
  const { data } = useQuery({ queryKey: ['status'], queryFn: api.status });
  const s = data?.haSuggestions;
  const suggestion = s ? suggestionFor(fieldKey, s, t) : null;
  if (!suggestion) return null;
  const values = Object.fromEntries(Object.entries(suggestion.values).filter(([k]) => visibleKeys.has(k)));
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs hover:bg-accent"
      onClick={() => onFill(values)}
    >
      <House className="size-3" aria-hidden />
      {suggestion.label}
    </button>
  );
}
```

`Translate` muss aus `@/lib/i18n` exportiert sein (ist es seit 0.3.0).

- [ ] **Step 4: In `SettingsFields` einbinden**

Unter jedem Feld (nach dem Eingabefeld, vor dem Hinweis):

```tsx
                  <HaFieldSuggestions
                    fieldKey={def.key}
                    visibleKeys={visibleKeys}
                    onFill={(filled) => {
                      for (const [k, v] of Object.entries(filled)) onChange(k, v);
                    }}
                  />
```

mit `const visibleKeys = new Set(visible.map((d) => d.key));` oben in der Komponente.

- [ ] **Step 5: Wörterbücher, Tests**

Schlüssel aus der Tabelle in alle sechs Wörterbücher.
Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/web
git commit -m "feat(web): Vorschläge aus Home Assistant an Zeitzone, NTP, MQTT und Einheit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Sofort-Regel in der Oberfläche

**Files:**
- Create: `packages/web/src/features/changes/FastRuleDialog.tsx`
- Create: `packages/web/src/features/changes/FastRuleDialog.test.tsx`
- Modify: `packages/web/src/lib/api.ts` (`fastRulePreview`, `fastRuleStage`)
- Modify: `packages/web/src/features/devices/BatchSettingsDialog.tsx`, `packages/web/src/features/devices/detail/SettingsTab.tsx` (`onFastRule`)
- Modify: Wörterbücher (6 Dateien)

**Interfaces:**
- Consumes: `POST /api/fast-rule/preview`, `POST /api/fast-rule/stage` (Task 6); `onFastRule` in `SettingsFields` (Task 8).
- Produces: `FastRuleDialog({ deviceIds, open, onOpenChange, onStaged }: { deviceIds: string[]; open: boolean; onOpenChange: (open: boolean) => void; onStaged: () => void })`.

Neue Schlüssel:

| Schlüssel | de | en |
|---|---|---|
| `fastRule.title` | Regel für sofortige Updates | Rule for instant updates |
| `fastRule.description` | Pro Gerät eine Regel, die bei jeder Sensormessung sofort Telemetrie sendet. TelePeriod wird auf 10 s gesetzt. | One rule per device that sends telemetry on every sensor reading. TelePeriod is set to 10 s. |
| `fastRule.slot` | wird zu Rule {slot} | becomes Rule {slot} |
| `fastRule.noSensors` | Keine passenden Sensoren | No suitable sensors |
| `fastRule.noSlot` | Alle Rule-Slots belegt; nichts wird überschrieben | All rule slots are in use; nothing is overwritten |
| `fastRule.unreachable` | Gerät nicht erreichbar | Device not reachable |
| `fastRule.omitted` | Nicht enthalten: {blocks} | Not included: {blocks} |
| `fastRule.stage` | Regeln vormerken | Stage rules |
| `fastRule.loading` | Regeln werden erstellt … | Creating rules … |

- [ ] **Step 1: Failing test**

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { renderWithProviders } from '@/test/render';
import { FastRuleDialog } from './FastRuleDialog';

vi.mock('@/lib/api', () => ({ api: { fastRulePreview: vi.fn(), fastRuleStage: vi.fn() }, ApiError: class extends Error {} }));

describe('FastRuleDialog', () => {
  it('zeigt die Vorschau pro Gerät und merkt die Regeln vor', async () => {
    vi.mocked(api.fastRulePreview).mockResolvedValue([
      { deviceId: 'A', deviceName: 'Bad', rule: 'ON AM2301#Temperature DO TelePeriod 1 ENDON', slot: 1, included: ['AM2301'], omitted: ['ENERGY'], reason: 'ok' },
      { deviceId: 'B', deviceName: 'Flur', rule: null, slot: null, included: [], omitted: [], reason: 'noSensors' },
    ]);
    vi.mocked(api.fastRuleStage).mockResolvedValue({ staged: 3, skipped: 0, incompatible: 0 });
    const onStaged = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<FastRuleDialog deviceIds={['A', 'B']} open onOpenChange={vi.fn()} onStaged={onStaged} />);
    expect(await screen.findByText('ON AM2301#Temperature DO TelePeriod 1 ENDON')).toBeInTheDocument();
    expect(screen.getByText('wird zu Rule 1')).toBeInTheDocument();
    expect(screen.getByText('Nicht enthalten: ENERGY')).toBeInTheDocument();
    expect(screen.getByText('Keine passenden Sensoren')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Regeln vormerken' }));
    await waitFor(() => expect(api.fastRuleStage).toHaveBeenCalledWith(['A']));
    expect(onStaged).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Fehlschlag bestätigen**

Run: `pnpm --filter @tm/web exec vitest run src/features/changes/FastRuleDialog.test.tsx`
Expected: FAIL

- [ ] **Step 3: API und Dialog**

In `api.ts`:

```ts
  fastRulePreview: (deviceIds: string[]) => request<FastRulePreview[]>('fast-rule/preview', json('POST', { deviceIds })),
  fastRuleStage: (deviceIds: string[]) => request<StageResult>('fast-rule/stage', json('POST', { deviceIds })),
```

(`FastRulePreview` im Typ-Import aus `@tm/shared` ergänzen.)

`FastRuleDialog.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { useT } from '@/lib/i18n';

interface Props {
  deviceIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStaged: () => void;
}

export function FastRuleDialog({ deviceIds, open, onOpenChange, onStaged }: Props) {
  const t = useT();
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: ['fast-rule', deviceIds],
    queryFn: () => api.fastRulePreview(deviceIds),
    enabled: open,
    staleTime: 0,
  });
  const ready = (preview.data ?? []).filter((p) => p.reason === 'ok').map((p) => p.deviceId);
  const stage = useMutation({
    mutationFn: () => api.fastRuleStage(ready),
    onSuccess: (result) => {
      toast.success(t('devices.staged', { staged: result.staged }));
      void qc.invalidateQueries({ queryKey: ['changes'] });
      void qc.invalidateQueries({ queryKey: ['devices'] });
      onStaged();
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(t('common.error', { message: errorText(t, err) })),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('fastRule.title')}</DialogTitle>
          <DialogDescription>{t('fastRule.description')}</DialogDescription>
        </DialogHeader>
        {!preview.data ? (
          <p className="text-sm text-muted-foreground">{t('fastRule.loading')}</p>
        ) : (
          <ul className="space-y-3 text-sm">
            {preview.data.map((p) => (
              <li key={p.deviceId} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{p.deviceName}</span>
                  {p.reason === 'ok' && p.slot && <span className="text-xs text-muted-foreground">{t('fastRule.slot', { slot: p.slot })}</span>}
                </div>
                {p.reason === 'ok' && p.rule ? (
                  <code className="block break-all rounded bg-muted px-2 py-1 text-xs">{p.rule}</code>
                ) : (
                  <p className="text-xs text-amber-700 dark:text-amber-300">{t(`fastRule.${p.reason}` as 'fastRule.noSensors')}</p>
                )}
                {p.omitted.length > 0 && (
                  <p className="text-xs text-muted-foreground">{t('fastRule.omitted', { blocks: p.omitted.join(', ') })}</p>
                )}
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button type="button" disabled={ready.length === 0 || stage.isPending} onClick={() => stage.mutate()}>
            {t('fastRule.stage')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Einbinden**

`BatchSettingsDialog.tsx`: `const [fastRuleOpen, setFastRuleOpen] = useState(false);`, `onFastRule={() => setFastRuleOpen(true)}` an `SettingsFields`, und unter dem `Dialog`:

```tsx
      <FastRuleDialog
        deviceIds={devices.map((d) => d.id)}
        open={fastRuleOpen}
        onOpenChange={setFastRuleOpen}
        onStaged={() => setValues((v) => ({ ...v, TelePeriod: '' }))}
      />
```

(Beide Dialoge in ein Fragment `<>…</>` setzen.) `SettingsTab.tsx` analog mit `deviceIds={[device.id]}`.

- [ ] **Step 5: Wörterbücher, Tests**

Schlüssel aus der Tabelle in alle sechs Wörterbücher.
Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/web
git commit -m "feat(web): Sofort-Regel mit Vorschau pro Gerät vormerken

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Doku, Changelog, Version 0.4.0

**Files:**
- Modify: `tasmota_manager/DOCS.md`, `tasmota_manager/CHANGELOG.md`, `tasmota_manager/config.yaml`, `README.md` (Feature-Liste)

- [ ] **Step 1: DOCS.md**

Nach dem Abschnitt „Standort für Sonnenzeiten“ einfügen:

```markdown
## Einstellungen je Gerätetyp

Die App erkennt aus Status und Sensoren, ob ein Gerät Energie misst, ein Licht steuert, Relais hat oder Temperatur und Feuchte misst. Das Einstellungsformular zeigt nur die passenden Gruppen: Energiemessung (PowerDelta, Nachkommastellen), Licht (Fade, Tempo, Dimmbereich, SetOption20), Relais (SetOption0, Interlock) und Klima (Nachkommastellen, °F, Korrekturwerte). Im Batch werden Einstellungen nur bei passenden Geräten vorgemerkt; die Meldung nennt übersprungene Geräte. Korrekturwerte (TempOffset, HumOffset) lassen sich nur pro Gerät setzen.

Bei der TelePeriod warnt die App unter 60 Sekunden vor einer wachsenden Home-Assistant-Datenbank. Unter 10 Sekunden bietet sie eine Regel an, die bei jeder Sensormessung sofort sendet (`ON <Sensor>#<Wert> DO TelePeriod 1 ENDON`); die Regel kommt in einen freien Rule-Slot, belegte Slots werden nie überschrieben.

## Vorschläge aus Home Assistant

Neben einigen Feldern stehen Vorschläge aus Home Assistant: Zeitzone samt Sommerzeitregeln, ein NTP-Server für dein Land, der MQTT-Broker auf dem Home-Assistant-Host, der MQTT-Benutzer deiner übrigen Geräte und die Temperatureinheit. Ein in Home Assistant vergebener Gerätename erscheint als Namensvorschlag.
```

- [ ] **Step 2: CHANGELOG.md, Version, README**

`config.yaml`: `version: "0.4.0"`.

`CHANGELOG.md` oben:

```markdown
## 0.4.0

- Device-type specific settings: energy monitoring (PowerDelta, decimals), lights (fade, speed, dimmer range, SetOption20), relays (SetOption0, interlock) and climate sensors (decimals, °F, offsets).
- Batch edits only apply settings to devices of the matching type; the confirmation names skipped devices.
- Warning for short telemetry intervals, and a generated rule for instant updates on every sensor reading when you need faster than 10 s.
- Suggestions from Home Assistant: timezone with daylight saving rules, NTP server for your country, MQTT broker on the Home Assistant host, the MQTT user of your other devices, temperature unit, and device names you set in Home Assistant.
```

`README.md`, Abschnitt „Features“: nach dem Punkt „Batch configuration“ ergänzen:

```markdown
- **Device-type aware settings:** energy monitoring, lights, relays and climate sensors get their own settings; batch edits skip devices of another type.
- **Suggestions from Home Assistant:** timezone with daylight saving rules, NTP server, MQTT broker, temperature unit and device names.
```

- [ ] **Step 3: Gesamtprüfung**

Run: `pnpm typecheck && pnpm test && pnpm build`, danach aus der Repo-Wurzel `docker build -t tasmota-manager:dev tasmota_manager`
Expected: alles grün, Image baut.

- [ ] **Step 4: Commit**

```bash
git add DOCS.md CHANGELOG.md config.yaml ../README.md
git commit -m "docs: gerätespezifische Einstellungen und HA-Vorschläge beschreiben, Version 0.4.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Tag, Push und Release folgen dem Release-Ablauf in `CLAUDE.md` und nur auf Ansage des Nutzers.
