import { useQuery } from '@tanstack/react-query';
import { House, MapPinned } from 'lucide-react';
import { Suspense, lazy, useMemo, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

// Leaflet wird erst geladen, wenn jemand die Karte öffnet.
const MapPicker = lazy(() => import('./MapPicker'));

/** Tasmota nimmt höchstens 6 Nachkommastellen; 5 sind rund 1 m und reichen für Sonnenzeiten. */
export const formatCoord = (value: number): string => value.toFixed(5);

interface Props {
  latitude: string;
  longitude: string;
  onPick: (latitude: string, longitude: string) => void;
}

const chip = 'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs hover:bg-accent';

/** Vorschlag aus Home Assistant und Kartenauswahl für Breiten- und Längengrad. */
export function LocationTools({ latitude, longitude, onPick }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.status });
  const home = status?.haLocation ?? null;
  const lat = Number(latitude);
  const lon = Number(longitude);
  const typed = latitude.trim() !== '' && longitude.trim() !== '' && Number.isFinite(lat) && Number.isFinite(lon);
  const center = useMemo(() => (typed ? { latitude: lat, longitude: lon } : home), [typed, lat, lon, home]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {home && (
        <button
          type="button"
          className={chip}
          title={t('location.fromHaTitle')}
          onClick={() => onPick(formatCoord(home.latitude), formatCoord(home.longitude))}
        >
          <House className="size-3" aria-hidden />
          {t('location.fromHa', { lat: formatCoord(home.latitude), lon: formatCoord(home.longitude) })}
        </button>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={chip}>
            <MapPinned className="size-3" aria-hidden />
            {t('location.map')}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="space-y-1">
          <p className="text-xs text-muted-foreground">{t('location.mapHint')}</p>
          {open && (
            <Suspense fallback={<div className="h-72 w-[22rem] max-w-[80vw]" />}>
              <MapPicker
                center={center}
                label={t('location.map')}
                onPick={(la, lo) => onPick(formatCoord(la), formatCoord(lo))}
              />
            </Suspense>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
