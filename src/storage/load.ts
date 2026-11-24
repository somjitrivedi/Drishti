import type { Head } from "../ingest/head.js";
import type { Label } from "../ingest/labels.js";
import type { LogEntry, LogLevelName } from "../ingest/logs.js";
import type { SeriesRegistry } from "../ingest/registry.js";
import type { StorageDb } from "./schema.js";

export interface LoadCounts {
  series: number;
  samples: number;
  logs: number;
  durationMs: number;
}

export function loadHead(db: StorageDb, registry: SeriesRegistry, head: Head, minSampleTs: number, minLogTs: number): LoadCounts {
  const started = performance.now();
  const counts: LoadCounts = { series: 0, samples: 0, logs: 0, durationMs: 0 };
  for (const row of db.prepare("SELECT ref, tenant, labels FROM series ORDER BY ref").iterate() as IterableIterator<{ ref: number; tenant: number; labels: string }>) {
    const labels = (JSON.parse(row.labels) as Array<[string, string]>).map(([name, value]): Label => ({ name, value }));
    registry.restore(row.tenant, row.ref, labels);
    counts.series++;
  }
  const samples = db.prepare("SELECT ref, ts, value FROM samples WHERE ts >= ? ORDER BY id").raw(true);
  for (const row of samples.iterate(minSampleTs) as IterableIterator<[number, number, number | null]>) {
    head.append(row[0], row[1], row[2] ?? NaN);
    counts.samples++;
  }
  const logs = db.prepare("SELECT tenant, ts, level, service, message, fields FROM logs WHERE ts >= ? ORDER BY id").raw(true);
  let tenant = -1;
  let batch: LogEntry[] = [];
  for (const row of logs.iterate(minLogTs) as IterableIterator<[number, number, string, string, string, string]>) {
    if (row[0] !== tenant && batch.length) {
      head.appendLogs(tenant, batch);
      batch = [];
    }
    tenant = row[0];
    batch.push({ ts: row[1], level: row[2] as LogLevelName, service: row[3], message: row[4], fields: JSON.parse(row[5]) as Record<string, string> });
    counts.logs++;
  }
  if (batch.length) head.appendLogs(tenant, batch);
  counts.durationMs = performance.now() - started;
  return counts;
}
