import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startBroker } from '../../test/fakes/broker';
import { FakeTasmota } from '../../test/fakes/fakeTasmota';
import { silentLogger, testDb, waitFor } from '../../test/helpers';
import { DeviceRegistry } from '../registry';
import { MqttTransport } from '../transport/mqtt';
import { MqttDiscovery } from './mqttDiscovery';

const MAC = 'AABBCC112233';

describe('MqttDiscovery', () => {
  let broker: Awaited<ReturnType<typeof startBroker>>;
  let mqtt: MqttTransport;
  let registry: DeviceRegistry;
  let fake: FakeTasmota;

  beforeEach(async () => {
    broker = await startBroker();
    registry = new DeviceRegistry(testDb());
    mqtt = new MqttTransport({ url: broker.url, timeoutMs: 1000 });
    new MqttDiscovery(mqtt, registry, silentLogger).start();
    mqtt.start();
    await waitFor(() => mqtt.status === 'connected');
    fake = new FakeTasmota({ mac: MAC, name: 'Keller', topic: 'keller' });
  });

  afterEach(async () => {
    await mqtt.stop();
    await fake.stop();
    await broker.close();
  });

  it('legt Geräte an, markiert sie online und lädt Status 0', async () => {
    await fake.connectMqtt(broker.url);
    const device = await waitFor(() => (registry.get(MAC)?.chip ? registry.get(MAC) : null));
    expect(device).toMatchObject({
      name: 'Keller',
      mqttTopic: 'keller',
      module: 'Sonoff Basic',
      firmware: '14.2.0',
      variant: 'tasmota',
      chip: 'ESP8266EX',
      online: true,
      channels: ['mqtt'],
    });
  });

  it('übernimmt STATE-Telemetrie', async () => {
    await fake.connectMqtt(broker.url);
    await waitFor(() => registry.get(MAC)?.online);
    await fake.publishState();
    await waitFor(() => registry.get(MAC)?.rssi === -55);
    expect(registry.get(MAC)?.uptimeSec).toBe(200);
  });

  it('setzt Geräte bei LWT Offline offline', async () => {
    await fake.connectMqtt(broker.url);
    await waitFor(() => registry.get(MAC)?.online);
    await fake.disconnectMqtt();
    await waitFor(() => registry.get(MAC)?.online === false);
  });

  it('entfernt den MQTT-Kanal aller Geräte, wenn der Broker wegfällt', async () => {
    await fake.connectMqtt(broker.url);
    await waitFor(() => registry.get(MAC)?.online);
    mqtt.emit('status', 'disconnected');
    expect(registry.get(MAC)).toMatchObject({ online: false, channels: [] });
  });

  it('abonniert beim Start bereits bekannte Geräte', async () => {
    const other = new DeviceRegistry(testDb());
    other.upsert({ mac: MAC, name: 'Bekannt', mqttTopic: 'keller' });
    const second = new MqttTransport({ url: broker.url, timeoutMs: 1000 });
    new MqttDiscovery(second, other, silentLogger).start();
    await fake.connectMqtt(broker.url);
    second.start();
    await waitFor(() => other.get(MAC)?.online);
    await second.stop();
  });
});
