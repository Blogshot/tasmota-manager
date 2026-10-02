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
    const link: HaLink = { deviceId: 'dev1', areaName: 'Bad', nameByUser: null, entities: [], automations: [] };
    const enricher = new DeviceEnricher(registry, store, { link: (mac) => (mac === 'AABBCC000001' ? link : null) }, () => 'de');

    store.stage({ deviceIds: ['AABBCC000002'], settings: { DeviceName: 'Flur', TelePeriod: '60' }, source: 'form' });
    const [first, second] = enricher.all().sort((a, b) => a.id.localeCompare(b.id));
    expect(first).toMatchObject({ id: 'AABBCC000001', ha: link, nameSuggestion: 'Klima Bad', pendingCount: 0, pendingName: null });
    expect(first?.capabilities).toEqual(['relay', 'climate']);
    expect(second).toMatchObject({ id: 'AABBCC000002', ha: null, nameSuggestion: null, pendingCount: 2, pendingName: 'Flur' });
    expect(enricher.one('AABBCC000001')?.nameSuggestion).toBe('Klima Bad');
    expect(enricher.one('GIBTSNICHT')).toBeNull();
  });

  it('zeigt abgelehnte Namensvorschläge nicht mehr an und vergibt ihren Namen nicht', () => {
    const db = testDb();
    const registry = new DeviceRegistry(db);
    const store = new PendingStore(db, registry);
    for (const mac of ['AABBCC000001', 'AABBCC000002']) {
      registry.upsert({ mac, name: 'Tasmota' }, { statusJson: { StatusSTS: { POWER: 'ON' } } });
    }
    const enricher = new DeviceEnricher(registry, store, null, () => 'de');
    expect(registry.setSuggestionDismissed('AABBCC000001', true).suggestionDismissed).toBe(true);
    const [first, second] = enricher.all().sort((a, b) => a.id.localeCompare(b.id));
    expect(first?.nameSuggestion).toBeNull();
    // Ohne den abgelehnten Vorschlag braucht das zweite Gerät keine Nummer.
    expect(second?.nameSuggestion).toBe('Schalter');
    registry.setSuggestionDismissed('AABBCC000001', false);
    expect(enricher.one('AABBCC000001')?.nameSuggestion).toBe('Schalter');
  });

  it('schlägt den in HA vergebenen Namen vor, auch für eigene Namen', () => {
    const db = testDb();
    const registry = new DeviceRegistry(db);
    const store = new PendingStore(db, registry);
    registry.upsert({ mac: 'AABBCC000001', name: 'Keller' }, { statusJson: { StatusSTS: { POWER: 'ON' } } });
    const link: HaLink = { deviceId: 'dev1', areaName: null, nameByUser: 'Kellerlicht', entities: [], automations: [] };
    const enricher = new DeviceEnricher(registry, store, { link: () => link }, () => 'de');
    expect(enricher.one('AABBCC000001')?.nameSuggestion).toBe('Kellerlicht');
  });

  it('schlägt einen HA-Namen über 32 Zeichen nicht vor, sondern den Typnamen', () => {
    const db = testDb();
    const registry = new DeviceRegistry(db);
    const store = new PendingStore(db, registry);
    registry.upsert({ mac: 'AABBCC000001', name: 'Tasmota' }, { statusJson: { StatusSTS: { POWER: 'ON' } } });
    const nameByUser = 'Ein sehr langer Name aus Home Assistant';
    expect(nameByUser.length).toBe(39);
    const link: HaLink = { deviceId: 'dev1', areaName: null, nameByUser, entities: [], automations: [] };
    const enricher = new DeviceEnricher(registry, store, { link: () => link }, () => 'de');
    expect(enricher.one('AABBCC000001')?.nameSuggestion).toBe('Schalter');
  });

  it('markiert Geräte als veraltet, die HA nicht kennt und die seit über 7 Tagen offline sind', () => {
    const db = testDb();
    const registry = new DeviceRegistry(db, () => new Date('2026-09-20T12:00:00Z'));
    const store = new PendingStore(db, registry);
    for (const mac of ['AABBCC000001', 'AABBCC000002', 'AABBCC000003']) {
      registry.upsert({ mac, name: mac }, { channel: 'http' });
      registry.updateRuntime(mac, {});
    }
    registry.markUnreachable('AABBCC000001', 'http'); // offline, nicht in HA → veraltet
    registry.markUnreachable('AABBCC000002', 'http'); // offline, aber in HA → nicht veraltet
    // AABBCC000003 ist online → nicht veraltet
    const link: HaLink = { deviceId: 'dev2', areaName: null, nameByUser: null, entities: [], automations: [] };
    const ha = { ready: true, linksLoaded: true, link: (mac: string) => (mac === 'AABBCC000002' ? link : null) };
    const now = () => new Date('2026-10-02T12:00:00Z');
    const stale = (e: DeviceEnricher) => e.all().filter((d) => d.stale).map((d) => d.id);
    expect(stale(new DeviceEnricher(registry, store, ha, () => 'de', now))).toEqual(['AABBCC000001']);
    // Ohne HA-Verbindung lässt sich „nicht in HA“ nicht beurteilen.
    expect(stale(new DeviceEnricher(registry, store, { ...ha, ready: false }, () => 'de', now))).toEqual([]);
    expect(stale(new DeviceEnricher(registry, store, null, () => 'de', now))).toEqual([]);
    // Erst nach 7 Tagen.
    expect(stale(new DeviceEnricher(registry, store, ha, () => 'de', () => new Date('2026-09-25T12:00:00Z')))).toEqual([]);
  });
});
