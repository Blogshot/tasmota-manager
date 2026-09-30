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

  /** Werte zum Zeitpunkt der Planung; nur Zeilen mit unverändertem Wert werden aufgelöst. */
  constructor(private readonly planned: ReadonlyMap<number, string>) {}

  withValues(ids: Iterable<number>): Array<{ id: number; value: string }> {
    return [...ids].map((id) => ({ id, value: this.planned.get(id) ?? '' }));
  }

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

  /** Ein Abbruch zählt auch dann als Fehler, wenn keine Zeile mehr offen ist (z. B. nur ein gesendeter Neustart-Befehl). */
  firstError(): string | null {
    const first = this.failed.values().next();
    return first.done ? this.aborted : first.value;
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
    const ids = [...new Set(deviceIds ?? store.deviceIdsWithChanges())].filter((id) => store.forDevice(id).length > 0);
    if (ids.length === 0) throw new NothingToApplyError('Keine ausstehenden Änderungen');
    store.clearErrors(ids);
    const job = jobs.create(
      ids.map((id) => ({ deviceId: id, deviceName: registry.get(id)?.name ?? id, changeIds: store.forDevice(id).map((r) => r.id) })),
    );
    this.current = this.runBatch(job.id, ids);
    return job;
  }

  /** Läuft immer bis zum Ende: der Job wird nach allen Geräten abgeschlossen, egal was dazwischen fehlschlägt. */
  private async runBatch(jobId: number, ids: string[]): Promise<void> {
    const { jobs, log } = this.deps;
    try {
      const limit = Math.max(1, Math.floor(this.deps.concurrency()) || 1);
      await mapLimit(ids, limit, (id) => this.runSafe(jobId, id));
    } catch (err) {
      log.error({ err }, 'Batch-Lauf fehlgeschlagen');
    }
    try {
      const view = jobs.finish(jobId);
      try {
        this.emit('done', view);
      } catch (err) {
        log.error({ err }, 'done-Listener fehlgeschlagen');
      }
    } catch (err) {
      log.error({ err, jobId }, 'Job konnte nicht abgeschlossen werden');
    } finally {
      this.current = null;
    }
  }

  private async runSafe(jobId: number, deviceId: string): Promise<void> {
    try {
      await this.runDevice(jobId, deviceId);
    } catch (err) {
      try {
        this.deps.log.error({ err, deviceId }, 'Batch-Lauf für ein Gerät abgebrochen');
        const message = describe(err);
        this.deps.store.fail(this.deps.jobs.changeIdsOf(jobId, deviceId), message);
        this.progress(jobId, deviceId, { status: 'failed', step: null, error: message });
      } catch (inner) {
        this.deps.log.error({ err: inner, deviceId }, 'Fehlerbehandlung für ein Gerät fehlgeschlagen');
      }
    }
  }

  private async runDevice(jobId: number, deviceId: string): Promise<void> {
    const { store } = this.deps;
    const ids = new Set(this.deps.jobs.changeIdsOf(jobId, deviceId));
    const rows = store.forDevice(deviceId).filter((r) => ids.has(r.id));
    const plan = planDevice(rows);
    const run = new DeviceRun(new Map(rows.map((r) => [r.id, r.value])));
    // Zeilen, die der Plan nicht abdeckt (z. B. unbekannter Katalogschlüssel), dürfen nicht unbemerkt liegen bleiben.
    const covered = new Set<number>();
    for (const step of [...plan.settings, ...plan.commands, ...(plan.restartBundle ? [plan.restartBundle] : [])]) {
      for (const id of step.changeIds) covered.add(id);
    }
    for (const row of rows) {
      if (!covered.has(row.id)) run.fail([row.id], row.key ? `Unbekannte Einstellung ${row.key}` : 'Nicht ausführbarer Eintrag');
    }
    this.progress(jobId, deviceId, { status: 'running', step: 'write', error: null });

    // 1. Einstellungen ohne Neustart (inkl. Rules/Timer) schreiben und sofort prüfen.
    for (const step of plan.settings) await this.execute(jobId, deviceId, step, run);
    await this.verify(jobId, deviceId, plan.verifySettings, run);
    // 2. Freie Befehle, 3. alle Einstellungen mit Neustart in einem Backlog.
    for (const step of plan.commands) await this.execute(jobId, deviceId, step, run);
    if (plan.restartBundle) await this.execute(jobId, deviceId, plan.restartBundle, run);
    // 4. Einstellungen mit Neustart prüfen (nur solche, die tatsächlich geschrieben wurden und das Gerät zurückkam).
    await this.verify(jobId, deviceId, plan.verifyRestart, run);

    if (!run.aborted) await this.refreshStatus(deviceId);
    store.resolveUnchanged(run.withValues(run.done));
    for (const [message, changeIds] of run.failuresByMessage()) store.failUnchanged(run.withValues(changeIds), message);
    const error = run.firstError();
    this.progress(jobId, deviceId, { status: error === null ? 'success' : 'failed', step: null, error });
  }

  private async execute(jobId: number, deviceId: string, step: SendStep, run: DeviceRun): Promise<void> {
    if (run.aborted) {
      run.fail(step.changeIds, run.aborted);
      return;
    }
    const { ops, store, jobs } = this.deps;
    let settled = false;
    const abort = (err: unknown): void => {
      const message = describe(err);
      if (!settled) run.fail(step.changeIds, message);
      run.aborted = message;
    };
    let before = 0;
    try {
      if (step.restarts) before = await ops.uptime(deviceId);
    } catch (err) {
      abort(err);
      return;
    }
    try {
      await ops.send(deviceId, step.command, step.idempotent);
    } catch (err) {
      // Nur ein Reject des eigenen Befehls betrifft ihn allein; alles andere (offline, timeout, auth) beendet das Gerät.
      if (err instanceof TransportError && err.code === 'rejected') run.fail(step.changeIds, describe(err));
      else abort(err);
      return;
    }
    if (step.settleOnSend) {
      // Ein freier Befehl ist mit dem Senden ausgeführt. Sofort festhalten (Puffer und Job-Item), damit ein
      // unterbrochener Lauf ihn beim erneuten Start nicht noch einmal ausführt.
      store.resolveUnchanged(run.withValues(step.changeIds));
      jobs.removeChangeIds(jobId, deviceId, step.changeIds);
      settled = true;
    }
    if (step.restarts) {
      try {
        this.progress(jobId, deviceId, { step: 'restart' });
        await ops.waitForRestart(deviceId, before);
        this.progress(jobId, deviceId, { step: 'write' });
      } catch (err) {
        abort(err);
        return;
      }
    }
    if (!settled) run.succeed(step.changeIds);
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
    try {
      this.emit('progress', jobId, this.deps.jobs.updateItem(jobId, deviceId, patch));
    } catch (err) {
      this.deps.log.error({ err, deviceId }, 'Fortschritt konnte nicht gemeldet werden');
    }
  }
}
