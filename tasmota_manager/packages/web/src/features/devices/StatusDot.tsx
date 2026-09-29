import type { Device } from '@tm/shared';
import { useT } from '@/lib/i18n';

export function StatusDot({ device }: { device: Device }) {
  const t = useT();
  const [color, label] = device.authRequired
    ? ['bg-amber-500', t('status.auth')]
    : device.online
      ? ['bg-emerald-500', t('status.online')]
      : ['bg-muted-foreground/40', t('status.offline')];
  return (
    <span className="inline-flex items-center gap-2" title={label}>
      <span className={`size-2.5 rounded-full ${color}`} />
      <span className="sr-only">{label}</span>
    </span>
  );
}
