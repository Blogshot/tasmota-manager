import { SETTINGS } from '@tm/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { makeDevice } from '@/test/fixtures';
import { renderWithProviders } from '@/test/render';
import { type FieldValues, SettingsFields } from './SettingsFields';

vi.mock('@/lib/api', () => ({ api: { status: vi.fn().mockResolvedValue({ haLocation: null, haSuggestions: { timezone: null, ntpServer: 'pool.ntp.org', mqtt: null, mqttUser: null, fahrenheit: null } }) }, ApiError: class extends Error {} }));

function Harness({ devices, onFastRule }: { devices: ReturnType<typeof makeDevice>[]; onFastRule?: () => void }) {
  const [values, setValues] = useState<FieldValues>({});
  return (
    <SettingsFields
      idPrefix="t"
      defs={SETTINGS.filter((d) => d.batch)}
      devices={devices}
      values={values}
      errors={{}}
      onFastRule={onFastRule}
      onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))}
    />
  );
}

const plug = makeDevice({ id: 'P', capabilities: ['energy', 'relay'] });
const lamp = makeDevice({ id: 'L', capabilities: ['light', 'relay'] });

describe('SettingsFields nach Gerätetyp', () => {
  it('zeigt nur passende Gruppen und wie viele Geräte betroffen sind', () => {
    renderWithProviders(<Harness devices={[plug, lamp]} />);
    expect(screen.getByText('Energiemessung')).toBeInTheDocument();
    expect(screen.getByText('Licht')).toBeInTheDocument();
    expect(screen.queryByText('Klima-Sensoren')).not.toBeInTheDocument();
    expect(screen.getAllByText('gilt für 1 von 2').length).toBeGreaterThan(0);
  });

  it('warnt bei kurzer TelePeriod und nennt PowerDelta nur bei Energiemessung', async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<Harness devices={[plug]} />);
    await user.type(screen.getByLabelText(/Telemetrie-Intervall/), '30');
    expect(screen.getByText('Kurze Intervalle füllen die Datenbank von Home Assistant.')).toBeInTheDocument();
    expect(screen.getByText('Für schnelle Leistungswerte besser PowerDelta verwenden.')).toBeInTheDocument();
    unmount();
    renderWithProviders(<Harness devices={[lamp]} />);
    await user.type(screen.getByLabelText(/Telemetrie-Intervall/), '30');
    expect(screen.queryByText('Für schnelle Leistungswerte besser PowerDelta verwenden.')).not.toBeInTheDocument();
  });

  it('bietet unter 10 s eine Regel an', async () => {
    const user = userEvent.setup();
    const onFastRule = vi.fn();
    renderWithProviders(<Harness devices={[plug]} onFastRule={onFastRule} />);
    await user.type(screen.getByLabelText(/Telemetrie-Intervall/), '5');
    await user.click(screen.getByRole('button', { name: 'Regel vorschlagen' }));
    expect(onFastRule).toHaveBeenCalled();
  });
});
