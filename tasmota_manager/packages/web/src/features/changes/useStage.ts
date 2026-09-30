import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { StageRequest } from '@tm/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

/** Merkt Änderungen vor, meldet das Ergebnis und aktualisiert Puffer und Geräte. */
export function useStage(onDone?: () => void) {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: StageRequest) => api.stage(req),
    onSuccess: (result) => {
      toast.success(
        result.skipped > 0
          ? t('devices.stagedSkipped', { staged: result.staged, skipped: result.skipped })
          : t('devices.staged', { staged: result.staged }),
      );
      void qc.invalidateQueries({ queryKey: ['changes'] });
      void qc.invalidateQueries({ queryKey: ['devices'] });
      onDone?.();
    },
    onError: (err: Error) => toast.error(t('common.error', { message: err.message })),
  });
}
