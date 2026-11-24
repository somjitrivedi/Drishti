import { parentPort, workerData } from "node:worker_threads";
import { unpackSamples } from "../ingest/records.js";
import { openStorageDb } from "./schema.js";
import type { FlushMessage, FromWriter, ToWriter, WriterInit } from "./protocol.js";

const init = workerData as WriterInit;
const port = parentPort!;
const send = (m: FromWriter) => port.postMessage(m);

const ROWS_PER_STATEMENT = 64;

const db = openStorageDb(init.path, { fsync: init.fsync, cacheMb: init.cacheMb });
const insertSeries = db.prepare("INSERT OR IGNORE INTO series (ref, tenant, metric, series_key, labels, created_at) VALUES (?, ?, ?, ?, ?, ?)");
const insertSample = db.prepare("INSERT INTO samples (ref, ts, value) VALUES (?, ?, ?)");
const insertSamplesBulk = db.prepare(`INSERT INTO samples (ref, ts, value) VALUES ${Array(ROWS_PER_STATEMENT).fill("(?, ?, ?)").join(", ")}`);
const insertLog = db.prepare("INSERT INTO logs (tenant, ts, level, service, message, fields) VALUES (?, ?, ?, ?, ?, ?)");

const apply = db.transaction((m: FlushMessage) => {
  for (const s of m.series) insertSeries.run(s.ref, s.tenant, s.metric, s.key, s.labels, s.createdAt);
  const { refs, ts, vals, count } = unpackSamples(m.samples);
  const params: Array<number | null> = new Array(ROWS_PER_STATEMENT * 3);
  let k = 0;
  for (; k + ROWS_PER_STATEMENT <= count; k += ROWS_PER_STATEMENT) {
    for (let r = 0; r < ROWS_PER_STATEMENT; r++) {
      const i = k + r;
      const v = vals[i]!;
      params[r * 3] = refs[i]!;
      params[r * 3 + 1] = ts[i]!;
      params[r * 3 + 2] = Number.isNaN(v) ? null : v;
    }
    insertSamplesBulk.run(params);
  }
  for (; k < count; k++) {
    const v = vals[k]!;
    insertSample.run(refs[k]!, ts[k]!, Number.isNaN(v) ? null : v);
  }
  for (const batch of m.logs) {
    for (const e of batch.entries) insertLog.run(batch.tenant, e.ts, e.level, e.service, e.message, JSON.stringify(e.fields));
  }
  return count;
});

port.on("message", (m: ToWriter) => {
  if (m.type === "close") {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    send({ type: "closed" });
    port.close();
    return;
  }
  const t0 = performance.now();
  try {
    const samples = apply(m);
    send({ type: "committed", seq: m.seq, ms: performance.now() - t0, samples });
  } catch (err) {
    send({ type: "error", seq: m.seq, message: (err as Error).message });
  }
});

send({ type: "ready" });
