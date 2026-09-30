import type { Logger } from 'pino';
import type { DeviceRegistry } from '../registry';
import { parseState, parseStatus0 } from '../tasmota/parse';
import type { MqttTarget, MqttTransport } from '../transport/mqtt';

export class MqttDiscovery {
  constructor(
    private readonly mqtt: MqttTransport,
    private readonly registry: DeviceRegistry,
    private readonly log: Logger,
  ) {}

  start(): void {
    for (const device of this.registry.list()) {
      if (device.mqttTopic) this.watch({ topic: device.mqttTopic, fullTopic: device.fullTopic });
    }

    this.mqtt.on('discovery', (info) => {
      this.registry.upsert(info);
      if (info.mqttTopic) this.watch({ topic: info.mqttTopic, fullTopic: info.fullTopic ?? null });
    });

    this.mqtt.on('lwt', (topic, online) => {
      const device = this.registry.findByTopic(topic);
      if (!device) return;
      if (!online) {
        this.registry.markUnreachable(device.id, 'mqtt');
        return;
      }
      this.registry.markReachable(device.id, 'mqtt');
      void this.refresh(device.id, { topic, fullTopic: device.fullTopic });
    });

    this.mqtt.on('state', (topic, payload) => {
      const device = this.registry.findByTopic(topic);
      if (!device) return;
      this.registry.updateRuntime(device.id, parseState(payload));
      if (!device.channels.includes('mqtt')) this.registry.markReachable(device.id, 'mqtt');
    });

    this.mqtt.on('power', (topic, power) => {
      const device = this.registry.findByTopic(topic);
      if (device) this.registry.updateRuntime(device.id, { power });
    });

    this.mqtt.on('status', (status) => {
      if (status === 'connected') return;
      for (const device of this.registry.list()) {
        if (device.channels.includes('mqtt')) this.registry.markUnreachable(device.id, 'mqtt');
      }
    });
  }

  private watch(target: MqttTarget): void {
    this.mqtt.watch(target).catch((err: unknown) => this.log.warn({ err, topic: target.topic }, 'MQTT-Abo fehlgeschlagen'));
  }

  private async refresh(id: string, target: MqttTarget): Promise<void> {
    try {
      const payload = await this.mqtt.send(target, 'Status 0');
      const info = parseStatus0(payload);
      if (!info) return;
      const sensors = await this.mqtt.send(target, 'Status 10').catch(() => undefined);
      this.registry.upsert(info, { statusJson: payload, sensorsJson: sensors });
    } catch (err) {
      this.log.warn({ err, id }, 'Status 0 per MQTT fehlgeschlagen');
    }
  }
}
