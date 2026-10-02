import { describe, expect, it } from 'vitest';
import { makeDevice } from '@/test/fixtures';
import { filterDevices } from './filter';
import { formatUptime } from './format';

const devices = [
  makeDevice({ id: 'A', name: 'Keller-Licht', tags: ['Keller'] }),
  makeDevice({ id: 'B', name: 'Garage', ip: '192.168.1.57', online: false }),
  makeDevice({ id: 'C', name: 'Steckdose', authRequired: true }),
];

describe('filterDevices', () => {
  it('sucht in Name, IP und weiteren Feldern', () => {
    expect(filterDevices(devices, { text: 'garage', status: 'all', tag: '' }).map((d) => d.id)).toEqual(['B']);
    expect(filterDevices(devices, { text: '1.57', status: 'all', tag: '' }).map((d) => d.id)).toEqual(['B']);
  });
  it('filtert nach Status und Tag', () => {
    expect(filterDevices(devices, { text: '', status: 'offline', tag: '' }).map((d) => d.id)).toEqual(['B']);
    expect(filterDevices(devices, { text: '', status: 'auth', tag: '' }).map((d) => d.id)).toEqual(['C']);
    expect(filterDevices(devices, { text: '', status: 'all', tag: 'Keller' }).map((d) => d.id)).toEqual(['A']);
  });
});

describe('filterDevices (veraltet)', () => {
  it('zeigt mit dem Filter „veraltet“ nur veraltete Geräte', () => {
    const list = [makeDevice({ id: 'A', stale: true }), makeDevice({ id: 'B' })];
    expect(filterDevices(list, { text: '', status: 'stale', tag: '' }).map((d) => d.id)).toEqual(['A']);
  });
});

describe('formatUptime', () => {
  it('formatiert Tage, Stunden und Minuten', () => {
    expect(formatUptime(93_784)).toBe('1d 2h 3m');
    expect(formatUptime(120)).toBe('2m');
    expect(formatUptime(null)).toBe('—');
  });
});
