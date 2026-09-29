import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { renderWithProviders } from '@/test/render';
import { MqttBanner } from './MqttBanner';

vi.mock('@/lib/api', () => ({ api: { status: vi.fn() }, ApiError: class extends Error {} }));

describe('MqttBanner', () => {
  it('warnt, wenn der Broker nicht erreichbar ist', async () => {
    vi.mocked(api.status).mockResolvedValue({ mqtt: 'disconnected', version: 'x', scanning: false });
    renderWithProviders(<MqttBanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent('MQTT-Broker nicht erreichbar');
  });

  it('bleibt bei verbundenem Broker unsichtbar', async () => {
    vi.mocked(api.status).mockResolvedValue({ mqtt: 'connected', version: 'x', scanning: false });
    renderWithProviders(<MqttBanner />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
