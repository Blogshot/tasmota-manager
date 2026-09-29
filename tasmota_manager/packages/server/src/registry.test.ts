import type { Device } from '@tm/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../test/helpers';
import { DeviceRegistry, placeholderId } from './registry';

const MAC_A = 'AABBCC000001';
const MAC_B = 'AABBCC000002';

describe('DeviceRegistry', () => {
  let registry: DeviceRegistry;
  let updates: Device[];
  let removed: string[];

  beforeEach(() => {
    registry = new DeviceRegistry(testDb(), () => new Date('2026-09-29T12:00:00Z'));
    updates = [];
    removed = [];
    registry.on('updated', (d) => updates.push(d));
    registry.on('removed', (id) => removed.push(id));
  });

  it('legt neue Geräte an und meldet sie', () => {
    const device = registry.upsert({ mac: MAC_A, name: 'Keller', ip: '10.0.0.5', mqttTopic: 'keller' });
    expect(device).toMatchObject({ id: MAC_A, name: 'Keller', ip: '10.0.0.5', online: false, channels: [], tags: [] });
    expect(updates).toHaveLength(1);
  });

  it('überschreibt bekannte Felder nicht mit undefined', () => {
    registry.upsert({ mac: MAC_A, name: 'Keller', firmware: '14.2.0', module: 'Sonoff Basic' });
    const device = registry.upsert({ mac: MAC_A, firmware: '14.3.0' });
    expect(device).toMatchObject({ name: 'Keller', firmware: '14.3.0', module: 'Sonoff Basic' });
  });

  it('entfernt eine per DHCP neu vergebene IP beim früheren Gerät', () => {
    registry.upsert({ mac: MAC_A, name: 'A', ip: '10.0.0.5' });
    registry.upsert({ mac: MAC_B, name: 'B', ip: '10.0.0.5' });
    expect(registry.get(MAC_A)?.ip).toBeNull();
    expect(registry.get(MAC_B)?.ip).toBe('10.0.0.5');
    expect(registry.list()).toHaveLength(2);
  });

  it('verwaltet Kanäle und Online-Status', () => {
    registry.upsert({ mac: MAC_A, name: 'A' }, { channel: 'mqtt' });
    registry.markReachable(MAC_A, 'http');
    expect(registry.get(MAC_A)).toMatchObject({ online: true, channels: ['http', 'mqtt'], lastSeen: '2026-09-29T12:00:00.000Z' });
    registry.markUnreachable(MAC_A, 'mqtt');
    expect(registry.get(MAC_A)).toMatchObject({ online: true, channels: ['http'] });
    registry.markUnreachable(MAC_A, 'http');
    expect(registry.get(MAC_A)).toMatchObject({ online: false, channels: [] });
  });

  it('ersetzt Passwort-Platzhalter und übernimmt deren Passwort', () => {
    const placeholder = registry.upsertAuthPlaceholder('10.0.0.9');
    expect(placeholder).toMatchObject({ id: placeholderId('10.0.0.9'), authRequired: true, online: true });
    registry.setPasswordOverride(placeholder.id, 'geheim');
    registry.upsert({ mac: MAC_A, name: 'Echt', ip: '10.0.0.9' }, { channel: 'http' });
    expect(registry.get(placeholder.id)).toBeNull();
    expect(removed).toEqual([placeholder.id]);
    expect(registry.getPasswordOverride(MAC_A)).toBe('geheim');
    expect(registry.get(MAC_A)?.authRequired).toBe(false);
  });

  it('markiert ein bekanntes Gerät statt einen Platzhalter anzulegen', () => {
    registry.upsert({ mac: MAC_A, name: 'A', ip: '10.0.0.9' });
    const device = registry.upsertAuthPlaceholder('10.0.0.9');
    expect(device.id).toBe(MAC_A);
    expect(device.authRequired).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });

  it('verwaltet Tags', () => {
    registry.upsert({ mac: MAC_A, name: 'A' });
    registry.upsert({ mac: MAC_B, name: 'B' });
    registry.setTags(MAC_A, ['Licht', 'Keller', 'Licht']);
    registry.setTags(MAC_B, ['Keller']);
    expect(registry.get(MAC_A)?.tags).toEqual(['Keller', 'Licht']);
    registry.setTags(MAC_A, []);
    expect(registry.get(MAC_A)?.tags).toEqual([]);
    expect(registry.get(MAC_B)?.tags).toEqual(['Keller']);
  });

  it('gibt Passwörter nie im Geräteobjekt heraus', () => {
    registry.upsert({ mac: MAC_A, name: 'A' });
    const device = registry.setPasswordOverride(MAC_A, 'geheim');
    expect(device.hasPasswordOverride).toBe(true);
    expect(JSON.stringify(registry.list())).not.toContain('geheim');
  });

  it('findet Geräte über Topic und IP, zählt HTTP-Fehler', () => {
    registry.upsert({ mac: MAC_A, name: 'A', mqttTopic: 'keller', ip: '10.0.0.5' });
    expect(registry.findByTopic('keller')?.id).toBe(MAC_A);
    expect(registry.findByIp('10.0.0.5')?.id).toBe(MAC_A);
    expect(registry.recordHttpFailure(MAC_A)).toBe(1);
    expect(registry.recordHttpFailure(MAC_A)).toBe(2);
    registry.markReachable(MAC_A, 'http');
    expect(registry.recordHttpFailure(MAC_A)).toBe(1);
  });

  it('entfernt Geräte', () => {
    registry.upsert({ mac: MAC_A, name: 'A' });
    expect(registry.remove(MAC_A)).toBe(true);
    expect(registry.remove(MAC_A)).toBe(false);
    expect(removed).toEqual([MAC_A]);
  });

  it('updateRuntime aktualisiert rssi/uptimeSec und lastSeen, ignoriert undefined', () => {
    registry.upsert({ mac: MAC_A, name: 'A', rssi: -60, uptimeSec: 1000 });
    const updated = registry.updateRuntime(MAC_A, { rssi: -50, uptimeSec: 2000 });
    expect(updated).toMatchObject({ rssi: -50, uptimeSec: 2000, lastSeen: '2026-09-29T12:00:00.000Z' });
    const partial = registry.updateRuntime(MAC_A, { rssi: -40 });
    expect(partial).toMatchObject({ rssi: -40, uptimeSec: 2000 });
    expect(registry.updateRuntime('NOPE', { rssi: -30 })).toBeNull();
  });

  it('setAuthRequired setzt und löscht authRequired', () => {
    registry.upsert({ mac: MAC_A, name: 'A' });
    let device = registry.setAuthRequired(MAC_A, true);
    expect(device.authRequired).toBe(true);
    device = registry.setAuthRequired(MAC_A, false);
    expect(device.authRequired).toBe(false);
  });

  it('getStatus gibt statusJson zurück', () => {
    registry.upsert({ mac: MAC_A, name: 'A' }, { statusJson: { test: 'value' } });
    expect(registry.getStatus(MAC_A)).toEqual({ test: 'value' });
    registry.upsert({ mac: MAC_B, name: 'B' });
    expect(registry.getStatus(MAC_B)).toBeNull();
    expect(registry.getStatus('NOPE')).toBeNull();
  });

  it('markUnreachable gibt null für unbekannte ID zurück', () => {
    expect(registry.markUnreachable('NOPE', 'mqtt')).toBeNull();
  });

  it('upsert meldet verdrängte Geräte mit ip null', () => {
    registry.upsert({ mac: MAC_A, name: 'A', ip: '10.0.0.5' });
    updates.length = 0;
    registry.upsert({ mac: MAC_B, name: 'B', ip: '10.0.0.5' });
    const displaced = updates.find((d) => d.id === MAC_A);
    expect(displaced).toBeDefined();
    expect(displaced?.ip).toBeNull();
  });

  it('Mutator auf unbekannte ID wirft Fehler', () => {
    expect(() => registry.setAuthRequired('NOPE', true)).toThrow(/Unbekanntes Gerät/);
    expect(() => registry.recordHttpFailure('NOPE')).toThrow(/Unbekanntes Gerät/);
    expect(() => registry.setPasswordOverride('NOPE', 'pwd')).toThrow(/Unbekanntes Gerät/);
    expect(() => registry.setTags('NOPE', ['tag'])).toThrow(/Unbekanntes Gerät/);
    expect(() => registry.markReachable('NOPE', 'http')).toThrow(/Unbekanntes Gerät/);
  });
});
