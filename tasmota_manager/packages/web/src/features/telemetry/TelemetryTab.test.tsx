import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { applyMessage } from '@/lib/live';
import { makeDevice } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { TelemetryTab } from './TelemetryTab';

vi.mock('@/lib/api', () => ({ api: { telemetry: vi.fn() }, ApiError: class extends Error {} }));

beforeEach(() => {
  vi.mocked(api.telemetry).mockReset();
});

function sample() {
  const now = Date.now();
  return {
    updatedAt: new Date(now).toISOString(),
    values: [
      { key: 'AM2301.Temperature', group: 'AM2301', name: 'Temperature', value: 21.3, unit: '°C' },
      { key: 'device.rssi', group: 'device', name: 'RSSI', value: 70, unit: '%' },
    ],
    history: { 'AM2301.Temperature': [[now - 120_000, 20] as [number, number], [now - 60_000, 21.3] as [number, number]] },
  };
}

describe('TelemetryTab', () => {
  it('zeigt Gruppen als Überschriften mit Werten samt Einheit', async () => {
    vi.mocked(api.telemetry).mockResolvedValue(sample());
    renderWithProviders(<TelemetryTab device={makeDevice({ id: 'A', channels: ['mqtt'] })} />);
    expect(await screen.findByText('AM2301')).toBeInTheDocument();
    expect(screen.getByText('Gerät')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^21,3 °C$/ })).toBeInTheDocument();
  });

  it('öffnet beim Klick auf einen Wert das Diagramm', async () => {
    vi.mocked(api.telemetry).mockResolvedValue(sample());
    const user = userEvent.setup();
    renderWithProviders(<TelemetryTab device={makeDevice({ id: 'A', channels: ['mqtt'] })} />);
    await user.click(await screen.findByRole('button', { name: /21,3/ }));
    expect(await screen.findByRole('img', { name: 'Temperature' })).toBeInTheDocument();
  });

  it('fordert ohne mqtt-Kanal eine HTTP-Auffrischung an, mit mqtt nicht', async () => {
    vi.mocked(api.telemetry).mockResolvedValue(sample());
    const { unmount } = renderWithProviders(<TelemetryTab device={makeDevice({ id: 'A', channels: ['http'] })} />);
    await screen.findByText('AM2301');
    expect(api.telemetry).toHaveBeenCalledWith('A', true);
    unmount();
    vi.mocked(api.telemetry).mockClear();
    renderWithProviders(<TelemetryTab device={makeDevice({ id: 'B', channels: ['mqtt'] })} />);
    await screen.findByText('AM2301');
    expect(api.telemetry).toHaveBeenCalledWith('B', false);
  });

  it('fragt bei HTTP-Geräten nach einem WS-Ereignis nicht erneut ab', async () => {
    vi.mocked(api.telemetry).mockResolvedValue(sample());
    const { queryClient } = renderWithProviders(<TelemetryTab device={makeDevice({ id: 'A', channels: ['http'] })} />);
    await screen.findByText('AM2301');
    expect(api.telemetry).toHaveBeenCalledTimes(1);
    applyMessage(queryClient, { type: 'telemetry', deviceId: 'A', updatedAt: new Date().toISOString(), headline: [] });
    applyMessage(queryClient, { type: 'telemetry', deviceId: 'A', updatedAt: new Date().toISOString(), headline: [] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.telemetry).toHaveBeenCalledTimes(1);
  });

  it('zeigt bei Offline-Geräten einen Hinweis', async () => {
    vi.mocked(api.telemetry).mockResolvedValue(sample());
    renderWithProviders(<TelemetryTab device={makeDevice({ id: 'A', online: false, channels: ['mqtt'] })} />);
    expect(await screen.findByText('offline – letzte bekannte Werte')).toBeInTheDocument();
  });

  it('zeigt ohne Werte den Leerhinweis', async () => {
    vi.mocked(api.telemetry).mockResolvedValue({ updatedAt: null, values: [], history: {} } as never);
    renderWithProviders(<TelemetryTab device={makeDevice({ id: 'A', channels: ['mqtt'] })} />);
    expect(await screen.findByText('Noch keine Telemetrie empfangen')).toBeInTheDocument();
  });
});
