import { describe, expect, it } from 'vitest';
import { testDb } from '../../test/helpers';
import { INTERRUPTED, JobRepo } from './jobs';

describe('JobRepo', () => {
  it('legt Jobs an, aktualisiert Items und schließt ab', () => {
    const jobs = new JobRepo(testDb(), () => new Date('2026-09-29T12:00:00Z'));
    const job = jobs.create([{ deviceId: 'A', deviceName: 'Keller', changeIds: [1, 2] }]);
    expect(job).toMatchObject({ status: 'running', items: [{ deviceId: 'A', deviceName: 'Keller', status: 'pending', step: null, error: null }] });
    expect(jobs.changeIdsOf(job.id, 'A')).toEqual([1, 2]);
    expect(jobs.updateItem(job.id, 'A', { status: 'running', step: 'write' })).toMatchObject({ status: 'running', step: 'write' });
    expect(jobs.finish(job.id)).toMatchObject({ status: 'done', finishedAt: '2026-09-29T12:00:00.000Z' });
    expect(jobs.latest()?.id).toBe(job.id);
  });

  it('markiert beim Start unterbrochene Jobs', () => {
    const jobs = new JobRepo(testDb());
    const job = jobs.create([
      { deviceId: 'A', deviceName: 'A', changeIds: [1] },
      { deviceId: 'B', deviceName: 'B', changeIds: [2, 3] },
      { deviceId: 'C', deviceName: 'C', changeIds: [4] },
    ]);
    jobs.updateItem(job.id, 'A', { status: 'success' });
    jobs.updateItem(job.id, 'B', { status: 'running' });
    expect(jobs.recoverInterrupted().sort()).toEqual([2, 3, 4]);
    const recovered = jobs.get(job.id);
    expect(recovered?.status).toBe('done');
    expect(recovered?.items.map((i) => [i.deviceId, i.status, i.error])).toEqual([
      ['A', 'success', null],
      ['B', 'failed', INTERRUPTED],
      ['C', 'failed', INTERRUPTED],
    ]);
    expect(jobs.recoverInterrupted()).toEqual([]);
  });
});
