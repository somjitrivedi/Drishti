import { METRIC_NAME } from "./labels.js";
import { parseTimestamp } from "./timestamps.js";

export interface IncomingSample {
  ts: number;
  value: number;
}

export interface IncomingSeries {
  index: number;
  labels: Array<[string, string]>;
  samples: IncomingSample[];
}

export interface ParseIssue {
  index: number;
  reason: string;
}

export function parseValue(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s === "NaN") return NaN;
  if (s === "Inf" || s === "+Inf") return Infinity;
  if (s === "-Inf") return -Infinity;
  if (s === "") return undefined;
  const n = Number(s);
  return Number.isNaN(n) ? undefined : n;
}

function parseItem(item: unknown, index: number, now: number): IncomingSeries | ParseIssue {
  if (!item || typeof item !== "object" || Array.isArray(item)) return { index, reason: "item must be an object" };
  const o = item as Record<string, unknown>;
  const name = o.name ?? o.metric;
  if (typeof name !== "string" || !name) return { index, reason: "name is required" };
  const labels: Array<[string, string]> = [[METRIC_NAME, name]];
  if (o.labels !== undefined) {
    if (!o.labels || typeof o.labels !== "object" || Array.isArray(o.labels)) return { index, reason: "labels must be an object" };
    for (const [k, v] of Object.entries(o.labels as Record<string, unknown>)) {
      if (k === METRIC_NAME) return { index, reason: "labels must not contain __name__" };
      if (typeof v === "number" || typeof v === "boolean") labels.push([k, String(v)]);
      else if (typeof v === "string") labels.push([k, v]);
      else return { index, reason: `label ${k} must be a string` };
    }
  }
  const samples: IncomingSample[] = [];
  if (o.samples !== undefined) {
    if (!Array.isArray(o.samples)) return { index, reason: "samples must be an array of [ts, value]" };
    for (const s of o.samples) {
      if (!Array.isArray(s) || s.length !== 2) return { index, reason: "each sample must be [ts, value]" };
      const ts = parseTimestamp(s[0]);
      const value = parseValue(s[1]);
      if (ts === undefined) return { index, reason: "invalid sample timestamp" };
      if (value === undefined) return { index, reason: "invalid sample value" };
      samples.push({ ts, value });
    }
  } else {
    const value = parseValue(o.value);
    if (value === undefined) return { index, reason: "value is required and must be a number" };
    const ts = o.ts === undefined && o.timestamp === undefined ? now : parseTimestamp(o.ts ?? o.timestamp);
    if (ts === undefined) return { index, reason: "invalid timestamp" };
    samples.push({ ts, value });
  }
  return { index, labels, samples };
}

export function parseMetricsJson(body: string, now: number): { series: IncomingSeries[]; issues: ParseIssue[] } {
  const series: IncomingSeries[] = [];
  const issues: ParseIssue[] = [];
  const push = (r: IncomingSeries | ParseIssue) => {
    if ("samples" in r) series.push(r);
    else issues.push(r);
  };
  const trimmed = body.trimStart();
  if (trimmed.startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(trimmed);
    } catch (err) {
      return { series, issues: [{ index: 0, reason: `invalid JSON: ${(err as Error).message}` }] };
    }
    if (!Array.isArray(arr)) return { series, issues: [{ index: 0, reason: "expected a JSON array" }] };
    arr.forEach((item, i) => push(parseItem(item, i, now)));
    return { series, issues };
  }
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    let item: unknown;
    try {
      item = JSON.parse(line);
    } catch (err) {
      issues.push({ index: i, reason: `invalid JSON: ${(err as Error).message}` });
      continue;
    }
    push(parseItem(item, i, now));
  }
  return { series, issues };
}
