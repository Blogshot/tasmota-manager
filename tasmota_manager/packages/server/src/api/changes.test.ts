import type { Device, JobView, PendingDevice, WsMessage } from '@tm/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupApps, setupApp } from '../../test/appSetup';
import { waitFor } from '../../test/helpers';
import { DeviceGateway } from '../gateway';

afterEach(cleanupApps);

const MAC = 'AABBCC112233';

async function addFake(app: FastifyInstance): Promise<Device> {
  const res = await app.inject({ method: 'POST', url: '/api/devices', payload: { ip: '127.0.0.1' } });
  expect(res.statusCode).toBe(201);
  return res.json<Device>();
}

const stage = (app: FastifyInstance, payload: object) => app.inject({ method: 'POST', url: '/api/changes', payload });

describe('Änderungs-API', () => {
  it('merkt vor, listet mit Vorher/Nachher und maskiert Passwörter', async () => {
    const { app } = await setupApp();
    await addFake(app);
    const res = await stage(app, { deviceIds: [MAC], settings: { PowerOnState: '1', MqttPassword: 'geheim' }, source: 'form' });
    expect(res.json()).toEqual({ staged: 2, skipped: 0, incompatible: 0 });
    const list = (await app.inject('/api/changes')).json<PendingDevice[]>();
    expect(list[0]?.changes.map((c) => [c.key, c.before, c.value])).toEqual([
      ['PowerOnState', '3', '1'],
      ['MqttPassword', null, '••••'],
    ]);
    expect(JSON.stringify(list)).not.toContain('geheim');
  });

  it('gibt Passwörter aus freien Befehlen nicht aus, sendet sie aber unverändert ans Gerät', async () => {
    const { app, fake, runner } = await setupApp();
    await addFake(app);
    await stage(app, { deviceIds: [MAC], commands: ['Backlog MqttUser neu; MqttPassword geheim'], source: 'command' });
    const res = await app.inject('/api/changes');
    expect(res.json<PendingDevice[]>()[0]?.changes.map((c) => c.value)).toEqual(['Backlog MqttUser neu; MqttPassword ••••']);
    expect(res.body).not.toContain('geheim');
    await app.inject({ method: 'POST', url: '/api/changes/apply', payload: {} });
    await runner.waitIdle();
    expect(fake.received).toContain('Backlog MqttUser neu; MqttPassword geheim');
    expect(fake.values.MqttPassword).toBe('geheim');
  });

  it('lehnt ungültige Werte und Backlog-Injektion mit 400 ab', async () => {
    const { app } = await setupApp();
    await addFake(app);
    expect((await stage(app, { deviceIds: [MAC], settings: { Unbekannt: '1' }, source: 'form' })).statusCode).toBe(400);
    const injected = await stage(app, { deviceIds: [MAC], settings: { MqttHost: 'broker;Reset 1' }, source: 'form' });
    expect(injected.statusCode).toBe(400);
    expect(injected.json()).toMatchObject({ code: 'validation' });
    expect((await stage(app, { deviceIds: [MAC], source: 'form' })).statusCode).toBe(400);
  });

  it('zeigt Pufferstatus und Namensvorschläge an den Geräten und übernimmt Vorschläge', async () => {
    const { app } = await setupApp({ fake: { name: 'Tasmota', sensors: { AM2301: { Temperature: 21, Humidity: 40 } } } });
    await addFake(app);
    let device = (await app.inject('/api/devices')).json<Device[]>()[0];
    expect(device).toMatchObject({ nameSuggestion: 'Climate', pendingCount: 0, pendingName: null, setOption4: false, ha: null });
    const res = await app.inject({ method: 'POST', url: '/api/changes/suggestions', payload: { deviceIds: [MAC] } });
    expect(res.json()).toEqual({ staged: 2, skipped: 0, incompatible: 0 });
    device = (await app.inject(`/api/devices/${MAC}`)).json<Device>();
    expect(device).toMatchObject({ nameSuggestion: null, pendingCount: 2, pendingName: 'Climate' });
  });

  it('liest den aktuellen Wert einer Einstellung live vom Gerät', async () => {
    const { app } = await setupApp();
    await addFake(app);
    const read = (key: string) => app.inject(`/api/devices/${MAC}/settings/${key}`);
    expect((await read('TelePeriod')).json()).toEqual({ value: '300' });
    expect((await read('Timezone')).json()).toEqual({ value: '99' });
    expect((await read('Rule1')).json()).toMatchObject({ value: expect.any(String) });
    // Passwörter sind nicht lesbar, unbekannte Schlüssel gibt es nicht.
    expect((await read('MqttPassword')).statusCode).toBe(400);
    expect((await read('Bogus')).statusCode).toBe(404);
    expect((await app.inject('/api/devices/GIBTSNICHT/settings/TelePeriod')).statusCode).toBe(404);
  });

  it('übergeht abgelehnte Namensvorschläge, auch beim Übernehmen per Batch', async () => {
    const { app } = await setupApp({ fake: { name: 'Tasmota', sensors: { AM2301: { Temperature: 21, Humidity: 40 } } } });
    await addFake(app);
    const dismissed = await app.inject({ method: 'PATCH', url: `/api/devices/${MAC}`, payload: { suggestionDismissed: true } });
    expect(dismissed.json()).toMatchObject({ nameSuggestion: null, suggestionDismissed: true });
    const res = await app.inject({ method: 'POST', url: '/api/changes/suggestions', payload: { deviceIds: [MAC] } });
    expect(res.json()).toEqual({ staged: 0, skipped: 0, incompatible: 0 });
    const restored = await app.inject({ method: 'PATCH', url: `/api/devices/${MAC}`, payload: { suggestionDismissed: false } });
    expect(restored.json()).toMatchObject({ nameSuggestion: 'Climate', suggestionDismissed: false });
  });

  it('meldet übersprungene Geräte und lehnt Kalibrierwerte für mehrere Geräte ab', async () => {
    const { app } = await setupApp();
    await addFake(app);
    const res = await stage(app, { deviceIds: [MAC], settings: { PowerDelta: '110' }, source: 'form' });
    expect(res.json()).toEqual({ staged: 0, skipped: 0, incompatible: 1 });
  });

  it('startet den Batch, liefert den Job und leert den Puffer', async () => {
    const { app, fake, runner } = await setupApp();
    await addFake(app);
    await stage(app, { deviceIds: [MAC], settings: { LedState: '0', MqttHost: 'neu.local' }, source: 'form' });
    const started = await app.inject({ method: 'POST', url: '/api/changes/apply', payload: {} });
    expect(started.statusCode).toBe(202);
    expect(started.json<JobView>().items[0]).toMatchObject({ deviceId: MAC, status: 'pending' });
    expect((await app.inject({ method: 'POST', url: '/api/changes/apply', payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: '/api/changes' })).statusCode).toBe(409);
    await runner.waitIdle();
    const job = (await app.inject('/api/jobs/current')).json<{ job: JobView }>().job;
    expect(job).toMatchObject({ status: 'done', items: [{ status: 'success' }] });
    expect(fake.values.LedState).toBe('0');
    expect(fake.values.MqttHost).toBe('neu.local');
    expect(fake.restarts).toBe(1);
    expect((await app.inject('/api/changes')).json()).toEqual([]);
    expect((await app.inject({ method: 'POST', url: '/api/changes/apply', payload: {} })).statusCode).toBe(422);
  });

  it('verwirft einzelne Einträge, Geräte und alles', async () => {
    const { app } = await setupApp();
    await addFake(app);
    await stage(app, { deviceIds: [MAC], settings: { LedState: '0', TelePeriod: '60' }, source: 'form' });
    const id = (await app.inject('/api/changes')).json<PendingDevice[]>()[0]?.changes[0]?.id;
    expect((await app.inject({ method: 'DELETE', url: `/api/changes/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/changes/${id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/changes?deviceId=${MAC}` })).statusCode).toBe(204);
    expect((await app.inject('/api/changes')).json()).toEqual([]);
  });

  it('liest Rules und Timer live vom Gerät', async () => {
    const { app, fake } = await setupApp();
    await addFake(app);
    fake.execute('Rule2 ON x DO y ENDON');
    fake.execute('Timer1 {"Enable":1,"Time":"06:30","Days":"1111111"}');
    const rules = (await app.inject(`/api/devices/${MAC}/rules`)).json();
    expect(rules[1]).toEqual({ index: 2, enabled: false, text: 'ON x DO y ENDON', length: 15, free: 496 });
    const timers = (await app.inject(`/api/devices/${MAC}/timers`)).json();
    expect(timers.enabled).toBe(true);
    expect(timers.timers).toHaveLength(16);
    expect(timers.timers[0]).toMatchObject({ Enable: 1, Time: '06:30', Days: '1111111' });
    expect((await app.inject('/api/devices/GIBTSNICHT/rules')).statusCode).toBe(404);
  });

  it('meldet Pufferänderungen per WebSocket', async () => {
    const { app, hub } = await setupApp();
    await addFake(app);
    await app.ready();
    const ws = await app.injectWS('/api/ws');
    await waitFor(() => hub.size === 1);
    const messages: WsMessage[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await stage(app, { deviceIds: [MAC], settings: { LedState: '0' }, source: 'form' });
    await waitFor(() => messages.some((m) => m.type === 'changes:updated'));
    expect(messages.find((m) => m.type === 'changes:updated')).toEqual({ type: 'changes:updated', count: 1 });
    ws.terminate();
  });

  it('schlägt eine Sofort-Regel vor und merkt sie im freien Slot vor', async () => {
    const { app, store } = await setupApp({ fake: { sensors: { AM2301: { Temperature: 21, Humidity: 40 } } } });
    await addFake(app);
    const preview = await app.inject({ method: 'POST', url: '/api/fast-rule/preview', payload: { deviceIds: [MAC] } });
    expect(preview.json()).toEqual([
      expect.objectContaining({ rule: 'ON AM2301#Temperature DO TelePeriod 1 ENDON', slot: 1, reason: 'ok' }),
    ]);
    const staged = await app.inject({ method: 'POST', url: '/api/fast-rule/stage', payload: { deviceIds: [MAC] } });
    expect(staged.json()).toMatchObject({ staged: 3 });
    expect(store.forDevice(MAC).map((r) => r.key).sort()).toEqual(['Rule1', 'Rule1Enabled', 'TelePeriod']);
  });

  it('überschreibt keine belegten Rule-Slots', async () => {
    const { app, fake } = await setupApp({ fake: { sensors: { AM2301: { Temperature: 21 } } } });
    await addFake(app);
    for (const n of [1, 2, 3]) fake.execute(`Rule${n} ON System#Boot DO Power 1 ENDON`);
    const preview = await app.inject({ method: 'POST', url: '/api/fast-rule/preview', payload: { deviceIds: [MAC] } });
    expect(preview.json()).toEqual([expect.objectContaining({ slot: null, reason: 'noSlot' })]);
  });

  it('meldet nicht erreichbare Geräte, ohne die anderen abzubrechen', async () => {
    const { app, fake } = await setupApp({ fake: { sensors: { AM2301: { Temperature: 21 } } } });
    await addFake(app);
    await fake.stop();
    const preview = await app.inject({ method: 'POST', url: '/api/fast-rule/preview', payload: { deviceIds: [MAC, 'GIBTSNICHT'] } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual([expect.objectContaining({ deviceId: MAC, slot: null, reason: 'unreachable' })]);
  });

  it('überspringt Rule-Slots, die bereits im Änderungspuffer vorgemerkt sind', async () => {
    const { app, store } = await setupApp({ fake: { sensors: { AM2301: { Temperature: 21 } } } });
    await addFake(app);
    store.stage({ deviceIds: [MAC], settings: { Rule1: 'ON System#Boot DO Power 1 ENDON' }, source: 'form' });
    const second = await app.inject({ method: 'POST', url: '/api/fast-rule/preview', payload: { deviceIds: [MAC] } });
    expect(second.json()).toEqual([expect.objectContaining({ slot: 2, reason: 'ok' })]);
    store.stage({ deviceIds: [MAC], settings: { Rule2: 'ON System#Boot DO Power 1 ENDON', Rule3: 'ON System#Boot DO Power 1 ENDON' }, source: 'form' });
    const full = await app.inject({ method: 'POST', url: '/api/fast-rule/preview', payload: { deviceIds: [MAC] } });
    expect(full.json()).toEqual([expect.objectContaining({ slot: null, reason: 'noSlot' })]);
    expect(store.forDevice(MAC).find((r) => r.key === 'Rule1')?.value).toBe('ON System#Boot DO Power 1 ENDON');
  });

  it('meldet einen Lesefehler pro Gerät als unreachable statt alle abzubrechen', async () => {
    const { app } = await setupApp({ fake: { sensors: { AM2301: { Temperature: 21 } } } });
    await addFake(app);
    const spy = vi.spyOn(DeviceGateway.prototype, 'send').mockImplementation(() => {
      throw new Error('boom');
    });
    const preview = await app.inject({ method: 'POST', url: '/api/fast-rule/preview', payload: { deviceIds: [MAC] } });
    spy.mockRestore();
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual([expect.objectContaining({ slot: null, reason: 'unreachable' })]);
  });
});
