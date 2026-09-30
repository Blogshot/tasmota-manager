import type { StageRequest } from '@tm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { startBroker } from '../../test/fakes/broker';
import { FakeTasmota, type FakeTasmotaOptions } from '../../test/fakes/fakeTasmota';
import { silentLogger, testDb, waitFor } from '../../test/helpers';
import { pendingChanges } from '../db/schema';
import { TransportError } from '../transport/errors';
import { identifyHost } from '../discovery/identify';
import { MqttDiscovery } from '../discovery/mqttDiscovery';
import { DeviceGateway } from '../gateway';
import { DeviceRegistry } from '../registry';
import { HttpTransport } from '../transport/http';
import { MqttTransport } from '../transport/mqtt';
import { DeviceOps } from './deviceOps';
import { INTERRUPTED, JobRepo } from './jobs';
import { ApplyRunner, NothingToApplyError, RunnerBusyError } from './runner';
import { PendingStore } from './store';

const MAC = 'AABBCC112233';
const http = new HttpTransport(500);

interface Ctx {
  db: ReturnType<typeof testDb>;
  fake: FakeTasmota;
  registry: DeviceRegistry;
  store: PendingStore;
  jobs: JobRepo;
  runner: ApplyRunner;
  cleanup: () => Promise<void>;
}

let ctx: Ctx | null = null;

afterEach(async () => {
  await ctx?.runner.waitIdle();
  await ctx?.cleanup();
  ctx = null;
});

async function httpSetup(fakeOpts: Partial<FakeTasmotaOptions> = {}, restartTimeoutMs = 3000, concurrency = 5): Promise<Ctx> {
  const db = testDb();
  const registry = new DeviceRegistry(db);
  const fake = await new FakeTasmota({ mac: MAC, restartDelayMs: 20, downtimeMs: 150, ...fakeOpts }).start();
  await identifyHost(http, registry, fake.host, null);
  const gateway = new DeviceGateway({ registry, http, mqtt: null, globalPassword: () => null });
  const ops = new DeviceOps(gateway, { restartTimeoutMs, pollIntervalMs: 30, commandTimeoutMs: 300 });
  const store = new PendingStore(db, registry);
  const jobs = new JobRepo(db);
  const runner = new ApplyRunner({ store, jobs, registry, ops, concurrency: () => concurrency, log: silentLogger });
  ctx = { db, fake, registry, store, jobs, runner, cleanup: () => fake.stop() };
  return ctx;
}

async function run(c: Ctx, req: Omit<StageRequest, 'deviceIds'>) {
  c.store.stage({ deviceIds: [MAC], ...req } as StageRequest);
  c.runner.start();
  await c.runner.waitIdle();
  return c.jobs.latest()?.items[0];
}

describe('ApplyRunner über HTTP', () => {
  it('schreibt Einstellungen ohne Neustart, prüft sie und leert den Puffer', async () => {
    const c = await httpSetup();
    const item = await run(c, { settings: { PowerOnState: '1', LedState: '0', Rule1: 'ON x DO y ENDON', Rule1Enabled: '1' }, source: 'form' });
    expect(item).toMatchObject({ status: 'success', error: null, step: null });
    expect(c.fake.values.PowerOnState).toBe('1');
    expect(c.fake.values.LedState).toBe('0');
    expect(c.fake.rules[0]).toEqual({ state: true, text: 'ON x DO y ENDON' });
    expect(c.fake.restarts).toBe(0);
    expect(c.store.count()).toBe(0);
  });

  it('bündelt Einstellungen mit Neustart in einem Backlog und startet genau einmal neu', async () => {
    const c = await httpSetup();
    const item = await run(c, { settings: { MqttHost: 'neu.local', MqttUser: 'u1', MqttPassword: 'pw', TelePeriod: '60' }, source: 'form' });
    expect(item?.status).toBe('success');
    expect(c.fake.values.MqttHost).toBe('neu.local');
    expect(c.fake.values.TelePeriod).toBe('60');
    expect(c.fake.restarts).toBe(1);
    expect(c.fake.received.filter((cmd) => cmd.startsWith('Backlog'))).toEqual(['Backlog MqttHost neu.local; MqttUser u1; MqttPassword pw']);
    expect(c.store.count()).toBe(0);
  });

  it('wartet nach Neustart-Befehlen unter den freien Befehlen', async () => {
    const c = await httpSetup();
    const item = await run(c, { commands: ['Restart 1', 'FriendlyName1 Danach'], source: 'command' });
    expect(item?.status).toBe('success');
    expect(c.fake.restarts).toBe(1);
    expect(c.fake.values.FriendlyName1).toBe('Danach');
  });

  it('markiert abgelehnte Befehle und macht mit den übrigen weiter', async () => {
    const c = await httpSetup();
    c.store.stage({ deviceIds: [MAC], commands: ['Foo'], source: 'command' });
    const item = await run(c, { settings: { LedState: '2' }, source: 'form' });
    expect(item?.status).toBe('failed');
    expect(c.fake.values.LedState).toBe('2');
    const remaining = c.store.forDevice(MAC);
    expect(remaining.map((r) => r.value)).toEqual(['Foo']);
    expect(remaining[0]?.error).toMatch(/^rejected/);
  });

  it('lässt Einträge stehen, wenn das Gerät nach dem Neustart nicht zurückkommt', async () => {
    const c = await httpSetup({ downtimeMs: 60_000 }, 400);
    const item = await run(c, { settings: { TelePeriod: '60', MqttHost: 'weg.local' }, source: 'form' });
    expect(item?.status).toBe('failed');
    const remaining = c.store.forDevice(MAC);
    expect(remaining.map((r) => r.key)).toEqual(['MqttHost']);
    expect(remaining[0]?.error).toMatch(/^offline/);
  });

  it('meldet Abweichungen beim Prüfen', async () => {
    const c = await httpSetup({ ignore: ['LedState'] });
    const item = await run(c, { settings: { LedState: '5' }, source: 'form' });
    expect(item?.status).toBe('failed');
    expect(c.store.forDevice(MAC)[0]?.error).toBe('verify_mismatch: Soll „5“, Ist „1“');
  });

  it('meldet keine Abweichung, wenn das Gerät Zeitzone und Timer-Versatz in seinem eigenen Format zurückgibt', async () => {
    const c = await httpSetup();
    const sunrise = { Enable: 1, Mode: 1, Time: '+00:30', Window: 0, Days: '1111111', Repeat: 1, Output: 1, Action: 1 };
    const clock = { ...sunrise, Mode: 0, Time: '+06:30' };
    const item = await run(c, { settings: { Timezone: '1', Timer1: JSON.stringify(sunrise), Timer2: JSON.stringify(clock) }, source: 'form' });
    expect(item).toMatchObject({ status: 'success', error: null });
    expect(c.fake.values.Timezone).toBe('+01:00');
    expect(c.fake.timers[0]).toMatchObject({ Mode: 1, Time: '00:30' });
    expect(c.fake.timers[1]).toMatchObject({ Mode: 0, Time: '06:30' });
    expect(c.store.count()).toBe(0);
  });

  it('meldet eine echte Abweichung der Zeitzone weiterhin', async () => {
    const c = await httpSetup({ ignore: ['Timezone'] });
    const item = await run(c, { settings: { Timezone: '-5' }, source: 'form' });
    expect(item?.status).toBe('failed');
    expect(c.store.forDevice(MAC)[0]?.error).toBe('verify_mismatch: Soll „-5“, Ist „99“');
  });

  it('verhindert parallele Läufe und leere Starts', async () => {
    const c = await httpSetup();
    expect(() => c.runner.start()).toThrow(NothingToApplyError);
    c.store.stage({ deviceIds: [MAC], settings: { LedState: '2' }, source: 'form' });
    c.runner.start();
    expect(c.runner.running).toBe(true);
    expect(() => c.runner.start()).toThrow(RunnerBusyError);
    await c.runner.waitIdle();
    expect(c.runner.running).toBe(false);
  });

  it('meldet Fortschritt pro Gerät', async () => {
    const c = await httpSetup();
    const steps: string[] = [];
    c.runner.on('progress', (_jobId, item) => steps.push(`${item.status}:${item.step ?? '-'}`));
    const done: number[] = [];
    c.runner.on('done', (job) => done.push(job.id));
    await run(c, { settings: { LedState: '2' }, source: 'form' });
    expect(steps[0]).toBe('running:write');
    expect(steps).toContain('running:verify');
    expect(steps.at(-1)).toBe('success:-');
    expect(done).toHaveLength(1);
  });

  it('übersteht einen werfenden progress-Listener', async () => {
    const c = await httpSetup();
    c.runner.on('progress', () => {
      throw new Error('boom');
    });
    c.store.stage({ deviceIds: [MAC], settings: { LedState: '2' }, source: 'form' });
    c.runner.start();
    await c.runner.waitIdle();
    const job = c.jobs.latest();
    expect(job?.status).toBe('done');
    expect(['pending', 'running']).not.toContain(job?.items[0]?.status);
    expect(c.runner.running).toBe(false);
    expect(c.fake.values.LedState).toBe('2');
  });

  it('löscht zwischenzeitlich neu vorgemerkte Werte nicht', async () => {
    const c = await httpSetup();
    c.store.stage({ deviceIds: [MAC], settings: { LedState: '2' }, source: 'form' });
    c.runner.on('progress', (_jobId, item) => {
      if (item.step === 'verify') c.store.stage({ deviceIds: [MAC], settings: { LedState: '5' }, source: 'form' });
    });
    c.runner.start();
    await c.runner.waitIdle();
    expect(c.fake.values.LedState).toBe('2');
    expect(c.store.forDevice(MAC).map((r) => r.value)).toEqual(['5']);
  });

  it('dedupliziert Geräte-IDs beim Start', async () => {
    const c = await httpSetup();
    c.store.stage({ deviceIds: [MAC], settings: { LedState: '2' }, source: 'form' });
    expect(c.runner.start([MAC, MAC]).items).toHaveLength(1);
  });

  it('wendet bei Concurrency 0 trotzdem an', async () => {
    const c = await httpSetup({}, 3000, 0);
    const item = await run(c, { settings: { LedState: '2' }, source: 'form' });
    expect(item?.status).toBe('success');
    expect(c.fake.values.LedState).toBe('2');
  });

  it('markiert nicht planbare Einträge als Fehler', async () => {
    const c = await httpSetup();
    const now = new Date().toISOString();
    c.db.insert(pendingChanges).values({ deviceId: MAC, kind: 'setting', key: 'Bogus', value: '1', source: 'form', createdAt: now, updatedAt: now }).run();
    const item = await run(c, { settings: { LedState: '2' }, source: 'form' });
    expect(item?.status).toBe('failed');
    expect(c.fake.values.LedState).toBe('2');
    const remaining = c.store.forDevice(MAC);
    expect(remaining.map((r) => r.key)).toEqual(['Bogus']);
    expect(remaining[0]?.error).toBe('Unbekannte Einstellung Bogus');
  });

  it('bricht das Gerät ab, wenn uptime vor einem Neustart-Befehl fehlschlägt (auch mit rejected)', async () => {
    const c = await httpSetup();
    const sent: string[] = [];
    const stub = {
      uptime: async () => {
        throw new TransportError('rejected', 'Status 11 enthält keine UptimeSec');
      },
      send: async (_id: string, command: string) => {
        sent.push(command);
        return { response: {} };
      },
      query: async () => ({}),
      waitForRestart: async () => undefined,
    };
    const runner = new ApplyRunner({ store: c.store, jobs: c.jobs, registry: c.registry, ops: stub as never, concurrency: () => 1, log: silentLogger });
    c.store.stage({ deviceIds: [MAC], commands: ['Restart 1', 'FriendlyName1 Danach'], source: 'command' });
    runner.start();
    await runner.waitIdle();
    expect(sent).toEqual([]);
    expect(c.jobs.latest()?.items[0]?.status).toBe('failed');
    const remaining = c.store.forDevice(MAC);
    expect(remaining).toHaveLength(2);
    expect(remaining.every((r) => r.error?.startsWith('rejected'))).toBe(true);
  });

  it('übernimmt beim App-Start unterbrochene Läufe als Fehler', async () => {
    const c = await httpSetup();
    c.store.stage({ deviceIds: [MAC], settings: { LedState: '2' }, source: 'form' });
    const ids = c.store.forDevice(MAC).map((r) => r.id);
    const job = c.jobs.create([{ deviceId: MAC, deviceName: 'Tasmota', changeIds: ids }]);
    c.jobs.updateItem(job.id, MAC, { status: 'running' });
    c.store.fail(c.jobs.recoverInterrupted(), INTERRUPTED);
    expect(c.store.forDevice(MAC)[0]?.error).toBe(INTERRUPTED);
    expect(c.jobs.get(job.id)?.status).toBe('done');
  });
});

async function mqttSetup(fakeOpts: Partial<FakeTasmotaOptions> = {}): Promise<Ctx> {
  const broker = await startBroker();
  const db = testDb();
  const registry = new DeviceRegistry(db);
  const mqtt = new MqttTransport({ url: broker.url, timeoutMs: 500 });
  new MqttDiscovery(mqtt, registry, silentLogger).start();
  mqtt.start();
  await waitFor(() => mqtt.status === 'connected');
  const fake = new FakeTasmota({ mac: MAC, topic: 'keller', advertiseIp: false, restartDelayMs: 20, downtimeMs: 200, ...fakeOpts });
  await fake.connectMqtt(broker.url);
  await waitFor(() => registry.get(MAC)?.channels.includes('mqtt') && registry.get(MAC)?.chip);

  const gateway = new DeviceGateway({ registry, http, mqtt, globalPassword: () => null });
  const ops = new DeviceOps(gateway, { restartTimeoutMs: 5000, pollIntervalMs: 50, commandTimeoutMs: 500 });
  const store = new PendingStore(db, registry);
  const jobs = new JobRepo(db);
  const runner = new ApplyRunner({ store, jobs, registry, ops, concurrency: () => 5, log: silentLogger });
  ctx = {
    db,
    fake,
    registry,
    store,
    jobs,
    runner,
    cleanup: async () => {
      await mqtt.stop();
      await fake.stop();
      await broker.close();
    },
  };
  return ctx;
}

describe('ApplyRunner über MQTT', () => {
  it('schreibt über MQTT, wartet den Neustart ab und kommt nach dem Reconnect weiter', async () => {
    const { store, runner, jobs, fake } = await mqttSetup();
    store.stage({ deviceIds: [MAC], settings: { LedState: '2', MqttUser: 'neu' }, source: 'form' });
    runner.start();
    await runner.waitIdle();
    expect(jobs.latest()?.items[0]?.status).toBe('success');
    expect(fake.values.LedState).toBe('2');
    expect(fake.values.MqttUser).toBe('neu');
    expect(fake.restarts).toBe(1);
    expect(store.count()).toBe(0);
  });

  it('prüft Neustart-Einstellungen auch ohne HTTP-Adresse', async () => {
    const { store, runner, jobs } = await mqttSetup({ ignore: ['MqttUser'] });
    // MqttHost löst im Fake den Neustart aus (ignorierte Schlüssel starten nicht neu).
    store.stage({ deviceIds: [MAC], settings: { MqttHost: 'neu.local', MqttUser: 'neu' }, source: 'form' });
    runner.start();
    await runner.waitIdle();
    expect(jobs.latest()?.items[0]?.status).toBe('failed');
    const remaining = store.forDevice(MAC);
    expect(remaining.map((r) => r.key)).toEqual(['MqttUser']);
    expect(remaining[0]?.error).toMatch(/^verify_mismatch/);
  });
});
