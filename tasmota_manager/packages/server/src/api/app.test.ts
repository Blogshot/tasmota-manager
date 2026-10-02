import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device, DeviceTelemetry, WsMessage } from '@tm/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupApps, setupApp as setup } from '../../test/appSetup';
import { silentLogger, waitFor } from '../../test/helpers';
import { haSuggestionsFrom } from '../haSuggestions';

afterEach(cleanupApps);

async function addFake(app: FastifyInstance): Promise<Device> {
  const res = await app.inject({ method: 'POST', url: '/api/devices', payload: { ip: '127.0.0.1' } });
  expect(res.statusCode).toBe(201);
  return res.json<Device>();
}

describe('Geräte-API', () => {
  it('fügt Geräte per IP hinzu und listet sie', async () => {
    const { app } = await setup();
    const device = await addFake(app);
    expect(device).toMatchObject({ id: 'AABBCC112233', name: 'Keller', channels: ['http'] });
    const list = await app.inject('/api/devices');
    expect(list.json<Device[]>()).toHaveLength(1);
  });

  it('liefert 422, wenn unter der IP kein Tasmota antwortet', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/devices', payload: { ip: '127.0.0.9' } });
    expect(res.statusCode).toBe(422);
    const invalid = await app.inject({ method: 'POST', url: '/api/devices', payload: { ip: 'kein-ip' } });
    expect(invalid.statusCode).toBe(400);
  });

  it('liefert Details mit Rohstatus und 404 für Unbekannte', async () => {
    const { app } = await setup();
    await addFake(app);
    const detail = await app.inject('/api/devices/AABBCC112233');
    expect(detail.json()).toMatchObject({ id: 'AABBCC112233', status: { StatusNET: { Mac: 'AA:BB:CC:11:22:33' } } });
    expect((await app.inject('/api/devices/UNBEKANNT')).statusCode).toBe(404);
  });

  it('führt Befehle aus und meldet abgelehnte Befehle', async () => {
    const { app } = await setup();
    await addFake(app);
    const ok = await app.inject({ method: 'POST', url: '/api/devices/AABBCC112233/command', payload: { command: 'Power ON' } });
    expect(ok.json()).toEqual({ ok: true, channel: 'http', response: { POWER: 'ON' } });
    const rejected = await app.inject({ method: 'POST', url: '/api/devices/AABBCC112233/command', payload: { command: 'Foo' } });
    expect(rejected.json()).toMatchObject({ ok: false, code: 'rejected' });
  });

  it('setzt Tags und Passwort, ohne das Passwort auszuliefern', async () => {
    const { app } = await setup();
    await addFake(app);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/devices/AABBCC112233',
      payload: { tags: ['Licht', 'Keller'], password: 'geheim' },
    });
    expect(res.json()).toMatchObject({ tags: ['Keller', 'Licht'], hasPasswordOverride: true });
    expect(res.body).not.toContain('geheim');
  });

  it('löst Passwort-Platzhalter nach Eingabe des Passworts auf', async () => {
    const { app, registry, fake } = await setup({ fakePassword: 'geheim' });
    const placeholder = await addFake(app);
    expect(placeholder).toMatchObject({ id: `IP-${fake.host}`, authRequired: true });
    const res = await app.inject({ method: 'PATCH', url: `/api/devices/${encodeURIComponent(placeholder.id)}`, payload: { password: 'geheim' } });
    expect(res.json()).toMatchObject({ id: 'AABBCC112233', authRequired: false, hasPasswordOverride: true });
    expect(registry.get(placeholder.id)).toBeNull();
  });

  it('entfernt Geräte', async () => {
    const { app } = await setup();
    await addFake(app);
    expect((await app.inject({ method: 'DELETE', url: '/api/devices/AABBCC112233' })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: '/api/devices/AABBCC112233' })).statusCode).toBe(404);
  });
});

describe('Einstellungen, Status und Scan', () => {
  it('validiert Einstellungen und verbirgt das Passwort', async () => {
    const { app } = await setup();
    const tooBig = await app.inject({ method: 'PUT', url: '/api/settings', payload: { scanCidrs: ['10.0.0.0/8'] } });
    expect(tooBig.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PUT', url: '/api/settings', payload: { scanCidrs: ['10.0.0.0/24'], globalPassword: 'geheim' } });
    expect(ok.json()).toMatchObject({ scanCidrs: ['10.0.0.0/24'], hasGlobalPassword: true });
    expect(ok.body).not.toContain('geheim');
    expect((await app.inject('/api/settings')).body).not.toContain('geheim');
  });

  it('speichert die Sprache und lehnt unbekannte ab', async () => {
    const { app } = await setup();
    expect((await app.inject('/api/settings')).json()).toMatchObject({ language: 'auto' });
    const saved = await app.inject({ method: 'PUT', url: '/api/settings', payload: { language: 'nl' } });
    expect(saved.json()).toMatchObject({ language: 'nl' });
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { language: 'xx' } })).statusCode).toBe(400);
  });

  it('liefert den Status', async () => {
    const { app } = await setup();
    expect((await app.inject('/api/status')).json()).toMatchObject({ mqtt: 'disabled', version: 'test', scanning: false, haLocation: null });
  });

  it('gibt in den HA-Vorschlägen nie die Zugangsdaten des MQTT-Dienstes aus', async () => {
    const { app } = await setup();
    const body = (await app.inject('/api/status')).body;
    expect(JSON.parse(body)).toMatchObject({ haSuggestions: { ntpServer: 'pool.ntp.org', mqtt: null } });
  });

  it('gibt auch mit Supervisor-MQTT-Dienst weder Benutzer noch Passwort in /api/status aus', async () => {
    const service = { url: 'mqtt://core-mosquitto:1883', username: 'svc-user', password: 'svc-secret', onHa: true };
    const { app } = await setup({
      haSuggestions: (registry) => haSuggestionsFrom({ ha: null, mqtt: service, registry, hostIp: '192.168.1.5', log: silentLogger }),
    });
    const body = (await app.inject('/api/status')).body;
    expect(JSON.parse(body)).toMatchObject({ haSuggestions: { mqtt: { host: '192.168.1.5', port: 1883 } } });
    expect(body).not.toContain('svc-user');
    expect(body).not.toContain('svc-secret');
  });

  it('liefert den Standort aus Home Assistant für Koordinaten-Vorschläge', async () => {
    const { app } = await setup({ haLocation: { latitude: 52.52, longitude: 13.405 } });
    expect((await app.inject('/api/status')).json()).toMatchObject({ haLocation: { latitude: 52.52, longitude: 13.405 } });
  });

  it('startet Scans über die konfigurierten Bereiche', async () => {
    const { app, registry, settings } = await setup();
    settings.update({ scanCidrs: [] });
    expect((await app.inject({ method: 'POST', url: '/api/scan' })).statusCode).toBe(422);
    settings.update({ scanCidrs: ['127.0.0.1/32'] });
    expect((await app.inject({ method: 'POST', url: '/api/scan' })).statusCode).toBe(202);
    await waitFor(() => registry.get('AABBCC112233'));
  });
});

describe('Telemetrie-API', () => {
  const MAC = 'AABBCC112233';
  const sensors = { AM2301: { Temperature: 21 } };

  it('liefert beim Auffrischen die Sensorwerte des Geräts', async () => {
    const { app } = await setup({ fake: { sensors } });
    await addFake(app);
    const res = await app.inject(`/api/devices/${MAC}/telemetry?refresh=1`);
    expect(res.statusCode).toBe(200);
    expect(res.json<DeviceTelemetry>().values).toContainEqual(expect.objectContaining({ key: 'AM2301.Temperature', value: 21 }));
    const summary = await app.inject('/api/telemetry');
    expect(summary.json()).toMatchObject({ [MAC]: [{ key: 'AM2301.Temperature' }] });
  });

  it('liefert bei nicht erreichbarem Gerät den letzten Stand', async () => {
    const { app, fake } = await setup({ fake: { sensors } });
    await addFake(app);
    await app.inject(`/api/devices/${MAC}/telemetry?refresh=1`);
    await fake.stop();
    const res = await app.inject(`/api/devices/${MAC}/telemetry?refresh=1`);
    expect(res.statusCode).toBe(200);
    expect(res.json<DeviceTelemetry>().values.map((v) => v.key)).toContain('AM2301.Temperature');
  });

  it('vergisst die Telemetrie gelöschter Geräte und kennt unbekannte nicht', async () => {
    const { app } = await setup({ fake: { sensors } });
    await addFake(app);
    await app.inject(`/api/devices/${MAC}/telemetry?refresh=1`);
    expect((await app.inject({ method: 'DELETE', url: `/api/devices/${MAC}` })).statusCode).toBe(204);
    expect(await app.inject('/api/telemetry').then((r) => r.json())).not.toHaveProperty(MAC);
    expect((await app.inject('/api/devices/UNBEKANNT/telemetry')).statusCode).toBe(404);
  });

  it('sendet Telemetrie per WebSocket mit Kopfwerten', async () => {
    const { app, telemetry, hub } = await setup();
    await app.ready();
    const ws = await app.injectWS('/api/ws');
    await waitFor(() => hub.size === 1);
    const received = new Promise<WsMessage>((resolve) => ws.on('message', (data) => resolve(JSON.parse(data.toString()))));
    // Für das Ereignis wird nicht der ganze Verlauf kopiert.
    const get = vi.spyOn(telemetry, 'get');
    telemetry.record(MAC, 'sensor', { AM2301: { Temperature: 21 } });
    const message = await received;
    expect(message).toMatchObject({ type: 'telemetry', deviceId: MAC, headline: [{ key: 'AM2301.Temperature' }] });
    expect(message).toMatchObject({ updatedAt: telemetry.updatedAt(MAC) });
    expect(get).not.toHaveBeenCalled();
    ws.terminate();
  });
});

describe('Live-Updates und Zugriffsschutz', () => {
  it('sendet Geräteänderungen per WebSocket', async () => {
    const { app, registry, hub } = await setup();
    await app.ready();
    const ws = await app.injectWS('/api/ws');
    await waitFor(() => hub.size === 1);
    const received = new Promise<WsMessage>((resolve) => ws.on('message', (data) => resolve(JSON.parse(data.toString()))));
    registry.upsert({ mac: 'AABBCC000001', name: 'Neu' });
    expect(await received).toMatchObject({ type: 'device:updated', device: { id: 'AABBCC000001' } });
    ws.terminate();
  });

  it('weist Anfragen außerhalb des Ingress ab', async () => {
    const { app } = await setup({ allowedIps: ['172.30.32.2'] });
    expect((await app.inject('/api/status')).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/status', remoteAddress: '172.30.32.2' })).statusCode).toBe(200);
  });

  it('liefert die Weboberfläche aus und fällt für unbekannte Pfade auf index.html zurück', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'tm-web-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>TM</title>');
    const { app } = await setup({ webDir });
    expect((await app.inject('/')).body).toContain('<title>TM</title>');
    expect((await app.inject('/irgendwas')).body).toContain('<title>TM</title>');
    const missing = await app.inject('/api/gibtsnicht');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'not_found' });
  });
});
