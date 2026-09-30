import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { RuleEditor, highlightRule } from './RuleEditor';

function Harness({ initial, max }: { initial: string; max?: number }) {
  const [value, setValue] = useState(initial);
  return (
    <I18nProvider lang="de">
      <label htmlFor="rule">Rule</label>
      <RuleEditor id="rule" value={value} onChange={setValue} max={max} />
    </I18nProvider>
  );
}

describe('highlightRule', () => {
  it('markiert Schlüsselwörter, Variablen und Speicher', () => {
    render(<pre>{highlightRule('ON Power1#State DO Var1 %value% ENDON')}</pre>);
    expect(screen.getByText('ON')).toHaveAttribute('data-token', 'keyword');
    expect(screen.getByText('DO')).toHaveAttribute('data-token', 'keyword');
    expect(screen.getByText('%value%')).toHaveAttribute('data-token', 'variable');
    expect(screen.getByText('Var1')).toHaveAttribute('data-token', 'memory');
  });
});

describe('RuleEditor', () => {
  it('zählt Zeichen und warnt bei Überlänge', async () => {
    const user = userEvent.setup();
    render(<Harness initial="abc" max={5} />);
    expect(screen.getByText('3 / 5 Zeichen')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Rule'), 'def');
    expect(screen.getByText(/6 \/ 5 Zeichen – Die Rule ist zu lang\./)).toBeInTheDocument();
  });
});
