import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startBroker } from '../../test/fakes/broker';
import { FakeTasmota, type FakeTasmotaOptions } from '../../test/fakes/fakeTasmota';
import { waitFor } from '../../test/helpers';
import type { DeviceInfo } from '../tasmota/parse';
import { TransportError } from './errors';
import { MqttTransport } from './mqtt';

describe('MqttTransport', () => {
  let broker: Awaited<ReturnType<typeof startBroker>>;
  let mqtt: MqttTransport;
  const fakes: FakeTasmota[] = [];

  beforeEach(async () => {
    broker = await startBroker();
    mqtt = new MqttTransport({ url: broker.url, timeoutMs: 1000 });
    mqtt.start();
    await waitFor(() => mqtt.status === 'connected');
  });

  afterEach(async () => {
    await mqtt.stop();
    for (const f of fakes.splice(0)) await f.stop();
    await broker.close();
  });

  async function fake(opts: Partial<FakeTasmotaOptions> = {}): Promise<FakeTasmota> {
    const f = new FakeTasmota({ mac: 'AABBCC112233', topic: 'keller', ...opts });
    fakes.push(f);
    await f.connectMqtt(broker.url);
    return f;
  }

  it('meldet Discovery-Nachrichten', async () => {
    const seen: DeviceInfo[] = [];
    mqtt.on('discovery', (info) => seen.push(info));
    await fake();
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ mac: 'AABBCC112233', mqttTopic: 'keller', fullTopic: '%prefix%/%topic%/' });
  });

  it('sendet Befehle und liefert die Antwort', async () => {
    await fake();
    const target = { topic: 'keller', fullTopic: null };
    expect(await mqtt.send(target, 'Status 0')).toMatchObject({ StatusNET: { Mac: 'AA:BB:CC:11:22:33' } });
    expect(await mqtt.send(target, 'Power TOGGLE')).toEqual({ POWER: 'ON' });
  });

  it('funktioniert mit umgestelltem FullTopic', async () => {
    await fake({ fullTopic: '%topic%/%prefix%/' });
    expect(await mqtt.send({ topic: 'keller', fullTopic: '%topic%/%prefix%/' }, 'Power ON')).toEqual({ POWER: 'ON' });
  });

  it('ordnet parallele Befehle an dasselbe Gerät korrekt zu', async () => {
    await fake({ name: 'Keller', responseDelayMs: 50 });
    const target = { topic: 'keller', fullTopic: null };
    const [a, b] = await Promise.all([mqtt.send(target, 'FriendlyName1'), mqtt.send(target, 'Timezone')]);
    expect(a).toEqual({ FriendlyName1: 'Keller' });
    expect(b).toEqual({ Timezone: 99 });
  });

  it('meldet rejected bei unbekanntem Befehl', async () => {
    await fake();
    const err = await mqtt.send({ topic: 'keller', fullTopic: null }, 'Foo').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).code).toBe('rejected');
  });

  it('meldet timeout, wenn niemand antwortet', async () => {
    const err = await mqtt.send({ topic: 'ghost', fullTopic: null }, 'Power', 200).catch((e: unknown) => e);
    expect((err as TransportError).code).toBe('timeout');
  });

  it('meldet LWT-Wechsel beobachteter Geräte', async () => {
    const events: Array<[string, boolean]> = [];
    mqtt.on('lwt', (topic, online) => events.push([topic, online]));
    await mqtt.watch({ topic: 'keller', fullTopic: null });
    const f = await fake();
    await waitFor(() => events.some(([, online]) => online));
    await f.disconnectMqtt();
    await waitFor(() => events.some(([, online]) => !online));
    expect(events[0]).toEqual(['keller', true]);
  });

  it('meldet offline, wenn der Broker nicht verbunden ist', async () => {
    const offline = new MqttTransport({ url: 'mqtt://127.0.0.1:1' });
    offline.start();
    const err = await offline.send({ topic: 'keller', fullTopic: null }, 'Power').catch((e: unknown) => e);
    expect((err as TransportError).code).toBe('offline');
    await offline.stop();
  });
});
