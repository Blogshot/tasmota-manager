import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device, JobView, PendingDevice } from '@tm/shared';
import { describe, expect, it } from 'vitest';
import { startBroker } from '../test/fakes/broker';
import { FakeTasmota } from '../test/fakes/fakeTasmota';
import { MIGRATIONS_DIR, waitFor } from '../test/helpers';
import { INTERRUPTED, JobRepo } from './changes/jobs';
import { PendingStore } from './changes/store';
import { openDb } from './db';
import { DeviceRegistry } from './registry';
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

  it('markiert beim Start einen Batch, der beim letzten Beenden lief, als unterbrochen', async () => {
    const mac = 'AABBCC112233';
    const dataDir = mkdtempSync(join(tmpdir(), 'tm-server-'));
    const db = openDb(join(dataDir, 'tasmota-manager.db'), MIGRATIONS_DIR);
    const registry = new DeviceRegistry(db);
    registry.upsert({ mac, name: 'Keller' });
    registry.upsert({ mac: 'AABBCC000002', name: 'Bad' });
    const store = new PendingStore(db, registry);
    store.stage({ deviceIds: [mac, 'AABBCC000002'], settings: { LedState: '2' }, commands: ['Power ON'], source: 'form' });
    const jobs = new JobRepo(db);
    // Keller lief gerade, Bad wartete noch.
    const job = jobs.create(
      [mac, 'AABBCC000002'].map((id) => ({ deviceId: id, deviceName: id, changeIds: store.forDevice(id).map((r) => r.id) })),
    );
    jobs.updateItem(job.id, mac, { status: 'running', step: 'write' });
    db.$client.close();

    const server = await startServer(
      { dataDir, port: 0, logLevel: 'silent', mqtt: null, ingressOnly: false },
      { migrationsDir: MIGRATIONS_DIR, webDir: null, scanCidrs: [] },
    );
    try {
      const pending = (await server.app.inject('/api/changes')).json<PendingDevice[]>();
      expect(pending.flatMap((d) => d.changes.map((c) => c.error))).toEqual([INTERRUPTED, INTERRUPTED, INTERRUPTED, INTERRUPTED]);
      const current = (await server.app.inject('/api/jobs/current')).json<{ job: JobView }>().job;
      expect(current.status).toBe('done');
      expect(current.items.map((i) => [i.status, i.step, i.error])).toEqual([
        ['failed', null, INTERRUPTED],
        ['failed', null, INTERRUPTED],
      ]);
    } finally {
      await server.stop();
    }
  });

  it('setzt beim Start ohne MQTT gespeicherte MQTT-Kanäle zurück', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tm-server-'));
    const db = openDb(join(dataDir, 'tasmota-manager.db'), MIGRATIONS_DIR);
    new DeviceRegistry(db).upsert({ mac: 'AABBCC112233', name: 'Keller', mqttTopic: 'keller' }, { channel: 'mqtt' });
    db.$client.close();

    const server = await startServer(
      { dataDir, port: 0, logLevel: 'silent', mqtt: null, ingressOnly: false },
      { migrationsDir: MIGRATIONS_DIR, webDir: null, scanCidrs: [] },
    );
    try {
      expect(server.registry.get('AABBCC112233')).toMatchObject({ channels: [], online: false });
    } finally {
      await server.stop();
    }
  });
});
