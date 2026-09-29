import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

export function AddDeviceDialog() {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [ip, setIp] = useState('');
  const mutation = useMutation({
    mutationFn: (value: string) => api.addDevice(value),
    onSuccess: (device) => {
      toast.success(t('devices.add.success', { name: device.name }));
      void qc.invalidateQueries({ queryKey: ['devices'] });
      setOpen(false);
      setIp('');
    },
    onError: (err) => toast.error(t('common.error', { message: err.message })),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>{t('devices.add')}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('devices.add')}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate(ip.trim());
          }}
        >
          <Label htmlFor="add-device-ip">{t('devices.add.ip')}</Label>
          <Input id="add-device-ip" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.50" />
          <DialogFooter>
            <Button type="submit" disabled={!ip.trim() || mutation.isPending}>
              {t('devices.add.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
