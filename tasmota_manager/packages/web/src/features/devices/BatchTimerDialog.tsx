import { DEFAULT_TIMER, type Device, type Timer, TimerSchema } from '@tm/shared';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useStage } from '@/features/changes/useStage';
import { TimerForm } from '@/features/timers/TimerForm';
import { useT } from '@/lib/i18n';
import { selectClass } from '@/lib/styles';

interface Props {
  devices: Device[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const INITIAL: Timer = { ...DEFAULT_TIMER, Enable: 1, Days: '1111111', Repeat: 1, Action: 1 };

export function BatchTimerDialog({ devices, open, onOpenChange }: Props) {
  const t = useT();
  const [slot, setSlot] = useState(1);
  const [timer, setTimer] = useState<Timer>(INITIAL);
  const [enableAll, setEnableAll] = useState(true);
  const stage = useStage(() => onOpenChange(false));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!TimerSchema.safeParse(timer).success) {
      toast.error(t('timers.invalid', { n: slot }));
      return;
    }
    const settings: Record<string, string> = { [`Timer${slot}`]: JSON.stringify(timer) };
    if (enableAll) settings.Timers = '1';
    stage.mutate({ deviceIds: devices.map((d) => d.id), settings, source: 'timer' });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('edit.timer')}</DialogTitle>
          <DialogDescription>{t('edit.forDevices', { count: devices.length })}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label htmlFor="batch-timer-slot">{t('edit.timer.slot')}</Label>
              <select id="batch-timer-slot" className={selectClass} value={slot} onChange={(e) => setSlot(Number(e.target.value))}>
                {Array.from({ length: 16 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={enableAll} onCheckedChange={(v) => setEnableAll(Boolean(v))} aria-label={t('edit.timer.enableAll')} />
              {t('edit.timer.enableAll')}
            </label>
          </div>
          <TimerForm id="batch-timer" value={timer} onChange={setTimer} />
          <DialogFooter>
            <Button type="submit" disabled={stage.isPending}>
              {t('edit.stage')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
