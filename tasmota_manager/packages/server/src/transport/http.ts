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

// Die Verbindung kam nie zustande: abgelehnt, Host oder Netz nicht erreichbar, Name nicht auflösbar, Verbindungsaufbau abgelaufen.
const NEVER_CONNECTED = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const errorCode = (err: unknown): unknown => (typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined);

/** fetch meldet „fetch failed" und nennt den Grund in `cause`; bei mehreren Adressen ist das ein AggregateError. */
function neverConnected(err: unknown): boolean {
  const cause = err instanceof Error ? err.cause : undefined;
  const causes = cause instanceof AggregateError ? cause.errors : [cause];
  return causes.length > 0 && causes.every((c) => NEVER_CONNECTED.has(String(errorCode(c))));
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
      // Bricht die Verbindung erst nach dem Senden ab, kann das Gerät den Befehl schon ausgeführt haben.
      throw new TransportError('unreachable', `HTTP-Verbindung zu ${target.host} fehlgeschlagen`, !neverConnected(err));
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
