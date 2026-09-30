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
    if (!Number.isFinite(uptime)) throw new TransportError('rejected', 'Status 11 enthält keine UptimeSec');
    return uptime;
  }

  /** Der Online-Status allein reicht nicht: Tasmota startet erst 1–2 s nach dem Befehl neu. */
  async waitForRestart(deviceId: string, uptimeBefore: number): Promise<void> {
    const deadline = Date.now() + this.restartTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.pollMs);
      try {
        if ((await this.uptime(deviceId, Math.min(this.commandTimeoutMs, 3000))) < uptimeBefore) return;
      } catch {
        // Gerät startet noch neu.
      }
    }
    throw new TransportError(
      'offline',
      `Gerät ist nach dem Neustart nicht innerhalb von ${Math.round(this.restartTimeoutMs / 1000)} s zurückgekommen`,
    );
  }

  /** Sendet mit Wiederholungen, falls der Befehl sicher nicht ausgeführt wurde (oder gefahrlos wiederholbar ist). */
  async send(deviceId: string, command: string, idempotent: boolean): Promise<SendResult> {
    const deadline = Date.now() + this.restartTimeoutMs;
    let delay = this.pollMs;
    for (;;) {
      try {
        return await this.gateway.send(deviceId, command, this.commandTimeoutMs);
      } catch (err) {
        if (!(err instanceof TransportError)) throw err;
        const retriable = err.code === 'unreachable' || err.code === 'offline' || (err.code === 'timeout' && idempotent);
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
