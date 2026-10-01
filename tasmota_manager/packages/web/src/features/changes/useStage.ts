import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { StageRequest } from '@tm/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { useT } from '@/lib/i18n';

/** Merkt Änderungen vor, meldet das Ergebnis und aktualisiert Puffer und Geräte. */
export function useStage(onDone?: () => void) {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: StageRequest) => api.stage(req),
    onSuccess: (result) => {
      toast.success(
        result.incompatible > 0
          ? t('devices.stagedIncompatible', { staged: result.staged, incompatible: result.incompatible })
          : result.skipped > 0
            ? t('devices.stagedSkipped', { staged: result.staged, skipped: result.skipped })
            : t('devices.staged', { staged: result.staged }),
      );
      void qc.invalidateQueries({ queryKey: ['changes'] });
      void qc.invalidateQueries({ queryKey: ['devices'] });
      onDone?.();
    },
    onError: (err: Error) => toast.error(t('common.error', { message: errorText(t, err) })),
  });
}
