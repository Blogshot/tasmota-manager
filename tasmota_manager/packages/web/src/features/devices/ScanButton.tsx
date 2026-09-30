import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScanProgress, StatusResponse } from '@tm/shared';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { useT } from '@/lib/i18n';

export function ScanButton() {
  const t = useT();
  const qc = useQueryClient();
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.status });
  // Der Fortschritt kommt ausschließlich per WebSocket (applyMessage) in den Cache.
  const { data: progress } = useQuery<ScanProgress | null>({
    queryKey: ['scan'],
    queryFn: () => Promise.resolve(null),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const mutation = useMutation({
    mutationFn: () => api.scan(),
    onSuccess: () => {
      toast(t('devices.scanStarted'));
      qc.setQueryData<StatusResponse>(['status'], (s) => s && { ...s, scanning: true });
    },
    onError: (err) => toast.error(t('common.error', { message: errorText(t, err) })),
  });
  const scanning = status?.scanning ?? false;
  return (
    <Button variant="outline" disabled={scanning || mutation.isPending} onClick={() => mutation.mutate()}>
      {scanning && progress ? t('devices.scanning', { scanned: progress.scanned, total: progress.total }) : t('devices.scan')}
    </Button>
  );
}
