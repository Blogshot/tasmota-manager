import type { MessageKey } from './messages';

/** Stützpunkte des Farbverlaufs: hell = Text auf Weiß (Tailwind 700), dunkel = Dark Mode (Tailwind 400). */
export const SIGNAL_STOPS = [
  { dbm: -50, light: '#15803d', dark: '#4ade80' },
  { dbm: -60, light: '#4d7c0f', dark: '#a3e635' },
  { dbm: -70, light: '#b45309', dark: '#fbbf24' },
  { dbm: -80, light: '#c2410c', dark: '#fb923c' },
  { dbm: -90, light: '#b91c1c', dark: '#f87171' },
] as const;

export type SignalMode = 'light' | 'dark';

/** Balkenzahl 1–4 nach der üblichen WLAN-Faustregel. */
export function signalBars(dbm: number): 1 | 2 | 3 | 4 {
  if (dbm >= -55) return 4;
  if (dbm >= -67) return 3;
  if (dbm >= -75) return 2;
  return 1;
}

const LEVELS: Record<1 | 2 | 3 | 4, MessageKey> = { 4: 'signal.excellent', 3: 'signal.good', 2: 'signal.fair', 1: 'signal.weak' };

export function signalLevel(dbm: number): MessageKey {
  return LEVELS[signalBars(dbm)];
}

/** Farbe stufenlos zwischen den Stützpunkten, gemischt in OKLCH. */
export function signalColor(dbm: number, mode: SignalMode): string {
  const first = SIGNAL_STOPS[0];
  const last = SIGNAL_STOPS[SIGNAL_STOPS.length - 1]!;
  if (dbm >= first.dbm) return first[mode];
  if (dbm <= last.dbm) return last[mode];
  for (let i = 0; i < SIGNAL_STOPS.length - 1; i++) {
    const upper = SIGNAL_STOPS[i]!;
    const lower = SIGNAL_STOPS[i + 1]!;
    if (dbm > lower.dbm) {
      if (dbm === upper.dbm) return upper[mode];
      const share = Math.round(((dbm - lower.dbm) / (upper.dbm - lower.dbm)) * 100);
      return `color-mix(in oklch, ${upper[mode]} ${share}%, ${lower[mode]})`;
    }
  }
  return last[mode];
}
