import type { MqttStatus } from '@tm/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../test/helpers';
import { DeviceGateway } from './gateway';
import { DeviceRegistry } from './registry';
import { TransportError } from './transport/errors';
import type { HttpSender, HttpTarget } from './transport/http';
import type { MqttSender, MqttTarget } from './transport/mqtt';

const MAC = 'AABBCC112233';

class StubHttpSender implements HttpSender {
  calls: string[] = [];
  passwords: Array<string | null> = [];
  constructor(public impl: (command: string) => unknown) {}
  async send(target: HttpTarget, command: string): Promise<unknown> {
    this.calls.push(command);
    this.passwords.push(target.password);
    const result = this.impl(command);
    if (result instanceof TransportError) throw result;
    return result;
  }
}

class StubMqttSender implements MqttSender {
  calls: string[] = [];
  passwords: Array<string | null> = [];
  status: MqttStatus = 'connected';
  constructor(public impl: (command: string) => unknown) {}
  async send(target: MqttTarget, command: string): Promise<unknown> {
    this.calls.push(command);
    const result = this.impl(command);
    if (result instanceof TransportError) throw result;
    return result;
  }
}

describe('DeviceGateway', () => {
  let registry: DeviceRegistry;
  let mqtt: StubMqttSender;
  let http: StubHttpSender;
  let globalPassword: string | null;
  let gateway: DeviceGateway;

  beforeEach(() => {
    registry = new DeviceRegistry(testDb());
    registry.upsert({ mac: MAC, name: 'Keller', mqttTopic: 'keller', ip: '10.0.0.5' }, { channel: 'mqtt' });
    mqtt = new StubMqttSender(() => ({ POWER: 'ON' }));
    http = new StubHttpSender(() => ({ POWER: 'OFF' }));
    globalPassword = null;
    gateway = new DeviceGateway({ registry, mqtt, http, globalPassword: () => globalPassword });
  });

  it('bevorzugt MQTT, wenn verbunden und erreichbar', async () => {
    expect(await gateway.send(MAC, 'Power')).toEqual({ channel: 'mqtt', response: { POWER: 'ON' } });
    expect(http.calls).toEqual([]);
  });

  it('übernimmt den Schaltzustand aus der Antwort ins Inventar', async () => {
    await gateway.send(MAC, 'Power TOGGLE');
    expect(registry.get(MAC)?.power).toEqual([true]);
  });

  it('nutzt HTTP, wenn der Broker getrennt ist', async () => {
    mqtt.status = 'disconnected';
    expect((await gateway.send(MAC, 'Power')).channel).toBe('http');
    expect(registry.get(MAC)?.channels).toEqual(['http', 'mqtt']);
  });

  it('weicht bei MQTT-Timeout einer Abfrage auf HTTP aus', async () => {
    mqtt.impl = () => new TransportError('timeout', 't');
    expect((await gateway.send(MAC, 'Power')).channel).toBe('http');
  });

  it('sendet nicht idempotente Befehle nach MQTT-Timeout nicht erneut', async () => {
    mqtt.impl = () => new TransportError('timeout', 't');
    await expect(gateway.send(MAC, 'Power TOGGLE')).rejects.toMatchObject({ code: 'timeout' });
    expect(http.calls).toEqual([]);
  });

  it('sendet nicht idempotente Befehle nach einem mehrdeutigen MQTT-Fehler nicht per HTTP', async () => {
    mqtt.impl = () => new TransportError('unreachable', 'Publish fehlgeschlagen');
    await expect(gateway.send(MAC, 'Power TOGGLE')).rejects.toMatchObject({ code: 'unreachable', maybeExecuted: true });
    expect(http.calls).toEqual([]);
    expect((await gateway.send(MAC, 'Power')).channel).toBe('http');
  });

  it('weicht auch mit nicht idempotenten Befehlen aus, wenn MQTT sicher nichts gesendet hat', async () => {
    mqtt.impl = () => new TransportError('offline', 'Broker nicht verbunden', false);
    expect((await gateway.send(MAC, 'Power TOGGLE')).channel).toBe('http');
    expect(http.calls).toEqual(['Power TOGGLE']);
  });

  it('weicht bei abgelehntem Befehl nicht aus', async () => {
    mqtt.impl = () => new TransportError('rejected', 'r');
    await expect(gateway.send(MAC, 'Foo')).rejects.toMatchObject({ code: 'rejected' });
    expect(http.calls).toEqual([]);
  });

  it('markiert auth-Fehler per HTTP am Gerät', async () => {
    mqtt.status = 'disconnected';
    http.impl = () => new TransportError('auth', 'a');
    await expect(gateway.send(MAC, 'Power')).rejects.toMatchObject({ code: 'auth' });
    expect(registry.get(MAC)?.authRequired).toBe(true);
  });

  it('nutzt das Geräte-Passwort vor dem globalen', async () => {
    mqtt.status = 'disconnected';
    globalPassword = 'global';
    await gateway.send(MAC, 'Power');
    registry.setPasswordOverride(MAC, 'eigenes');
    await gateway.send(MAC, 'Power');
    expect(http.passwords).toEqual(['global', 'eigenes']);
  });

  it('behandelt ein leeres globales Passwort als keines', () => {
    globalPassword = '';
    expect(gateway.passwordFor(MAC)).toBeNull();
  });

  it('meldet offline ohne erreichbaren Kanal', async () => {
    registry.upsert({ mac: 'AABBCC000009', name: 'Ohne' });
    await expect(gateway.send('AABBCC000009', 'Power')).rejects.toMatchObject({ code: 'offline', maybeExecuted: false });
    await expect(gateway.send('GIBTSNICHT', 'Power')).rejects.toMatchObject({ code: 'offline', maybeExecuted: false });
  });

  it('meidet MQTT bei Geräten mit SetOption4', async () => {
    registry.upsert({ mac: MAC }, { statusJson: { StatusLOG: { SetOption: ['00000010'] } } });
    expect((await gateway.send(MAC, 'Power')).channel).toBe('http');
    expect(mqtt.calls).toEqual([]);
  });
});
