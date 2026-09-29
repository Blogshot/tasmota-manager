import { describe, expect, it } from 'vitest';
import {
  normalizeMac,
  parseDiscoveryConfig,
  parseModule,
  parseState,
  parseStatus0,
  parseVersion,
  safeJson,
} from './parse';

const STATUS0 = {
  Status: { Module: 1, DeviceName: 'Keller', FriendlyName: ['Keller-Licht'], Topic: 'keller', Power: '0' },
  StatusFWR: { Version: '14.2.0(release-tasmota)', Hardware: 'ESP8266EX' },
  StatusNET: { Hostname: 'keller-1234', IPAddress: '192.168.1.23', Mac: 'aa:bb:cc:11:22:33' },
  StatusMEM: { FlashSize: 4096 },
  StatusSTS: { UptimeSec: 3600, Wifi: { RSSI: 80, Signal: -61 } },
};

describe('normalizeMac', () => {
  it('entfernt Trennzeichen und setzt Großbuchstaben', () => {
    expect(normalizeMac('aa:bb:cc:11:22:33')).toBe('AABBCC112233');
    expect(normalizeMac('AABBCC112233')).toBe('AABBCC112233');
  });
  it('lehnt falsche Längen und Nicht-Strings ab', () => {
    expect(normalizeMac('aa:bb')).toBeNull();
    expect(normalizeMac(42)).toBeNull();
  });
});

describe('parseVersion', () => {
  it('trennt Version und Variante', () => {
    expect(parseVersion('14.2.0(release-tasmota32)')).toEqual({ firmware: '14.2.0', variant: 'tasmota32' });
    expect(parseVersion('14.2.0.1(tasmota)')).toEqual({ firmware: '14.2.0.1', variant: 'tasmota' });
    expect(parseVersion('14.2.0')).toEqual({ firmware: '14.2.0', variant: undefined });
  });
});

describe('parseStatus0', () => {
  it('liest alle relevanten Felder', () => {
    expect(parseStatus0(STATUS0)).toEqual({
      mac: 'AABBCC112233',
      name: 'Keller-Licht',
      hostname: 'keller-1234',
      ip: '192.168.1.23',
      mqttTopic: 'keller',
      chip: 'ESP8266EX',
      flashSize: 4096,
      rssi: -61,
      uptimeSec: 3600,
      firmware: '14.2.0',
      variant: 'tasmota',
    });
  });
  it('nutzt DeviceName nur, wenn kein FriendlyName gesetzt ist', () => {
    expect(parseStatus0({ ...STATUS0, Status: { ...STATUS0.Status, FriendlyName: [] } })?.name).toBe('Keller');
  });
  it('bevorzugt die Ethernet-IP von ESP32-Geräten', () => {
    const net = { ...STATUS0.StatusNET, IPAddress: '0.0.0.0', Ethernet: { IPAddress: '192.168.1.50' } };
    expect(parseStatus0({ ...STATUS0, StatusNET: net })?.ip).toBe('192.168.1.50');
  });
  it('verwirft ungültige oder leere IP-Adressen', () => {
    expect(parseStatus0({ ...STATUS0, StatusNET: { ...STATUS0.StatusNET, IPAddress: '0.0.0.0' } })?.ip).toBeUndefined();
    expect(parseStatus0({ ...STATUS0, StatusNET: { ...STATUS0.StatusNET, IPAddress: 'host/path?' } })?.ip).toBeUndefined();
  });
  it('liefert null ohne MAC (kein Tasmota)', () => {
    expect(parseStatus0({ hello: 'world' })).toBeNull();
    expect(parseStatus0('<html>')).toBeNull();
  });
});

describe('parseDiscoveryConfig', () => {
  it('liest die Discovery-Nachricht', () => {
    const info = parseDiscoveryConfig({
      ip: '192.168.1.23',
      dn: 'Keller',
      fn: ['Keller-Licht', null],
      hn: 'keller-1234',
      mac: 'AABBCC112233',
      md: 'Sonoff Basic',
      sw: '14.2.0',
      t: 'keller',
      ft: '%prefix%/%topic%/',
    });
    expect(info).toEqual({
      mac: 'AABBCC112233',
      name: 'Keller-Licht',
      hostname: 'keller-1234',
      ip: '192.168.1.23',
      mqttTopic: 'keller',
      fullTopic: '%prefix%/%topic%/',
      module: 'Sonoff Basic',
      firmware: '14.2.0',
      variant: undefined,
    });
  });
  it('verwirft IP-Adressen, die keine gültige IPv4 sind', () => {
    const base = { mac: 'AABBCC112233', t: 'keller' };
    expect(parseDiscoveryConfig({ ...base, ip: 'attacker.example' })?.ip).toBeUndefined();
    expect(parseDiscoveryConfig({ ...base, ip: '0.0.0.0' })?.ip).toBeUndefined();
    expect(parseDiscoveryConfig({ ...base, ip: '192.168.1.256' })?.ip).toBeUndefined();
  });
  it('liefert null ohne MAC oder Topic', () => {
    expect(parseDiscoveryConfig({ mac: 'AABBCC112233' })).toBeNull();
  });
});

describe('parseState / parseModule / safeJson', () => {
  it('liest Laufzeitwerte aus STATE', () => {
    expect(parseState({ UptimeSec: 200, Wifi: { Signal: -55 } })).toEqual({ rssi: -55, uptimeSec: 200 });
  });
  it('liest den Modulnamen', () => {
    expect(parseModule({ Module: { '1': 'Sonoff Basic' } })).toBe('Sonoff Basic');
    expect(parseModule({ Module: 'x' })).toBeNull();
  });
  it('gibt bei ungültigem JSON undefined zurück', () => {
    expect(safeJson('{"a":1}')).toEqual({ a: 1 });
    expect(safeJson('Online')).toBeUndefined();
  });
});
