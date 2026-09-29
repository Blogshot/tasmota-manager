import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { renderWithProviders } from '@/test/render';
import { SettingsPage } from './SettingsPage';

vi.mock('@/lib/api', () => ({
  api: { settings: vi.fn(), updateSettings: vi.fn(), status: vi.fn() },
  ApiError: class extends Error {},
}));

const SETTINGS = {
  scanCidrs: ['192.168.1.0/24'],
  pollIntervalSec: 60,
  concurrency: { command: 10, ota: 3, backup: 5 },
  backupRetention: 10,
  firmwarePort: 8266,
  hasGlobalPassword: false,
};

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.mocked(api.settings).mockResolvedValue(SETTINGS);
    vi.mocked(api.status).mockResolvedValue({ mqtt: 'connected', version: 'x', scanning: false });
    vi.mocked(api.updateSettings).mockImplementation(async (patch) => ({ ...SETTINGS, ...patch, hasGlobalPassword: false }));
  });

  it('zeigt den MQTT-Status', async () => {
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText('Mit dem MQTT-Broker verbunden.')).toBeInTheDocument();
  });

  it('lehnt zu große Scan-Bereiche ab', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const cidrs = await screen.findByLabelText('Scan-Bereiche (CIDR)');
    await user.clear(cidrs);
    await user.type(cidrs, '10.0.0.0/8');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(screen.getByText('Ungültiger Bereich: 10.0.0.0/8')).toBeInTheDocument();
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it('speichert gültige Werte und ein neues Passwort', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const cidrs = await screen.findByLabelText('Scan-Bereiche (CIDR)');
    await user.clear(cidrs);
    await user.type(cidrs, '10.0.0.0/24{Enter}10.0.1.0/24');
    const poll = screen.getByLabelText('Abfrageintervall für HTTP-Geräte (Sekunden)');
    await user.clear(poll);
    await user.type(poll, '30');
    await user.type(screen.getByLabelText('Globales Web-Passwort'), 'geheim');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        scanCidrs: ['10.0.0.0/24', '10.0.1.0/24'],
        pollIntervalSec: 30,
        globalPassword: 'geheim',
      }),
    );
  });
});
