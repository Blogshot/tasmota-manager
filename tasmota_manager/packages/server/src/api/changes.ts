import { ApplyRequestSchema, DeviceIdsRequestSchema, StageRequestSchema, type StageResult } from '@tm/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { NothingToApplyError, RunnerBusyError } from '../changes/runner';
import { StageError } from '../changes/store';
import type { AppDeps } from './app';
import { notFound, parseBody } from './validate';

export function registerChangeRoutes(app: FastifyInstance, { store, runner, jobs, enricher }: AppDeps): void {
  const busy = (reply: FastifyReply) => reply.code(409).send({ code: 'busy', message: 'A batch is currently running' });

  app.get('/api/changes', async () => store.list());

  app.post('/api/changes', async (req, reply) => {
    const body = parseBody(StageRequestSchema, req.body, reply);
    if (!body) return reply;
    try {
      return store.stage(body);
    } catch (err) {
      if (err instanceof StageError) return reply.code(400).send({ code: 'validation', message: err.message });
      throw err;
    }
  });

  app.post('/api/changes/suggestions', async (req, reply) => {
    const body = parseBody(DeviceIdsRequestSchema, req.body, reply);
    if (!body) return reply;
    const wanted = new Set(body.deviceIds);
    const total: StageResult = { staged: 0, skipped: 0, incompatible: 0 };
    for (const device of enricher.all()) {
      if (!wanted.has(device.id) || !device.nameSuggestion) continue;
      const name = device.nameSuggestion;
      const result = store.stage({ deviceIds: [device.id], settings: { DeviceName: name, FriendlyName1: name }, source: 'suggestion' });
      total.staged += result.staged;
      total.skipped += result.skipped;
      total.incompatible += result.incompatible;
    }
    return total;
  });

  app.delete<{ Params: { id: string } }>('/api/changes/:id', async (req, reply) => {
    if (runner.running) return busy(reply);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !store.discard(id)) return reply.code(404).send(notFound('Change'));
    return reply.code(204).send();
  });

  app.delete<{ Querystring: { deviceId?: string } }>('/api/changes', async (req, reply) => {
    if (runner.running) return busy(reply);
    if (req.query.deviceId) store.discardDevice(req.query.deviceId);
    else store.discardAll();
    return reply.code(204).send();
  });

  app.post('/api/changes/apply', async (req, reply) => {
    const body = parseBody(ApplyRequestSchema, req.body, reply);
    if (!body) return reply;
    try {
      return reply.code(202).send(runner.start(body.deviceIds));
    } catch (err) {
      if (err instanceof RunnerBusyError) return busy(reply);
      if (err instanceof NothingToApplyError) return reply.code(422).send({ code: 'nothing_to_apply', message: err.message });
      throw err;
    }
  });

  app.get('/api/jobs/current', async () => ({ job: jobs.latest() }));
}
