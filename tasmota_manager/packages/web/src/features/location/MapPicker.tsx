import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';

export interface MapPickerProps {
  /** Startpunkt; ohne ihn zeigt die Karte die ganze Welt. */
  center: { latitude: number; longitude: number } | null;
  onPick: (latitude: number, longitude: number) => void;
  label: string;
}

/** Weltkarte mit OpenStreetMap-Kacheln; ein Klick setzt den Marker und meldet die Koordinaten. */
export default function MapPicker({ center, onPick, label }: MapPickerProps) {
  const element = useRef<HTMLDivElement>(null);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    if (!element.current) return;
    const map = L.map(element.current, { worldCopyJump: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      // OSM blockiert Kachelabrufe ohne Referer. Home Assistant liefert Seiten mit „no-referrer“ aus;
      // pro Kachel senden wir deshalb wenigstens den Ursprung (ohne Pfad) mit.
      referrerPolicy: 'strict-origin-when-cross-origin',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
    }).addTo(map);
    // Kreis statt Standard-Marker: dessen Bilddateien findet Leaflet nach dem Bündeln nicht.
    const marker = L.circleMarker([0, 0], { radius: 7, color: '#d97706', fillOpacity: 0.8 });
    if (center) {
      map.setView([center.latitude, center.longitude], 12);
      marker.setLatLng([center.latitude, center.longitude]).addTo(map);
    } else {
      map.setView([20, 0], 1);
    }
    map.on('click', (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng.wrap();
      marker.setLatLng([lat, lng]).addTo(map);
      pick.current(lat, lng);
    });
    // Im Popover steht die Größe erst nach dem Öffnen fest.
    const timer = setTimeout(() => map.invalidateSize(), 50);
    return () => {
      clearTimeout(timer);
      map.remove();
    };
  }, [center]);

  return <div ref={element} role="application" aria-label={label} className="h-72 w-[22rem] max-w-[80vw] rounded-sm" />;
}
