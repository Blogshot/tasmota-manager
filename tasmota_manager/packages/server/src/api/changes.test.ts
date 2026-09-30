import type { Device, JobView, PendingDevice, WsMessage } from '@tm/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupApps, setupApp } from '../../test/appSetup';
import { waitFor } from '../../test/helpers';

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
    expect(res.json()).toEqual({ staged: 2, skipped: 0 });
    const list = (await app.inject('/api/changes')).json<PendingDevice[]>();
    expect(list[0]?.changes.map((c) => [c.key, c.before, c.value])).toEqual([
      ['PowerOnState', '3', '1'],
      ['MqttPassword', null, '••••'],
    ]);
    expect(JSON.stringify(list)).not.toContain('geheim');
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
    expect(device).toMatchObject({ nameSuggestion: 'Klima', pendingCount: 0, pendingName: null, setOption4: false, ha: null });
    const res = await app.inject({ method: 'POST', url: '/api/changes/suggestions', payload: { deviceIds: [MAC] } });
    expect(res.json()).toEqual({ staged: 2, skipped: 0 });
    device = (await app.inject(`/api/devices/${MAC}`)).json<Device>();
    expect(device).toMatchObject({ nameSuggestion: null, pendingCount: 2, pendingName: 'Klima' });
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
});
