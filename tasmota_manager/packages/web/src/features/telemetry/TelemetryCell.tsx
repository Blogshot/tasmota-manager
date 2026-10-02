import { useQuery } from '@tanstack/react-query';
import type { TelemetryValue } from '@tm/shared';
import { Fragment } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { formatTelemetry, HistoryChart } from './charts';

export function useTelemetrySummary() {
  return useQuery({ queryKey: ['telemetry-summary'], queryFn: api.telemetrySummary });
}

function ChartFor({ deviceId, value }: { deviceId: string; value: TelemetryValue }) {
  const { data } = useQuery({ queryKey: ['telemetry', deviceId, 'live'], queryFn: () => api.telemetry(deviceId) });
  return <HistoryChart points={data?.history[value.key] ?? []} unit={value.unit} label={value.name} />;
}

/** Hauptwerte eines Geräts; ein Klick auf einen Wert zeigt den Verlauf der letzten 60 Minuten. */
export function TelemetryCell({ deviceId }: { deviceId: string }) {
  const lang = useLang();
  const { data } = useTelemetrySummary();
  const values = data?.[deviceId] ?? [];
  if (values.length === 0) return <>—</>;
  return (
    <div className="flex flex-wrap items-center gap-x-1">
      {values.map((value, index) => {
        const text = formatTelemetry(value.value, value.unit, lang);
        return (
          <Fragment key={value.key}>
            {index > 0 && <span className="text-muted-foreground">·</span>}
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={`${value.name}: ${text}`}
                  onClick={(e) => e.stopPropagation()}
                  className="rounded px-0.5 whitespace-nowrap underline-offset-2 hover:underline"
                >
                  {text}
                </button>
              </PopoverTrigger>
              <PopoverContent onClick={(e) => e.stopPropagation()}>
                <ChartFor deviceId={deviceId} value={value} />
              </PopoverContent>
            </Popover>
          </Fragment>
        );
      })}
    </div>
  );
}
