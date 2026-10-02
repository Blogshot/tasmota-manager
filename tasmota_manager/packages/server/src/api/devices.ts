import {
  AddDeviceRequestSchema,
  CommandRequestSchema,
  type CommandResult,
  type DeviceDetail,
  type ErrorCode,
  DeviceUpdateRequestSchema,
  type RuleState,
  type SettingDef,
  type SettingValue,
  SettingsReadRequestSchema,
  type SettingsReadResult,
  type TimersState,
  settingDef,
} from '@tm/shared';
import type { FastifyInstance } from 'fastify';
import { extractValue, parseRuleState, parseTimer, parseTimersEnabled, readCommand } from '../changes/catalog';
import { TransportError } from '../transport/errors';
import type { AppDeps } from './app';
import { notFound, parseBody } from './validate';

type IdParams = { Params: { id: string } };

/** Fehler, nach denen weitere Abfragen an dasselbe Gerät nur Zeit kosten. */
const UNREACHABLE = new Set<ErrorCode>(['offline', 'unreachable', 'timeout']);

export function registerDeviceRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { registry, gateway, scanner, enricher } = deps;
  app.get('/api/devices', async () => enricher.all());

  app.post('/api/devices', async (req, reply) => {
    const body = parseBody(AddDeviceRequestSchema, req.body, reply);
    if (!body) return reply;
    const device = await scanner.probe(body.ip);
    if (!device) return reply.code(422).send({ code: 'unreachable', message: `No Tasmota device answers at ${body.ip}` });
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
    if (body.suggestionDismissed !== undefined) device = registry.setSuggestionDismissed(device.id, body.suggestionDismissed);
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

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>('/api/devices/:id/telemetry', async (req, reply) => {
    const device = registry.get(req.params.id);
    if (!device) return reply.code(404).send(notFound());
    if (req.query.refresh === '1' && !device.channels.includes('mqtt')) {
      // Nur lesen; ein nicht erreichbares Gerät liefert den letzten Stand.
      for (const [command, source] of [
        ['Status 10', 'sensor'],
        ['Status 11', 'state'],
      ] as const) {
        try {
          deps.telemetry?.record(device.id, source, (await gateway.send(device.id, command)).response);
        } catch {
          // letzter Stand bleibt
        }
      }
    }
    return deps.telemetry?.get(device.id) ?? { updatedAt: null, values: [], history: {} };
  });

  app.get('/api/telemetry', async () => deps.telemetry?.summary() ?? {});

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

  /**
   * Liest mehrere Einstellungen live vom Gerät, nacheinander (nur Abfragen, schreibt nichts). Nicht lesbare und
   * unbekannte Schlüssel werden übersprungen; ist das Gerät nicht erreichbar, bleiben die übrigen Werte `null`.
   */
  app.post<IdParams>('/api/devices/:id/settings/read', async (req, reply) => {
    const body = parseBody(SettingsReadRequestSchema, req.body, reply);
    if (!body) return reply;
    const id = req.params.id;
    if (!registry.get(id)) return reply.code(404).send(notFound());
    const defs = [...new Set(body.keys)].map((key) => settingDef(key)).filter((def): def is SettingDef => def !== undefined && !def.writeOnly);
    const values: SettingsReadResult['values'] = Object.fromEntries(defs.map((def) => [def.key, null]));
    for (const def of defs) {
      try {
        values[def.key] = extractValue(def, (await gateway.send(id, readCommand(def))).response);
      } catch (err) {
        if (err instanceof TransportError && UNREACHABLE.has(err.code)) break;
      }
    }
    return { values } satisfies SettingsReadResult;
  });

  /** Liest den aktuellen Wert einer Einstellung live vom Gerät (nur Abfrage, schreibt nichts). */
  app.get<{ Params: { id: string; key: string } }>('/api/devices/:id/settings/:key', async (req, reply) => {
    const { id, key } = req.params;
    const def = settingDef(key);
    if (!registry.get(id) || !def) return reply.code(404).send(notFound(def ? 'Device' : 'Setting'));
    if (def.writeOnly) return reply.code(400).send({ code: 'validation', message: `${key} cannot be read` });
    try {
      const { response } = await gateway.send(id, readCommand(def));
      return { value: extractValue(def, response) } satisfies SettingValue;
    } catch (err) {
      if (err instanceof TransportError) return reply.code(502).send({ code: err.code, message: err.message });
      throw err;
    }
  });
}
