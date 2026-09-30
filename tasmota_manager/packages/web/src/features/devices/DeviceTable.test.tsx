import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { makeDevice } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { DeviceTable } from './DeviceTable';

vi.mock('@/lib/api', () => ({ api: { stageSuggestions: vi.fn() }, ApiError: class extends Error {} }));

const devices = [
  makeDevice({
    id: 'A',
    name: 'Tasmota',
    nameSuggestion: 'Klima Bad',
    ha: {
      deviceId: 'dev1',
      areaName: 'Bad',
      entities: [{ entityId: 'sensor.bad_temp', name: 'Temperatur Bad' }],
      automations: [
        { id: '1700000000', entityId: 'automation.licht_bad', name: 'Licht Bad' },
        { id: null, entityId: 'automation.yaml', name: 'YAML-Automation' },
      ],
    },
  }),
  makeDevice({ id: 'B', name: 'Garage', pendingName: 'Garage Tor', pendingCount: 2, setOption4: true }),
];

function renderTable(onOpen = vi.fn()) {
  renderWithProviders(<DeviceTable devices={devices} rowSelection={{}} onRowSelectionChange={vi.fn()} onOpen={onOpen} />);
  return onOpen;
}

describe('DeviceTable', () => {
  it('verlinkt HA-Entitäten und Automationen im Hauptfenster', () => {
    renderTable();
    const entity = screen.getByRole('link', { name: 'Temperatur Bad' });
    expect(entity).toHaveAttribute('href', '/config/entities?search=sensor.bad_temp');
    expect(entity).toHaveAttribute('target', '_top');
    expect(screen.getByRole('link', { name: 'Licht Bad' })).toHaveAttribute('href', '/config/automation/edit/1700000000');
    // Automationen ohne ID (YAML) sind nicht verlinkbar.
    expect(screen.queryByRole('link', { name: 'YAML-Automation' })).not.toBeInTheDocument();
    expect(screen.getByText('YAML-Automation')).toBeInTheDocument();
  });

  it('merkt den Namensvorschlag per Klick vor, ohne die Detailansicht zu öffnen', async () => {
    vi.mocked(api.stageSuggestions).mockResolvedValue({ staged: 2, skipped: 0 });
    const user = userEvent.setup();
    const onOpen = renderTable();
    await user.click(screen.getByRole('button', { name: /Klima Bad/ }));
    await waitFor(() => expect(api.stageSuggestions).toHaveBeenCalledWith(['A']));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('zeigt vorgemerkte Namen, ausstehende Änderungen und SetOption4', () => {
    renderTable();
    expect(screen.getByText('Garage')).toHaveClass('line-through');
    expect(screen.getByText('Garage Tor')).toBeInTheDocument();
    expect(screen.getByTitle('2 ausstehende Änderungen')).toBeInTheDocument();
    expect(screen.getByText('SO4')).toBeInTheDocument();
  });
});
