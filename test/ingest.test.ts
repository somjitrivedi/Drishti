import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Head } from "../src/ingest/head.js";
import { Ingester } from "../src/ingest/ingester.js";
import { RateLimiter, StaticLimits } from "../src/ingest/limits.js";
import type { LogEntry } from "../src/ingest/logs.js";
import { SeriesRegistry } from "../src/ingest/registry.js";
import { SamplesRecordBuilder, unpackSamples } from "../src/ingest/records.js";
import { SqliteStore } from "../src/storage/store.js";
import { defaultConfig, type TenantLimits } from "../src/shared/config.js";
import { tempDir } from "./helpers.js";
import { join } from "node:path";

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const window = { minSampleTs: 0, minLogTs: 0 };
const open: SqliteStore[] = [];

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function openStore(path: string, flushIntervalMs = 2) {
  const registry = new SeriesRegistry();
  const head = new Head();
  const { store, loaded } = await SqliteStore.open({ path, fsync: true, flushIntervalMs, cacheMb: 16 }, registry, head, window);
  open.push(store);
  return { store, registry, head, loaded };
}

async function setup(limitPatch: Partial<TenantLimits> = {}, ingestPatch: Partial<ReturnType<typeof defaultConfig>["ingest"]> = {}) {
  const path = join(tempDir(), "tsdb.db");
  const s = await openStore(path);
  const cfg = defaultConfig();
  let now = NOW;
  const clock = () => now;
  const ingester = new Ingester({
    config: { ...cfg.ingest, ...ingestPatch },
    maxStoreBacklogBytes: cfg.storage.maxPendingBytes,
    store: s.store,
    head: s.head,
    registry: s.registry,
    limits: new StaticLimits({ ...cfg.limits, ...limitPatch }),
    rateLimiter: new RateLimiter(clock),
    clock
  });
  return { ...s, path, ingester, advance: (ms: number) => (now += ms) };
}

const series = (name: string, samples: Array<[number, number]>, extra: Record<string, string> = {}, index = 0) => ({
  index,
  labels: [["__name__", name], ...Object.entries(extra)] as Array<[string, string]>,
  samples: samples.map(([ts, value]) => ({ ts, value }))
});

describe("samples record", () => {
  it("packs and unpacks samples", () => {
    const b = new SamplesRecordBuilder(3);
    b.add(1, NOW, 1.5);
    b.add(7, NOW + 1, NaN);
    const first = b.finish();
    b.add(9, NOW + 2, -1);
    const u = unpackSamples([first, b.finish()]);
    expect(u.count).toBe(3);
    expect([...u.refs]).toEqual([1, 7, 9]);
    expect([...u.ts]).toEqual([NOW, NOW + 1, NOW + 2]);
    expect(u.vals[0]).toBe(1.5);
    expect(Number.isNaN(u.vals[1]!)).toBe(true);
    expect(b.size).toBe(0);
    expect(() => unpackSamples([first.subarray(0, first.length - 1)])).toThrow(/length mismatch/);
  });
});

describe("sqlite store", () => {
  it("persists series, samples and logs and reloads them into the head", async () => {
    const path = join(tempDir(), "tsdb.db");
    const a = await openStore(path);
    const meta = a.registry.create(1, [{ name: "__name__", value: "up" }]);
    a.store.appendSeries(1, [meta]);
    const b = new SamplesRecordBuilder(4);
    b.add(meta.ref, NOW, 1);
    b.add(meta.ref, NOW + 1000, NaN);
    a.store.appendSamples(b.finish());
    const log: LogEntry = { ts: NOW, level: "info", service: "api", message: "hi", fields: { k: "v" } };
    a.store.appendLogs(1, [log]);
    await a.store.commit();
    expect(a.store.stats()).toMatchObject({ samplesWritten: 2, failed: false });
    await a.store.close();
    open.length = 0;

    const r = await openStore(path);
    expect(r.loaded).toMatchObject({ series: 1, samples: 2, logs: 1 });
    expect(r.registry.get(meta.ref)?.labels).toEqual([{ name: "__name__", value: "up" }]);
    const range = r.head.range(meta.ref);
    expect(range.ts).toEqual([NOW, NOW + 1000]);
    expect(Number.isNaN(range.values[1]!)).toBe(true);
    expect(r.head.queryLogs(1, { limit: 10 })).toEqual([log]);
    expect(r.registry.create(1, [{ name: "__name__", value: "new" }]).ref).toBe(meta.ref + 1);
  });

  it("group-commits many appends into few transactions", async () => {
    const { store, registry } = await openStore(join(tempDir(), "tsdb.db"), 20);
    const meta = registry.create(1, [{ name: "__name__", value: "x" }]);
    store.appendSeries(1, [meta]);
    const commits: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      const b = new SamplesRecordBuilder(1);
      b.add(meta.ref, NOW + i, i);
      store.appendSamples(b.finish());
      commits.push(store.commit());
    }
    await Promise.all(commits);
    expect(store.stats().commits).toBeLessThanOrEqual(2);
    expect(store.stats().samplesWritten).toBe(50);
    await expect(store.commit()).resolves.toBeUndefined();
  });

  it("only loads samples and logs inside the window", async () => {
    const path = join(tempDir(), "tsdb.db");
    const a = await openStore(path);
    const meta = a.registry.create(1, [{ name: "__name__", value: "x" }]);
    a.store.appendSeries(1, [meta]);
    const b = new SamplesRecordBuilder(2);
    b.add(meta.ref, 1000, 1);
    b.add(meta.ref, 5000, 2);
    a.store.appendSamples(b.finish());
    a.store.appendLogs(1, [
      { ts: 1000, level: "info", service: "s", message: "old", fields: {} },
      { ts: 5000, level: "info", service: "s", message: "new", fields: {} }
    ]);
    await a.store.close();
    open.length = 0;
    const registry = new SeriesRegistry();
    const head = new Head();
    const { store, loaded } = await SqliteStore.open({ path, fsync: false, flushIntervalMs: 2, cacheMb: 8 }, registry, head, { minSampleTs: 2000, minLogTs: 2000 });
    open.push(store);
    expect(loaded).toMatchObject({ series: 1, samples: 1, logs: 1 });
    expect(head.queryLogs(1, { limit: 5 }).map((e) => e.message)).toEqual(["new"]);
  });

  it("fails closed when the writer cannot commit", async () => {
    const { store, path } = await setup();
    const blocker = new Database(path);
    blocker.exec("DROP TABLE logs");
    blocker.close();
    store.appendLogs(1, [{ ts: NOW, level: "info", service: "s", message: "m", fields: {} }]);
    await expect(store.commit()).rejects.toThrow(/storage failed|no such table/);
    expect(store.failed).not.toBeNull();
    expect(() => store.appendLogs(1, [])).toThrow(/storage failed/);
  });
});

describe("ingester", () => {
  it("accepts samples, creates series once and persists them", async () => {
    const { ingester, registry, head, store } = await setup();
    const r = await ingester.ingestSamples(1, [series("cpu", [[NOW, 1], [NOW + 1000, 2]], { host: "a" }), series("cpu", [[NOW + 2000, 3]], { host: "a" })]);
    expect(r).toEqual({ accepted: 3, rejected: 0, newSeries: 1, errors: [] });
    expect(registry.count(1)).toBe(1);
    expect(head.sampleCount).toBe(3);
    expect(store.stats().samplesWritten).toBe(3);
  });

  it("rejects out-of-order and conflicting duplicates but accepts exact retries", async () => {
    const { ingester, head } = await setup();
    await ingester.ingestSamples(1, [series("m", [[NOW, 1], [NOW + 1000, 2]])]);
    const r = await ingester.ingestSamples(1, [series("m", [[NOW + 1000, 2], [NOW + 1000, 5], [NOW + 500, 9], [NOW + 2000, 3]])]);
    expect(r.accepted).toBe(2);
    expect(r.rejected).toBe(2);
    expect(r.errors.map((e) => e.reason)).toEqual(["duplicate_timestamp", "out_of_order"]);
    expect(r.errors[0]!.series).toBe("m{}");
    expect(head.sampleCount).toBe(3);
    const retry = await ingester.ingestSamples(1, [series("m", [[NOW, 1], [NOW + 1000, 2], [NOW, 7]])]);
    expect(retry).toMatchObject({ accepted: 2, rejected: 1 });
    expect(retry.errors[0]!.reason).toBe("duplicate_timestamp");
    expect(head.sampleCount).toBe(3);
  });

  it("enforces the time window and integer timestamps", async () => {
    const { ingester } = await setup({}, { maxSampleAgeMs: 60_000, maxFutureSkewMs: 1000 });
    const r = await ingester.ingestSamples(1, [series("m", [[NOW - 120_000, 1], [NOW + 5000, 1], [NOW + 0.5, 1], [NOW, 1]])]);
    expect(r.errors.map((e) => e.reason)).toEqual(["too_old", "too_far_in_future", "invalid_timestamp"]);
    expect(r.accepted).toBe(1);
  });

  it("rejects invalid labels per series without failing the batch", async () => {
    const { ingester } = await setup();
    const bad = { index: 3, labels: [["__name__", "x"], ["__secret", "y"]] as Array<[string, string]>, samples: [{ ts: NOW, value: 1 }] };
    const r = await ingester.ingestSamples(1, [bad, series("ok", [[NOW, 1]])]);
    expect(r).toMatchObject({ accepted: 1, rejected: 1 });
    expect(r.errors[0]).toMatchObject({ index: 3, reason: "invalid_labels" });
  });

  it("enforces the per-tenant series limit but keeps existing series writable", async () => {
    const { ingester } = await setup({ maxSeries: 2 });
    await ingester.ingestSamples(1, [series("a", [[NOW, 1]]), series("b", [[NOW, 1]])]);
    const r = await ingester.ingestSamples(1, [series("c", [[NOW, 1]]), series("a", [[NOW + 1, 2]])]);
    expect(r).toMatchObject({ accepted: 1, rejected: 1, newSeries: 0 });
    expect(r.errors[0]!.reason).toBe("series_limit");
    const other = await ingester.ingestSamples(2, [series("c", [[NOW, 1]])]);
    expect(other.newSeries).toBe(1);
  });

  it("rate limits with 429 and refuses batches above the burst with 413", async () => {
    const { ingester, advance } = await setup({ samplesPerSec: 10, samplesBurst: 10 });
    await ingester.ingestSamples(1, [series("m", Array.from({ length: 10 }, (_, i) => [NOW + i, i] as [number, number]))]);
    await expect(ingester.ingestSamples(1, [series("m", [[NOW + 100, 1]])])).rejects.toMatchObject({ status: 429, headers: { "Retry-After": "1" } });
    await expect(ingester.ingestSamples(1, [series("m", Array.from({ length: 11 }, (_, i) => [NOW + 200 + i, i] as [number, number]))])).rejects.toMatchObject({ status: 413 });
    advance(1000);
    await expect(ingester.ingestSamples(1, [series("m", [[NOW + 300, 1]])])).resolves.toMatchObject({ accepted: 1 });
  });

  it("applies backpressure when the head is full", async () => {
    const { ingester } = await setup({}, { headMaxBytes: 1 });
    await ingester.ingestSamples(1, [series("m", [[NOW, 1]])]);
    await expect(ingester.ingestSamples(1, [series("m", [[NOW + 1, 1]])])).rejects.toMatchObject({ status: 429, code: "backpressure" });
  });

  it("ingests logs inside the window and rejects stale ones", async () => {
    const { ingester, head } = await setup({}, { maxLogAgeMs: 60_000 });
    const entries = [
      { ts: NOW, level: "info" as const, service: "api", message: "ok", fields: {}, line: 1 },
      { ts: NOW - 120_000, level: "info" as const, service: "api", message: "old", fields: {}, line: 2 }
    ];
    const r = await ingester.ingestLogs(1, entries, 100);
    expect(r).toMatchObject({ accepted: 1, rejected: 1 });
    expect(r.errors[0]).toMatchObject({ index: 2, reason: "too_old" });
    expect(head.queryLogs(1, { limit: 10 }).map((e) => e.message)).toEqual(["ok"]);
  });

  it("throttles log bytes", async () => {
    const { ingester } = await setup({ logBytesPerSec: 100, logBytesBurst: 100 });
    const e = [{ ts: NOW, level: "info" as const, service: "s", message: "m", fields: {} }];
    await ingester.ingestLogs(1, e, 100);
    await expect(ingester.ingestLogs(1, e, 1)).rejects.toMatchObject({ status: 429 });
  });
});
