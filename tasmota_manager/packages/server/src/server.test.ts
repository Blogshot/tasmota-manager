import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device } from '@tm/shared';
import { describe, expect, it } from 'vitest';
import { startBroker } from '../test/fakes/broker';
import { FakeTasmota } from '../test/fakes/fakeTasmota';
import { MIGRATIONS_DIR, waitFor } from '../test/helpers';
import { startServer } from './server';

describe('startServer', () => {
  it('startet, findet ein MQTT-Gerät und liefert es über die API aus', async () => {
    const broker = await startBroker();
    const dataDir = mkdtempSync(join(tmpdir(), 'tm-server-'));
    const server = await startServer(
      { dataDir, port: 0, logLevel: 'silent', mqtt: { url: broker.url }, ingressOnly: false },
      { migrationsDir: MIGRATIONS_DIR, webDir: null, scanCidrs: [] },
    );
    const fake = new FakeTasmota({ mac: 'AABBCC112233', name: 'Keller', topic: 'keller' });
    try {
      await fake.connectMqtt(broker.url);
      const devices = await waitFor(async () => {
        const list = (await server.app.inject('/api/devices')).json<Device[]>();
        return list.length === 1 && list[0]?.online ? list : null;
      });
      expect(devices[0]).toMatchObject({ id: 'AABBCC112233', channels: ['mqtt'] });
      const status = (await server.app.inject('/api/status')).json();
      expect(status).toMatchObject({ mqtt: 'connected' });
    } finally {
      await fake.stop();
      await server.stop();
      await broker.close();
    }
  });
});
