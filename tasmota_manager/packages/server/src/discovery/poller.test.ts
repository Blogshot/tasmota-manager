import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTasmota } from '../../test/fakes/fakeTasmota';
import { silentLogger, testDb } from '../../test/helpers';
import { DeviceRegistry } from '../registry';
import { TransportError } from '../transport/errors';
import type { HttpSender } from '../transport/http';
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
    fake.values.FriendlyName1 = 'Neu';
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

  it('übersteht ein während der Abfrage gelöschtes Gerät', async () => {
    fake = await new FakeTasmota({ mac: MAC }).start();
    registry.upsert({ mac: MAC, name: 'X', ip: '10.0.0.9' }, { channel: 'http' });
    const deletingHttp: HttpSender = {
      send: async () => {
        registry.remove(MAC);
        throw new TransportError('auth', 'Passwort nötig');
      },
    };
    poller = new HttpPoller({ http: deletingHttp, registry, passwordFor: () => null, intervalSec: () => 60, log: silentLogger });
    await expect(poller.pollOnce()).resolves.toBeUndefined();
    expect(registry.get(MAC)).toBeNull();
  });

  it('plant nach einem Fehler im Abfragezyklus weiter', async () => {
    fake = await new FakeTasmota({ mac: MAC }).start();
    const log = pino({ level: 'silent' });
    const error = vi.spyOn(log, 'error');
    poller = new HttpPoller({ http, registry, passwordFor: () => null, intervalSec: () => 0.01, log });
    const pollOnce = vi.spyOn(poller, 'pollOnce').mockRejectedValueOnce(new Error('kaputt')).mockResolvedValue();
    poller.start();
    await vi.waitFor(() => expect(pollOnce.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(error).toHaveBeenCalledTimes(1);
  });
});
