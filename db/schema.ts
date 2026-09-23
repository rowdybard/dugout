import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
export const cache = sqliteTable('cache',{key:text('key').primaryKey(),value:text('value').notNull(),updated:integer('updated').notNull()});
export const snapshots = sqliteTable('snapshots',{id:text('id').primaryKey(),slug:text('slug').notNull(),time:integer('time').notNull(),price:real('price'),bid:real('bid'),ask:real('ask'),volume:real('volume'),depth:real('depth'),signals:text('signals')},t=>[index('snapshot_slug_time').on(t.slug,t.time)]);
export const profiles = sqliteTable('profiles',{id:text('id').primaryKey(),value:text('value').notNull(),version:integer('version').notNull().default(0)});
export const tradingCommands = sqliteTable('trading_commands', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(), commandId: text('command_id').notNull(),
  fingerprint: text('fingerprint').notNull(), value: text('value').notNull(), createdAt: integer('created_at').notNull(),
}, t => [index('trading_commands_user_time').on(t.userId, t.createdAt)]);
export const tradingObservations = sqliteTable('trading_observations', {
  id: text('id').primaryKey(), slug: text('slug').notNull(), time: integer('time').notNull(),
  price: real('price'), bid: real('bid'), ask: real('ask'), depth: real('depth'), source: text('source').notNull(),
}, t => [index('trading_observations_slug_time').on(t.slug, t.time)]);
