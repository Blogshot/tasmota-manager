import { afterEach, describe, expect, it } from 'vitest';
import { FakeHa, type FakeHaData } from '../../test/fakes/haServer';
import { silentLogger, waitFor } from '../../test/helpers';
import { HaClient, macOfHaDevice } from './client';

const data = (): FakeHaData => ({
  devices: [
    { id: 'dev1', area_id: 'bad', connections: [['mac', 'aa:bb:cc:11:22:33']], identifiers: [] },
    { id: 'dev2', area_id: null, connections: [], identifiers: [['tasmota', 'AABBCC000002']] },
  ],
  entities: [
    { entity_id: 'switch.bad', device_id: 'dev1', unique_id: 'x', name: null, original_name: 'Bad Schalter' },
    { entity_id: 'sensor.bad_temp', device_id: 'dev1', unique_id: 'y', name: 'Temperatur Bad', original_name: 'Temperature' },
    { entity_id: 'sensor.bad_rssi', device_id: 'dev1', unique_id: 'd', name: null, original_name: 'RSSI', entity_category: 'diagnostic' },
    { entity_id: 'number.bad_teleperiod', device_id: 'dev1', unique_id: 'c', name: null, original_name: 'TelePeriod', entity_category: 'config' },
    { entity_id: 'sensor.bad_aus', device_id: 'dev1', unique_id: 'o', name: null, original_name: 'Aus', entity_category: null, disabled_by: 'user' },
    { entity_id: 'automation.licht_bad', device_id: null, unique_id: '1700000000', name: null, original_name: 'Licht Bad' },
    { entity_id: 'automation.yaml_ohne_id', device_id: null, unique_id: null, name: null, original_name: null },
  ],
  areas: [{ area_id: 'bad', name: 'Bad' }],
  language: 'de',
  location: { latitude: 52.52, longitude: 13.405 },
  related: { dev1: { automation: ['automation.licht_bad', 'automation.yaml_ohne_id'] } },
});

let ha: FakeHa | null = null;
let client: HaClient | null = null;

afterEach(async () => {
  await client?.stop();
  await ha?.stop();
  client = null;
  ha = null;
});

describe('macOfHaDevice', () => {
  it('liest die MAC aus connections oder Tasmota-Identifiern', () => {
    expect(macOfHaDevice({ connections: [['mac', 'aa:bb:cc:11:22:33']] })).toBe('AABBCC112233');
    expect(macOfHaDevice({ identifiers: [['tasmota', 'AABBCC000002']] })).toBe('AABBCC000002');
    expect(macOfHaDevice({ identifiers: [['zha', 'x']] })).toBeNull();
  });
});

describe('HaClient', () => {
  it('ordnet Geräte zu und liefert Entitäten, Bereich und Automationen', async () => {
    ha = await new FakeHa(data()).start();
    client = new HaClient({ url: ha.url, token: 'geheim' }, silentLogger, { debounceMs: 20 });
    client.start();
    const link = await waitFor(() => client?.link('AABBCC112233'));
    expect(link).toEqual({
      deviceId: 'dev1',
      areaName: 'Bad',
      nameByUser: null,
      entities: [
        { entityId: 'switch.bad', name: 'Bad Schalter' },
        { entityId: 'sensor.bad_temp', name: 'Temperatur Bad' },
      ],
      automations: [
        { id: '1700000000', entityId: 'automation.licht_bad', name: 'Licht Bad' },
        { id: null, entityId: 'automation.yaml_ohne_id', name: 'automation.yaml_ohne_id' },
      ],
    });
    expect(client.link('AABBCC000002')).toMatchObject({ deviceId: 'dev2', areaName: null, entities: [], automations: [] });
  });

  it('lässt Diagnose-, Konfigurations- und deaktivierte Entitäten weg', async () => {
    ha = await new FakeHa(data()).start();
    client = new HaClient({ url: ha.url, token: 'geheim' }, silentLogger, { debounceMs: 20 });
    client.start();
    const link = await waitFor(() => client?.link('AABBCC112233'));
    expect(link.entities.map((e) => e.entityId)).toEqual(['switch.bad', 'sensor.bad_temp']);
  });

  it('liest die Systemsprache von Home Assistant', async () => {
    ha = await new FakeHa(data()).start();
    client = new HaClient({ url: ha.url, token: 'geheim' }, silentLogger, { debounceMs: 20 });
    expect(client.language).toBeNull();
    client.start();
    await waitFor(() => client?.link('AABBCC112233'));
    expect(client.language).toBe('de');
    expect(client.location).toEqual({ latitude: 52.52, longitude: 13.405 });
  });

  it('lädt bei Registry-Events neu und meldet Änderungen', async () => {
    ha = await new FakeHa(data()).start();
    client = new HaClient({ url: ha.url, token: 'geheim' }, silentLogger, { debounceMs: 20 });
    let changed = 0;
    client.on('changed', () => changed++);
    client.start();
    await waitFor(() => client?.link('AABBCC112233'));
    ha.data.areas = [{ area_id: 'bad', name: 'Badezimmer' }];
    ha.emitEvent('area_registry_updated');
    await waitFor(() => client?.link('AABBCC112233')?.areaName === 'Badezimmer');
    expect(changed).toBeGreaterThanOrEqual(2);
  });

  it('gibt bei ungültigem Token auf, statt ständig neu zu verbinden', async () => {
    ha = await new FakeHa(data()).start();
    client = new HaClient({ url: ha.url, token: 'falsch' }, silentLogger, { debounceMs: 20, reconnectMs: 20 });
    client.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.ready).toBe(false);
    expect(client.link('AABBCC112233')).toBeNull();
    expect(ha.connections).toBe(1);
  });

  it('verbindet nach einem Verbindungsabbruch neu', async () => {
    ha = await new FakeHa(data()).start();
    client = new HaClient({ url: ha.url, token: 'geheim' }, silentLogger, { debounceMs: 20, reconnectMs: 20 });
    client.start();
    await waitFor(() => client?.link('AABBCC112233'));
    ha.data.areas = [{ area_id: 'bad', name: 'Neu' }];
    ha.dropClients();
    await waitFor(() => client?.link('AABBCC112233')?.areaName === 'Neu');
    expect(ha.connections).toBe(2);
  });

  it('hinterlässt nach stop() keine Timer und behält die letzten Daten', async () => {
    ha = await new FakeHa(data()).start();
    client = new HaClient({ url: ha.url, token: 'geheim' }, silentLogger, { debounceMs: 20, refreshMs: 20 });
    client.start();
    await waitFor(() => client?.link('AABBCC112233'));
    await client.stop();
    const count = ha.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ha.requests.length).toBe(count);
    expect(client.link('AABBCC112233')?.areaName).toBe('Bad');
  });

  it('behält die bisherigen Daten, wenn search/related ausfällt', async () => {
    ha = await new FakeHa(data()).start();
    client = new HaClient({ url: ha.url, token: 'geheim' }, silentLogger, { debounceMs: 20, requestTimeoutMs: 50 });
    let changed = 0;
    client.on('changed', () => changed++);
    client.start();
    await waitFor(() => client?.link('AABBCC112233'));
    const before = changed;
    ha.failRelated = true;
    ha.data.areas = [{ area_id: 'bad', name: 'Neu' }];
    ha.emitEvent('area_registry_updated');
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(changed).toBe(before);
    expect(client.link('AABBCC112233')?.areaName).toBe('Bad');
    expect(client.link('AABBCC112233')?.automations).toHaveLength(2);
  });

  it('wirft bei einer ungültigen URL nicht', () => {
    client = new HaClient({ url: 'kein-url', token: 'x' }, silentLogger);
    expect(() => client?.start()).not.toThrow();
    expect(client.ready).toBe(false);
  });
});
