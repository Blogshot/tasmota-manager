import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startBroker } from '../../test/fakes/broker';
import { FakeTasmota } from '../../test/fakes/fakeTasmota';
import { silentLogger, testDb, waitFor } from '../../test/helpers';
import { DeviceRegistry } from '../registry';
import { TelemetryStore } from '../telemetry';
import { MqttTransport } from '../transport/mqtt';
import { MqttDiscovery } from './mqttDiscovery';

const MAC = 'AABBCC112233';

describe('MqttDiscovery', () => {
  let broker: Awaited<ReturnType<typeof startBroker>>;
  let mqtt: MqttTransport;
  let registry: DeviceRegistry;
  let fake: FakeTasmota;
  let telemetry: TelemetryStore;

  beforeEach(async () => {
    broker = await startBroker();
    registry = new DeviceRegistry(testDb());
    mqtt = new MqttTransport({ url: broker.url, timeoutMs: 1000 });
    telemetry = new TelemetryStore();
    new MqttDiscovery(mqtt, registry, silentLogger, telemetry).start();
    mqtt.start();
    await waitFor(() => mqtt.status === 'connected');
    fake = new FakeTasmota({ mac: MAC, name: 'Keller', topic: 'keller', sensors: { AM2301: { Temperature: 21 } } });
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
    // Erst den Status-0-Abruf nach dem LWT abwarten, sonst überschreibt er die Telemetrie.
    await waitFor(() => registry.get(MAC)?.online && registry.get(MAC)?.chip);
    await fake.publishState();
    await waitFor(() => registry.get(MAC)?.rssi === -55);
    expect(registry.get(MAC)?.uptimeSec).toBe(200);
  });

  it('sammelt STATE- und SENSOR-Telemetrie im Speicher', async () => {
    await fake.connectMqtt(broker.url);
    await waitFor(() => registry.get(MAC)?.online && registry.get(MAC)?.chip);
    await fake.publishState();
    await fake.publishSensor();
    await waitFor(() => telemetry.get(MAC).values.some((v) => v.key === 'AM2301.Temperature'));
    const keys = telemetry.get(MAC).values.map((v) => v.key);
    expect(keys).toContain('UptimeSec');
    expect(keys).toContain('AM2301.Temperature');
  });

  it('übernimmt Schaltvorgänge, die nicht von der App ausgelöst wurden', async () => {
    await fake.connectMqtt(broker.url);
    await waitFor(() => registry.get(MAC)?.chip);
    expect(registry.get(MAC)?.power).toEqual([false]);
    await fake.pressButton();
    await waitFor(() => registry.get(MAC)?.power[0] === true);
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
