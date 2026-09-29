import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { makeDevice } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { DevicesPage } from './DevicesPage';

vi.mock('@/lib/api', () => ({
  api: {
    devices: vi.fn(),
    device: vi.fn(),
    status: vi.fn(),
    scan: vi.fn(),
    addDevice: vi.fn(),
  },
  ApiError: class extends Error {},
}));

describe('DevicesPage', () => {
  beforeEach(() => {
    vi.mocked(api.devices).mockResolvedValue([
      makeDevice({ id: 'A', name: 'Keller-Licht', tags: ['Keller'] }),
      makeDevice({ id: 'B', name: 'Garage', online: false, channels: [] }),
      makeDevice({ id: 'C', name: 'Steckdose', channels: ['http'] }),
    ]);
    vi.mocked(api.status).mockResolvedValue({ mqtt: 'connected', version: 'x', scanning: false });
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
});
