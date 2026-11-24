import { describe, expect, it } from "vitest";
import { LabelError, formatSeries, normalizeLabels, sanitizeLabelName, sanitizeMetricName, seriesKey } from "../src/ingest/labels.js";
import { normalizeLevel, parseJsonLog, parseLogBody, parsePlainLog, type LogParseOptions } from "../src/ingest/logs.js";
import { parseMetricsJson, parseValue } from "../src/ingest/metricsJson.js";
import { normalizeEpoch, parseTimestamp } from "../src/ingest/timestamps.js";

const limits = { maxLabels: 5, maxLabelNameLength: 20, maxLabelValueLength: 10 };
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const logOpts: LogParseOptions = { now: NOW, maxLineBytes: 64, maxFields: 4 };

describe("labels", () => {
  it("sanitizes names", () => {
    expect(sanitizeLabelName("http.status-code")).toBe("http_status_code");
    expect(sanitizeLabelName("1abc")).toBe("_1abc");
    expect(sanitizeMetricName("node:cpu.seconds")).toBe("node:cpu_seconds");
  });

  it("sorts, drops empty values and requires a metric name", () => {
    const l = normalizeLabels(
      [
        ["zone", "b"],
        ["__name__", "up"],
        ["empty", ""],
        ["app.name", "api"]
      ],
      limits
    );
    expect(l.map((x) => x.name)).toEqual(["__name__", "app_name", "zone"]);
    expect(formatSeries(l)).toBe('up{app_name="api", zone="b"}');
    expect(() => normalizeLabels([["a", "b"]], limits)).toThrow(/metric name/);
  });

  it("rejects reserved, duplicate and oversized labels", () => {
    expect(() => normalizeLabels([["__name__", "x"], ["__meta", "y"]], limits)).toThrow(/reserved/);
    expect(() => normalizeLabels([["__name__", "x"], ["a.b", "1"], ["a_b", "2"]], limits)).toThrow(/duplicate/);
    expect(() => normalizeLabels([["__name__", "x"], ["a", "x".repeat(11)]], limits)).toThrow(/longer than 10/);
    expect(() => normalizeLabels([["__name__", "x"], ["a".repeat(21), "1"]], limits)).toThrow(LabelError);
    const many = Array.from({ length: 5 }, (_, i) => [`l${i}`, "v"] as [string, string]);
    expect(() => normalizeLabels([["__name__", "x"], ...many], limits)).toThrow(/limit is 5/);
  });

  it("builds keys that cannot collide through separators", () => {
    const a = seriesKey([{ name: "a", value: "b1:c" }]);
    const b = seriesKey([{ name: "a", value: "b" }, { name: "1:c", value: "" }]);
    expect(a).not.toBe(b);
  });
});

describe("timestamps", () => {
  it("normalizes seconds, millis, micros and nanos", () => {
    expect(normalizeEpoch(1_795_000_000)).toBe(1_795_000_000_000);
    expect(normalizeEpoch(1_795_000_000.25)).toBe(1_795_000_000_250);
    expect(normalizeEpoch(1_795_000_000_123)).toBe(1_795_000_000_123);
    expect(normalizeEpoch(1_795_000_000_123_456)).toBe(1_795_000_000_123);
    expect(normalizeEpoch(1_795_000_000_123_456_789)).toBe(1_795_000_000_123);
  });

  it("parses ISO, local-style and numeric strings", () => {
    expect(parseTimestamp("2026-11-24T12:00:00Z")).toBe(NOW);
    expect(parseTimestamp("2026-11-24 12:00:00,500")).toBe(NOW + 500);
    expect(parseTimestamp("2026-11-24T17:30:00+05:30")).toBe(NOW);
    expect(parseTimestamp("1795000000")).toBe(1_795_000_000_000);
    expect(parseTimestamp("not a date")).toBeUndefined();
    expect(parseTimestamp(NaN)).toBeUndefined();
    expect(parseTimestamp({})).toBeUndefined();
  });
});

describe("metrics JSON", () => {
  it("parses NDJSON with single values and sample arrays", () => {
    const body = [
      JSON.stringify({ name: "cpu", labels: { host: "a", core: 1 }, value: 0.5, ts: NOW }),
      "",
      JSON.stringify({ name: "mem", samples: [[NOW, 1], [NOW + 1000, "+Inf"]] }),
      JSON.stringify({ name: "now", value: "NaN" })
    ].join("\n");
    const { series, issues } = parseMetricsJson(body, NOW);
    expect(issues).toEqual([]);
    expect(series[0]).toEqual({ index: 0, labels: [["__name__", "cpu"], ["host", "a"], ["core", "1"]], samples: [{ ts: NOW, value: 0.5 }] });
    expect(series[1]!.samples[1]).toEqual({ ts: NOW + 1000, value: Infinity });
    expect(series[2]!.samples[0]!.ts).toBe(NOW);
    expect(Number.isNaN(series[2]!.samples[0]!.value)).toBe(true);
  });

  it("parses a JSON array and reports per-item problems", () => {
    const { series, issues } = parseMetricsJson(
      JSON.stringify([{ name: "ok", value: 1 }, { value: 1 }, { name: "x", value: "abc" }, { name: "y", labels: { __name__: "z" }, value: 1 }, { name: "t", value: 1, ts: "soon" }]),
      NOW
    );
    expect(series).toHaveLength(1);
    expect(issues.map((i) => i.index)).toEqual([1, 2, 3, 4]);
    expect(parseMetricsJson("{not json", NOW).issues[0]!.reason).toMatch(/invalid JSON/);
    expect(parseValue("-Inf")).toBe(-Infinity);
    expect(parseValue(" ")).toBeUndefined();
  });
});

describe("log parsing", () => {
  it("normalizes levels from names and pino numbers", () => {
    expect(normalizeLevel("WARNING")).toBe("warn");
    expect(normalizeLevel("crit")).toBe("fatal");
    expect(normalizeLevel(30)).toBe("info");
    expect(normalizeLevel(50)).toBe("error");
    expect(normalizeLevel("loud")).toBe("unknown");
  });

  it("maps common JSON log shapes and flattens fields", () => {
    const e = parseJsonLog({ time: "2026-11-24T12:00:00Z", severity: "ERROR", msg: "boom", service: { name: "pay" }, http: { status: 500 }, tags: ["a"] }, logOpts);
    expect(e).toEqual({ ts: NOW, level: "error", service: "pay", message: "boom", fields: { "http.status": "500", tags: '["a"]' } });
  });

  it("uses defaults, caps fields and truncates long messages", () => {
    const e = parseJsonLog({ message: "é".repeat(100), a: 1, b: 2, c: 3, d: 4, e: 5 }, { ...logOpts, defaultService: "web", extraFields: { host: "h1" } });
    expect(e.service).toBe("web");
    expect(e.ts).toBe(NOW);
    expect(Buffer.byteLength(e.message)).toBeLessThanOrEqual(64);
    expect(e.fields).toMatchObject({ host: "h1", a: "1", b: "2", c: "3", _dropped_fields: "2", _truncated: "true" });
    const noMsg = parseJsonLog({ user: "u1" }, logOpts);
    expect(noMsg.message).toBe('{"user":"u1"}');
  });

  it("parses plain lines with timestamps, levels and logfmt", () => {
    const a = parsePlainLog("2026-11-24 12:00:00,250 [ERROR] payment failed for order 42", logOpts);
    expect(a).toMatchObject({ ts: NOW + 250, level: "error", message: "payment failed for order 42", service: "unknown" });
    const b = parsePlainLog('ts=2026-11-24T12:00:00Z level=warn service=api msg="slow request" duration=1.2s', logOpts);
    expect(b).toEqual({ ts: NOW, level: "warn", service: "api", message: "slow request", fields: { duration: "1.2s" } });
    const c = parsePlainLog("just some text", logOpts);
    expect(c).toMatchObject({ ts: NOW, level: "unknown", message: "just some text" });
  });

  it("parses bodies line by line and keeps going after bad lines", () => {
    const r = parseLogBody(['{"msg":"a"}', "nope", "[1]", '{"msg":"b"}'].join("\n"), "json", logOpts);
    expect(r.entries.map((e) => [e.line, e.message])).toEqual([
      [1, "a"],
      [4, "b"]
    ]);
    expect(r.errors.map((e) => e.line)).toEqual([2, 3]);
    const arr = parseLogBody(JSON.stringify([{ msg: "x" }, "INFO plain", 5]), "json", logOpts);
    expect(arr.entries.map((e) => e.message)).toEqual(["x", "plain"]);
    expect(arr.errors).toHaveLength(1);
    expect(parseLogBody("line one\r\n\r\nline two", "text", logOpts).entries).toHaveLength(2);
  });
});
