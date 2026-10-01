import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { makeDevice } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { DeviceTable } from './DeviceTable';

vi.mock('@/lib/api', () => ({ api: { stageSuggestions: vi.fn(), updateDevice: vi.fn() }, ApiError: class extends Error {} }));

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
    // HA kann die Entitätenliste nicht per URL durchsuchen; der Link führt deshalb auf die Geräteseite.
    expect(entity).toHaveAttribute('href', '/config/devices/device/dev1');
    expect(entity).toHaveAttribute('target', '_top');
    expect(screen.getByRole('link', { name: 'Licht Bad' })).toHaveAttribute('href', '/config/automation/edit/1700000000');
    // Automationen ohne ID (YAML) sind nicht verlinkbar.
    expect(screen.queryByRole('link', { name: 'YAML-Automation' })).not.toBeInTheDocument();
    expect(screen.getByText('YAML-Automation')).toBeInTheDocument();
  });

  it('zeigt höchstens drei Entitäten und den Rest hinter einem „…"-Button', async () => {
    const names = ['Schalter', 'Leistung', 'Spannung', 'Strom', 'Energie heute'];
    const device = makeDevice({
      id: 'C',
      ha: { deviceId: 'dev3', areaName: null, entities: names.map((name, i) => ({ entityId: `sensor.e${i}`, name })), automations: [] },
    });
    const onOpen = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<DeviceTable devices={[device]} rowSelection={{}} onRowSelectionChange={vi.fn()} onOpen={onOpen} />);
    expect(screen.getByRole('link', { name: 'Spannung' })).toBeInTheDocument();
    expect(screen.queryByText('Strom')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '2 weitere Entitäten' }));
    expect(await screen.findByRole('menuitem', { name: 'Strom' })).toHaveAttribute('href', '/config/devices/device/dev3');
    expect(screen.getByRole('menuitem', { name: 'Energie heute' })).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('merkt den Namensvorschlag per Klick vor, ohne die Detailansicht zu öffnen', async () => {
    vi.mocked(api.stageSuggestions).mockResolvedValue({ staged: 2, skipped: 0 });
    const user = userEvent.setup();
    const onOpen = renderTable();
    await user.click(screen.getByRole('button', { name: 'Klima Bad' }));
    await waitFor(() => expect(api.stageSuggestions).toHaveBeenCalledWith(['A']));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('lehnt einen Namensvorschlag per X ab, ohne ihn vorzumerken', async () => {
    vi.mocked(api.updateDevice).mockResolvedValue(makeDevice({ id: 'A', suggestionDismissed: true }));
    vi.mocked(api.stageSuggestions).mockClear();
    const user = userEvent.setup();
    const onOpen = renderTable();
    await user.click(screen.getByRole('button', { name: 'Vorschlag „Klima Bad“ ablehnen' }));
    await waitFor(() => expect(api.updateDevice).toHaveBeenCalledWith('A', { suggestionDismissed: true }));
    expect(api.stageSuggestions).not.toHaveBeenCalled();
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
