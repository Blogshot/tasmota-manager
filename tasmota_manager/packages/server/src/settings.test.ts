import { describe, expect, it } from 'vitest';
import { testDb } from '../test/helpers';
import { SettingsStore, defaultSettings } from './settings';

describe('SettingsStore', () => {
  it('liefert Standardwerte', () => {
    const store = new SettingsStore(testDb(), defaultSettings(['192.168.1.0/24']));
    expect(store.get()).toMatchObject({ scanCidrs: ['192.168.1.0/24'], pollIntervalSec: 60, globalPassword: null });
    expect(store.get().concurrency).toEqual({ command: 10, ota: 3, backup: 5 });
  });

  it('speichert Änderungen dauerhaft', () => {
    const db = testDb();
    new SettingsStore(db, defaultSettings([])).update({ pollIntervalSec: 30, scanCidrs: ['10.0.0.0/24'] });
    const reloaded = new SettingsStore(db, defaultSettings([]));
    expect(reloaded.get().pollIntervalSec).toBe(30);
    expect(reloaded.get().scanCidrs).toEqual(['10.0.0.0/24']);
  });

  it('gibt das globale Passwort nie öffentlich heraus', () => {
    const store = new SettingsStore(testDb(), defaultSettings([]));
    store.update({ globalPassword: 'geheim' });
    const pub = store.toPublic();
    expect(pub.hasGlobalPassword).toBe(true);
    expect(JSON.stringify(pub)).not.toContain('geheim');
  });

  it('behandelt ein leeres Passwort wie keines', () => {
    const store = new SettingsStore(testDb(), defaultSettings([]));
    store.update({ globalPassword: 'x' });
    store.update({ globalPassword: '' });
    expect(store.get().globalPassword).toBeNull();
    expect(store.toPublic().hasGlobalPassword).toBe(false);
  });
});
