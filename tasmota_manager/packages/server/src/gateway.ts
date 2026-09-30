import type { Channel, Device } from '@tm/shared';
import type { DeviceRegistry } from './registry';
import { isQuery } from './tasmota/commands';
import { parsePower } from './tasmota/parse';
import { TransportError } from './transport/errors';
import type { HttpSender } from './transport/http';
import type { MqttSender } from './transport/mqtt';

export interface GatewayDeps {
  registry: DeviceRegistry;
  http: HttpSender;
  mqtt: MqttSender | null;
  globalPassword: () => string | null;
}

export interface SendResult {
  channel: Channel;
  response: unknown;
}

export class DeviceGateway {
  constructor(private readonly deps: GatewayDeps) {}

  passwordFor(id: string): string | null {
    return this.deps.registry.getPasswordOverride(id) ?? (this.deps.globalPassword() || null);
  }

  async send(id: string, command: string, timeoutMs?: number): Promise<SendResult> {
    const device = this.deps.registry.get(id);
    if (!device) throw new TransportError('offline', `Unknown device ${id}`, false);
    const channels = this.channelsFor(device);
    if (channels.length === 0) throw new TransportError('offline', 'Device is reachable neither via MQTT nor via HTTP', false);

    let lastError: TransportError | null = null;
    for (const [index, channel] of channels.entries()) {
      try {
        const response = await this.sendVia(channel, device, command, timeoutMs);
        this.deps.registry.markReachable(id, channel);
        const power = parsePower(response);
        if (Object.keys(power).length > 0) this.deps.registry.updateRuntime(id, { power });
        return { channel, response };
      } catch (err) {
        if (!(err instanceof TransportError)) throw err;
        lastError = err;
        if (channel === 'http' && err.code === 'auth') this.deps.registry.setAuthRequired(id, true);
        if (index === channels.length - 1 || !canFallback(err, command)) break;
      }
    }
    throw lastError ?? new TransportError('offline', 'Device not reachable');
  }

  private channelsFor(device: Device): Channel[] {
    const channels: Channel[] = [];
    // Mit SetOption4 1 antwortet Tasmota nicht auf RESULT; die Antwortzuordnung per MQTT funktioniert dann nicht.
    if (!device.setOption4 && this.deps.mqtt?.status === 'connected' && device.mqttTopic && device.channels.includes('mqtt')) {
      channels.push('mqtt');
    }
    if (device.ip) channels.push('http');
    return channels;
  }

  private sendVia(channel: Channel, device: Device, command: string, timeoutMs?: number): Promise<unknown> {
    if (channel === 'mqtt' && this.deps.mqtt && device.mqttTopic) {
      return this.deps.mqtt.send({ topic: device.mqttTopic, fullTopic: device.fullTopic }, command, timeoutMs);
    }
    return this.deps.http.send({ host: device.ip ?? '', password: this.passwordFor(device.id) }, command, timeoutMs);
  }
}

/**
 * Hat das Gerät den Befehl eventuell schon ausgeführt (Timeout, Abbruch nach dem Senden, unlesbare Antwort), werden nur
 * Abfragen über den nächsten Kanal wiederholt, damit z. B. „Power TOGGLE" nicht doppelt schaltet.
 */
function canFallback(err: TransportError, command: string): boolean {
  if (err.code === 'rejected') return false;
  return isQuery(command) || !err.maybeExecuted;
}
