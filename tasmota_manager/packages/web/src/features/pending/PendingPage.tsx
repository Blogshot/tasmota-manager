import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PendingChange, PendingDevice, RuleState, TimersState } from '@tm/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { settingLabel } from '@/features/changes/labels';
import { api } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { useT } from '@/lib/i18n';
import { JobProgress } from './JobProgress';
import { liveKind, liveValue } from './liveValue';

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['changes'] });
    void qc.invalidateQueries({ queryKey: ['devices'] });
  };
}

export function PendingPage() {
  const t = useT();
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  const { data: groups = [] } = useQuery({ queryKey: ['changes'], queryFn: api.changes });
  const { data: jobData } = useQuery({ queryKey: ['job'], queryFn: api.currentJob });
  const job = jobData?.job ?? null;
  const running = job?.status === 'running';
  const onError = (err: Error) => toast.error(t('common.error', { message: errorText(t, err) }));

  const apply = useMutation({
    mutationFn: (deviceIds?: string[]) => api.apply(deviceIds),
    onSuccess: (started) => {
      qc.setQueryData(['job'], { job: started });
      toast.success(t('pending.started'));
    },
    onError,
  });
  const discardAll = useMutation({ mutationFn: () => api.discardAll(), onSuccess: invalidate, onError });
  const failedDeviceIds = groups.filter((g) => g.changes.some((c) => c.error)).map((g) => g.deviceId);
  const locked = running || apply.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold">{t('pending.title')}</h1>
        {failedDeviceIds.length > 0 && (
          <Button variant="outline" disabled={locked} onClick={() => apply.mutate(failedDeviceIds)}>
            {t('pending.retry')}
          </Button>
        )}
        {groups.length > 0 && (
          <Button
            variant="outline"
            disabled={locked}
            onClick={() => window.confirm(t('pending.discardAllConfirm')) && discardAll.mutate()}
          >
            {t('pending.discardAll')}
          </Button>
        )}
        <Button disabled={groups.length === 0 || locked} onClick={() => apply.mutate(undefined)}>
          {running ? t('pending.running') : t('pending.apply', { count: groups.length })}
        </Button>
      </div>
      {job && <JobProgress job={job} />}
      {groups.length === 0 ? (
        <p className="text-muted-foreground">{t('pending.empty')}</p>
      ) : (
        groups.map((group) => <PendingGroup key={group.deviceId} group={group} disabled={locked} />)
      )}
    </div>
  );
}

function PendingGroup({ group, disabled }: { group: PendingDevice; disabled: boolean }) {
  const t = useT();
  const invalidate = useInvalidate();
  const discard = useMutation({
    mutationFn: () => api.discardDevice(group.deviceId),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(t('common.error', { message: errorText(t, err) })),
  });
  return (
    <Card data-testid={`pending-${group.deviceId}`}>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{group.deviceName}</CardTitle>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => discard.mutate()}>
          {t('pending.discardDevice')}
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {group.changes.map((change) => (
            <PendingRow key={change.id} change={change} disabled={disabled} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function PendingRow({ change, disabled }: { change: PendingChange; disabled: boolean }) {
  const t = useT();
  const invalidate = useInvalidate();
  const discard = useMutation({
    mutationFn: () => api.discardChange(change.id),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(t('common.error', { message: errorText(t, err) })),
  });
  const label = change.kind === 'command' ? t('pending.command') : settingLabel(t, change.key ?? '');
  return (
    <li className="flex flex-wrap items-center gap-2 py-2 text-sm">
      <span className="w-56 shrink-0 text-muted-foreground">{label}</span>
      {change.kind === 'setting' && (
        <>
          <BeforeValue change={change} />
          <span aria-hidden>→</span>
        </>
      )}
      <span className="font-mono break-all">{change.value}</span>
      <Button variant="ghost" size="sm" className="ml-auto" disabled={disabled} onClick={() => discard.mutate()}>
        {t('pending.discard')}
      </Button>
      {change.error && <span className="w-full text-xs text-destructive">{errorText(t, change.error)}</span>}
    </li>
  );
}

function BeforeValue({ change }: { change: PendingChange }) {
  const t = useT();
  const [load, setLoad] = useState(false);
  const kind = liveKind(change.key);
  const query = useQuery<RuleState[] | TimersState>({
    queryKey: [kind ?? 'none', change.deviceId],
    queryFn: () => (kind === 'rules' ? api.rules(change.deviceId) : api.timers(change.deviceId)),
    enabled: load && kind !== null,
  });
  const struck = 'font-mono text-muted-foreground line-through break-all';
  if (change.before !== null) return <span className={struck}>{change.before === '' ? '""' : change.before}</span>;
  if (!kind) return <span className="text-muted-foreground">{t('pending.unknown')}</span>;
  if (!load) {
    return (
      <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setLoad(true)}>
        {t('pending.loadCurrent')}
      </Button>
    );
  }
  if (!query.data) return <span className="text-muted-foreground">…</span>;
  return <span className={struck}>{liveValue(change.key ?? '', query.data) ?? '—'}</span>;
}
