import { type Device, MAX_RULE_LENGTH } from '@tm/shared';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useStage } from '@/features/changes/useStage';
import { RuleEditor } from '@/features/rules/RuleEditor';
import { useT } from '@/lib/i18n';
import { selectClass } from '@/lib/styles';

interface Props {
  devices: Device[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BatchRuleDialog({ devices, open, onOpenChange }: Props) {
  const t = useT();
  const [slot, setSlot] = useState(1);
  const [text, setText] = useState('');
  const [enabled, setEnabled] = useState(true);
  const stage = useStage(() => {
    setText('');
    onOpenChange(false);
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.length > MAX_RULE_LENGTH) {
      toast.error(t('rules.tooLong'));
      return;
    }
    stage.mutate({
      deviceIds: devices.map((d) => d.id),
      settings: { [`Rule${slot}`]: text, [`Rule${slot}Enabled`]: enabled ? '1' : '0' },
      source: 'rule',
    });
  };
  const editorId = 'batch-rule-text';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('edit.rule')}</DialogTitle>
          <DialogDescription>{t('edit.forDevices', { count: devices.length })}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label htmlFor="batch-rule-slot">{t('edit.rule.slot')}</Label>
              <select id="batch-rule-slot" className={selectClass} value={slot} onChange={(e) => setSlot(Number(e.target.value))}>
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(Boolean(v))} aria-label={t('rules.enabled')} />
              {t('rules.enabled')}
            </label>
          </div>
          <Label htmlFor={editorId}>{t('rules.rule', { n: slot })}</Label>
          <RuleEditor id={editorId} value={text} onChange={setText} />
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
