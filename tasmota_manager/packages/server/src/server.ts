import { resolveLanguage } from '@tm/shared';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './api/app';
import { WsHub, wireLiveEvents } from './api/hub';
import { type AppConfig, detectHostCidrs } from './config';
import { DeviceOps } from './changes/deviceOps';
import { INTERRUPTED, JobRepo } from './changes/jobs';
import { ApplyRunner } from './changes/runner';
import { PendingStore } from './changes/store';
import { openDb } from './db';
import { MqttDiscovery } from './discovery/mqttDiscovery';
import { HttpPoller } from './discovery/poller';
import { HttpScanner } from './discovery/scanner';
import { DeviceEnricher } from './enrich';
import { DeviceGateway } from './gateway';
import { HaClient } from './ha/client';
import { createLogger } from './logger';
import { DeviceRegistry } from './registry';
import { SettingsStore, defaultSettings } from './settings';
import { HttpTransport } from './transport/http';
import { MqttTransport } from './transport/mqtt';

// Beide Pfade funktionieren aus src/ (tsx) und aus dist/ (Bundle), weil beide eine Ebene unter packages/server liegen.
const DEFAULT_MIGRATIONS_DIR = process.env.TM_MIGRATIONS_DIR ?? fileURLToPath(new URL('../drizzle', import.meta.url));
const DEFAULT_WEB_DIR = process.env.TM_WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface StartOverrides {
  migrationsDir?: string;
  webDir?: string | null;
  scanCidrs?: string[];
  version?: string;
}

export interface RunningServer {
  app: FastifyInstance;
  registry: DeviceRegistry;
  stop: () => Promise<void>;
}

export async function startServer(config: AppConfig, overrides: StartOverrides = {}): Promise<RunningServer> {
  const log = createLogger(config.logLevel);
  if (config.mqttLookupError) log.warn({ reason: config.mqttLookupError }, 'MQTT-Dienst des Supervisors nicht verfügbar');
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, 'tasmota-manager.db'), overrides.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);

  const settings = new SettingsStore(db, defaultSettings(overrides.scanCidrs ?? detectHostCidrs()));
  const registry = new DeviceRegistry(db);
  // Der MQTT-Zustand aus der letzten Sitzung ist veraltet; Discovery und LWT setzen ihn neu.
  registry.resetChannel('mqtt');
  const http = new HttpTransport();
  const mqtt = config.mqtt ? new MqttTransport(config.mqtt) : null;
  const gateway = new DeviceGateway({ registry, http, mqtt, globalPassword: () => settings.get().globalPassword });
  const scanner = new HttpScanner(
    http,
    registry,
    (id) => gateway.passwordFor(id),
    () => settings.get().globalPassword || null,
  );
  const poller = new HttpPoller({
    http,
    registry,
    passwordFor: (id) => gateway.passwordFor(id),
    intervalSec: () => settings.get().pollIntervalSec,
    log,
  });
  const hub = new WsHub();
  const store = new PendingStore(db, registry);
  const jobs = new JobRepo(db);
  // Ein Batch, der beim letzten Beenden lief, gilt als unterbrochen; seine Einträge bleiben mit Fehler stehen.
  const interrupted = jobs.recoverInterrupted();
  if (interrupted.length > 0) store.fail(interrupted, INTERRUPTED);
  const runner = new ApplyRunner({
    store,
    jobs,
    registry,
    ops: new DeviceOps(gateway),
    concurrency: () => settings.get().concurrency.command,
    log,
  });
  const ha = config.ha ? new HaClient(config.ha, log) : null;
  const enricher = new DeviceEnricher(registry, store, ha, () => resolveLanguage(settings.get().language, ha?.language));
  wireLiveEvents({ hub, registry, scanner, mqtt, store, runner, ha, enricher });
  ha?.start();

  if (mqtt) {
    new MqttDiscovery(mqtt, registry, log).start();
    mqtt.start();
  }
  poller.start();

  const webDir = overrides.webDir === undefined ? DEFAULT_WEB_DIR : overrides.webDir;
  const app = await buildApp({
    registry,
    gateway,
    scanner,
    settings,
    hub,
    store,
    runner,
    jobs,
    enricher,
    version: overrides.version ?? 'dev',
    mqttStatus: () => mqtt?.status ?? 'disabled',
    webDir: webDir && existsSync(webDir) ? webDir : undefined,
    allowedIps: config.ingressOnly ? ['172.30.32.2', '127.0.0.1'] : undefined,
    logger: log,
  });
  await app.listen({ host: '0.0.0.0', port: config.port });
  log.info({ port: config.port, mqtt: Boolean(mqtt), scanCidrs: settings.get().scanCidrs }, 'Tasmota Manager gestartet');

  return {
    app,
    registry,
    stop: async () => {
      poller.stop();
      await ha?.stop();
      hub.closeAll();
      await app.close();
      await mqtt?.stop();
      db.$client.close();
    },
  };
}
