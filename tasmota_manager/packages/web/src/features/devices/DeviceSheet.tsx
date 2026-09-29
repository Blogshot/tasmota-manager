import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommandResult, Device, DeviceUpdateRequest } from '@tm/shared';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { Console } from './Console';
import { StatusDot } from './StatusDot';

interface Props {
  deviceId: string | null;
  onClose: () => void;
  onSwitch: (id: string) => void;
}

export function DeviceSheet({ deviceId, onClose, onSwitch }: Props) {
  return (
    <Sheet open={deviceId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {deviceId && <DeviceDetail deviceId={deviceId} onClose={onClose} onSwitch={onSwitch} />}
      </SheetContent>
    </Sheet>
  );
}

function DeviceDetail({ deviceId, onClose, onSwitch }: { deviceId: string; onClose: () => void; onSwitch: (id: string) => void }) {
  const t = useT();
  const qc = useQueryClient();
  // Metadaten aus der live aktualisierten Liste, der Rohstatus aus dem Detail-Endpunkt.
  const { data: fromList } = useQuery({
    queryKey: ['devices'],
    queryFn: api.devices,
    select: (list) => list.find((d) => d.id === deviceId),
  });
  const { data: detail } = useQuery({ queryKey: ['device', deviceId], queryFn: () => api.device(deviceId) });
  const device: Device | undefined = fromList ?? detail;

  const command = useMutation({
    mutationFn: (cmd: string) => api.command(deviceId, cmd),
    onSuccess: (result: CommandResult) =>
      result.ok ? toast.success(JSON.stringify(result.response)) : toast.error(t('common.error', { message: result.message })),
    onError: (err: Error) => toast.error(t('common.error', { message: err.message })),
  });
  const remove = useMutation({
    mutationFn: () => api.removeDevice(deviceId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['devices'] });
      onClose();
    },
    onError: (err: Error) => toast.error(t('common.error', { message: err.message })),
  });

  if (!device) return null;

  const info: Array<[string, string | number | null]> = [
    ['IP', device.ip],
    [t('detail.hostname'), device.hostname],
    [t('detail.topic'), device.mqttTopic],
    [t('devices.col.firmware'), device.firmware],
    [t('detail.variant'), device.variant],
    [t('devices.col.module'), device.module],
    [t('detail.chip'), device.chip],
    [t('detail.flash'), device.flashSize ? `${device.flashSize} KB` : null],
    [t('devices.col.channels'), device.channels.map((c) => c.toUpperCase()).join(', ')],
    [t('detail.lastSeen'), device.lastSeen ? new Date(device.lastSeen).toLocaleString() : null],
  ];

  return (
    <div className="space-y-6 p-4">
      <SheetHeader className="p-0">
        <SheetTitle className="flex items-center gap-2">
          <StatusDot device={device} />
          {device.name}
        </SheetTitle>
        <SheetDescription>{device.id}</SheetDescription>
      </SheetHeader>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t('detail.info')}</h3>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          {info.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{value || '—'}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t('detail.actions')}</h3>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => command.mutate('Power TOGGLE')}>
            {t('detail.toggle')}
          </Button>
          <Button
            variant="outline"
            onClick={() => window.confirm(t('detail.restartConfirm', { name: device.name })) && command.mutate('Restart 1')}
          >
            {t('detail.restart')}
          </Button>
          {device.ip && (
            <Button variant="outline" asChild>
              <a href={`http://${device.ip}`} target="_blank" rel="noreferrer">
                {t('detail.webui')}
              </a>
            </Button>
          )}
        </div>
      </section>

      <DeviceSettingsForm key={device.id} device={device} onSwitch={onSwitch} />

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t('console.title')}</h3>
        <Console key={device.id} deviceId={device.id} />
      </section>

      <Button
        variant="destructive"
        onClick={() => window.confirm(t('detail.removeConfirm', { name: device.name })) && remove.mutate()}
      >
        {t('detail.remove')}
      </Button>
    </div>
  );
}

function DeviceSettingsForm({ device, onSwitch }: { device: Device; onSwitch: (id: string) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [tags, setTags] = useState(device.tags.join(', '));
  const [password, setPassword] = useState('');
  const mutation = useMutation({
    mutationFn: (patch: DeviceUpdateRequest) => api.updateDevice(device.id, patch),
    onSuccess: (updated) => {
      toast.success(t('common.saved'));
      setPassword('');
      void qc.invalidateQueries({ queryKey: ['devices'] });
      if (updated.id !== device.id) onSwitch(updated.id);
    },
    onError: (err) => toast.error(t('common.error', { message: err.message })),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const patch: DeviceUpdateRequest = {
      tags: tags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    if (password) patch.password = password;
    mutation.mutate(patch);
  };

  return (
    <form className="space-y-3" onSubmit={submit}>
      <div className="space-y-1">
        <Label htmlFor="device-tags">{t('detail.tags')}</Label>
        <Input id="device-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('detail.tagsHint')} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="device-password">{t('detail.password')}</Label>
        <Input id="device-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {device.hasPasswordOverride && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t('detail.passwordSet')}</span>
            <Button type="button" variant="link" size="sm" onClick={() => mutation.mutate({ password: null })}>
              {t('detail.passwordClear')}
            </Button>
          </div>
        )}
      </div>
      <Button type="submit" disabled={mutation.isPending}>
        {t('common.save')}
      </Button>
    </form>
  );
}
