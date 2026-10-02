# Telemetrie-Ansicht – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live-Telemetrie mit Verlauf der letzten Stunde: Spalte „Messwerte“ mit Diagramm-Popover und Tab „Telemetrie“ in der Detailansicht.

**Architecture:** Ein `TelemetryStore` im Server sammelt Werte aus MQTT (`tele/SENSOR`, `tele/STATE`) und aus HTTP-Abfragen, klopft sie flach, vergibt Einheiten und hält pro Zahlenwert einen 60-Minuten-Ringpuffer. Zwei Endpunkte und ein WebSocket-Ereignis liefern Werte an die Oberfläche; die zeichnet Linien-Diagramme und Sparklines als SVG ohne Bibliothek.

**Tech Stack:** TypeScript strict, Fastify 5, mqtt.js, React 19, TanStack Query/Table, Tailwind 4, shadcn/ui (radix Popover vorhanden: `web/src/components/ui/popover.tsx`).

**Spec:** `docs/superpowers/specs/2026-10-02-telemetry-design.md`

## Global Constraints

- Arbeitsverzeichnis: `tasmota_manager/`. Tests: `pnpm test`, Typecheck: `pnpm typecheck`; einzelne Datei: `pnpm --filter @tm/<paket> exec vitest run <pfad>`.
- Telemetrie liest nur; nichts davon schreibt auf ein Gerät. Gelesen wird nur `Status 10` und `Status 11`.
- Verlauf: nur im Arbeitsspeicher, 60 Minuten, Punkte im Abstand von mindestens 5 s (der jeweils letzte Punkt wird bis dahin ersetzt), höchstens 720 Punkte pro Wert.
- HTTP-Auffrischung im Tab alle 10 000 ms, nur für Geräte ohne Kanal `mqtt`.
- Oberflächentexte nur über Wörterbuchschlüssel, in allen sechs Wörterbüchern (`web/src/lib/messages.ts` de/en, `web/src/lib/locales/{fr,es,it,nl}.ts`); `errors.test.ts` prüft Vollständigkeit.
- Diagramme: eine Linie 2 px in einem Farbton (`text-sky-600 dark:text-sky-400`, Linie mit `stroke="currentColor"`), Texte in Textfarben (`text-muted-foreground`), keine zweite y-Achse, Tooltip-Inhalte als React-Text (kein `dangerouslySetInnerHTML`).
- Commit-Nachrichten auf Deutsch mit Schlusszeile `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nicht pushen.

## Review Focus

- MQTT-Gerät, das SENSOR-Nachrichten im Sekundentakt schickt (Sofort-Regel): Verlauf bleibt bei höchstens 720 Punkten, ältere als 60 min fallen weg. Test in Task 1.
- Mehrkanal-Energie (`"Power":[12.1,0,3.4]`) und Werte mit Textinhalt (`"POWER":"ON"`, `"TotalStartTime":"…"`): keine Abstürze, Arrays als `.1/.2/.3`, Texte nicht im Verlauf. Test in Task 1.
- Entferntes Gerät: Telemetrie verschwindet aus Speicher und Tabelle. Test in Task 2.
- `?refresh=1` bei nicht erreichbarem HTTP-Gerät: Antwort 200 mit dem letzten Stand, kein 500. Test in Task 2.
- Diagramm mit 0 oder 1 Punkt und mit konstanter Reihe (Min = Max): kein NaN im SVG, Hinweis „Noch kein Verlauf“ bzw. flache Linie. Test in Task 3.

---

### Task 1: Telemetrie-Speicher

**Files:**
- Modify: `packages/shared/src/index.ts` (Typen)
- Create: `packages/server/src/telemetry.ts`
- Create: `packages/server/src/telemetry.test.ts`

**Interfaces:**
- Produces (shared):
  ```ts
  export interface TelemetryValue { key: string; group: string; name: string; value: number | string; unit: string | null }
  export interface DeviceTelemetry { updatedAt: string | null; values: TelemetryValue[]; history: Record<string, Array<[number, number]>> }
  export type TelemetrySummary = Record<string, TelemetryValue[]>;
  ```
  und im `WsMessage`-Union: `| { type: 'telemetry'; deviceId: string; updatedAt: string; headline: TelemetryValue[] }`
- Produces (server): `class TelemetryStore extends EventEmitter<{ updated: [deviceId: string] }>` mit
  - `constructor(now: () => number = Date.now)`
  - `record(deviceId: string, source: 'sensor' | 'state', payload: unknown): void`
  - `get(deviceId: string): DeviceTelemetry`
  - `headline(deviceId: string): TelemetryValue[]`
  - `summary(): TelemetrySummary`
  - `remove(deviceId: string): void`

- [ ] **Step 1: Typen in `shared/src/index.ts`** (nach `HaSuggestions`) wie oben ergänzen, `WsMessage` erweitern.

- [ ] **Step 2: Failing tests** – `packages/server/src/telemetry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TelemetryStore } from './telemetry';

const SENSOR = {
  Time: '2026-10-02T12:00:00',
  AM2301: { Temperature: 21.3, Humidity: 48.2, DewPoint: 9.9 },
  ENERGY: { TotalStartTime: '2026-01-01T00:00:00', Total: 12.5, Power: [12.1, 0, 3.4], Voltage: 230 },
  ESP32: { Temperature: 44 },
  TempUnit: 'C',
};
const STATE = { Time: 'x', UptimeSec: 3600, Heap: 25, LoadAvg: 19, POWER: 'ON', Wifi: { RSSI: 80, Signal: -60, SSId: 'iot' } };

function store(start = 1_000_000) {
  let t = start;
  const s = new TelemetryStore(() => t);
  return { s, advance: (ms: number) => (t += ms) };
}

describe('TelemetryStore', () => {
  it('klopft SENSOR flach, vergibt Einheiten und lässt Chip-Temperatur und Zeitfelder weg', () => {
    const { s } = store();
    s.record('A', 'sensor', SENSOR);
    const byKey = Object.fromEntries(s.get('A').values.map((v) => [v.key, v]));
    expect(byKey['AM2301.Temperature']).toEqual({ key: 'AM2301.Temperature', group: 'AM2301', name: 'Temperature', value: 21.3, unit: '°C' });
    expect(byKey['AM2301.Humidity']?.unit).toBe('%');
    expect(byKey['ENERGY.Power.1']).toMatchObject({ value: 12.1, unit: 'W', name: 'Power 1' });
    expect(byKey['ENERGY.Power.3']).toMatchObject({ value: 3.4 });
    expect(byKey['ENERGY.Total']?.unit).toBe('kWh');
    expect(byKey['ENERGY.TotalStartTime']).toBeUndefined();
    expect(byKey['ESP32.Temperature']).toBeUndefined();
    expect(byKey.Time).toBeUndefined();
  });

  it('übernimmt STATE in die Gruppe „device“, Schaltzustände als Text ohne Verlauf', () => {
    const { s } = store();
    s.record('A', 'state', STATE);
    const t = s.get('A');
    const byKey = Object.fromEntries(t.values.map((v) => [v.key, v]));
    expect(byKey.UptimeSec).toMatchObject({ group: 'device', value: 3600, unit: 's' });
    expect(byKey['Wifi.Signal']).toMatchObject({ group: 'device', value: -60, unit: 'dBm' });
    expect(byKey['Wifi.RSSI']?.unit).toBe('%');
    expect(byKey.POWER).toMatchObject({ value: 'ON', unit: null });
    expect(byKey['Wifi.SSId']).toBeUndefined();
    expect(t.history.POWER).toBeUndefined();
  });

  it('nimmt Status-10/11-Antworten mit Hülle an', () => {
    const { s } = store();
    s.record('A', 'sensor', { StatusSNS: SENSOR });
    s.record('A', 'state', { StatusSTS: STATE });
    expect(s.get('A').values.some((v) => v.key === 'AM2301.Temperature')).toBe(true);
    expect(s.get('A').values.some((v) => v.key === 'UptimeSec')).toBe(true);
  });

  it('führt einen Verlauf: höchstens ein Punkt je 5 s, 60 Minuten, höchstens 720 Punkte', () => {
    const { s, advance } = store();
    s.record('A', 'sensor', { AM2301: { Temperature: 20 } });
    advance(2000);
    s.record('A', 'sensor', { AM2301: { Temperature: 21 } });
    advance(2000);
    s.record('A', 'sensor', { AM2301: { Temperature: 22 } });
    // Innerhalb von 5 s nach dem vorletzten Punkt ersetzt ein neuer Wert den letzten.
    expect(s.get('A').history['AM2301.Temperature']).toEqual([
      [1_000_000, 20],
      [1_004_000, 22],
    ]);
    for (let i = 0; i < 2000; i++) {
      advance(1000);
      s.record('A', 'sensor', { AM2301: { Temperature: i } });
    }
    const points = s.get('A').history['AM2301.Temperature'] ?? [];
    expect(points.length).toBeLessThanOrEqual(720);
    const newest = points.at(-1)?.[0] ?? 0;
    expect(points.every(([t]) => newest - t <= 60 * 60 * 1000)).toBe(true);
  });

  it('wählt bis zu zwei Hauptwerte in fester Rangfolge, nie aus „device“', () => {
    const { s } = store();
    s.record('A', 'sensor', SENSOR);
    s.record('A', 'state', STATE);
    expect(s.headline('A').map((v) => v.key)).toEqual(['ENERGY.Power.1', 'AM2301.Temperature']);
    s.record('B', 'state', STATE);
    expect(s.headline('B')).toEqual([]);
    s.record('C', 'sensor', { VL53L0X: { Distance: 120 } });
    expect(s.headline('C').map((v) => v.key)).toEqual(['VL53L0X.Distance']);
    expect(s.summary()).toMatchObject({ C: [{ key: 'VL53L0X.Distance', unit: 'mm' }] });
  });

  it('meldet Aktualisierungen und vergisst entfernte Geräte', () => {
    const { s } = store();
    const seen: string[] = [];
    s.on('updated', (id) => seen.push(id));
    s.record('A', 'sensor', { AM2301: { Temperature: 20 } });
    s.record('A', 'sensor', 'kaputt');
    expect(seen).toEqual(['A']);
    expect(s.get('A').updatedAt).toBe(new Date(1_000_000).toISOString());
    s.remove('A');
    expect(s.get('A')).toEqual({ updatedAt: null, values: [], history: {} });
  });
});
```

- [ ] **Step 3: Fehlschlag bestätigen** – `pnpm --filter @tm/server exec vitest run src/telemetry.test.ts` → FAIL (Modul fehlt).

- [ ] **Step 4: Implementierung** – `packages/server/src/telemetry.ts`:

```ts
import { EventEmitter } from 'node:events';
import type { DeviceTelemetry, TelemetrySummary, TelemetryValue } from '@tm/shared';
import { isObj } from './tasmota/parse';

const HOUR_MS = 60 * 60 * 1000;
const MIN_STEP_MS = 5000;
const MAX_POINTS = 720;
const SKIPPED = new Set(['Time', 'TempUnit', 'PressureUnit', 'SpeedUnit']);
const STATE_NUMBERS = new Set(['UptimeSec', 'Heap', 'LoadAvg', 'Sleep']);

const FIXED_UNITS: Record<string, string> = {
  Humidity: '%',
  Power: 'W',
  ApparentPower: 'VA',
  ReactivePower: 'var',
  Voltage: 'V',
  Current: 'A',
  Total: 'kWh',
  Today: 'kWh',
  Yesterday: 'kWh',
  Frequency: 'Hz',
  Illuminance: 'lx',
  Distance: 'mm',
  CO2: 'ppm',
  eCO2: 'ppm',
  TVOC: 'ppb',
  UptimeSec: 's',
  Heap: 'kB',
};

interface DeviceData {
  updatedAt: number | null;
  values: Map<string, TelemetryValue>;
  history: Map<string, Array<[number, number]>>;
  units: { temp: string; pressure: string };
}

function unitFor(key: string, name: string, units: DeviceData['units']): string | null {
  if (key === 'Wifi.Signal') return 'dBm';
  if (key === 'Wifi.RSSI') return '%';
  if (name === 'Temperature' || name === 'DewPoint') return `°${units.temp}`;
  if (name === 'Pressure' || name === 'SeaPressure') return units.pressure;
  return FIXED_UNITS[name] ?? null;
}

/** Telemetrie aller Geräte im Arbeitsspeicher: letzte Werte und Verlauf der letzten Stunde. */
export class TelemetryStore extends EventEmitter<{ updated: [deviceId: string] }> {
  private readonly devices = new Map<string, DeviceData>();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  record(deviceId: string, source: 'sensor' | 'state', payload: unknown): void {
    if (!isObj(payload)) return;
    const body = source === 'sensor' ? (isObj(payload.StatusSNS) ? payload.StatusSNS : payload) : isObj(payload.StatusSTS) ? payload.StatusSTS : payload;
    const data = this.data(deviceId);
    if (typeof body.TempUnit === 'string') data.units.temp = body.TempUnit;
    if (typeof body.PressureUnit === 'string') data.units.pressure = body.PressureUnit;
    const at = this.now();
    const found = source === 'sensor' ? this.flattenSensor(body) : this.flattenState(body);
    if (found.length === 0) return;
    for (const { key, group, name, value } of found) {
      data.values.set(key, { key, group, name, value, unit: typeof value === 'number' ? unitFor(key, name.replace(/ \d+$/, ''), data.units) : null });
      if (typeof value === 'number') this.push(data, key, at, value);
    }
    data.updatedAt = at;
    this.emit('updated', deviceId);
  }

  get(deviceId: string): DeviceTelemetry {
    const data = this.devices.get(deviceId);
    if (!data) return { updatedAt: null, values: [], history: {} };
    return {
      updatedAt: data.updatedAt === null ? null : new Date(data.updatedAt).toISOString(),
      values: [...data.values.values()],
      history: Object.fromEntries([...data.history.entries()].map(([k, v]) => [k, [...v]])),
    };
  }

  headline(deviceId: string): TelemetryValue[] {
    const values = [...(this.devices.get(deviceId)?.values.values() ?? [])].filter(
      (v): v is TelemetryValue & { value: number } => v.group !== 'device' && typeof v.value === 'number',
    );
    const picks: TelemetryValue[] = [];
    const take = (match: (v: TelemetryValue) => boolean) => {
      const found = values.find((v) => match(v) && !picks.includes(v));
      if (found && picks.length < 2) picks.push(found);
    };
    take((v) => v.group === 'ENERGY' && v.name.startsWith('Power') && (v.key === 'ENERGY.Power' || v.key === 'ENERGY.Power.1'));
    take((v) => v.name === 'Temperature');
    take((v) => v.name === 'Humidity');
    take(() => true);
    return picks;
  }

  summary(): TelemetrySummary {
    return Object.fromEntries([...this.devices.keys()].map((id) => [id, this.headline(id)]).filter(([, v]) => v.length > 0));
  }

  remove(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  private data(deviceId: string): DeviceData {
    let data = this.devices.get(deviceId);
    if (!data) {
      data = { updatedAt: null, values: new Map(), history: new Map(), units: { temp: 'C', pressure: 'hPa' } };
      this.devices.set(deviceId, data);
    }
    return data;
  }

  private push(data: DeviceData, key: string, at: number, value: number): void {
    const points = data.history.get(key) ?? [];
    // Der letzte Punkt ist „live“: Er wird ersetzt, bis 5 s seit dem vorletzten vergangen sind.
    const previous = points.at(-2);
    if (previous && at - previous[0] < MIN_STEP_MS) points[points.length - 1] = [at, value];
    else points.push([at, value]);
    while (points.length > 0 && (at - (points[0]?.[0] ?? at) > HOUR_MS || points.length > MAX_POINTS)) points.shift();
    data.history.set(key, points);
  }

  private flattenSensor(body: Record<string, unknown>) {
    const out: Array<{ key: string; group: string; name: string; value: number | string }> = [];
    for (const [block, fields] of Object.entries(body)) {
      if (SKIPPED.has(block) || /^ESP32/i.test(block) || !isObj(fields)) continue;
      for (const [name, value] of Object.entries(fields)) {
        if (typeof value === 'number') out.push({ key: `${block}.${name}`, group: block, name, value });
        else if (Array.isArray(value)) {
          value.forEach((v, i) => {
            if (typeof v === 'number') out.push({ key: `${block}.${name}.${i + 1}`, group: block, name: `${name} ${i + 1}`, value: v });
          });
        }
      }
    }
    return out;
  }

  private flattenState(body: Record<string, unknown>) {
    const out: Array<{ key: string; group: string; name: string; value: number | string }> = [];
    for (const [name, value] of Object.entries(body)) {
      if (STATE_NUMBERS.has(name) && typeof value === 'number') out.push({ key: name, group: 'device', name, value });
      else if (/^POWER\d*$/.test(name) && typeof value === 'string') out.push({ key: name, group: 'device', name, value });
    }
    const wifi = body.Wifi;
    if (isObj(wifi)) {
      for (const name of ['Signal', 'RSSI']) {
        const value = wifi[name];
        if (typeof value === 'number') out.push({ key: `Wifi.${name}`, group: 'device', name: `Wifi ${name}`, value });
      }
    }
    return out;
  }
}
```

Hinweis: In `record` wird der Einheiten-Name ohne angehängte Kanalnummer gesucht (`'Power 1'` → `'Power'`). `Wifi Signal`/`Wifi RSSI` laufen über die Sonderfälle mit dem Schlüssel.

- [ ] **Step 5: Tests** – `pnpm --filter @tm/server exec vitest run src/telemetry.test.ts` → PASS; danach `pnpm typecheck` (die Web-Seite kompiliert mit dem erweiterten `WsMessage`; ein `switch` in `web/src/lib/live.ts` ohne `telemetry`-Fall ist erlaubt, Task 4 ergänzt ihn).

- [ ] **Step 6: Commit** `feat(server): Telemetrie-Speicher mit Einheiten und Verlauf der letzten Stunde`

---

### Task 2: Quellen, Endpunkte und Live-Ereignis

**Files:**
- Modify: `packages/server/src/transport/mqtt.ts` (Ereignis `sensor`)
- Modify: `packages/server/src/discovery/mqttDiscovery.ts`, `packages/server/src/discovery/identify.ts`, `packages/server/src/discovery/poller.ts`
- Modify: `packages/server/src/api/app.ts` (`AppDeps.telemetry`), `packages/server/src/api/devices.ts`, `packages/server/src/api/hub.ts`, `packages/server/src/server.ts`, `packages/server/test/appSetup.ts`
- Test: `packages/server/src/transport/mqtt.test.ts`, `packages/server/src/discovery/mqttDiscovery.test.ts`, `packages/server/src/api/app.test.ts` (oder eine neue `api/telemetry.test.ts`)

**Interfaces:**
- Consumes: `TelemetryStore` (Task 1).
- Produces: `GET /api/devices/:id/telemetry[?refresh=1]` → `DeviceTelemetry` (404 für unbekannte Geräte); `GET /api/telemetry` → `TelemetrySummary`; WS `{ type: 'telemetry', deviceId, updatedAt, headline }`.

- [ ] **Step 1: Failing tests**
  - `mqtt.test.ts`: Ein Fake veröffentlicht `tele/<topic>/SENSOR` mit `{"AM2301":{"Temperature":21}}` → der Transport meldet `sensor` mit Topic und Nutzlast. (Für das Fake-Gerät eine Methode `publishSensor()` neben `publishState()` anlegen, die `tele/<topic>/SENSOR` mit `this.opts.sensors` veröffentlicht.)
  - `mqttDiscovery.test.ts`: Mit einem `TelemetryStore` im Konstruktor (neuer optionaler vierter Parameter) landen `publishState()` und `publishSensor()` im Speicher (`telemetry.get(MAC).values` enthält `UptimeSec` und den Sensorwert).
  - API-Test (über `setupApp`):
    1. Nach dem Anlegen des HTTP-Fakes mit `sensors: { AM2301: { Temperature: 21 } }` liefert `GET /api/devices/<MAC>/telemetry?refresh=1` einen Wert `AM2301.Temperature` mit 21.
    2. `GET /api/telemetry` enthält `{ [MAC]: [{ key: 'AM2301.Temperature' }] }`.
    3. Nach `await fake.stop()` liefert `?refresh=1` weiter 200 mit dem letzten Stand.
    4. `DELETE /api/devices/<MAC>` → `GET /api/telemetry` enthält das Gerät nicht mehr.
    5. Unbekanntes Gerät → 404.
  - Hub: Ein `telemetry.record(...)` erzeugt ein WS-Ereignis `telemetry` mit `headline` (am Muster der vorhandenen Hub-Tests).

- [ ] **Step 2: Fehlschlag bestätigen.**

- [ ] **Step 3: Implementierung**
  - `mqtt.ts`: `MqttEvents` um `sensor: [topic: string, payload: unknown]` ergänzen; in `onMessage` im `tele`-Zweig `else if (suffix === 'SENSOR') this.emit('sensor', watch.topic, safeJson(text));`.
  - `mqttDiscovery.ts`: Konstruktor `(mqtt, registry, log, telemetry?: TelemetryStore)`. Im `state`-Handler zusätzlich `this.telemetry?.record(device.id, 'state', payload)`; neuer Handler `mqtt.on('sensor', (topic, payload) => { const device = registry.findByTopic(topic); if (device) telemetry?.record(device.id, 'sensor', payload); })`.
  - `identify.ts`: optionaler letzter Parameter `telemetry?: TelemetryStore`; nach erfolgreichem `upsert` `telemetry?.record(device.id, 'state', payload)` (Status 0 enthält `StatusSTS`) und, falls vorhanden, `telemetry?.record(device.id, 'sensor', sensors)`. `poller.ts`: `PollerDeps.telemetry?: TelemetryStore` und an `identifyHost` durchreichen.
  - `api/devices.ts`:
    ```ts
    app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>('/api/devices/:id/telemetry', async (req, reply) => {
      const device = registry.get(req.params.id);
      if (!device) return reply.code(404).send(notFound());
      if (req.query.refresh === '1' && !device.channels.includes('mqtt')) {
        // Nur lesen; ein nicht erreichbares Gerät liefert den letzten Stand.
        for (const [command, source] of [['Status 10', 'sensor'], ['Status 11', 'state']] as const) {
          try {
            deps.telemetry?.record(device.id, source, (await gateway.send(device.id, command)).response);
          } catch {
            // letzter Stand bleibt
          }
        }
      }
      return deps.telemetry?.get(device.id) ?? { updatedAt: null, values: [], history: {} };
    });
    app.get('/api/telemetry', async () => deps.telemetry?.summary() ?? {});
    ```
    (`deps` ist der `AppDeps`-Parameter der Routen-Funktion; Name an die Datei anpassen.)
  - `AppDeps.telemetry?: TelemetryStore`; `appSetup.ts` legt einen `TelemetryStore` an, reicht ihn an `buildApp` und `wireLiveEvents` und gibt ihn zurück.
  - `hub.ts`/`wireLiveEvents`: Parameter `telemetry?: TelemetryStore`;
    ```ts
    deps.telemetry?.on('updated', (deviceId) => {
      const t = deps.telemetry?.get(deviceId);
      hub.broadcast({ type: 'telemetry', deviceId, updatedAt: t?.updatedAt ?? new Date().toISOString(), headline: deps.telemetry?.headline(deviceId) ?? [] });
    });
    deps.registry.on('removed', (id) => deps.telemetry?.remove(id));
    ```
  - `server.ts`: einen `TelemetryStore` anlegen und an `MqttDiscovery`, `HttpPoller`, `buildApp` und `wireLiveEvents` geben.

- [ ] **Step 4: Tests** – betroffene Dateien, dann `pnpm typecheck && pnpm test`.

- [ ] **Step 5: Commit** `feat(server): Telemetrie aus MQTT und HTTP sammeln, Endpunkte und Live-Ereignis`

---

### Task 3: Diagramm-Komponenten

**Files:**
- Create: `packages/web/src/features/telemetry/charts.tsx`
- Create: `packages/web/src/features/telemetry/charts.test.tsx`
- Modify: Wörterbücher (6)

**Interfaces:**
- Produces:
  - `formatTelemetry(value: number | string, unit: string | null, lang: string): string` – Zahlen mit `Intl.NumberFormat(lang, { maximumFractionDigits: 2 })`, Einheit mit Leerzeichen (außer `%` und `°…` direkt angehängt: `48 %` → deutsch üblich mit Leerzeichen; einheitlich: immer ein schmales Leerzeichen `\u202F`).
  - `Sparkline({ points }: { points: Array<[number, number]> })` – 80×20 SVG, ab 2 Punkten, sonst `null`.
  - `HistoryChart({ points, unit, label }: { points: Array<[number, number]>; unit: string | null; label: string })` – Diagramm der letzten Stunde.
  - `useLang(): string` aus `@/lib/i18n` (neu exportieren: liefert die aktive Sprache aus dem Kontext), falls noch nicht vorhanden.

Neue Wörterbuchschlüssel:

| Schlüssel | de | en |
|---|---|---|
| `telemetry.noHistory` | Noch kein Verlauf | No history yet |
| `telemetry.minutesAgo` | −60 min | −60 min |
| `telemetry.now` | jetzt | now |
| `telemetry.min` | Min | Min |
| `telemetry.max` | Max | Max |
| `telemetry.current` | Aktuell | Current |

- [ ] **Step 1: Failing tests** (`charts.test.tsx`):

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { HistoryChart, Sparkline, formatTelemetry } from './charts';

const pts = (values: number[]): Array<[number, number]> => values.map((v, i) => [1_000_000 + i * 60_000, v]);

describe('formatTelemetry', () => {
  it('formatiert Zahlen in der Sprache mit Einheit', () => {
    expect(formatTelemetry(21.346, '°C', 'de')).toBe('21,35\u202F°C');
    expect(formatTelemetry(12, 'W', 'en')).toBe('12\u202FW');
    expect(formatTelemetry('ON', null, 'de')).toBe('ON');
  });
});

describe('Sparkline', () => {
  it('zeichnet erst ab zwei Punkten, ohne NaN bei konstanter Reihe', () => {
    const { container, rerender } = render(<Sparkline points={pts([5])} />);
    expect(container.querySelector('svg')).toBeNull();
    rerender(<Sparkline points={pts([5, 5, 5])} />);
    expect(container.querySelector('polyline')?.getAttribute('points')).not.toMatch(/NaN/);
  });
});

describe('HistoryChart', () => {
  it('zeigt Min, Max und aktuellen Wert und einen Tooltip am nächsten Punkt', () => {
    renderWithProviders(<HistoryChart points={pts([10, 30, 20])} unit="W" label="Power" />);
    expect(screen.getByText('Min')).toBeInTheDocument();
    expect(screen.getByText('10\u202FW')).toBeInTheDocument();
    expect(screen.getByText('30\u202FW')).toBeInTheDocument();
    const plot = screen.getByRole('img', { name: 'Power' });
    fireEvent.pointerMove(plot, { clientX: 0, clientY: 10 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('10\u202FW');
  });

  it('zeigt ohne Verlauf einen Hinweis statt einer Linie', () => {
    renderWithProviders(<HistoryChart points={pts([10])} unit="W" label="Power" />);
    expect(screen.getByText('Noch kein Verlauf')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Fehlschlag bestätigen.**

- [ ] **Step 3: Implementierung** – `charts.tsx`:

```tsx
import { type PointerEvent, useMemo, useRef, useState } from 'react';
import { useLang, useT } from '@/lib/i18n';

type Points = Array<[number, number]>;
const NARROW = '\u202F';

export function formatTelemetry(value: number | string, unit: string | null, lang: string): string {
  if (typeof value === 'string') return value;
  const text = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 }).format(value);
  return unit ? `${text}${NARROW}${unit}` : text;
}

function scale(points: Points, width: number, height: number, pad: number) {
  const ts = points.map(([t]) => t);
  const vs = points.map(([, v]) => v);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const v0 = Math.min(...vs);
  const v1 = Math.max(...vs);
  const x = (t: number) => (t1 === t0 ? width / 2 : pad + ((t - t0) / (t1 - t0)) * (width - 2 * pad));
  // Konstante Reihe: mittig zeichnen statt durch 0 zu teilen.
  const y = (v: number) => (v1 === v0 ? height / 2 : height - pad - ((v - v0) / (v1 - v0)) * (height - 2 * pad));
  return { x, y, v0, v1 };
}

export function Sparkline({ points }: { points: Points }) {
  if (points.length < 2) return null;
  const { x, y } = scale(points, 80, 20, 2);
  return (
    <svg width={80} height={20} viewBox="0 0 80 20" aria-hidden className="text-sky-600 dark:text-sky-400">
      <polyline fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" points={points.map(([t, v]) => `${x(t)},${y(v)}`).join(' ')} />
    </svg>
  );
}

export function HistoryChart({ points, unit, label }: { points: Points; unit: string | null; label: string }) {
  const t = useT();
  const lang = useLang();
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 320;
  const H = 140;
  const PAD = 8;
  const s = useMemo(() => (points.length >= 2 ? scale(points, W, H, PAD) : null), [points]);
  const fmt = (v: number) => formatTelemetry(v, unit, lang);
  if (!s) return <p className="text-sm text-muted-foreground">{t('telemetry.noHistory')}</p>;
  const values = points.map(([, v]) => v);
  const last = points.at(-1) as [number, number];

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = ref.current?.getBoundingClientRect();
    const px = box && box.width > 0 ? ((e.clientX - box.left) / box.width) * W : 0;
    let best = 0;
    points.forEach(([pt], i) => {
      if (Math.abs(s.x(pt) - px) < Math.abs(s.x(points[best]?.[0] ?? 0) - px)) best = i;
    });
    setHover(best);
  };
  const hovered = hover === null ? null : points[hover];

  return (
    <div className="w-[min(22rem,80vw)] space-y-1">
      <div className="relative">
        <svg
          ref={ref}
          role="img"
          aria-label={label}
          viewBox={`0 0 ${W} ${H}`}
          className="h-36 w-full touch-none text-sky-600 dark:text-sky-400"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <line x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} className="stroke-border" strokeWidth={1} />
          <polyline fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" points={points.map(([pt, v]) => `${s.x(pt)},${s.y(v)}`).join(' ')} />
          {hovered && (
            <>
              <line x1={s.x(hovered[0])} x2={s.x(hovered[0])} y1={PAD} y2={H - PAD} className="stroke-muted-foreground" strokeWidth={1} />
              <circle cx={s.x(hovered[0])} cy={s.y(hovered[1])} r={4} fill="currentColor" className="stroke-background" strokeWidth={2} />
            </>
          )}
        </svg>
        {hovered && (
          <div role="tooltip" className="pointer-events-none absolute top-0 right-0 rounded border bg-popover px-2 py-1 text-xs text-popover-foreground shadow">
            {new Date(hovered[0]).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · {fmt(hovered[1])}
          </div>
        )}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{t('telemetry.minutesAgo')}</span>
        <span>{t('telemetry.now')}</span>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        {(
          [
            ['telemetry.min', Math.min(...values)],
            ['telemetry.max', Math.max(...values)],
            ['telemetry.current', last[1]],
          ] as const
        ).map(([key, v]) => (
          <div key={key}>
            <dt className="text-muted-foreground">{t(key)}</dt>
            <dd className="font-medium">{fmt(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
```

`useLang` in `web/src/lib/i18n.tsx` ergänzen, falls nicht vorhanden: `export function useLang(): Lang { return useContext(I18nContext); }`.

- [ ] **Step 4: Wörterbücher** (6) mit den Schlüsseln oben; `pnpm --filter @tm/web exec vitest run src/features/telemetry/charts.test.tsx` → PASS; `pnpm typecheck && pnpm test`.

- [ ] **Step 5: Commit** `feat(web): Verlaufsdiagramm und Sparkline für Telemetrie`

---

### Task 4: Spalte „Messwerte“ mit Diagramm-Popover

**Files:**
- Create: `packages/web/src/features/telemetry/TelemetryCell.tsx`, `packages/web/src/features/telemetry/TelemetryCell.test.tsx`
- Modify: `packages/web/src/lib/api.ts` (`telemetry(id, refresh?)`, `telemetrySummary()`), `packages/web/src/lib/live.ts` (Fall `telemetry`), `packages/web/src/features/devices/columns.tsx`, Wörterbücher (6)

**Interfaces:**
- Consumes: `GET /api/telemetry`, `GET /api/devices/:id/telemetry` (Task 2), `HistoryChart`, `formatTelemetry`, `useLang` (Task 3).
- Produces: `useTelemetrySummary()` (Query `['telemetry-summary']`), `TelemetryCell({ deviceId })`.

Neue Schlüssel: `devices.col.telemetry` – de „Messwerte“, en „Readings“.

- [ ] **Step 1: Failing test** (`TelemetryCell.test.tsx`): Mit gemocktem `api.telemetrySummary` → `{ A: [{ key: 'ENERGY.Power', group: 'ENERGY', name: 'Power', value: 12.3, unit: 'W' }] }` und `api.telemetry` → `{ updatedAt: '…', values: [], history: { 'ENERGY.Power': [[1, 10], [2, 12.3]] } }`:
  - Die Zelle zeigt den Button `12,3 W` (mit schmalem Leerzeichen).
  - Ein Klick öffnet das Popover mit dem Diagramm (`role="img"` mit Name `Power`), ohne dass ein umgebender `onClick` (Zeile) ausgelöst wird.
  - Ein Gerät ohne Werte zeigt `—`.

- [ ] **Step 2: Fehlschlag bestätigen.**

- [ ] **Step 3: Implementierung**
  - `api.ts`:
    ```ts
    telemetry: (id: string, refresh = false) => request<DeviceTelemetry>(`${deviceUrl(id)}/telemetry${refresh ? '?refresh=1' : ''}`),
    telemetrySummary: () => request<TelemetrySummary>('telemetry'),
    ```
  - `live.ts`, neuer Fall:
    ```ts
    case 'telemetry':
      qc.setQueryData<TelemetrySummary>(['telemetry-summary'], (s) => ({ ...(s ?? {}), [msg.deviceId]: msg.headline }));
      void qc.invalidateQueries({ queryKey: ['telemetry', msg.deviceId] });
      break;
    ```
  - `TelemetryCell.tsx`: liest `useQuery({ queryKey: ['telemetry-summary'], queryFn: api.telemetrySummary })`; für jeden Hauptwert ein `Popover` mit einem Button (`formatTelemetry`, `onClick` stoppt die Ausbreitung) und im Inhalt `ChartFor({ deviceId, value })`, das `useQuery({ queryKey: ['telemetry', deviceId], queryFn: () => api.telemetry(deviceId) })` lädt und `HistoryChart` mit `history[value.key] ?? []`, `unit`, `label = value.name` zeigt. Werte durch ` · ` getrennt. Ohne Werte `—`.
  - `columns.tsx`: Spalte nach `power`:
    ```ts
    { id: 'telemetry', header: t('devices.col.telemetry'), enableSorting: false, cell: ({ row }) => <TelemetryCell deviceId={row.original.id} /> },
    ```

- [ ] **Step 4: Wörterbücher, Tests** – `pnpm typecheck && pnpm test`.

- [ ] **Step 5: Commit** `feat(web): Spalte „Messwerte“ mit Verlaufsdiagramm`

---

### Task 5: Tab „Telemetrie“

**Files:**
- Create: `packages/web/src/features/telemetry/TelemetryTab.tsx`, `packages/web/src/features/telemetry/TelemetryTab.test.tsx`
- Modify: `packages/web/src/features/devices/DeviceSheet.tsx` (Tab), Wörterbücher (6)

**Interfaces:**
- Consumes: `api.telemetry(id, refresh)`, `Sparkline`, `HistoryChart`, `formatTelemetry`, `useLang`.
- Produces: `TelemetryTab({ device }: { device: Device })`.

Neue Schlüssel:

| Schlüssel | de | en |
|---|---|---|
| `detail.tab.telemetry` | Telemetrie | Telemetry |
| `telemetry.updated` | zuletzt aktualisiert vor {seconds} s | last updated {seconds} s ago |
| `telemetry.offline` | offline – letzte bekannte Werte | offline – last known values |
| `telemetry.empty` | Noch keine Telemetrie empfangen | No telemetry received yet |
| `telemetry.device` | Gerät | Device |

- [ ] **Step 1: Failing test** (`TelemetryTab.test.tsx`), `api.telemetry` gemockt:
  1. Gruppen werden als Überschriften gezeigt (`AM2301`, `Gerät`), mit Werten samt Einheit (`21,3 °C`).
  2. Ein Klick auf einen Wert öffnet das Diagramm (`role="img"`).
  3. Ein Gerät ohne Kanal `mqtt` ruft `api.telemetry(id, true)` auf, eines mit `mqtt` `api.telemetry(id, false)`.
  4. `online: false` zeigt den Offline-Hinweis.
  5. Keine Werte zeigen „Noch keine Telemetrie empfangen“.

- [ ] **Step 2: Fehlschlag bestätigen.**

- [ ] **Step 3: Implementierung**
  - `useQuery({ queryKey: ['telemetry', device.id], queryFn: () => api.telemetry(device.id, httpOnly), refetchInterval: httpOnly ? 10_000 : false })` mit `httpOnly = !device.channels.includes('mqtt')`.
  - Gruppen in Reihenfolge des ersten Auftretens, `device` immer zuletzt und als `t('telemetry.device')` beschriftet.
  - Je Wert eine Zeile: Name, `Popover` mit Button (`formatTelemetry`) und `HistoryChart`, rechts `Sparkline` aus `history[key]`.
  - Kopfzeile: `telemetry.updated` mit Sekunden seit `updatedAt` (einmal pro Sekunde neu berechnet über `useEffect`-Intervall), bei `!device.online` zusätzlich `telemetry.offline`.
  - `DeviceSheet.tsx`: `TabsTrigger value="telemetry"` nach „Info“ und `TabsContent value="telemetry"` mit `<TelemetryTab device={device} />`.

- [ ] **Step 4: Wörterbücher, Tests** – `pnpm typecheck && pnpm test`.

- [ ] **Step 5: Commit** `feat(web): Tab „Telemetrie“ mit Live-Werten und Verlauf`

---

### Task 6: Doku und Changelog

**Files:** `tasmota_manager/DOCS.md`, `tasmota_manager/CHANGELOG.md`, `README.md`

- [ ] **Step 1:** `CHANGELOG.md`, Abschnitt `## 0.5.0` (existiert schon) am Anfang ergänzen:

```markdown
- Telemetry: a new "Readings" column shows each device's main values (power, temperature, humidity), and a click opens a chart of the last hour. The new "Telemetry" tab in the device details shows all sensor and device values live, with sparklines. History is kept in memory for one hour and starts empty after an app restart.
```

- [ ] **Step 2:** `DOCS.md`, neuer Abschnitt vor „## Geräte aufräumen“:

```markdown
## Telemetrie

Die Spalte **Messwerte** zeigt je Gerät bis zu zwei Hauptwerte (Leistung, Temperatur, Feuchte); ein Klick öffnet den Verlauf der letzten Stunde. Der Tab **Telemetrie** in der Detailansicht zeigt alle Sensor- und Gerätewerte live. MQTT-Geräte liefern Werte bei jeder Telemetrie-Nachricht, reine HTTP-Geräte im Abfrageintervall und alle 10 Sekunden, solange der Tab offen ist. Der Verlauf liegt nur im Arbeitsspeicher der App und beginnt nach einem Neustart leer; längere Verläufe bietet Home Assistant.
```

- [ ] **Step 3:** `README.md`, Feature-Liste nach „Switch column“:

```markdown
- **Telemetry:** a readings column with a one-hour chart per value, and a live telemetry tab in the device details.
```

- [ ] **Step 4:** `pnpm typecheck && pnpm test && pnpm build`; aus der Repo-Wurzel `docker build -t tasmota-manager:dev tasmota_manager`.

- [ ] **Step 5: Commit** `docs: Telemetrie beschreiben`
