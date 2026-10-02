import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Device } from '@tm/shared';
import { TriangleAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { useT } from '@/lib/i18n';

export function NameCell({ device }: { device: Device }) {
  const t = useT();
  const qc = useQueryClient();
  const stage = useMutation({
    mutationFn: () => api.stageSuggestions([device.id]),
    onSuccess: (result) => {
      toast.success(t('devices.staged', { staged: result.staged }));
      void qc.invalidateQueries({ queryKey: ['devices'] });
      void qc.invalidateQueries({ queryKey: ['changes'] });
    },
    onError: (err: Error) => toast.error(t('common.error', { message: errorText(t, err) })),
  });
  const dismiss = useMutation({
    mutationFn: (dismissed: boolean) => api.updateDevice(device.id, { suggestionDismissed: dismissed }),
    onSuccess: (_device, dismissed) => {
      void qc.invalidateQueries({ queryKey: ['devices'] });
      if (dismissed) {
        toast.success(t('devices.suggestion.dismissed'), {
          action: { label: t('common.undo'), onClick: () => dismiss.mutate(false) },
        });
      }
    },
    onError: (err: Error) => toast.error(t('common.error', { message: errorText(t, err) })),
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {device.pendingName ? (
        <>
          <span className="text-muted-foreground line-through">{device.name}</span>
          <span className="font-medium">{device.pendingName}</span>
        </>
      ) : (
        <span className="font-medium">{device.name}</span>
      )}
      {device.pendingCount > 0 && (
        <span title={t('devices.pendingDot', { count: device.pendingCount })} className="size-2 rounded-full bg-sky-500" />
      )}
      {device.nameSuggestion && (
        // Zwei Buttons in einem Label: Übernehmen (vormerken) und Ablehnen (nur in der App, nichts geht ans Gerät).
        <span className="inline-flex items-center rounded-md border border-amber-500/50 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-300">
          <button
            type="button"
            title={t('devices.suggestion.title')}
            disabled={stage.isPending}
            onClick={(e) => {
              e.stopPropagation();
              stage.mutate();
            }}
            className="inline-flex items-center gap-1 rounded-l-md py-0.5 pl-1.5 pr-1 hover:bg-amber-500/20"
          >
            <TriangleAlert className="size-3" aria-hidden />
            {device.nameSuggestion}
          </button>
          <button
            type="button"
            title={t('devices.suggestion.dismiss', { name: device.nameSuggestion })}
            aria-label={t('devices.suggestion.dismiss', { name: device.nameSuggestion })}
            disabled={dismiss.isPending}
            onClick={(e) => {
              e.stopPropagation();
              dismiss.mutate(true);
            }}
            className="inline-flex items-center self-stretch rounded-r-md px-1 text-red-600 hover:bg-red-500/15 dark:text-red-400"
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      )}
      {device.stale && (
        <Badge variant="outline" title={t('devices.staleTitle')} className="text-muted-foreground">
          {t('devices.stale')}
        </Badge>
      )}
      {device.setOption4 && (
        <Badge variant="outline" title={t('devices.so4')}>
          SO4
        </Badge>
      )}
    </div>
  );
}
