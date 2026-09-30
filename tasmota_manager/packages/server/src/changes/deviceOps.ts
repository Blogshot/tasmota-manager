import type { DeviceGateway, SendResult } from '../gateway';
import { isObj } from '../tasmota/parse';
import { TransportError } from '../transport/errors';

export interface DeviceOpsOptions {
  restartTimeoutMs?: number;
  pollIntervalMs?: number;
  commandTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MAX_BACKOFF_MS = 10_000;
const RESTART_POLL_TIMEOUT_MS = 3000;
const TRANSIENT = new Set<string>(['unreachable', 'offline', 'timeout']);

export class DeviceOps {
  readonly restartTimeoutMs: number;
  private readonly pollMs: number;
  private readonly commandTimeoutMs: number;

  constructor(
    private readonly gateway: Pick<DeviceGateway, 'send'>,
    opts: DeviceOpsOptions = {},
  ) {
    this.restartTimeoutMs = opts.restartTimeoutMs ?? 90_000;
    this.pollMs = opts.pollIntervalMs ?? 2000;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 10_000;
  }

  async uptime(deviceId: string, timeoutMs = this.commandTimeoutMs): Promise<number> {
    const { response } = await this.gateway.send(deviceId, 'Status 11', timeoutMs);
    const sts = isObj(response) && isObj(response.StatusSTS) ? response.StatusSTS : null;
    const uptime = sts ? Number(sts.UptimeSec) : Number.NaN;
    if (!Number.isFinite(uptime)) throw new TransportError('rejected', 'Status 11 contains no UptimeSec');
    return uptime;
  }

  /**
   * Ein Neustart gilt als erfolgt, wenn die Laufzeit kleiner ist als vorher – oder wenn das Gerät
   * zwischendurch nicht erreichbar war und wieder antwortet (nötig, wenn es kurz zuvor schon neu gestartet hat
   * und die Laufzeit deshalb nicht kleiner werden kann). Der Online-Status allein reicht nicht.
   */
  async waitForRestart(deviceId: string, uptimeBefore: number): Promise<void> {
    const deadline = Date.now() + this.restartTimeoutMs;
    let sawDown = false;
    while (Date.now() < deadline) {
      await sleep(this.pollMs);
      try {
        const uptime = await this.uptime(deviceId, Math.min(this.commandTimeoutMs, RESTART_POLL_TIMEOUT_MS));
        if (uptime < uptimeBefore || sawDown) return;
      } catch (err) {
        // Nur vorübergehende Transportfehler bedeuten „startet noch neu"; alles andere ist ein echter Fehler.
        if (!(err instanceof TransportError) || !TRANSIENT.has(err.code)) throw err;
        sawDown = true;
      }
    }
    throw new TransportError(
      'offline',
      `Device did not come back within ${Math.round(this.restartTimeoutMs / 1000)} s after the restart`,
    );
  }

  /**
   * Sendet mit Wiederholungen, solange das Gerät vorübergehend nicht antwortet. Nicht idempotente Befehle werden nur
   * wiederholt, wenn der Fehler sicher ausschließt, dass das Gerät sie schon ausgeführt hat.
   */
  async send(deviceId: string, command: string, idempotent: boolean): Promise<SendResult> {
    const deadline = Date.now() + this.restartTimeoutMs;
    let delay = this.pollMs;
    for (;;) {
      try {
        return await this.gateway.send(deviceId, command, this.commandTimeoutMs);
      } catch (err) {
        if (!(err instanceof TransportError)) throw err;
        const retriable = TRANSIENT.has(err.code) && (idempotent || !err.maybeExecuted);
        if (!retriable || Date.now() + delay > deadline) throw err;
        await sleep(delay);
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      }
    }
  }

  async query(deviceId: string, command: string): Promise<unknown> {
    return (await this.gateway.send(deviceId, command, this.commandTimeoutMs)).response;
  }
}
