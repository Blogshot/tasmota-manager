import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeTasmota } from '../../test/fakes/fakeTasmota';
import { silentLogger, testDb } from '../../test/helpers';
import { DeviceRegistry } from '../registry';
import { HttpTransport } from '../transport/http';
import { identifyHost } from './identify';
import { HttpPoller } from './poller';

const MAC = 'AABBCC112233';

describe('HttpPoller', () => {
  const http = new HttpTransport(500);
  let registry: DeviceRegistry;
  let fake: FakeTasmota;
  let password: string | null;
  let poller: HttpPoller;

  beforeEach(async () => {
    registry = new DeviceRegistry(testDb());
    password = null;
    poller = new HttpPoller({ http, registry, passwordFor: () => password, intervalSec: () => 60, log: silentLogger, timeoutMs: 300 });
  });

  afterEach(async () => {
    poller.stop();
    await fake.stop();
  });

  it('aktualisiert HTTP-Geräte', async () => {
    fake = await new FakeTasmota({ mac: MAC, name: 'Alt' }).start();
    await identifyHost(http, registry, fake.host, null);
    fake.values.DeviceName = 'Neu';
    await poller.pollOnce();
    expect(registry.get(MAC)?.name).toBe('Neu');
  });

  it('markiert das Gerät nach drei Fehlschlägen als nicht erreichbar', async () => {
    fake = await new FakeTasmota({ mac: MAC }).start();
    await identifyHost(http, registry, fake.host, null);
    await fake.stop();
    await poller.pollOnce();
    await poller.pollOnce();
    expect(registry.get(MAC)?.online).toBe(true);
    await poller.pollOnce();
    expect(registry.get(MAC)).toMatchObject({ online: false, channels: [] });
  });

  it('überspringt Geräte mit MQTT-Kanal', async () => {
    fake = await new FakeTasmota({ mac: MAC }).start();
    await identifyHost(http, registry, fake.host, null);
    registry.markReachable(MAC, 'mqtt');
    const before = fake.received.length;
    await poller.pollOnce();
    expect(fake.received.length).toBe(before);
  });

  it('markiert fehlende Passwörter, ohne das Gerät offline zu setzen', async () => {
    fake = await new FakeTasmota({ mac: MAC, password: 'geheim' }).start();
    await identifyHost(http, registry, fake.host, 'geheim');
    await poller.pollOnce();
    expect(registry.get(MAC)).toMatchObject({ authRequired: true, online: true });
    password = 'geheim';
    await poller.pollOnce();
    expect(registry.get(MAC)?.authRequired).toBe(false);
  });
});
