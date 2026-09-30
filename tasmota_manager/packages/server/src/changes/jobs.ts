import type { JobItem, JobItemStatus, JobStep, JobView } from '@tm/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { jobItems, jobs } from '../db/schema';

export const INTERRUPTED = 'interrupted: The app was restarted during the batch run';

export interface NewJobItem {
  deviceId: string;
  deviceName: string;
  changeIds: number[];
}

type JobRow = typeof jobs.$inferSelect;
type JobItemRow = typeof jobItems.$inferSelect;
export type JobItemPatch = Partial<{ status: JobItemStatus; step: JobStep | null; error: string | null }>;

const toItem = (row: JobItemRow): JobItem => ({
  deviceId: row.deviceId,
  deviceName: row.deviceName,
  status: row.status,
  step: row.step,
  error: row.error,
});

export class JobRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(items: NewJobItem[]): JobView {
    const job = this.db.insert(jobs).values({ type: 'apply', status: 'running', createdAt: this.now().toISOString() }).returning().get();
    for (const item of items) {
      this.db.insert(jobItems).values({ jobId: job.id, ...item, status: 'pending' }).run();
    }
    return this.view(job);
  }

  changeIdsOf(jobId: number, deviceId: string): number[] {
    return this.itemRow(jobId, deviceId)?.changeIds ?? [];
  }

  updateItem(jobId: number, deviceId: string, patch: JobItemPatch): JobItem {
    this.db
      .update(jobItems)
      .set(patch)
      .where(and(eq(jobItems.jobId, jobId), eq(jobItems.deviceId, deviceId)))
      .run();
    const row = this.itemRow(jobId, deviceId);
    if (!row) throw new Error(`Unbekanntes Job-Item ${jobId}/${deviceId}`);
    return toItem(row);
  }

  /** Erledigte Einträge gehören nicht mehr zum Item; eine spätere Unterbrechung darf sie nicht als Fehler markieren. */
  removeChangeIds(jobId: number, deviceId: string, ids: number[]): void {
    const row = this.itemRow(jobId, deviceId);
    if (!row) return;
    const changeIds = row.changeIds.filter((id) => !ids.includes(id));
    this.db.update(jobItems).set({ changeIds }).where(eq(jobItems.id, row.id)).run();
  }

  finish(jobId: number): JobView {
    this.db.update(jobs).set({ status: 'done', finishedAt: this.now().toISOString() }).where(eq(jobs.id, jobId)).run();
    const view = this.get(jobId);
    if (!view) throw new Error(`Unbekannter Job ${jobId}`);
    return view;
  }

  get(jobId: number): JobView | null {
    const row = this.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    return row ? this.view(row) : null;
  }

  latest(): JobView | null {
    const row = this.db.select().from(jobs).orderBy(desc(jobs.id)).limit(1).get();
    return row ? this.view(row) : null;
  }

  /** Nach einem App-Neustart: offene Items als unterbrochen markieren und deren Change-IDs liefern. */
  recoverInterrupted(): number[] {
    const changeIds: number[] = [];
    for (const job of this.db.select().from(jobs).where(eq(jobs.status, 'running')).all()) {
      for (const item of this.db.select().from(jobItems).where(eq(jobItems.jobId, job.id)).all()) {
        if (item.status !== 'pending' && item.status !== 'running') continue;
        changeIds.push(...item.changeIds);
        this.db.update(jobItems).set({ status: 'failed', step: null, error: INTERRUPTED }).where(eq(jobItems.id, item.id)).run();
      }
      this.db.update(jobs).set({ status: 'done', finishedAt: this.now().toISOString() }).where(eq(jobs.id, job.id)).run();
    }
    return changeIds;
  }

  private itemRow(jobId: number, deviceId: string): JobItemRow | undefined {
    return this.db
      .select()
      .from(jobItems)
      .where(and(eq(jobItems.jobId, jobId), eq(jobItems.deviceId, deviceId)))
      .get();
  }

  private view(row: JobRow): JobView {
    const items = this.db.select().from(jobItems).where(eq(jobItems.jobId, row.id)).orderBy(asc(jobItems.id)).all();
    return { id: row.id, status: row.status, createdAt: row.createdAt, finishedAt: row.finishedAt, items: items.map(toItem) };
  }
}
