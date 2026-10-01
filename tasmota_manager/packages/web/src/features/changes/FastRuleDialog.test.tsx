import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { renderWithProviders } from '@/test/render';
import { FastRuleDialog } from './FastRuleDialog';

vi.mock('@/lib/api', () => ({ api: { fastRulePreview: vi.fn(), fastRuleStage: vi.fn() }, ApiError: class extends Error {} }));

describe('FastRuleDialog', () => {
  it('zeigt die Vorschau pro Gerät und merkt die Regeln vor', async () => {
    vi.mocked(api.fastRulePreview).mockResolvedValue([
      { deviceId: 'A', deviceName: 'Bad', rule: 'ON AM2301#Temperature DO TelePeriod ENDON', slot: 1, included: ['AM2301'], omitted: ['ENERGY'], reason: 'ok' },
      { deviceId: 'B', deviceName: 'Flur', rule: null, slot: null, included: [], omitted: [], reason: 'noSensors' },
    ]);
    vi.mocked(api.fastRuleStage).mockResolvedValue({ staged: 3, skipped: 0, incompatible: 0 });
    const onStaged = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<FastRuleDialog deviceIds={['A', 'B']} open onOpenChange={vi.fn()} onStaged={onStaged} />);
    expect(await screen.findByText('ON AM2301#Temperature DO TelePeriod ENDON')).toBeInTheDocument();
    expect(screen.getByText('wird zu Rule 1')).toBeInTheDocument();
    expect(screen.getByText('Nicht enthalten: ENERGY')).toBeInTheDocument();
    expect(screen.getByText('Keine passenden Sensoren')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Regeln vormerken' }));
    await waitFor(() => expect(api.fastRuleStage).toHaveBeenCalledWith(['A']));
    expect(onStaged).toHaveBeenCalled();
  });
});
