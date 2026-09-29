import { mkdtempSync, writeFileSync } from 'node:fs';
import type { networkInterfaces } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { detectHostCidrs, loadConfig } from './config';

function dataDir(options?: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'tm-config-'));
  if (options) writeFileSync(join(dir, 'options.json'), JSON.stringify(options));
  return dir;
}

describe('loadConfig', () => {
  it('nutzt Standardwerte ohne Optionen', async () => {
    const config = await loadConfig({ TM_DATA_DIR: dataDir() }, vi.fn());
    expect(config).toMatchObject({ port: 8099, logLevel: 'info', mqtt: null, ingressOnly: false });
  });

  it('bevorzugt MQTT-Daten aus den App-Optionen', async () => {
    const fetchFn = vi.fn();
    const config = await loadConfig(
      { TM_DATA_DIR: dataDir({ log_level: 'debug', mqtt_host: 'broker', mqtt_username: 'u', mqtt_password: 'p' }), SUPERVISOR_TOKEN: 't' },
      fetchFn,
    );
    expect(config.mqtt).toEqual({ url: 'mqtt://broker:1883', username: 'u', password: 'p' });
    expect(config.logLevel).toBe('debug');
    expect(config.ingressOnly).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('holt MQTT-Daten vom Supervisor', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: 'ok', data: { host: 'core-mosquitto', port: 1883, ssl: false, username: 'addons', password: 'x' } })),
    );
    const config = await loadConfig({ TM_DATA_DIR: dataDir(), SUPERVISOR_TOKEN: 'token' }, fetchFn);
    expect(config.mqtt).toEqual({ url: 'mqtt://core-mosquitto:1883', username: 'addons', password: 'x' });
    expect(fetchFn).toHaveBeenCalledWith('http://supervisor/services/mqtt', expect.objectContaining({ headers: { Authorization: 'Bearer token' } }));
  });

  it('läuft ohne MQTT weiter, wenn der Supervisor keinen Dienst kennt', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 400 }));
    const config = await loadConfig({ TM_DATA_DIR: dataDir(), SUPERVISOR_TOKEN: 'token' }, fetchFn);
    expect(config.mqtt).toBeNull();
  });

  it('nutzt TM_MQTT_URL für die lokale Entwicklung', async () => {
    const config = await loadConfig({ TM_DATA_DIR: dataDir(), TM_MQTT_URL: 'mqtt://localhost:1883' }, vi.fn());
    expect(config.mqtt).toEqual({ url: 'mqtt://localhost:1883' });
  });
});

describe('detectHostCidrs', () => {
  it('liefert LAN-Netze, höchstens /24, ohne Docker- und Loopback-Schnittstellen', () => {
    const ifaces = {
      lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: '127.0.0.1/8' }],
      enp3s0: [
        { address: '192.168.1.10', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: '192.168.1.10/24' },
        { address: 'fe80::1', netmask: 'ffff::', family: 'IPv6', mac: '', internal: false, cidr: 'fe80::1/64', scopeid: 2 },
      ],
      wlan0: [{ address: '10.1.5.20', netmask: '255.255.0.0', family: 'IPv4', mac: '', internal: false, cidr: '10.1.5.20/16' }],
      hassio: [{ address: '172.30.32.1', netmask: '255.255.254.0', family: 'IPv4', mac: '', internal: false, cidr: '172.30.32.1/23' }],
      docker0: [{ address: '172.17.0.1', netmask: '255.255.0.0', family: 'IPv4', mac: '', internal: false, cidr: '172.17.0.1/16' }],
    } as ReturnType<typeof networkInterfaces>;
    expect(detectHostCidrs(ifaces)).toEqual(['192.168.1.0/24', '10.1.5.0/24']);
  });
});
