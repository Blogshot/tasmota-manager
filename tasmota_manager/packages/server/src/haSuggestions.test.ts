import { describe, expect, it } from 'vitest';
import { buildHaSuggestions } from './haSuggestions';

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
