import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CidrSchema, type Settings, type SettingsUpdateRequest } from '@tm/shared';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

export function SettingsPage() {
  const t = useT();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.status });
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">{t('settings.title')}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.mqtt')}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">{status ? t(`mqtt.${status.mqtt}`) : '…'}</CardContent>
      </Card>
      {settings && <SettingsForm key={JSON.stringify(settings)} initial={settings} />}
    </div>
  );
}

function SettingsForm({ initial }: { initial: Settings }) {
  const t = useT();
  const qc = useQueryClient();
  const [cidrs, setCidrs] = useState(initial.scanCidrs.join('\n'));
  const [poll, setPoll] = useState(String(initial.pollIntervalSec));
  const [password, setPassword] = useState('');
  const [removePassword, setRemovePassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (patch: SettingsUpdateRequest) => api.updateSettings(patch),
    onSuccess: (saved) => {
      qc.setQueryData(['settings'], saved);
      toast.success(t('common.saved'));
    },
    onError: (err) => setError(err.message),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const list = cidrs
      .split(/[\n,]/)
      .map((c) => c.trim())
      .filter(Boolean);
    const invalid = list.find((c) => !CidrSchema.safeParse(c).success);
    if (invalid) return setError(t('settings.invalidCidr', { cidr: invalid }));
    const pollIntervalSec = Number(poll);
    if (!Number.isInteger(pollIntervalSec) || pollIntervalSec < 10 || pollIntervalSec > 3600) return setError(t('settings.invalidPoll'));
    setError(null);
    const patch: SettingsUpdateRequest = { scanCidrs: list, pollIntervalSec };
    if (removePassword) patch.globalPassword = null;
    else if (password) patch.globalPassword = password;
    mutation.mutate(patch);
  };

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="space-y-1">
        <Label htmlFor="settings-cidrs">{t('settings.cidrs')}</Label>
        <Textarea id="settings-cidrs" rows={4} className="font-mono" value={cidrs} onChange={(e) => setCidrs(e.target.value)} />
        <p className="text-xs text-muted-foreground">{t('settings.cidrsHint')}</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="settings-poll">{t('settings.poll')}</Label>
        <Input id="settings-poll" type="number" min={10} max={3600} value={poll} onChange={(e) => setPoll(e.target.value)} className="max-w-32" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="settings-password">{t('settings.password')}</Label>
        <Input
          id="settings-password"
          type="password"
          autoComplete="new-password"
          value={password}
          disabled={removePassword}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">{initial.hasGlobalPassword ? t('settings.passwordSet') : t('settings.passwordNone')}</p>
        {initial.hasGlobalPassword && (
          <div className="flex items-center gap-2 text-sm">
            <Checkbox id="settings-remove-password" checked={removePassword} onCheckedChange={(v) => setRemovePassword(Boolean(v))} />
            <Label htmlFor="settings-remove-password">{t('settings.passwordRemove')}</Label>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={mutation.isPending}>
        {t('common.save')}
      </Button>
    </form>
  );
}
