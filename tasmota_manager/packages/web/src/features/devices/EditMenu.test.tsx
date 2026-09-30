import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { makeDevice } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { EditMenu } from './EditMenu';

vi.mock('@/lib/api', () => ({
  api: { stage: vi.fn(), stageSuggestions: vi.fn() },
  ApiError: class extends Error {},
}));

const devices = [makeDevice({ id: 'A', name: 'Keller' }), makeDevice({ id: 'B', name: 'Bad' })];

describe('EditMenu', () => {
  beforeEach(() => {
    vi.mocked(api.stage).mockResolvedValue({ staged: 2, skipped: 0 });
    vi.mocked(api.stageSuggestions).mockResolvedValue({ staged: 0, skipped: 0 });
  });

  it('merkt Einstellungen aus dem Formular für alle ausgewählten Geräte vor', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EditMenu devices={devices} />);
    await user.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Einstellungen …' }));
    await user.selectOptions(await screen.findByLabelText('Zustand nach Stromausfall'), '1');
    await user.type(screen.getByLabelText('Telemetrie-Intervall in s (10–3600)'), '60');
    await user.click(screen.getByRole('button', { name: 'Vormerken' }));
    await waitFor(() =>
      expect(api.stage).toHaveBeenCalledWith({ deviceIds: ['A', 'B'], settings: { PowerOnState: '1', TelePeriod: '60' }, source: 'form' }),
    );
  });

  it('zeigt Feldfehler statt ungültige Werte vorzumerken', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EditMenu devices={devices} />);
    await user.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Einstellungen …' }));
    await user.type(await screen.findByLabelText('Telemetrie-Intervall in s (10–3600)'), '5');
    await user.click(screen.getByRole('button', { name: 'Vormerken' }));
    expect(await screen.findByText('Erlaubt: 10–3600')).toBeInTheDocument();
    expect(api.stage).not.toHaveBeenCalled();
  });

  it('merkt freie Befehle mit Platzhaltern vor und zeigt eine Vorschau', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EditMenu devices={devices} />);
    await user.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Befehle …' }));
    await user.click(await screen.findByLabelText('Befehle'));
    await user.paste('FriendlyName1 {{name}}\nPower ON');
    expect(screen.getByText(/FriendlyName1 Keller/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Vormerken' }));
    await waitFor(() =>
      expect(api.stage).toHaveBeenCalledWith({
        deviceIds: ['A', 'B'],
        commands: ['FriendlyName1 {{name}}', 'Power ON'],
        source: 'command',
      }),
    );
  });

  it('übernimmt Namensvorschläge für die Auswahl', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EditMenu devices={devices} />);
    await user.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Namensvorschläge übernehmen' }));
    await waitFor(() => expect(api.stageSuggestions).toHaveBeenCalledWith(['A', 'B']));
  });

  it('setzt eine Rule für alle ausgewählten Geräte', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EditMenu devices={devices} />);
    await user.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rule setzen …' }));
    await user.selectOptions(await screen.findByLabelText('Rule-Nummer'), '2');
    await user.click(screen.getByLabelText('Rule 2'));
    await user.paste('ON Power1#State DO Publish x ENDON');
    await user.click(screen.getByRole('button', { name: 'Vormerken' }));
    await waitFor(() =>
      expect(api.stage).toHaveBeenCalledWith({
        deviceIds: ['A', 'B'],
        settings: { Rule2: 'ON Power1#State DO Publish x ENDON', Rule2Enabled: '1' },
        source: 'rule',
      }),
    );
  });

  it('setzt einen Timer für alle ausgewählten Geräte', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EditMenu devices={devices} />);
    await user.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Timer setzen …' }));
    await user.selectOptions(await screen.findByLabelText('Timer-Nummer'), '4');
    const time = screen.getByLabelText('Zeit (HH:MM)');
    await user.clear(time);
    await user.type(time, '06:45');
    await user.click(screen.getByRole('button', { name: 'Vormerken' }));
    await waitFor(() => expect(api.stage).toHaveBeenCalled());
    const request = vi.mocked(api.stage).mock.calls.at(-1)?.[0];
    expect(request?.source).toBe('timer');
    expect(request?.settings?.Timers).toBe('1');
    expect(JSON.parse(request?.settings?.Timer4 ?? '')).toMatchObject({ Enable: 1, Time: '06:45', Days: '1111111', Repeat: 1 });
  });
});
