import { EventEmitter } from 'node:events';
import type { JobItem, JobView } from '@tm/shared';
import type { Logger } from 'pino';
import type { DeviceRegistry } from '../registry';
import { parseStatus0 } from '../tasmota/parse';
import { TransportError } from '../transport/errors';
import { mapLimit } from '../util/mapLimit';
import { extractValue, readCommand, valuesEqual } from './catalog';
import type { DeviceOps } from './deviceOps';
import type { JobItemPatch, JobRepo } from './jobs';
import { type SendStep, type VerifyItem, planDevice } from './planner';
import type { PendingStore } from './store';

export class RunnerBusyError extends Error {}
export class NothingToApplyError extends Error {}

export interface RunnerDeps {
  store: PendingStore;
  jobs: JobRepo;
  registry: DeviceRegistry;
  ops: DeviceOps;
  concurrency: () => number;
  log: Logger;
}

const describe = (err: unknown): string =>
  err instanceof TransportError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);

/** Ergebnis eines Geräts während eines Laufs. */
class DeviceRun {
  readonly done = new Set<number>();
  readonly failed = new Map<number, string>();
  aborted: string | null = null;

  succeed(ids: number[]): void {
    for (const id of ids) this.done.add(id);
  }

  fail(ids: number[], message: string): void {
    for (const id of ids) {
      this.done.delete(id);
      this.failed.set(id, message);
    }
  }

  failuresByMessage(): Map<string, number[]> {
    const grouped = new Map<string, number[]>();
    for (const [id, message] of this.failed) grouped.set(message, [...(grouped.get(message) ?? []), id]);
    return grouped;
  }

  firstError(): string | null {
    const first = this.failed.values().next();
    return first.done ? null : first.value;
  }
}

export class ApplyRunner extends EventEmitter<{ progress: [number, JobItem]; done: [JobView] }> {
  private current: Promise<void> | null = null;

  constructor(private readonly deps: RunnerDeps) {
    super();
  }

  get running(): boolean {
    return this.current !== null;
  }

  async waitIdle(): Promise<void> {
    await this.current;
  }

  start(deviceIds?: string[]): JobView {
    if (this.current) throw new RunnerBusyError('Es läuft bereits ein Batch');
    const { store, jobs, registry } = this.deps;
    const ids = (deviceIds ?? store.deviceIdsWithChanges()).filter((id) => store.forDevice(id).length > 0);
    if (ids.length === 0) throw new NothingToApplyError('Keine ausstehenden Änderungen');
    store.clearErrors(ids);
    const job = jobs.create(
      ids.map((id) => ({ deviceId: id, deviceName: registry.get(id)?.name ?? id, changeIds: store.forDevice(id).map((r) => r.id) })),
    );
    this.current = mapLimit(ids, this.deps.concurrency(), (id) => this.runSafe(job.id, id))
      .then(() => {
        this.emit('done', jobs.finish(job.id));
      })
      .catch((err: unknown) => this.deps.log.error({ err }, 'Batch-Lauf fehlgeschlagen'))
      .finally(() => {
        this.current = null;
      });
    return job;
  }

  private async runSafe(jobId: number, deviceId: string): Promise<void> {
    try {
      await this.runDevice(jobId, deviceId);
    } catch (err) {
      this.deps.log.error({ err, deviceId }, 'Batch-Lauf für ein Gerät abgebrochen');
      const message = describe(err);
      this.deps.store.fail(this.deps.jobs.changeIdsOf(jobId, deviceId), message);
      this.progress(jobId, deviceId, { status: 'failed', step: null, error: message });
    }
  }

  private async runDevice(jobId: number, deviceId: string): Promise<void> {
    const { store, registry } = this.deps;
    const ids = new Set(this.deps.jobs.changeIdsOf(jobId, deviceId));
    const plan = planDevice(store.forDevice(deviceId).filter((r) => ids.has(r.id)));
    const run = new DeviceRun();
    this.progress(jobId, deviceId, { status: 'running', step: 'write', error: null });

    // 1. Einstellungen ohne Neustart (inkl. Rules/Timer) schreiben und sofort prüfen.
    for (const step of plan.settings) await this.execute(jobId, deviceId, step, run);
    await this.verify(jobId, deviceId, plan.verifySettings, run);
    // 2. Freie Befehle, 3. alle Einstellungen mit Neustart in einem Backlog.
    for (const step of plan.commands) await this.execute(jobId, deviceId, step, run);
    if (plan.restartBundle) await this.execute(jobId, deviceId, plan.restartBundle, run);
    // 4. Nach MQTT-Änderungen nur prüfen, wenn das Gerät auch per HTTP erreichbar ist.
    const canVerifyRestart = plan.restartBundle === null || Boolean(registry.get(deviceId)?.ip);
    if (canVerifyRestart) await this.verify(jobId, deviceId, plan.verifyRestart, run);

    if (!run.aborted) await this.refreshStatus(deviceId);
    store.resolve([...run.done]);
    for (const [message, changeIds] of run.failuresByMessage()) store.fail(changeIds, message);
    this.progress(jobId, deviceId, { status: run.failed.size > 0 ? 'failed' : 'success', step: null, error: run.firstError() });
  }

  private async execute(jobId: number, deviceId: string, step: SendStep, run: DeviceRun): Promise<void> {
    if (run.aborted) {
      run.fail(step.changeIds, run.aborted);
      return;
    }
    const { ops } = this.deps;
    try {
      const before = step.restarts ? await ops.uptime(deviceId) : 0;
      await ops.send(deviceId, step.command, step.idempotent);
      if (step.restarts) {
        this.progress(jobId, deviceId, { step: 'restart' });
        await ops.waitForRestart(deviceId, before);
        this.progress(jobId, deviceId, { step: 'write' });
      }
      run.succeed(step.changeIds);
    } catch (err) {
      const message = describe(err);
      run.fail(step.changeIds, message);
      // Ein abgelehnter Befehl betrifft nur ihn selbst; alles andere (offline, timeout, auth) beendet das Gerät.
      if (!(err instanceof TransportError && err.code === 'rejected')) run.aborted = message;
    }
  }

  private async verify(jobId: number, deviceId: string, items: VerifyItem[], run: DeviceRun): Promise<void> {
    const open = items.filter((item) => run.done.has(item.changeId));
    if (open.length === 0) return;
    this.progress(jobId, deviceId, { step: 'verify' });
    for (const item of open) {
      if (run.aborted) {
        run.fail([item.changeId], run.aborted);
        continue;
      }
      try {
        const { response } = await this.deps.ops.send(deviceId, readCommand(item.def), true);
        const actual = extractValue(item.def, response);
        if (!valuesEqual(item.def, item.expected, actual)) {
          run.fail([item.changeId], `verify_mismatch: Soll „${item.expected}“, Ist „${actual ?? '—'}“`);
        }
      } catch (err) {
        const message = describe(err);
        run.fail([item.changeId], message);
        run.aborted = message;
      }
    }
    this.progress(jobId, deviceId, { step: 'write' });
  }

  /** Aktualisiert den gespeicherten Status, damit „vorher“-Werte stimmen. Die bekannte Adresse bleibt erhalten. */
  private async refreshStatus(deviceId: string): Promise<void> {
    try {
      const payload = await this.deps.ops.query(deviceId, 'Status 0');
      const info = parseStatus0(payload);
      if (!info) return;
      info.ip = undefined;
      this.deps.registry.upsert(info, { statusJson: payload });
    } catch {
      // Nicht kritisch; der nächste Poll bzw. Status-Refresh holt es nach.
    }
  }

  private progress(jobId: number, deviceId: string, patch: JobItemPatch): void {
    this.emit('progress', jobId, this.deps.jobs.updateItem(jobId, deviceId, patch));
  }
}
