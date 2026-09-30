import { type Device, renderPlaceholders } from '@tm/shared';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useStage } from '@/features/changes/useStage';
import { useT } from '@/lib/i18n';

interface Props {
  devices: Device[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BatchCommandsDialog({ devices, open, onOpenChange }: Props) {
  const t = useT();
  const [text, setText] = useState('');
  const stage = useStage(() => {
    setText('');
    onOpenChange(false);
  });
  const commands = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const sample = devices[0];
  const preview = sample ? commands.map((c) => renderPlaceholders(c, sample)) : [];
  const unknown = preview.find((p) => !p.ok);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (commands.length === 0) {
      toast.error(t('edit.nothing'));
      return;
    }
    if (unknown && !unknown.ok) {
      toast.error(t('edit.commands.unknown', { placeholder: `{{${unknown.unknown}}}` }));
      return;
    }
    stage.mutate({ deviceIds: devices.map((d) => d.id), commands, source: 'command' });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('edit.commands')}</DialogTitle>
          <DialogDescription>{t('edit.forDevices', { count: devices.length })}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Label htmlFor="batch-commands">{t('edit.commands.label')}</Label>
          <Textarea id="batch-commands" rows={6} className="font-mono" value={text} onChange={(e) => setText(e.target.value)} />
          <p className="text-xs text-muted-foreground">{t('edit.commands.hint')}</p>
          {sample && commands.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t('edit.commands.preview', { name: sample.name })}</p>
              <pre className="rounded-md border bg-muted/30 p-2 font-mono text-xs whitespace-pre-wrap">
                {preview.map((p) => (p.ok ? p.value : `⚠ {{${p.unknown}}}`)).join('\n')}
              </pre>
            </div>
          )}
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
