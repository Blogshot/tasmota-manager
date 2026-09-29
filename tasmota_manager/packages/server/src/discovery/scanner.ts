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

const isAuthError = (err: unknown): boolean => err instanceof TransportError && err.code === 'auth';

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
    /** Passwort (Override oder global) für bekannte Geräte. */
    private readonly passwordFor: (id: string) => string | null,
    private readonly globalPassword: () => string | null,
    private readonly opts: ScannerOptions = {},
  ) {
    super();
  }

  hostFor(ip: string): string {
    const port = this.opts.port ?? 80;
    return port === 80 ? ip : `${ip}:${port}`;
  }

  async probe(ip: string): Promise<Device | null> {
    const host = this.hostFor(ip);
    const known = this.registry.findByIp(host);
    if (known) return this.probeHost(host, this.passwordFor(known.id));
    // Unbekannte Hosts bekommen das globale Passwort erst, wenn sie mit einem Tasmota-typischen 401 antworten.
    const global = this.globalPassword();
    if (!global) return this.probeHost(host, null);
    try {
      return await this.identify(host, null);
    } catch (err) {
      if (!isAuthError(err)) return null;
    }
    return this.probeHost(host, global);
  }

  async probeHost(host: string, password: string | null): Promise<Device | null> {
    try {
      return await this.identify(host, password);
    } catch (err) {
      if (isAuthError(err)) return this.registry.upsertAuthPlaceholder(host);
      return null;
    }
  }

  private identify(host: string, password: string | null): Promise<Device> {
    return identifyHost(this.http, this.registry, host, password, this.opts.timeoutMs ?? 1500);
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
