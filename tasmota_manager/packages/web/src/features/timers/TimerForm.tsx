import type { Timer } from '@tm/shared';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/lib/i18n';
import type { MessageKey } from '@/lib/messages';
import { selectClass } from '@/lib/styles';

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

export const toggleDay = (days: string, index: number, on: boolean): string =>
  days.slice(0, index) + (on ? '1' : '0') + days.slice(index + 1);

/** Kurzfassung für Listen, z. B. „Uhrzeit 06:30 · Mo, Di · An → 1“. */
export function timerSummary(timer: Timer, t: T): string {
  if (timer.Enable !== 1) return t('timers.inactive');
  const names = t('days.short').split(',');
  const days = [...timer.Days].flatMap((c, i) => (c === '1' ? [names[i] ?? ''] : [])).join(', ');
  const mode = t(`timers.mode.${timer.Mode}` as MessageKey);
  const action = t(`timers.action.${timer.Action}` as MessageKey);
  return `${mode} ${timer.Time} · ${days || '—'} · ${action} → ${timer.Output}`;
}

interface Props {
  id: string;
  value: Timer;
  onChange: (timer: Timer) => void;
}

export function TimerForm({ id, value, onChange }: Props) {
  const t = useT();
  const set = <K extends keyof Timer>(key: K, v: Timer[K]) => onChange({ ...value, [key]: v });
  const sun = value.Mode !== 0;
  const days = t('days.short').split(',');
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={value.Enable === 1} onCheckedChange={(v) => set('Enable', v ? 1 : 0)} aria-label={t('timers.active')} />
        {t('timers.active')}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={value.Repeat === 1} onCheckedChange={(v) => set('Repeat', v ? 1 : 0)} aria-label={t('timers.repeat')} />
        {t('timers.repeat')}
      </label>
      <div className="space-y-1">
        <Label htmlFor={`${id}-mode`}>{t('timers.mode')}</Label>
        <select id={`${id}-mode`} className={`${selectClass} w-full`} value={value.Mode} onChange={(e) => set('Mode', Number(e.target.value))}>
          {[0, 1, 2].map((m) => (
            <option key={m} value={m}>
              {t(`timers.mode.${m}` as MessageKey)}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-time`}>{sun ? t('timers.offset') : t('timers.time')}</Label>
        <Input id={`${id}-time`} value={value.Time} placeholder={sun ? '+00:30' : '06:30'} onChange={(e) => set('Time', e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-window`}>{t('timers.window')}</Label>
        <Input
          id={`${id}-window`}
          type="number"
          min={0}
          max={15}
          value={value.Window}
          onChange={(e) => set('Window', Number(e.target.value))}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-output`}>{t('timers.output')}</Label>
        <Input
          id={`${id}-output`}
          type="number"
          min={1}
          max={16}
          value={value.Output}
          onChange={(e) => set('Output', Number(e.target.value))}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-action`}>{t('timers.action')}</Label>
        <select id={`${id}-action`} className={`${selectClass} w-full`} value={value.Action} onChange={(e) => set('Action', Number(e.target.value))}>
          {[0, 1, 2, 3].map((a) => (
            <option key={a} value={a}>
              {t(`timers.action.${a}` as MessageKey)}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1 sm:col-span-2">
        <span className="text-sm font-medium">{t('timers.days')}</span>
        <div className="flex flex-wrap gap-3">
          {days.map((day, index) => (
            <label key={day} className="flex items-center gap-1 text-sm">
              <Checkbox
                checked={value.Days[index] === '1'}
                onCheckedChange={(v) => set('Days', toggleDay(value.Days, index, Boolean(v)))}
                aria-label={day}
              />
              {day}
            </label>
          ))}
        </div>
      </div>
      {sun && <p className="text-xs text-muted-foreground sm:col-span-2">{t('timers.sunHint')}</p>}
    </div>
  );
}
