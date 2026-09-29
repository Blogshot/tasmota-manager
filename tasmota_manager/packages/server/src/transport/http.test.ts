import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeTasmota } from '../../test/fakes/fakeTasmota';
import { parseStatus0 } from '../tasmota/parse';
import { TransportError } from './errors';
import { HttpTransport } from './http';

const http = new HttpTransport(2000);
const started: FakeTasmota[] = [];

async function fake(opts: Partial<ConstructorParameters<typeof FakeTasmota>[0]> = {}): Promise<FakeTasmota> {
  const f = await new FakeTasmota({ mac: 'AABBCC112233', name: 'Keller', ...opts }).start();
  started.push(f);
  return f;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(TransportError);
  await promise.catch((err: TransportError) => expect(err.code).toBe(code));
}

afterEach(async () => {
  for (const f of started.splice(0)) await f.stop();
});

describe('HttpTransport', () => {
  it('liefert Status 0 als JSON', async () => {
    const f = await fake();
    const response = await http.send({ host: f.host, password: null }, 'Status 0');
    expect(parseStatus0(response)?.mac).toBe('AABBCC112233');
  });

  it('kodiert Leerzeichen und Sonderzeichen korrekt', async () => {
    const f = await fake();
    await http.send({ host: f.host, password: null }, 'FriendlyName1 Küche & Bad');
    expect(await http.send({ host: f.host, password: null }, 'FriendlyName1')).toEqual({ FriendlyName1: 'Küche & Bad' });
  });

  it('meldet auth ohne oder mit falschem Passwort', async () => {
    const f = await fake({ password: 'geheim' });
    await expectCode(http.send({ host: f.host, password: null }, 'Power'), 'auth');
    await expectCode(http.send({ host: f.host, password: 'falsch' }, 'Power'), 'auth');
  });

  it('akzeptiert das richtige Passwort', async () => {
    const f = await fake({ password: 'geh eim&' });
    expect(await http.send({ host: f.host, password: 'geh eim&' }, 'Power ON')).toEqual({ POWER: 'ON' });
  });

  it('meldet rejected bei unbekanntem Befehl', async () => {
    const f = await fake();
    await expectCode(http.send({ host: f.host, password: null }, 'Foo'), 'rejected');
  });

  it('meldet timeout bei zu langsamer Antwort', async () => {
    const f = await fake({ responseDelayMs: 500 });
    await expectCode(http.send({ host: f.host, password: null }, 'Power', 100), 'timeout');
  });

  it('meldet unreachable bei geschlossenem Port', async () => {
    await expectCode(http.send({ host: '127.0.0.1:1', password: null }, 'Power'), 'unreachable');
  });

  it('behandelt fremde Geräte mit 401 nicht als Tasmota', async () => {
    const server: Server = createServer((_req, res) => res.writeHead(401, { 'Content-Type': 'text/html' }).end('<h1>Login</h1>'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      await expectCode(http.send({ host: `127.0.0.1:${port}`, password: null }, 'Status 0'), 'unreachable');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
