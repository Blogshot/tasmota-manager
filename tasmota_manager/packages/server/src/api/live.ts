import type { StatusResponse } from '@tm/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from './app';

export function registerLiveRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/status', async (): Promise<StatusResponse> => ({
    mqtt: deps.mqttStatus(),
    version: deps.version,
    scanning: deps.scanner.running,
  }));

  app.post('/api/scan', async (_req, reply) => {
    if (deps.scanner.running) return reply.code(409).send({ code: 'busy', message: 'A scan is already running' });
    const cidrs = deps.settings.get().scanCidrs;
    if (cidrs.length === 0) return reply.code(422).send({ code: 'no_cidrs', message: 'No scan ranges configured' });
    void deps.scanner.scan(cidrs).catch((err: unknown) => app.log.error({ err }, 'Scan fehlgeschlagen'));
    return reply.code(202).send({ started: true });
  });

  app.get('/api/ws', { websocket: true }, (socket) => deps.hub.add(socket));
}
