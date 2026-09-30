import type { HaLink } from '@tm/shared';
import { describe, expect, it } from 'vitest';
import { testDb } from '../test/helpers';
import { PendingStore } from './changes/store';
import { DeviceEnricher } from './enrich';
import { DeviceRegistry } from './registry';

describe('DeviceEnricher', () => {
  it('ergänzt HA-Links, Namensvorschläge und Pufferstatus', () => {
    const db = testDb();
    const registry = new DeviceRegistry(db);
    const store = new PendingStore(db, registry);
    registry.upsert(
      { mac: 'AABBCC000001', name: 'Tasmota' },
      { statusJson: { StatusSTS: { POWER: 'ON' } }, sensorsJson: { StatusSNS: { AM2301: { Temperature: 21 } } } },
    );
    registry.upsert({ mac: 'AABBCC000002', name: 'Tasmota' }, { statusJson: { StatusSTS: { POWER: 'ON' } } });
    const link: HaLink = { deviceId: 'dev1', areaName: 'Bad', entities: [], automations: [] };
    const enricher = new DeviceEnricher(registry, store, { link: (mac) => (mac === 'AABBCC000001' ? link : null) }, () => 'de');

    store.stage({ deviceIds: ['AABBCC000002'], settings: { DeviceName: 'Flur', TelePeriod: '60' }, source: 'form' });
    const [first, second] = enricher.all().sort((a, b) => a.id.localeCompare(b.id));
    expect(first).toMatchObject({ id: 'AABBCC000001', ha: link, nameSuggestion: 'Klima Bad', pendingCount: 0, pendingName: null });
    expect(second).toMatchObject({ id: 'AABBCC000002', ha: null, nameSuggestion: null, pendingCount: 2, pendingName: 'Flur' });
    expect(enricher.one('AABBCC000001')?.nameSuggestion).toBe('Klima Bad');
    expect(enricher.one('GIBTSNICHT')).toBeNull();
  });
});
