import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { renderWithProviders } from '@/test/render';
import { Console } from './Console';

vi.mock('@/lib/api', () => ({ api: { command: vi.fn() }, ApiError: class extends Error {} }));

describe('Console', () => {
  it('sendet Befehle und zeigt Antworten im Verlauf', async () => {
    vi.mocked(api.command).mockResolvedValueOnce({ ok: true, channel: 'mqtt', response: { POWER: 'ON' } });
    const user = userEvent.setup();
    renderWithProviders(<Console deviceId="AABBCC112233" />);
    await user.type(screen.getByPlaceholderText('Befehl, z. B. Status 0'), 'Power ON{Enter}');
    expect(api.command).toHaveBeenCalledWith('AABBCC112233', 'Power ON');
    expect(await screen.findByText('Power ON')).toBeInTheDocument();
    expect(screen.getByText(/"POWER": "ON"/)).toBeInTheDocument();
    expect(screen.getByText('über MQTT')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Befehl, z. B. Status 0')).toHaveValue('');
  });

  it('zeigt Fehler mit Code', async () => {
    vi.mocked(api.command).mockResolvedValueOnce({ ok: false, code: 'rejected', message: 'Gerät lehnt den Befehl "Foo" ab' });
    const user = userEvent.setup();
    renderWithProviders(<Console deviceId="AABBCC112233" />);
    await user.type(screen.getByPlaceholderText('Befehl, z. B. Status 0'), 'Foo{Enter}');
    expect(await screen.findByText(/rejected/)).toBeInTheDocument();
  });
});
