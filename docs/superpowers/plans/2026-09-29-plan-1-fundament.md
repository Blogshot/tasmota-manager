# Tasmota Manager – Plan 1: Fundament + Geräteübersicht

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eine installierbare Home Assistant App, die Tasmota-Geräte per MQTT und HTTP findet, im Inventar hält, live in einer modernen Tabelle anzeigt und Einzelbefehle über eine Konsole sendet.

**Architecture:** Ein pnpm-Monorepo im App-Ordner `tasmota_manager/` mit drei Paketen: `shared` (zod-Schemas und Typen), `server` (Fastify, mqtt.js, SQLite über Drizzle) und `web` (React + shadcn/ui). Im Server liefern zwei Transports (MQTT, HTTP) dieselbe `send()`-Schnittstelle, und ein `DeviceGateway` wählt pro Gerät den Kanal. Discovery-Komponenten füllen die `DeviceRegistry`, deren Events per WebSocket an die UI gehen.

**Tech Stack:** Node 22, pnpm 10, TypeScript 5.9, Fastify 5, @fastify/websocket 11, @fastify/static 10, mqtt 5, better-sqlite3 13, drizzle-orm 0.45 / drizzle-kit 0.31, zod 4, pino 10, esbuild 0.28, Vitest 5, Aedes 1 (Test-Broker), React 19, Vite 8, Tailwind 4, shadcn/ui (radix, Preset nova), TanStack Table 8, TanStack Query 5.

**Spec:** `docs/superpowers/specs/2026-09-29-tasmota-manager-design.md`

**Folgepläne (nicht Teil dieses Plans):** Plan 2 umfasst Job-Engine, Batch-Befehle und Vorlagen, Plan 3 OTA, Backups, den Playwright-Smoke-Test und Multi-Arch-Release-Builds.

## Global Constraints

- Alle Befehle laufen im Ordner `tasmota_manager/`, sofern nicht anders angegeben. Git-Befehle funktionieren von dort aus, weil das Repository eine Ebene höher liegt.
- Node 22 (`>=22.12`), pnpm 10, TypeScript 5.9 `strict`, ESM (`"type": "module"`), `moduleResolution: Bundler`, Imports ohne Dateiendung.
- Bezeichner auf Englisch, Code-Kommentare sparsam und auf Deutsch, Testnamen auf Deutsch.
- Passwörter sind write-only: Sie erscheinen nie in API-Antworten (nur `hasPasswordOverride` / `hasGlobalPassword`), nie in Logs und nie in Fehlermeldungen.
- Timeouts: MQTT-Befehl 5 s, HTTP-Befehl 10 s, HTTP-Scan 1,5 s pro Adresse bei 32 parallelen Anfragen.
- HTTP-Polling: standardmäßig alle 60 s. Nach 3 aufeinanderfolgenden Fehlschlägen gilt der HTTP-Kanal als nicht erreichbar.
- Scan-Bereiche: nur IPv4-CIDR mit Präfix ≥ /20 (höchstens 4096 Adressen).
- Persistenz ausschließlich unter dem Datenverzeichnis (`/data` in der App), Datenbankdatei `tasmota-manager.db`.
- Die UI verwendet nur relative URLs (`api/...`) und Hash-Routing, damit sie hinter dem HA-Ingress-Pfad funktioniert. Sprachen: Deutsch und Englisch.
- Unter dem Supervisor (`SUPERVISOR_TOKEN` gesetzt) nimmt der Server nur Anfragen von `172.30.32.2` und `127.0.0.1` an.
- Ingress-Port 8099.

## Review Focus

1. **Geänderte IP-Adresse durch DHCP:** Ein Gerät bekommt eine neue IP, oder ein anderes Gerät erhält die alte. Das Inventar führt über die MAC zusammen, es entsteht kein Duplikat, und die alte IP wird beim früheren Besitzer entfernt. → Task 4
2. **Nicht-standardmäßiges `FullTopic`** (z. B. `%topic%/%prefix%/`): Discovery, LWT und Befehle funktionieren trotzdem. → Task 6
3. **Fremde HTTP-Geräte im Scan-Bereich** (Router mit 401 oder HTML): Sie werden ignoriert und nicht als Tasmota-Platzhalter angelegt. → Task 5 und Task 8
4. **Broker fällt aus:** Alle Geräte verlieren den MQTT-Kanal, das Gateway nutzt HTTP, und die UI zeigt einen Hinweis. Ein nicht idempotenter Befehl (`Power TOGGLE`) wird nach einem MQTT-Timeout **nicht** zusätzlich per HTTP gesendet. → Task 7, Task 9 und Task 16
5. **Zugriff aus dem LAN am Ingress vorbei:** Wegen `host_network` ist Port 8099 im LAN offen. Anfragen, die nicht vom Ingress-Proxy kommen, werden mit 403 abgewiesen. → Task 11

---

### Task 1: Monorepo-Gerüst und `shared`-Paket

**Files:**
- Create: `tasmota_manager/package.json`
- Create: `tasmota_manager/pnpm-workspace.yaml`
- Create: `tasmota_manager/tsconfig.base.json`
- Create: `tasmota_manager/.gitignore`
- Create: `tasmota_manager/.dockerignore`
- Create: `tasmota_manager/packages/shared/package.json`
- Create: `tasmota_manager/packages/shared/tsconfig.json`
- Create: `tasmota_manager/packages/shared/src/index.ts`
- Test: `tasmota_manager/packages/shared/src/index.test.ts`

**Interfaces:**
- Produces (Paket `@tm/shared`): `ChannelSchema`/`Channel` (`'mqtt' | 'http'`), `ErrorCodeSchema`/`ErrorCode`, `MqttStatusSchema`/`MqttStatus`, `DeviceSchema`/`Device`, `DeviceDetail`, `AddDeviceRequestSchema`, `DeviceUpdateRequestSchema`/`DeviceUpdateRequest`, `CommandRequestSchema`, `CommandResult`, `MAX_SCAN_PREFIX`, `parseCidr(cidr): { base: number; prefix: number } | null`, `intToIp(n): string`, `CidrSchema`, `SettingsSchema`/`Settings`, `SettingsUpdateRequestSchema`/`SettingsUpdateRequest`, `StatusResponse`, `ScanProgress`, `WsMessage`, `ApiErrorBody`.

- [ ] **Step 1: pnpm bereitstellen**

Prüfe mit `pnpm --version`, ob pnpm 10 vorhanden ist. Falls nicht, installiere es ohne Root-Rechte:

```bash
npm install -g --prefix ~/.local pnpm@10
pnpm --version
```
Erwartet: `10.x.x`. Liegt `~/.local/bin` nicht im `PATH`, verwende in allen folgenden Befehlen `npx -y pnpm@10` statt `pnpm`.

- [ ] **Step 2: Wurzeldateien anlegen**

`tasmota_manager/package.json`:
```json
{
  "name": "tasmota-manager",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "build": "pnpm --filter @tm/web build && pnpm --filter @tm/server build",
    "dev:server": "TM_DATA_DIR=.data pnpm --filter @tm/server dev",
    "dev:web": "pnpm --filter @tm/web dev"
  },
  "engines": { "node": ">=22.12" }
}
```

`tasmota_manager/pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
onlyBuiltDependencies:
  - better-sqlite3
  - esbuild
```

`tasmota_manager/tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "types": []
  }
}
```

`tasmota_manager/.gitignore`:
```
node_modules/
dist/
.data/
*.db
*.db-wal
*.db-shm
```

`tasmota_manager/.dockerignore`:
```
**/node_modules
**/dist
.data
```

- [ ] **Step 3: `shared`-Paket anlegen**

`tasmota_manager/packages/shared/package.json`:
```json
{
  "name": "@tm/shared",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": { "zod": "^4.6.5" },
  "devDependencies": { "typescript": "5.9.3", "vitest": "^5.0.2" }
}
```

`tasmota_manager/packages/shared/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

- [ ] **Step 4: Failing Test schreiben**

`tasmota_manager/packages/shared/src/index.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  AddDeviceRequestSchema,
  CidrSchema,
  DeviceUpdateRequestSchema,
  SettingsUpdateRequestSchema,
  intToIp,
  parseCidr,
} from './index';

describe('parseCidr', () => {
  it('normalisiert die Basisadresse auf das Netz', () => {
    const parsed = parseCidr('192.168.1.77/24');
    expect(parsed?.prefix).toBe(24);
    expect(intToIp(parsed!.base)).toBe('192.168.1.0');
  });

  it('akzeptiert /32 und /0', () => {
    expect(intToIp(parseCidr('10.1.2.3/32')!.base)).toBe('10.1.2.3');
    expect(intToIp(parseCidr('10.1.2.3/0')!.base)).toBe('0.0.0.0');
  });

  it('lehnt ungültige Eingaben ab', () => {
    expect(parseCidr('300.1.1.1/24')).toBeNull();
    expect(parseCidr('1.2.3.4')).toBeNull();
    expect(parseCidr('1.2.3.4/33')).toBeNull();
    expect(parseCidr('abc')).toBeNull();
  });
});

describe('CidrSchema', () => {
  it('erlaubt höchstens 4096 Adressen', () => {
    expect(CidrSchema.safeParse('10.0.0.0/20').success).toBe(true);
    expect(CidrSchema.safeParse('10.0.0.0/19').success).toBe(false);
    expect(CidrSchema.safeParse('10.0.0.0/8').success).toBe(false);
  });
});

describe('Request-Schemas', () => {
  it('prüft IPv4-Adressen beim manuellen Hinzufügen', () => {
    expect(AddDeviceRequestSchema.safeParse({ ip: '192.168.1.5' }).success).toBe(true);
    expect(AddDeviceRequestSchema.safeParse({ ip: '192.168.1.500' }).success).toBe(false);
  });

  it('erlaubt Teil-Updates der Einstellungen und null als Passwort', () => {
    expect(SettingsUpdateRequestSchema.safeParse({ pollIntervalSec: 30 }).success).toBe(true);
    expect(SettingsUpdateRequestSchema.safeParse({ globalPassword: null }).success).toBe(true);
    expect(SettingsUpdateRequestSchema.safeParse({ pollIntervalSec: 5 }).success).toBe(false);
  });

  it('trimmt Tags und lehnt leere ab', () => {
    expect(DeviceUpdateRequestSchema.parse({ tags: [' Keller '] }).tags).toEqual(['Keller']);
    expect(DeviceUpdateRequestSchema.safeParse({ tags: ['  '] }).success).toBe(false);
  });
});
```

- [ ] **Step 5: Abhängigkeiten installieren und den fehlschlagenden Test ausführen**

```bash
pnpm install
pnpm --filter @tm/shared test
```
Erwartet: FAIL (`./index` existiert noch nicht bzw. die Exporte fehlen).

- [ ] **Step 6: `shared` implementieren**

`tasmota_manager/packages/shared/src/index.ts`:
```ts
import { z } from 'zod';

export const ChannelSchema = z.enum(['mqtt', 'http']);
export type Channel = z.infer<typeof ChannelSchema>;

export const ErrorCodeSchema = z.enum([
  'offline',
  'auth',
  'timeout',
  'rejected',
  'unreachable',
  'interrupted',
  'verify_mismatch',
  'version_mismatch',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const MqttStatusSchema = z.enum(['disabled', 'connecting', 'connected', 'disconnected']);
export type MqttStatus = z.infer<typeof MqttStatusSchema>;

export const DeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string().nullable(),
  ip: z.string().nullable(),
  mqttTopic: z.string().nullable(),
  fullTopic: z.string().nullable(),
  module: z.string().nullable(),
  firmware: z.string().nullable(),
  variant: z.string().nullable(),
  chip: z.string().nullable(),
  flashSize: z.number().nullable(),
  rssi: z.number().nullable(),
  uptimeSec: z.number().nullable(),
  online: z.boolean(),
  authRequired: z.boolean(),
  channels: z.array(ChannelSchema),
  lastSeen: z.string().nullable(),
  hasPasswordOverride: z.boolean(),
  tags: z.array(z.string()),
});
export type Device = z.infer<typeof DeviceSchema>;
export type DeviceDetail = Device & { status: unknown };

export const AddDeviceRequestSchema = z.object({ ip: z.ipv4() });
export type AddDeviceRequest = z.infer<typeof AddDeviceRequestSchema>;

export const DeviceUpdateRequestSchema = z.object({
  password: z.string().max(64).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});
export type DeviceUpdateRequest = z.infer<typeof DeviceUpdateRequestSchema>;

export const CommandRequestSchema = z.object({ command: z.string().trim().min(1).max(512) });
export type CommandResult =
  | { ok: true; channel: Channel; response: unknown }
  | { ok: false; code: ErrorCode; message: string };

/** Kleinstes erlaubtes Präfix für Scans: /20 = 4096 Adressen. */
export const MAX_SCAN_PREFIX = 20;

export function parseCidr(cidr: string): { base: number; prefix: number } | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return null;
  const [a, b, c, d] = octets as [number, number, number, number];
  const ip = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return { base: (ip & mask) >>> 0, prefix };
}

export function intToIp(n: number): string {
  return [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');
}

export const CidrSchema = z
  .string()
  .trim()
  .refine((v) => (parseCidr(v)?.prefix ?? 0) >= MAX_SCAN_PREFIX, { message: 'invalid_cidr' });

export const ConcurrencySchema = z.object({
  command: z.int().min(1).max(50),
  ota: z.int().min(1).max(10),
  backup: z.int().min(1).max(20),
});

export const SettingsSchema = z.object({
  scanCidrs: z.array(CidrSchema).max(16),
  pollIntervalSec: z.int().min(10).max(3600),
  concurrency: ConcurrencySchema,
  backupRetention: z.int().min(1).max(100),
  firmwarePort: z.int().min(1024).max(65535),
  hasGlobalPassword: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const SettingsUpdateRequestSchema = SettingsSchema.omit({ hasGlobalPassword: true })
  .partial()
  .extend({ globalPassword: z.string().max(64).nullable().optional() });
export type SettingsUpdateRequest = z.infer<typeof SettingsUpdateRequestSchema>;

export interface StatusResponse {
  mqtt: MqttStatus;
  version: string;
  scanning: boolean;
}

export interface ScanProgress {
  scanned: number;
  total: number;
  found: number;
}

export type WsMessage =
  | { type: 'device:updated'; device: Device }
  | { type: 'device:removed'; id: string }
  | { type: 'mqtt:status'; status: MqttStatus }
  | ({ type: 'scan:progress' } & ScanProgress)
  | { type: 'scan:done'; found: number };

export interface ApiErrorBody {
  code: string;
  message: string;
}
```

- [ ] **Step 7: Tests und Typecheck ausführen**

```bash
pnpm --filter @tm/shared test && pnpm --filter @tm/shared typecheck
```
Erwartet: alle Tests PASS, keine Typfehler.

- [ ] **Step 8: Commit**

```bash
git add -A .
git commit -m "chore: scaffold pnpm monorepo with shared schemas"
```

---

### Task 2: Tasmota-Protokollhelfer

**Files:**
- Create: `tasmota_manager/packages/server/package.json`
- Create: `tasmota_manager/packages/server/tsconfig.json`
- Create: `tasmota_manager/packages/server/src/tasmota/parse.ts`
- Create: `tasmota_manager/packages/server/src/tasmota/commands.ts`
- Test: `tasmota_manager/packages/server/src/tasmota/parse.test.ts`
- Test: `tasmota_manager/packages/server/src/tasmota/commands.test.ts`

**Interfaces:**
- Produces (`src/tasmota/parse.ts`): `interface DeviceInfo { mac: string; name?; hostname?; ip?; mqttTopic?; fullTopic?; module?; firmware?; variant?; chip?; flashSize?: number; rssi?: number; uptimeSec?: number }`, `isObj(v): v is Record<string, unknown>`, `safeJson(text: string): unknown`, `normalizeMac(mac: unknown): string | null`, `parseVersion(v): { firmware?; variant? }`, `parseStatus0(payload): DeviceInfo | null`, `parseDiscoveryConfig(payload): DeviceInfo | null`, `parseState(payload): { rssi?; uptimeSec? }`, `parseModule(payload): string | null`
- Produces (`src/tasmota/commands.ts`): `type TopicPrefix = 'cmnd' | 'stat' | 'tele'`, `splitCommand(cmd): { name: string; args: string }`, `isQuery(cmd): boolean`, `isRejected(response): boolean`, `buildTopic(fullTopic: string | null | undefined, prefix: TopicPrefix, topic: string): string` (immer mit abschließendem `/`), `matchesResponse(commandName: string, suffix: string, payload: unknown): boolean`

- [ ] **Step 1: `server`-Paket anlegen**

`tasmota_manager/packages/server/package.json`:
```json
{
  "name": "@tm/server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "node build.mjs",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "@fastify/static": "^10.1.5",
    "@fastify/websocket": "^11.3.1",
    "@tm/shared": "workspace:*",
    "better-sqlite3": "^13.0.3",
    "drizzle-orm": "^0.45.3",
    "fastify": "^5.12.5",
    "mqtt": "^5.16.0",
    "pino": "^10.3.1",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^9.6.0",
    "@types/node": "^22.20.0",
    "@types/ws": "^8.18.0",
    "aedes": "^1.2.0",
    "drizzle-kit": "^0.31.11",
    "esbuild": "^0.28.2",
    "tsx": "^4.23.15",
    "typescript": "5.9.3",
    "vitest": "^5.0.2"
  }
}
```

`tasmota_manager/packages/server/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test", "drizzle.config.ts"]
}
```

Danach: `pnpm install`

- [ ] **Step 2: Failing Tests schreiben**

`tasmota_manager/packages/server/src/tasmota/parse.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  normalizeMac,
  parseDiscoveryConfig,
  parseModule,
  parseState,
  parseStatus0,
  parseVersion,
  safeJson,
} from './parse';

const STATUS0 = {
  Status: { Module: 1, DeviceName: 'Keller', FriendlyName: ['Keller-Licht'], Topic: 'keller', Power: '0' },
  StatusFWR: { Version: '14.2.0(release-tasmota)', Hardware: 'ESP8266EX' },
  StatusNET: { Hostname: 'keller-1234', IPAddress: '192.168.1.23', Mac: 'aa:bb:cc:11:22:33' },
  StatusMEM: { FlashSize: 4096 },
  StatusSTS: { UptimeSec: 3600, Wifi: { RSSI: 80, Signal: -61 } },
};

describe('normalizeMac', () => {
  it('entfernt Trennzeichen und setzt Großbuchstaben', () => {
    expect(normalizeMac('aa:bb:cc:11:22:33')).toBe('AABBCC112233');
    expect(normalizeMac('AABBCC112233')).toBe('AABBCC112233');
  });
  it('lehnt falsche Längen und Nicht-Strings ab', () => {
    expect(normalizeMac('aa:bb')).toBeNull();
    expect(normalizeMac(42)).toBeNull();
  });
});

describe('parseVersion', () => {
  it('trennt Version und Variante', () => {
    expect(parseVersion('14.2.0(release-tasmota32)')).toEqual({ firmware: '14.2.0', variant: 'tasmota32' });
    expect(parseVersion('14.2.0.1(tasmota)')).toEqual({ firmware: '14.2.0.1', variant: 'tasmota' });
    expect(parseVersion('14.2.0')).toEqual({ firmware: '14.2.0', variant: undefined });
  });
});

describe('parseStatus0', () => {
  it('liest alle relevanten Felder', () => {
    expect(parseStatus0(STATUS0)).toEqual({
      mac: 'AABBCC112233',
      name: 'Keller',
      hostname: 'keller-1234',
      ip: '192.168.1.23',
      mqttTopic: 'keller',
      chip: 'ESP8266EX',
      flashSize: 4096,
      rssi: -61,
      uptimeSec: 3600,
      firmware: '14.2.0',
      variant: 'tasmota',
    });
  });
  it('liefert null ohne MAC (kein Tasmota)', () => {
    expect(parseStatus0({ hello: 'world' })).toBeNull();
    expect(parseStatus0('<html>')).toBeNull();
  });
});

describe('parseDiscoveryConfig', () => {
  it('liest die Discovery-Nachricht', () => {
    const info = parseDiscoveryConfig({
      ip: '192.168.1.23',
      dn: 'Keller',
      fn: ['Keller-Licht', null],
      hn: 'keller-1234',
      mac: 'AABBCC112233',
      md: 'Sonoff Basic',
      sw: '14.2.0',
      t: 'keller',
      ft: '%prefix%/%topic%/',
    });
    expect(info).toEqual({
      mac: 'AABBCC112233',
      name: 'Keller-Licht',
      hostname: 'keller-1234',
      ip: '192.168.1.23',
      mqttTopic: 'keller',
      fullTopic: '%prefix%/%topic%/',
      module: 'Sonoff Basic',
      firmware: '14.2.0',
      variant: undefined,
    });
  });
  it('liefert null ohne MAC oder Topic', () => {
    expect(parseDiscoveryConfig({ mac: 'AABBCC112233' })).toBeNull();
  });
});

describe('parseState / parseModule / safeJson', () => {
  it('liest Laufzeitwerte aus STATE', () => {
    expect(parseState({ UptimeSec: 200, Wifi: { Signal: -55 } })).toEqual({ rssi: -55, uptimeSec: 200 });
  });
  it('liest den Modulnamen', () => {
    expect(parseModule({ Module: { '1': 'Sonoff Basic' } })).toBe('Sonoff Basic');
    expect(parseModule({ Module: 'x' })).toBeNull();
  });
  it('gibt bei ungültigem JSON undefined zurück', () => {
    expect(safeJson('{"a":1}')).toEqual({ a: 1 });
    expect(safeJson('Online')).toBeUndefined();
  });
});
```

`tasmota_manager/packages/server/src/tasmota/commands.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildTopic, isQuery, isRejected, matchesResponse, splitCommand } from './commands';

describe('splitCommand', () => {
  it('trennt Befehl und Argumente', () => {
    expect(splitCommand('Power1 ON')).toEqual({ name: 'Power1', args: 'ON' });
    expect(splitCommand('  FriendlyName1   Küche & Bad ')).toEqual({ name: 'FriendlyName1', args: 'Küche & Bad' });
    expect(splitCommand('Status')).toEqual({ name: 'Status', args: '' });
  });
  it('erkennt Abfragen ohne Argumente', () => {
    expect(isQuery('Power')).toBe(true);
    expect(isQuery('Power TOGGLE')).toBe(false);
  });
});

describe('isRejected', () => {
  it('erkennt Unknown und Error', () => {
    expect(isRejected({ Command: 'Unknown' })).toBe(true);
    expect(isRejected({ Command: 'Error' })).toBe(true);
    expect(isRejected({ POWER: 'ON' })).toBe(false);
  });
});

describe('buildTopic', () => {
  it('nutzt das Standard-FullTopic', () => {
    expect(buildTopic(null, 'cmnd', 'keller')).toBe('cmnd/keller/');
    expect(buildTopic('%prefix%/%topic%/', 'stat', 'keller')).toBe('stat/keller/');
  });
  it('unterstützt umgestellte FullTopics und ergänzt den Schrägstrich', () => {
    expect(buildTopic('%topic%/%prefix%', 'tele', 'keller')).toBe('keller/tele/');
    expect(buildTopic('haus/%prefix%/%topic%/', 'cmnd', 'keller')).toBe('haus/cmnd/keller/');
  });
});

describe('matchesResponse', () => {
  it('ordnet Status-Befehle STATUS-Topics zu', () => {
    expect(matchesResponse('Status', 'STATUS0', {})).toBe(true);
    expect(matchesResponse('Status', 'RESULT', {})).toBe(false);
  });
  it('ordnet RESULT anhand des Schlüssels zu', () => {
    expect(matchesResponse('Power', 'RESULT', { POWER: 'ON' })).toBe(true);
    expect(matchesResponse('Power1', 'RESULT', { POWER1: 'ON' })).toBe(true);
    expect(matchesResponse('FriendlyName1', 'RESULT', { FriendlyName1: 'x' })).toBe(true);
    expect(matchesResponse('Timezone', 'RESULT', { POWER: 'ON' })).toBe(false);
  });
  it('akzeptiert Fehlerantworten und Template-Antworten', () => {
    expect(matchesResponse('Foo', 'RESULT', { Command: 'Unknown' })).toBe(true);
    expect(matchesResponse('Template', 'RESULT', { NAME: 'Generic', GPIO: [] })).toBe(true);
  });
  it('ignoriert Nicht-RESULT-Topics bei normalen Befehlen', () => {
    expect(matchesResponse('Power', 'POWER', 'ON')).toBe(false);
  });
});
```

- [ ] **Step 3: Tests ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test
```
Erwartet: FAIL (Module `./parse` und `./commands` fehlen).

- [ ] **Step 4: `parse.ts` implementieren**

`tasmota_manager/packages/server/src/tasmota/parse.ts`:
```ts
export interface DeviceInfo {
  mac: string;
  name?: string;
  hostname?: string;
  ip?: string;
  mqttTopic?: string;
  fullTopic?: string;
  module?: string;
  firmware?: string;
  variant?: string;
  chip?: string;
  flashSize?: number;
  rssi?: number;
  uptimeSec?: number;
}

type Json = Record<string, unknown>;

export const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Json => (isObj(v) ? v : {});

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function normalizeMac(mac: unknown): string | null {
  if (typeof mac !== 'string') return null;
  const hex = mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return hex.length === 12 ? hex : null;
}

export function parseVersion(version: unknown): { firmware?: string; variant?: string } {
  const v = str(version);
  if (!v) return {};
  const m = /^([\d.]+)(?:\((.+)\))?/.exec(v);
  if (!m) return { firmware: v };
  return { firmware: m[1], variant: m[2]?.replace(/^release-/, '') };
}

export function parseStatus0(payload: unknown): DeviceInfo | null {
  if (!isObj(payload)) return null;
  const status = obj(payload.Status);
  const fwr = obj(payload.StatusFWR);
  const net = obj(payload.StatusNET);
  const sts = obj(payload.StatusSTS);
  const mem = obj(payload.StatusMEM);
  const mac = normalizeMac(net.Mac);
  if (!mac) return null;
  const friendly = Array.isArray(status.FriendlyName) ? str(status.FriendlyName[0]) : undefined;
  return {
    mac,
    name: str(status.DeviceName) ?? friendly,
    hostname: str(net.Hostname),
    ip: str(net.IPAddress),
    mqttTopic: str(status.Topic),
    chip: str(fwr.Hardware),
    flashSize: num(mem.FlashSize),
    rssi: num(obj(sts.Wifi).Signal),
    uptimeSec: num(sts.UptimeSec),
    ...parseVersion(fwr.Version),
  };
}

export function parseDiscoveryConfig(payload: unknown): DeviceInfo | null {
  if (!isObj(payload)) return null;
  const mac = normalizeMac(payload.mac);
  const topic = str(payload.t);
  if (!mac || !topic) return null;
  const friendly = Array.isArray(payload.fn) ? str(payload.fn[0]) : undefined;
  return {
    mac,
    name: friendly ?? str(payload.dn),
    hostname: str(payload.hn),
    ip: str(payload.ip),
    mqttTopic: topic,
    fullTopic: str(payload.ft),
    module: str(payload.md),
    ...parseVersion(payload.sw),
  };
}

export function parseState(payload: unknown): { rssi?: number; uptimeSec?: number } {
  if (!isObj(payload)) return {};
  return { rssi: num(obj(payload.Wifi).Signal), uptimeSec: num(payload.UptimeSec) };
}

export function parseModule(payload: unknown): string | null {
  if (!isObj(payload) || !isObj(payload.Module)) return null;
  const first = Object.values(payload.Module)[0];
  return typeof first === 'string' ? first : null;
}
```

- [ ] **Step 5: `commands.ts` implementieren**

`tasmota_manager/packages/server/src/tasmota/commands.ts`:
```ts
import { isObj } from './parse';

export type TopicPrefix = 'cmnd' | 'stat' | 'tele';

export function splitCommand(command: string): { name: string; args: string } {
  const trimmed = command.trim();
  const idx = trimmed.search(/\s/);
  if (idx === -1) return { name: trimmed, args: '' };
  return { name: trimmed.slice(0, idx), args: trimmed.slice(idx + 1).trim() };
}

/** Befehle ohne Argumente sind bei Tasmota Abfragen und damit gefahrlos wiederholbar. */
export function isQuery(command: string): boolean {
  return splitCommand(command).args === '';
}

export function isRejected(response: unknown): boolean {
  return isObj(response) && (response.Command === 'Unknown' || response.Command === 'Error');
}

export function buildTopic(fullTopic: string | null | undefined, prefix: TopicPrefix, topic: string): string {
  const template = fullTopic && fullTopic.includes('%prefix%') ? fullTopic : '%prefix%/%topic%/';
  const built = template.replaceAll('%prefix%', prefix).replaceAll('%topic%', topic);
  return built.endsWith('/') ? built : `${built}/`;
}

/** Prüft, ob eine stat-Nachricht die Antwort auf den gesendeten Befehl ist. */
export function matchesResponse(commandName: string, suffix: string, payload: unknown): boolean {
  const name = commandName.toUpperCase();
  if (name.startsWith('STATUS')) return suffix.startsWith('STATUS');
  if (suffix !== 'RESULT' || !isObj(payload)) return false;
  if ('Command' in payload) return true;
  const base = name.replace(/\d+$/, '');
  if (base === 'TEMPLATE' && 'NAME' in payload) return true;
  return Object.keys(payload).some((key) => key.toUpperCase().startsWith(base));
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
git commit -m "feat(server): add Tasmota payload parsing and topic helpers"
```

---

### Task 3: Datenbank und Einstellungen

**Files:**
- Create: `tasmota_manager/packages/server/drizzle.config.ts`
- Create: `tasmota_manager/packages/server/src/db/schema.ts`
- Create: `tasmota_manager/packages/server/src/db/index.ts`
- Create: `tasmota_manager/packages/server/drizzle/` (generiert)
- Create: `tasmota_manager/packages/server/src/settings.ts`
- Create: `tasmota_manager/packages/server/test/helpers.ts`
- Test: `tasmota_manager/packages/server/src/db/db.test.ts`
- Test: `tasmota_manager/packages/server/src/settings.test.ts`

**Interfaces:**
- Consumes: `Channel`, `Settings`, `SettingsUpdateRequest` aus `@tm/shared`
- Produces: `type Db`, `openDb(file: string, migrationsFolder: string): Db` (Schließen über `db.$client.close()`), die Tabellen `devices`, `tags`, `deviceTags`, `settings`, `interface StoredSettings { scanCidrs: string[]; pollIntervalSec: number; concurrency: { command: number; ota: number; backup: number }; backupRetention: number; firmwarePort: number; globalPassword: string | null }`, `defaultSettings(scanCidrs: string[]): StoredSettings`, `class SettingsStore { get(): StoredSettings; update(patch: SettingsUpdateRequest): StoredSettings; toPublic(): Settings }`
- Produces (`test/helpers.ts`): `MIGRATIONS_DIR`, `testDb(): Db`, `waitFor<T>(fn: () => T | Promise<T>, timeoutMs?): Promise<NonNullable<T>>`, `silentLogger`

- [ ] **Step 1: Schema und Drizzle-Konfiguration anlegen**

`tasmota_manager/packages/server/drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({ dialect: 'sqlite', schema: './src/db/schema.ts', out: './drizzle' });
```

`tasmota_manager/packages/server/src/db/schema.ts`:
```ts
import type { Channel } from '@tm/shared';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  hostname: text('hostname'),
  ip: text('ip'),
  mqttTopic: text('mqtt_topic'),
  fullTopic: text('full_topic'),
  module: text('module'),
  firmware: text('firmware'),
  variant: text('variant'),
  chip: text('chip'),
  flashSize: integer('flash_size'),
  rssi: integer('rssi'),
  uptimeSec: integer('uptime_sec'),
  online: integer('online', { mode: 'boolean' }).notNull().default(false),
  authRequired: integer('auth_required', { mode: 'boolean' }).notNull().default(false),
  channels: text('channels', { mode: 'json' }).$type<Channel[]>().notNull().default([]),
  httpFailures: integer('http_failures').notNull().default(0),
  lastSeen: text('last_seen'),
  statusJson: text('status_json', { mode: 'json' }).$type<unknown>(),
  passwordOverride: text('password_override'),
  createdAt: text('created_at').notNull(),
});

export const tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  color: text('color'),
});

export const deviceTags = sqliteTable(
  'device_tags',
  {
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.tagId] })],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json', { mode: 'json' }).$type<unknown>(),
});
```

- [ ] **Step 2: Migration generieren**

```bash
cd packages/server && pnpm db:generate --name init && cd ../..
ls packages/server/drizzle
```
Erwartet: `0000_init.sql` und `meta/` existieren.

- [ ] **Step 3: DB-Zugang und Testhelfer anlegen**

`tasmota_manager/packages/server/src/db/index.ts`:
```ts
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export function openDb(file: string, migrationsFolder: string): Db {
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}
```

`tasmota_manager/packages/server/test/helpers.ts`:
```ts
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { type Db, openDb } from '../src/db';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

export function testDb(): Db {
  return openDb(':memory:', MIGRATIONS_DIR);
}

export const silentLogger = pino({ level: 'silent' });

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 3000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: Zeitüberschreitung');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
```

- [ ] **Step 4: Failing Tests schreiben**

`tasmota_manager/packages/server/src/db/db.test.ts`:
```ts
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { testDb } from '../../test/helpers';
import { deviceTags, devices, tags } from './schema';

describe('openDb', () => {
  it('legt das Schema an und speichert JSON-Spalten', () => {
    const db = testDb();
    db.insert(devices).values({ id: 'AABBCC112233', name: 'Keller', channels: ['mqtt'], createdAt: 'now' }).run();
    const row = db.select().from(devices).get();
    expect(row?.channels).toEqual(['mqtt']);
    expect(row?.online).toBe(false);
  });

  it('löscht Tag-Zuordnungen mit dem Gerät', () => {
    const db = testDb();
    db.insert(devices).values({ id: 'A', name: 'A', createdAt: 'now' }).run();
    const tag = db.insert(tags).values({ name: 'Keller' }).returning().get();
    db.insert(deviceTags).values({ deviceId: 'A', tagId: tag.id }).run();
    db.delete(devices).where(eq(devices.id, 'A')).run();
    expect(db.select().from(deviceTags).all()).toEqual([]);
  });
});
```

`tasmota_manager/packages/server/src/settings.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { testDb } from '../test/helpers';
import { SettingsStore, defaultSettings } from './settings';

describe('SettingsStore', () => {
  it('liefert Standardwerte', () => {
    const store = new SettingsStore(testDb(), defaultSettings(['192.168.1.0/24']));
    expect(store.get()).toMatchObject({ scanCidrs: ['192.168.1.0/24'], pollIntervalSec: 60, globalPassword: null });
    expect(store.get().concurrency).toEqual({ command: 10, ota: 3, backup: 5 });
  });

  it('speichert Änderungen dauerhaft', () => {
    const db = testDb();
    new SettingsStore(db, defaultSettings([])).update({ pollIntervalSec: 30, scanCidrs: ['10.0.0.0/24'] });
    const reloaded = new SettingsStore(db, defaultSettings([]));
    expect(reloaded.get().pollIntervalSec).toBe(30);
    expect(reloaded.get().scanCidrs).toEqual(['10.0.0.0/24']);
  });

  it('gibt das globale Passwort nie öffentlich heraus', () => {
    const store = new SettingsStore(testDb(), defaultSettings([]));
    store.update({ globalPassword: 'geheim' });
    const pub = store.toPublic();
    expect(pub.hasGlobalPassword).toBe(true);
    expect(JSON.stringify(pub)).not.toContain('geheim');
  });

  it('behandelt ein leeres Passwort wie keines', () => {
    const store = new SettingsStore(testDb(), defaultSettings([]));
    store.update({ globalPassword: 'x' });
    store.update({ globalPassword: '' });
    expect(store.get().globalPassword).toBeNull();
    expect(store.toPublic().hasGlobalPassword).toBe(false);
  });
});
```

- [ ] **Step 5: Tests ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test
```
Erwartet: `db.test.ts` PASS, `settings.test.ts` FAIL (`./settings` fehlt).

- [ ] **Step 6: `SettingsStore` implementieren**

`tasmota_manager/packages/server/src/settings.ts`:
```ts
import type { Settings, SettingsUpdateRequest } from '@tm/shared';
import type { Db } from './db';
import { settings as settingsTable } from './db/schema';

export interface StoredSettings {
  scanCidrs: string[];
  pollIntervalSec: number;
  concurrency: { command: number; ota: number; backup: number };
  backupRetention: number;
  firmwarePort: number;
  globalPassword: string | null;
}

export function defaultSettings(scanCidrs: string[]): StoredSettings {
  return {
    scanCidrs,
    pollIntervalSec: 60,
    concurrency: { command: 10, ota: 3, backup: 5 },
    backupRetention: 10,
    firmwarePort: 8266,
    globalPassword: null,
  };
}

export class SettingsStore {
  private cache: StoredSettings;

  constructor(
    private readonly db: Db,
    private readonly defaults: StoredSettings,
  ) {
    this.cache = this.load();
  }

  get(): StoredSettings {
    return this.cache;
  }

  update(patch: SettingsUpdateRequest): StoredSettings {
    const normalized: Record<string, unknown> = { ...patch };
    if (normalized.globalPassword === '') normalized.globalPassword = null;
    const entries = Object.entries(normalized).filter(([, value]) => value !== undefined);
    this.db.transaction((tx) => {
      for (const [key, value] of entries) {
        tx.insert(settingsTable)
          .values({ key, valueJson: value })
          .onConflictDoUpdate({ target: settingsTable.key, set: { valueJson: value } })
          .run();
      }
    });
    this.cache = this.load();
    return this.cache;
  }

  toPublic(): Settings {
    const { globalPassword, ...rest } = this.cache;
    return { ...rest, hasGlobalPassword: Boolean(globalPassword) };
  }

  private load(): StoredSettings {
    const rows = this.db.select().from(settingsTable).all();
    const stored = Object.fromEntries(rows.map((row) => [row.key, row.valueJson]));
    return { ...this.defaults, ...stored } as StoredSettings;
  }
}
```

- [ ] **Step 7: Tests und Typecheck ausführen**

```bash
pnpm --filter @tm/server test && pnpm --filter @tm/server typecheck
```
Erwartet: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A .
git commit -m "feat(server): add SQLite schema, migrations and settings store"
```

---

### Task 4: Geräteinventar (`DeviceRegistry`)

**Files:**
- Create: `tasmota_manager/packages/server/src/registry.ts`
- Test: `tasmota_manager/packages/server/src/registry.test.ts`

**Interfaces:**
- Consumes: `Db`, `devices`/`tags`/`deviceTags` (Task 3), `DeviceInfo` (Task 2), `Channel`/`Device` aus `@tm/shared`
- Produces: `placeholderId(host: string): string` (`IP-<host>`), `interface UpsertOptions { channel?: Channel; statusJson?: unknown }`, `class DeviceRegistry extends EventEmitter<{ updated: [Device]; removed: [string] }>` mit den Methoden `list(): Device[]`, `get(id): Device | null`, `getStatus(id): unknown`, `findByTopic(topic): Device | null`, `findByIp(ip): Device | null`, `upsert(info: DeviceInfo, opts?: UpsertOptions): Device`, `upsertAuthPlaceholder(host): Device`, `markReachable(id, channel): Device`, `markUnreachable(id, channel): Device | null`, `updateRuntime(id, values: { rssi?: number; uptimeSec?: number }): Device | null`, `setAuthRequired(id, value: boolean): Device`, `recordHttpFailure(id): number`, `setPasswordOverride(id, password: string | null): Device`, `getPasswordOverride(id): string | null`, `setTags(id, names: string[]): Device`, `remove(id): boolean`

- [ ] **Step 1: Failing Test schreiben**

`tasmota_manager/packages/server/src/registry.test.ts`:
```ts
import type { Device } from '@tm/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../test/helpers';
import { DeviceRegistry, placeholderId } from './registry';

const MAC_A = 'AABBCC000001';
const MAC_B = 'AABBCC000002';

describe('DeviceRegistry', () => {
  let registry: DeviceRegistry;
  let updates: Device[];
  let removed: string[];

  beforeEach(() => {
    registry = new DeviceRegistry(testDb(), () => new Date('2026-09-29T12:00:00Z'));
    updates = [];
    removed = [];
    registry.on('updated', (d) => updates.push(d));
    registry.on('removed', (id) => removed.push(id));
  });

  it('legt neue Geräte an und meldet sie', () => {
    const device = registry.upsert({ mac: MAC_A, name: 'Keller', ip: '10.0.0.5', mqttTopic: 'keller' });
    expect(device).toMatchObject({ id: MAC_A, name: 'Keller', ip: '10.0.0.5', online: false, channels: [], tags: [] });
    expect(updates).toHaveLength(1);
  });

  it('überschreibt bekannte Felder nicht mit undefined', () => {
    registry.upsert({ mac: MAC_A, name: 'Keller', firmware: '14.2.0', module: 'Sonoff Basic' });
    const device = registry.upsert({ mac: MAC_A, firmware: '14.3.0' });
    expect(device).toMatchObject({ name: 'Keller', firmware: '14.3.0', module: 'Sonoff Basic' });
  });

  it('entfernt eine per DHCP neu vergebene IP beim früheren Gerät', () => {
    registry.upsert({ mac: MAC_A, name: 'A', ip: '10.0.0.5' });
    registry.upsert({ mac: MAC_B, name: 'B', ip: '10.0.0.5' });
    expect(registry.get(MAC_A)?.ip).toBeNull();
    expect(registry.get(MAC_B)?.ip).toBe('10.0.0.5');
    expect(registry.list()).toHaveLength(2);
  });

  it('verwaltet Kanäle und Online-Status', () => {
    registry.upsert({ mac: MAC_A, name: 'A' }, { channel: 'mqtt' });
    registry.markReachable(MAC_A, 'http');
    expect(registry.get(MAC_A)).toMatchObject({ online: true, channels: ['http', 'mqtt'], lastSeen: '2026-09-29T12:00:00.000Z' });
    registry.markUnreachable(MAC_A, 'mqtt');
    expect(registry.get(MAC_A)).toMatchObject({ online: true, channels: ['http'] });
    registry.markUnreachable(MAC_A, 'http');
    expect(registry.get(MAC_A)).toMatchObject({ online: false, channels: [] });
  });

  it('ersetzt Passwort-Platzhalter und übernimmt deren Passwort', () => {
    const placeholder = registry.upsertAuthPlaceholder('10.0.0.9');
    expect(placeholder).toMatchObject({ id: placeholderId('10.0.0.9'), authRequired: true, online: true });
    registry.setPasswordOverride(placeholder.id, 'geheim');
    registry.upsert({ mac: MAC_A, name: 'Echt', ip: '10.0.0.9' }, { channel: 'http' });
    expect(registry.get(placeholder.id)).toBeNull();
    expect(removed).toEqual([placeholder.id]);
    expect(registry.getPasswordOverride(MAC_A)).toBe('geheim');
    expect(registry.get(MAC_A)?.authRequired).toBe(false);
  });

  it('markiert ein bekanntes Gerät statt einen Platzhalter anzulegen', () => {
    registry.upsert({ mac: MAC_A, name: 'A', ip: '10.0.0.9' });
    const device = registry.upsertAuthPlaceholder('10.0.0.9');
    expect(device.id).toBe(MAC_A);
    expect(device.authRequired).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });

  it('verwaltet Tags', () => {
    registry.upsert({ mac: MAC_A, name: 'A' });
    registry.upsert({ mac: MAC_B, name: 'B' });
    registry.setTags(MAC_A, ['Licht', 'Keller', 'Licht']);
    registry.setTags(MAC_B, ['Keller']);
    expect(registry.get(MAC_A)?.tags).toEqual(['Keller', 'Licht']);
    registry.setTags(MAC_A, []);
    expect(registry.get(MAC_A)?.tags).toEqual([]);
    expect(registry.get(MAC_B)?.tags).toEqual(['Keller']);
  });

  it('gibt Passwörter nie im Geräteobjekt heraus', () => {
    registry.upsert({ mac: MAC_A, name: 'A' });
    const device = registry.setPasswordOverride(MAC_A, 'geheim');
    expect(device.hasPasswordOverride).toBe(true);
    expect(JSON.stringify(registry.list())).not.toContain('geheim');
  });

  it('findet Geräte über Topic und IP, zählt HTTP-Fehler', () => {
    registry.upsert({ mac: MAC_A, name: 'A', mqttTopic: 'keller', ip: '10.0.0.5' });
    expect(registry.findByTopic('keller')?.id).toBe(MAC_A);
    expect(registry.findByIp('10.0.0.5')?.id).toBe(MAC_A);
    expect(registry.recordHttpFailure(MAC_A)).toBe(1);
    expect(registry.recordHttpFailure(MAC_A)).toBe(2);
    registry.markReachable(MAC_A, 'http');
    expect(registry.recordHttpFailure(MAC_A)).toBe(1);
  });

  it('entfernt Geräte', () => {
    registry.upsert({ mac: MAC_A, name: 'A' });
    expect(registry.remove(MAC_A)).toBe(true);
    expect(registry.remove(MAC_A)).toBe(false);
    expect(removed).toEqual([MAC_A]);
  });
});
```

- [ ] **Step 2: Test ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test -- registry
```
Erwartet: FAIL (`./registry` fehlt).

- [ ] **Step 3: `DeviceRegistry` implementieren**

`tasmota_manager/packages/server/src/registry.ts`:
```ts
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
```

- [ ] **Step 4: Tests und Typecheck ausführen**

```bash
pnpm --filter @tm/server test && pnpm --filter @tm/server typecheck
```
Erwartet: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A .
git commit -m "feat(server): add device registry with MAC-based merging"
```

---

### Task 5: Test-Fakes und HTTP-Transport

**Files:**
- Create: `tasmota_manager/packages/server/src/transport/errors.ts`
- Create: `tasmota_manager/packages/server/src/transport/http.ts`
- Create: `tasmota_manager/packages/server/test/fakes/fakeTasmota.ts`
- Create: `tasmota_manager/packages/server/test/fakes/broker.ts`
- Test: `tasmota_manager/packages/server/src/transport/http.test.ts`

**Interfaces:**
- Consumes: `splitCommand`, `isRejected`, `buildTopic` (Task 2), `isObj`, `safeJson` (Task 2), `ErrorCode` aus `@tm/shared`
- Produces: `class TransportError extends Error { readonly code: ErrorCode }`, `interface HttpTarget { host: string; password: string | null }`, `interface HttpSender { send(target: HttpTarget, command: string, timeoutMs?: number): Promise<unknown> }`, `class HttpTransport implements HttpSender` (Konstruktor `(defaultTimeoutMs = 10_000)`)
- Produces (Tests): `class FakeTasmota` mit `start(): Promise<this>`, `connectMqtt(url): Promise<void>`, `publishState(): Promise<void>`, `disconnectMqtt(): Promise<void>`, `stop(): Promise<void>`, den Feldern `host`, `port`, `mac`, `topic`, `values: Record<string, string>` und `received: string[]`; außerdem `startBroker(): Promise<{ url: string; close(): Promise<void> }>`

- [ ] **Step 1: Fehlerklasse anlegen**

`tasmota_manager/packages/server/src/transport/errors.ts`:
```ts
import type { ErrorCode } from '@tm/shared';

export class TransportError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}
```

- [ ] **Step 2: Test-Fakes anlegen**

`tasmota_manager/packages/server/test/fakes/fakeTasmota.ts`:
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
}

/** Simuliert ein Tasmota-Gerät mit HTTP-API (/cm) und MQTT-Anbindung. */
export class FakeTasmota {
  readonly received: string[] = [];
  readonly values: Record<string, string>;
  readonly mac: string;
  readonly topic: string;
  readonly fullTopic: string;
  readonly bindHost: string;
  port = 0;
  private server: Server | null = null;
  private client: MqttClient | null = null;

  constructor(private readonly opts: FakeTasmotaOptions) {
    this.mac = opts.mac;
    this.topic = opts.topic ?? `tasmota_${opts.mac.slice(-6)}`;
    this.fullTopic = opts.fullTopic ?? '%prefix%/%topic%/';
    this.bindHost = opts.bindHost ?? '127.0.0.1';
    const name = opts.name ?? 'Tasmota';
    this.values = {
      POWER: 'OFF',
      DeviceName: name,
      FriendlyName1: name,
      Timezone: '99',
      MqttHost: '',
      SetOption19: 'OFF',
      TelePeriod: '300',
    };
  }

  get host(): string {
    return `${this.bindHost}:${this.port}`;
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
    const lwt = `${buildTopic(this.fullTopic, 'tele', this.topic)}LWT`;
    const cmnd = buildTopic(this.fullTopic, 'cmnd', this.topic);
    const stat = buildTopic(this.fullTopic, 'stat', this.topic);
    const client = await connectAsync(url, { will: { topic: lwt, payload: Buffer.from('Offline'), retain: true, qos: 1 } });
    this.client = client;
    await client.subscribeAsync(`${cmnd}#`);
    client.on('message', (topic, message) => {
      if (!topic.startsWith(cmnd)) return;
      const name = topic.slice(cmnd.length);
      const command = message.length > 0 ? `${name} ${message.toString()}` : name;
      const { suffix, payload } = this.execute(command);
      setTimeout(() => {
        void client.publishAsync(`${stat}${suffix}`, JSON.stringify(payload)).catch(() => undefined);
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
    await this.client?.endAsync(true);
    this.client = null;
    const server = this.server;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.server = null;
    }
  }

  execute(command: string): { suffix: string; payload: Record<string, unknown> } {
    this.received.push(command);
    const { name, args } = splitCommand(command);
    const upper = name.toUpperCase();
    if (upper === 'STATUS' && args === '0') return { suffix: 'STATUS0', payload: this.status0() };
    if (upper === 'MODULE' && !args) return { suffix: 'RESULT', payload: { Module: { '1': this.opts.module ?? 'Sonoff Basic' } } };
    if (upper === 'RESTART') return { suffix: 'RESULT', payload: { Restart: 'Restarting' } };
    if (upper === 'POWER' || upper === 'POWER1') {
      const current = this.values.POWER;
      const arg = args.toUpperCase();
      const next = !arg ? current : arg === 'TOGGLE' ? (current === 'ON' ? 'OFF' : 'ON') : arg === 'ON' || arg === '1' ? 'ON' : 'OFF';
      this.values.POWER = next ?? 'OFF';
      return { suffix: 'RESULT', payload: { POWER: this.values.POWER } };
    }
    const key = Object.keys(this.values).find((k) => k.toUpperCase() === upper);
    if (!key) return { suffix: 'RESULT', payload: { Command: 'Unknown' } };
    if (args) this.values[key] = args;
    return { suffix: 'RESULT', payload: { [key]: this.values[key] } };
  }

  status0(): Record<string, unknown> {
    const macColons = this.mac.match(/../g)?.join(':') ?? this.mac;
    return {
      Status: {
        Module: 1,
        DeviceName: this.values.DeviceName,
        FriendlyName: [this.values.FriendlyName1],
        Topic: this.topic,
        Power: this.values.POWER === 'ON' ? '1' : '0',
      },
      StatusFWR: { Version: this.opts.firmware ?? '14.2.0(release-tasmota)', Hardware: 'ESP8266EX' },
      StatusNET: { Hostname: `${this.topic}-1234`, IPAddress: this.bindHost, Mac: macColons },
      StatusMEM: { FlashSize: 4096 },
      StatusSTS: { UptimeSec: 100, Wifi: { Signal: -60 } },
    };
  }

  private discoveryConfig(): Record<string, unknown> {
    return {
      ip: this.bindHost,
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
    const { payload } = this.execute(url.searchParams.get('cmnd') ?? '');
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    }, this.opts.responseDelayMs ?? 0);
  }
}
```

`tasmota_manager/packages/server/test/fakes/broker.ts`:
```ts
import { type AddressInfo, createServer } from 'node:net';
import { Aedes } from 'aedes';

export async function startBroker(): Promise<{ url: string; close: () => Promise<void> }> {
  const broker = await Aedes.createBroker();
  const server = createServer(broker.handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `mqtt://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        broker.close(() => server.close(() => resolve()));
      }),
  };
}
```

- [ ] **Step 3: Failing Test schreiben**

`tasmota_manager/packages/server/src/transport/http.test.ts`:
```ts
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeTasmota } from '../../test/fakes/fakeTasmota';
import { parseStatus0 } from '../tasmota/parse';
import { TransportError } from './errors';
import { HttpTransport } from './http';

const http = new HttpTransport(2000);
const started: FakeTasmota[] = [];

async function fake(opts: Partial<ConstructorParameters<typeof FakeTasmota>[0]> = {}): Promise<FakeTasmota> {
  const f = await new FakeTasmota({ mac: 'AABBCC112233', name: 'Keller', ...opts }).start();
  started.push(f);
  return f;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(TransportError);
  await promise.catch((err: TransportError) => expect(err.code).toBe(code));
}

afterEach(async () => {
  for (const f of started.splice(0)) await f.stop();
});

describe('HttpTransport', () => {
  it('liefert Status 0 als JSON', async () => {
    const f = await fake();
    const response = await http.send({ host: f.host, password: null }, 'Status 0');
    expect(parseStatus0(response)?.mac).toBe('AABBCC112233');
  });

  it('kodiert Leerzeichen und Sonderzeichen korrekt', async () => {
    const f = await fake();
    await http.send({ host: f.host, password: null }, 'FriendlyName1 Küche & Bad');
    expect(await http.send({ host: f.host, password: null }, 'FriendlyName1')).toEqual({ FriendlyName1: 'Küche & Bad' });
  });

  it('meldet auth ohne oder mit falschem Passwort', async () => {
    const f = await fake({ password: 'geheim' });
    await expectCode(http.send({ host: f.host, password: null }, 'Power'), 'auth');
    await expectCode(http.send({ host: f.host, password: 'falsch' }, 'Power'), 'auth');
  });

  it('akzeptiert das richtige Passwort', async () => {
    const f = await fake({ password: 'geh eim&' });
    expect(await http.send({ host: f.host, password: 'geh eim&' }, 'Power ON')).toEqual({ POWER: 'ON' });
  });

  it('meldet rejected bei unbekanntem Befehl', async () => {
    const f = await fake();
    await expectCode(http.send({ host: f.host, password: null }, 'Foo'), 'rejected');
  });

  it('meldet timeout bei zu langsamer Antwort', async () => {
    const f = await fake({ responseDelayMs: 500 });
    await expectCode(http.send({ host: f.host, password: null }, 'Power', 100), 'timeout');
  });

  it('meldet unreachable bei geschlossenem Port', async () => {
    await expectCode(http.send({ host: '127.0.0.1:1', password: null }, 'Power'), 'unreachable');
  });

  it('behandelt fremde Geräte mit 401 nicht als Tasmota', async () => {
    const server: Server = createServer((_req, res) => res.writeHead(401, { 'Content-Type': 'text/html' }).end('<h1>Login</h1>'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      await expectCode(http.send({ host: `127.0.0.1:${port}`, password: null }, 'Status 0'), 'unreachable');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
```

- [ ] **Step 4: Test ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test -- http
```
Erwartet: FAIL (`./http` fehlt).

- [ ] **Step 5: `HttpTransport` implementieren**

`tasmota_manager/packages/server/src/transport/http.ts`:
```ts
import { isRejected, splitCommand } from '../tasmota/commands';
import { isObj, safeJson } from '../tasmota/parse';
import { TransportError } from './errors';

export interface HttpTarget {
  host: string;
  password: string | null;
}

export interface HttpSender {
  send(target: HttpTarget, command: string, timeoutMs?: number): Promise<unknown>;
}

export class HttpTransport implements HttpSender {
  constructor(private readonly defaultTimeoutMs = 10_000) {}

  async send(target: HttpTarget, command: string, timeoutMs = this.defaultTimeoutMs): Promise<unknown> {
    const auth = target.password ? `user=admin&password=${encodeURIComponent(target.password)}&` : '';
    const url = `http://${target.host}/cm?${auth}cmnd=${encodeURIComponent(command)}`;

    let res: Response;
    let body: string;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      body = await res.text();
    } catch (err) {
      // Die URL enthält ggf. das Passwort und darf nie in Fehlermeldungen landen.
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new TransportError('timeout', `Keine HTTP-Antwort von ${target.host} innerhalb von ${timeoutMs} ms`);
      }
      throw new TransportError('unreachable', `HTTP-Verbindung zu ${target.host} fehlgeschlagen`);
    }

    const json = safeJson(body);
    if (res.status === 401) {
      if (isObj(json) && typeof json.WARNING === 'string') {
        throw new TransportError('auth', `${target.host} verlangt ein gültiges Web-Passwort`);
      }
      throw new TransportError('unreachable', `${target.host} ist kein Tasmota-Gerät`);
    }
    if (!res.ok || json === undefined) {
      throw new TransportError('unreachable', `Unerwartete Antwort (HTTP ${res.status}) von ${target.host}`);
    }
    if (isRejected(json)) {
      throw new TransportError('rejected', `Gerät lehnt den Befehl "${splitCommand(command).name}" ab`);
    }
    return json;
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
git commit -m "feat(server): add HTTP transport and Tasmota test fakes"
```

---

### Task 6: MQTT-Transport

**Files:**
- Create: `tasmota_manager/packages/server/src/transport/mqtt.ts`
- Test: `tasmota_manager/packages/server/src/transport/mqtt.test.ts`

**Interfaces:**
- Consumes: `buildTopic`, `splitCommand`, `isRejected`, `matchesResponse` (Task 2), `parseDiscoveryConfig`, `safeJson`, `DeviceInfo` (Task 2), `TransportError` (Task 5), `MqttStatus` aus `@tm/shared`, `FakeTasmota`, `startBroker`, `waitFor` (Tests)
- Produces: `interface MqttTarget { topic: string; fullTopic: string | null }`, `interface MqttOptions { url: string; username?: string; password?: string; timeoutMs?: number }`, `interface MqttSender { readonly status: MqttStatus; send(target: MqttTarget, command: string, timeoutMs?: number): Promise<unknown> }`, `class MqttTransport extends EventEmitter<{ status: [MqttStatus]; discovery: [DeviceInfo]; lwt: [topic: string, online: boolean]; state: [topic: string, payload: unknown] }> implements MqttSender` mit `status`, `start(): void`, `stop(): Promise<void>`, `watch(target: MqttTarget): Promise<void>`, `send(...)`

- [ ] **Step 1: Failing Test schreiben**

`tasmota_manager/packages/server/src/transport/mqtt.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startBroker } from '../../test/fakes/broker';
import { FakeTasmota, type FakeTasmotaOptions } from '../../test/fakes/fakeTasmota';
import { waitFor } from '../../test/helpers';
import type { DeviceInfo } from '../tasmota/parse';
import { TransportError } from './errors';
import { MqttTransport } from './mqtt';

describe('MqttTransport', () => {
  let broker: Awaited<ReturnType<typeof startBroker>>;
  let mqtt: MqttTransport;
  const fakes: FakeTasmota[] = [];

  beforeEach(async () => {
    broker = await startBroker();
    mqtt = new MqttTransport({ url: broker.url, timeoutMs: 1000 });
    mqtt.start();
    await waitFor(() => mqtt.status === 'connected');
  });

  afterEach(async () => {
    await mqtt.stop();
    for (const f of fakes.splice(0)) await f.stop();
    await broker.close();
  });

  async function fake(opts: Partial<FakeTasmotaOptions> = {}): Promise<FakeTasmota> {
    const f = new FakeTasmota({ mac: 'AABBCC112233', topic: 'keller', ...opts });
    fakes.push(f);
    await f.connectMqtt(broker.url);
    return f;
  }

  it('meldet Discovery-Nachrichten', async () => {
    const seen: DeviceInfo[] = [];
    mqtt.on('discovery', (info) => seen.push(info));
    await fake();
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ mac: 'AABBCC112233', mqttTopic: 'keller', fullTopic: '%prefix%/%topic%/' });
  });

  it('sendet Befehle und liefert die Antwort', async () => {
    await fake();
    const target = { topic: 'keller', fullTopic: null };
    expect(await mqtt.send(target, 'Status 0')).toMatchObject({ StatusNET: { Mac: 'AA:BB:CC:11:22:33' } });
    expect(await mqtt.send(target, 'Power TOGGLE')).toEqual({ POWER: 'ON' });
  });

  it('funktioniert mit umgestelltem FullTopic', async () => {
    await fake({ fullTopic: '%topic%/%prefix%/' });
    expect(await mqtt.send({ topic: 'keller', fullTopic: '%topic%/%prefix%/' }, 'Power ON')).toEqual({ POWER: 'ON' });
  });

  it('ordnet parallele Befehle an dasselbe Gerät korrekt zu', async () => {
    await fake({ name: 'Keller', responseDelayMs: 50 });
    const target = { topic: 'keller', fullTopic: null };
    const [a, b] = await Promise.all([mqtt.send(target, 'FriendlyName1'), mqtt.send(target, 'Timezone')]);
    expect(a).toEqual({ FriendlyName1: 'Keller' });
    expect(b).toEqual({ Timezone: '99' });
  });

  it('meldet rejected bei unbekanntem Befehl', async () => {
    await fake();
    const err = await mqtt.send({ topic: 'keller', fullTopic: null }, 'Foo').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).code).toBe('rejected');
  });

  it('meldet timeout, wenn niemand antwortet', async () => {
    const err = await mqtt.send({ topic: 'ghost', fullTopic: null }, 'Power', 200).catch((e: unknown) => e);
    expect((err as TransportError).code).toBe('timeout');
  });

  it('meldet LWT-Wechsel beobachteter Geräte', async () => {
    const events: Array<[string, boolean]> = [];
    mqtt.on('lwt', (topic, online) => events.push([topic, online]));
    await mqtt.watch({ topic: 'keller', fullTopic: null });
    const f = await fake();
    await waitFor(() => events.some(([, online]) => online));
    await f.disconnectMqtt();
    await waitFor(() => events.some(([, online]) => !online));
    expect(events[0]).toEqual(['keller', true]);
  });

  it('meldet offline, wenn der Broker nicht verbunden ist', async () => {
    const offline = new MqttTransport({ url: 'mqtt://127.0.0.1:1' });
    offline.start();
    const err = await offline.send({ topic: 'keller', fullTopic: null }, 'Power').catch((e: unknown) => e);
    expect((err as TransportError).code).toBe('offline');
    await offline.stop();
  });
});
```

- [ ] **Step 2: Test ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test -- mqtt
```
Erwartet: FAIL (`./mqtt` fehlt).

- [ ] **Step 3: `MqttTransport` implementieren**

`tasmota_manager/packages/server/src/transport/mqtt.ts`:
```ts
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
    if (!client || this.status !== 'connected') throw new TransportError('offline', 'MQTT-Broker nicht verbunden');
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
```

- [ ] **Step 4: Tests und Typecheck ausführen**

```bash
pnpm --filter @tm/server test && pnpm --filter @tm/server typecheck
```
Erwartet: PASS. Tests, die gelegentlich an Timing scheitern, dürfen nicht über längere Timeouts „repariert“ werden. Suche stattdessen die Ursache (z. B. ein fehlendes `await mqtt.watch(...)`).

- [ ] **Step 5: Commit**

```bash
git add -A .
git commit -m "feat(server): add MQTT transport with per-device response correlation"
```

---

### Task 7: `DeviceGateway` (Kanalwahl und Fallback)

**Files:**
- Create: `tasmota_manager/packages/server/src/gateway.ts`
- Test: `tasmota_manager/packages/server/src/gateway.test.ts`

**Interfaces:**
- Consumes: `DeviceRegistry` (Task 4), `HttpSender`/`HttpTarget` (Task 5), `MqttSender`/`MqttTarget` (Task 6), `TransportError`, `isQuery` (Task 2)
- Produces: `interface GatewayDeps { registry: DeviceRegistry; http: HttpSender; mqtt: MqttSender | null; globalPassword: () => string | null }`, `interface SendResult { channel: Channel; response: unknown }`, `class DeviceGateway { passwordFor(id: string): string | null; send(id: string, command: string, timeoutMs?: number): Promise<SendResult> }`

- [ ] **Step 1: Failing Test schreiben**

`tasmota_manager/packages/server/src/gateway.test.ts`:
```ts
import type { MqttStatus } from '@tm/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../test/helpers';
import { DeviceGateway } from './gateway';
import { DeviceRegistry } from './registry';
import { TransportError } from './transport/errors';

const MAC = 'AABBCC112233';

class StubSender {
  calls: string[] = [];
  passwords: Array<string | null> = [];
  status: MqttStatus = 'connected';
  constructor(public impl: (command: string) => unknown) {}
  async send(target: { password?: string | null }, command: string): Promise<unknown> {
    this.calls.push(command);
    this.passwords.push(target.password ?? null);
    const result = this.impl(command);
    if (result instanceof TransportError) throw result;
    return result;
  }
}

describe('DeviceGateway', () => {
  let registry: DeviceRegistry;
  let mqtt: StubSender;
  let http: StubSender;
  let globalPassword: string | null;
  let gateway: DeviceGateway;

  beforeEach(() => {
    registry = new DeviceRegistry(testDb());
    registry.upsert({ mac: MAC, name: 'Keller', mqttTopic: 'keller', ip: '10.0.0.5' }, { channel: 'mqtt' });
    mqtt = new StubSender(() => ({ POWER: 'ON' }));
    http = new StubSender(() => ({ POWER: 'OFF' }));
    globalPassword = null;
    gateway = new DeviceGateway({ registry, mqtt, http, globalPassword: () => globalPassword });
  });

  it('bevorzugt MQTT, wenn verbunden und erreichbar', async () => {
    expect(await gateway.send(MAC, 'Power')).toEqual({ channel: 'mqtt', response: { POWER: 'ON' } });
    expect(http.calls).toEqual([]);
  });

  it('nutzt HTTP, wenn der Broker getrennt ist', async () => {
    mqtt.status = 'disconnected';
    expect((await gateway.send(MAC, 'Power')).channel).toBe('http');
    expect(registry.get(MAC)?.channels).toEqual(['http', 'mqtt']);
  });

  it('weicht bei MQTT-Timeout einer Abfrage auf HTTP aus', async () => {
    mqtt.impl = () => new TransportError('timeout', 't');
    expect((await gateway.send(MAC, 'Power')).channel).toBe('http');
  });

  it('sendet nicht idempotente Befehle nach MQTT-Timeout nicht erneut', async () => {
    mqtt.impl = () => new TransportError('timeout', 't');
    await expect(gateway.send(MAC, 'Power TOGGLE')).rejects.toMatchObject({ code: 'timeout' });
    expect(http.calls).toEqual([]);
  });

  it('weicht bei abgelehntem Befehl nicht aus', async () => {
    mqtt.impl = () => new TransportError('rejected', 'r');
    await expect(gateway.send(MAC, 'Foo')).rejects.toMatchObject({ code: 'rejected' });
    expect(http.calls).toEqual([]);
  });

  it('markiert auth-Fehler per HTTP am Gerät', async () => {
    mqtt.status = 'disconnected';
    http.impl = () => new TransportError('auth', 'a');
    await expect(gateway.send(MAC, 'Power')).rejects.toMatchObject({ code: 'auth' });
    expect(registry.get(MAC)?.authRequired).toBe(true);
  });

  it('nutzt das Geräte-Passwort vor dem globalen', async () => {
    mqtt.status = 'disconnected';
    globalPassword = 'global';
    await gateway.send(MAC, 'Power');
    registry.setPasswordOverride(MAC, 'eigenes');
    await gateway.send(MAC, 'Power');
    expect(http.passwords).toEqual(['global', 'eigenes']);
  });

  it('behandelt ein leeres globales Passwort als keines', () => {
    globalPassword = '';
    expect(gateway.passwordFor(MAC)).toBeNull();
  });

  it('meldet offline ohne erreichbaren Kanal', async () => {
    registry.upsert({ mac: 'AABBCC000009', name: 'Ohne' });
    await expect(gateway.send('AABBCC000009', 'Power')).rejects.toMatchObject({ code: 'offline' });
  });
});
```

- [ ] **Step 2: Test ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test -- gateway
```
Erwartet: FAIL (`./gateway` fehlt).

- [ ] **Step 3: `DeviceGateway` implementieren**

`tasmota_manager/packages/server/src/gateway.ts`:
```ts
import type { Channel, Device } from '@tm/shared';
import type { DeviceRegistry } from './registry';
import { isQuery } from './tasmota/commands';
import { TransportError } from './transport/errors';
import type { HttpSender } from './transport/http';
import type { MqttSender } from './transport/mqtt';

export interface GatewayDeps {
  registry: DeviceRegistry;
  http: HttpSender;
  mqtt: MqttSender | null;
  globalPassword: () => string | null;
}

export interface SendResult {
  channel: Channel;
  response: unknown;
}

export class DeviceGateway {
  constructor(private readonly deps: GatewayDeps) {}

  passwordFor(id: string): string | null {
    return this.deps.registry.getPasswordOverride(id) ?? (this.deps.globalPassword() || null);
  }

  async send(id: string, command: string, timeoutMs?: number): Promise<SendResult> {
    const device = this.deps.registry.get(id);
    if (!device) throw new TransportError('offline', `Unbekanntes Gerät ${id}`);
    const channels = this.channelsFor(device);
    if (channels.length === 0) throw new TransportError('offline', 'Gerät ist weder per MQTT noch per HTTP erreichbar');

    let lastError: TransportError | null = null;
    for (const [index, channel] of channels.entries()) {
      try {
        const response = await this.sendVia(channel, device, command, timeoutMs);
        this.deps.registry.markReachable(id, channel);
        return { channel, response };
      } catch (err) {
        if (!(err instanceof TransportError)) throw err;
        lastError = err;
        if (channel === 'http' && err.code === 'auth') this.deps.registry.setAuthRequired(id, true);
        if (index === channels.length - 1 || !canFallback(channel, err, command)) break;
      }
    }
    throw lastError ?? new TransportError('offline', 'Gerät nicht erreichbar');
  }

  private channelsFor(device: Device): Channel[] {
    const channels: Channel[] = [];
    if (this.deps.mqtt?.status === 'connected' && device.mqttTopic && device.channels.includes('mqtt')) channels.push('mqtt');
    if (device.ip) channels.push('http');
    return channels;
  }

  private sendVia(channel: Channel, device: Device, command: string, timeoutMs?: number): Promise<unknown> {
    if (channel === 'mqtt' && this.deps.mqtt && device.mqttTopic) {
      return this.deps.mqtt.send({ topic: device.mqttTopic, fullTopic: device.fullTopic }, command, timeoutMs);
    }
    return this.deps.http.send({ host: device.ip ?? '', password: this.passwordFor(device.id) }, command, timeoutMs);
  }
}

/**
 * Ein MQTT-Timeout ist mehrdeutig: Das Gerät hat den Befehl eventuell ausgeführt.
 * Nur Abfragen werden dann per HTTP wiederholt, damit z. B. „Power TOGGLE“ nicht doppelt schaltet.
 */
function canFallback(channel: Channel, err: TransportError, command: string): boolean {
  if (err.code === 'rejected') return false;
  if (channel === 'mqtt' && err.code === 'timeout') return isQuery(command);
  return true;
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
git commit -m "feat(server): add device gateway with safe channel fallback"
```

---

### Task 8: HTTP-Discovery (Identifikation, Scanner, Poller)

**Files:**
- Create: `tasmota_manager/packages/server/src/util/mapLimit.ts`
- Create: `tasmota_manager/packages/server/src/discovery/identify.ts`
- Create: `tasmota_manager/packages/server/src/discovery/scanner.ts`
- Create: `tasmota_manager/packages/server/src/discovery/poller.ts`
- Test: `tasmota_manager/packages/server/src/discovery/scanner.test.ts`
- Test: `tasmota_manager/packages/server/src/discovery/poller.test.ts`

**Interfaces:**
- Consumes: `DeviceRegistry` (Task 4), `HttpSender`, `TransportError` (Task 5), `parseStatus0`, `parseModule` (Task 2), `parseCidr`, `intToIp`, `ScanProgress` aus `@tm/shared`
- Produces: `mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void>`, `identifyHost(http: HttpSender, registry: DeviceRegistry, host: string, password: string | null, timeoutMs?: number): Promise<Device>`, `expandCidr(cidr: string): string[]`, `interface ScannerOptions { port?: number; concurrency?: number; timeoutMs?: number }`, `class HttpScanner extends EventEmitter<{ progress: [ScanProgress]; done: [{ found: number }] }>` mit `running: boolean`, `hostFor(ip): string`, `probe(ip: string): Promise<Device | null>`, `probeHost(host: string, password: string | null): Promise<Device | null>` und `scan(cidrs: string[]): Promise<{ found: number }>` (Konstruktor `(http, registry, credentials: (host: string) => string | null, opts?)`), `interface PollerDeps { http; registry; passwordFor: (id: string) => string | null; intervalSec: () => number; log: Logger; timeoutMs?: number }`, `class HttpPoller { start(); stop(); pollOnce(): Promise<void> }`

- [ ] **Step 1: Failing Tests schreiben**

`tasmota_manager/packages/server/src/discovery/scanner.test.ts`:
```ts
import { type Server, createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeTasmota } from '../../test/fakes/fakeTasmota';
import { testDb } from '../../test/helpers';
import { DeviceRegistry, placeholderId } from '../registry';
import { HttpTransport } from '../transport/http';
import { HttpScanner, expandCidr } from './scanner';

describe('expandCidr', () => {
  it('lässt Netz- und Broadcast-Adresse weg', () => {
    expect(expandCidr('192.168.1.0/30')).toEqual(['192.168.1.1', '192.168.1.2']);
  });
  it('behandelt /31 und /32 vollständig', () => {
    expect(expandCidr('10.0.0.4/31')).toEqual(['10.0.0.4', '10.0.0.5']);
    expect(expandCidr('10.0.0.7/32')).toEqual(['10.0.0.7']);
  });
  it('wirft bei ungültigen Bereichen', () => {
    expect(() => expandCidr('kaputt')).toThrow();
  });
});

describe('HttpScanner', () => {
  const http = new HttpTransport(1000);
  let registry: DeviceRegistry;
  let fakes: FakeTasmota[];
  let stranger: Server | null;

  beforeEach(() => {
    registry = new DeviceRegistry(testDb());
    fakes = [];
    stranger = null;
  });

  afterEach(async () => {
    for (const f of fakes) await f.stop();
    if (stranger) {
      stranger.closeAllConnections();
      await new Promise<void>((resolve) => stranger?.close(() => resolve()));
    }
  });

  it('findet Tasmota-Geräte und ignoriert fremde Webserver', async () => {
    const first = await new FakeTasmota({ mac: 'AABBCC000001', name: 'Eins' }).start();
    const second = await new FakeTasmota({ mac: 'AABBCC000003', name: 'Drei', bindHost: '127.0.0.3', port: first.port }).start();
    fakes.push(first, second);
    const server = createServer((_req, res) => res.writeHead(401, { 'Content-Type': 'text/html' }).end('<h1>Router</h1>'));
    stranger = server;
    await new Promise<void>((resolve) => server.listen(first.port, '127.0.0.2', () => resolve()));

    const scanner = new HttpScanner(http, registry, () => null, { port: first.port, timeoutMs: 500 });
    const done: number[] = [];
    scanner.on('done', ({ found }) => done.push(found));
    expect(await scanner.scan(['127.0.0.0/29'])).toEqual({ found: 2 });
    expect(done).toEqual([2]);
    expect(scanner.running).toBe(false);
    const devices = registry.list();
    expect(devices.map((d) => d.id).sort()).toEqual(['AABBCC000001', 'AABBCC000003']);
    expect(devices.find((d) => d.id === 'AABBCC000001')).toMatchObject({
      ip: first.host,
      module: 'Sonoff Basic',
      channels: ['http'],
      online: true,
    });
  });

  it('legt für passwortgeschützte Geräte einen Platzhalter an und löst ihn mit Passwort auf', async () => {
    const locked = await new FakeTasmota({ mac: 'AABBCC000005', password: 'geheim' }).start();
    fakes.push(locked);
    const scanner = new HttpScanner(http, registry, () => null, { port: locked.port, timeoutMs: 500 });
    const placeholder = await scanner.probe('127.0.0.1');
    expect(placeholder).toMatchObject({ id: placeholderId(locked.host), authRequired: true });

    const device = await scanner.probeHost(locked.host, 'geheim');
    expect(device?.id).toBe('AABBCC000005');
    expect(registry.get(placeholderId(locked.host))).toBeNull();
  });

  it('verwendet das Passwort bekannter Geräte beim Scan', async () => {
    const locked = await new FakeTasmota({ mac: 'AABBCC000006', password: 'geheim' }).start();
    fakes.push(locked);
    registry.upsert({ mac: 'AABBCC000006', name: 'X', ip: locked.host });
    registry.setPasswordOverride('AABBCC000006', 'geheim');
    const scanner = new HttpScanner(http, registry, (host) => registry.getPasswordOverride(registry.findByIp(host)?.id ?? ''), {
      port: locked.port,
      timeoutMs: 500,
    });
    const device = await scanner.probe('127.0.0.1');
    expect(device).toMatchObject({ id: 'AABBCC000006', authRequired: false });
  });

  it('verhindert parallele Scans', async () => {
    const scanner = new HttpScanner(http, registry, () => null, { port: 1, timeoutMs: 200 });
    const first = scanner.scan(['127.0.0.1/32']);
    await expect(scanner.scan(['127.0.0.1/32'])).rejects.toThrow();
    await first;
  });
});
```

`tasmota_manager/packages/server/src/discovery/poller.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeTasmota } from '../../test/fakes/fakeTasmota';
import { silentLogger, testDb } from '../../test/helpers';
import { DeviceRegistry } from '../registry';
import { HttpTransport } from '../transport/http';
import { identifyHost } from './identify';
import { HttpPoller } from './poller';

const MAC = 'AABBCC112233';

describe('HttpPoller', () => {
  const http = new HttpTransport(500);
  let registry: DeviceRegistry;
  let fake: FakeTasmota;
  let password: string | null;
  let poller: HttpPoller;

  beforeEach(async () => {
    registry = new DeviceRegistry(testDb());
    password = null;
    poller = new HttpPoller({ http, registry, passwordFor: () => password, intervalSec: () => 60, log: silentLogger, timeoutMs: 300 });
  });

  afterEach(async () => {
    poller.stop();
    await fake.stop();
  });

  it('aktualisiert HTTP-Geräte', async () => {
    fake = await new FakeTasmota({ mac: MAC, name: 'Alt' }).start();
    await identifyHost(http, registry, fake.host, null);
    fake.values.DeviceName = 'Neu';
    await poller.pollOnce();
    expect(registry.get(MAC)?.name).toBe('Neu');
  });

  it('markiert das Gerät nach drei Fehlschlägen als nicht erreichbar', async () => {
    fake = await new FakeTasmota({ mac: MAC }).start();
    await identifyHost(http, registry, fake.host, null);
    await fake.stop();
    await poller.pollOnce();
    await poller.pollOnce();
    expect(registry.get(MAC)?.online).toBe(true);
    await poller.pollOnce();
    expect(registry.get(MAC)).toMatchObject({ online: false, channels: [] });
  });

  it('überspringt Geräte mit MQTT-Kanal', async () => {
    fake = await new FakeTasmota({ mac: MAC }).start();
    await identifyHost(http, registry, fake.host, null);
    registry.markReachable(MAC, 'mqtt');
    const before = fake.received.length;
    await poller.pollOnce();
    expect(fake.received.length).toBe(before);
  });

  it('markiert fehlende Passwörter, ohne das Gerät offline zu setzen', async () => {
    fake = await new FakeTasmota({ mac: MAC, password: 'geheim' }).start();
    await identifyHost(http, registry, fake.host, 'geheim');
    await poller.pollOnce();
    expect(registry.get(MAC)).toMatchObject({ authRequired: true, online: true });
    password = 'geheim';
    await poller.pollOnce();
    expect(registry.get(MAC)?.authRequired).toBe(false);
  });
});
```

- [ ] **Step 2: Tests ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test -- discovery
```
Erwartet: FAIL (Module fehlen).

- [ ] **Step 3: Hilfsfunktion und Identifikation implementieren**

`tasmota_manager/packages/server/src/util/mapLimit.ts`:
```ts
/** Führt fn für alle Elemente mit höchstens `limit` gleichzeitigen Aufrufen aus. fn darf nicht werfen. */
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
```

`tasmota_manager/packages/server/src/discovery/identify.ts`:
```ts
import type { Device } from '@tm/shared';
import type { DeviceRegistry } from '../registry';
import { parseModule, parseStatus0 } from '../tasmota/parse';
import { TransportError } from '../transport/errors';
import type { HttpSender } from '../transport/http';

/** Fragt `Status 0` per HTTP ab und trägt das Gerät ins Inventar ein. Wirft TransportError. */
export async function identifyHost(
  http: HttpSender,
  registry: DeviceRegistry,
  host: string,
  password: string | null,
  timeoutMs?: number,
): Promise<Device> {
  const payload = await http.send({ host, password }, 'Status 0', timeoutMs);
  const info = parseStatus0(payload);
  if (!info) throw new TransportError('rejected', `${host} liefert keinen Tasmota-Status`);
  // Erreichbar ist das Gerät unter der Adresse, über die wir es gefunden haben (inkl. Port).
  info.ip = host;
  if (!registry.get(info.mac)?.module) {
    try {
      info.module = parseModule(await http.send({ host, password }, 'Module', timeoutMs)) ?? undefined;
    } catch {
      // Modulname ist optional.
    }
  }
  return registry.upsert(info, { channel: 'http', statusJson: payload });
}
```

- [ ] **Step 4: Scanner implementieren**

`tasmota_manager/packages/server/src/discovery/scanner.ts`:
```ts
import { EventEmitter } from 'node:events';
import { type Device, type ScanProgress, intToIp, parseCidr } from '@tm/shared';
import type { DeviceRegistry } from '../registry';
import { TransportError } from '../transport/errors';
import type { HttpSender } from '../transport/http';
import { mapLimit } from '../util/mapLimit';
import { identifyHost } from './identify';

export function expandCidr(cidr: string): string[] {
  const parsed = parseCidr(cidr);
  if (!parsed) throw new Error(`Ungültiger Bereich: ${cidr}`);
  const size = 2 ** (32 - parsed.prefix);
  const first = parsed.prefix >= 31 ? 0 : 1;
  const last = parsed.prefix >= 31 ? size - 1 : size - 2;
  const ips: string[] = [];
  for (let i = first; i <= last; i++) ips.push(intToIp(parsed.base + i));
  return ips;
}

export interface ScannerOptions {
  port?: number;
  concurrency?: number;
  timeoutMs?: number;
}

type ScannerEvents = { progress: [ScanProgress]; done: [{ found: number }] };

export class HttpScanner extends EventEmitter<ScannerEvents> {
  running = false;

  constructor(
    private readonly http: HttpSender,
    private readonly registry: DeviceRegistry,
    private readonly credentials: (host: string) => string | null,
    private readonly opts: ScannerOptions = {},
  ) {
    super();
  }

  hostFor(ip: string): string {
    const port = this.opts.port ?? 80;
    return port === 80 ? ip : `${ip}:${port}`;
  }

  probe(ip: string): Promise<Device | null> {
    const host = this.hostFor(ip);
    return this.probeHost(host, this.credentials(host));
  }

  async probeHost(host: string, password: string | null): Promise<Device | null> {
    try {
      return await identifyHost(this.http, this.registry, host, password, this.opts.timeoutMs ?? 1500);
    } catch (err) {
      if (err instanceof TransportError && err.code === 'auth') return this.registry.upsertAuthPlaceholder(host);
      return null;
    }
  }

  async scan(cidrs: string[]): Promise<{ found: number }> {
    if (this.running) throw new Error('Es läuft bereits ein Scan');
    this.running = true;
    try {
      const ips = [...new Set(cidrs.flatMap(expandCidr))];
      const progress: ScanProgress = { scanned: 0, total: ips.length, found: 0 };
      await mapLimit(ips, this.opts.concurrency ?? 32, async (ip) => {
        if (await this.probe(ip)) progress.found++;
        progress.scanned++;
        if (progress.scanned % 16 === 0 || progress.scanned === progress.total) this.emit('progress', { ...progress });
      });
      this.emit('done', { found: progress.found });
      return { found: progress.found };
    } finally {
      this.running = false;
    }
  }
}
```

- [ ] **Step 5: Poller implementieren**

`tasmota_manager/packages/server/src/discovery/poller.ts`:
```ts
import type { Device } from '@tm/shared';
import type { Logger } from 'pino';
import type { DeviceRegistry } from '../registry';
import { TransportError } from '../transport/errors';
import type { HttpSender } from '../transport/http';
import { mapLimit } from '../util/mapLimit';
import { identifyHost } from './identify';

const MAX_FAILURES = 3;

export interface PollerDeps {
  http: HttpSender;
  registry: DeviceRegistry;
  passwordFor: (id: string) => string | null;
  intervalSec: () => number;
  log: Logger;
  timeoutMs?: number;
}

/** Fragt Geräte ohne MQTT-Kanal regelmäßig per HTTP ab. */
export class HttpPoller {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: PollerDeps) {}

  start(): void {
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<void> {
    const targets = this.deps.registry.list().filter((d) => d.ip && !d.channels.includes('mqtt'));
    await mapLimit(targets, 16, (device) => this.pollDevice(device));
  }

  private schedule(): void {
    this.timer = setTimeout(async () => {
      await this.pollOnce();
      if (this.timer) this.schedule();
    }, this.deps.intervalSec() * 1000);
  }

  private async pollDevice(device: Device): Promise<void> {
    try {
      await identifyHost(this.deps.http, this.deps.registry, device.ip ?? '', this.deps.passwordFor(device.id), this.deps.timeoutMs ?? 5000);
    } catch (err) {
      if (err instanceof TransportError && err.code === 'auth') {
        this.deps.registry.setAuthRequired(device.id, true);
        return;
      }
      if (!this.deps.registry.get(device.id)) return;
      const failures = this.deps.registry.recordHttpFailure(device.id);
      if (failures >= MAX_FAILURES) this.deps.registry.markUnreachable(device.id, 'http');
      this.deps.log.debug({ id: device.id, failures }, 'HTTP-Abfrage fehlgeschlagen');
    }
  }
}
```

- [ ] **Step 6: Tests und Typecheck ausführen**

```bash
pnpm --filter @tm/server test && pnpm --filter @tm/server typecheck
```
Erwartet: PASS. Hinweis: Der Scanner-Test bindet Fakes an `127.0.0.2` und `127.0.0.3`. Das funktioniert unter Linux ohne weitere Konfiguration.

- [ ] **Step 7: Commit**

```bash
git add -A .
git commit -m "feat(server): add HTTP discovery with scanner and poller"
```

---

### Task 9: MQTT-Discovery

**Files:**
- Create: `tasmota_manager/packages/server/src/discovery/mqttDiscovery.ts`
- Test: `tasmota_manager/packages/server/src/discovery/mqttDiscovery.test.ts`

**Interfaces:**
- Consumes: `MqttTransport` (Task 6), `DeviceRegistry` (Task 4), `parseStatus0`, `parseState` (Task 2), pino `Logger`
- Produces: `class MqttDiscovery { constructor(mqtt: MqttTransport, registry: DeviceRegistry, log: Logger); start(): void }`. `start()` muss **vor** `mqtt.start()` aufgerufen werden, damit bekannte Geräte beim Verbindungsaufbau abonniert werden.

- [ ] **Step 1: Failing Test schreiben**

`tasmota_manager/packages/server/src/discovery/mqttDiscovery.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startBroker } from '../../test/fakes/broker';
import { FakeTasmota } from '../../test/fakes/fakeTasmota';
import { silentLogger, testDb, waitFor } from '../../test/helpers';
import { DeviceRegistry } from '../registry';
import { MqttTransport } from '../transport/mqtt';
import { MqttDiscovery } from './mqttDiscovery';

const MAC = 'AABBCC112233';

describe('MqttDiscovery', () => {
  let broker: Awaited<ReturnType<typeof startBroker>>;
  let mqtt: MqttTransport;
  let registry: DeviceRegistry;
  let fake: FakeTasmota;

  beforeEach(async () => {
    broker = await startBroker();
    registry = new DeviceRegistry(testDb());
    mqtt = new MqttTransport({ url: broker.url, timeoutMs: 1000 });
    new MqttDiscovery(mqtt, registry, silentLogger).start();
    mqtt.start();
    await waitFor(() => mqtt.status === 'connected');
    fake = new FakeTasmota({ mac: MAC, name: 'Keller', topic: 'keller' });
  });

  afterEach(async () => {
    await mqtt.stop();
    await fake.stop();
    await broker.close();
  });

  it('legt Geräte an, markiert sie online und lädt Status 0', async () => {
    await fake.connectMqtt(broker.url);
    const device = await waitFor(() => (registry.get(MAC)?.chip ? registry.get(MAC) : null));
    expect(device).toMatchObject({
      name: 'Keller',
      mqttTopic: 'keller',
      module: 'Sonoff Basic',
      firmware: '14.2.0',
      variant: 'tasmota',
      chip: 'ESP8266EX',
      online: true,
      channels: ['mqtt'],
    });
  });

  it('übernimmt STATE-Telemetrie', async () => {
    await fake.connectMqtt(broker.url);
    await waitFor(() => registry.get(MAC)?.online);
    await fake.publishState();
    await waitFor(() => registry.get(MAC)?.rssi === -55);
    expect(registry.get(MAC)?.uptimeSec).toBe(200);
  });

  it('setzt Geräte bei LWT Offline offline', async () => {
    await fake.connectMqtt(broker.url);
    await waitFor(() => registry.get(MAC)?.online);
    await fake.disconnectMqtt();
    await waitFor(() => registry.get(MAC)?.online === false);
  });

  it('entfernt den MQTT-Kanal aller Geräte, wenn der Broker wegfällt', async () => {
    await fake.connectMqtt(broker.url);
    await waitFor(() => registry.get(MAC)?.online);
    mqtt.emit('status', 'disconnected');
    expect(registry.get(MAC)).toMatchObject({ online: false, channels: [] });
  });

  it('abonniert beim Start bereits bekannte Geräte', async () => {
    const other = new DeviceRegistry(testDb());
    other.upsert({ mac: MAC, name: 'Bekannt', mqttTopic: 'keller' });
    const second = new MqttTransport({ url: broker.url, timeoutMs: 1000 });
    new MqttDiscovery(second, other, silentLogger).start();
    await fake.connectMqtt(broker.url);
    second.start();
    await waitFor(() => other.get(MAC)?.online);
    await second.stop();
  });
});
```

- [ ] **Step 2: Test ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test -- mqttDiscovery
```
Erwartet: FAIL (`./mqttDiscovery` fehlt).

- [ ] **Step 3: `MqttDiscovery` implementieren**

`tasmota_manager/packages/server/src/discovery/mqttDiscovery.ts`:
```ts
import type { Logger } from 'pino';
import type { DeviceRegistry } from '../registry';
import { parseState, parseStatus0 } from '../tasmota/parse';
import type { MqttTarget, MqttTransport } from '../transport/mqtt';

export class MqttDiscovery {
  constructor(
    private readonly mqtt: MqttTransport,
    private readonly registry: DeviceRegistry,
    private readonly log: Logger,
  ) {}

  start(): void {
    for (const device of this.registry.list()) {
      if (device.mqttTopic) this.watch({ topic: device.mqttTopic, fullTopic: device.fullTopic });
    }

    this.mqtt.on('discovery', (info) => {
      this.registry.upsert(info);
      if (info.mqttTopic) this.watch({ topic: info.mqttTopic, fullTopic: info.fullTopic ?? null });
    });

    this.mqtt.on('lwt', (topic, online) => {
      const device = this.registry.findByTopic(topic);
      if (!device) return;
      if (!online) {
        this.registry.markUnreachable(device.id, 'mqtt');
        return;
      }
      this.registry.markReachable(device.id, 'mqtt');
      void this.refresh(device.id, { topic, fullTopic: device.fullTopic });
    });

    this.mqtt.on('state', (topic, payload) => {
      const device = this.registry.findByTopic(topic);
      if (!device) return;
      this.registry.updateRuntime(device.id, parseState(payload));
      if (!device.channels.includes('mqtt')) this.registry.markReachable(device.id, 'mqtt');
    });

    this.mqtt.on('status', (status) => {
      if (status === 'connected') return;
      for (const device of this.registry.list()) {
        if (device.channels.includes('mqtt')) this.registry.markUnreachable(device.id, 'mqtt');
      }
    });
  }

  private watch(target: MqttTarget): void {
    this.mqtt.watch(target).catch((err: unknown) => this.log.warn({ err, topic: target.topic }, 'MQTT-Abo fehlgeschlagen'));
  }

  private async refresh(id: string, target: MqttTarget): Promise<void> {
    try {
      const payload = await this.mqtt.send(target, 'Status 0');
      const info = parseStatus0(payload);
      if (info) this.registry.upsert(info, { statusJson: payload });
    } catch (err) {
      this.log.warn({ err, id }, 'Status 0 per MQTT fehlgeschlagen');
    }
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
git commit -m "feat(server): add MQTT discovery with LWT and telemetry handling"
```

---

### Task 10: Konfiguration und Logger

**Files:**
- Create: `tasmota_manager/packages/server/src/config.ts`
- Create: `tasmota_manager/packages/server/src/logger.ts`
- Test: `tasmota_manager/packages/server/src/config.test.ts`
- Test: `tasmota_manager/packages/server/src/logger.test.ts`

**Interfaces:**
- Consumes: `parseCidr`, `intToIp` aus `@tm/shared`
- Produces: `interface MqttConfig { url: string; username?: string; password?: string }`, `interface AppConfig { dataDir: string; port: number; logLevel: string; mqtt: MqttConfig | null; ingressOnly: boolean }`, `loadConfig(env?: NodeJS.ProcessEnv, fetchFn?: typeof fetch): Promise<AppConfig>`, `detectHostCidrs(ifaces?: ReturnType<typeof networkInterfaces>): string[]`, `createLogger(level: string, destination?: DestinationStream): Logger`

- [ ] **Step 1: Failing Tests schreiben**

`tasmota_manager/packages/server/src/config.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { networkInterfaces } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { detectHostCidrs, loadConfig } from './config';

function dataDir(options?: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'tm-config-'));
  if (options) writeFileSync(join(dir, 'options.json'), JSON.stringify(options));
  return dir;
}

describe('loadConfig', () => {
  it('nutzt Standardwerte ohne Optionen', async () => {
    const config = await loadConfig({ TM_DATA_DIR: dataDir() }, vi.fn());
    expect(config).toMatchObject({ port: 8099, logLevel: 'info', mqtt: null, ingressOnly: false });
  });

  it('bevorzugt MQTT-Daten aus den App-Optionen', async () => {
    const fetchFn = vi.fn();
    const config = await loadConfig(
      { TM_DATA_DIR: dataDir({ log_level: 'debug', mqtt_host: 'broker', mqtt_username: 'u', mqtt_password: 'p' }), SUPERVISOR_TOKEN: 't' },
      fetchFn,
    );
    expect(config.mqtt).toEqual({ url: 'mqtt://broker:1883', username: 'u', password: 'p' });
    expect(config.logLevel).toBe('debug');
    expect(config.ingressOnly).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('holt MQTT-Daten vom Supervisor', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: 'ok', data: { host: 'core-mosquitto', port: 1883, ssl: false, username: 'addons', password: 'x' } })),
    );
    const config = await loadConfig({ TM_DATA_DIR: dataDir(), SUPERVISOR_TOKEN: 'token' }, fetchFn);
    expect(config.mqtt).toEqual({ url: 'mqtt://core-mosquitto:1883', username: 'addons', password: 'x' });
    expect(fetchFn).toHaveBeenCalledWith('http://supervisor/services/mqtt', expect.objectContaining({ headers: { Authorization: 'Bearer token' } }));
  });

  it('läuft ohne MQTT weiter, wenn der Supervisor keinen Dienst kennt', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 400 }));
    const config = await loadConfig({ TM_DATA_DIR: dataDir(), SUPERVISOR_TOKEN: 'token' }, fetchFn);
    expect(config.mqtt).toBeNull();
  });

  it('nutzt TM_MQTT_URL für die lokale Entwicklung', async () => {
    const config = await loadConfig({ TM_DATA_DIR: dataDir(), TM_MQTT_URL: 'mqtt://localhost:1883' }, vi.fn());
    expect(config.mqtt).toEqual({ url: 'mqtt://localhost:1883' });
  });
});

describe('detectHostCidrs', () => {
  it('liefert LAN-Netze, höchstens /24, ohne Docker- und Loopback-Schnittstellen', () => {
    const ifaces = {
      lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: '127.0.0.1/8' }],
      enp3s0: [
        { address: '192.168.1.10', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: '192.168.1.10/24' },
        { address: 'fe80::1', netmask: 'ffff::', family: 'IPv6', mac: '', internal: false, cidr: 'fe80::1/64', scopeid: 2 },
      ],
      wlan0: [{ address: '10.1.5.20', netmask: '255.255.0.0', family: 'IPv4', mac: '', internal: false, cidr: '10.1.5.20/16' }],
      hassio: [{ address: '172.30.32.1', netmask: '255.255.254.0', family: 'IPv4', mac: '', internal: false, cidr: '172.30.32.1/23' }],
      docker0: [{ address: '172.17.0.1', netmask: '255.255.0.0', family: 'IPv4', mac: '', internal: false, cidr: '172.17.0.1/16' }],
    } as ReturnType<typeof networkInterfaces>;
    expect(detectHostCidrs(ifaces)).toEqual(['192.168.1.0/24', '10.1.5.0/24']);
  });
});
```

`tasmota_manager/packages/server/src/logger.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';

describe('createLogger', () => {
  it('schwärzt Passwörter', () => {
    const lines: string[] = [];
    const log = createLogger('info', { write: (line: string) => lines.push(line) });
    log.info({ password: 'geheim', settings: { globalPassword: 'auch-geheim' } }, 'test');
    expect(lines.join('')).not.toContain('geheim');
    expect(lines.join('')).toContain('***');
  });
});
```

- [ ] **Step 2: Tests ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test -- config logger
```
Erwartet: FAIL (Module fehlen).

- [ ] **Step 3: Implementieren**

`tasmota_manager/packages/server/src/logger.ts`:
```ts
import pino, { type DestinationStream, type Logger } from 'pino';

const REDACT_PATHS = [
  'password',
  '*.password',
  'globalPassword',
  '*.globalPassword',
  'req.headers.authorization',
  'req.headers.cookie',
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = { level, redact: { paths: REDACT_PATHS, censor: '***' } };
  return destination ? pino(options, destination) : pino(options);
}
```

`tasmota_manager/packages/server/src/config.ts`:
```ts
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { intToIp, parseCidr } from '@tm/shared';

export interface MqttConfig {
  url: string;
  username?: string;
  password?: string;
}

export interface AppConfig {
  dataDir: string;
  port: number;
  logLevel: string;
  mqtt: MqttConfig | null;
  /** true unter dem Supervisor: nur Anfragen über den Ingress-Proxy zulassen. */
  ingressOnly: boolean;
}

interface AddonOptions {
  log_level?: string;
  mqtt_host?: string;
  mqtt_port?: number;
  mqtt_username?: string;
  mqtt_password?: string;
}

interface SupervisorMqttService {
  data?: { host?: string; port?: number; ssl?: boolean; username?: string; password?: string };
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<AppConfig> {
  const dataDir = env.TM_DATA_DIR ?? '/data';
  const options = readOptions(join(dataDir, 'options.json'));
  return {
    dataDir,
    port: Number(env.TM_PORT ?? 8099),
    logLevel: options.log_level ?? env.TM_LOG_LEVEL ?? 'info',
    mqtt: await resolveMqtt(options, env, fetchFn),
    ingressOnly: Boolean(env.SUPERVISOR_TOKEN),
  };
}

function readOptions(file: string): AddonOptions {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AddonOptions;
  } catch {
    return {};
  }
}

async function resolveMqtt(options: AddonOptions, env: NodeJS.ProcessEnv, fetchFn: typeof fetch): Promise<MqttConfig | null> {
  if (options.mqtt_host) {
    return {
      url: `mqtt://${options.mqtt_host}:${options.mqtt_port ?? 1883}`,
      username: options.mqtt_username || undefined,
      password: options.mqtt_password || undefined,
    };
  }
  if (env.SUPERVISOR_TOKEN) {
    try {
      const res = await fetchFn('http://supervisor/services/mqtt', {
        headers: { Authorization: `Bearer ${env.SUPERVISOR_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const { data } = (await res.json()) as SupervisorMqttService;
        if (data?.host) {
          return {
            url: `${data.ssl ? 'mqtts' : 'mqtt'}://${data.host}:${data.port ?? 1883}`,
            username: data.username,
            password: data.password,
          };
        }
      }
    } catch {
      // Kein MQTT-Dienst verfügbar: HTTP-Modus.
    }
  }
  if (env.TM_MQTT_URL) return { url: env.TM_MQTT_URL };
  return null;
}

const IGNORED_INTERFACES = /^(lo|docker|hassio|veth|br-)/;

/** Ermittelt die LAN-Netze des Hosts als Standard-Scanbereiche (höchstens /24 je Netz). */
export function detectHostCidrs(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const result = new Set<string>();
  for (const [name, addresses] of Object.entries(ifaces)) {
    if (IGNORED_INTERFACES.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal || !address.cidr) continue;
      const [ip, prefixText] = address.cidr.split('/');
      const prefix = Math.max(Number(prefixText), 24);
      const parsed = parseCidr(`${ip}/${prefix}`);
      if (parsed) result.add(`${intToIp(parsed.base)}/${prefix}`);
    }
  }
  return [...result];
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
git commit -m "feat(server): add config loading with supervisor MQTT service and redacting logger"
```

---

### Task 11: REST-API und WebSocket

**Files:**
- Create: `tasmota_manager/packages/server/src/api/hub.ts`
- Create: `tasmota_manager/packages/server/src/api/validate.ts`
- Create: `tasmota_manager/packages/server/src/api/devices.ts`
- Create: `tasmota_manager/packages/server/src/api/settings.ts`
- Create: `tasmota_manager/packages/server/src/api/live.ts`
- Create: `tasmota_manager/packages/server/src/api/app.ts`
- Test: `tasmota_manager/packages/server/src/api/app.test.ts`

**Interfaces:**
- Consumes: alle Server-Klassen aus Task 3–9, die Schemas aus `@tm/shared`
- Produces: `class WsHub { add(socket: WebSocket): void; broadcast(msg: WsMessage): void; closeAll(): void; readonly size: number }`, `wireLiveEvents(deps: { hub: WsHub; registry: DeviceRegistry; scanner: HttpScanner; mqtt: MqttTransport | null }): void`, `interface AppDeps { registry; gateway; scanner; settings: SettingsStore; hub: WsHub; mqttStatus: () => MqttStatus; version: string; webDir?: string; allowedIps?: string[]; logger?: Logger }`, `buildApp(deps: AppDeps): Promise<FastifyInstance>`
- HTTP-Endpunkte: `GET /api/devices`, `POST /api/devices`, `GET|PATCH|DELETE /api/devices/:id`, `POST /api/devices/:id/command`, `GET|PUT /api/settings`, `GET /api/status`, `POST /api/scan`, `GET /api/ws` (WebSocket)

- [ ] **Step 1: Failing Test schreiben**

`tasmota_manager/packages/server/src/api/app.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device, WsMessage } from '@tm/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeTasmota } from '../../test/fakes/fakeTasmota';
import { testDb, waitFor } from '../../test/helpers';
import { HttpScanner } from '../discovery/scanner';
import { DeviceGateway } from '../gateway';
import { DeviceRegistry } from '../registry';
import { SettingsStore, defaultSettings } from '../settings';
import { HttpTransport } from '../transport/http';
import { buildApp } from './app';
import { WsHub, wireLiveEvents } from './hub';

interface SetupOptions {
  allowedIps?: string[];
  webDir?: string;
  fakePassword?: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(opts: SetupOptions = {}) {
  const db = testDb();
  const registry = new DeviceRegistry(db);
  const settings = new SettingsStore(db, defaultSettings(['192.168.1.0/24']));
  const http = new HttpTransport(2000);
  const gateway = new DeviceGateway({ registry, http, mqtt: null, globalPassword: () => settings.get().globalPassword });
  const fake = await new FakeTasmota({ mac: 'AABBCC112233', name: 'Keller', password: opts.fakePassword }).start();
  const scanner = new HttpScanner(http, registry, () => settings.get().globalPassword, { port: fake.port, timeoutMs: 500 });
  const hub = new WsHub();
  wireLiveEvents({ hub, registry, scanner, mqtt: null });
  const app: FastifyInstance = await buildApp({
    registry,
    gateway,
    scanner,
    settings,
    hub,
    version: 'test',
    mqttStatus: () => 'disabled',
    allowedIps: opts.allowedIps,
    webDir: opts.webDir,
  });
  cleanups.push(async () => {
    await app.close();
    await fake.stop();
  });
  return { app, registry, settings, hub, fake };
}

async function addFake(app: FastifyInstance): Promise<Device> {
  const res = await app.inject({ method: 'POST', url: '/api/devices', payload: { ip: '127.0.0.1' } });
  expect(res.statusCode).toBe(201);
  return res.json<Device>();
}

describe('Geräte-API', () => {
  it('fügt Geräte per IP hinzu und listet sie', async () => {
    const { app } = await setup();
    const device = await addFake(app);
    expect(device).toMatchObject({ id: 'AABBCC112233', name: 'Keller', channels: ['http'] });
    const list = await app.inject('/api/devices');
    expect(list.json<Device[]>()).toHaveLength(1);
  });

  it('liefert 422, wenn unter der IP kein Tasmota antwortet', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/devices', payload: { ip: '127.0.0.9' } });
    expect(res.statusCode).toBe(422);
    const invalid = await app.inject({ method: 'POST', url: '/api/devices', payload: { ip: 'kein-ip' } });
    expect(invalid.statusCode).toBe(400);
  });

  it('liefert Details mit Rohstatus und 404 für Unbekannte', async () => {
    const { app } = await setup();
    await addFake(app);
    const detail = await app.inject('/api/devices/AABBCC112233');
    expect(detail.json()).toMatchObject({ id: 'AABBCC112233', status: { StatusNET: { Mac: 'AA:BB:CC:11:22:33' } } });
    expect((await app.inject('/api/devices/UNBEKANNT')).statusCode).toBe(404);
  });

  it('führt Befehle aus und meldet abgelehnte Befehle', async () => {
    const { app } = await setup();
    await addFake(app);
    const ok = await app.inject({ method: 'POST', url: '/api/devices/AABBCC112233/command', payload: { command: 'Power ON' } });
    expect(ok.json()).toEqual({ ok: true, channel: 'http', response: { POWER: 'ON' } });
    const rejected = await app.inject({ method: 'POST', url: '/api/devices/AABBCC112233/command', payload: { command: 'Foo' } });
    expect(rejected.json()).toMatchObject({ ok: false, code: 'rejected' });
  });

  it('setzt Tags und Passwort, ohne das Passwort auszuliefern', async () => {
    const { app } = await setup();
    await addFake(app);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/devices/AABBCC112233',
      payload: { tags: ['Licht', 'Keller'], password: 'geheim' },
    });
    expect(res.json()).toMatchObject({ tags: ['Keller', 'Licht'], hasPasswordOverride: true });
    expect(res.body).not.toContain('geheim');
  });

  it('löst Passwort-Platzhalter nach Eingabe des Passworts auf', async () => {
    const { app, registry, fake } = await setup({ fakePassword: 'geheim' });
    const placeholder = await addFake(app);
    expect(placeholder).toMatchObject({ id: `IP-${fake.host}`, authRequired: true });
    const res = await app.inject({ method: 'PATCH', url: `/api/devices/${encodeURIComponent(placeholder.id)}`, payload: { password: 'geheim' } });
    expect(res.json()).toMatchObject({ id: 'AABBCC112233', authRequired: false, hasPasswordOverride: true });
    expect(registry.get(placeholder.id)).toBeNull();
  });

  it('entfernt Geräte', async () => {
    const { app } = await setup();
    await addFake(app);
    expect((await app.inject({ method: 'DELETE', url: '/api/devices/AABBCC112233' })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: '/api/devices/AABBCC112233' })).statusCode).toBe(404);
  });
});

describe('Einstellungen, Status und Scan', () => {
  it('validiert Einstellungen und verbirgt das Passwort', async () => {
    const { app } = await setup();
    const tooBig = await app.inject({ method: 'PUT', url: '/api/settings', payload: { scanCidrs: ['10.0.0.0/8'] } });
    expect(tooBig.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PUT', url: '/api/settings', payload: { scanCidrs: ['10.0.0.0/24'], globalPassword: 'geheim' } });
    expect(ok.json()).toMatchObject({ scanCidrs: ['10.0.0.0/24'], hasGlobalPassword: true });
    expect(ok.body).not.toContain('geheim');
    expect((await app.inject('/api/settings')).body).not.toContain('geheim');
  });

  it('liefert den Status', async () => {
    const { app } = await setup();
    expect((await app.inject('/api/status')).json()).toEqual({ mqtt: 'disabled', version: 'test', scanning: false });
  });

  it('startet Scans über die konfigurierten Bereiche', async () => {
    const { app, registry, settings } = await setup();
    settings.update({ scanCidrs: [] });
    expect((await app.inject({ method: 'POST', url: '/api/scan' })).statusCode).toBe(422);
    settings.update({ scanCidrs: ['127.0.0.1/32'] });
    expect((await app.inject({ method: 'POST', url: '/api/scan' })).statusCode).toBe(202);
    await waitFor(() => registry.get('AABBCC112233'));
  });
});

describe('Live-Updates und Zugriffsschutz', () => {
  it('sendet Geräteänderungen per WebSocket', async () => {
    const { app, registry, hub } = await setup();
    await app.ready();
    const ws = await app.injectWS('/api/ws');
    await waitFor(() => hub.size === 1);
    const received = new Promise<WsMessage>((resolve) => ws.on('message', (data) => resolve(JSON.parse(data.toString()))));
    registry.upsert({ mac: 'AABBCC000001', name: 'Neu' });
    expect(await received).toMatchObject({ type: 'device:updated', device: { id: 'AABBCC000001' } });
    ws.terminate();
  });

  it('weist Anfragen außerhalb des Ingress ab', async () => {
    const { app } = await setup({ allowedIps: ['172.30.32.2'] });
    expect((await app.inject('/api/status')).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/status', remoteAddress: '172.30.32.2' })).statusCode).toBe(200);
  });

  it('liefert die Weboberfläche aus und fällt für unbekannte Pfade auf index.html zurück', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'tm-web-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>TM</title>');
    const { app } = await setup({ webDir });
    expect((await app.inject('/')).body).toContain('<title>TM</title>');
    expect((await app.inject('/irgendwas')).body).toContain('<title>TM</title>');
    const missing = await app.inject('/api/gibtsnicht');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'not_found' });
  });
});
```

- [ ] **Step 2: Test ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test -- api
```
Erwartet: FAIL (Module fehlen).

- [ ] **Step 3: Hub und Validierung implementieren**

`tasmota_manager/packages/server/src/api/hub.ts`:
```ts
import type { WsMessage } from '@tm/shared';
import type { WebSocket } from 'ws';
import type { HttpScanner } from '../discovery/scanner';
import type { DeviceRegistry } from '../registry';
import type { MqttTransport } from '../transport/mqtt';

export class WsHub {
  private readonly sockets = new Set<WebSocket>();

  get size(): number {
    return this.sockets.size;
  }

  add(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
  }

  broadcast(message: WsMessage): void {
    const data = JSON.stringify(message);
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(data);
    }
  }

  closeAll(): void {
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
  }
}

export function wireLiveEvents(deps: {
  hub: WsHub;
  registry: DeviceRegistry;
  scanner: HttpScanner;
  mqtt: MqttTransport | null;
}): void {
  const { hub } = deps;
  deps.registry.on('updated', (device) => hub.broadcast({ type: 'device:updated', device }));
  deps.registry.on('removed', (id) => hub.broadcast({ type: 'device:removed', id }));
  deps.scanner.on('progress', (progress) => hub.broadcast({ type: 'scan:progress', ...progress }));
  deps.scanner.on('done', ({ found }) => hub.broadcast({ type: 'scan:done', found }));
  deps.mqtt?.on('status', (status) => hub.broadcast({ type: 'mqtt:status', status }));
}
```

`tasmota_manager/packages/server/src/api/validate.ts`:
```ts
import type { ApiErrorBody } from '@tm/shared';
import type { FastifyReply } from 'fastify';
import { type ZodType, prettifyError } from 'zod';

export function parseBody<T>(schema: ZodType<T>, data: unknown, reply: FastifyReply): T | undefined {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  void reply.code(400).send({ code: 'validation', message: prettifyError(result.error) } satisfies ApiErrorBody);
  return undefined;
}

export const notFound = (what = 'Gerät'): ApiErrorBody => ({ code: 'not_found', message: `${what} nicht gefunden` });
```

- [ ] **Step 4: Routen implementieren**

`tasmota_manager/packages/server/src/api/devices.ts`:
```ts
import {
  AddDeviceRequestSchema,
  CommandRequestSchema,
  type CommandResult,
  type DeviceDetail,
  DeviceUpdateRequestSchema,
} from '@tm/shared';
import type { FastifyInstance } from 'fastify';
import { TransportError } from '../transport/errors';
import type { AppDeps } from './app';
import { notFound, parseBody } from './validate';

type IdParams = { Params: { id: string } };

export function registerDeviceRoutes(app: FastifyInstance, { registry, gateway, scanner }: AppDeps): void {
  app.get('/api/devices', async () => registry.list());

  app.post('/api/devices', async (req, reply) => {
    const body = parseBody(AddDeviceRequestSchema, req.body, reply);
    if (!body) return reply;
    const device = await scanner.probe(body.ip);
    if (!device) return reply.code(422).send({ code: 'unreachable', message: `Unter ${body.ip} antwortet kein Tasmota-Gerät` });
    return reply.code(201).send(device);
  });

  app.get<IdParams>('/api/devices/:id', async (req, reply) => {
    const device = registry.get(req.params.id);
    if (!device) return reply.code(404).send(notFound());
    const detail: DeviceDetail = { ...device, status: registry.getStatus(device.id) };
    return detail;
  });

  app.patch<IdParams>('/api/devices/:id', async (req, reply) => {
    const body = parseBody(DeviceUpdateRequestSchema, req.body, reply);
    if (!body) return reply;
    let device = registry.get(req.params.id);
    if (!device) return reply.code(404).send(notFound());
    if (body.tags) device = registry.setTags(device.id, body.tags);
    if (body.password !== undefined) {
      device = registry.setPasswordOverride(device.id, body.password || null);
      if (device.authRequired && device.ip) {
        device = (await scanner.probeHost(device.ip, gateway.passwordFor(device.id))) ?? device;
      }
    }
    return device;
  });

  app.delete<IdParams>('/api/devices/:id', async (req, reply) => {
    if (!registry.remove(req.params.id)) return reply.code(404).send(notFound());
    return reply.code(204).send();
  });

  app.post<IdParams>('/api/devices/:id/command', async (req, reply) => {
    const body = parseBody(CommandRequestSchema, req.body, reply);
    if (!body) return reply;
    if (!registry.get(req.params.id)) return reply.code(404).send(notFound());
    try {
      const { channel, response } = await gateway.send(req.params.id, body.command);
      return { ok: true, channel, response } satisfies CommandResult;
    } catch (err) {
      if (err instanceof TransportError) return { ok: false, code: err.code, message: err.message } satisfies CommandResult;
      throw err;
    }
  });
}
```

`tasmota_manager/packages/server/src/api/settings.ts`:
```ts
import { SettingsUpdateRequestSchema } from '@tm/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from './app';
import { parseBody } from './validate';

export function registerSettingsRoutes(app: FastifyInstance, { settings }: AppDeps): void {
  app.get('/api/settings', async () => settings.toPublic());

  app.put('/api/settings', async (req, reply) => {
    const body = parseBody(SettingsUpdateRequestSchema, req.body, reply);
    if (!body) return reply;
    settings.update(body);
    return settings.toPublic();
  });
}
```

`tasmota_manager/packages/server/src/api/live.ts`:
```ts
import type { StatusResponse } from '@tm/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from './app';

export function registerLiveRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/status', async (): Promise<StatusResponse> => ({
    mqtt: deps.mqttStatus(),
    version: deps.version,
    scanning: deps.scanner.running,
  }));

  app.post('/api/scan', async (_req, reply) => {
    if (deps.scanner.running) return reply.code(409).send({ code: 'busy', message: 'Es läuft bereits ein Scan' });
    const cidrs = deps.settings.get().scanCidrs;
    if (cidrs.length === 0) return reply.code(422).send({ code: 'no_cidrs', message: 'Keine Scan-Bereiche konfiguriert' });
    void deps.scanner.scan(cidrs).catch((err: unknown) => app.log.error({ err }, 'Scan fehlgeschlagen'));
    return reply.code(202).send({ started: true });
  });

  app.get('/api/ws', { websocket: true }, (socket) => deps.hub.add(socket));
}
```

`tasmota_manager/packages/server/src/api/app.ts`:
```ts
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { MqttStatus } from '@tm/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { HttpScanner } from '../discovery/scanner';
import type { DeviceGateway } from '../gateway';
import type { DeviceRegistry } from '../registry';
import type { SettingsStore } from '../settings';
import { registerDeviceRoutes } from './devices';
import type { WsHub } from './hub';
import { registerLiveRoutes } from './live';
import { registerSettingsRoutes } from './settings';
import { notFound } from './validate';

export interface AppDeps {
  registry: DeviceRegistry;
  gateway: DeviceGateway;
  scanner: HttpScanner;
  settings: SettingsStore;
  hub: WsHub;
  mqttStatus: () => MqttStatus;
  version: string;
  webDir?: string;
  allowedIps?: string[];
  logger?: Logger;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = deps.logger ? Fastify({ loggerInstance: deps.logger }) : Fastify({ logger: false });

  if (deps.allowedIps) {
    const allowed = new Set(deps.allowedIps);
    app.addHook('onRequest', async (req, reply) => {
      const ip = req.ip.replace(/^::ffff:/, '');
      if (!allowed.has(ip)) {
        return reply.code(403).send({ code: 'forbidden', message: 'Zugriff nur über Home Assistant (Ingress)' });
      }
    });
  }

  await app.register(websocket);
  registerDeviceRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerLiveRoutes(app, deps);

  if (deps.webDir) {
    await app.register(fastifyStatic, { root: deps.webDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.code(404).send(notFound('Ressource')) : reply.sendFile('index.html'),
    );
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send(notFound('Ressource')));
  }
  return app;
}
```

- [ ] **Step 5: Tests und Typecheck ausführen**

```bash
pnpm --filter @tm/server test && pnpm --filter @tm/server typecheck
```
Erwartet: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A .
git commit -m "feat(server): add REST API, WebSocket hub and ingress guard"
```

---

### Task 12: Server-Start, Verdrahtung und Build

**Files:**
- Create: `tasmota_manager/packages/server/src/server.ts`
- Create: `tasmota_manager/packages/server/src/main.ts`
- Create: `tasmota_manager/packages/server/build.mjs`
- Test: `tasmota_manager/packages/server/src/server.test.ts`

**Interfaces:**
- Consumes: alles aus Task 3–11
- Produces: `interface StartOverrides { migrationsDir?: string; webDir?: string | null; scanCidrs?: string[]; version?: string }`, `interface RunningServer { app: FastifyInstance; registry: DeviceRegistry; stop(): Promise<void> }`, `startServer(config: AppConfig, overrides?: StartOverrides): Promise<RunningServer>`, das Bundle `packages/server/dist/server.js`

- [ ] **Step 1: Failing Test schreiben**

`tasmota_manager/packages/server/src/server.test.ts`:
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device } from '@tm/shared';
import { describe, expect, it } from 'vitest';
import { startBroker } from '../test/fakes/broker';
import { FakeTasmota } from '../test/fakes/fakeTasmota';
import { MIGRATIONS_DIR, waitFor } from '../test/helpers';
import { startServer } from './server';

describe('startServer', () => {
  it('startet, findet ein MQTT-Gerät und liefert es über die API aus', async () => {
    const broker = await startBroker();
    const dataDir = mkdtempSync(join(tmpdir(), 'tm-server-'));
    const server = await startServer(
      { dataDir, port: 0, logLevel: 'silent', mqtt: { url: broker.url }, ingressOnly: false },
      { migrationsDir: MIGRATIONS_DIR, webDir: null, scanCidrs: [] },
    );
    const fake = new FakeTasmota({ mac: 'AABBCC112233', name: 'Keller', topic: 'keller' });
    try {
      await fake.connectMqtt(broker.url);
      const devices = await waitFor(async () => {
        const list = (await server.app.inject('/api/devices')).json<Device[]>();
        return list.length === 1 && list[0]?.online ? list : null;
      });
      expect(devices[0]).toMatchObject({ id: 'AABBCC112233', channels: ['mqtt'] });
      const status = (await server.app.inject('/api/status')).json();
      expect(status).toMatchObject({ mqtt: 'connected' });
    } finally {
      await fake.stop();
      await server.stop();
      await broker.close();
    }
  });
});
```

- [ ] **Step 2: Test ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/server test -- server
```
Erwartet: FAIL (`./server` fehlt).

- [ ] **Step 3: `startServer` und `main` implementieren**

`tasmota_manager/packages/server/src/server.ts`:
```ts
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './api/app';
import { WsHub, wireLiveEvents } from './api/hub';
import { type AppConfig, detectHostCidrs } from './config';
import { openDb } from './db';
import { MqttDiscovery } from './discovery/mqttDiscovery';
import { HttpPoller } from './discovery/poller';
import { HttpScanner } from './discovery/scanner';
import { DeviceGateway } from './gateway';
import { createLogger } from './logger';
import { DeviceRegistry } from './registry';
import { SettingsStore, defaultSettings } from './settings';
import { HttpTransport } from './transport/http';
import { MqttTransport } from './transport/mqtt';

// Beide Pfade funktionieren aus src/ (tsx) und aus dist/ (Bundle), weil beide eine Ebene unter packages/server liegen.
const DEFAULT_MIGRATIONS_DIR = process.env.TM_MIGRATIONS_DIR ?? fileURLToPath(new URL('../drizzle', import.meta.url));
const DEFAULT_WEB_DIR = process.env.TM_WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface StartOverrides {
  migrationsDir?: string;
  webDir?: string | null;
  scanCidrs?: string[];
  version?: string;
}

export interface RunningServer {
  app: FastifyInstance;
  registry: DeviceRegistry;
  stop: () => Promise<void>;
}

export async function startServer(config: AppConfig, overrides: StartOverrides = {}): Promise<RunningServer> {
  const log = createLogger(config.logLevel);
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, 'tasmota-manager.db'), overrides.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);

  const settings = new SettingsStore(db, defaultSettings(overrides.scanCidrs ?? detectHostCidrs()));
  const registry = new DeviceRegistry(db);
  const http = new HttpTransport();
  const mqtt = config.mqtt ? new MqttTransport(config.mqtt) : null;
  const gateway = new DeviceGateway({ registry, http, mqtt, globalPassword: () => settings.get().globalPassword });
  const scanner = new HttpScanner(http, registry, (host) => {
    const known = registry.findByIp(host);
    return known ? gateway.passwordFor(known.id) : settings.get().globalPassword || null;
  });
  const poller = new HttpPoller({
    http,
    registry,
    passwordFor: (id) => gateway.passwordFor(id),
    intervalSec: () => settings.get().pollIntervalSec,
    log,
  });
  const hub = new WsHub();
  wireLiveEvents({ hub, registry, scanner, mqtt });

  if (mqtt) {
    new MqttDiscovery(mqtt, registry, log).start();
    mqtt.start();
  }
  poller.start();

  const webDir = overrides.webDir === undefined ? DEFAULT_WEB_DIR : overrides.webDir;
  const app = await buildApp({
    registry,
    gateway,
    scanner,
    settings,
    hub,
    version: overrides.version ?? 'dev',
    mqttStatus: () => mqtt?.status ?? 'disabled',
    webDir: webDir && existsSync(webDir) ? webDir : undefined,
    allowedIps: config.ingressOnly ? ['172.30.32.2', '127.0.0.1'] : undefined,
    logger: log,
  });
  await app.listen({ host: '0.0.0.0', port: config.port });
  log.info({ port: config.port, mqtt: Boolean(mqtt), scanCidrs: settings.get().scanCidrs }, 'Tasmota Manager gestartet');

  return {
    app,
    registry,
    stop: async () => {
      poller.stop();
      hub.closeAll();
      await app.close();
      await mqtt?.stop();
      db.$client.close();
    },
  };
}
```

`tasmota_manager/packages/server/src/main.ts`:
```ts
import { loadConfig } from './config';
import { startServer } from './server';

const config = await loadConfig();
const server = await startServer(config, { version: process.env.TM_VERSION });

const shutdown = (): void => {
  void server.stop().finally(() => process.exit(0));
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
```

`tasmota_manager/packages/server/build.mjs`:
```js
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/server.js',
  external: ['better-sqlite3'],
  // CommonJS-Abhängigkeiten im ESM-Bundle brauchen ein echtes require.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
```

- [ ] **Step 4: Tests und Typecheck ausführen**

```bash
pnpm --filter @tm/server test && pnpm --filter @tm/server typecheck
```
Erwartet: PASS.

- [ ] **Step 5: Bundle bauen und starten**

```bash
pnpm --filter @tm/server build
mkdir -p .data && TM_DATA_DIR=.data TM_PORT=8098 node packages/server/dist/server.js &
sleep 2
curl -s localhost:8098/api/status
curl -s localhost:8098/api/settings
kill %1
```
Erwartet: `{"mqtt":"disabled","version":"dev","scanning":false}` und Einstellungen mit `"hasGlobalPassword":false`, dazu die erkannten `scanCidrs`. Startet das Bundle nicht (z. B. `Dynamic require of ... is not supported`), ergänze das betroffene Paket in `build.mjs` unter `external` und in Task 17 im Dockerfile bei der Laufzeitinstallation.

- [ ] **Step 6: Commit**

```bash
git add -A .
git commit -m "feat(server): wire components into startable server and esbuild bundle"
```

---

### Task 13: Web-Gerüst (Vite, Tailwind, shadcn, i18n, Live-Updates)

**Files:**
- Create: `tasmota_manager/packages/web/package.json`
- Create: `tasmota_manager/packages/web/tsconfig.json`
- Create: `tasmota_manager/packages/web/vite.config.ts`
- Create: `tasmota_manager/packages/web/index.html`
- Create: `tasmota_manager/packages/web/src/index.css` (wird von shadcn erweitert)
- Create: `tasmota_manager/packages/web/src/components/ui/*` (von shadcn generiert)
- Create: `tasmota_manager/packages/web/src/lib/utils.ts` (von shadcn generiert)
- Create: `tasmota_manager/packages/web/src/lib/messages.ts`
- Create: `tasmota_manager/packages/web/src/lib/i18n.tsx`
- Create: `tasmota_manager/packages/web/src/lib/ha.ts`
- Create: `tasmota_manager/packages/web/src/lib/api.ts`
- Create: `tasmota_manager/packages/web/src/lib/live.ts`
- Create: `tasmota_manager/packages/web/src/lib/route.ts`
- Create: `tasmota_manager/packages/web/src/lib/styles.ts`
- Create: `tasmota_manager/packages/web/src/App.tsx`
- Create: `tasmota_manager/packages/web/src/main.tsx`
- Create: `tasmota_manager/packages/web/src/test/setup.ts`
- Create: `tasmota_manager/packages/web/src/test/render.tsx`
- Create: `tasmota_manager/packages/web/src/test/fixtures.ts`
- Test: `tasmota_manager/packages/web/src/lib/lib.test.ts`

**Interfaces:**
- Consumes: Typen aus `@tm/shared`
- Produces: `api` (Objekt mit `devices()`, `device(id)`, `addDevice(ip)`, `updateDevice(id, patch)`, `removeDevice(id)`, `command(id, cmd)`, `settings()`, `updateSettings(patch)`, `status()`, `scan()`), `class ApiError extends Error { status; code }`, `useT(): (key: MessageKey, vars?) => string`, `I18nProvider({ lang, children })`, `detectLanguage(): Lang`, `applyTheme(): void`, `applyMessage(qc, msg: WsMessage): void`, `useLiveUpdates(): void`, `type Route = 'devices' | 'settings'`, `useHashRoute(): [Route, (r: Route) => void]`, `selectClass: string`, `renderWithProviders(ui)`, `makeDevice(partial?): Device`, die Query-Keys `['devices']`, `['device', id]`, `['status']`, `['settings']`, `['scan']`

- [ ] **Step 1: Paketdateien anlegen**

`tasmota_manager/packages/web/package.json`:
```json
{
  "name": "@tm/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.104.0",
    "@tanstack/react-table": "^8.21.3",
    "@tm/shared": "workspace:*",
    "react": "^19.3.0",
    "react-dom": "^19.3.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.3.3",
    "@testing-library/dom": "^10.4.0",
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.3.3",
    "@testing-library/user-event": "^14.6.0",
    "@types/node": "^22.20.0",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.1.1",
    "jsdom": "^30.1.1",
    "tailwindcss": "^4.3.3",
    "typescript": "5.9.3",
    "vite": "^8.3.1",
    "vitest": "^5.0.2"
  }
}
```

`tasmota_manager/packages/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client"],
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
```

`tasmota_manager/packages/web/vite.config.ts`:
```ts
/// <reference types="vitest/config" />
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative Pfade, damit die App unter dem HA-Ingress-Pfad funktioniert.
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  server: { proxy: { '/api': { target: 'http://localhost:8099', ws: true } } },
  test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'] },
});
```

`tasmota_manager/packages/web/index.html`:
```html
<!doctype html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tasmota Manager</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
```

`tasmota_manager/packages/web/src/index.css`:
```css
@import "tailwindcss";
```

`tasmota_manager/packages/web/src/main.tsx` (vorläufig, wird in Step 5 ersetzt):
```tsx
import './index.css';
```

- [ ] **Step 2: Installieren und shadcn/ui einrichten**

```bash
pnpm install
cd packages/web
npx -y shadcn@latest init -b radix -p nova --no-monorepo -y
npx -y shadcn@latest add -y button checkbox table input badge sheet dropdown-menu sonner label card dialog textarea
rm -f package-lock.json
cd ../..
pnpm install
ls packages/web/src/components/ui
```
Erwartet: `badge.tsx button.tsx card.tsx checkbox.tsx dialog.tsx dropdown-menu.tsx input.tsx label.tsx sheet.tsx sonner.tsx table.tsx textarea.tsx`. Außerdem existiert `packages/web/src/lib/utils.ts`, und `components.json` hat `"style": "radix-nova"`. Hat shadcn die Abhängigkeiten per npm installiert (`package-lock.json`), fügt der zweite `pnpm install` sie dem pnpm-Lockfile hinzu.

- [ ] **Step 3: Failing Test schreiben**

`tasmota_manager/packages/web/src/test/setup.ts`:
```ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());
```

`tasmota_manager/packages/web/src/test/render.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '@/lib/i18n';

export function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider lang="de">{ui}</I18nProvider>
    </QueryClientProvider>,
  );
  return { queryClient, ...result };
}
```

`tasmota_manager/packages/web/src/test/fixtures.ts`:
```ts
import type { Device } from '@tm/shared';

export function makeDevice(partial: Partial<Device> = {}): Device {
  return {
    id: 'AABBCC112233',
    name: 'Keller-Licht',
    hostname: 'keller-1234',
    ip: '192.168.1.23',
    mqttTopic: 'keller',
    fullTopic: '%prefix%/%topic%/',
    module: 'Sonoff Basic',
    firmware: '14.2.0',
    variant: 'tasmota',
    chip: 'ESP8266EX',
    flashSize: 4096,
    rssi: -61,
    uptimeSec: 3600,
    online: true,
    authRequired: false,
    channels: ['mqtt'],
    lastSeen: '2026-09-29T12:00:00.000Z',
    hasPasswordOverride: false,
    tags: [],
    ...partial,
  };
}
```

`tasmota_manager/packages/web/src/lib/lib.test.ts`:
```ts
import { QueryClient } from '@tanstack/react-query';
import type { Device, StatusResponse } from '@tm/shared';
import { describe, expect, it } from 'vitest';
import { makeDevice } from '@/test/fixtures';
import { formatMessage } from './i18n';
import { de, en } from './messages';
import { applyMessage } from './live';
import { readHaContext } from './ha';

describe('formatMessage', () => {
  it('ersetzt Platzhalter', () => {
    expect(formatMessage('{count} ausgewählt', { count: 3 })).toBe('3 ausgewählt');
    expect(formatMessage('ohne {x}')).toBe('ohne {x}');
  });
  it('hat für jede deutsche Meldung eine englische', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort());
  });
});

describe('applyMessage', () => {
  it('aktualisiert, ergänzt und entfernt Geräte im Cache', () => {
    const qc = new QueryClient();
    qc.setQueryData<Device[]>(['devices'], [makeDevice({ id: 'A', name: 'Alt' })]);
    applyMessage(qc, { type: 'device:updated', device: makeDevice({ id: 'A', name: 'Neu' }) });
    applyMessage(qc, { type: 'device:updated', device: makeDevice({ id: 'B' }) });
    expect(qc.getQueryData<Device[]>(['devices'])?.map((d) => d.name)).toEqual(['Neu', 'Keller-Licht']);
    applyMessage(qc, { type: 'device:removed', id: 'A' });
    expect(qc.getQueryData<Device[]>(['devices'])?.map((d) => d.id)).toEqual(['B']);
  });

  it('pflegt MQTT- und Scan-Status', () => {
    const qc = new QueryClient();
    qc.setQueryData<StatusResponse>(['status'], { mqtt: 'connected', version: 'x', scanning: false });
    applyMessage(qc, { type: 'mqtt:status', status: 'disconnected' });
    applyMessage(qc, { type: 'scan:progress', scanned: 16, total: 254, found: 1 });
    expect(qc.getQueryData(['status'])).toEqual({ mqtt: 'disconnected', version: 'x', scanning: true });
    expect(qc.getQueryData(['scan'])).toMatchObject({ scanned: 16, total: 254 });
    applyMessage(qc, { type: 'scan:done', found: 1 });
    expect(qc.getQueryData<StatusResponse>(['status'])?.scanning).toBe(false);
    expect(qc.getQueryData(['scan'])).toBeNull();
  });
});

describe('readHaContext', () => {
  it('liefert ein leeres Objekt außerhalb von Home Assistant', () => {
    expect(readHaContext()).toEqual({});
  });
});
```

- [ ] **Step 4: Test ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/web test
```
Erwartet: FAIL (`./i18n`, `./messages`, `./live` und `./ha` fehlen).

- [ ] **Step 5: Bibliotheken und App-Hülle implementieren**

`tasmota_manager/packages/web/src/lib/messages.ts`:
```ts
export const de = {
  'nav.devices': 'Geräte',
  'nav.settings': 'Einstellungen',
  'devices.title': 'Geräte',
  'devices.search': 'Suchen …',
  'devices.filter.status': 'Status',
  'devices.filter.all': 'Alle',
  'devices.filter.online': 'Online',
  'devices.filter.offline': 'Offline',
  'devices.filter.auth': 'Passwort nötig',
  'devices.filter.tag': 'Tag',
  'devices.filter.allTags': 'Alle Tags',
  'devices.columns': 'Spalten',
  'devices.scan': 'Netzwerk scannen',
  'devices.scanning': 'Scan läuft … {scanned}/{total}',
  'devices.scanStarted': 'Scan gestartet',
  'devices.add': 'Gerät hinzufügen',
  'devices.add.ip': 'IP-Adresse',
  'devices.add.submit': 'Hinzufügen',
  'devices.add.success': '{name} hinzugefügt',
  'devices.empty': 'Noch keine Geräte gefunden. Starte einen Scan oder füge ein Gerät per IP hinzu.',
  'devices.selected': '{count} ausgewählt',
  'devices.clearSelection': 'Auswahl aufheben',
  'devices.selectAll': 'Alle auswählen',
  'devices.selectRow': 'Zeile auswählen',
  'devices.col.status': 'Status',
  'devices.col.name': 'Name',
  'devices.col.ip': 'IP',
  'devices.col.firmware': 'Firmware',
  'devices.col.module': 'Modul',
  'devices.col.rssi': 'WLAN',
  'devices.col.channels': 'Kanal',
  'devices.col.tags': 'Tags',
  'devices.col.uptime': 'Laufzeit',
  'status.online': 'Online',
  'status.offline': 'Offline',
  'status.auth': 'Passwort erforderlich',
  'detail.info': 'Informationen',
  'detail.hostname': 'Hostname',
  'detail.topic': 'MQTT-Topic',
  'detail.variant': 'Variante',
  'detail.chip': 'Chip',
  'detail.flash': 'Flash',
  'detail.lastSeen': 'Zuletzt gesehen',
  'detail.actions': 'Aktionen',
  'detail.toggle': 'Schalten',
  'detail.restart': 'Neustart',
  'detail.restartConfirm': '{name} wirklich neu starten?',
  'detail.webui': 'Weboberfläche öffnen',
  'detail.tags': 'Tags',
  'detail.tagsHint': 'Kommagetrennt, z. B. Keller, Licht',
  'detail.password': 'Passwort nur für dieses Gerät',
  'detail.passwordSet': 'Ein eigenes Passwort ist gesetzt.',
  'detail.passwordClear': 'Eigenes Passwort entfernen',
  'detail.remove': 'Gerät entfernen',
  'detail.removeConfirm': '{name} aus der Liste entfernen?',
  'common.save': 'Speichern',
  'common.saved': 'Gespeichert',
  'common.error': 'Fehler: {message}',
  'console.title': 'Konsole',
  'console.placeholder': 'Befehl, z. B. Status 0',
  'console.send': 'Senden',
  'console.via': 'über {channel}',
  'settings.title': 'Einstellungen',
  'settings.cidrs': 'Scan-Bereiche (CIDR)',
  'settings.cidrsHint': 'Ein Bereich pro Zeile, höchstens /20 (4096 Adressen).',
  'settings.invalidCidr': 'Ungültiger Bereich: {cidr}',
  'settings.poll': 'Abfrageintervall für HTTP-Geräte (Sekunden)',
  'settings.invalidPoll': 'Das Intervall muss zwischen 10 und 3600 Sekunden liegen.',
  'settings.password': 'Globales Web-Passwort',
  'settings.passwordSet': 'Ein globales Passwort ist gesetzt. Leer lassen, um es beizubehalten.',
  'settings.passwordNone': 'Kein globales Passwort gesetzt.',
  'settings.passwordRemove': 'Globales Passwort entfernen',
  'settings.mqtt': 'MQTT-Verbindung',
  'mqtt.disabled': 'Kein MQTT-Broker konfiguriert. Alle Geräte werden per HTTP angesprochen.',
  'mqtt.connecting': 'Verbinde mit dem MQTT-Broker …',
  'mqtt.connected': 'Mit dem MQTT-Broker verbunden.',
  'mqtt.disconnected': 'MQTT-Broker nicht erreichbar. Geräte werden per HTTP angesprochen.',
} as const;

export type MessageKey = keyof typeof de;

export const en: Record<MessageKey, string> = {
  'nav.devices': 'Devices',
  'nav.settings': 'Settings',
  'devices.title': 'Devices',
  'devices.search': 'Search …',
  'devices.filter.status': 'Status',
  'devices.filter.all': 'All',
  'devices.filter.online': 'Online',
  'devices.filter.offline': 'Offline',
  'devices.filter.auth': 'Password needed',
  'devices.filter.tag': 'Tag',
  'devices.filter.allTags': 'All tags',
  'devices.columns': 'Columns',
  'devices.scan': 'Scan network',
  'devices.scanning': 'Scanning … {scanned}/{total}',
  'devices.scanStarted': 'Scan started',
  'devices.add': 'Add device',
  'devices.add.ip': 'IP address',
  'devices.add.submit': 'Add',
  'devices.add.success': '{name} added',
  'devices.empty': 'No devices found yet. Start a scan or add a device by IP.',
  'devices.selected': '{count} selected',
  'devices.clearSelection': 'Clear selection',
  'devices.selectAll': 'Select all',
  'devices.selectRow': 'Select row',
  'devices.col.status': 'Status',
  'devices.col.name': 'Name',
  'devices.col.ip': 'IP',
  'devices.col.firmware': 'Firmware',
  'devices.col.module': 'Module',
  'devices.col.rssi': 'Wi-Fi',
  'devices.col.channels': 'Channel',
  'devices.col.tags': 'Tags',
  'devices.col.uptime': 'Uptime',
  'status.online': 'Online',
  'status.offline': 'Offline',
  'status.auth': 'Password required',
  'detail.info': 'Information',
  'detail.hostname': 'Hostname',
  'detail.topic': 'MQTT topic',
  'detail.variant': 'Variant',
  'detail.chip': 'Chip',
  'detail.flash': 'Flash',
  'detail.lastSeen': 'Last seen',
  'detail.actions': 'Actions',
  'detail.toggle': 'Toggle',
  'detail.restart': 'Restart',
  'detail.restartConfirm': 'Really restart {name}?',
  'detail.webui': 'Open web UI',
  'detail.tags': 'Tags',
  'detail.tagsHint': 'Comma-separated, e.g. basement, light',
  'detail.password': 'Password for this device only',
  'detail.passwordSet': 'A device password is set.',
  'detail.passwordClear': 'Remove device password',
  'detail.remove': 'Remove device',
  'detail.removeConfirm': 'Remove {name} from the list?',
  'common.save': 'Save',
  'common.saved': 'Saved',
  'common.error': 'Error: {message}',
  'console.title': 'Console',
  'console.placeholder': 'Command, e.g. Status 0',
  'console.send': 'Send',
  'console.via': 'via {channel}',
  'settings.title': 'Settings',
  'settings.cidrs': 'Scan ranges (CIDR)',
  'settings.cidrsHint': 'One range per line, at most /20 (4096 addresses).',
  'settings.invalidCidr': 'Invalid range: {cidr}',
  'settings.poll': 'Poll interval for HTTP devices (seconds)',
  'settings.invalidPoll': 'The interval must be between 10 and 3600 seconds.',
  'settings.password': 'Global web password',
  'settings.passwordSet': 'A global password is set. Leave empty to keep it.',
  'settings.passwordNone': 'No global password set.',
  'settings.passwordRemove': 'Remove global password',
  'settings.mqtt': 'MQTT connection',
  'mqtt.disabled': 'No MQTT broker configured. All devices are reached via HTTP.',
  'mqtt.connecting': 'Connecting to the MQTT broker …',
  'mqtt.connected': 'Connected to the MQTT broker.',
  'mqtt.disconnected': 'MQTT broker unreachable. Devices are reached via HTTP.',
};
```

`tasmota_manager/packages/web/src/lib/ha.ts`:
```ts
interface HaContext {
  darkMode?: boolean;
  language?: string;
}

type HassElement = Element & { hass?: { language?: string; themes?: { darkMode?: boolean } } };

/** Liest Sprache und Dark Mode aus dem umgebenden HA-Frontend (Ingress läuft same-origin im iframe). */
export function readHaContext(): HaContext {
  try {
    if (window.parent === window) return {};
    const root = window.parent.document.querySelector('home-assistant') as HassElement | null;
    const hass = root?.hass;
    if (!hass) return {};
    return { darkMode: hass.themes?.darkMode, language: hass.language };
  } catch {
    return {};
  }
}

export function applyTheme(): void {
  const dark = readHaContext().darkMode ?? window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  document.documentElement.classList.toggle('dark', dark);
}
```

`tasmota_manager/packages/web/src/lib/i18n.tsx`:
```tsx
import { type ReactNode, createContext, useCallback, useContext } from 'react';
import { readHaContext } from './ha';
import { type MessageKey, de, en } from './messages';

export type Lang = 'de' | 'en';
type Vars = Record<string, string | number>;

const dictionaries: Record<Lang, Record<MessageKey, string>> = { de, en };
const I18nContext = createContext<Lang>('en');

export function detectLanguage(): Lang {
  const language = (readHaContext().language ?? navigator.language).toLowerCase();
  return language.startsWith('de') ? 'de' : 'en';
}

export function formatMessage(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
}

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  return <I18nContext.Provider value={lang}>{children}</I18nContext.Provider>;
}

export function useT(): (key: MessageKey, vars?: Vars) => string {
  const lang = useContext(I18nContext);
  return useCallback((key: MessageKey, vars?: Vars) => formatMessage(dictionaries[lang][key], vars), [lang]);
}
```

`tasmota_manager/packages/web/src/lib/api.ts`:
```ts
import type {
  CommandResult,
  Device,
  DeviceDetail,
  DeviceUpdateRequest,
  Settings,
  SettingsUpdateRequest,
  StatusResponse,
} from '@tm/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// Relative Pfade (ohne führenden Schrägstrich) funktionieren hinter dem Ingress-Präfix.
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`api/${path}`, init);
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, body.code ?? 'error', body.message ?? res.statusText);
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
});

const deviceUrl = (id: string) => `devices/${encodeURIComponent(id)}`;

export const api = {
  devices: () => request<Device[]>('devices'),
  device: (id: string) => request<DeviceDetail>(deviceUrl(id)),
  addDevice: (ip: string) => request<Device>('devices', json('POST', { ip })),
  updateDevice: (id: string, patch: DeviceUpdateRequest) => request<Device>(deviceUrl(id), json('PATCH', patch)),
  removeDevice: (id: string) => request<void>(deviceUrl(id), { method: 'DELETE' }),
  command: (id: string, command: string) => request<CommandResult>(`${deviceUrl(id)}/command`, json('POST', { command })),
  settings: () => request<Settings>('settings'),
  updateSettings: (patch: SettingsUpdateRequest) => request<Settings>('settings', json('PUT', patch)),
  status: () => request<StatusResponse>('status'),
  scan: () => request<{ started: boolean }>('scan', json('POST', {})),
};
```

`tasmota_manager/packages/web/src/lib/live.ts`:
```ts
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import type { Device, StatusResponse, WsMessage } from '@tm/shared';
import { useEffect } from 'react';

export function applyMessage(qc: QueryClient, msg: WsMessage): void {
  switch (msg.type) {
    case 'device:updated':
      qc.setQueryData<Device[]>(['devices'], (list) => {
        if (!list) return list;
        const index = list.findIndex((d) => d.id === msg.device.id);
        if (index === -1) return [...list, msg.device];
        const copy = list.slice();
        copy[index] = msg.device;
        return copy;
      });
      break;
    case 'device:removed':
      qc.setQueryData<Device[]>(['devices'], (list) => list?.filter((d) => d.id !== msg.id));
      break;
    case 'mqtt:status':
      qc.setQueryData<StatusResponse>(['status'], (s) => s && { ...s, mqtt: msg.status });
      break;
    case 'scan:progress': {
      const { type: _type, ...progress } = msg;
      qc.setQueryData(['scan'], progress);
      qc.setQueryData<StatusResponse>(['status'], (s) => s && { ...s, scanning: true });
      break;
    }
    case 'scan:done':
      qc.setQueryData(['scan'], null);
      qc.setQueryData<StatusResponse>(['status'], (s) => s && { ...s, scanning: false });
      break;
  }
}

export function useLiveUpdates(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let closed = false;
    const connect = () => {
      const url = new URL('api/ws', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.hash = '';
      socket = new WebSocket(url);
      socket.onopen = () => void qc.invalidateQueries();
      socket.onmessage = (event) => applyMessage(qc, JSON.parse(String(event.data)) as WsMessage);
      socket.onclose = () => {
        if (!closed) retry = window.setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, [qc]);
}
```

`tasmota_manager/packages/web/src/lib/route.ts`:
```ts
import { useEffect, useState } from 'react';

export const ROUTES = ['devices', 'settings'] as const;
export type Route = (typeof ROUTES)[number];

function readRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return (ROUTES as readonly string[]).includes(hash) ? (hash as Route) : 'devices';
}

/** Hash-Routing, damit Links unter dem Ingress-Pfad funktionieren. */
export function useHashRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [route, (next) => (window.location.hash = `/${next}`)];
}
```

`tasmota_manager/packages/web/src/lib/styles.ts`:
```ts
export const selectClass =
  'h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring';
```

`tasmota_manager/packages/web/src/App.tsx` (Seiten folgen in Task 14 und 16, bis dahin Platzhalter):
```tsx
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { useT } from '@/lib/i18n';
import { useLiveUpdates } from '@/lib/live';
import { ROUTES, useHashRoute } from '@/lib/route';

export function App() {
  useLiveUpdates();
  const t = useT();
  const [route, navigate] = useHashRoute();
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <nav className="flex w-52 shrink-0 flex-col gap-1 border-r p-3">
        <div className="px-2 py-3 font-semibold">Tasmota Manager</div>
        {ROUTES.map((r) => (
          <Button key={r} variant={route === r ? 'secondary' : 'ghost'} className="justify-start" onClick={() => navigate(r)}>
            {t(`nav.${r}`)}
          </Button>
        ))}
      </nav>
      <main className="min-w-0 flex-1 space-y-4 p-6">{route}</main>
      <Toaster />
    </div>
  );
}
```

`tasmota_manager/packages/web/src/main.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme } from './lib/ha';
import { I18nProvider, detectLanguage } from './lib/i18n';
import './index.css';

applyTheme();
const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider lang={detectLanguage()}>
        <App />
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 6: Tests, Typecheck und Build ausführen**

```bash
pnpm --filter @tm/web test && pnpm --filter @tm/web build
```
Erwartet: Tests PASS. `vite build` erzeugt `packages/web/dist/index.html` mit relativen Asset-Pfaden (`./assets/...`).

- [ ] **Step 7: Commit**

```bash
git add -A .
git commit -m "feat(web): scaffold React app with shadcn, i18n, API client and live updates"
```

---

### Task 14: Geräteübersicht

**Files:**
- Create: `tasmota_manager/packages/web/src/features/devices/filter.ts`
- Create: `tasmota_manager/packages/web/src/features/devices/format.ts`
- Create: `tasmota_manager/packages/web/src/features/devices/StatusDot.tsx`
- Create: `tasmota_manager/packages/web/src/features/devices/columns.tsx`
- Create: `tasmota_manager/packages/web/src/features/devices/DeviceTable.tsx`
- Create: `tasmota_manager/packages/web/src/features/devices/ScanButton.tsx`
- Create: `tasmota_manager/packages/web/src/features/devices/AddDeviceDialog.tsx`
- Create: `tasmota_manager/packages/web/src/features/devices/DevicesPage.tsx`
- Modify: `tasmota_manager/packages/web/src/App.tsx` (`<main>`-Inhalt)
- Test: `tasmota_manager/packages/web/src/features/devices/filter.test.ts`
- Test: `tasmota_manager/packages/web/src/features/devices/DevicesPage.test.tsx`

**Interfaces:**
- Consumes: `api`, `useT`, `selectClass`, `renderWithProviders`, `makeDevice` (Task 13), die shadcn-Komponenten
- Produces: `type StatusFilter = 'all' | 'online' | 'offline' | 'auth'`, `filterDevices(devices, { text, status, tag }): Device[]`, `formatUptime(sec: number | null): string`, `DevicesPage` (öffnet `DeviceSheet` aus Task 15; bis dahin ohne Sheet, siehe Step 3)

- [ ] **Step 1: Failing Tests schreiben**

`tasmota_manager/packages/web/src/features/devices/filter.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { makeDevice } from '@/test/fixtures';
import { filterDevices } from './filter';
import { formatUptime } from './format';

const devices = [
  makeDevice({ id: 'A', name: 'Keller-Licht', tags: ['Keller'] }),
  makeDevice({ id: 'B', name: 'Garage', ip: '192.168.1.57', online: false }),
  makeDevice({ id: 'C', name: 'Steckdose', authRequired: true }),
];

describe('filterDevices', () => {
  it('sucht in Name, IP und weiteren Feldern', () => {
    expect(filterDevices(devices, { text: 'garage', status: 'all', tag: '' }).map((d) => d.id)).toEqual(['B']);
    expect(filterDevices(devices, { text: '1.57', status: 'all', tag: '' }).map((d) => d.id)).toEqual(['B']);
  });
  it('filtert nach Status und Tag', () => {
    expect(filterDevices(devices, { text: '', status: 'offline', tag: '' }).map((d) => d.id)).toEqual(['B']);
    expect(filterDevices(devices, { text: '', status: 'auth', tag: '' }).map((d) => d.id)).toEqual(['C']);
    expect(filterDevices(devices, { text: '', status: 'all', tag: 'Keller' }).map((d) => d.id)).toEqual(['A']);
  });
});

describe('formatUptime', () => {
  it('formatiert Tage, Stunden und Minuten', () => {
    expect(formatUptime(93_784)).toBe('1d 2h 3m');
    expect(formatUptime(120)).toBe('2m');
    expect(formatUptime(null)).toBe('—');
  });
});
```

`tasmota_manager/packages/web/src/features/devices/DevicesPage.test.tsx`:
```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { makeDevice } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { DevicesPage } from './DevicesPage';

vi.mock('@/lib/api', () => ({
  api: {
    devices: vi.fn(),
    device: vi.fn(),
    status: vi.fn(),
    scan: vi.fn(),
    addDevice: vi.fn(),
  },
  ApiError: class extends Error {},
}));

describe('DevicesPage', () => {
  beforeEach(() => {
    vi.mocked(api.devices).mockResolvedValue([
      makeDevice({ id: 'A', name: 'Keller-Licht', tags: ['Keller'] }),
      makeDevice({ id: 'B', name: 'Garage', online: false, channels: [] }),
      makeDevice({ id: 'C', name: 'Steckdose', channels: ['http'] }),
    ]);
    vi.mocked(api.status).mockResolvedValue({ mqtt: 'connected', version: 'x', scanning: false });
  });

  it('zeigt alle Geräte', async () => {
    renderWithProviders(<DevicesPage />);
    expect(await screen.findByText('Keller-Licht')).toBeInTheDocument();
    expect(screen.getByText('Garage')).toBeInTheDocument();
    expect(screen.getByText('Steckdose')).toBeInTheDocument();
  });

  it('filtert über Suche und Status', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DevicesPage />);
    await screen.findByText('Keller-Licht');
    await user.type(screen.getByLabelText('Suchen …'), 'gar');
    expect(screen.queryByText('Keller-Licht')).not.toBeInTheDocument();
    expect(screen.getByText('Garage')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Suchen …'));
    await user.selectOptions(screen.getByLabelText('Status'), 'offline');
    expect(screen.getByText('Garage')).toBeInTheDocument();
    expect(screen.queryByText('Steckdose')).not.toBeInTheDocument();
  });

  it('zählt ausgewählte Geräte und hebt die Auswahl auf', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DevicesPage />);
    await screen.findByText('Keller-Licht');
    const rows = screen.getAllByRole('row').slice(1);
    await user.click(within(rows[0] as HTMLElement).getByRole('checkbox'));
    await user.click(within(rows[1] as HTMLElement).getByRole('checkbox'));
    expect(screen.getByText('2 ausgewählt')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Auswahl aufheben' }));
    await waitFor(() => expect(screen.queryByText('2 ausgewählt')).not.toBeInTheDocument());
  });

  it('zeigt einen Hinweis ohne Geräte', async () => {
    vi.mocked(api.devices).mockResolvedValue([]);
    renderWithProviders(<DevicesPage />);
    expect(await screen.findByText(/Noch keine Geräte gefunden/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Tests ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/web test
```
Erwartet: FAIL (Module fehlen).

- [ ] **Step 3: Komponenten implementieren**

`tasmota_manager/packages/web/src/features/devices/filter.ts`:
```ts
import type { Device } from '@tm/shared';

export type StatusFilter = 'all' | 'online' | 'offline' | 'auth';

export function filterDevices(devices: Device[], filter: { text: string; status: StatusFilter; tag: string }): Device[] {
  const query = filter.text.trim().toLowerCase();
  return devices.filter((d) => {
    if (filter.status === 'online' && !d.online) return false;
    if (filter.status === 'offline' && d.online) return false;
    if (filter.status === 'auth' && !d.authRequired) return false;
    if (filter.tag && !d.tags.includes(filter.tag)) return false;
    if (!query) return true;
    return [d.name, d.ip, d.hostname, d.mqttTopic, d.firmware, d.module, d.id].some((v) => v?.toLowerCase().includes(query));
  });
}
```

`tasmota_manager/packages/web/src/features/devices/format.ts`:
```ts
export function formatUptime(seconds: number | null): string {
  if (seconds == null) return '—';
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}
```

`tasmota_manager/packages/web/src/features/devices/StatusDot.tsx`:
```tsx
import type { Device } from '@tm/shared';
import { useT } from '@/lib/i18n';

export function StatusDot({ device }: { device: Device }) {
  const t = useT();
  const [color, label] = device.authRequired
    ? ['bg-amber-500', t('status.auth')]
    : device.online
      ? ['bg-emerald-500', t('status.online')]
      : ['bg-muted-foreground/40', t('status.offline')];
  return (
    <span className="inline-flex items-center gap-2" title={label}>
      <span className={`size-2.5 rounded-full ${color}`} />
      <span className="sr-only">{label}</span>
    </span>
  );
}
```

`tasmota_manager/packages/web/src/features/devices/columns.tsx`:
```tsx
import type { ColumnDef } from '@tanstack/react-table';
import type { Device } from '@tm/shared';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { useT } from '@/lib/i18n';
import { formatUptime } from './format';
import { StatusDot } from './StatusDot';

const dash = (v: string | number | null) => (v == null || v === '' ? '—' : v);

export function useDeviceColumns(): ColumnDef<Device>[] {
  const t = useT();
  return useMemo<ColumnDef<Device>[]>(
    () => [
      {
        id: 'select',
        header: ({ table }) => (
          <Checkbox
            checked={table.getIsAllRowsSelected() || (table.getIsSomeRowsSelected() && 'indeterminate')}
            onCheckedChange={(v) => table.toggleAllRowsSelected(Boolean(v))}
            aria-label={t('devices.selectAll')}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(v) => row.toggleSelected(Boolean(v))}
            onClick={(e) => e.stopPropagation()}
            aria-label={t('devices.selectRow')}
          />
        ),
        enableSorting: false,
        enableHiding: false,
      },
      { accessorKey: 'online', header: t('devices.col.status'), sortingFn: 'basic', cell: ({ row }) => <StatusDot device={row.original} /> },
      { accessorKey: 'name', header: t('devices.col.name'), cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
      {
        accessorKey: 'ip',
        header: t('devices.col.ip'),
        cell: ({ row }) =>
          row.original.ip ? (
            <a
              href={`http://${row.original.ip}`}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-2 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {row.original.ip}
            </a>
          ) : (
            '—'
          ),
      },
      { accessorKey: 'firmware', header: t('devices.col.firmware'), cell: ({ row }) => dash(row.original.firmware) },
      { accessorKey: 'module', header: t('devices.col.module'), cell: ({ row }) => dash(row.original.module) },
      {
        accessorKey: 'rssi',
        header: t('devices.col.rssi'),
        cell: ({ row }) => (row.original.rssi == null ? '—' : `${row.original.rssi} dBm`),
      },
      {
        id: 'channels',
        header: t('devices.col.channels'),
        accessorFn: (d) => d.channels.join(','),
        cell: ({ row }) => (
          <div className="flex gap-1">
            {row.original.channels.map((c) => (
              <Badge key={c} variant="outline">
                {c.toUpperCase()}
              </Badge>
            ))}
          </div>
        ),
      },
      {
        id: 'tags',
        header: t('devices.col.tags'),
        accessorFn: (d) => d.tags.join(','),
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>
        ),
      },
      { accessorKey: 'uptimeSec', header: t('devices.col.uptime'), cell: ({ row }) => formatUptime(row.original.uptimeSec) },
    ],
    [t],
  );
}
```

`tasmota_manager/packages/web/src/features/devices/DeviceTable.tsx`:
```tsx
import {
  type OnChangeFn,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { Device } from '@tm/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useT } from '@/lib/i18n';
import { useDeviceColumns } from './columns';

interface Props {
  devices: Device[];
  rowSelection: RowSelectionState;
  onRowSelectionChange: OnChangeFn<RowSelectionState>;
  onOpen: (id: string) => void;
}

const SORT_ICONS: Record<string, string> = { asc: ' ↑', desc: ' ↓' };

export function DeviceTable({ devices, rowSelection, onRowSelectionChange, onOpen }: Props) {
  const t = useT();
  const columns = useDeviceColumns();
  const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({ module: false, uptimeSec: false });
  const table = useReactTable({
    data: devices,
    columns,
    getRowId: (d) => d.id,
    state: { sorting, rowSelection, columnVisibility },
    enableRowSelection: true,
    onSortingChange: setSorting,
    onRowSelectionChange,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {t('devices.columns')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {table
              .getAllColumns()
              .filter((c) => c.getCanHide())
              .map((c) => (
                <DropdownMenuCheckboxItem key={c.id} checked={c.getIsVisible()} onCheckedChange={(v) => c.toggleVisibility(Boolean(v))}>
                  {typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    onClick={header.column.getToggleSortingHandler()}
                    className={header.column.getCanSort() ? 'cursor-pointer select-none' : undefined}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {SORT_ICONS[header.column.getIsSorted() || ''] ?? null}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                data-state={row.getIsSelected() ? 'selected' : undefined}
                className="cursor-pointer"
                onClick={() => onOpen(row.original.id)}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
```

`tasmota_manager/packages/web/src/features/devices/ScanButton.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScanProgress, StatusResponse } from '@tm/shared';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

export function ScanButton() {
  const t = useT();
  const qc = useQueryClient();
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.status });
  // Der Fortschritt kommt ausschließlich per WebSocket (applyMessage) in den Cache.
  const { data: progress } = useQuery<ScanProgress | null>({
    queryKey: ['scan'],
    queryFn: () => Promise.resolve(null),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const mutation = useMutation({
    mutationFn: () => api.scan(),
    onSuccess: () => {
      toast(t('devices.scanStarted'));
      qc.setQueryData<StatusResponse>(['status'], (s) => s && { ...s, scanning: true });
    },
    onError: (err) => toast.error(t('common.error', { message: err.message })),
  });
  const scanning = status?.scanning ?? false;
  return (
    <Button variant="outline" disabled={scanning || mutation.isPending} onClick={() => mutation.mutate()}>
      {scanning && progress ? t('devices.scanning', { scanned: progress.scanned, total: progress.total }) : t('devices.scan')}
    </Button>
  );
}
```

`tasmota_manager/packages/web/src/features/devices/AddDeviceDialog.tsx`:
```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

export function AddDeviceDialog() {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [ip, setIp] = useState('');
  const mutation = useMutation({
    mutationFn: (value: string) => api.addDevice(value),
    onSuccess: (device) => {
      toast.success(t('devices.add.success', { name: device.name }));
      void qc.invalidateQueries({ queryKey: ['devices'] });
      setOpen(false);
      setIp('');
    },
    onError: (err) => toast.error(t('common.error', { message: err.message })),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>{t('devices.add')}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('devices.add')}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate(ip.trim());
          }}
        >
          <Label htmlFor="add-device-ip">{t('devices.add.ip')}</Label>
          <Input id="add-device-ip" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.50" />
          <DialogFooter>
            <Button type="submit" disabled={!ip.trim() || mutation.isPending}>
              {t('devices.add.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

`tasmota_manager/packages/web/src/features/devices/DevicesPage.tsx` (vorerst ohne Detailansicht; `DeviceSheet` wird in Task 15 ergänzt):
```tsx
import { useQuery } from '@tanstack/react-query';
import type { RowSelectionState } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { selectClass } from '@/lib/styles';
import { AddDeviceDialog } from './AddDeviceDialog';
import { DeviceTable } from './DeviceTable';
import { type StatusFilter, filterDevices } from './filter';
import { ScanButton } from './ScanButton';

export function DevicesPage() {
  const t = useT();
  const { data: devices = [], isLoading } = useQuery({ queryKey: ['devices'], queryFn: api.devices });
  const [text, setText] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [tag, setTag] = useState('');
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [openId, setOpenId] = useState<string | null>(null);

  const allTags = useMemo(() => [...new Set(devices.flatMap((d) => d.tags))].sort(), [devices]);
  const visible = useMemo(() => filterDevices(devices, { text, status, tag }), [devices, text, status, tag]);
  const selectedCount = devices.filter((d) => rowSelection[d.id]).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold">{t('devices.title')}</h1>
        <ScanButton />
        <AddDeviceDialog />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder={t('devices.search')}
          aria-label={t('devices.search')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select
          aria-label={t('devices.filter.status')}
          className={selectClass}
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
        >
          <option value="all">{t('devices.filter.all')}</option>
          <option value="online">{t('devices.filter.online')}</option>
          <option value="offline">{t('devices.filter.offline')}</option>
          <option value="auth">{t('devices.filter.auth')}</option>
        </select>
        <select aria-label={t('devices.filter.tag')} className={selectClass} value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">{t('devices.filter.allTags')}</option>
          {allTags.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      {selectedCount > 0 && (
        <div className="flex items-center gap-3 rounded-md border bg-muted/50 px-3 py-2 text-sm">
          <span>{t('devices.selected', { count: selectedCount })}</span>
          <Button variant="ghost" size="sm" onClick={() => setRowSelection({})}>
            {t('devices.clearSelection')}
          </Button>
        </div>
      )}
      {!isLoading && devices.length === 0 ? (
        <p className="text-muted-foreground">{t('devices.empty')}</p>
      ) : (
        <DeviceTable devices={visible} rowSelection={rowSelection} onRowSelectionChange={setRowSelection} onOpen={setOpenId} />
      )}
      <span hidden data-open-device={openId ?? ''} />
    </div>
  );
}
```

`tasmota_manager/packages/web/src/App.tsx`: Ersetze `<main className="min-w-0 flex-1 space-y-4 p-6">{route}</main>` durch
```tsx
      <main className="min-w-0 flex-1 space-y-4 p-6">{route === 'devices' ? <DevicesPage /> : null}</main>
```
und ergänze den Import `import { DevicesPage } from '@/features/devices/DevicesPage';`.

- [ ] **Step 4: Tests, Typecheck und Build ausführen**

```bash
pnpm --filter @tm/web test && pnpm --filter @tm/web build
```
Erwartet: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A .
git commit -m "feat(web): add device overview with filters, selection, scan and manual add"
```

---

### Task 15: Gerätedetail mit Konsole

**Files:**
- Create: `tasmota_manager/packages/web/src/features/devices/Console.tsx`
- Create: `tasmota_manager/packages/web/src/features/devices/DeviceSheet.tsx`
- Modify: `tasmota_manager/packages/web/src/features/devices/DevicesPage.tsx`
- Test: `tasmota_manager/packages/web/src/features/devices/Console.test.tsx`
- Test: `tasmota_manager/packages/web/src/features/devices/DeviceSheet.test.tsx`

**Interfaces:**
- Consumes: `api`, `useT`, `renderWithProviders`, `makeDevice`, shadcn `Sheet`, `Card`, `Input`, `Label`, `Button`, `Badge`
- Produces: `Console({ deviceId })`, `DeviceSheet({ deviceId: string | null; onClose(): void; onSwitch(id: string): void })`

- [ ] **Step 1: Failing Tests schreiben**

`tasmota_manager/packages/web/src/features/devices/Console.test.tsx`:
```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { renderWithProviders } from '@/test/render';
import { Console } from './Console';

vi.mock('@/lib/api', () => ({ api: { command: vi.fn() }, ApiError: class extends Error {} }));

describe('Console', () => {
  it('sendet Befehle und zeigt Antworten im Verlauf', async () => {
    vi.mocked(api.command).mockResolvedValueOnce({ ok: true, channel: 'mqtt', response: { POWER: 'ON' } });
    const user = userEvent.setup();
    renderWithProviders(<Console deviceId="AABBCC112233" />);
    await user.type(screen.getByPlaceholderText('Befehl, z. B. Status 0'), 'Power ON{Enter}');
    expect(api.command).toHaveBeenCalledWith('AABBCC112233', 'Power ON');
    expect(await screen.findByText('Power ON')).toBeInTheDocument();
    expect(screen.getByText(/"POWER": "ON"/)).toBeInTheDocument();
    expect(screen.getByText('über MQTT')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Befehl, z. B. Status 0')).toHaveValue('');
  });

  it('zeigt Fehler mit Code', async () => {
    vi.mocked(api.command).mockResolvedValueOnce({ ok: false, code: 'rejected', message: 'Gerät lehnt den Befehl "Foo" ab' });
    const user = userEvent.setup();
    renderWithProviders(<Console deviceId="AABBCC112233" />);
    await user.type(screen.getByPlaceholderText('Befehl, z. B. Status 0'), 'Foo{Enter}');
    expect(await screen.findByText(/rejected/)).toBeInTheDocument();
  });
});
```

`tasmota_manager/packages/web/src/features/devices/DeviceSheet.test.tsx`:
```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { makeDevice } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { DeviceSheet } from './DeviceSheet';

vi.mock('@/lib/api', () => ({
  api: { devices: vi.fn(), device: vi.fn(), updateDevice: vi.fn(), removeDevice: vi.fn(), command: vi.fn() },
  ApiError: class extends Error {},
}));

describe('DeviceSheet', () => {
  beforeEach(() => {
    const device = makeDevice({ tags: ['Keller'] });
    vi.mocked(api.devices).mockResolvedValue([device]);
    vi.mocked(api.device).mockResolvedValue({ ...device, status: {} });
  });

  it('zeigt Gerätedaten', async () => {
    renderWithProviders(<DeviceSheet deviceId="AABBCC112233" onClose={vi.fn()} onSwitch={vi.fn()} />);
    // Der Statuspunkt steuert einen Screenreader-Text zum Überschriftennamen bei.
    expect(await screen.findByRole('heading', { name: /Keller-Licht/ })).toBeInTheDocument();
    expect(screen.getByText('keller-1234')).toBeInTheDocument();
    expect(screen.getByText('ESP8266EX')).toBeInTheDocument();
  });

  it('speichert Tags und Passwort', async () => {
    vi.mocked(api.updateDevice).mockResolvedValue(makeDevice({ tags: ['Keller', 'Licht'], hasPasswordOverride: true }));
    const user = userEvent.setup();
    renderWithProviders(<DeviceSheet deviceId="AABBCC112233" onClose={vi.fn()} onSwitch={vi.fn()} />);
    const tags = await screen.findByLabelText('Tags');
    await user.clear(tags);
    await user.type(tags, 'Keller, Licht');
    await user.type(screen.getByLabelText('Passwort nur für dieses Gerät'), 'geheim');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() =>
      expect(api.updateDevice).toHaveBeenCalledWith('AABBCC112233', { tags: ['Keller', 'Licht'], password: 'geheim' }),
    );
  });

  it('wechselt zum echten Gerät, wenn ein Platzhalter aufgelöst wird', async () => {
    const placeholder = makeDevice({ id: 'IP-10.0.0.9', name: '10.0.0.9', authRequired: true });
    vi.mocked(api.devices).mockResolvedValue([placeholder]);
    vi.mocked(api.device).mockResolvedValue({ ...placeholder, status: null });
    vi.mocked(api.updateDevice).mockResolvedValue(makeDevice({ id: 'AABBCC112233' }));
    const onSwitch = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<DeviceSheet deviceId="IP-10.0.0.9" onClose={vi.fn()} onSwitch={onSwitch} />);
    await user.type(await screen.findByLabelText('Passwort nur für dieses Gerät'), 'geheim');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith('AABBCC112233'));
  });
});
```

- [ ] **Step 2: Tests ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/web test
```
Erwartet: FAIL (`./Console` und `./DeviceSheet` fehlen).

- [ ] **Step 3: Konsole implementieren**

`tasmota_manager/packages/web/src/features/devices/Console.tsx`:
```tsx
import { useMutation } from '@tanstack/react-query';
import type { CommandResult } from '@tm/shared';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Entry {
  id: number;
  command: string;
  result: CommandResult;
}

let nextId = 0;

export function Console({ deviceId }: { deviceId: string }) {
  const t = useT();
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<Entry[]>([]);
  const push = (command: string, result: CommandResult) =>
    setHistory((h) => [...h, { id: nextId++, command, result }].slice(-50));
  const mutation = useMutation({
    mutationFn: (command: string) => api.command(deviceId, command),
    onSuccess: (result, command) => push(command, result),
    onError: (err, command) => push(command, { ok: false, code: 'unreachable', message: err.message }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const command = input.trim();
    if (!command) return;
    mutation.mutate(command);
    setInput('');
  };

  return (
    <div className="space-y-2">
      <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border bg-muted/30 p-2 font-mono text-xs">
        {history.map((entry) => (
          <div key={entry.id}>
            <div className="flex gap-2 font-semibold">
              <span>{entry.command}</span>
              {entry.result.ok && <span className="text-muted-foreground">{t('console.via', { channel: entry.result.channel.toUpperCase() })}</span>}
            </div>
            <pre className={`whitespace-pre-wrap ${entry.result.ok ? '' : 'text-destructive'}`}>
              {entry.result.ok ? JSON.stringify(entry.result.response, null, 2) : `${entry.result.code}: ${entry.result.message}`}
            </pre>
          </div>
        ))}
      </div>
      <form className="flex gap-2" onSubmit={submit}>
        <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('console.placeholder')} className="font-mono" />
        <Button type="submit" disabled={mutation.isPending}>
          {t('console.send')}
        </Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Detailansicht implementieren**

`tasmota_manager/packages/web/src/features/devices/DeviceSheet.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommandResult, Device, DeviceUpdateRequest } from '@tm/shared';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { Console } from './Console';
import { StatusDot } from './StatusDot';

interface Props {
  deviceId: string | null;
  onClose: () => void;
  onSwitch: (id: string) => void;
}

export function DeviceSheet({ deviceId, onClose, onSwitch }: Props) {
  return (
    <Sheet open={deviceId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {deviceId && <DeviceDetail deviceId={deviceId} onClose={onClose} onSwitch={onSwitch} />}
      </SheetContent>
    </Sheet>
  );
}

function DeviceDetail({ deviceId, onClose, onSwitch }: { deviceId: string; onClose: () => void; onSwitch: (id: string) => void }) {
  const t = useT();
  const qc = useQueryClient();
  // Metadaten aus der live aktualisierten Liste, der Rohstatus aus dem Detail-Endpunkt.
  const { data: fromList } = useQuery({
    queryKey: ['devices'],
    queryFn: api.devices,
    select: (list) => list.find((d) => d.id === deviceId),
  });
  const { data: detail } = useQuery({ queryKey: ['device', deviceId], queryFn: () => api.device(deviceId) });
  const device: Device | undefined = fromList ?? detail;

  const command = useMutation({
    mutationFn: (cmd: string) => api.command(deviceId, cmd),
    onSuccess: (result: CommandResult) =>
      result.ok ? toast.success(JSON.stringify(result.response)) : toast.error(t('common.error', { message: result.message })),
  });
  const remove = useMutation({
    mutationFn: () => api.removeDevice(deviceId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['devices'] });
      onClose();
    },
  });

  if (!device) return null;

  const info: Array<[string, string | number | null]> = [
    ['IP', device.ip],
    [t('detail.hostname'), device.hostname],
    [t('detail.topic'), device.mqttTopic],
    [t('devices.col.firmware'), device.firmware],
    [t('detail.variant'), device.variant],
    [t('devices.col.module'), device.module],
    [t('detail.chip'), device.chip],
    [t('detail.flash'), device.flashSize ? `${device.flashSize} KB` : null],
    [t('devices.col.channels'), device.channels.map((c) => c.toUpperCase()).join(', ')],
    [t('detail.lastSeen'), device.lastSeen ? new Date(device.lastSeen).toLocaleString() : null],
  ];

  return (
    <div className="space-y-6 p-4">
      <SheetHeader className="p-0">
        <SheetTitle className="flex items-center gap-2">
          <StatusDot device={device} />
          {device.name}
        </SheetTitle>
        <SheetDescription>{device.id}</SheetDescription>
      </SheetHeader>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t('detail.info')}</h3>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          {info.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{value || '—'}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t('detail.actions')}</h3>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => command.mutate('Power TOGGLE')}>
            {t('detail.toggle')}
          </Button>
          <Button
            variant="outline"
            onClick={() => window.confirm(t('detail.restartConfirm', { name: device.name })) && command.mutate('Restart 1')}
          >
            {t('detail.restart')}
          </Button>
          {device.ip && (
            <Button variant="outline" asChild>
              <a href={`http://${device.ip}`} target="_blank" rel="noreferrer">
                {t('detail.webui')}
              </a>
            </Button>
          )}
        </div>
      </section>

      <DeviceSettingsForm key={device.id} device={device} onSwitch={onSwitch} />

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t('console.title')}</h3>
        <Console deviceId={device.id} />
      </section>

      <Button
        variant="destructive"
        onClick={() => window.confirm(t('detail.removeConfirm', { name: device.name })) && remove.mutate()}
      >
        {t('detail.remove')}
      </Button>
    </div>
  );
}

function DeviceSettingsForm({ device, onSwitch }: { device: Device; onSwitch: (id: string) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [tags, setTags] = useState(device.tags.join(', '));
  const [password, setPassword] = useState('');
  const mutation = useMutation({
    mutationFn: (patch: DeviceUpdateRequest) => api.updateDevice(device.id, patch),
    onSuccess: (updated) => {
      toast.success(t('common.saved'));
      setPassword('');
      void qc.invalidateQueries({ queryKey: ['devices'] });
      if (updated.id !== device.id) onSwitch(updated.id);
    },
    onError: (err) => toast.error(t('common.error', { message: err.message })),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const patch: DeviceUpdateRequest = {
      tags: tags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    if (password) patch.password = password;
    mutation.mutate(patch);
  };

  return (
    <form className="space-y-3" onSubmit={submit}>
      <div className="space-y-1">
        <Label htmlFor="device-tags">{t('detail.tags')}</Label>
        <Input id="device-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('detail.tagsHint')} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="device-password">{t('detail.password')}</Label>
        <Input id="device-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {device.hasPasswordOverride && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t('detail.passwordSet')}</span>
            <Button type="button" variant="link" size="sm" onClick={() => mutation.mutate({ password: null })}>
              {t('detail.passwordClear')}
            </Button>
          </div>
        )}
      </div>
      <Button type="submit" disabled={mutation.isPending}>
        {t('common.save')}
      </Button>
    </form>
  );
}
```

- [ ] **Step 5: Detailansicht in die Übersicht einbinden**

In `tasmota_manager/packages/web/src/features/devices/DevicesPage.tsx`:
- Import ergänzen: `import { DeviceSheet } from './DeviceSheet';`
- Die Zeile `<span hidden data-open-device={openId ?? ''} />` ersetzen durch:
```tsx
      <DeviceSheet deviceId={openId} onClose={() => setOpenId(null)} onSwitch={setOpenId} />
```

- [ ] **Step 6: Tests, Typecheck und Build ausführen**

```bash
pnpm --filter @tm/web test && pnpm --filter @tm/web build
```
Erwartet: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A .
git commit -m "feat(web): add device detail sheet with console, tags and password override"
```

---

### Task 16: Einstellungen und MQTT-Hinweis

**Files:**
- Create: `tasmota_manager/packages/web/src/features/settings/SettingsPage.tsx`
- Create: `tasmota_manager/packages/web/src/components/MqttBanner.tsx`
- Modify: `tasmota_manager/packages/web/src/App.tsx`
- Test: `tasmota_manager/packages/web/src/features/settings/SettingsPage.test.tsx`
- Test: `tasmota_manager/packages/web/src/components/MqttBanner.test.tsx`

**Interfaces:**
- Consumes: `api`, `useT`, `CidrSchema` und die Typen `Settings`/`SettingsUpdateRequest` aus `@tm/shared`, shadcn `Card`, `Textarea`, `Input`, `Label`, `Checkbox`, `Button`
- Produces: `SettingsPage`, `MqttBanner`

- [ ] **Step 1: Failing Tests schreiben**

`tasmota_manager/packages/web/src/features/settings/SettingsPage.test.tsx`:
```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { renderWithProviders } from '@/test/render';
import { SettingsPage } from './SettingsPage';

vi.mock('@/lib/api', () => ({
  api: { settings: vi.fn(), updateSettings: vi.fn(), status: vi.fn() },
  ApiError: class extends Error {},
}));

const SETTINGS = {
  scanCidrs: ['192.168.1.0/24'],
  pollIntervalSec: 60,
  concurrency: { command: 10, ota: 3, backup: 5 },
  backupRetention: 10,
  firmwarePort: 8266,
  hasGlobalPassword: false,
};

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.mocked(api.settings).mockResolvedValue(SETTINGS);
    vi.mocked(api.status).mockResolvedValue({ mqtt: 'connected', version: 'x', scanning: false });
    vi.mocked(api.updateSettings).mockImplementation(async (patch) => ({ ...SETTINGS, ...patch, hasGlobalPassword: false }));
  });

  it('zeigt den MQTT-Status', async () => {
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText('Mit dem MQTT-Broker verbunden.')).toBeInTheDocument();
  });

  it('lehnt zu große Scan-Bereiche ab', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const cidrs = await screen.findByLabelText('Scan-Bereiche (CIDR)');
    await user.clear(cidrs);
    await user.type(cidrs, '10.0.0.0/8');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(screen.getByText('Ungültiger Bereich: 10.0.0.0/8')).toBeInTheDocument();
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it('speichert gültige Werte und ein neues Passwort', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const cidrs = await screen.findByLabelText('Scan-Bereiche (CIDR)');
    await user.clear(cidrs);
    await user.type(cidrs, '10.0.0.0/24{Enter}10.0.1.0/24');
    const poll = screen.getByLabelText('Abfrageintervall für HTTP-Geräte (Sekunden)');
    await user.clear(poll);
    await user.type(poll, '30');
    await user.type(screen.getByLabelText('Globales Web-Passwort'), 'geheim');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        scanCidrs: ['10.0.0.0/24', '10.0.1.0/24'],
        pollIntervalSec: 30,
        globalPassword: 'geheim',
      }),
    );
  });
});
```

`tasmota_manager/packages/web/src/components/MqttBanner.test.tsx`:
```tsx
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { renderWithProviders } from '@/test/render';
import { MqttBanner } from './MqttBanner';

vi.mock('@/lib/api', () => ({ api: { status: vi.fn() }, ApiError: class extends Error {} }));

describe('MqttBanner', () => {
  it('warnt, wenn der Broker nicht erreichbar ist', async () => {
    vi.mocked(api.status).mockResolvedValue({ mqtt: 'disconnected', version: 'x', scanning: false });
    renderWithProviders(<MqttBanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent('MQTT-Broker nicht erreichbar');
  });

  it('bleibt bei verbundenem Broker unsichtbar', async () => {
    vi.mocked(api.status).mockResolvedValue({ mqtt: 'connected', version: 'x', scanning: false });
    renderWithProviders(<MqttBanner />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Tests ausführen und Fehlschlag prüfen**

```bash
pnpm --filter @tm/web test
```
Erwartet: FAIL (Module fehlen).

- [ ] **Step 3: Implementieren**

`tasmota_manager/packages/web/src/components/MqttBanner.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

export function MqttBanner() {
  const t = useT();
  const { data } = useQuery({ queryKey: ['status'], queryFn: api.status });
  if (data?.mqtt !== 'disconnected') return null;
  return (
    <div role="alert" className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-2 text-sm">
      {t('mqtt.disconnected')}
    </div>
  );
}
```

`tasmota_manager/packages/web/src/features/settings/SettingsPage.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CidrSchema, type Settings, type SettingsUpdateRequest } from '@tm/shared';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

export function SettingsPage() {
  const t = useT();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.status });
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">{t('settings.title')}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.mqtt')}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">{status ? t(`mqtt.${status.mqtt}`) : '…'}</CardContent>
      </Card>
      {settings && <SettingsForm key={JSON.stringify(settings)} initial={settings} />}
    </div>
  );
}

function SettingsForm({ initial }: { initial: Settings }) {
  const t = useT();
  const qc = useQueryClient();
  const [cidrs, setCidrs] = useState(initial.scanCidrs.join('\n'));
  const [poll, setPoll] = useState(String(initial.pollIntervalSec));
  const [password, setPassword] = useState('');
  const [removePassword, setRemovePassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (patch: SettingsUpdateRequest) => api.updateSettings(patch),
    onSuccess: (saved) => {
      qc.setQueryData(['settings'], saved);
      toast.success(t('common.saved'));
    },
    onError: (err) => setError(err.message),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const list = cidrs
      .split(/[\n,]/)
      .map((c) => c.trim())
      .filter(Boolean);
    const invalid = list.find((c) => !CidrSchema.safeParse(c).success);
    if (invalid) return setError(t('settings.invalidCidr', { cidr: invalid }));
    const pollIntervalSec = Number(poll);
    if (!Number.isInteger(pollIntervalSec) || pollIntervalSec < 10 || pollIntervalSec > 3600) return setError(t('settings.invalidPoll'));
    setError(null);
    const patch: SettingsUpdateRequest = { scanCidrs: list, pollIntervalSec };
    if (removePassword) patch.globalPassword = null;
    else if (password) patch.globalPassword = password;
    mutation.mutate(patch);
  };

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="space-y-1">
        <Label htmlFor="settings-cidrs">{t('settings.cidrs')}</Label>
        <Textarea id="settings-cidrs" rows={4} className="font-mono" value={cidrs} onChange={(e) => setCidrs(e.target.value)} />
        <p className="text-xs text-muted-foreground">{t('settings.cidrsHint')}</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="settings-poll">{t('settings.poll')}</Label>
        <Input id="settings-poll" type="number" min={10} max={3600} value={poll} onChange={(e) => setPoll(e.target.value)} className="max-w-32" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="settings-password">{t('settings.password')}</Label>
        <Input
          id="settings-password"
          type="password"
          autoComplete="new-password"
          value={password}
          disabled={removePassword}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">{initial.hasGlobalPassword ? t('settings.passwordSet') : t('settings.passwordNone')}</p>
        {initial.hasGlobalPassword && (
          <div className="flex items-center gap-2 text-sm">
            <Checkbox id="settings-remove-password" checked={removePassword} onCheckedChange={(v) => setRemovePassword(Boolean(v))} />
            <Label htmlFor="settings-remove-password">{t('settings.passwordRemove')}</Label>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={mutation.isPending}>
        {t('common.save')}
      </Button>
    </form>
  );
}
```

`tasmota_manager/packages/web/src/App.tsx`: Imports ergänzen

```tsx
import { MqttBanner } from '@/components/MqttBanner';
import { SettingsPage } from '@/features/settings/SettingsPage';
```
und den `<main>`-Inhalt ersetzen durch
```tsx
      <main className="min-w-0 flex-1 space-y-4 p-6">
        <MqttBanner />
        {route === 'devices' ? <DevicesPage /> : <SettingsPage />}
      </main>
```

- [ ] **Step 4: Tests, Typecheck und Build ausführen**

```bash
pnpm --filter @tm/web test && pnpm --filter @tm/web build
```
Erwartet: PASS.

- [ ] **Step 5: Manuell gegen den echten Server prüfen**

```bash
pnpm build
TM_DATA_DIR=.data TM_PORT=8099 node packages/server/dist/server.js
```
Öffne `http://localhost:8099/` im Browser und prüfe: Die Geräteseite lädt, „Netzwerk scannen“ zeigt Fortschritt und findet Geräte im LAN, die Einstellungen lassen sich speichern, und `#/settings` bleibt auch nach einem Reload erhalten. Mit echten Tasmota-Geräten im Netz: Öffne die Detailansicht eines Geräts und sende `Status 0` über die Konsole. Beende den Server mit Strg+C.

- [ ] **Step 6: Commit**

```bash
git add -A .
git commit -m "feat(web): add settings page and MQTT outage banner"
```

---

### Task 17: App-Packaging und CI

**Files:**
- Create: `repository.yaml` (Repository-Wurzel)
- Create: `README.md` (Repository-Wurzel)
- Create: `tasmota_manager/config.yaml`
- Create: `tasmota_manager/Dockerfile`
- Create: `tasmota_manager/DOCS.md`
- Create: `tasmota_manager/translations/de.yaml`
- Create: `tasmota_manager/translations/en.yaml`
- Create: `.github/workflows/ci.yml` (Repository-Wurzel)

**Interfaces:**
- Consumes: `pnpm build` (Task 12–16), `packages/server/dist/server.js`, `packages/server/drizzle/`, `packages/web/dist/`
- Produces: ein Docker-Image, das `node /app/server/dist/server.js` startet und auf Port 8099 lauscht; ein HA-App-Repository, das per URL in Home Assistant hinzugefügt werden kann

- [ ] **Step 1: App-Metadaten anlegen**

`repository.yaml` (Repository-Wurzel, eine Ebene über `tasmota_manager/`):
```yaml
name: Tasmota Manager
maintainer: Sascha Knott <sascha@knott.ac>
```

`tasmota_manager/config.yaml`:
```yaml
name: Tasmota Manager
version: "0.1.0"
slug: tasmota_manager
description: Verwaltung und Batch-Konfiguration aller Tasmota-Geräte im Netzwerk
arch:
  - amd64
  - aarch64
ingress: true
ingress_port: 8099
panel_icon: mdi:lightning-bolt-circle
panel_title: Tasmota
host_network: true
services:
  - mqtt:want
options:
  log_level: info
schema:
  log_level: list(trace|debug|info|warn|error)
  mqtt_host: str?
  mqtt_port: port?
  mqtt_username: str?
  mqtt_password: password?
```

`tasmota_manager/translations/de.yaml`:
```yaml
configuration:
  log_level:
    name: Log-Level
    description: Detailgrad der Protokollausgabe.
  mqtt_host:
    name: MQTT-Host
    description: Nur setzen, wenn nicht der MQTT-Broker aus Home Assistant (z. B. Mosquitto) verwendet werden soll.
  mqtt_port:
    name: MQTT-Port
    description: Standard ist 1883.
  mqtt_username:
    name: MQTT-Benutzer
    description: Benutzername für den eigenen MQTT-Broker.
  mqtt_password:
    name: MQTT-Passwort
    description: Passwort für den eigenen MQTT-Broker.
```

`tasmota_manager/translations/en.yaml`:
```yaml
configuration:
  log_level:
    name: Log level
    description: Verbosity of the log output.
  mqtt_host:
    name: MQTT host
    description: Only set this if you do not want to use the MQTT broker provided by Home Assistant (e.g. Mosquitto).
  mqtt_port:
    name: MQTT port
    description: Defaults to 1883.
  mqtt_username:
    name: MQTT username
    description: Username for your own MQTT broker.
  mqtt_password:
    name: MQTT password
    description: Password for your own MQTT broker.
```

`tasmota_manager/DOCS.md`:
```markdown
# Tasmota Manager

Verwaltet alle Tasmota-Geräte im Netzwerk über eine moderne Oberfläche in der Home-Assistant-Seitenleiste.

## Geräte finden

- **MQTT:** Ist die Mosquitto-App (oder ein anderer MQTT-Dienst) in Home Assistant eingerichtet, verbindet sich die App automatisch. Geräte erscheinen über Tasmota-Discovery (`SetOption19 0`, Standard ab Tasmota 9.x).
- **HTTP:** Unter *Geräte → Netzwerk scannen* werden die in den Einstellungen hinterlegten Bereiche abgesucht (standardmäßig das Netz des Home-Assistant-Hosts). Einzelne Geräte lassen sich über *Gerät hinzufügen* per IP eintragen.

## Passwörter

Haben Geräte ein Web-Passwort, hinterlege ein globales Passwort in den Einstellungen. Weicht ein einzelnes Gerät davon ab, setzt du das Passwort in der Detailansicht des Geräts. Geräte, die ein Passwort verlangen, erscheinen mit dem Status „Passwort erforderlich“.

## Sicherheit

Die App braucht Host-Netzwerkzugriff, um Geräte im LAN zu erreichen. Die Oberfläche ist trotzdem nur über Home Assistant (Ingress) erreichbar. Direkte Anfragen an Port 8099 aus dem Netzwerk werden abgewiesen.
```

`README.md` (Repository-Wurzel):
```markdown
# Tasmota Manager für Home Assistant

Home-Assistant-App zur Verwaltung und Batch-Konfiguration von Tasmota-Geräten.

## Installation

Einstellungen → Apps → App-Store → ⋮ → Repositories → die URL dieses Repositorys hinzufügen, dann „Tasmota Manager“ installieren.

## Entwicklung

```bash
cd tasmota_manager
pnpm install
pnpm test
pnpm dev:server   # API auf :8099, Daten in tasmota_manager/.data
pnpm dev:web      # Vite auf :5173, leitet /api an :8099 weiter
```
```

- [ ] **Step 2: Dockerfile anlegen**

`tasmota_manager/Dockerfile`:
```dockerfile
# Der Supervisor übergibt BUILD_FROM/BUILD_VERSION; die App nutzt bewusst das offizielle Node-Image.
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++ \
 && npm install -g pnpm@10
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY packages ./packages
RUN pnpm build
# Laufzeitabhängigkeiten: nur das native better-sqlite3, alles andere steckt im Bundle.
RUN mkdir -p /out/server /out/web \
 && cp -r packages/server/dist packages/server/drizzle /out/server/ \
 && cp -r packages/web/dist /out/web/ \
 && cd /out/server \
 && echo '{"type":"module","dependencies":{"better-sqlite3":"^13.0.3"}}' > package.json \
 && npm install --omit=dev

FROM node:22-alpine
ARG BUILD_VERSION=dev
ENV NODE_ENV=production TM_VERSION=${BUILD_VERSION}
WORKDIR /app
COPY --from=build /out/ /app/
EXPOSE 8099
CMD ["node", "/app/server/dist/server.js"]
```

- [ ] **Step 3: Image bauen und starten**

Im Repository-Wurzelverzeichnis (bei Podman `podman` statt `docker`):
```bash
docker build -t tasmota-manager:dev tasmota_manager
docker run --rm -d --name tm-test -p 8099:8099 -e TM_DATA_DIR=/tmp/tm tasmota-manager:dev
sleep 3
curl -s localhost:8099/api/status
curl -s localhost:8099/ | head -c 200
docker stop tm-test
```
Erwartet: `{"mqtt":"disabled","version":"dev","scanning":false}` und der Anfang von `index.html` (`<!doctype html>`). Scheitert der Start mit einem fehlenden Modul, trage das Paket in `packages/server/build.mjs` unter `external` **und** im `echo`-Befehl des Dockerfiles bei den Laufzeitabhängigkeiten ein.

- [ ] **Step 4: Zugriffsschutz im Container prüfen**

```bash
docker run --rm -d --name tm-guard -p 8099:8099 -e TM_DATA_DIR=/tmp/tm -e SUPERVISOR_TOKEN=x tasmota-manager:dev
# Der vergebliche Supervisor-Aufruf für MQTT kann den Start bis zu 5 s verzögern.
sleep 7
curl -s -o /dev/null -w '%{http_code}\n' localhost:8099/api/status
docker stop tm-guard
```
Erwartet: `403`, weil die Anfrage von der Docker-Bridge-IP und nicht vom Ingress-Proxy kommt. Der Supervisor-Aufruf für MQTT schlägt dabei still fehl, und die App läuft im HTTP-Modus weiter.

- [ ] **Step 5: CI-Workflow anlegen**

`.github/workflows/ci.yml` (Repository-Wurzel):
```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: tasmota_manager
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
          cache-dependency-path: tasmota_manager/pnpm-lock.yaml
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build

  docker:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t tasmota-manager:ci tasmota_manager
```

- [ ] **Step 6: Gesamtprüfung**

```bash
cd tasmota_manager && pnpm typecheck && pnpm test && pnpm build && cd ..
```
Erwartet: alles PASS.

- [ ] **Step 7: Commit**

```bash
git add -A .
git commit -m "build: package as Home Assistant app with Dockerfile and CI"
```

- [ ] **Step 8: Installation in Home Assistant (manuell)**

Pushe das Repository in ein Git-Repository, das Home Assistant erreichen kann (GitHub oder Forgejo). Füge es dann unter *Einstellungen → Apps → App-Store → ⋮ → Repositories* hinzu und installiere „Tasmota Manager“. Der Supervisor baut das Image lokal, was auf einem Raspberry Pi einige Minuten dauert. Prüfe danach:
- Der Eintrag „Tasmota“ erscheint in der Seitenleiste, und die Oberfläche lädt im Ingress.
- Mit Mosquitto erscheinen MQTT-Geräte automatisch mit Kanal „MQTT“.
- Ein Scan findet HTTP-Geräte.
- Dark Mode und Sprache folgen den HA-Einstellungen.
