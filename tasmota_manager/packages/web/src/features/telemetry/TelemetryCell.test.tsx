import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { renderWithProviders } from '@/test/render';
import { TelemetryCell } from './TelemetryCell';

vi.mock('@/lib/api', () => ({ api: { telemetrySummary: vi.fn(), telemetry: vi.fn() }, ApiError: class extends Error {} }));

beforeEach(() => {
  vi.mocked(api.telemetrySummary).mockReset();
  vi.mocked(api.telemetry).mockReset();
});

describe('TelemetryCell', () => {
  it('zeigt den Hauptwert als Button und öffnet das Diagramm, ohne die Zeile zu öffnen', async () => {
    const now = Date.now();
    vi.mocked(api.telemetrySummary).mockResolvedValue({ A: [{ key: 'ENERGY.Power', group: 'ENERGY', name: 'Power', value: 12.3, unit: 'W' }] });
    vi.mocked(api.telemetry).mockResolvedValue({
      updatedAt: new Date(now).toISOString(),
      values: [],
      history: { 'ENERGY.Power': [[now - 120_000, 10], [now - 60_000, 12.3]] },
    });
    const onRowClick = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <div onClick={onRowClick}>
        <TelemetryCell deviceId="A" />
      </div>,
    );
    const button = await screen.findByRole('button', { name: 'Power: 12,3 W' });
    await user.click(button);
    expect(await screen.findByRole('img', { name: 'Power' })).toBeInTheDocument();
    expect(api.telemetry).toHaveBeenCalledWith('A');
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('zeigt einen Strich für Geräte ohne Werte', async () => {
    vi.mocked(api.telemetrySummary).mockResolvedValue({});
    renderWithProviders(<TelemetryCell deviceId="A" />);
    expect(await screen.findByText('—')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
