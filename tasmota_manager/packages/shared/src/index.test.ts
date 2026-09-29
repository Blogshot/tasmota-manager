import { describe, expect, it } from 'vitest';
import {
  AddDeviceRequestSchema,
  CidrSchema,
  DeviceUpdateRequestSchema,
  SettingsUpdateRequestSchema,
  intToIp,
  parseCidr,
} from './index';

describe('parseCidr', () => {
  it('normalisiert die Basisadresse auf das Netz', () => {
    const parsed = parseCidr('192.168.1.77/24');
    expect(parsed?.prefix).toBe(24);
    expect(intToIp(parsed!.base)).toBe('192.168.1.0');
  });

  it('akzeptiert /32 und /0', () => {
    expect(intToIp(parseCidr('10.1.2.3/32')!.base)).toBe('10.1.2.3');
    expect(intToIp(parseCidr('10.1.2.3/0')!.base)).toBe('0.0.0.0');
  });

  it('lehnt ungültige Eingaben ab', () => {
    expect(parseCidr('300.1.1.1/24')).toBeNull();
    expect(parseCidr('1.2.3.4')).toBeNull();
    expect(parseCidr('1.2.3.4/33')).toBeNull();
    expect(parseCidr('abc')).toBeNull();
  });
});

describe('CidrSchema', () => {
  it('erlaubt höchstens 4096 Adressen', () => {
    expect(CidrSchema.safeParse('10.0.0.0/20').success).toBe(true);
    expect(CidrSchema.safeParse('10.0.0.0/19').success).toBe(false);
    expect(CidrSchema.safeParse('10.0.0.0/8').success).toBe(false);
  });
});

describe('Request-Schemas', () => {
  it('prüft IPv4-Adressen beim manuellen Hinzufügen', () => {
    expect(AddDeviceRequestSchema.safeParse({ ip: '192.168.1.5' }).success).toBe(true);
    expect(AddDeviceRequestSchema.safeParse({ ip: '192.168.1.500' }).success).toBe(false);
  });

  it('erlaubt Teil-Updates der Einstellungen und null als Passwort', () => {
    expect(SettingsUpdateRequestSchema.safeParse({ pollIntervalSec: 30 }).success).toBe(true);
    expect(SettingsUpdateRequestSchema.safeParse({ globalPassword: null }).success).toBe(true);
    expect(SettingsUpdateRequestSchema.safeParse({ pollIntervalSec: 5 }).success).toBe(false);
  });

  it('trimmt Tags und lehnt leere ab', () => {
    expect(DeviceUpdateRequestSchema.parse({ tags: [' Keller '] }).tags).toEqual(['Keller']);
    expect(DeviceUpdateRequestSchema.safeParse({ tags: ['  '] }).success).toBe(false);
  });
});
