import { describe, expect, it, vi } from 'vitest';
import { buildHaSuggestions, haSuggestionsFrom } from './haSuggestions';

const base = { timeZone: null, country: null, fahrenheit: null, mqttOnHa: false, mqttPort: null, hostIp: null, deviceMqttUsers: [] };

describe('buildHaSuggestions', () => {
  it('liefert ohne Quellen nur den allgemeinen NTP-Server', () => {
    expect(buildHaSuggestions(base)).toEqual({ timezone: null, ntpServer: 'pool.ntp.org', mqtt: null, mqttUser: null, fahrenheit: null });
  });
  it('nutzt Zeitzone, Land und Einheit aus HA', () => {
    const s = buildHaSuggestions({ ...base, timeZone: 'Europe/Berlin', country: 'DE', fahrenheit: false });
    expect(s.timezone).toMatchObject({ zone: 'Europe/Berlin', timezone: '99' });
    expect(s.ntpServer).toBe('de.pool.ntp.org');
    expect(s.fahrenheit).toBe(false);
  });
  it('schlägt den Broker nur vor, wenn er auf HA läuft und die Adresse bekannt ist', () => {
    expect(buildHaSuggestions({ ...base, mqttOnHa: true, mqttPort: 1883, hostIp: '192.168.1.5' }).mqtt).toEqual({ host: '192.168.1.5', port: 1883 });
    expect(buildHaSuggestions({ ...base, mqttOnHa: false, mqttPort: 1883, hostIp: '192.168.1.5' }).mqtt).toBeNull();
    expect(buildHaSuggestions({ ...base, mqttOnHa: true, mqttPort: 1883, hostIp: null }).mqtt).toBeNull();
  });
  it('schlägt den häufigsten MQTT-Benutzer der Geräte vor, ab zwei Geräten', () => {
    expect(buildHaSuggestions({ ...base, deviceMqttUsers: ['tasmota', 'tasmota', 'DVES_USER'] }).mqttUser).toBe('tasmota');
    expect(buildHaSuggestions({ ...base, deviceMqttUsers: ['tasmota'] }).mqttUser).toBeNull();
  });
});

describe('buildHaSuggestions: MQTT-Vorschläge', () => {
  it('schlägt weder die Firmware-Vorgabe noch den Benutzer des MQTT-Dienstes als Benutzer vor', () => {
    expect(buildHaSuggestions({ ...base, deviceMqttUsers: ['DVES_USER', 'DVES_USER', 'DVES_USER'] }).mqttUser).toBeNull();
    const users = ['svc-user', 'svc-user', 'tasmota', 'tasmota'];
    expect(buildHaSuggestions({ ...base, deviceMqttUsers: users, mqttServiceUser: 'svc-user' }).mqttUser).toBe('tasmota');
    expect(buildHaSuggestions({ ...base, deviceMqttUsers: ['svc-user', 'svc-user'], mqttServiceUser: 'svc-user' }).mqttUser).toBeNull();
  });

  it('schlägt bei TLS keinen Broker vor', () => {
    const input = { ...base, mqttOnHa: true, mqttPort: 8883, hostIp: '192.168.1.5' };
    expect(buildHaSuggestions({ ...input, mqttTls: true }).mqtt).toBeNull();
    expect(buildHaSuggestions({ ...input, mqttTls: false }).mqtt).toEqual({ host: '192.168.1.5', port: 8883 });
  });
});

describe('haSuggestionsFrom', () => {
  const registry = { listRaw: () => [] };
  const service = { url: 'mqtt://core-mosquitto:1883', username: 'svc-user', password: 'svc-secret', onHa: true };

  it('verrät keine Zugangsdaten des MQTT-Dienstes', () => {
    const log = { warn: vi.fn() };
    const out = haSuggestionsFrom({ ha: null, mqtt: service, registry, hostIp: '192.168.1.5', log })();
    expect(out.mqtt).toEqual({ host: '192.168.1.5', port: 1883 });
    expect(JSON.stringify(out)).not.toMatch(/svc-user|svc-secret/);
  });

  it('macht bei einem mqtts-Dienst keinen Broker-Vorschlag', () => {
    const tls = { ...service, url: 'mqtts://core-mosquitto:8883' };
    expect(haSuggestionsFrom({ ha: null, mqtt: tls, registry, hostIp: '192.168.1.5', log: { warn: vi.fn() } })().mqtt).toBeNull();
  });

  it('warnt je nicht umrechenbarer Zone nur einmal', () => {
    const log = { warn: vi.fn() };
    const suggest = haSuggestionsFrom({ ha: { config: { timeZone: 'Mars/Olympus', country: null, fahrenheit: null } }, mqtt: null, registry, hostIp: null, log });
    expect(suggest().timezone).toBeNull();
    suggest();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toEqual({ zone: 'Mars/Olympus' });
    const ok = { warn: vi.fn() };
    haSuggestionsFrom({ ha: { config: { timeZone: 'Europe/Berlin', country: null, fahrenheit: null } }, mqtt: null, registry, hostIp: null, log: ok })();
    expect(ok.warn).not.toHaveBeenCalled();
  });
});
