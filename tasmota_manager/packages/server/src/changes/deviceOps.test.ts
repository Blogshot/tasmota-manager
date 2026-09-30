import { afterEach, describe, expect, it } from 'vitest';
import { FakeTasmota } from '../../test/fakes/fakeTasmota';
import { testDb } from '../../test/helpers';
import { identifyHost } from '../discovery/identify';
import { DeviceGateway, type SendResult } from '../gateway';
import { DeviceRegistry } from '../registry';
import { TransportError } from '../transport/errors';
import { HttpTransport } from '../transport/http';
import { DeviceOps } from './deviceOps';

const MAC = 'AABBCC112233';
const http = new HttpTransport(500);
let fake: FakeTasmota | null = null;

afterEach(async () => {
  await fake?.stop();
  fake = null;
});

async function withFake(downtimeMs: number) {
  fake = await new FakeTasmota({ mac: MAC, restartDelayMs: 20, downtimeMs }).start();
  const registry = new DeviceRegistry(testDb());
  await identifyHost(http, registry, fake.host, null);
  const gateway = new DeviceGateway({ registry, http, mqtt: null, globalPassword: () => null });
  return new DeviceOps(gateway, { restartTimeoutMs: 1500, pollIntervalMs: 30, commandTimeoutMs: 300 });
}

class StubGateway {
  calls = 0;
  constructor(private readonly outcomes: Array<TransportError | unknown>) {}
  async send(): Promise<SendResult> {
    const outcome = this.outcomes[Math.min(this.calls, this.outcomes.length - 1)];
    this.calls++;
    if (outcome instanceof TransportError) throw outcome;
    return { channel: 'http', response: outcome };
  }
}

describe('DeviceOps', () => {
  it('liest die Laufzeit', async () => {
    const ops = await withFake(100);
    expect(await ops.uptime(MAC)).toBe(100);
  });

  it('erkennt einen Neustart an der kleineren Laufzeit', async () => {
    const ops = await withFake(150);
    const before = await ops.uptime(MAC);
    await ops.send(MAC, 'Restart 1', false);
    await ops.waitForRestart(MAC, before);
    expect(fake?.restarts).toBe(1);
  });

  it('meldet offline, wenn das Gerät nicht zurückkommt', async () => {
    const ops = await withFake(60_000);
    const before = await ops.uptime(MAC);
    await ops.send(MAC, 'Restart 1', false);
    await expect(ops.waitForRestart(MAC, before)).rejects.toMatchObject({ code: 'offline' });
  });

  it('wiederholt bei nicht erreichbarem Gerät', async () => {
    const gateway = new StubGateway([new TransportError('unreachable', 'x'), new TransportError('unreachable', 'x'), { ok: 1 }]);
    const ops = new DeviceOps(gateway as unknown as DeviceGateway, { restartTimeoutMs: 1000, pollIntervalMs: 10 });
    expect((await ops.send(MAC, 'LedState 1', true)).response).toEqual({ ok: 1 });
    expect(gateway.calls).toBe(3);
  });

  it('wiederholt nicht idempotente Befehle nach einem Timeout nicht', async () => {
    const gateway = new StubGateway([new TransportError('timeout', 'x'), { ok: 1 }]);
    const ops = new DeviceOps(gateway as unknown as DeviceGateway, { restartTimeoutMs: 1000, pollIntervalMs: 10 });
    await expect(ops.send(MAC, 'Power TOGGLE', false)).rejects.toMatchObject({ code: 'timeout' });
    expect(gateway.calls).toBe(1);
  });

  it('gibt abgelehnte Befehle sofort weiter', async () => {
    const gateway = new StubGateway([new TransportError('rejected', 'x')]);
    const ops = new DeviceOps(gateway as unknown as DeviceGateway, { restartTimeoutMs: 1000, pollIntervalMs: 10 });
    await expect(ops.send(MAC, 'Foo', true)).rejects.toMatchObject({ code: 'rejected' });
    expect(gateway.calls).toBe(1);
  });
});
