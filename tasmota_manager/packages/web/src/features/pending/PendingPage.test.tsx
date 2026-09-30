import type { JobView, PendingDevice } from '@tm/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { renderWithProviders } from '@/test/render';
import { PendingPage } from './PendingPage';

vi.mock('@/lib/api', () => ({
  api: {
    changes: vi.fn(),
    currentJob: vi.fn(),
    apply: vi.fn(),
    discardChange: vi.fn(),
    discardDevice: vi.fn(),
    discardAll: vi.fn(),
    rules: vi.fn(),
    timers: vi.fn(),
  },
  ApiError: class extends Error {},
}));

const change = (partial: Partial<PendingDevice['changes'][number]>) => ({
  id: 1,
  deviceId: 'A',
  kind: 'setting' as const,
  key: 'PowerOnState',
  value: '1',
  before: '3',
  source: 'form' as const,
  error: null,
  updatedAt: 'x',
  ...partial,
});

const GROUPS: PendingDevice[] = [
  {
    deviceId: 'A',
    deviceName: 'Keller',
    changes: [
      change({ id: 1 }),
      change({ id: 2, key: 'Rule1', value: 'ON x DO y ENDON', before: null }),
      change({ id: 3, kind: 'command', key: null, value: 'Power ON', before: null, error: 'rejected: Device rejects the command "Power"' }),
    ],
  },
  { deviceId: 'B', deviceName: 'Bad', changes: [change({ id: 4, deviceId: 'B', key: 'MqttPassword', value: '••••', before: null })] },
];

const JOB: JobView = {
  id: 1,
  status: 'running',
  createdAt: 'x',
  finishedAt: null,
  items: [
    { deviceId: 'A', deviceName: 'Keller', status: 'running', step: 'restart', error: null },
    { deviceId: 'B', deviceName: 'Bad', status: 'success', step: null, error: null },
  ],
};

describe('PendingPage', () => {
  beforeEach(() => {
    vi.mocked(api.changes).mockResolvedValue(GROUPS);
    vi.mocked(api.currentJob).mockResolvedValue({ job: null });
    vi.mocked(api.apply).mockResolvedValue({ ...JOB, status: 'running' });
    vi.mocked(api.discardChange).mockResolvedValue(undefined);
    vi.mocked(api.rules).mockResolvedValue([
      { index: 1, enabled: false, text: 'alt', length: 3, free: 508 },
      { index: 2, enabled: false, text: '', length: 0, free: 511 },
      { index: 3, enabled: false, text: '', length: 0, free: 511 },
    ]);
  });

  it('zeigt Änderungen gruppiert mit Vorher/Nachher und Fehlern', async () => {
    renderWithProviders(<PendingPage />);
    const keller = await screen.findByTestId('pending-A');
    expect(within(keller).getByText('Zustand nach Stromausfall')).toBeInTheDocument();
    expect(within(keller).getByText('3')).toHaveClass('line-through');
    expect(within(keller).getByText('Power ON')).toBeInTheDocument();
    expect(within(keller).getByText('Das Gerät hat den Befehl abgelehnt')).toBeInTheDocument();
    expect(within(screen.getByTestId('pending-B')).getByText('••••')).toBeInTheDocument();
  });

  it('lädt den aktuellen Wert einer Rule bei Bedarf', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PendingPage />);
    const keller = await screen.findByTestId('pending-A');
    await user.click(within(keller).getByRole('button', { name: 'Aktuellen Wert laden' }));
    expect(await within(keller).findByText('alt')).toBeInTheDocument();
    expect(api.rules).toHaveBeenCalledWith('A');
  });

  it('startet den Batch für alle Geräte', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PendingPage />);
    await user.click(await screen.findByRole('button', { name: 'Batch starten (2 Geräte)' }));
    await waitFor(() => expect(api.apply).toHaveBeenCalledWith(undefined));
  });

  it('startet fehlgeschlagene Geräte erneut', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PendingPage />);
    await user.click(await screen.findByRole('button', { name: 'Fehlgeschlagene erneut starten' }));
    await waitFor(() => expect(api.apply).toHaveBeenCalledWith(['A']));
  });

  it('verwirft einzelne Einträge', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PendingPage />);
    const keller = await screen.findByTestId('pending-A');
    await user.click(within(keller).getAllByRole('button', { name: 'Verwerfen' })[0] as HTMLElement);
    await waitFor(() => expect(api.discardChange).toHaveBeenCalledWith(1));
  });

  it('zeigt den Fortschritt eines laufenden Batches und sperrt den Start', async () => {
    vi.mocked(api.currentJob).mockResolvedValue({ job: JOB });
    renderWithProviders(<PendingPage />);
    expect(await screen.findByText('Warte auf Neustart')).toBeInTheDocument();
    expect(screen.getByText('Erfolgreich')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Batch läuft …' })).toBeDisabled();
  });

  it('zeigt einen Hinweis ohne ausstehende Änderungen', async () => {
    vi.mocked(api.changes).mockResolvedValue([]);
    renderWithProviders(<PendingPage />);
    expect(await screen.findByText(/Keine ausstehenden Änderungen/)).toBeInTheDocument();
  });
});
