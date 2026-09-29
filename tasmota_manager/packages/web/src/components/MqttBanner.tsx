import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

export function MqttBanner() {
  const t = useT();
  const { data } = useQuery({ queryKey: ['status'], queryFn: api.status });
  if (data?.mqtt !== 'disconnected') return null;
  return (
    <div role="alert" className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-2 text-sm">
      {t('mqtt.disconnected')}
    </div>
  );
}
