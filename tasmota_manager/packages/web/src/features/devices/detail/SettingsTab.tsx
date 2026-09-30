import { type Device, SETTINGS, readFromStatus } from '@tm/shared';
import { type FormEvent, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { type FieldValues, SettingsFields, collectSettings } from '@/features/changes/SettingsFields';
import { useStage } from '@/features/changes/useStage';
import { useT } from '@/lib/i18n';

const DEFS = SETTINGS.filter((d) => d.group !== 'rules' && d.group !== 'timers');

export function SettingsTab({ device, status }: { device: Device; status: unknown }) {
  const t = useT();
  const current = useMemo(() => Object.fromEntries(DEFS.map((d) => [d.key, readFromStatus(d.key, status)])), [status]);
  const [values, setValues] = useState<FieldValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const stage = useStage(() => setValues({}));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const result = collectSettings(DEFS, values);
    setErrors(result.errors);
    if (Object.keys(result.errors).length > 0) return;
    if (Object.keys(result.settings).length === 0) {
      toast.error(t('edit.nothing'));
      return;
    }
    stage.mutate({ deviceIds: [device.id], settings: result.settings, source: 'detail' });
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-xs text-muted-foreground">{t('detail.pendingHint')}</p>
      <SettingsFields
        idPrefix={`detail-${device.id}`}
        defs={DEFS}
        values={values}
        errors={errors}
        current={current}
        onChange={(key, value) => setValues((v) => ({ ...v, [key]: value }))}
      />
      <Button type="submit" disabled={stage.isPending}>
        {t('edit.stage')}
      </Button>
    </form>
  );
}
