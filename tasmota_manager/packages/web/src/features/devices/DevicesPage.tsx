import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RowSelectionState } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { selectClass } from '@/lib/styles';
import { AddDeviceDialog } from './AddDeviceDialog';
import { DeviceSheet } from './DeviceSheet';
import { DeviceTable } from './DeviceTable';
import { EditMenu } from './EditMenu';
import { type StatusFilter, filterDevices } from './filter';
import { ScanButton } from './ScanButton';

export function DevicesPage() {
  const t = useT();
  const { data: devices = [], isLoading } = useQuery({ queryKey: ['devices'], queryFn: api.devices });
  const [text, setText] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [tag, setTag] = useState('');
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [openId, setOpenId] = useState<string | null>(null);

  const allTags = useMemo(() => [...new Set(devices.flatMap((d) => d.tags))].sort(), [devices]);
  const visible = useMemo(() => filterDevices(devices, { text, status, tag }), [devices, text, status, tag]);
  const selected = devices.filter((d) => rowSelection[d.id]);
  const selectedCount = selected.length;
  const qc = useQueryClient();
  // Entfernt nur Einträge in der App; an den Geräten ändert sich nichts.
  const remove = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => api.removeDevice(id)));
      return { removed: results.filter((r) => r.status === 'fulfilled').length, failed: ids.filter((_, i) => results[i]?.status === 'rejected') };
    },
    onSuccess: ({ removed, failed }) => {
      if (removed > 0) toast.success(t('devices.removed', { count: removed }));
      if (failed.length > 0) toast.error(t('devices.removeFailed', { failed: failed.length }));
      // Fehlgeschlagene Geräte bleiben ausgewählt, damit man es erneut versuchen kann.
      setRowSelection(Object.fromEntries(failed.map((id) => [id, true])));
      void qc.invalidateQueries({ queryKey: ['devices'] });
      void qc.invalidateQueries({ queryKey: ['changes'] });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold">{t('devices.title')}</h1>
        <ScanButton />
        <AddDeviceDialog />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder={t('devices.search')}
          aria-label={t('devices.search')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select
          aria-label={t('devices.filter.status')}
          className={selectClass}
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
        >
          <option value="all">{t('devices.filter.all')}</option>
          <option value="online">{t('devices.filter.online')}</option>
          <option value="offline">{t('devices.filter.offline')}</option>
          <option value="auth">{t('devices.filter.auth')}</option>
          <option value="stale">{t('devices.filter.stale')}</option>
        </select>
        <select aria-label={t('devices.filter.tag')} className={selectClass} value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">{t('devices.filter.allTags')}</option>
          {allTags.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      {selectedCount > 0 && (
        <div className="flex items-center gap-3 rounded-md border bg-muted/50 px-3 py-2 text-sm">
          <span>{t('devices.selected', { count: selectedCount })}</span>
          <EditMenu devices={selected} />
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            disabled={remove.isPending}
            onClick={() => window.confirm(t('devices.removeSelectedConfirm', { count: selectedCount })) && remove.mutate(selected.map((d) => d.id))}
          >
            {t('devices.removeSelected')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRowSelection({})}>
            {t('devices.clearSelection')}
          </Button>
        </div>
      )}
      {!isLoading && devices.length === 0 ? (
        <p className="text-muted-foreground">{t('devices.empty')}</p>
      ) : (
        <DeviceTable devices={visible} rowSelection={rowSelection} onRowSelectionChange={setRowSelection} onOpen={setOpenId} />
      )}
      <DeviceSheet deviceId={openId} onClose={() => setOpenId(null)} onSwitch={setOpenId} />
    </div>
  );
}
