import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "../meta/db.js";
import type { Migration } from "../meta/migrations.js";

export type StorageDb = Database.Database;

export const storageMigrations: Migration[] = [
  {
    version: 1,
    name: "series_samples_logs",
    sql: `
      CREATE TABLE series (
        ref INTEGER PRIMARY KEY,
        tenant INTEGER NOT NULL,
        metric TEXT NOT NULL,
        series_key TEXT NOT NULL,
        labels TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (tenant, series_key)
      );

      CREATE TABLE samples (
        id INTEGER PRIMARY KEY,
        ref INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        value REAL
      );

      CREATE TABLE logs (
        id INTEGER PRIMARY KEY,
        tenant INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        level TEXT NOT NULL,
        service TEXT NOT NULL,
        message TEXT NOT NULL,
        fields TEXT NOT NULL
      );
    `
  }
];

export interface StorageDbOptions {
  fsync: boolean;
  cacheMb: number;
  readonly?: boolean;
}

export function openStorageDb(path: string, opts: StorageDbOptions): StorageDb {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma(`synchronous = ${opts.fsync ? "FULL" : "NORMAL"}`);
  db.pragma(`cache_size = -${Math.round(opts.cacheMb * 1024)}`);
  db.pragma("temp_store = MEMORY");
  db.pragma("busy_timeout = 5000");
  migrate(db, storageMigrations);
  return db;
}
