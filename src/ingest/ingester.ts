import type { Config } from "../shared/config.js";
import { payloadTooLarge, tooManyRequests, unavailable } from "../shared/errors.js";
import type { Counter } from "../shared/metrics.js";
import type { SqliteStore } from "../storage/store.js";
import type { Head } from "./head.js";
import { LabelError, formatSeries, normalizeLabels, seriesKey, type Label } from "./labels.js";
import type { LimitsProvider, RateLimiter } from "./limits.js";
import type { LogEntry } from "./logs.js";
import type { IncomingSeries } from "./metricsJson.js";
import { SamplesRecordBuilder } from "./records.js";
import type { SeriesRegistry } from "./registry.js";

export type RejectReason =
  | "invalid_labels"
  | "series_limit"
  | "out_of_order"
  | "duplicate_timestamp"
  | "too_old"
  | "too_far_in_future"
  | "invalid_timestamp"
  | "parse_error";

export interface IngestIssue {
  index: number;
  reason: RejectReason;
  message: string;
  series?: string;
}

export interface IngestResult {
  accepted: number;
  rejected: number;
  newSeries: number;
  errors: IngestIssue[];
}

export interface IngesterCounters {
  samplesAccepted: Counter;
  samplesRejected: Counter;
  logsAccepted: Counter;
  logBytes: Counter;
  throttled: Counter;
}

export interface IngesterDeps {
  config: Config["ingest"];
  maxStoreBacklogBytes: number;
  store: SqliteStore;
  head: Head;
  registry: SeriesRegistry;
  limits: LimitsProvider;
  rateLimiter: RateLimiter;
  counters?: IngesterCounters;
  clock?: () => number;
}

const MAX_REPORTED_ERRORS = 20;

export class Ingester {
  private readonly clock: () => number;

  constructor(private readonly d: IngesterDeps) {
    this.clock = d.clock ?? Date.now;
  }

  checkCapacity(): void {
    const { store, head, registry, config } = this.d;
    if (store.failed) throw unavailable("storage is unavailable");
    if (store.backlogBytes > this.d.maxStoreBacklogBytes) {
      this.d.counters?.throttled.inc(1, { reason: "storage_backlog" });
      throw tooManyRequests("storage write backlog is full, retry shortly", 1, "backpressure");
    }
    if (head.bytes + registry.bytes > config.headMaxBytes) {
      this.d.counters?.throttled.inc(1, { reason: "head_memory" });
      throw tooManyRequests("in-memory head is full, retry later", 10, "backpressure");
    }
  }

  private takeRate(tenant: number, kind: "samples" | "logBytes", n: number): void {
    if (n === 0) return;
    const limits = this.d.limits.get(tenant);
    const r = this.d.rateLimiter.take(tenant, kind, n, limits);
    if (r.ok) return;
    const unit = kind === "samples" ? "samples" : "log bytes";
    if (r.exceedsBurst) {
      const burst = kind === "samples" ? limits.samplesBurst : limits.logBytesBurst;
      throw payloadTooLarge(`request has ${n} ${unit}, larger than the burst limit of ${burst}; split it into smaller batches`);
    }
    this.d.counters?.throttled.inc(1, { reason: kind === "samples" ? "sample_rate" : "log_rate" });
    throw tooManyRequests(`ingest rate limit exceeded for ${unit}`, r.retryAfterSec);
  }

  async ingestSamples(tenant: number, input: IncomingSeries[], preRejected: IngestIssue[] = []): Promise<IngestResult> {
    this.checkCapacity();
    let total = 0;
    for (const s of input) total += s.samples.length;
    this.takeRate(tenant, "samples", total);

    const { config, registry, head, store } = this.d;
    const limits = this.d.limits.get(tenant);
    const now = this.clock();
    const minTs = now - config.maxSampleAgeMs;
    const maxTs = now + config.maxFutureSkewMs;
    const result: IngestResult = { accepted: 0, rejected: preRejected.length, newSeries: 0, errors: preRejected.slice(0, MAX_REPORTED_ERRORS) };
    const reject = (index: number, reason: RejectReason, message: string, count: number, labels?: Label[]) => {
      result.rejected += count;
      this.d.counters?.samplesRejected.inc(count, { reason });
      if (result.errors.length < MAX_REPORTED_ERRORS) result.errors.push({ index, reason, message, series: labels ? formatSeries(labels) : undefined });
    };

    const newSeries: Array<{ ref: number; labels: Label[]; key: string }> = [];
    const builder = new SamplesRecordBuilder(Math.max(1, Math.min(total, config.maxSamplesPerRecord)));
    const accepted: Array<[number, number, number]> = [];
    const pendingLast = new Map<number, { ts: number; value: number }>();

    for (const s of input) {
      let labels: Label[];
      try {
        labels = normalizeLabels(s.labels, config);
      } catch (err) {
        if (!(err instanceof LabelError)) throw err;
        reject(s.index, "invalid_labels", err.message, s.samples.length);
        continue;
      }
      const key = seriesKey(labels);
      let ref = registry.lookup(tenant, key);
      if (ref === undefined) {
        if (s.samples.length === 0) continue;
        if (registry.count(tenant) >= limits.maxSeries) {
          reject(s.index, "series_limit", `active series limit of ${limits.maxSeries} reached`, s.samples.length, labels);
          continue;
        }
        ref = registry.create(tenant, labels, key).ref;
        newSeries.push({ ref, labels, key });
        result.newSeries++;
      }
      let last = pendingLast.get(ref) ?? head.last(ref);
      for (const sample of s.samples) {
        const { ts, value } = sample;
        if (!Number.isFinite(ts) || !Number.isInteger(ts)) {
          reject(s.index, "invalid_timestamp", "timestamp must be an integer number of milliseconds", 1, labels);
          continue;
        }
        if (ts < minTs) {
          reject(s.index, "too_old", `sample at ${new Date(ts).toISOString()} is older than the ${config.maxSampleAgeMs / 60000} minute ingest window`, 1, labels);
          continue;
        }
        if (ts > maxTs) {
          reject(s.index, "too_far_in_future", `sample at ${new Date(ts).toISOString()} is too far in the future`, 1, labels);
          continue;
        }
        if (last) {
          if (ts < last.ts) {
            const stored = head.valueAt(ref, ts);
            if (stored !== undefined && Object.is(stored, value)) {
              result.accepted++;
              continue;
            }
            if (stored !== undefined) reject(s.index, "duplicate_timestamp", "a different value already exists for this timestamp", 1, labels);
            else reject(s.index, "out_of_order", "sample is older than the latest sample for this series", 1, labels);
            continue;
          }
          if (ts === last.ts) {
            if (Object.is(value, last.value) || value === last.value) {
              result.accepted++;
              continue;
            }
            reject(s.index, "duplicate_timestamp", "a different value already exists for this timestamp", 1, labels);
            continue;
          }
        }
        last = { ts, value };
        accepted.push([ref, ts, value]);
        result.accepted++;
      }
      if (last) pendingLast.set(ref, last);
    }

    if (newSeries.length) store.appendSeries(tenant, newSeries, now);
    for (const [ref, ts, value] of accepted) {
      builder.add(ref, ts, value);
      if (builder.size >= builder.capacity) store.appendSamples(builder.finish());
    }
    if (builder.size) store.appendSamples(builder.finish());
    for (const [ref, ts, value] of accepted) head.append(ref, ts, value);

    if (newSeries.length || accepted.length) await store.commit();
    this.d.counters?.samplesAccepted.inc(result.accepted);
    return result;
  }

  async ingestLogs(tenant: number, entries: Array<LogEntry & { line?: number }>, bodyBytes: number, preRejected: IngestIssue[] = []): Promise<IngestResult> {
    this.checkCapacity();
    this.takeRate(tenant, "logBytes", bodyBytes);
    const { config, head, store } = this.d;
    const now = this.clock();
    const minTs = now - config.maxLogAgeMs;
    const maxTs = now + config.maxFutureSkewMs;
    const result: IngestResult = { accepted: 0, rejected: preRejected.length, newSeries: 0, errors: preRejected.slice(0, MAX_REPORTED_ERRORS) };
    const ok: LogEntry[] = [];
    for (const e of entries) {
      const index = e.line ?? 0;
      if (e.ts < minTs || e.ts > maxTs) {
        result.rejected++;
        this.d.counters?.samplesRejected.inc(1, { reason: e.ts < minTs ? "log_too_old" : "log_too_far_in_future" });
        if (result.errors.length < MAX_REPORTED_ERRORS)
          result.errors.push({ index, reason: e.ts < minTs ? "too_old" : "too_far_in_future", message: `log timestamp ${new Date(e.ts).toISOString()} is outside the ingest window` });
        continue;
      }
      ok.push({ ts: e.ts, level: e.level, service: e.service, message: e.message, fields: e.fields });
    }
    if (ok.length) {
      store.appendLogs(tenant, ok);
      head.appendLogs(tenant, ok);
      await store.commit();
    }
    result.accepted = ok.length;
    this.d.counters?.logsAccepted.inc(ok.length);
    this.d.counters?.logBytes.inc(bodyBytes);
    return result;
  }
}

export function resultStatus(r: IngestResult): number {
  return r.accepted === 0 && r.rejected > 0 ? 400 : 200;
}

