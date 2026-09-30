import type { JobItemStatus, JobView } from '@tm/shared';
import { Card, CardContent } from '@/components/ui/card';
import { useT } from '@/lib/i18n';

const STATUS_CLASS: Record<JobItemStatus, string> = {
  pending: 'text-muted-foreground',
  running: 'text-sky-600 dark:text-sky-400',
  success: 'text-emerald-600 dark:text-emerald-400',
  failed: 'text-destructive',
};

export function JobProgress({ job }: { job: JobView }) {
  const t = useT();
  const finished = job.items.filter((i) => i.status === 'success' || i.status === 'failed').length;
  const percent = Math.round((finished / Math.max(job.items.length, 1)) * 100);
  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="h-2 w-full overflow-hidden rounded bg-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
        </div>
        <ul className="space-y-1 text-sm">
          {job.items.map((item) => (
            <li key={item.deviceId} className="flex flex-wrap gap-2">
              <span className="font-medium">{item.deviceName}</span>
              <span className={STATUS_CLASS[item.status]}>{t(`job.status.${item.status}`)}</span>
              {item.step && <span className="text-muted-foreground">{t(`job.step.${item.step}`)}</span>}
              {item.error && <span className="w-full text-xs text-destructive">{item.error}</span>}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
