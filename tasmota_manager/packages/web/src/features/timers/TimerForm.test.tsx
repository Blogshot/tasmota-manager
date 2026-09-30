import { DEFAULT_TIMER, type Timer } from '@tm/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { I18nProvider, formatMessage } from '@/lib/i18n';
import { de } from '@/lib/messages';
import { TimerForm, timerSummary, toggleDay } from './TimerForm';

function Harness({ onChange }: { onChange: (t: Timer) => void }) {
  const [value, setValue] = useState<Timer>(DEFAULT_TIMER);
  return (
    <I18nProvider lang="de">
      <TimerForm
        id="t1"
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
    </I18nProvider>
  );
}

describe('TimerForm', () => {
  it('setzt Tage, Modus und Aktion', async () => {
    const user = userEvent.setup();
    const changes: Timer[] = [];
    render(<Harness onChange={(t) => changes.push(t)} />);
    await user.click(screen.getByRole('checkbox', { name: 'Aktiv' }));
    await user.click(screen.getByRole('checkbox', { name: 'Mo' }));
    await user.selectOptions(screen.getByLabelText('Modus'), '2');
    await user.selectOptions(screen.getByLabelText('Aktion'), '1');
    expect(changes.at(-1)).toMatchObject({ Enable: 1, Days: '0100000', Mode: 2, Action: 1 });
    expect(screen.getByText('Für Sonnenzeiten müssen Breiten- und Längengrad gesetzt sein.')).toBeInTheDocument();
    expect(screen.getByLabelText('Versatz (±HH:MM)')).toBeInTheDocument();
  });

  it('schlägt für den Versatz kein Format vor, das das Gerät nicht zurückmeldet', async () => {
    const user = userEvent.setup();
    render(<Harness onChange={() => undefined} />);
    expect(screen.getByLabelText('Zeit (HH:MM)')).toHaveAttribute('placeholder', '06:30');
    await user.selectOptions(screen.getByLabelText('Modus'), '1');
    expect(screen.getByLabelText('Versatz (±HH:MM)')).toHaveAttribute('placeholder', '-00:30');
  });

  it('entfernt das Vorzeichen beim Wechsel zurück auf Uhrzeit', async () => {
    const user = userEvent.setup();
    const changes: Timer[] = [];
    render(<Harness onChange={(t) => changes.push(t)} />);
    await user.selectOptions(screen.getByLabelText('Modus'), '2');
    const offset = screen.getByLabelText('Versatz (±HH:MM)');
    await user.clear(offset);
    await user.type(offset, '-00:30');
    expect(changes.at(-1)).toMatchObject({ Mode: 2, Time: '-00:30' });
    await user.selectOptions(screen.getByLabelText('Modus'), '0');
    expect(changes.at(-1)).toMatchObject({ Mode: 0, Time: '00:30' });
  });

  it('fasst Timer zusammen', () => {
    const t = (key: keyof typeof de, vars?: Record<string, string | number>) => formatMessage(de[key], vars);
    expect(toggleDay('0000000', 6, true)).toBe('0000001');
    expect(timerSummary(DEFAULT_TIMER, t)).toBe('inaktiv');
    expect(timerSummary({ ...DEFAULT_TIMER, Enable: 1, Time: '06:30', Days: '0111110', Action: 1, Output: 2 }, t)).toBe(
      'Uhrzeit 06:30 · Mo, Di, Mi, Do, Fr · An → 2',
    );
  });
});
