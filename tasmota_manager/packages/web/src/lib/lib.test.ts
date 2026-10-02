import { QueryClient } from '@tanstack/react-query';
import type { Device, JobView, StatusResponse } from '@tm/shared';
import { describe, expect, it } from 'vitest';
import { makeDevice } from '@/test/fixtures';
import { SUGGESTIONS } from '@/test/fixtures';
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
    qc.setQueryData<StatusResponse>(['status'], { mqtt: 'connected', version: 'x', scanning: false, haLocation: null, haSuggestions: SUGGESTIONS });
    applyMessage(qc, { type: 'mqtt:status', status: 'disconnected' });
    applyMessage(qc, { type: 'scan:progress', scanned: 16, total: 254, found: 1 });
    expect(qc.getQueryData(['status'])).toEqual({ mqtt: 'disconnected', version: 'x', scanning: true, haLocation: null, haSuggestions: SUGGESTIONS });
    expect(qc.getQueryData(['scan'])).toMatchObject({ scanned: 16, total: 254 });
    applyMessage(qc, { type: 'scan:done', found: 1 });
    expect(qc.getQueryData<StatusResponse>(['status'])?.scanning).toBe(false);
    expect(qc.getQueryData(['scan'])).toBeNull();
  });
  it('invalidiert Puffer und Geräte bei Pufferänderungen', () => {
    const qc = new QueryClient();
    qc.setQueryData(['changes'], []);
    qc.setQueryData<Device[]>(['devices'], []);
    applyMessage(qc, { type: 'changes:updated', count: 3 });
    expect(qc.getQueryState(['changes'])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['devices'])?.isInvalidated).toBe(true);
  });

  it('aktualisiert den Fortschritt des laufenden Jobs', () => {
    const qc = new QueryClient();
    const job: JobView = {
      id: 7,
      status: 'running',
      createdAt: 'x',
      finishedAt: null,
      items: [{ deviceId: 'A', deviceName: 'A', status: 'pending', step: null, error: null }],
    };
    qc.setQueryData(['job'], { job });
    applyMessage(qc, { type: 'job:progress', jobId: 7, item: { deviceId: 'A', deviceName: 'A', status: 'running', step: 'restart', error: null } });
    expect(qc.getQueryData<{ job: JobView }>(['job'])?.job.items[0]).toMatchObject({ status: 'running', step: 'restart' });
    applyMessage(qc, { type: 'job:done', job: { ...job, status: 'done' } });
    expect(qc.getQueryData<{ job: JobView }>(['job'])?.job.status).toBe('done');
  });

  it('aktualisiert bei Telemetrie die Übersicht und invalidiert nur die Live-Abfrage', () => {
    const qc = new QueryClient();
    qc.setQueryData(['telemetry', 'A', 'live'], { updatedAt: null, values: [], history: {} });
    qc.setQueryData(['telemetry', 'A', 'poll'], { updatedAt: null, values: [], history: {} });
    const headline = [{ key: 'ENERGY.Power', group: 'ENERGY', name: 'Power', value: 5, unit: 'W' }];
    applyMessage(qc, { type: 'telemetry', deviceId: 'A', updatedAt: 'x', headline });
    expect(qc.getQueryData(['telemetry-summary'])).toEqual({ A: headline });
    expect(qc.getQueryState(['telemetry', 'A', 'live'])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['telemetry', 'A', 'poll'])?.isInvalidated).toBe(false);
  });
});

describe('readHaContext', () => {
  it('liefert ein leeres Objekt außerhalb von Home Assistant', () => {
    expect(readHaContext()).toEqual({});
  });
});
