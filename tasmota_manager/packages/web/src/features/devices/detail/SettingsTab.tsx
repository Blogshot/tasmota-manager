import { type Device, SETTINGS, readFromStatus, settingApplies } from '@tm/shared';
import { useQueries } from '@tanstack/react-query';
import { type FormEvent, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { FastRuleDialog } from '@/features/changes/FastRuleDialog';
import { type FieldValues, SettingsFields, collectSettings } from '@/features/changes/SettingsFields';
import { useStage } from '@/features/changes/useStage';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

const DEFS = SETTINGS.filter((d) => d.group !== 'rules' && d.group !== 'timers');

export function SettingsTab({ device, status }: { device: Device; status: unknown }) {
  const t = useT();
  const fromStatus = useMemo(() => Object.fromEntries(DEFS.map((d) => [d.key, readFromStatus(d.key, status)])), [status]);
  // Was nicht im gespeicherten Status 0 steht, wird einzeln vom Gerät gelesen (nur Abfragen, Passwörter nie).
  const missing = useMemo(
    () => DEFS.filter((d) => !d.writeOnly && settingApplies(d, device.capabilities) && fromStatus[d.key] === null).map((d) => d.key),
    [device.capabilities, fromStatus],
  );
  const live = useQueries({
    queries: missing.map((key) => ({
      queryKey: ['setting', device.id, key],
      queryFn: () => api.setting(device.id, key),
      staleTime: 30_000,
      retry: false,
    })),
  });
  const current: Record<string, string | null> = { ...fromStatus };
  const loading = new Set<string>();
  missing.forEach((key, i) => {
    const query = live[i];
    if (query?.isPending) loading.add(key);
    else if (query?.data) current[key] = query.data.value;
  });
  const [values, setValues] = useState<FieldValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fastRuleOpen, setFastRuleOpen] = useState(false);
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
    <>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-muted-foreground">{t('detail.pendingHint')}</p>
        <SettingsFields
          idPrefix={`detail-${device.id}`}
          defs={DEFS}
          devices={[device]}
          values={values}
          errors={errors}
          current={current}
          loading={loading}
          onFastRule={() => setFastRuleOpen(true)}
          onChange={(key, value) => setValues((v) => ({ ...v, [key]: value }))}
        />
        <Button type="submit" disabled={stage.isPending}>
          {t('edit.stage')}
        </Button>
      </form>
      <FastRuleDialog
        deviceIds={[device.id]}
        open={fastRuleOpen}
        onOpenChange={setFastRuleOpen}
        onStaged={() => setValues((v) => ({ ...v, TelePeriod: '' }))}
      />
    </>
  );
}
