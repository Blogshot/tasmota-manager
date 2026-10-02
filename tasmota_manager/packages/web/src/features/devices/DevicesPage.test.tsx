import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { SUGGESTIONS, makeDevice } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { DevicesPage } from './DevicesPage';

vi.mock('@/lib/api', () => ({
  api: {
    devices: vi.fn(),
    device: vi.fn(),
    status: vi.fn(),
    scan: vi.fn(),
    addDevice: vi.fn(),
    removeDevice: vi.fn(),
  },
  ApiError: class extends Error {},
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe('DevicesPage', () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(api.removeDevice).mockReset();
    vi.mocked(api.devices).mockResolvedValue([
      makeDevice({ id: 'A', name: 'Keller-Licht', tags: ['Keller'] }),
      makeDevice({ id: 'B', name: 'Garage', online: false, channels: [] }),
      makeDevice({ id: 'C', name: 'Steckdose', channels: ['http'] }),
    ]);
    vi.mocked(api.status).mockResolvedValue({ mqtt: 'connected', version: 'x', scanning: false, haLocation: null, haSuggestions: SUGGESTIONS });
  });

  it('zeigt alle Geräte', async () => {
    renderWithProviders(<DevicesPage />);
    expect(await screen.findByText('Keller-Licht')).toBeInTheDocument();
    expect(screen.getByText('Garage')).toBeInTheDocument();
    expect(screen.getByText('Steckdose')).toBeInTheDocument();
  });

  it('filtert über Suche und Status', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DevicesPage />);
    await screen.findByText('Keller-Licht');
    await user.type(screen.getByLabelText('Suchen …'), 'gar');
    expect(screen.queryByText('Keller-Licht')).not.toBeInTheDocument();
    expect(screen.getByText('Garage')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Suchen …'));
    await user.selectOptions(screen.getByLabelText('Status'), 'offline');
    expect(screen.getByText('Garage')).toBeInTheDocument();
    expect(screen.queryByText('Steckdose')).not.toBeInTheDocument();
  });

  it('zählt ausgewählte Geräte und hebt die Auswahl auf', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DevicesPage />);
    await screen.findByText('Keller-Licht');
    const rows = screen.getAllByRole('row').slice(1);
    await user.click(within(rows[0] as HTMLElement).getByRole('checkbox'));
    await user.click(within(rows[1] as HTMLElement).getByRole('checkbox'));
    expect(screen.getByText('2 ausgewählt')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Auswahl aufheben' }));
    await waitFor(() => expect(screen.queryByText('2 ausgewählt')).not.toBeInTheDocument());
  });

  it('zeigt einen Hinweis ohne Geräte', async () => {
    vi.mocked(api.devices).mockResolvedValue([]);
    renderWithProviders(<DevicesPage />);
    expect(await screen.findByText(/Noch keine Geräte gefunden/)).toBeInTheDocument();
  });

  it('entfernt mehrere ausgewählte Geräte nach Rückfrage', async () => {
    vi.mocked(api.removeDevice).mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderWithProviders(<DevicesPage />);
    await screen.findByText('Keller-Licht');
    const rows = screen.getAllByRole('checkbox', { name: 'Zeile auswählen' });
    await user.click(rows[0] as HTMLElement);
    await user.click(rows[1] as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'Entfernen' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('2 Geräte'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Vorgemerkte Änderungen dieser Geräte werden verworfen.'));
    await waitFor(() => expect(api.removeDevice).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('2 Geräte entfernt'));
    expect(toast.error).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('meldet Teilfehler beim Entfernen und behält fehlgeschlagene Geräte in der Auswahl', async () => {
    vi.mocked(api.removeDevice).mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderWithProviders(<DevicesPage />);
    await screen.findByText('Keller-Licht');
    const rows = screen.getAllByRole('checkbox', { name: 'Zeile auswählen' });
    await user.click(rows[0] as HTMLElement);
    await user.click(rows[1] as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'Entfernen' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('1 Geräte konnten nicht entfernt werden'));
    expect(toast.success).toHaveBeenCalledWith('1 Geräte entfernt');
    expect(await screen.findByText('1 ausgewählt')).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('zeigt keine Erfolgsmeldung, wenn kein Gerät entfernt werden konnte', async () => {
    vi.mocked(api.removeDevice).mockRejectedValue(new Error('boom'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderWithProviders(<DevicesPage />);
    await screen.findByText('Keller-Licht');
    await user.click(screen.getAllByRole('checkbox', { name: 'Zeile auswählen' })[0] as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'Entfernen' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('1 Geräte konnten nicht entfernt werden'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByText('1 ausgewählt')).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('zeigt veraltete Geräte gekennzeichnet', async () => {
    vi.mocked(api.devices).mockResolvedValue([makeDevice({ id: 'S', name: 'Alt', online: false, stale: true })]);
    renderWithProviders(<DevicesPage />);
    expect(await screen.findByText('veraltet')).toHaveAttribute('title', 'Nicht in Home Assistant und seit über 7 Tagen nicht gesehen');
  });
});
