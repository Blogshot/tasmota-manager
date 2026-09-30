import { z } from 'zod';

export type SettingKind = 'text' | 'int' | 'bool' | 'coord' | 'timezone' | 'rule' | 'timer';
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

/**
 * Validierungstexte sind sprachneutrale Schlüssel mit Parametern (`invalid.range|0|5`).
 * Die Oberfläche übersetzt sie; in Logs und API-Antworten bleiben sie lesbar.
 */
export const issue = (key: string, ...args: Array<string | number>): string => [`invalid.${key}`, ...args].join('|');

const text = (max: number) => z.string().trim().min(1).max(max);
// Werte mit Neustart landen gebündelt in einem Backlog; ein Semikolon würde dort einen eigenen Befehl einschleusen.
const noSemicolon = (schema: z.ZodString) => schema.refine((v) => !v.includes(';'), { message: issue('semicolon') });
const int = (min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^-?\d+$/, { message: issue('int') })
    .refine((v) => Number(v) >= min && Number(v) <= max, { message: issue('range', min, max) });
const bool = z.string().regex(/^[01]$/, { message: issue('bool') });
const coord = (limit: number) =>
  z
    .string()
    .trim()
    .regex(/^-?\d{1,3}(\.\d{1,6})?$/, { message: issue('decimal') })
    .refine((v) => Math.abs(Number(v)) <= limit, { message: issue('maxAbs', limit) });

// Die Firmware speichert Minuten: ein „-" bedeutet +12 h. Eine Uhrzeit mit Minus oder ein Versatz ab 12 h käme deshalb
// als anderer Wert zurück und würde beim Prüfen als Abweichung gelten.
export const TimerSchema = z
  .object({
    Enable: z.int().min(0).max(1),
    Mode: z.int().min(0).max(2),
    Time: z.string().regex(/^[+-]?([01]\d|2[0-3]):[0-5]\d$/),
    Window: z.int().min(0).max(15),
    Days: z.string().regex(/^[01]{7}$/),
    Repeat: z.int().min(0).max(1),
    Output: z.int().min(1).max(16),
    Action: z.int().min(0).max(3),
  })
  .refine((t) => t.Mode !== 0 || !t.Time.startsWith('-'), { path: ['Time'], message: issue('timeNoSign') })
  .refine((t) => t.Mode === 0 || Number(t.Time.replace(/^[+-]/, '').slice(0, 2)) <= 11, {
    path: ['Time'],
    message: issue('offsetMax'),
  });
export type Timer = z.infer<typeof TimerSchema>;

export const DEFAULT_TIMER: Timer = { Enable: 0, Mode: 0, Time: '00:00', Window: 0, Days: '0000000', Repeat: 0, Output: 1, Action: 0 };

/** Tasmota meldet Wochentage als „1111111" oder „-MTWTF-"; intern gilt „0"/„1" ab Sonntag. */
export function normalizeDays(value: unknown): string {
  const s = typeof value === 'string' ? value : '';
  if (s.length !== 7) return DEFAULT_TIMER.Days;
  return [...s].map((c) => (c === '0' || c === '-' ? '0' : '1')).join('');
}

/** Tasmota meldet einen positiven Versatz und Uhrzeiten ohne Vorzeichen; ein führendes „+" trägt keine Information. */
export function normalizeTimerTime(time: string): string {
  return time.replace(/^\+/, '');
}

export function normalizeTimer(raw: Record<string, unknown>): Timer {
  const n = (v: unknown, fallback: number) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);
  return {
    Enable: n(raw.Enable, 0),
    Mode: n(raw.Mode, 0),
    Time: typeof raw.Time === 'string' ? normalizeTimerTime(raw.Time) : DEFAULT_TIMER.Time,
    Window: n(raw.Window, 0),
    Days: normalizeDays(raw.Days),
    Repeat: n(raw.Repeat, 0),
    Output: n(raw.Output, 1),
    Action: n(raw.Action, 0),
  };
}

// Vorgemerkt und gesendet wird die normalisierte Form, also genau das, was das Gerät danach zurückmeldet.
const timerValue = z.string().transform((v, ctx) => {
  let parsed: ReturnType<typeof TimerSchema.safeParse> | null = null;
  try {
    parsed = TimerSchema.safeParse(JSON.parse(v));
  } catch {
    // kein JSON
  }
  if (!parsed?.success) {
    ctx.issues.push({ code: 'custom', message: issue('timer'), input: v });
    return z.NEVER;
  }
  return JSON.stringify(normalizeTimer(parsed.data));
});
const ruleText = z.string().max(MAX_RULE_LENGTH, { message: issue('maxLength', MAX_RULE_LENGTH) });

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
    'timezone',
    z
      .string()
      .trim()
      .regex(/^(99|[+-]?\d{1,2}|[+-]\d{1,2}:\d{2})$/, { message: issue('timezone') }),
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
  if (!Object.hasOwn(STATUS_READERS, key)) return null;
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
    if (!Object.hasOwn(values, key)) {
      unknown ??= key;
      return '';
    }
    return values[key] ?? '';
  });
  return unknown ? { ok: false, unknown } : { ok: true, value };
}
