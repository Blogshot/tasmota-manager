import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Device } from '@tm/shared';
import { TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
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
    onError: (err: Error) => toast.error(t('common.error', { message: err.message })),
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
        <button
          type="button"
          title={t('devices.suggestion.title')}
          disabled={stage.isPending}
          onClick={(e) => {
            e.stopPropagation();
            stage.mutate();
          }}
          className="inline-flex items-center gap-1 rounded-md border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
        >
          <TriangleAlert className="size-3" aria-hidden />
          {device.nameSuggestion}
        </button>
      )}
      {device.setOption4 && (
        <Badge variant="outline" title={t('devices.so4')}>
          SO4
        </Badge>
      )}
    </div>
  );
}
