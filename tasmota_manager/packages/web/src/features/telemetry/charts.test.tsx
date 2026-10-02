import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { HistoryChart, Sparkline, formatTelemetry } from './charts';

const pts = (values: number[]): Array<[number, number]> => values.map((v, i) => [1_000_000 + i * 60_000, v]);

// Der Standard-Normalizer macht aus U+202F ein normales Leerzeichen; hier exakt vergleichen.
const exact = { normalizer: (text: string) => text };

describe('formatTelemetry', () => {
  it('formatiert Zahlen in der Sprache mit Einheit', () => {
    expect(formatTelemetry(21.346, '°C', 'de')).toBe('21,35\u202F°C');
    expect(formatTelemetry(12, 'W', 'en')).toBe('12\u202FW');
    expect(formatTelemetry('ON', null, 'de')).toBe('ON');
  });
});

describe('Sparkline', () => {
  it('zeichnet erst ab zwei Punkten, ohne NaN bei konstanter Reihe', () => {
    const { container, rerender } = render(<Sparkline points={pts([5])} />);
    expect(container.querySelector('svg')).toBeNull();
    rerender(<Sparkline points={pts([5, 5, 5])} />);
    expect(container.querySelector('polyline')?.getAttribute('points')).not.toMatch(/NaN/);
  });
});

describe('HistoryChart', () => {
  it('zeigt Min, Max und aktuellen Wert und einen Tooltip am nächsten Punkt', () => {
    renderWithProviders(<HistoryChart points={pts([10, 30, 20])} unit="W" label="Power" />);
    expect(screen.getByText('Min')).toBeInTheDocument();
    expect(screen.getByText('10\u202FW', exact)).toBeInTheDocument();
    expect(screen.getByText('30\u202FW', exact)).toBeInTheDocument();
    const plot = screen.getByRole('img', { name: 'Power' });
    fireEvent.pointerMove(plot, { clientX: 0, clientY: 10 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('10\u202FW', { normalizeWhitespace: false });
  });

  it('zeigt ohne Verlauf einen Hinweis statt einer Linie', () => {
    renderWithProviders(<HistoryChart points={pts([10])} unit="W" label="Power" />);
    expect(screen.getByText('Noch kein Verlauf')).toBeInTheDocument();
  });
});
