import { type Server, createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeTasmota } from '../../test/fakes/fakeTasmota';
import { testDb } from '../../test/helpers';
import { DeviceRegistry, placeholderId } from '../registry';
import { HttpTransport } from '../transport/http';
import { HttpScanner, expandCidr } from './scanner';

describe('expandCidr', () => {
  it('lässt Netz- und Broadcast-Adresse weg', () => {
    expect(expandCidr('192.168.1.0/30')).toEqual(['192.168.1.1', '192.168.1.2']);
  });
  it('behandelt /31 und /32 vollständig', () => {
    expect(expandCidr('10.0.0.4/31')).toEqual(['10.0.0.4', '10.0.0.5']);
    expect(expandCidr('10.0.0.7/32')).toEqual(['10.0.0.7']);
  });
  it('wirft bei ungültigen Bereichen', () => {
    expect(() => expandCidr('kaputt')).toThrow();
  });
});

describe('HttpScanner', () => {
  const http = new HttpTransport(1000);
  let registry: DeviceRegistry;
  let fakes: FakeTasmota[];
  let stranger: Server | null;

  beforeEach(() => {
    registry = new DeviceRegistry(testDb());
    fakes = [];
    stranger = null;
  });

  afterEach(async () => {
    for (const f of fakes) await f.stop();
    if (stranger) {
      stranger.closeAllConnections();
      await new Promise<void>((resolve) => stranger?.close(() => resolve()));
    }
  });

  it('findet Tasmota-Geräte und ignoriert fremde Webserver', async () => {
    const first = await new FakeTasmota({ mac: 'AABBCC000001', name: 'Eins' }).start();
    const second = await new FakeTasmota({ mac: 'AABBCC000003', name: 'Drei', bindHost: '127.0.0.3', port: first.port }).start();
    fakes.push(first, second);
    const server = createServer((_req, res) => res.writeHead(401, { 'Content-Type': 'text/html' }).end('<h1>Router</h1>'));
    stranger = server;
    await new Promise<void>((resolve) => server.listen(first.port, '127.0.0.2', () => resolve()));

    const scanner = new HttpScanner(http, registry, () => null, { port: first.port, timeoutMs: 500 });
    const done: number[] = [];
    scanner.on('done', ({ found }) => done.push(found));
    expect(await scanner.scan(['127.0.0.0/29'])).toEqual({ found: 2 });
    expect(done).toEqual([2]);
    expect(scanner.running).toBe(false);
    const devices = registry.list();
    expect(devices.map((d) => d.id).sort()).toEqual(['AABBCC000001', 'AABBCC000003']);
    expect(devices.find((d) => d.id === 'AABBCC000001')).toMatchObject({
      ip: first.host,
      module: 'Sonoff Basic',
      channels: ['http'],
      online: true,
    });
  });

  it('legt für passwortgeschützte Geräte einen Platzhalter an und löst ihn mit Passwort auf', async () => {
    const locked = await new FakeTasmota({ mac: 'AABBCC000005', password: 'geheim' }).start();
    fakes.push(locked);
    const scanner = new HttpScanner(http, registry, () => null, { port: locked.port, timeoutMs: 500 });
    const placeholder = await scanner.probe('127.0.0.1');
    expect(placeholder).toMatchObject({ id: placeholderId(locked.host), authRequired: true });

    const device = await scanner.probeHost(locked.host, 'geheim');
    expect(device?.id).toBe('AABBCC000005');
    expect(registry.get(placeholderId(locked.host))).toBeNull();
  });

  it('verwendet das Passwort bekannter Geräte beim Scan', async () => {
    const locked = await new FakeTasmota({ mac: 'AABBCC000006', password: 'geheim' }).start();
    fakes.push(locked);
    registry.upsert({ mac: 'AABBCC000006', name: 'X', ip: locked.host });
    registry.setPasswordOverride('AABBCC000006', 'geheim');
    const scanner = new HttpScanner(http, registry, (host) => registry.getPasswordOverride(registry.findByIp(host)?.id ?? ''), {
      port: locked.port,
      timeoutMs: 500,
    });
    const device = await scanner.probe('127.0.0.1');
    expect(device).toMatchObject({ id: 'AABBCC000006', authRequired: false });
  });

  it('verhindert parallele Scans', async () => {
    const scanner = new HttpScanner(http, registry, () => null, { port: 1, timeoutMs: 200 });
    const first = scanner.scan(['127.0.0.1/32']);
    await expect(scanner.scan(['127.0.0.1/32'])).rejects.toThrow();
    await first;
  });
});
