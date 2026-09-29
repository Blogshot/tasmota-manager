import { EventEmitter } from 'node:events';
import { type Device, type ScanProgress, intToIp, parseCidr } from '@tm/shared';
import type { DeviceRegistry } from '../registry';
import { TransportError } from '../transport/errors';
import type { HttpSender } from '../transport/http';
import { mapLimit } from '../util/mapLimit';
import { identifyHost } from './identify';

export function expandCidr(cidr: string): string[] {
  const parsed = parseCidr(cidr);
  if (!parsed) throw new Error(`Ungültiger Bereich: ${cidr}`);
  const size = 2 ** (32 - parsed.prefix);
  const first = parsed.prefix >= 31 ? 0 : 1;
  const last = parsed.prefix >= 31 ? size - 1 : size - 2;
  const ips: string[] = [];
  for (let i = first; i <= last; i++) ips.push(intToIp(parsed.base + i));
  return ips;
}

export interface ScannerOptions {
  port?: number;
  concurrency?: number;
  timeoutMs?: number;
}

type ScannerEvents = { progress: [ScanProgress]; done: [{ found: number }] };

export class HttpScanner extends EventEmitter<ScannerEvents> {
  running = false;

  constructor(
    private readonly http: HttpSender,
    private readonly registry: DeviceRegistry,
    private readonly credentials: (host: string) => string | null,
    private readonly opts: ScannerOptions = {},
  ) {
    super();
  }

  hostFor(ip: string): string {
    const port = this.opts.port ?? 80;
    return port === 80 ? ip : `${ip}:${port}`;
  }

  probe(ip: string): Promise<Device | null> {
    const host = this.hostFor(ip);
    return this.probeHost(host, this.credentials(host));
  }

  async probeHost(host: string, password: string | null): Promise<Device | null> {
    try {
      return await identifyHost(this.http, this.registry, host, password, this.opts.timeoutMs ?? 1500);
    } catch (err) {
      if (err instanceof TransportError && err.code === 'auth') return this.registry.upsertAuthPlaceholder(host);
      return null;
    }
  }

  async scan(cidrs: string[]): Promise<{ found: number }> {
    if (this.running) throw new Error('Es läuft bereits ein Scan');
    this.running = true;
    try {
      const ips = [...new Set(cidrs.flatMap(expandCidr))];
      const progress: ScanProgress = { scanned: 0, total: ips.length, found: 0 };
      await mapLimit(ips, this.opts.concurrency ?? 32, async (ip) => {
        if (await this.probe(ip)) progress.found++;
        progress.scanned++;
        if (progress.scanned % 16 === 0 || progress.scanned === progress.total) this.emit('progress', { ...progress });
      });
      this.emit('done', { found: progress.found });
      return { found: progress.found };
    } finally {
      this.running = false;
    }
  }
}
