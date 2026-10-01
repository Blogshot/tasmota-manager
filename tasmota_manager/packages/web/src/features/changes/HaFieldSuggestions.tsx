import { useQuery } from '@tanstack/react-query';
import type { HaSuggestions } from '@tm/shared';
import { House } from 'lucide-react';
import { api } from '@/lib/api';
import { type Translate, useT } from '@/lib/i18n';

interface Suggestion {
  label: string;
  values: Record<string, string>;
}

function suggestionFor(key: string, s: HaSuggestions, t: Translate): Suggestion | null {
  switch (key) {
    case 'Timezone': {
      if (!s.timezone) return null;
      const values: Record<string, string> = { Timezone: s.timezone.timezone };
      if (s.timezone.timeStd) values.TimeStd = s.timezone.timeStd;
      if (s.timezone.timeDst) values.TimeDst = s.timezone.timeDst;
      return { label: t('suggest.timezone', { zone: s.timezone.zone }), values };
    }
    case 'NtpServer1':
      return { label: t('suggest.ntp', { server: s.ntpServer }), values: { NtpServer1: s.ntpServer } };
    case 'MqttHost':
      return s.mqtt
        ? { label: t('suggest.mqtt', { host: s.mqtt.host, port: s.mqtt.port }), values: { MqttHost: s.mqtt.host, MqttPort: String(s.mqtt.port) } }
        : null;
    case 'MqttUser':
      return s.mqttUser ? { label: t('suggest.mqttUser', { user: s.mqttUser }), values: { MqttUser: s.mqttUser } } : null;
    case 'SetOption8':
      return s.fahrenheit === null
        ? null
        : { label: t('suggest.unit', { unit: s.fahrenheit ? '°F' : '°C' }), values: { SetOption8: s.fahrenheit ? '1' : '0' } };
    default:
      return null;
  }
}

/** Vorschlag aus Home Assistant für ein Feld; füllt nur Felder, die im Formular sichtbar sind. */
export function HaFieldSuggestions({
  fieldKey,
  visibleKeys,
  onFill,
}: {
  fieldKey: string;
  visibleKeys: Set<string>;
  onFill: (values: Record<string, string>) => void;
}) {
  const t = useT();
  const { data } = useQuery({ queryKey: ['status'], queryFn: api.status });
  const s = data?.haSuggestions;
  const suggestion = s ? suggestionFor(fieldKey, s, t) : null;
  if (!suggestion) return null;
  const values = Object.fromEntries(Object.entries(suggestion.values).filter(([k]) => visibleKeys.has(k)));
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs hover:bg-accent"
      onClick={() => onFill(values)}
    >
      <House className="size-3" aria-hidden />
      {suggestion.label}
    </button>
  );
}
