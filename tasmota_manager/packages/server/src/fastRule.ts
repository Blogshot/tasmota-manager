import { MAX_RULE_LENGTH } from '@tm/shared';
import { isObj } from './tasmota/parse';

const SKIPPED = (key: string) => key === 'ENERGY' || /^ESP32/i.test(key);

/** Eine Regel, die bei jeder Messung eines Sensorblocks sofort Telemetrie sendet (`TelePeriod` ohne Argument). */
export function buildFastRule(sensors: unknown): { rule: string | null; included: string[]; omitted: string[] } {
  const sns = isObj(sensors) && isObj(sensors.StatusSNS) ? sensors.StatusSNS : {};
  const included: string[] = [];
  const omitted: string[] = [];
  const lines: string[] = [];
  for (const [block, values] of Object.entries(sns)) {
    if (!isObj(values)) continue;
    if (SKIPPED(block)) {
      omitted.push(block);
      continue;
    }
    const field = Object.entries(values).find(([, v]) => typeof v === 'number')?.[0];
    if (!field) continue;
    const line = `ON ${block}#${field} DO TelePeriod ENDON`;
    if ([...lines, line].join(' ').length > MAX_RULE_LENGTH) {
      omitted.push(block);
      continue;
    }
    lines.push(line);
    included.push(block);
  }
  return { rule: lines.length > 0 ? lines.join(' ') : null, included, omitted };
}
