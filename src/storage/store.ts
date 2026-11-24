import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { Head } from "../ingest/head.js";
import { METRIC_NAME, type Label } from "../ingest/labels.js";
import type { LogEntry } from "../ingest/logs.js";
import type { SeriesRegistry } from "../ingest/registry.js";
import { silentLogger, type Logger } from "../shared/logger.js";
import { loadHead, type LoadCounts } from "./load.js";
import type { FromWriter, LogBatch, SeriesRow, WriterInit } from "./protocol.js";
import { openStorageDb } from "./schema.js";

export interface StoreOptions {
  path: string;
  fsync: boolean;
  flushIntervalMs: number;
  cacheMb: number;
  logger?: Logger;
  onCommit?: (seconds: number) => void;
}

export interface StoreStats {
  path: string;
  commits: number;
  samplesWritten: number;
  pendingBytes: number;
  lastCommitMs: number;
  failed: boolean;
}

export class StoreError extends Error {}

interface Waiter {
  seq: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface LoadWindow {
  minSampleTs: number;
  minLogTs: number;
}

function workerUrl(): { url: URL; execArgv: string[] } {
  const isTs = import.meta.url.endsWith(".ts");
  const url = new URL(`./writer.worker.${isTs ? "ts" : "js"}`, import.meta.url);
  return { url, execArgv: isTs ? ["--import", "tsx"] : [] };
}

export class SqliteStore {
  private series: SeriesRow[] = [];
  private samples: Uint8Array[] = [];
  private logs: LogBatch[] = [];
  private pendingBytes = 0;
  private inflightBytes = 0;
  private appendedSeq = 0;
  private durableSeq = 0;
  private waiters: Waiter[] = [];
  private flushing = false;
  private timer: NodeJS.Timeout | null = null;
  private failure: Error | null = null;
  private closed = false;
  private commits = 0;
  private samplesWritten = 0;
  private lastCommitMs = 0;
  private inflight: { seq: number; resolve: () => void; reject: (e: Error) => void } | null = null;
  private closedSignal: (() => void) | null = null;
  private readonly log: Logger;

  private constructor(
    private readonly opts: StoreOptions,
    private readonly worker: Worker
  ) {
    this.log = opts.logger ?? silentLogger;
    worker.on("message", (m: FromWriter) => this.onMessage(m));
    worker.on("error", (err) => this.fail(err));
    worker.on("exit", (code) => {
      if (!this.closed) this.fail(new StoreError(`storage writer exited with code ${code}`));
      this.closedSignal?.();
    });
  }

  static async open(opts: StoreOptions, registry: SeriesRegistry, head: Head, window: LoadWindow): Promise<{ store: SqliteStore; loaded: LoadCounts }> {
    const db = openStorageDb(opts.path, { fsync: opts.fsync, cacheMb: opts.cacheMb });
    let loaded: LoadCounts;
    try {
      loaded = loadHead(db, registry, head, window.minSampleTs, window.minLogTs);
    } finally {
      db.close();
    }
    const { url, execArgv } = workerUrl();
    const init: WriterInit = { path: opts.path, fsync: opts.fsync, cacheMb: opts.cacheMb };
    const worker = new Worker(fileURLToPath(url), { workerData: init, execArgv });
    const store = new SqliteStore(opts, worker);
    await new Promise<void>((resolve, reject) => {
      const onMsg = (m: FromWriter) => {
        if (m.type === "ready") {
          worker.off("message", onMsg);
          worker.off("error", reject);
          resolve();
        }
      };
      worker.on("message", onMsg);
      worker.once("error", reject);
    });
    return { store, loaded };
  }

  appendSeries(tenant: number, entries: Array<{ ref: number; labels: Label[]; key: string }>, now = Date.now()): void {
    this.guard();
    for (const e of entries) {
      const labels = JSON.stringify(e.labels.map((l) => [l.name, l.value]));
      this.series.push({ ref: e.ref, tenant, metric: e.labels.find((l) => l.name === METRIC_NAME)?.value ?? "", key: e.key, labels, createdAt: now });
      this.bump(labels.length + e.key.length + 64);
    }
  }

  appendSamples(chunk: Uint8Array): void {
    this.guard();
    this.samples.push(chunk);
    this.bump(chunk.length);
  }

  appendLogs(tenant: number, entries: LogEntry[]): void {
    this.guard();
    this.logs.push({ tenant, entries });
    let bytes = 0;
    for (const e of entries) bytes += e.message.length + 128;
    this.bump(bytes);
  }

  commit(): Promise<void> {
    if (this.failure) return Promise.reject(new StoreError(`storage failed: ${this.failure.message}`));
    const seq = this.appendedSeq;
    if (this.durableSeq >= seq) return Promise.resolve();
    return new Promise((resolve, reject) => this.waiters.push({ seq, resolve, reject }));
  }

  get failed(): Error | null {
    return this.failure;
  }

  get backlogBytes(): number {
    return this.pendingBytes + this.inflightBytes;
  }

  stats(): StoreStats {
    return {
      path: this.opts.path,
      commits: this.commits,
      samplesWritten: this.samplesWritten,
      pendingBytes: this.backlogBytes,
      lastCommitMs: Math.round(this.lastCommitMs * 100) / 100,
      failed: this.failure !== null
    };
  }

  private guard(): void {
    if (this.closed) throw new StoreError("storage is closed");
    if (this.failure) throw new StoreError(`storage failed: ${this.failure.message}`);
  }

  private bump(bytes: number): void {
    this.pendingBytes += bytes;
    this.appendedSeq++;
    this.schedule();
  }

  private schedule(): void {
    if (this.flushing || this.timer) return;
    const delay = this.opts.flushIntervalMs === 0 || this.pendingBytes >= 4 * 1024 * 1024 ? 0 : this.opts.flushIntervalMs;
    this.timer = setTimeout(() => void this.flush(), delay);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    if (this.flushing || this.failure || this.appendedSeq === this.durableSeq) return;
    this.flushing = true;
    const seq = this.appendedSeq;
    const msg = { type: "flush" as const, seq, series: this.series, samples: this.samples, logs: this.logs };
    this.inflightBytes = this.pendingBytes;
    this.series = [];
    this.samples = [];
    this.logs = [];
    this.pendingBytes = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        this.inflight = { seq, resolve, reject };
        this.worker.postMessage(msg);
      });
      this.durableSeq = seq;
      const ready = this.waiters.filter((w) => w.seq <= seq);
      this.waiters = this.waiters.filter((w) => w.seq > seq);
      for (const w of ready) w.resolve();
    } catch (err) {
      this.fail(err as Error);
    } finally {
      this.inflight = null;
      this.inflightBytes = 0;
      this.flushing = false;
      if (this.appendedSeq > this.durableSeq && !this.failure) this.schedule();
    }
  }

  private onMessage(m: FromWriter): void {
    if (m.type === "committed") {
      this.commits++;
      this.samplesWritten += m.samples;
      this.lastCommitMs = m.ms;
      this.opts.onCommit?.(m.ms / 1000);
      if (this.inflight?.seq === m.seq) this.inflight.resolve();
    } else if (m.type === "error") {
      if (this.inflight?.seq === m.seq) this.inflight.reject(new StoreError(m.message));
    }
  }

  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    this.log.error("storage failed", { err });
    this.inflight?.reject(err);
    const all = this.waiters;
    this.waiters = [];
    for (const w of all) w.reject(new StoreError(`storage failed: ${err.message}`));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (!this.failure && (this.flushing || this.appendedSeq > this.durableSeq)) {
      if (this.flushing) await new Promise((r) => setTimeout(r, 1));
      else await this.flush();
    }
    this.closed = true;
    if (this.failure) {
      await this.worker.terminate();
      return;
    }
    await new Promise<void>((resolve) => {
      this.closedSignal = resolve;
      this.worker.postMessage({ type: "close" });
    });
  }
}
