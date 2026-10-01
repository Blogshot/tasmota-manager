import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { useT } from '@/lib/i18n';

interface Props {
  deviceIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStaged: () => void;
}

export function FastRuleDialog({ deviceIds, open, onOpenChange, onStaged }: Props) {
  const t = useT();
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: ['fast-rule', deviceIds],
    queryFn: () => api.fastRulePreview(deviceIds),
    enabled: open,
    staleTime: 0,
  });
  const ready = (preview.data ?? []).filter((p) => p.reason === 'ok').map((p) => p.deviceId);
  const stage = useMutation({
    mutationFn: () => api.fastRuleStage(ready),
    onSuccess: (result) => {
      toast.success(t('devices.staged', { staged: result.staged }));
      void qc.invalidateQueries({ queryKey: ['changes'] });
      void qc.invalidateQueries({ queryKey: ['devices'] });
      onStaged();
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(t('common.error', { message: errorText(t, err) })),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('fastRule.title')}</DialogTitle>
          <DialogDescription>{t('fastRule.description')}</DialogDescription>
        </DialogHeader>
        {!preview.data ? (
          <p className="text-sm text-muted-foreground">{t('fastRule.loading')}</p>
        ) : (
          <ul className="space-y-3 text-sm">
            {preview.data.map((p) => (
              <li key={p.deviceId} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{p.deviceName}</span>
                  {p.reason === 'ok' && p.slot && <span className="text-xs text-muted-foreground">{t('fastRule.slot', { slot: p.slot })}</span>}
                </div>
                {p.reason === 'ok' && p.rule ? (
                  <code className="block break-all rounded bg-muted px-2 py-1 text-xs">{p.rule}</code>
                ) : (
                  <p className="text-xs text-amber-700 dark:text-amber-300">{t(`fastRule.${p.reason}` as 'fastRule.noSensors')}</p>
                )}
                {p.omitted.length > 0 && (
                  <p className="text-xs text-muted-foreground">{t('fastRule.omitted', { blocks: p.omitted.join(', ') })}</p>
                )}
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button type="button" disabled={ready.length === 0 || stage.isPending} onClick={() => stage.mutate()}>
            {t('fastRule.stage')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
