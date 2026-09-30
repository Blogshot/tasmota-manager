import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { makeDevice } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { PowerCell } from './PowerCell';

vi.mock('@/lib/api', () => ({ api: { command: vi.fn() }, ApiError: class extends Error {} }));

beforeEach(() => vi.mocked(api.command).mockReset());

describe('PowerCell', () => {
  it('zeigt pro Relais einen Button mit dem aktuellen Zustand', () => {
    renderWithProviders(<PowerCell device={makeDevice({ power: [true, false] })} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
    expect(buttons[1]).toHaveAttribute('aria-pressed', 'false');
  });

  it('zeigt nichts Schaltbares für Geräte ohne Relais', () => {
    renderWithProviders(<PowerCell device={makeDevice({ power: [] })} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('schaltet das angeklickte Relais sofort um, ohne die Zeile zu öffnen', async () => {
    vi.mocked(api.command).mockResolvedValue({ ok: true, channel: 'mqtt', response: { POWER2: 'ON' } });
    const onRowClick = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <div onClick={onRowClick}>
        <PowerCell device={makeDevice({ id: 'A', power: [true, false] })} />
      </div>,
    );
    await user.click(screen.getAllByRole('button')[1] as HTMLElement);
    await waitFor(() => expect(api.command).toHaveBeenCalledWith('A', 'Power2 TOGGLE'));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('sperrt die Buttons, wenn das Gerät offline ist oder ein Passwort fehlt', () => {
    renderWithProviders(<PowerCell device={makeDevice({ power: [true], online: false })} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('fasst mehr als vier Relais zusammen', () => {
    renderWithProviders(<PowerCell device={makeDevice({ power: [true, false, false, false, true, true] })} />);
    expect(screen.getAllByRole('button')).toHaveLength(4);
    expect(screen.getByText('+2')).toBeInTheDocument();
  });
});
