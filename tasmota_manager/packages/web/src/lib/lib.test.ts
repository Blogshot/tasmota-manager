import { QueryClient } from '@tanstack/react-query';
import type { Device, StatusResponse } from '@tm/shared';
import { describe, expect, it } from 'vitest';
import { makeDevice } from '@/test/fixtures';
import { formatMessage } from './i18n';
import { de, en } from './messages';
import { applyMessage } from './live';
import { readHaContext } from './ha';

describe('formatMessage', () => {
  it('ersetzt Platzhalter', () => {
    expect(formatMessage('{count} ausgewählt', { count: 3 })).toBe('3 ausgewählt');
    expect(formatMessage('ohne {x}')).toBe('ohne {x}');
  });
  it('hat für jede deutsche Meldung eine englische', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort());
  });
});

describe('applyMessage', () => {
  it('aktualisiert, ergänzt und entfernt Geräte im Cache', () => {
    const qc = new QueryClient();
    qc.setQueryData<Device[]>(['devices'], [makeDevice({ id: 'A', name: 'Alt' })]);
    applyMessage(qc, { type: 'device:updated', device: makeDevice({ id: 'A', name: 'Neu' }) });
    applyMessage(qc, { type: 'device:updated', device: makeDevice({ id: 'B' }) });
    expect(qc.getQueryData<Device[]>(['devices'])?.map((d) => d.name)).toEqual(['Neu', 'Keller-Licht']);
    applyMessage(qc, { type: 'device:removed', id: 'A' });
    expect(qc.getQueryData<Device[]>(['devices'])?.map((d) => d.id)).toEqual(['B']);
  });

  it('pflegt MQTT- und Scan-Status', () => {
    const qc = new QueryClient();
    qc.setQueryData<StatusResponse>(['status'], { mqtt: 'connected', version: 'x', scanning: false });
    applyMessage(qc, { type: 'mqtt:status', status: 'disconnected' });
    applyMessage(qc, { type: 'scan:progress', scanned: 16, total: 254, found: 1 });
    expect(qc.getQueryData(['status'])).toEqual({ mqtt: 'disconnected', version: 'x', scanning: true });
    expect(qc.getQueryData(['scan'])).toMatchObject({ scanned: 16, total: 254 });
    applyMessage(qc, { type: 'scan:done', found: 1 });
    expect(qc.getQueryData<StatusResponse>(['status'])?.scanning).toBe(false);
    expect(qc.getQueryData(['scan'])).toBeNull();
  });
});

describe('readHaContext', () => {
  it('liefert ein leeres Objekt außerhalb von Home Assistant', () => {
    expect(readHaContext()).toEqual({});
  });
});
