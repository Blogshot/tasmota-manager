import { type Device, SETTINGS } from '@tm/shared';
import { type FormEvent, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FastRuleDialog } from '@/features/changes/FastRuleDialog';
import { type FieldValues, SettingsFields, collectSettings } from '@/features/changes/SettingsFields';
import { useStage } from '@/features/changes/useStage';
import { useT } from '@/lib/i18n';

interface Props {
  devices: Device[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BatchSettingsDialog({ devices, open, onOpenChange }: Props) {
  const t = useT();
  const defs = useMemo(() => SETTINGS.filter((d) => d.batch), []);
  const [values, setValues] = useState<FieldValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fastRuleOpen, setFastRuleOpen] = useState(false);
  const stage = useStage(() => {
    setValues({});
    onOpenChange(false);
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const result = collectSettings(defs, values);
    setErrors(result.errors);
    if (Object.keys(result.errors).length > 0) return;
    if (Object.keys(result.settings).length === 0) {
      toast.error(t('edit.nothing'));
      return;
    }
    stage.mutate({ deviceIds: devices.map((d) => d.id), settings: result.settings, source: 'form' });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('edit.settings')}</DialogTitle>
            <DialogDescription>{t('edit.forDevices', { count: devices.length })}</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <SettingsFields
              idPrefix="batch"
              defs={defs}
              devices={devices}
              values={values}
              errors={errors}
              onChange={(key, value) => setValues((v) => ({ ...v, [key]: value }))}
              onFastRule={() => setFastRuleOpen(true)}
            />
            <DialogFooter>
              <Button type="submit" disabled={stage.isPending}>
                {t('edit.stage')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <FastRuleDialog
        deviceIds={devices.map((d) => d.id)}
        open={fastRuleOpen}
        onOpenChange={setFastRuleOpen}
        onStaged={() => setValues((v) => ({ ...v, TelePeriod: '' }))}
      />
    </>
  );
}
