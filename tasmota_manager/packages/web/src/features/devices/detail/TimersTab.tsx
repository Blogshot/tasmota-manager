import { useQuery } from '@tanstack/react-query';
import { type Timer, TimerSchema, type TimersState } from '@tm/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useStage } from '@/features/changes/useStage';
import { TimerForm, timerSummary } from '@/features/timers/TimerForm';
import { api } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { useT } from '@/lib/i18n';

export function TimersTab({ deviceId }: { deviceId: string }) {
  const t = useT();
  const { data, error } = useQuery({ queryKey: ['timers', deviceId], queryFn: () => api.timers(deviceId) });
  if (error) return <p className="text-sm text-destructive">{t('timers.loadError', { message: errorText(t, error) })}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">…</p>;
  return <TimersEditor deviceId={deviceId} initial={data} />;
}

function TimersEditor({ deviceId, initial }: { deviceId: string; initial: TimersState }) {
  const t = useT();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [timers, setTimers] = useState<Timer[]>(initial.timers);
  const [open, setOpen] = useState<number | null>(null);
  const stage = useStage();
  const submit = () => {
    const invalid = timers.findIndex((timer) => !TimerSchema.safeParse(timer).success);
    if (invalid >= 0) {
      toast.error(t('timers.invalid', { n: invalid + 1 }));
      return;
    }
    const settings: Record<string, string> = {};
    if (enabled !== initial.enabled) settings.Timers = enabled ? '1' : '0';
    timers.forEach((timer, i) => {
      if (JSON.stringify(timer) !== JSON.stringify(initial.timers[i])) settings[`Timer${i + 1}`] = JSON.stringify(timer);
    });
    if (Object.keys(settings).length === 0) {
      toast.error(t('edit.nothing'));
      return;
    }
    stage.mutate({ deviceIds: [deviceId], settings, source: 'timer' });
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('detail.pendingHint')}</p>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(Boolean(v))} aria-label={t('timers.enabled')} />
        {t('timers.enabled')}
      </label>
      <ul className="divide-y rounded-md border">
        {timers.map((timer, i) => (
          <li key={`timer-${i + 1}`} className="p-2">
            <button type="button" className="flex w-full items-center gap-2 text-left text-sm" onClick={() => setOpen(open === i ? null : i)}>
              <span className="font-medium">{t('timers.timer', { n: i + 1 })}</span>
              <span className="text-muted-foreground">{timerSummary(timer, t)}</span>
            </button>
            {open === i && (
              <div className="pt-3">
                <TimerForm
                  id={`detail-timer-${i + 1}`}
                  value={timer}
                  onChange={(next) => setTimers((list) => list.map((x, j) => (j === i ? next : x)))}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
      <Button onClick={submit} disabled={stage.isPending}>
        {t('edit.stage')}
      </Button>
    </div>
  );
}
