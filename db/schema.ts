import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
export const cache = sqliteTable('cache',{key:text('key').primaryKey(),value:text('value').notNull(),updated:integer('updated').notNull()});
export const snapshots = sqliteTable('snapshots',{id:text('id').primaryKey(),slug:text('slug').notNull(),time:integer('time').notNull(),price:real('price'),bid:real('bid'),ask:real('ask'),volume:real('volume'),depth:real('depth'),signals:text('signals')},t=>[index('snapshot_slug_time').on(t.slug,t.time)]);
export const profiles = sqliteTable('profiles',{id:text('id').primaryKey(),value:text('value').notNull(),version:integer('version').notNull().default(0)});
