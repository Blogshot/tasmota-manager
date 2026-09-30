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
  },
  ApiError: class extends Error {},
}));

const device = makeDevice({ id: 'A', name: 'Keller' });

describe('Detail-Tabs', () => {
  beforeEach(() => {
    vi.mocked(api.devices).mockResolvedValue([device]);
    vi.mocked(api.device).mockResolvedValue({ ...device, status: { Status: { PowerOnState: 3 } } });
    vi.mocked(api.stage).mockResolvedValue({ staged: 1, skipped: 0 });
    vi.mocked(api.rules).mockResolvedValue([
      { index: 1, enabled: false, text: 'ON x DO y ENDON', length: 15, free: 496 },
      { index: 2, enabled: false, text: '', length: 0, free: 511 },
      { index: 3, enabled: false, text: '', length: 0, free: 511 },
    ]);
    vi.mocked(api.timers).mockResolvedValue({ enabled: true, timers: Array.from({ length: 16 }, () => DEFAULT_TIMER) });
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
    expect(select).toHaveDisplayValue('unverändert (3)');
    await user.selectOptions(select, '1');
    await user.click(screen.getByRole('button', { name: 'Vormerken' }));
    await waitFor(() =>
      expect(api.stage).toHaveBeenCalledWith({ deviceIds: ['A'], settings: { PowerOnState: '1' }, source: 'detail' }),
    );
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
    expect(await screen.findByText('Rules konnten nicht gelesen werden: offline')).toBeInTheDocument();
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
