import type { ChangeSource, Channel, JobItemStatus, JobStep } from '@tm/shared';
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  hostname: text('hostname'),
  ip: text('ip'),
  mqttTopic: text('mqtt_topic'),
  fullTopic: text('full_topic'),
  module: text('module'),
  firmware: text('firmware'),
  variant: text('variant'),
  chip: text('chip'),
  flashSize: integer('flash_size'),
  rssi: integer('rssi'),
  uptimeSec: integer('uptime_sec'),
  online: integer('online', { mode: 'boolean' }).notNull().default(false),
  authRequired: integer('auth_required', { mode: 'boolean' }).notNull().default(false),
  channels: text('channels', { mode: 'json' }).$type<Channel[]>().notNull().default([]),
  httpFailures: integer('http_failures').notNull().default(0),
  lastSeen: text('last_seen'),
  power: text('power', { mode: 'json' }).$type<boolean[]>(),
  statusJson: text('status_json', { mode: 'json' }).$type<unknown>(),
  sensorsJson: text('sensors_json', { mode: 'json' }).$type<unknown>(),
  passwordOverride: text('password_override'),
  createdAt: text('created_at').notNull(),
});

export const tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  color: text('color'),
});

export const deviceTags = sqliteTable(
  'device_tags',
  {
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.tagId] })],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json', { mode: 'json' }).$type<unknown>(),
});

export const pendingChanges = sqliteTable(
  'pending_changes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'setting' | 'command'>().notNull(),
    key: text('key'),
    value: text('value').notNull(),
    position: integer('position').notNull().default(0),
    source: text('source').$type<ChangeSource>().notNull(),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  // Pro Gerät und Einstellung gibt es höchstens einen Eintrag (letzter Wert gilt); Befehle haben key = NULL.
  (t) => [uniqueIndex('pending_changes_device_key').on(t.deviceId, t.key)],
);

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  status: text('status').$type<'running' | 'done'>().notNull(),
  createdAt: text('created_at').notNull(),
  finishedAt: text('finished_at'),
});

export const jobItems = sqliteTable('job_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  deviceId: text('device_id').notNull(),
  deviceName: text('device_name').notNull(),
  status: text('status').$type<JobItemStatus>().notNull(),
  step: text('step').$type<JobStep>(),
  error: text('error'),
  changeIds: text('change_ids', { mode: 'json' }).$type<number[]>().notNull(),
});
