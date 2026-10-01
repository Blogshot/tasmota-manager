import type { HaLocation, HaSuggestions } from '@tm/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app';
import { WsHub, wireLiveEvents } from '../src/api/hub';
import { DeviceOps } from '../src/changes/deviceOps';
import { JobRepo } from '../src/changes/jobs';
import { ApplyRunner } from '../src/changes/runner';
import { PendingStore } from '../src/changes/store';
import { HttpScanner } from '../src/discovery/scanner';
import { DeviceEnricher } from '../src/enrich';
import { DeviceGateway } from '../src/gateway';
import { DeviceRegistry } from '../src/registry';
import { SettingsStore, defaultSettings } from '../src/settings';
import { HttpTransport } from '../src/transport/http';
import { FakeTasmota, type FakeTasmotaOptions } from './fakes/fakeTasmota';
import { silentLogger, testDb } from './helpers';

export interface SetupOptions {
  allowedIps?: string[];
  webDir?: string;
  fakePassword?: string;
  fake?: Partial<FakeTasmotaOptions>;
  haLocation?: HaLocation;
  haSuggestions?: (registry: DeviceRegistry) => () => HaSuggestions;
}

const cleanups: Array<() => Promise<void>> = [];

export async function cleanupApps(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) await cleanup();
}

export async function setupApp(opts: SetupOptions = {}) {
  const db = testDb();
  const registry = new DeviceRegistry(db);
  const settings = new SettingsStore(db, defaultSettings(['192.168.1.0/24']));
  const http = new HttpTransport(2000);
  const gateway = new DeviceGateway({ registry, http, mqtt: null, globalPassword: () => settings.get().globalPassword });
  const fake = await new FakeTasmota({
    mac: 'AABBCC112233',
    name: 'Keller',
    password: opts.fakePassword,
    restartDelayMs: 20,
    downtimeMs: 150,
    ...opts.fake,
  }).start();
  const scanner = new HttpScanner(
    http,
    registry,
    (id) => gateway.passwordFor(id),
    () => settings.get().globalPassword || null,
    { port: fake.port, timeoutMs: 500 },
  );
  const store = new PendingStore(db, registry);
  const jobs = new JobRepo(db);
  const ops = new DeviceOps(gateway, { restartTimeoutMs: 3000, pollIntervalMs: 30, commandTimeoutMs: 500 });
  const runner = new ApplyRunner({ store, jobs, registry, ops, concurrency: () => 5, log: silentLogger });
  const enricher = new DeviceEnricher(registry, store, null);
  const hub = new WsHub();
  wireLiveEvents({ hub, registry, scanner, mqtt: null, store, runner, ha: null, enricher });
  const app: FastifyInstance = await buildApp({
    registry,
    gateway,
    scanner,
    settings,
    hub,
    store,
    runner,
    jobs,
    enricher,
    version: 'test',
    mqttStatus: () => 'disabled',
    haLocation: () => opts.haLocation ?? null,
    haSuggestions: opts.haSuggestions?.(registry),
    allowedIps: opts.allowedIps,
    webDir: opts.webDir,
  });
  cleanups.push(async () => {
    await runner.waitIdle();
    await app.close();
    await fake.stop();
  });
  return { app, registry, settings, hub, fake, store, runner, jobs };
}
