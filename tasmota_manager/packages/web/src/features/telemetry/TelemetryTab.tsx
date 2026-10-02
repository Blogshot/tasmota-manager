import { useQuery } from '@tanstack/react-query';
import type { Device, TelemetryValue } from '@tm/shared';
import { useEffect, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api } from '@/lib/api';
import { useLang, useT } from '@/lib/i18n';
import { SignalStrength } from '../devices/signal';
import { formatTelemetry, HistoryChart, Sparkline } from './charts';

const DEVICE_GROUP = 'device';

/** Gruppen in Reihenfolge des ersten Auftretens, die Gruppe „device“ immer zuletzt. */
function groupValues(values: TelemetryValue[]): Array<[string, TelemetryValue[]]> {
  const groups = new Map<string, TelemetryValue[]>();
  for (const value of values) groups.set(value.group, [...(groups.get(value.group) ?? []), value]);
  const device = groups.get(DEVICE_GROUP);
  groups.delete(DEVICE_GROUP);
  return [...groups, ...(device ? ([[DEVICE_GROUP, device]] as Array<[string, TelemetryValue[]]>) : [])];
}

function useSecondsSince(iso: string | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!iso) return null;
  return Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
}

const isSignal = (v: TelemetryValue) => v.key === 'Wifi.Signal' && typeof v.value === 'number';

/** Alle Messwerte eines Geräts mit Verlauf; Werte kommen per MQTT, ohne MQTT per HTTP-Auffrischung. */
export function TelemetryTab({ device }: { device: Device }) {
  const t = useT();
  const lang = useLang();
  const httpOnly = !device.channels.includes('mqtt');
  const { data } = useQuery({
    // Eigener Schlüssel für die HTTP-Auffrischung: WS-Ereignisse invalidieren nur ['telemetry', id, 'live'],
    // sonst würde jede Antwort (die serverseitig Ereignisse auslöst) sofort die nächste Abfrage starten.
    queryKey: ['telemetry', device.id, httpOnly ? 'poll' : 'live'],
    queryFn: () => api.telemetry(device.id, httpOnly),
    refetchInterval: httpOnly ? 10_000 : false,
  });
  const seconds = useSecondsSince(data?.updatedAt);
  const groups = groupValues(data?.values ?? []);

  return (
    <div className="space-y-4">
      <div className="space-y-0.5 text-xs text-muted-foreground">
        {seconds !== null && <p>{t('telemetry.updated', { seconds })}</p>}
        {!device.online && <p>{t('telemetry.offline')}</p>}
      </div>
      {groups.length === 0 && data && <p className="text-sm text-muted-foreground">{t('telemetry.empty')}</p>}
      {groups.map(([group, values]) => (
        <section key={group} className="space-y-1">
          <h3 className="text-sm font-medium">{group === DEVICE_GROUP ? t('telemetry.device') : group}</h3>
          <ul className="divide-y rounded-md border">
            {values.map((value) => (
              <li key={value.key} className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
                <span className="min-w-0 truncate text-muted-foreground">{value.name}</span>
                <span className="flex items-center gap-3">
                  <Popover>
                    <PopoverTrigger asChild>
                      <button type="button" onClick={(e) => e.stopPropagation()} className="rounded px-0.5 text-right tabular-nums whitespace-nowrap underline-offset-2 hover:underline">
                        {isSignal(value) ? <SignalStrength dbm={value.value as number} stale={!device.online} /> : formatTelemetry(value.value, value.unit, lang)}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent onClick={(e) => e.stopPropagation()}>
                      <HistoryChart points={data?.history[value.key] ?? []} unit={value.unit} label={value.name} colorScale={isSignal(value) ? 'signal' : undefined} />
                    </PopoverContent>
                  </Popover>
                  {/* Feste Breite auch ohne Verlauf, damit Werte und Sparklines aller Zeilen untereinander stehen. */}
                  <span data-slot="sparkline" className="flex w-20 shrink-0 justify-end">
                    <Sparkline points={data?.history[value.key] ?? []} />
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
