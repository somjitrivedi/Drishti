import { parseTimestamp } from "./timestamps.js";

export type LogLevelName = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "unknown";

export interface LogEntry {
  ts: number;
  level: LogLevelName;
  service: string;
  message: string;
  fields: Record<string, string>;
}

export interface LogParseOptions {
  now: number;
  defaultService?: string;
  extraFields?: Record<string, string>;
  maxLineBytes: number;
  maxFields: number;
}

export interface LogParseError {
  line: number;
  reason: string;
}

export interface LogParseResult {
  entries: Array<LogEntry & { line: number }>;
  errors: LogParseError[];
}

const levelAliases: Record<string, LogLevelName> = {
  trace: "trace",
  trc: "trace",
  debug: "debug",
  dbg: "debug",
  info: "info",
  information: "info",
  informational: "info",
  notice: "info",
  inf: "info",
  warn: "warn",
  warning: "warn",
  wrn: "warn",
  error: "error",
  err: "error",
  eror: "error",
  fatal: "fatal",
  critical: "fatal",
  crit: "fatal",
  panic: "fatal",
  emerg: "fatal",
  emergency: "fatal",
  alert: "fatal"
};

export function normalizeLevel(v: unknown): LogLevelName {
  if (typeof v === "number") {
    if (v <= 10) return "trace";
    if (v <= 20) return "debug";
    if (v <= 30) return "info";
    if (v <= 40) return "warn";
    if (v <= 50) return "error";
    return "fatal";
  }
  if (typeof v !== "string") return "unknown";
  return levelAliases[v.trim().toLowerCase()] ?? "unknown";
}

const TS_KEYS = ["ts", "timestamp", "time", "@timestamp", "t", "datetime"];
const LEVEL_KEYS = ["level", "severity", "lvl", "loglevel", "log.level", "levelname"];
const MESSAGE_KEYS = ["message", "msg", "log", "text", "@message"];
const SERVICE_KEYS = ["service", "service.name", "app", "application", "logger_name"];

function truncateUtf8(s: string, maxBytes: number): { value: string; truncated: boolean } {
  if (s.length * 3 <= maxBytes) return { value: s, truncated: false };
  const b = Buffer.from(s, "utf8");
  if (b.length <= maxBytes) return { value: s, truncated: false };
  return { value: b.toString("utf8", 0, maxBytes).replace(/�+$/, ""), truncated: true };
}

function stringify(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return JSON.stringify(v);
}

function flatten(obj: Record<string, unknown>, prefix: string, depth: number, out: Map<string, unknown>): void {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v) && depth < 4) flatten(v as Record<string, unknown>, key, depth + 1, out);
    else out.set(key, v);
  }
}

function takeFirst(flat: Map<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (flat.has(k)) {
      const v = flat.get(k);
      flat.delete(k);
      if (v !== undefined && v !== null && v !== "") return v;
    }
  }
  return undefined;
}

function finishEntry(
  ts: number,
  level: LogLevelName,
  service: string,
  message: string,
  fields: Map<string, unknown>,
  opts: LogParseOptions
): LogEntry {
  const out: Record<string, string> = {};
  let count = 0;
  let dropped = 0;
  const add = (k: string, v: unknown) => {
    const s = stringify(v);
    if (s === undefined || k.length === 0 || k.length > 128) return;
    if (count >= opts.maxFields) {
      dropped++;
      return;
    }
    out[k] = s.length > 2048 ? s.slice(0, 2048) : s;
    count++;
  };
  if (opts.extraFields) for (const [k, v] of Object.entries(opts.extraFields)) add(k, v);
  for (const [k, v] of fields) if (!(k in out)) add(k, v);
  if (dropped) out._dropped_fields = String(dropped);
  const t = truncateUtf8(message, opts.maxLineBytes);
  if (t.truncated) out._truncated = "true";
  return { ts, level, service, message: t.value, fields: out };
}

export function parseJsonLog(obj: Record<string, unknown>, opts: LogParseOptions): LogEntry {
  const flat = new Map<string, unknown>();
  flatten(obj, "", 0, flat);
  const rawTs = takeFirst(flat, TS_KEYS);
  const ts = parseTimestamp(rawTs) ?? opts.now;
  const level = normalizeLevel(takeFirst(flat, LEVEL_KEYS));
  const service = stringify(takeFirst(flat, SERVICE_KEYS)) ?? opts.defaultService ?? "unknown";
  const rawMessage = takeFirst(flat, MESSAGE_KEYS);
  const message = rawMessage === undefined ? JSON.stringify(Object.fromEntries(flat)) : (stringify(rawMessage) ?? "");
  if (rawMessage === undefined) flat.clear();
  if (rawTs !== undefined && parseTimestamp(rawTs) === undefined) flat.set("_ts_unparsed", stringify(rawTs));
  return finishEntry(ts, level, service, message, flat, opts);
}

const TS_PATTERNS: RegExp[] = [
  /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s+/,
  /^\[?(\d{13}|\d{10}(?:\.\d{1,6})?)\]?\s+/
];
const LEVEL_PREFIX = /^[[(<]?(trace|debug|dbg|info|notice|warn|warning|error|err|fatal|critical|crit|panic)[\])>]?:?\s+/i;
const LOGFMT_PAIR = /(?:^|\s)([A-Za-z_][\w.\-]*)=("(?:[^"\\]|\\.)*"|[^\s"]*)/g;

export function parsePlainLog(line: string, opts: LogParseOptions): LogEntry {
  let rest = line;
  let ts: number | undefined;
  for (const p of TS_PATTERNS) {
    const m = p.exec(rest);
    if (m) {
      ts = parseTimestamp(m[1]!.replace(" ", "T"));
      if (ts !== undefined) {
        rest = rest.slice(m[0].length);
        break;
      }
    }
  }
  let level: LogLevelName = "unknown";
  const lm = LEVEL_PREFIX.exec(rest);
  if (lm) {
    level = normalizeLevel(lm[1]);
    rest = rest.slice(lm[0].length);
  }
  const fields = new Map<string, unknown>();
  let message = rest;
  LOGFMT_PAIR.lastIndex = 0;
  let pair: RegExpExecArray | null;
  while ((pair = LOGFMT_PAIR.exec(rest)) !== null) {
    let v = pair[2]!;
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v) as string;
      } catch {
        v = v.slice(1, -1);
      }
    }
    fields.set(pair[1]!, v);
  }
  if (fields.size) {
    const lvl = takeFirst(fields, LEVEL_KEYS);
    if (lvl !== undefined && level === "unknown") level = normalizeLevel(lvl);
    const t = takeFirst(fields, TS_KEYS);
    if (t !== undefined && ts === undefined) ts = parseTimestamp(t);
    const msg = takeFirst(fields, MESSAGE_KEYS);
    if (msg !== undefined) message = String(msg);
  }
  const svc = takeFirst(fields, SERVICE_KEYS);
  const service = (svc === undefined ? undefined : String(svc)) ?? opts.defaultService ?? "unknown";
  return finishEntry(ts ?? opts.now, level, service, message, fields, opts);
}

export function parseLogBody(body: string, mode: "json" | "text", opts: LogParseOptions): LogParseResult {
  const result: LogParseResult = { entries: [], errors: [] };
  const trimmed = body.trimStart();
  if (mode === "json" && trimmed.startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(trimmed);
    } catch (err) {
      result.errors.push({ line: 1, reason: `invalid JSON: ${(err as Error).message}` });
      return result;
    }
    if (!Array.isArray(arr)) {
      result.errors.push({ line: 1, reason: "expected a JSON array" });
      return result;
    }
    arr.forEach((item, i) => {
      if (item && typeof item === "object" && !Array.isArray(item)) result.entries.push({ ...parseJsonLog(item as Record<string, unknown>, opts), line: i + 1 });
      else if (typeof item === "string") result.entries.push({ ...parsePlainLog(item, opts), line: i + 1 });
      else result.errors.push({ line: i + 1, reason: "entry must be an object or string" });
    });
    return result;
  }
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    if (mode === "json") {
      let obj: unknown;
      try {
        obj = JSON.parse(raw);
      } catch (err) {
        result.errors.push({ line: i + 1, reason: `invalid JSON: ${(err as Error).message}` });
        continue;
      }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        result.errors.push({ line: i + 1, reason: "line must be a JSON object" });
        continue;
      }
      result.entries.push({ ...parseJsonLog(obj as Record<string, unknown>, opts), line: i + 1 });
    } else {
      result.entries.push({ ...parsePlainLog(raw.trimEnd(), opts), line: i + 1 });
    }
  }
  return result;
}
