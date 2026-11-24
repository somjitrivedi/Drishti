import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrations, type Migration } from "./migrations.js";

export type MetaDb = Database.Database;

export function openMetaDb(path: string): MetaDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

export function currentVersion(db: MetaDb): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  return row.v ?? 0;
}

export function migrate(db: MetaDb, list: Migration[] = migrations): number[] {
  const from = currentVersion(db);
  const pending = list.filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  const record = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  const applied: number[] = [];
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, Date.now());
    })();
    applied.push(m.version);
  }
  return applied;
}

export function openMigrated(path: string): MetaDb {
  const db = openMetaDb(path);
  migrate(db);
  return db;
}
