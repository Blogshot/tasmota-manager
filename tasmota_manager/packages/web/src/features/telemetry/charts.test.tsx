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

const HOUR = 3_600_000;
const NOW = 10_000_000;
const recent = (values: number[], stepMs = 60_000): Array<[number, number]> =>
  values.map((v, i) => [NOW - (values.length - 1 - i) * stepMs, v]);
const firstX = (el: Element | null) => Number((el?.getAttribute('points') ?? '').split(' ')[0]?.split(',')[0]);

describe('HistoryChart', () => {
  it('zeigt Min, Max und aktuellen Wert und einen Tooltip am nächsten Punkt', () => {
    renderWithProviders(<HistoryChart points={recent([10, 30, 20])} unit="W" label="Power" now={NOW} />);
    expect(screen.getByText('Min')).toBeInTheDocument();
    expect(screen.getAllByText('10 W', exact).length).toBeGreaterThan(0);
    expect(screen.getAllByText('30 W', exact).length).toBeGreaterThan(0);
    const plot = screen.getByRole('img', { name: 'Power' });
    fireEvent.pointerMove(plot, { clientX: 0, clientY: 10 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('10 W', { normalizeWhitespace: false });
  });

  it('zeigt ohne Verlauf einen Hinweis statt einer Linie', () => {
    renderWithProviders(<HistoryChart points={recent([10])} unit="W" label="Power" now={NOW} />);
    expect(screen.getByText('Noch kein Verlauf')).toBeInTheDocument();
  });

  it('zeichnet 10 Minuten Daten im rechten Teil des 60-Minuten-Fensters', () => {
    const { container } = renderWithProviders(
      <HistoryChart points={recent([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 60_000)} unit="W" label="Power" now={NOW} />,
    );
    expect(firstX(container.querySelector('svg[role="img"] polyline'))).toBeGreaterThan(160);
  });

  it('zeigt "Noch kein Verlauf", wenn alle Punkte älter als 60 Minuten sind', () => {
    const old: Array<[number, number]> = [
      [NOW - HOUR - 120_000, 1],
      [NOW - HOUR - 60_000, 2],
    ];
    renderWithProviders(<HistoryChart points={old} unit="W" label="Power" now={NOW} />);
    expect(screen.getByText('Noch kein Verlauf')).toBeInTheDocument();
  });

  it('beschriftet die y-Achse mit Max oben und Min unten', () => {
    const { container } = renderWithProviders(<HistoryChart points={recent([10, 30, 20])} unit="W" label="Power" now={NOW} />);
    const texts = [...container.querySelectorAll('svg[role="img"] text')].map((n) => n.textContent);
    expect(texts).toEqual(['30 W', '10 W']);
  });

  it('rastet bei bekannter Breite am nächsten Punkt ein', () => {
    renderWithProviders(<HistoryChart points={recent([10, 30, 20])} unit="W" label="Power" now={NOW} />);
    const plot = screen.getByRole('img', { name: 'Power' });
    plot.getBoundingClientRect = () => ({ left: 0, width: 320, top: 0, height: 140, right: 320, bottom: 140, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(plot, { clientX: 310, clientY: 10 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('20 W', { normalizeWhitespace: false });
  });
});
