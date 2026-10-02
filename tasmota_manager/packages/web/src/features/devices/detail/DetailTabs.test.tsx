import { DEFAULT_TIMER } from '@tm/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { I18nProvider } from '@/lib/i18n';
import { makeDevice } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { DeviceSheet } from '../DeviceSheet';

vi.mock('@/lib/api', () => ({
  api: {
    devices: vi.fn(),
    device: vi.fn(),
    updateDevice: vi.fn(),
    removeDevice: vi.fn(),
    command: vi.fn(),
    stage: vi.fn(),
    rules: vi.fn(),
    timers: vi.fn(),
    readSettings: vi.fn(),
  },
  ApiError: class extends Error {},
}));

const device = makeDevice({ id: 'A', name: 'Keller' });

describe('Detail-Tabs', () => {
  beforeEach(() => {
    vi.mocked(api.devices).mockResolvedValue([device]);
    vi.mocked(api.device).mockResolvedValue({ ...device, status: { Status: { PowerOnState: 3 } } });
    vi.mocked(api.stage).mockResolvedValue({ staged: 1, skipped: 0, incompatible: 0 });
    vi.mocked(api.rules).mockResolvedValue([
      { index: 1, enabled: false, text: 'ON x DO y ENDON', length: 15, free: 496 },
      { index: 2, enabled: false, text: '', length: 0, free: 511 },
      { index: 3, enabled: false, text: '', length: 0, free: 511 },
    ]);
    vi.mocked(api.timers).mockResolvedValue({ enabled: true, timers: Array.from({ length: 16 }, () => DEFAULT_TIMER) });
    vi.mocked(api.readSettings).mockReset();
    vi.mocked(api.readSettings).mockImplementation(async (_id, keys) => ({
      values: Object.fromEntries(keys.map((key) => [key, key === 'NtpServer1' ? 'de.pool.ntp.org' : key === 'SetOption65' ? '1' : null])),
    }));
  });

  const open = async (tab: string) => {
    const user = userEvent.setup();
    renderWithProviders(<DeviceSheet deviceId="A" onClose={vi.fn()} onSwitch={vi.fn()} />);
    await user.click(await screen.findByRole('tab', { name: tab }));
    return user;
  };

  it('merkt Einstellungen eines Geräts vor und zeigt den aktuellen Wert', async () => {
    const user = await open('Einstellungen');
    const select = await screen.findByLabelText('Zustand nach Stromausfall');
    expect(select).toHaveDisplayValue('3 – Letzter Zustand (Standard) (aktuell)');
    await user.selectOptions(select, '1');
    await user.click(screen.getByRole('button', { name: 'Vormerken' }));
    await waitFor(() =>
      expect(api.stage).toHaveBeenCalledWith({ deviceIds: ['A'], settings: { PowerOnState: '1' }, source: 'detail' }),
    );
  });

  it('zeigt fehlende Werte live vom Gerät statt „unverändert“', async () => {
    await open('Einstellungen');
    const ntp = await screen.findByLabelText('NTP-Server 1');
    await waitFor(() => expect(ntp).toHaveAttribute('placeholder', 'de.pool.ntp.org'));
    await waitFor(() => expect(screen.getByLabelText(/SetOption65/)).toHaveDisplayValue('An (aktuell)'));
    // Ein einziger Aufruf für alle fehlenden Werte; bereits aus dem Status bekannte Werte werden nicht erneut gelesen, Passwörter nie.
    expect(api.readSettings).toHaveBeenCalledTimes(1);
    const keys = vi.mocked(api.readSettings).mock.calls[0]?.[1] ?? [];
    expect(vi.mocked(api.readSettings).mock.calls[0]?.[0]).toBe('A');
    expect(keys).toEqual(expect.arrayContaining(['NtpServer1', 'SetOption65']));
    expect(keys).not.toContain('PowerOnState');
    expect(keys).not.toContain('MqttPassword');
  });

  it('zeigt einen Ladespinner, bis die Werte gelesen sind', async () => {
    let resolve: (value: { values: Record<string, string | null> }) => void = () => {};
    vi.mocked(api.readSettings).mockImplementation(() => new Promise((r) => (resolve = r)));
    await open('Einstellungen');
    await screen.findByLabelText('NTP-Server 1');
    expect(screen.getAllByRole('status', { name: 'Wird geladen' }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('NTP-Server 1')).toHaveAttribute('placeholder', '');
    await waitFor(() => expect(api.readSettings).toHaveBeenCalledTimes(1));
    resolve({ values: { NtpServer1: 'de.pool.ntp.org' } });
    await waitFor(() => expect(screen.getByLabelText('NTP-Server 1')).toHaveAttribute('placeholder', 'de.pool.ntp.org'));
    expect(screen.queryAllByRole('status', { name: 'Wird geladen' })).toHaveLength(0);
  });

  it('liest bei Offline-Geräten nichts und zeigt „unverändert“', async () => {
    const offline = makeDevice({ id: 'A', name: 'Keller', online: false });
    vi.mocked(api.devices).mockResolvedValue([offline]);
    vi.mocked(api.device).mockResolvedValue({ ...offline, status: { Status: { PowerOnState: 3 } } });
    await open('Einstellungen');
    await waitFor(() => expect(screen.getByLabelText('NTP-Server 1')).toHaveAttribute('placeholder', 'unverändert'));
    expect(screen.queryAllByRole('status', { name: 'Wird geladen' })).toHaveLength(0);
    expect(api.readSettings).not.toHaveBeenCalled();
  });

  it('bearbeitet Rules und merkt nur Geänderte vor', async () => {
    const user = await open('Rules');
    await user.click(await screen.findByRole('checkbox', { name: 'Rule 1 Aktiv' }));
    await user.click(screen.getAllByRole('button', { name: 'Vormerken' })[0] as HTMLElement);
    await waitFor(() =>
      expect(api.stage).toHaveBeenCalledWith({ deviceIds: ['A'], settings: { Rule1Enabled: '1' }, source: 'rule' }),
    );
  });

  it('bearbeitet Timer und merkt nur Geänderte vor', async () => {
    const user = await open('Timer');
    await user.click(await screen.findByRole('button', { name: /Timer 2/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Aktiv' }));
    await user.click(screen.getByRole('button', { name: 'Vormerken' }));
    await waitFor(() => expect(api.stage).toHaveBeenCalled());
    const request = vi.mocked(api.stage).mock.calls.at(-1)?.[0];
    expect(Object.keys(request?.settings ?? {})).toEqual(['Timer2']);
    expect(JSON.parse(request?.settings?.Timer2 ?? '')).toMatchObject({ Enable: 1 });
  });

  it('zeigt Lesefehler von Rules an', async () => {
    vi.mocked(api.rules).mockRejectedValue(new Error('offline'));
    await open('Rules');
    expect(await screen.findByText('Rules konnten nicht gelesen werden: Gerät nicht erreichbar')).toBeInTheDocument();
  });

  it('setzt Formularzustand beim Wechsel auf ein anderes Gerät zurück', async () => {
    const other = makeDevice({ id: 'B', name: 'Bad' });
    vi.mocked(api.devices).mockResolvedValue([device, other]);
    vi.mocked(api.device).mockImplementation(async (id) => ({ ...(id === 'A' ? device : other), status: {} }));
    const user = userEvent.setup();
    const { rerender, queryClient } = renderWithProviders(<DeviceSheet deviceId="A" onClose={vi.fn()} onSwitch={vi.fn()} />);
    await user.click(await screen.findByRole('tab', { name: 'Einstellungen' }));
    await user.type(await screen.findByLabelText('Syslog-Host'), 'loghost-a');
    rerender(
      <QueryClientProvider client={queryClient}>
        <I18nProvider lang="de">
          <DeviceSheet deviceId="B" onClose={vi.fn()} onSwitch={vi.fn()} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    await screen.findByText('Bad');
    await user.click(await screen.findByRole('tab', { name: 'Einstellungen' }));
    expect(await screen.findByLabelText('Syslog-Host')).toHaveValue('');
  });
});
