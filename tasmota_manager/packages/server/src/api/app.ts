import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { HaLocation, HaSuggestions, MqttStatus } from '@tm/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { JobRepo } from '../changes/jobs';
import type { ApplyRunner } from '../changes/runner';
import type { PendingStore } from '../changes/store';
import type { HttpScanner } from '../discovery/scanner';
import type { DeviceEnricher } from '../enrich';
import type { DeviceGateway } from '../gateway';
import type { DeviceRegistry } from '../registry';
import type { SettingsStore } from '../settings';
import type { TelemetryStore } from '../telemetry';
import { registerChangeRoutes } from './changes';
import { registerDeviceRoutes } from './devices';
import { registerFastRuleRoutes } from './fastRule';
import type { WsHub } from './hub';
import { registerLiveRoutes } from './live';
import { registerSettingsRoutes } from './settings';
import { notFound } from './validate';

export interface AppDeps {
  registry: DeviceRegistry;
  gateway: DeviceGateway;
  scanner: HttpScanner;
  settings: SettingsStore;
  hub: WsHub;
  store: PendingStore;
  runner: ApplyRunner;
  jobs: JobRepo;
  enricher: DeviceEnricher;
  telemetry?: TelemetryStore;
  mqttStatus: () => MqttStatus;
  /** Standort aus Home Assistant für Koordinaten-Vorschläge */
  haLocation?: () => HaLocation | null;
  haSuggestions?: () => HaSuggestions;
  version: string;
  webDir?: string;
  allowedIps?: string[];
  logger?: Logger;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // pino.Logger und FastifyBaseLogger sind für tsc nicht zuweisungskompatibel (msgPrefix)
  const app = (deps.logger ? Fastify({ loggerInstance: deps.logger }) : Fastify({ logger: false })) as unknown as FastifyInstance;

  if (deps.allowedIps) {
    const allowed = new Set(deps.allowedIps);
    app.addHook('onRequest', async (req, reply) => {
      const ip = req.ip.replace(/^::ffff:/, '');
      if (!allowed.has(ip)) {
        return reply.code(403).send({ code: 'forbidden', message: 'Access only through Home Assistant (ingress)' });
      }
    });
  }

  await app.register(websocket);
  registerDeviceRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerLiveRoutes(app, deps);
  registerChangeRoutes(app, deps);
  registerFastRuleRoutes(app, deps);

  if (deps.webDir) {
    await app.register(fastifyStatic, { root: deps.webDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.code(404).send(notFound('Ressource')) : reply.sendFile('index.html'),
    );
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send(notFound('Ressource')));
  }
  return app;
}
