import type { Device } from '@tm/shared';
import type { Logger } from 'pino';
import type { DeviceRegistry } from '../registry';
import { TransportError } from '../transport/errors';
import type { HttpSender } from '../transport/http';
import type { TelemetryStore } from '../telemetry';
import { mapLimit } from '../util/mapLimit';
import { identifyHost } from './identify';

const MAX_FAILURES = 3;

export interface PollerDeps {
  http: HttpSender;
  registry: DeviceRegistry;
  passwordFor: (id: string) => string | null;
  intervalSec: () => number;
  log: Logger;
  timeoutMs?: number;
  telemetry?: TelemetryStore;
}

/** Fragt Geräte ohne MQTT-Kanal regelmäßig per HTTP ab. */
export class HttpPoller {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: PollerDeps) {}

  start(): void {
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<void> {
    const targets = this.deps.registry.list().filter((d) => d.ip && !d.channels.includes('mqtt'));
    await mapLimit(targets, 16, (device) => this.pollDevice(device));
  }

  private schedule(): void {
    this.timer = setTimeout(async () => {
      try {
        await this.pollOnce();
      } catch (err) {
        this.deps.log.error({ err }, 'HTTP-Abfragezyklus fehlgeschlagen');
      }
      if (this.timer) this.schedule();
    }, this.deps.intervalSec() * 1000);
  }

  private async pollDevice(device: Device): Promise<void> {
    try {
      await identifyHost(this.deps.http, this.deps.registry, device.ip ?? '', this.deps.passwordFor(device.id), this.deps.timeoutMs ?? 5000, this.deps.telemetry);
    } catch (err) {
      // Das Gerät kann während der Abfrage gelöscht oder aufgelöst worden sein.
      if (!this.deps.registry.get(device.id)) return;
      if (err instanceof TransportError && err.code === 'auth') {
        this.deps.registry.setAuthRequired(device.id, true);
        return;
      }
      const failures = this.deps.registry.recordHttpFailure(device.id);
      if (failures >= MAX_FAILURES) this.deps.registry.markUnreachable(device.id, 'http');
      this.deps.log.debug({ id: device.id, failures }, 'HTTP-Abfrage fehlgeschlagen');
    }
  }
}
