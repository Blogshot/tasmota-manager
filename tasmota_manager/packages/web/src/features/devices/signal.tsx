import type { CSSProperties } from 'react';
import { formatTelemetry } from '@/features/telemetry/charts';
import { useLang, useT } from '@/lib/i18n';
import { signalBars, signalColor, signalLevel } from '@/lib/signal';
import { cn } from '@/lib/utils';

export { SIGNAL_STOPS, signalBars, signalColor, signalLevel } from '@/lib/signal';

/** WLAN-Stärke mit Balken und eingefärbtem Wert; `stale` (Gerät offline) graut den letzten Wert aus. */
export function SignalStrength({ dbm, stale = false }: { dbm: number; stale?: boolean }) {
  const t = useT();
  const lang = useLang();
  const value = formatTelemetry(dbm, 'dBm', lang);
  const bars = signalBars(dbm);
  const style = stale ? undefined : ({ '--signal-light': signalColor(dbm, 'light'), '--signal-dark': signalColor(dbm, 'dark') } as CSSProperties);
  return (
    <span
      aria-label={`${t(signalLevel(dbm))} (${value})`}
      title={`${t(signalLevel(dbm))} (${value})`}
      style={style}
      className={cn('inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums', stale ? 'text-muted-foreground' : 'text-(--signal-light) dark:text-(--signal-dark)')}
    >
      <svg width={14} height={12} viewBox="0 0 14 12" aria-hidden className="shrink-0">
        {[0, 1, 2, 3].map((i) => (
          <rect
            key={i}
            data-bar={i < bars ? 'on' : 'off'}
            x={i * 3.5}
            y={9 - i * 3}
            width={2.5}
            height={3 + i * 3}
            rx={0.5}
            fill="currentColor"
            opacity={i < bars ? 1 : 0.25}
          />
        ))}
      </svg>
      {value}
    </span>
  );
}
