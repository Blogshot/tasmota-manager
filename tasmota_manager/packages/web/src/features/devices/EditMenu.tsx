import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Device } from '@tm/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { useT } from '@/lib/i18n';
import { BatchCommandsDialog } from './BatchCommandsDialog';
import { BatchRuleDialog } from './BatchRuleDialog';
import { BatchSettingsDialog } from './BatchSettingsDialog';
import { BatchTimerDialog } from './BatchTimerDialog';

type DialogKind = 'settings' | 'commands' | 'rule' | 'timer' | null;

export function EditMenu({ devices }: { devices: Device[] }) {
  const t = useT();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const suggestions = useMutation({
    mutationFn: () => api.stageSuggestions(devices.map((d) => d.id)),
    onSuccess: (result) => {
      if (result.staged === 0) toast(t('edit.suggestions.none'));
      else toast.success(t('devices.staged', { staged: result.staged }));
      void qc.invalidateQueries({ queryKey: ['devices'] });
      void qc.invalidateQueries({ queryKey: ['changes'] });
    },
    onError: (err: Error) => toast.error(t('common.error', { message: errorText(t, err) })),
  });
  const onOpenChange = (open: boolean) => {
    if (!open) setDialog(null);
  };

  return (
    <>
      {/* modal={false}: sonst blockiert das Menü beim Öffnen eines Dialogs die Zeiger-Ereignisse. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button size="sm">{t('edit.menu')}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => setDialog('settings')}>{t('edit.settings')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('commands')}>{t('edit.commands')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('rule')}>{t('edit.rule')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('timer')}>{t('edit.timer')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => suggestions.mutate()}>{t('edit.suggestions')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <BatchSettingsDialog devices={devices} open={dialog === 'settings'} onOpenChange={onOpenChange} />
      <BatchCommandsDialog devices={devices} open={dialog === 'commands'} onOpenChange={onOpenChange} />
      <BatchRuleDialog devices={devices} open={dialog === 'rule'} onOpenChange={onOpenChange} />
      <BatchTimerDialog devices={devices} open={dialog === 'timer'} onOpenChange={onOpenChange} />
    </>
  );
}
