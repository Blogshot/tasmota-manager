import { SettingsUpdateRequestSchema } from '@tm/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from './app';
import { parseBody } from './validate';

export function registerSettingsRoutes(app: FastifyInstance, { settings }: AppDeps): void {
  app.get('/api/settings', async () => settings.toPublic());

  app.put('/api/settings', async (req, reply) => {
    const body = parseBody(SettingsUpdateRequestSchema, req.body, reply);
    if (!body) return reply;
    settings.update(body);
    return settings.toPublic();
  });
}
