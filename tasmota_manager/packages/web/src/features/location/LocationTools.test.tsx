import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { SUGGESTIONS } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { LocationTools } from './LocationTools';

vi.mock('@/lib/api', () => ({ api: { status: vi.fn() }, ApiError: class extends Error {} }));
// Leaflet braucht ein echtes Layout; hier zählt nur, was die Karte meldet.
vi.mock('./MapPicker', () => ({
  default: ({ onPick, label }: { onPick: (lat: number, lon: number) => void; label: string }) => (
    <button type="button" aria-label={`${label} (Test)`} onClick={() => onPick(48.137154, 11.576124)} />
  ),
}));

const status = (haLocation: { latitude: number; longitude: number } | null) =>
  vi.mocked(api.status).mockResolvedValue({ mqtt: 'connected', version: 'x', scanning: false, haLocation, haSuggestions: SUGGESTIONS });

describe('LocationTools', () => {
  it('schlägt den Standort aus Home Assistant vor und übernimmt ihn per Klick', async () => {
    status({ latitude: 52.52, longitude: 13.405 });
    const onPick = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<LocationTools latitude="" longitude="" onPick={onPick} />);
    await user.click(await screen.findByRole('button', { name: /Aus Home Assistant: 52\.52000, 13\.40500/ }));
    expect(onPick).toHaveBeenCalledWith('52.52000', '13.40500');
  });

  it('zeigt keinen Vorschlag, wenn Home Assistant keinen Standort liefert', async () => {
    status(null);
    renderWithProviders(<LocationTools latitude="" longitude="" onPick={vi.fn()} />);
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Aus Home Assistant/ })).not.toBeInTheDocument();
  });

  it('übernimmt einen Ort aus der Karte, gerundet auf 5 Nachkommastellen', async () => {
    status(null);
    const onPick = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<LocationTools latitude="" longitude="" onPick={onPick} />);
    await user.click(screen.getByRole('button', { name: 'Auf Karte wählen' }));
    await user.click(await screen.findByRole('button', { name: 'Auf Karte wählen (Test)' }));
    expect(onPick).toHaveBeenCalledWith('48.13715', '11.57612');
  });
});
