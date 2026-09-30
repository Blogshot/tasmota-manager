import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Device } from '@tm/shared';
import { Power } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const MAX_BUTTONS = 4;

/** Ein Button pro Relais bzw. Licht: zeigt den Zustand und schaltet sofort um (Bedienung, kein vorgemerkter Wert). */
export function PowerCell({ device }: { device: Device }) {
  const t = useT();
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (index: number) => api.command(device.id, `Power${index + 1} TOGGLE`),
    onSuccess: (result) => {
      if (!result.ok) toast.error(t('common.error', { message: result.message }));
      void qc.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (err: Error) => toast.error(t('common.error', { message: err.message })),
  });

  if (device.power.length === 0) return <>—</>;
  const disabled = !device.online || device.authRequired || toggle.isPending;
  const single = device.power.length === 1;
  const hidden = device.power.length - MAX_BUTTONS;

  return (
    <div className="flex items-center gap-1">
      {device.power.slice(0, MAX_BUTTONS).map((on, index) => (
        <button
          key={index}
          type="button"
          aria-pressed={on}
          title={t(on ? 'devices.power.on' : 'devices.power.off', { n: index + 1 })}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            toggle.mutate(index);
          }}
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-md border text-xs font-medium transition-colors disabled:opacity-50',
            on ? 'border-amber-500 bg-amber-500 text-white hover:bg-amber-600' : 'border-input text-muted-foreground hover:bg-accent',
          )}
        >
          {single ? <Power className="size-3.5" /> : index + 1}
        </button>
      ))}
      {hidden > 0 && <span className="text-xs text-muted-foreground">+{hidden}</span>}
    </div>
  );
}
