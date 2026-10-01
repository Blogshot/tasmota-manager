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
  if (def.kind === 'dimmerRange') return isObj(raw) ? `${raw.Min},${raw.Max}` : null;
  if (def.kind === 'timeRule') {
    if (!isObj(raw)) return null;
    return [raw.Hemisphere, raw.Week, raw.Month, raw.Day, raw.Hour, raw.Offset].map((v) => String(v)).join(',');
  }
  if (isObj(raw)) return null;
  return def.kind === 'bool' ? onOff(raw) : String(raw);
}

const leadingNumber = (value: string): number => Number.parseFloat(/-?\d+(\.\d+)?/.exec(value)?.[0] ?? 'NaN');
const normalizeRule = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

/** Zeitzone in Minuten: „1", „+1" und „+01:00" sind dasselbe. 99 (Sommerzeitregeln) ergibt einen Wert außerhalb jeder echten Zeitzone. */
function timezoneMinutes(value: string): number | null {
  const match = /^([+-]?)(\d{1,2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === '-' ? -minutes : minutes;
}

export function valuesEqual(def: SettingDef, expected: string, actual: string | null): boolean {
  if (actual === null) return false;
  switch (def.kind) {
    case 'int':
      return leadingNumber(expected) === leadingNumber(actual);
    case 'bool':
      return onOff(expected) !== null && onOff(expected) === onOff(actual);
    case 'coord':
      return Math.abs(Number(expected) - Number(actual)) < 1e-4;
    case 'timezone': {
      const minutes = timezoneMinutes(expected);
      return minutes !== null && minutes === timezoneMinutes(actual);
    }
    case 'dimmerRange':
    case 'timeRule': {
      const parts = (v: string) => v.split(',').map((p) => Number(p.trim()));
      const a = parts(expected);
      const b = parts(actual);
      return a.length === b.length && a.every((n, i) => Number.isFinite(n) && n === b[i]);
    }
    case 'decimal':
      return Math.abs(Number(expected) - Number(actual)) < 0.05;
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
