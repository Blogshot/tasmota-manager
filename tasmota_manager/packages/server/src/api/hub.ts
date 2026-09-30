import type { WsMessage } from '@tm/shared';
import type { WebSocket } from 'ws';
import type { ApplyRunner } from '../changes/runner';
import type { PendingStore } from '../changes/store';
import type { HttpScanner } from '../discovery/scanner';
import type { DeviceEnricher } from '../enrich';
import type { HaClient } from '../ha/client';
import type { DeviceRegistry } from '../registry';
import type { MqttTransport } from '../transport/mqtt';

export class WsHub {
  private readonly sockets = new Set<WebSocket>();

  get size(): number {
    return this.sockets.size;
  }

  add(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
  }

  broadcast(message: WsMessage): void {
    const data = JSON.stringify(message);
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(data);
    }
  }

  closeAll(): void {
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
  }
}

export function wireLiveEvents(deps: {
  hub: WsHub;
  registry: DeviceRegistry;
  scanner: HttpScanner;
  mqtt: MqttTransport | null;
  store: PendingStore;
  runner: ApplyRunner;
  ha: HaClient | null;
  enricher: DeviceEnricher;
}): void {
  const { hub } = deps;
  deps.registry.on('updated', (device) => hub.broadcast({ type: 'device:updated', device: deps.enricher.one(device.id) ?? device }));
  deps.registry.on('removed', (id) => hub.broadcast({ type: 'device:removed', id }));
  deps.scanner.on('progress', (progress) => hub.broadcast({ type: 'scan:progress', ...progress }));
  deps.scanner.on('done', ({ found }) => hub.broadcast({ type: 'scan:done', found }));
  deps.mqtt?.on('status', (status) => hub.broadcast({ type: 'mqtt:status', status }));
  deps.store.on('changed', (count) => hub.broadcast({ type: 'changes:updated', count }));
  deps.runner.on('progress', (jobId, item) => hub.broadcast({ type: 'job:progress', jobId, item }));
  deps.runner.on('done', (job) => hub.broadcast({ type: 'job:done', job }));
  deps.ha?.on('changed', () => hub.broadcast({ type: 'devices:stale' }));
}
