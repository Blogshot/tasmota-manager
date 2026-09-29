import type { Device } from '@tm/shared';
import type { DeviceRegistry } from '../registry';
import { parseModule, parseStatus0 } from '../tasmota/parse';
import { TransportError } from '../transport/errors';
import type { HttpSender } from '../transport/http';

/** Fragt `Status 0` per HTTP ab und trägt das Gerät ins Inventar ein. Wirft TransportError. */
export async function identifyHost(
  http: HttpSender,
  registry: DeviceRegistry,
  host: string,
  password: string | null,
  timeoutMs?: number,
): Promise<Device> {
  const payload = await http.send({ host, password }, 'Status 0', timeoutMs);
  const info = parseStatus0(payload);
  if (!info) throw new TransportError('rejected', `${host} liefert keinen Tasmota-Status`);
  // Erreichbar ist das Gerät unter der Adresse, über die wir es gefunden haben (inkl. Port).
  info.ip = host;
  if (!registry.get(info.mac)?.module) {
    try {
      info.module = parseModule(await http.send({ host, password }, 'Module', timeoutMs)) ?? undefined;
    } catch {
      // Modulname ist optional.
    }
  }
  return registry.upsert(info, { channel: 'http', statusJson: payload });
}
