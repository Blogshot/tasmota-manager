import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';

export interface FakeHaData {
  devices: Array<Record<string, unknown>>;
  entities: Array<Record<string, unknown>>;
  areas: Array<Record<string, unknown>>;
  related: Record<string, { automation?: string[] }>;
}

/** Minimaler Home-Assistant-WebSocket für Tests (Auth, Registrys, search/related, Events). */
export class FakeHa {
  readonly requests: string[] = [];
  connections = 0;
  port = 0;
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();

  constructor(
    public data: FakeHaData,
    private readonly token = 'geheim',
  ) {}

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  async start(): Promise<this> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.wss = wss;
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    this.port = (wss.address() as AddressInfo).port;
    wss.on('connection', (ws) => this.accept(ws));
    return this;
  }

  emitEvent(eventType: string): void {
    for (const ws of this.clients) ws.send(JSON.stringify({ id: 1, type: 'event', event: { event_type: eventType, data: {} } }));
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) ws.terminate();
    const wss = this.wss;
    this.wss = null;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  private accept(ws: WebSocket): void {
    this.connections++;
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.9.0' }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id?: number; type: string; access_token?: string; item_id?: string };
      if (msg.type === 'auth') {
        if (msg.access_token === this.token) {
          ws.send(JSON.stringify({ type: 'auth_ok', ha_version: '2026.9.0' }));
        } else {
          ws.send(JSON.stringify({ type: 'auth_invalid', message: 'Invalid access token or password' }));
          ws.close();
        }
        return;
      }
      this.requests.push(msg.type);
      const ok = (result: unknown) => ws.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result }));
      switch (msg.type) {
        case 'subscribe_events':
          ok(null);
          break;
        case 'config/device_registry/list':
          ok(this.data.devices);
          break;
        case 'config/entity_registry/list':
          ok(this.data.entities);
          break;
        case 'config/area_registry/list':
          ok(this.data.areas);
          break;
        case 'search/related':
          ok(this.data.related[msg.item_id ?? ''] ?? {});
          break;
        default:
          ws.send(JSON.stringify({ id: msg.id, type: 'result', success: false, error: { code: 'unknown_command', message: 'Unknown command.' } }));
      }
    });
  }
}
