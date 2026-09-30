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
