import { useQuery } from '@tanstack/react-query';
import { MqttBanner } from '@/components/MqttBanner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { DevicesPage } from '@/features/devices/DevicesPage';
import { PendingPage } from '@/features/pending/PendingPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useLiveUpdates } from '@/lib/live';
import { ROUTES, useHashRoute } from '@/lib/route';

export function App() {
  useLiveUpdates();
  const t = useT();
  const [route, navigate] = useHashRoute();
  const { data: changes = [] } = useQuery({ queryKey: ['changes'], queryFn: api.changes });
  const pendingTotal = changes.reduce((sum, group) => sum + group.changes.length, 0);
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <nav className="flex w-52 shrink-0 flex-col gap-1 border-r p-3">
        <div className="px-2 py-3 font-semibold">Tasmota Manager</div>
        {ROUTES.map((r) => (
          <Button key={r} variant={route === r ? 'secondary' : 'ghost'} className="justify-start" onClick={() => navigate(r)}>
            {t(`nav.${r}`)}
            {r === 'pending' && pendingTotal > 0 && <Badge className="ml-auto">{pendingTotal}</Badge>}
          </Button>
        ))}
      </nav>
      <main className="min-w-0 flex-1 space-y-4 p-6">
        <MqttBanner />
        {route === 'devices' ? <DevicesPage /> : route === 'pending' ? <PendingPage /> : <SettingsPage />}
      </main>
      <Toaster />
    </div>
  );
}
