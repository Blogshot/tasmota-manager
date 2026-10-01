import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { renderWithProviders } from '@/test/render';
import { MqttBanner } from './MqttBanner';

vi.mock('@/lib/api', () => ({ api: { status: vi.fn() }, ApiError: class extends Error {} }));

describe('MqttBanner', () => {
  it('warnt, wenn der Broker nicht erreichbar ist', async () => {
    vi.mocked(api.status).mockResolvedValue({ mqtt: 'disconnected', version: 'x', scanning: false, haLocation: null });
    renderWithProviders(<MqttBanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent('MQTT-Broker nicht erreichbar');
  });

  it('warnt auch während eines erneuten Verbindungsversuchs', async () => {
    vi.mocked(api.status).mockResolvedValue({ mqtt: 'connecting', version: 'x', scanning: false, haLocation: null });
    renderWithProviders(<MqttBanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent('MQTT-Broker nicht erreichbar');
  });

  it.each(['connected', 'disabled'] as const)('bleibt bei Status %s unsichtbar', async (mqtt) => {
    vi.mocked(api.status).mockResolvedValue({ mqtt, version: 'x', scanning: false, haLocation: null });
    renderWithProviders(<MqttBanner />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
