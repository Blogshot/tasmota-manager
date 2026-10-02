import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { SIGNAL_STOPS, SignalStrength, signalBars, signalColor, signalLevel } from './signal';

describe('signalBars / signalLevel', () => {
  it('ordnet dBm vier Stufen zu', () => {
    expect([-40, -55, -56, -67, -68, -75, -76, -95].map(signalBars)).toEqual([4, 4, 3, 3, 2, 2, 1, 1]);
    expect(signalLevel(-60)).toBe('signal.good');
    expect(signalLevel(-90)).toBe('signal.weak');
  });
});

describe('signalColor', () => {
  it('liefert an den Stützpunkten deren Farbe und dazwischen eine Mischung', () => {
    expect(signalColor(-50, 'light')).toBe(SIGNAL_STOPS[0]!.light);
    expect(signalColor(-30, 'dark')).toBe(SIGNAL_STOPS[0]!.dark);
    expect(signalColor(-99, 'light')).toBe(SIGNAL_STOPS.at(-1)!.light);
    expect(signalColor(-65, 'light')).toBe(`color-mix(in oklch, ${SIGNAL_STOPS[1]!.light} 50%, ${SIGNAL_STOPS[2]!.light})`);
  });
});

describe('SignalStrength', () => {
  it('zeigt Wert, Balken und die Stufe in Worten', () => {
    const { container } = renderWithProviders(<SignalStrength dbm={-63} />);
    const el = screen.getByLabelText(/^Gut \(-63.dBm\)$/);
    expect(el).toHaveTextContent(/-63.dBm/);
    expect(container.querySelectorAll('[data-bar="on"]')).toHaveLength(3);
    expect(el.getAttribute('style')).toContain('--signal-light');
  });

  it('graut veraltete Werte aus', () => {
    renderWithProviders(<SignalStrength dbm={-63} stale />);
    const el = screen.getByLabelText(/^Gut \(-63.dBm\)$/);
    expect(el.className).toContain('text-muted-foreground');
    expect(el.getAttribute('style') ?? '').not.toContain('--signal-light');
  });
});
