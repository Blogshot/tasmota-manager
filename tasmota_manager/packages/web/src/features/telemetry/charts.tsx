import { type PointerEvent, useMemo, useRef, useState } from 'react';
import { useLang, useT } from '@/lib/i18n';

type Points = Array<[number, number]>;
const NARROW = '\u202F';

export function formatTelemetry(value: number | string, unit: string | null, lang: string): string {
  if (typeof value === 'string') return value;
  const text = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 }).format(value);
  return unit ? `${text}${NARROW}${unit}` : text;
}

function scale(points: Points, width: number, height: number, pad: number, domain?: [number, number]) {
  const ts = points.map(([t]) => t);
  const vs = points.map(([, v]) => v);
  const t0 = domain ? domain[0] : Math.min(...ts);
  const t1 = domain ? domain[1] : Math.max(...ts);
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

const WINDOW_MS = 3_600_000;

export function HistoryChart({ points: all, unit, label, now }: { points: Points; unit: string | null; label: string; now?: number }) {
  const t = useT();
  const lang = useLang();
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 320;
  const H = 140;
  const PAD = 8;
  const end = now ?? Date.now();
  const points = useMemo(() => all.filter(([pt]) => pt >= end - WINDOW_MS && pt <= end), [all, end]);
  const s = useMemo(() => (points.length >= 2 ? scale(points, W, H, PAD, [end - WINDOW_MS, end]) : null), [points, end]);
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
          <text x={PAD} y={PAD + 8} fontSize={10} className="fill-muted-foreground">
            {fmt(s.v1)}
          </text>
          <text x={PAD} y={H - PAD - 4} fontSize={10} className="fill-muted-foreground">
            {fmt(s.v0)}
          </text>
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
