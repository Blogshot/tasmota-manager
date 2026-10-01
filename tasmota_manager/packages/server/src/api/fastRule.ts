import { type FastRulePreview, FastRuleRequestSchema, type StageResult } from '@tm/shared';
import type { FastifyInstance } from 'fastify';
import { parseRuleState } from '../changes/catalog';
import { buildFastRule } from '../fastRule';
import type { AppDeps } from './app';
import { parseBody } from './validate';

async function preview(deps: AppDeps, deviceId: string): Promise<FastRulePreview | null> {
  const device = deps.registry.get(deviceId);
  if (!device) return null;
  const built = buildFastRule(deps.registry.getSensors(deviceId));
  const base = { deviceId, deviceName: device.name, rule: built.rule, included: built.included, omitted: built.omitted };
  if (!built.rule) return { ...base, slot: null, reason: 'noSensors' };
  try {
    const staged = new Set(deps.store.forDevice(deviceId).map((r) => r.key));
    for (const index of [1, 2, 3]) {
      // Nur lesen; ein belegter oder bereits vorgemerkter Slot wird nie überschrieben.
      const state = parseRuleState(index, (await deps.gateway.send(deviceId, `Rule${index}`)).response);
      if (state.text.trim() === '' && !staged.has(`Rule${index}`)) return { ...base, slot: index, reason: 'ok' };
    }
    return { ...base, slot: null, reason: 'noSlot' };
  } catch {
    // Ein Lesefehler betrifft nur dieses Gerät.
    return { ...base, slot: null, reason: 'unreachable' };
  }
}

export function registerFastRuleRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/api/fast-rule/preview', async (req, reply) => {
    const body = parseBody(FastRuleRequestSchema, req.body, reply);
    if (!body) return reply;
    const results = await Promise.all(body.deviceIds.map((id) => preview(deps, id)));
    return results.filter((r): r is FastRulePreview => r !== null);
  });

  app.post('/api/fast-rule/stage', async (req, reply) => {
    const body = parseBody(FastRuleRequestSchema, req.body, reply);
    if (!body) return reply;
    const total: StageResult = { staged: 0, skipped: 0, incompatible: 0 };
    for (const id of body.deviceIds) {
      const p = await preview(deps, id);
      if (!p || p.reason !== 'ok' || !p.rule || !p.slot) continue;
      const result = deps.store.stage({
        deviceIds: [id],
        settings: { [`Rule${p.slot}`]: p.rule, [`Rule${p.slot}Enabled`]: '1', TelePeriod: '10' },
        source: 'rule',
      });
      total.staged += result.staged;
      total.skipped += result.skipped;
    }
    return total;
  });
}
