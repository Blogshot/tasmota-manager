import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { makeDevice } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { DeviceSheet } from './DeviceSheet';

vi.mock('@/lib/api', () => ({
  api: { devices: vi.fn(), device: vi.fn(), updateDevice: vi.fn(), removeDevice: vi.fn(), command: vi.fn() },
  ApiError: class extends Error {},
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe('DeviceSheet', () => {
  beforeEach(() => {
    const device = makeDevice({ tags: ['Keller'] });
    vi.mocked(api.devices).mockResolvedValue([device]);
    vi.mocked(api.device).mockResolvedValue({ ...device, status: {} });
  });

  it('zeigt Gerätedaten', async () => {
    renderWithProviders(<DeviceSheet deviceId="AABBCC112233" onClose={vi.fn()} onSwitch={vi.fn()} />);
    // Der Statuspunkt steuert einen Screenreader-Text zum Überschriftennamen bei.
    expect(await screen.findByRole('heading', { name: /Keller-Licht/ })).toBeInTheDocument();
    expect(screen.getByText('keller-1234')).toBeInTheDocument();
    expect(screen.getByText('ESP8266EX')).toBeInTheDocument();
  });

  it('speichert Tags und Passwort', async () => {
    vi.mocked(api.updateDevice).mockResolvedValue(makeDevice({ tags: ['Keller', 'Licht'], hasPasswordOverride: true }));
    const user = userEvent.setup();
    renderWithProviders(<DeviceSheet deviceId="AABBCC112233" onClose={vi.fn()} onSwitch={vi.fn()} />);
    const tags = await screen.findByLabelText('Tags');
    await user.clear(tags);
    await user.type(tags, 'Keller, Licht');
    await user.type(screen.getByLabelText('Passwort nur für dieses Gerät'), 'geheim');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() =>
      expect(api.updateDevice).toHaveBeenCalledWith('AABBCC112233', { tags: ['Keller', 'Licht'], password: 'geheim' }),
    );
  });

  it('wechselt zum echten Gerät, wenn ein Platzhalter aufgelöst wird', async () => {
    const placeholder = makeDevice({ id: 'IP-10.0.0.9', name: '10.0.0.9', authRequired: true });
    vi.mocked(api.devices).mockResolvedValue([placeholder]);
    vi.mocked(api.device).mockResolvedValue({ ...placeholder, status: null });
    vi.mocked(api.updateDevice).mockResolvedValue(makeDevice({ id: 'AABBCC112233' }));
    const onSwitch = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<DeviceSheet deviceId="IP-10.0.0.9" onClose={vi.fn()} onSwitch={onSwitch} />);
    await user.type(await screen.findByLabelText('Passwort nur für dieses Gerät'), 'geheim');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith('AABBCC112233'));
  });

  it('zeigt einen Fehler-Toast, wenn eine Aktion fehlschlägt', async () => {
    vi.mocked(api.command).mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    renderWithProviders(<DeviceSheet deviceId="AABBCC112233" onClose={vi.fn()} onSwitch={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Schalten' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Fehler: Gerät nicht erreichbar'));
  });
});
