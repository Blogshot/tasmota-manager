import type { Device } from '@tm/shared';

export type StatusFilter = 'all' | 'online' | 'offline' | 'auth' | 'stale';

export function filterDevices(devices: Device[], filter: { text: string; status: StatusFilter; tag: string }): Device[] {
  const query = filter.text.trim().toLowerCase();
  return devices.filter((d) => {
    if (filter.status === 'online' && !d.online) return false;
    if (filter.status === 'offline' && d.online) return false;
    if (filter.status === 'auth' && !d.authRequired) return false;
    if (filter.status === 'stale' && !d.stale) return false;
    if (filter.tag && !d.tags.includes(filter.tag)) return false;
    if (!query) return true;
    return [d.name, d.ip, d.hostname, d.mqttTopic, d.firmware, d.module, d.id].some((v) => v?.toLowerCase().includes(query));
  });
}
