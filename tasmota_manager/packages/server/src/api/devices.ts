import {
  AddDeviceRequestSchema,
  CommandRequestSchema,
  type CommandResult,
  type DeviceDetail,
  DeviceUpdateRequestSchema,
  type RuleState,
  type TimersState,
} from '@tm/shared';
import type { FastifyInstance } from 'fastify';
import { parseRuleState, parseTimer, parseTimersEnabled } from '../changes/catalog';
import { TransportError } from '../transport/errors';
import type { AppDeps } from './app';
import { notFound, parseBody } from './validate';

type IdParams = { Params: { id: string } };

export function registerDeviceRoutes(app: FastifyInstance, { registry, gateway, scanner, enricher }: AppDeps): void {
  app.get('/api/devices', async () => enricher.all());

  app.post('/api/devices', async (req, reply) => {
    const body = parseBody(AddDeviceRequestSchema, req.body, reply);
    if (!body) return reply;
    const device = await scanner.probe(body.ip);
    if (!device) return reply.code(422).send({ code: 'unreachable', message: `Unter ${body.ip} antwortet kein Tasmota-Gerät` });
    return reply.code(201).send(enricher.one(device.id) ?? device);
  });

  app.get<IdParams>('/api/devices/:id', async (req, reply) => {
    const device = enricher.one(req.params.id);
    if (!device) return reply.code(404).send(notFound());
    const detail: DeviceDetail = { ...device, status: registry.getStatus(device.id) };
    return detail;
  });

  app.patch<IdParams>('/api/devices/:id', async (req, reply) => {
    const body = parseBody(DeviceUpdateRequestSchema, req.body, reply);
    if (!body) return reply;
    let device = registry.get(req.params.id);
    if (!device) return reply.code(404).send(notFound());
    if (body.tags) device = registry.setTags(device.id, body.tags);
    if (body.password !== undefined) {
      device = registry.setPasswordOverride(device.id, body.password || null);
      if (device.authRequired && device.ip) {
        device = (await scanner.probeHost(device.ip, gateway.passwordFor(device.id))) ?? device;
      }
    }
    return enricher.one(device.id) ?? device;
  });

  app.delete<IdParams>('/api/devices/:id', async (req, reply) => {
    if (!registry.remove(req.params.id)) return reply.code(404).send(notFound());
    return reply.code(204).send();
  });

  app.post<IdParams>('/api/devices/:id/command', async (req, reply) => {
    const body = parseBody(CommandRequestSchema, req.body, reply);
    if (!body) return reply;
    if (!registry.get(req.params.id)) return reply.code(404).send(notFound());
    try {
      const { channel, response } = await gateway.send(req.params.id, body.command);
      return { ok: true, channel, response } satisfies CommandResult;
    } catch (err) {
      if (err instanceof TransportError) return { ok: false, code: err.code, message: err.message } satisfies CommandResult;
      throw err;
    }
  });

  app.get<IdParams>('/api/devices/:id/rules', async (req, reply) => {
    const id = req.params.id;
    if (!registry.get(id)) return reply.code(404).send(notFound());
    try {
      const rules: RuleState[] = [];
      for (const index of [1, 2, 3]) rules.push(parseRuleState(index, (await gateway.send(id, `Rule${index}`)).response));
      return rules;
    } catch (err) {
      if (err instanceof TransportError) return reply.code(502).send({ code: err.code, message: err.message });
      throw err;
    }
  });

  app.get<IdParams>('/api/devices/:id/timers', async (req, reply) => {
    const id = req.params.id;
    if (!registry.get(id)) return reply.code(404).send(notFound());
    try {
      const enabled = parseTimersEnabled((await gateway.send(id, 'Timers')).response);
      const timers: TimersState['timers'] = [];
      for (let index = 1; index <= 16; index++) timers.push(parseTimer(index, (await gateway.send(id, `Timer${index}`)).response));
      return { enabled, timers } satisfies TimersState;
    } catch (err) {
      if (err instanceof TransportError) return reply.code(502).send({ code: err.code, message: err.message });
      throw err;
    }
  });
}
