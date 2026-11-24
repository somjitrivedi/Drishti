import type { RwTimeSeries } from "../codec/remoteWrite.js";
import { Rng, advance, buildSeries, encodeJsonBatch, encodeRemoteWriteBatch, makeLogLine, type SeriesSpec } from "./generator.js";

export type LoadFormat = "json" | "remote-write";

export interface LoadOptions {
  url: string;
  key: string;
  series: number;
  rate: number;
  durationSec: number;
  batchSize: number;
  concurrency: number;
  format: LoadFormat;
  logsPerSec: number;
  reportEverySec: number;
  seed?: number;
  onReport?: (r: LoadReport) => void;
}

export interface LoadReport {
  elapsedSec: number;
  samplesSent: number;
  samplesAcked: number;
  samplesRejected: number;
  ackedPerSec: number;
  requests: number;
  throttled: number;
  failures: number;
  logsAcked: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  lastError: string | null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runLoad(opts: LoadOptions): Promise<LoadReport> {
  const specs = buildSeries(opts.series, opts.seed ?? 42);
  const latencies: number[] = [];
  const state = { sent: 0, acked: 0, rejected: 0, requests: 0, throttled: 0, failures: 0, logsAcked: 0, lastError: null as string | null };
  const start = performance.now();
  const deadline = start + opts.durationSec * 1000;
  const base = opts.url.replace(/\/$/, "");
  const auth = { Authorization: `Bearer ${opts.key}` };

  const snapshot = (): LoadReport => {
    const elapsedSec = (performance.now() - start) / 1000;
    const sorted = [...latencies].sort((a, b) => a - b);
    return {
      elapsedSec: Math.round(elapsedSec * 10) / 10,
      samplesSent: state.sent,
      samplesAcked: state.acked,
      samplesRejected: state.rejected,
      ackedPerSec: Math.round(state.acked / Math.max(elapsedSec, 0.001)),
      requests: state.requests,
      throttled: state.throttled,
      failures: state.failures,
      logsAcked: state.logsAcked,
      latencyMs: {
        p50: Math.round(percentile(sorted, 50) * 10) / 10,
        p95: Math.round(percentile(sorted, 95) * 10) / 10,
        p99: Math.round(percentile(sorted, 99) * 10) / 10,
        max: Math.round((sorted.at(-1) ?? 0) * 10) / 10
      },
      lastError: state.lastError
    };
  };

  const send = async (path: string, body: string | Uint8Array, headers: Record<string, string>): Promise<{ status: number; text: string }> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const t0 = performance.now();
      let res: Response;
      try {
        res = await fetch(base + path, { method: "POST", headers: { ...auth, ...headers }, body });
      } catch (err) {
        state.failures++;
        state.lastError = (err as Error).message;
        await sleep(200);
        continue;
      }
      const text = await res.text();
      state.requests++;
      latencies.push(performance.now() - t0);
      if (res.status === 429 || res.status === 503) {
        state.throttled++;
        const retry = Number(res.headers.get("retry-after") ?? "1");
        await sleep(Math.min(5000, retry * 1000));
        continue;
      }
      return { status: res.status, text };
    }
    return { status: 0, text: "gave up after retries" };
  };

  const worker = async (w: number) => {
    const owned = specs.filter((_, i) => i % opts.concurrency === w);
    if (owned.length === 0) return;
    const rng = new Rng((opts.seed ?? 42) + w * 7919);
    const perWorkerRate = opts.rate / opts.concurrency;
    const interval = (opts.batchSize / perWorkerRate) * 1000;
    let cursor = 0;
    let nextAt = performance.now();
    while (performance.now() < deadline) {
      const wait = nextAt - performance.now();
      if (wait > 0) await sleep(wait);
      if (performance.now() >= deadline) break;
      nextAt += interval;
      const now = Date.now();
      const bySpec = new Map<SeriesSpec, RwTimeSeries>();
      for (let i = 0; i < opts.batchSize; i++) {
        const spec = owned[cursor]!;
        cursor = (cursor + 1) % owned.length;
        const p = advance(spec, rng, now);
        let ts = bySpec.get(spec);
        if (!ts) {
          ts = { labels: spec.labels, samples: [] };
          bySpec.set(spec, ts);
        }
        ts.samples.push({ timestamp: p.ts, value: p.value });
      }
      const batch = [...bySpec.values()];
      state.sent += opts.batchSize;
      const res =
        opts.format === "json"
          ? await send("/api/v1/metrics", encodeJsonBatch(batch), { "Content-Type": "application/x-ndjson" })
          : await send("/api/v1/write", encodeRemoteWriteBatch(batch), {
              "Content-Type": "application/x-protobuf",
              "Content-Encoding": "snappy",
              "X-Prometheus-Remote-Write-Version": "0.1.0"
            });
      if (res.status === 204) state.acked += opts.batchSize;
      else if (res.status === 200 || res.status === 400) {
        try {
          const body = JSON.parse(res.text) as { accepted?: number; rejected?: number; error?: { message?: string } };
          state.acked += body.accepted ?? 0;
          state.rejected += body.rejected ?? 0;
          if (body.rejected) state.lastError = body.error?.message ?? `${body.rejected} rejected`;
        } catch {
          state.failures++;
          state.lastError = `status ${res.status}: ${res.text.slice(0, 200)}`;
        }
      } else {
        state.failures++;
        state.lastError = `status ${res.status}: ${res.text.slice(0, 200)}`;
      }
    }
  };

  const logWorker = async () => {
    if (opts.logsPerSec <= 0) return;
    const rng = new Rng((opts.seed ?? 42) ^ 0xabcdef);
    const batch = Math.max(1, Math.min(1000, Math.round(opts.logsPerSec / 4)));
    const interval = (batch / opts.logsPerSec) * 1000;
    let nextAt = performance.now();
    while (performance.now() < deadline) {
      const wait = nextAt - performance.now();
      if (wait > 0) await sleep(wait);
      if (performance.now() >= deadline) break;
      nextAt += interval;
      const now = Date.now();
      const lines: string[] = [];
      for (let i = 0; i < batch; i++) lines.push(makeLogLine(rng, now));
      const res = await send("/api/v1/logs", lines.join("\n"), { "Content-Type": "application/x-ndjson" });
      if (res.status === 200) {
        try {
          state.logsAcked += (JSON.parse(res.text) as { accepted: number }).accepted;
        } catch {
          state.failures++;
        }
      } else {
        state.failures++;
        state.lastError = `logs status ${res.status}: ${res.text.slice(0, 200)}`;
      }
    }
  };

  const reporter = opts.onReport ? setInterval(() => opts.onReport!(snapshot()), opts.reportEverySec * 1000) : null;
  try {
    await Promise.all([...Array.from({ length: opts.concurrency }, (_, w) => worker(w)), logWorker()]);
  } finally {
    if (reporter) clearInterval(reporter);
  }
  return snapshot();
}
