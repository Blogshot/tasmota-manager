import type { Channel } from '@tm/shared';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
  statusJson: text('status_json', { mode: 'json' }).$type<unknown>(),
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
