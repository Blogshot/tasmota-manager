import { isRejected, splitCommand } from '../tasmota/commands';
import { isObj, safeJson } from '../tasmota/parse';
import { TransportError } from './errors';

export interface HttpTarget {
  host: string;
  password: string | null;
}

export interface HttpSender {
  send(target: HttpTarget, command: string, timeoutMs?: number): Promise<unknown>;
}

export class HttpTransport implements HttpSender {
  constructor(private readonly defaultTimeoutMs = 10_000) {}

  async send(target: HttpTarget, command: string, timeoutMs = this.defaultTimeoutMs): Promise<unknown> {
    const auth = target.password ? `user=admin&password=${encodeURIComponent(target.password)}&` : '';
    const url = `http://${target.host}/cm?${auth}cmnd=${encodeURIComponent(command)}`;

    let res: Response;
    let body: string;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      body = await res.text();
    } catch (err) {
      // Die URL enthält ggf. das Passwort und darf nie in Fehlermeldungen landen.
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new TransportError('timeout', `Keine HTTP-Antwort von ${target.host} innerhalb von ${timeoutMs} ms`);
      }
      throw new TransportError('unreachable', `HTTP-Verbindung zu ${target.host} fehlgeschlagen`);
    }

    const json = safeJson(body);
    if (res.status === 401) {
      if (isObj(json) && typeof json.WARNING === 'string') {
        throw new TransportError('auth', `${target.host} verlangt ein gültiges Web-Passwort`);
      }
      throw new TransportError('unreachable', `${target.host} ist kein Tasmota-Gerät`);
    }
    if (!res.ok || json === undefined) {
      throw new TransportError('unreachable', `Unerwartete Antwort (HTTP ${res.status}) von ${target.host}`);
    }
    if (isRejected(json)) {
      throw new TransportError('rejected', `Gerät lehnt den Befehl "${splitCommand(command).name}" ab`);
    }
    return json;
  }
}
