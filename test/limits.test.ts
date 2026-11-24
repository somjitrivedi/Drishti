import { describe, expect, it } from "vitest";
import { RateLimiter, TokenBucket } from "../src/ingest/limits.js";
import { defaultConfig } from "../src/shared/config.js";
import { MetricsRegistry } from "../src/shared/metrics.js";

describe("token bucket", () => {
  it("allows the burst then refills at the rate", () => {
    let now = 0;
    const b = new TokenBucket(100, 200, () => now);
    expect(b.take(200)).toEqual({ ok: true });
    const denied = b.take(50);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.retryAfterSec).toBeCloseTo(0.5);
    now += 500;
    expect(b.take(50)).toEqual({ ok: true });
    now += 10_000;
    expect(b.available()).toBe(200);
    expect(b.take(201)).toEqual({ ok: false, retryAfterSec: 1, exceedsBurst: true });
  });

  it("applies new limits to an existing tenant bucket", () => {
    let now = 0;
    const r = new RateLimiter(() => now);
    const limits = { ...defaultConfig().limits, samplesPerSec: 10, samplesBurst: 10 };
    expect(r.take(1, "samples", 10, limits).ok).toBe(true);
    expect(r.take(1, "samples", 1, limits).ok).toBe(false);
    expect(r.take(2, "samples", 10, limits).ok).toBe(true);
    now += 1000;
    expect(r.take(1, "samples", 20, { ...limits, samplesPerSec: 20, samplesBurst: 20 }).ok).toBe(false);
    now += 1000;
    expect(r.take(1, "samples", 20, { ...limits, samplesPerSec: 20, samplesBurst: 20 }).ok).toBe(true);
  });
});

describe("self metrics", () => {
  it("renders Prometheus exposition text", () => {
    const m = new MetricsRegistry();
    const c = m.counter("x_total", "things");
    c.inc(2, { reason: 'a"b' });
    m.gauge("g", "gauge", () => 3);
    const h = m.histogram("h_seconds", "latency", [0.1, 1]);
    h.observe(0.05);
    h.observe(5);
    const text = m.render();
    expect(text).toContain('x_total{reason="a\\"b"} 2');
    expect(text).toContain("g 3");
    expect(text).toContain('h_seconds_bucket{le="0.1"} 1');
    expect(text).toContain('h_seconds_bucket{le="+Inf"} 2');
    expect(text).toContain("h_seconds_count 2");
  });
});
