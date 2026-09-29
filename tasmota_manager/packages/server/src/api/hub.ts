import type { WsMessage } from '@tm/shared';
import type { WebSocket } from 'ws';
import type { HttpScanner } from '../discovery/scanner';
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
}): void {
  const { hub } = deps;
  deps.registry.on('updated', (device) => hub.broadcast({ type: 'device:updated', device }));
  deps.registry.on('removed', (id) => hub.broadcast({ type: 'device:removed', id }));
  deps.scanner.on('progress', (progress) => hub.broadcast({ type: 'scan:progress', ...progress }));
  deps.scanner.on('done', ({ found }) => hub.broadcast({ type: 'scan:done', found }));
  deps.mqtt?.on('status', (status) => hub.broadcast({ type: 'mqtt:status', status }));
}
