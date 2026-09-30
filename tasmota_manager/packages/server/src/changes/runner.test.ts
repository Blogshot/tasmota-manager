import type { StageRequest } from '@tm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { startBroker } from '../../test/fakes/broker';
import { FakeTasmota, type FakeTasmotaOptions } from '../../test/fakes/fakeTasmota';
import { silentLogger, testDb, waitFor } from '../../test/helpers';
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

async function httpSetup(fakeOpts: Partial<FakeTasmotaOptions> = {}, restartTimeoutMs = 3000): Promise<Ctx> {
  const db = testDb();
  const registry = new DeviceRegistry(db);
  const fake = await new FakeTasmota({ mac: MAC, restartDelayMs: 20, downtimeMs: 150, ...fakeOpts }).start();
  await identifyHost(http, registry, fake.host, null);
  const gateway = new DeviceGateway({ registry, http, mqtt: null, globalPassword: () => null });
  const ops = new DeviceOps(gateway, { restartTimeoutMs, pollIntervalMs: 30, commandTimeoutMs: 300 });
  const store = new PendingStore(db, registry);
  const jobs = new JobRepo(db);
  const runner = new ApplyRunner({ store, jobs, registry, ops, concurrency: () => 5, log: silentLogger });
  ctx = { fake, registry, store, jobs, runner, cleanup: () => fake.stop() };
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

describe('ApplyRunner über MQTT', () => {
  it('schreibt über MQTT, wartet den Neustart ab und kommt nach dem Reconnect weiter', async () => {
    const broker = await startBroker();
    const db = testDb();
    const registry = new DeviceRegistry(db);
    const mqtt = new MqttTransport({ url: broker.url, timeoutMs: 500 });
    new MqttDiscovery(mqtt, registry, silentLogger).start();
    mqtt.start();
    await waitFor(() => mqtt.status === 'connected');
    const fake = new FakeTasmota({ mac: MAC, topic: 'keller', advertiseIp: false, restartDelayMs: 20, downtimeMs: 200 });
    await fake.connectMqtt(broker.url);
    await waitFor(() => registry.get(MAC)?.channels.includes('mqtt') && registry.get(MAC)?.chip);

    const gateway = new DeviceGateway({ registry, http, mqtt, globalPassword: () => null });
    const ops = new DeviceOps(gateway, { restartTimeoutMs: 5000, pollIntervalMs: 50, commandTimeoutMs: 500 });
    const store = new PendingStore(db, registry);
    const jobs = new JobRepo(db);
    const runner = new ApplyRunner({ store, jobs, registry, ops, concurrency: () => 5, log: silentLogger });
    ctx = {
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

    store.stage({ deviceIds: [MAC], settings: { LedState: '2', MqttUser: 'neu' }, source: 'form' });
    runner.start();
    await runner.waitIdle();
    expect(jobs.latest()?.items[0]?.status).toBe('success');
    expect(fake.values.LedState).toBe('2');
    expect(fake.values.MqttUser).toBe('neu');
    expect(fake.restarts).toBe(1);
    expect(store.count()).toBe(0);
  });
});
