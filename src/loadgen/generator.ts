import { encodeWriteRequest, type RwTimeSeries } from "../codec/remoteWrite.js";
import { snappyCompress } from "../codec/snappy.js";

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)]!;
  }
}

export type SeriesKind = "counter" | "gauge" | "latency";

export interface SeriesSpec {
  labels: Array<[string, string]>;
  kind: SeriesKind;
  value: number;
  lastTs: number;
}

const REGIONS = ["ap-south-1", "ap-southeast-1", "eu-west-1", "us-east-1"];
const SERVICES = ["api", "checkout", "payments", "search", "auth", "catalog", "notifications", "orders"];
const ROUTES = ["/", "/login", "/cart", "/checkout", "/search", "/product", "/orders", "/health"];
const METHODS = ["GET", "POST"];
const STATUSES = ["200", "201", "400", "404", "500"];

const TEMPLATES: Array<{ name: string; kind: SeriesKind; extra: (rng: Rng) => Array<[string, string]> }> = [
  { name: "http_requests_total", kind: "counter", extra: (r) => [["method", r.pick(METHODS)], ["route", r.pick(ROUTES)], ["status", r.pick(STATUSES)]] },
  { name: "http_request_duration_seconds", kind: "latency", extra: (r) => [["route", r.pick(ROUTES)]] },
  { name: "node_cpu_seconds_total", kind: "counter", extra: (r) => [["cpu", String(r.int(16))], ["mode", r.pick(["user", "system", "idle", "iowait"])]] },
  { name: "node_memory_used_bytes", kind: "gauge", extra: () => [] },
  { name: "process_open_fds", kind: "gauge", extra: () => [] },
  { name: "queue_depth", kind: "gauge", extra: (r) => [["queue", r.pick(["email", "sms", "webhooks", "invoices"])]] }
];

export function buildSeries(count: number, seed = 42): SeriesSpec[] {
  const rng = new Rng(seed);
  const out: SeriesSpec[] = [];
  const seen = new Set<string>();
  let host = 0;
  let attempts = 0;
  while (out.length < count && attempts < count * 20) {
    attempts++;
    const t = TEMPLATES[out.length % TEMPLATES.length]!;
    const labels: Array<[string, string]> = [
      ["__name__", t.name],
      ["host", `host-${String(host).padStart(4, "0")}`],
      ["region", REGIONS[host % REGIONS.length]!],
      ["service", SERVICES[host % SERVICES.length]!],
      ...t.extra(rng),
      ["series_id", String(out.length)]
    ];
    const key = labels.map((l) => l.join("=")).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.length % 50 === 49) host++;
    const value = t.kind === "counter" ? rng.int(100000) : t.kind === "latency" ? 0.05 + rng.next() * 0.2 : 1e6 + rng.int(1e9);
    out.push({ labels, kind: t.kind, value, lastTs: 0 });
  }
  return out;
}

export function advance(spec: SeriesSpec, rng: Rng, now: number): { ts: number; value: number } {
  const ts = now > spec.lastTs ? now : spec.lastTs + 1;
  spec.lastTs = ts;
  switch (spec.kind) {
    case "counter":
      spec.value += rng.int(20);
      break;
    case "gauge":
      spec.value = Math.max(0, Math.round(spec.value * (0.98 + rng.next() * 0.04)));
      break;
    case "latency":
      spec.value = Math.round(Math.max(0.001, spec.value * (0.9 + rng.next() * 0.2)) * 1e4) / 1e4;
      break;
  }
  return { ts, value: spec.value };
}

export function encodeJsonBatch(series: RwTimeSeries[]): string {
  const lines: string[] = [];
  for (const s of series) {
    const name = s.labels.find((l) => l[0] === "__name__")?.[1];
    const labels: Record<string, string> = {};
    for (const [k, v] of s.labels) if (k !== "__name__") labels[k] = v;
    for (const p of s.samples) lines.push(JSON.stringify({ name, labels, value: p.value, ts: p.timestamp }));
  }
  return lines.join("\n");
}

export function encodeRemoteWriteBatch(series: RwTimeSeries[]): Uint8Array {
  return snappyCompress(encodeWriteRequest(series));
}

const LOG_MESSAGES = [
  "request completed",
  "cache miss for key",
  "payment authorised",
  "retrying upstream call",
  "connection reset by peer",
  "user logged in",
  "order placed",
  "slow query detected"
];

export function makeLogLine(rng: Rng, now: number): string {
  const level = rng.next() < 0.8 ? "info" : rng.next() < 0.7 ? "warn" : "error";
  return JSON.stringify({
    ts: now,
    level,
    service: rng.pick(SERVICES),
    msg: rng.pick(LOG_MESSAGES),
    host: `host-${String(rng.int(200)).padStart(4, "0")}`,
    route: rng.pick(ROUTES),
    status: rng.pick(STATUSES),
    duration_ms: rng.int(900),
    trace_id: Math.floor(rng.next() * 2 ** 52).toString(16)
  });
}
