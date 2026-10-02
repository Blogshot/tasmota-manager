import { z } from 'zod';
import { CAPABILITIES, type Timer } from './catalog';

export * from './catalog';

export const ChannelSchema = z.enum(['mqtt', 'http']);
export type Channel = z.infer<typeof ChannelSchema>;
export const CapabilitySchema = z.enum(CAPABILITIES);

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

export const HaLinkSchema = z.object({
  deviceId: z.string(),
  areaName: z.string().nullable(),
  /** In HA vergebener Gerätename (name_by_user); null, wenn nicht umbenannt. */
  nameByUser: z.string().nullable(),
  entities: z.array(z.object({ entityId: z.string(), name: z.string() })),
  automations: z.array(z.object({ id: z.string().nullable(), entityId: z.string(), name: z.string() })),
});
export type HaLink = z.infer<typeof HaLinkSchema>;

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
  setOption4: z.boolean(),
  /** Schaltzustand je Relais bzw. Licht (Index 0 = POWER/POWER1); leer, wenn das Gerät nichts schaltet. */
  power: z.array(z.boolean()),
  capabilities: z.array(CapabilitySchema),
  ha: HaLinkSchema.nullable(),
  nameSuggestion: z.string().nullable(),
  suggestionDismissed: z.boolean(),
  /** Nicht in Home Assistant und seit über 7 Tagen nicht gesehen (nur bei bestehender HA-Verbindung). */
  stale: z.boolean(),
  pendingCount: z.number(),
  pendingName: z.string().nullable(),
});
export type Device = z.infer<typeof DeviceSchema>;
export type DeviceDetail = Device & { status: unknown };

export const AddDeviceRequestSchema = z.object({ ip: z.ipv4() });
export type AddDeviceRequest = z.infer<typeof AddDeviceRequestSchema>;

export const DeviceUpdateRequestSchema = z.object({
  password: z.string().max(64).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  /** Namensvorschlag für dieses Gerät ausblenden (nur in der App, nicht auf dem Gerät). */
  suggestionDismissed: z.boolean().optional(),
});
export type DeviceUpdateRequest = z.infer<typeof DeviceUpdateRequestSchema>;

/** Live gelesener Wert einer Einstellung, in der Form, in der er im Puffer steht. */
export interface SettingValue {
  value: string | null;
}

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
  .refine((v) => (parseCidr(v)?.prefix ?? 0) >= MAX_SCAN_PREFIX, {
    message: 'invalid.cidr',
  });

export const ConcurrencySchema = z.object({
  command: z.int().min(1).max(50),
  ota: z.int().min(1).max(10),
  backup: z.int().min(1).max(20),
});

export const LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'nl'] as const;
export type Language = (typeof LANGUAGES)[number];
export const LanguageSettingSchema = z.enum(['auto', ...LANGUAGES]);
export type LanguageSetting = z.infer<typeof LanguageSettingSchema>;

/** Feste Auswahl oder – bei „auto" – die erkannte Sprache (z. B. "de-CH"), sonst Englisch. */
export function resolveLanguage(setting: LanguageSetting, detected: string | null | undefined): Language {
  if (setting !== 'auto') return setting;
  const prefix = (detected ?? '').toLowerCase().split(/[-_]/)[0];
  return LANGUAGES.find((l) => l === prefix) ?? 'en';
}

export const SettingsSchema = z.object({
  scanCidrs: z.array(CidrSchema).max(16),
  pollIntervalSec: z.int().min(10).max(3600),
  concurrency: ConcurrencySchema,
  backupRetention: z.int().min(1).max(100),
  firmwarePort: z.int().min(1024).max(65535),
  hasGlobalPassword: z.boolean(),
  language: LanguageSettingSchema,
});
export type Settings = z.infer<typeof SettingsSchema>;

export const SettingsUpdateRequestSchema = SettingsSchema.omit({ hasGlobalPassword: true })
  .partial()
  .extend({ globalPassword: z.string().max(64).nullable().optional() });
export type SettingsUpdateRequest = z.infer<typeof SettingsUpdateRequestSchema>;

/** Standort des Heims aus der HA-Konfiguration. */
export interface HaLocation {
  latitude: number;
  longitude: number;
}

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

export interface TelemetryValue {
  key: string;
  group: string;
  name: string;
  value: number | string;
  unit: string | null;
}

export interface DeviceTelemetry {
  updatedAt: string | null;
  values: TelemetryValue[];
  history: Record<string, Array<[number, number]>>;
}

export type TelemetrySummary = Record<string, TelemetryValue[]>;

export interface StatusResponse {
  mqtt: MqttStatus;
  version: string;
  scanning: boolean;
  /** null, wenn kein HA-Zugriff besteht oder HA keinen Standort kennt */
  haLocation: HaLocation | null;
  haSuggestions: HaSuggestions;
}

export interface ScanProgress {
  scanned: number;
  total: number;
  found: number;
}

export type WsMessage =
  | { type: 'device:updated'; device: Device }
  | { type: 'device:removed'; id: string }
  | { type: 'devices:stale' }
  | { type: 'mqtt:status'; status: MqttStatus }
  | ({ type: 'scan:progress' } & ScanProgress)
  | { type: 'scan:done'; found: number }
  | { type: 'changes:updated'; count: number }
  | { type: 'job:progress'; jobId: number; item: JobItem }
  | { type: 'job:done'; job: JobView }
  | { type: 'telemetry'; deviceId: string; updatedAt: string; headline: TelemetryValue[] };

export interface ApiErrorBody {
  code: string;
  message: string;
}

export const ChangeSourceSchema = z.enum(['suggestion', 'form', 'command', 'detail', 'rule', 'timer']);
export type ChangeSource = z.infer<typeof ChangeSourceSchema>;

export interface PendingChange {
  id: number;
  deviceId: string;
  kind: 'setting' | 'command';
  key: string | null;
  /** write-only-Werte als „••••" */
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
    message: 'invalid.noChanges',
  });
export type StageRequest = z.infer<typeof StageRequestSchema>;

export interface StageResult {
  staged: number;
  skipped: number;
  /** Geräte, bei denen mindestens eine Einstellung nicht zum Gerätetyp passte und übersprungen wurde. */
  incompatible: number;
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
