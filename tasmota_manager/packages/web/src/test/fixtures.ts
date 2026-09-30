import type { Device } from '@tm/shared';

export function makeDevice(partial: Partial<Device> = {}): Device {
  return {
    id: 'AABBCC112233',
    name: 'Keller-Licht',
    hostname: 'keller-1234',
    ip: '192.168.1.23',
    mqttTopic: 'keller',
    fullTopic: '%prefix%/%topic%/',
    module: 'Sonoff Basic',
    firmware: '14.2.0',
    variant: 'tasmota',
    chip: 'ESP8266EX',
    flashSize: 4096,
    rssi: -61,
    uptimeSec: 3600,
    online: true,
    authRequired: false,
    channels: ['mqtt'],
    lastSeen: '2026-09-29T12:00:00.000Z',
    hasPasswordOverride: false,
    tags: [],
    setOption4: false,
    power: [],
    ha: null,
    nameSuggestion: null,
    pendingCount: 0,
    pendingName: null,
    ...partial,
  };
}
