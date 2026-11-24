import type { LogEntry } from "./logs.js";

const CHUNK = 512;
const LOG_OVERHEAD_BYTES = 96;

class SeriesBuffer {
  ts: Float64Array[] = [];
  vals: Float64Array[] = [];
  len = 0;
  lastTs = -Infinity;
  lastValue = NaN;
  firstTs = Infinity;

  append(ts: number, value: number): boolean {
    const i = this.len % CHUNK;
    let grew = false;
    if (i === 0) {
      this.ts.push(new Float64Array(CHUNK));
      this.vals.push(new Float64Array(CHUNK));
      grew = true;
    }
    this.ts[this.ts.length - 1]![i] = ts;
    this.vals[this.vals.length - 1]![i] = value;
    this.len++;
    this.lastTs = ts;
    this.lastValue = value;
    if (ts < this.firstTs) this.firstTs = ts;
    return grew;
  }
}

export interface SampleRange {
  ts: number[];
  values: number[];
}

export interface SeriesSummary {
  samples: number;
  firstTs: number | null;
  lastTs: number | null;
  lastValue: number | null;
}

export interface LogQuery {
  service?: string;
  level?: string;
  contains?: string;
  from?: number;
  to?: number;
  limit: number;
}

export class Head {
  private series = new Map<number, SeriesBuffer>();
  private logsByTenant = new Map<number, LogEntry[]>();
  private sampleBytes = 0;
  private logBytes = 0;
  private samplesTotal = 0;
  private logsTotal = 0;

  append(ref: number, ts: number, value: number): void {
    let s = this.series.get(ref);
    if (!s) {
      s = new SeriesBuffer();
      this.series.set(ref, s);
    }
    if (s.append(ts, value)) this.sampleBytes += CHUNK * 16;
    this.samplesTotal++;
  }

  last(ref: number): { ts: number; value: number } | undefined {
    const s = this.series.get(ref);
    return s && s.len > 0 ? { ts: s.lastTs, value: s.lastValue } : undefined;
  }

  valueAt(ref: number, ts: number): number | undefined {
    const s = this.series.get(ref);
    if (!s) return undefined;
    let lo = 0;
    let hi = s.len - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const t = s.ts[Math.floor(mid / CHUNK)]![mid % CHUNK]!;
      if (t === ts) return s.vals[Math.floor(mid / CHUNK)]![mid % CHUNK]!;
      if (t < ts) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  }

  summary(ref: number): SeriesSummary {
    const s = this.series.get(ref);
    if (!s || s.len === 0) return { samples: 0, firstTs: null, lastTs: null, lastValue: null };
    return { samples: s.len, firstTs: s.firstTs, lastTs: s.lastTs, lastValue: s.lastValue };
  }

  range(ref: number, from = -Infinity, to = Infinity, limit = Infinity): SampleRange {
    const out: SampleRange = { ts: [], values: [] };
    const s = this.series.get(ref);
    if (!s) return out;
    for (let i = 0; i < s.len && out.ts.length < limit; i++) {
      const c = Math.floor(i / CHUNK);
      const j = i % CHUNK;
      const t = s.ts[c]![j]!;
      if (t < from || t > to) continue;
      out.ts.push(t);
      out.values.push(s.vals[c]![j]!);
    }
    return out;
  }

  appendLogs(tenant: number, entries: LogEntry[]): void {
    let list = this.logsByTenant.get(tenant);
    if (!list) {
      list = [];
      this.logsByTenant.set(tenant, list);
    }
    for (const e of entries) {
      list.push(e);
      this.logBytes += LOG_OVERHEAD_BYTES + logEntrySize(e);
    }
    this.logsTotal += entries.length;
  }

  queryLogs(tenant: number, q: LogQuery): LogEntry[] {
    const list = this.logsByTenant.get(tenant) ?? [];
    const out: LogEntry[] = [];
    const needle = q.contains?.toLowerCase();
    for (let i = list.length - 1; i >= 0 && out.length < q.limit; i--) {
      const e = list[i]!;
      if (q.service && e.service !== q.service) continue;
      if (q.level && e.level !== q.level) continue;
      if (q.from !== undefined && e.ts < q.from) continue;
      if (q.to !== undefined && e.ts > q.to) continue;
      if (needle && !e.message.toLowerCase().includes(needle)) continue;
      out.push(e);
    }
    return out;
  }

  logCount(tenant?: number): number {
    if (tenant === undefined) return this.logsTotal;
    return this.logsByTenant.get(tenant)?.length ?? 0;
  }

  get sampleCount(): number {
    return this.samplesTotal;
  }

  get seriesWithData(): number {
    return this.series.size;
  }

  get bytes(): number {
    return this.sampleBytes + this.logBytes;
  }
}

export function logEntrySize(e: LogEntry): number {
  let n = e.message.length + e.service.length + e.level.length + 8;
  for (const k in e.fields) n += k.length + e.fields[k]!.length;
  return n;
}
