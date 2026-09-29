import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { testDb } from '../../test/helpers';
import { deviceTags, devices, tags } from './schema';

describe('openDb', () => {
  it('legt das Schema an und speichert JSON-Spalten', () => {
    const db = testDb();
    db.insert(devices).values({ id: 'AABBCC112233', name: 'Keller', channels: ['mqtt'], createdAt: 'now' }).run();
    const row = db.select().from(devices).get();
    expect(row?.channels).toEqual(['mqtt']);
    expect(row?.online).toBe(false);
  });

  it('löscht Tag-Zuordnungen mit dem Gerät', () => {
    const db = testDb();
    db.insert(devices).values({ id: 'A', name: 'A', createdAt: 'now' }).run();
    const tag = db.insert(tags).values({ name: 'Keller' }).returning().get();
    db.insert(deviceTags).values({ deviceId: 'A', tagId: tag.id }).run();
    db.delete(devices).where(eq(devices.id, 'A')).run();
    expect(db.select().from(deviceTags).all()).toEqual([]);
  });
});
