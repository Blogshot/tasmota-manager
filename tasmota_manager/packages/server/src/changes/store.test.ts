import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from '../../test/helpers';
import { DeviceRegistry } from '../registry';
import { MASK, PendingStore, StageError } from './store';

const A = 'AABBCC000001';
const B = 'AABBCC000002';
const STATUS = {
  Status: { DeviceName: 'Keller', FriendlyName: ['Keller'], PowerOnState: 3, LedState: 1 },
  StatusMQT: { MqttHost: 'broker', MqttPort: 1883, MqttUser: 'DVES_USER' },
};

describe('PendingStore', () => {
  let registry: DeviceRegistry;
  let store: PendingStore;
  let events: number[];

  beforeEach(() => {
    const db = testDb();
    registry = new DeviceRegistry(db);
    registry.upsert({ mac: A, name: 'Keller', hostname: 'keller-1', mqttTopic: 'keller', ip: '10.0.0.5' }, { statusJson: STATUS });
    registry.upsert({ mac: B, name: 'Bad' }, { statusJson: STATUS });
    store = new PendingStore(db, registry);
    events = [];
    store.on('changed', (n) => events.push(n));
  });

  it('merkt Einstellungen für mehrere Geräte vor und zeigt Vorher/Nachher', () => {
    expect(store.stage({ deviceIds: [A, B], settings: { PowerOnState: '1', Latitude: '48.1' }, source: 'form' })).toEqual({
      staged: 4,
      skipped: 0,
    });
    const [bad, keller] = store.list();
    expect(bad?.deviceName).toBe('Bad');
    expect(keller?.changes.map((c) => [c.key, c.before, c.value])).toEqual([
      ['PowerOnState', '3', '1'],
      ['Latitude', null, '48.1'],
    ]);
    expect(events).toEqual([4]);
  });

  it('überschreibt bei erneutem Vormerken (letzter Wert gilt)', () => {
    store.stage({ deviceIds: [A], settings: { LedState: '2' }, source: 'form' });
    store.stage({ deviceIds: [A], settings: { LedState: '5' }, source: 'detail' });
    const changes = store.list()[0]?.changes ?? [];
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ key: 'LedState', value: '5', source: 'detail' });
  });

  it('löst nur unveränderte Werte auf (resolveUnchanged)', () => {
    store.stage({ deviceIds: [A], settings: { LedState: '2' }, source: 'form' });
    const id = store.forDevice(A)[0]?.id ?? -1;
    store.stage({ deviceIds: [A], settings: { LedState: '5' }, source: 'form' });
    store.resolveUnchanged([{ id, value: '2' }]);
    expect(store.forDevice(A).map((r) => [r.id, r.value])).toEqual([[id, '5']]);
    store.resolveUnchanged([{ id, value: '5' }]);
    expect(store.count()).toBe(0);
  });

  it('verwirft Werte gleich dem aktuellen Gerätewert und entfernt dafür bestehende Einträge', () => {
    store.stage({ deviceIds: [A], settings: { PowerOnState: '1' }, source: 'form' });
    expect(store.stage({ deviceIds: [A], settings: { PowerOnState: '3' }, source: 'form' })).toEqual({ staged: 0, skipped: 1 });
    expect(store.count()).toBe(0);
  });

  it('ist atomar: ein ungültiger Wert verhindert das ganze Vormerken', () => {
    expect(() => store.stage({ deviceIds: [A], settings: { LedState: '2', PowerOnState: '9' }, source: 'form' })).toThrow(StageError);
    expect(() => store.stage({ deviceIds: [A], settings: { Unbekannt: '1' }, source: 'form' })).toThrow(/Unbekannte Einstellung/);
    expect(() => store.stage({ deviceIds: ['GIBTSNICHT'], settings: { LedState: '2' }, source: 'form' })).toThrow(/Unbekanntes Gerät/);
    expect(() => store.stage({ deviceIds: [A], settings: { MqttHost: 'x;Reset 1' }, source: 'form' })).toThrow(StageError);
    expect(store.count()).toBe(0);
  });

  it('gibt das MQTT-Passwort nie aus', () => {
    store.stage({ deviceIds: [A], settings: { MqttPassword: 'geheim' }, source: 'form' });
    const change = store.list()[0]?.changes[0];
    expect(change).toMatchObject({ key: 'MqttPassword', value: MASK, before: null });
    expect(JSON.stringify(store.list())).not.toContain('geheim');
    expect(store.forDevice(A)[0]?.value).toBe('geheim');
  });

  it('maskiert Passwörter in freien Befehlen, auch im Backlog und unabhängig von der Schreibweise', () => {
    const commands = [
      'WebPassword geheim1',
      'mqttpassword geheim2',
      'Backlog Password1 geheim3; Power ON;PASSWORD2 geheim4',
      'Password geheim5',
      'backlog0 SSId1 netz; webpassword geheim6',
      'Power ON',
      'WebPassword',
    ];
    store.stage({ deviceIds: [A], commands, source: 'command' });
    expect(store.list()[0]?.changes.map((c) => c.value)).toEqual([
      `WebPassword ${MASK}`,
      `mqttpassword ${MASK}`,
      `Backlog Password1 ${MASK}; Power ON; PASSWORD2 ${MASK}`,
      `Password ${MASK}`,
      `backlog0 SSId1 netz; webpassword ${MASK}`,
      'Power ON',
      'WebPassword',
    ]);
    expect(JSON.stringify(store.list())).not.toContain('geheim');
    // Gespeichert und gesendet wird der echte Wert.
    expect(store.forDevice(A).map((r) => r.value)).toEqual(commands);
  });

  it('rendert Platzhalter in Befehlen und hängt sie in Reihenfolge an', () => {
    store.stage({ deviceIds: [A], commands: ['FriendlyName1 {{name}}-{{mac6}}', 'Power ON'], source: 'command' });
    store.stage({ deviceIds: [A], commands: ['Restart 1'], source: 'command' });
    expect(store.forDevice(A).map((r) => r.value)).toEqual(['FriendlyName1 Keller-000001', 'Power ON', 'Restart 1']);
    expect(() => store.stage({ deviceIds: [A], commands: ['X {{foo}}'], source: 'command' })).toThrow(/Platzhalter/);
  });

  it('sortiert Einstellungen nach Katalog-Reihenfolge vor Befehlen', () => {
    store.stage({ deviceIds: [A], commands: ['Power ON'], source: 'command' });
    store.stage({ deviceIds: [A], settings: { TelePeriod: '60', PowerOnState: '1' }, source: 'form' });
    expect(store.list()[0]?.changes.map((c) => c.key ?? c.value)).toEqual(['PowerOnState', 'TelePeriod', 'Power ON']);
  });

  it('fasst Zeilenumbrüche in Rules zusammen', () => {
    store.stage({ deviceIds: [A], settings: { Rule1: 'ON Power1#State DO\n  Publish x\nENDON' }, source: 'rule' });
    expect(store.forDevice(A)[0]?.value).toBe('ON Power1#State DO Publish x ENDON');
  });

  it('verwirft, löst auf und vermerkt Fehler', () => {
    store.stage({ deviceIds: [A, B], settings: { LedState: '2', TelePeriod: '60' }, source: 'form' });
    const [first, second] = store.forDevice(A);
    expect(store.counts().get(A)).toBe(2);
    store.fail([first?.id ?? 0], 'offline: weg');
    expect(store.forDevice(A)[0]?.error).toBe('offline: weg');
    store.clearErrors([A]);
    expect(store.forDevice(A)[0]?.error).toBeNull();
    store.resolve([second?.id ?? 0]);
    expect(store.forDevice(A)).toHaveLength(1);
    expect(store.discard(first?.id ?? 0)).toBe(true);
    expect(store.discard(first?.id ?? 0)).toBe(false);
    expect(store.deviceIdsWithChanges()).toEqual([B]);
    expect(store.discardDevice(B)).toBe(2);
    store.stage({ deviceIds: [A], settings: { LedState: '2' }, source: 'form' });
    expect(store.discardAll()).toBe(1);
    expect(store.count()).toBe(0);
  });

  it('liefert vorgemerkte Namen', () => {
    store.stage({ deviceIds: [A], settings: { DeviceName: 'Klima Bad', FriendlyName1: 'Klima Bad' }, source: 'suggestion' });
    expect(store.pendingNames().get(A)).toBe('Klima Bad');
  });
});
