import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { encodeWriteRequest } from "../src/codec/remoteWrite.js";
import { snappyCompress } from "../src/codec/snappy.js";
import { startApp, type App } from "../src/server/app.js";
import type { Config, DeepPartial } from "../src/shared/config.js";
import { addKey, seedTenant, testConfig } from "./helpers.js";

const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function boot(overrides: DeepPartial<Config> = {}) {
  const config = testConfig(overrides);
  const tenant = seedTenant(config);
  const app = await startApp(config);
  apps.push(app);
  const call = (path: string, init: RequestInit & { key?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    const key = init.key === undefined ? tenant.key : init.key;
    if (key) headers.set("Authorization", `Bearer ${key}`);
    return fetch(app.url + path, { ...init, headers });
  };
  return { app, config, tenant, call };
}

const now = () => Date.now();

describe("http api", () => {
  it("serves health, readiness and self metrics without auth", async () => {
    const { call } = await boot();
    expect((await call("/healthz", { key: null })).status).toBe(200);
    expect(await (await call("/readyz", { key: null })).json()).toEqual({ status: "ready" });
    const m = await call("/metrics", { key: null });
    expect(m.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await m.text()).toContain("drishti_head_series");
  });

  it("requires a valid key and the right scope", async () => {
    const { call, config, tenant } = await boot();
    expect((await call("/api/v1/me", { key: null })).status).toBe(401);
    expect((await call("/api/v1/me", { key: "drk_000000000000_" + "x".repeat(43) })).status).toBe(401);
    const ingestOnly = addKey(config, tenant.orgId, ["ingest"]);
    expect((await call("/api/v1/debug/stats", { key: ingestOnly })).status).toBe(403);
    expect((await call("/api/v1/keys", { key: ingestOnly })).status).toBe(403);
    const me = await (await call("/api/v1/me", { key: ingestOnly })).json();
    expect(me).toMatchObject({ org: { slug: "acme" }, key: { scopes: ["ingest"] } });
    expect((await call("/api/v1/nope")).status).toBe(404);
    const wrong = await call("/api/v1/write", { method: "GET" });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
  });

  it("accepts Prometheus remote write and exposes the data", async () => {
    const { call } = await boot();
    const t = now();
    const body = snappyCompress(
      encodeWriteRequest([
        { labels: [["__name__", "http_requests_total"], ["job", "api"]], samples: [{ value: 1, timestamp: t - 1000 }, { value: 4, timestamp: t }] },
        { labels: [["__name__", "up"], ["job", "api"]], samples: [{ value: 1, timestamp: t }] }
      ])
    );
    const res = await call("/api/v1/write", { method: "POST", body, headers: { "Content-Encoding": "snappy", "Content-Type": "application/x-protobuf" } });
    expect(res.status).toBe(204);
    const stats = await (await call("/api/v1/debug/stats")).json();
    expect(stats.tenant).toEqual({ series: 2, samples: 3, logs: 0 });
    const s = await (await call("/api/v1/debug/series?name=http_requests_total&samples=true")).json();
    expect(s.series[0]).toMatchObject({ series: 'http_requests_total{job="api"}', samples: 2, lastValue: 4, points: [[t - 1000, 1], [t, 4]] });
    const filtered = await (await call("/api/v1/debug/series?label=job=api&prefix=u")).json();
    expect(filtered.matched).toBe(1);
  });

  it("reports partial remote-write rejections with 400", async () => {
    const { call } = await boot();
    const t = now();
    const body = snappyCompress(
      encodeWriteRequest([
        { labels: [["__name__", "ok"]], samples: [{ value: 1, timestamp: t }] },
        { labels: [["job", "no-name"]], samples: [{ value: 1, timestamp: t }] }
      ])
    );
    const res = await call("/api/v1/write", { method: "POST", body, headers: { "Content-Encoding": "snappy" } });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({ accepted: 1, rejected: 1, error: { code: "partial_write" } });
    const bad = await call("/api/v1/write", { method: "POST", body: Buffer.from("not snappy at all") });
    expect(bad.status).toBe(400);
  });

  it("accepts gzip NDJSON metrics and reports per-line errors", async () => {
    const { call } = await boot();
    const t = now();
    const lines = [JSON.stringify({ name: "cpu", labels: { host: "a" }, value: 0.7, ts: t }), "garbage", JSON.stringify({ name: "cpu", labels: { host: "b" }, value: 0.2 })];
    const res = await call("/api/v1/metrics", {
      method: "POST",
      body: gzipSync(lines.join("\n")),
      headers: { "Content-Type": "application/x-ndjson", "Content-Encoding": "gzip" }
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ accepted: 2, rejected: 1, newSeries: 2 });
    expect(json.errors[0]).toMatchObject({ index: 1, reason: "parse_error" });
    const allBad = await call("/api/v1/metrics", { method: "POST", body: "nope", headers: { "Content-Type": "application/json" } });
    expect(allBad.status).toBe(400);
    expect((await call("/api/v1/metrics", { method: "POST", body: "x", headers: { "Content-Type": "image/png" } })).status).toBe(415);
    expect((await call("/api/v1/metrics", { method: "POST", body: "x", headers: { "Content-Encoding": "br" } })).status).toBe(415);
  });

  it("ingests JSON and plain-text logs with stream fields from the query string", async () => {
    const { call } = await boot();
    const json = await call("/api/v1/logs", {
      method: "POST",
      body: [JSON.stringify({ level: "error", msg: "card declined", service: "payments", order: 42 }), JSON.stringify({ msg: "ok" })].join("\n"),
      headers: { "Content-Type": "application/x-ndjson" }
    });
    expect(await json.json()).toMatchObject({ accepted: 2, rejected: 0 });
    const text = await call("/api/v1/logs?service=nginx&host=web-1", {
      method: "POST",
      body: "2026-11-24T10:00:00Z WARN upstream slow\nplain line",
      headers: { "Content-Type": "text/plain" }
    });
    expect(text.status).toBe(200);
    const errors = await (await call("/api/v1/debug/logs?level=error")).json();
    expect(errors.entries).toHaveLength(1);
    expect(errors.entries[0]).toMatchObject({ service: "payments", message: "card declined", fields: { order: "42" } });
    const nginx = await (await call("/api/v1/debug/logs?service=nginx&contains=PLAIN")).json();
    expect(nginx.entries).toEqual([expect.objectContaining({ message: "plain line", fields: { host: "web-1" } })]);
  });

  it("rejects bodies over the tenant limit with 413", async () => {
    const { call } = await boot({ limits: { maxBodyBytes: 1024 } });
    const big = "x".repeat(5000);
    const res = await call("/api/v1/logs", { method: "POST", body: big, headers: { "Content-Type": "text/plain" } });
    expect(res.status).toBe(413);
    const bomb = gzipSync(Buffer.alloc(100_000, 0x61));
    expect(bomb.length).toBeLessThan(1024);
    const res2 = await call("/api/v1/logs", { method: "POST", body: bomb, headers: { "Content-Type": "text/plain", "Content-Encoding": "gzip" } });
    expect(res2.status).toBe(413);
  });

  it("returns 429 with Retry-After when the tenant is over its rate", async () => {
    const { call } = await boot({ limits: { samplesPerSec: 5, samplesBurst: 5 } });
    const t = now();
    const send = (n: number, offset: number) =>
      call("/api/v1/metrics", {
        method: "POST",
        body: Array.from({ length: n }, (_, i) => JSON.stringify({ name: "m", value: i, ts: t + offset + i })).join("\n"),
        headers: { "Content-Type": "application/x-ndjson" }
      });
    expect((await send(5, 0)).status).toBe(200);
    const limited = await send(3, 10);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await send(6, 20)).status).toBe(413);
  });

  it("manages keys, limits and retention through the admin API", async () => {
    const { call } = await boot();
    const created = await call("/api/v1/keys", { method: "POST", body: JSON.stringify({ name: "agent", scopes: ["ingest"] }), headers: { "Content-Type": "application/json" } });
    expect(created.status).toBe(201);
    const { key, record } = await created.json();
    expect((await call("/api/v1/me", { key })).status).toBe(200);
    const list = await (await call("/api/v1/keys")).json();
    expect(list.keys.map((k: { name: string }) => k.name)).toEqual(["test", "agent"]);
    expect(JSON.stringify(list)).not.toContain(key);
    expect((await call(`/api/v1/keys/${record.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await call("/api/v1/me", { key })).status).toBe(401);
    expect((await call(`/api/v1/keys/${record.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await call("/api/v1/keys", { method: "POST", body: JSON.stringify({ name: "x", scopes: ["root"] }) })).status).toBe(400);

    const limits = await call("/api/v1/limits", { method: "PUT", body: JSON.stringify({ maxSeries: 3 }) });
    expect((await limits.json()).effective.maxSeries).toBe(3);
    expect((await call("/api/v1/limits", { method: "PUT", body: JSON.stringify({ maxSeries: 0 }) })).status).toBe(400);
    const t = now();
    const res = await call("/api/v1/metrics", {
      method: "POST",
      body: ["a", "b", "c", "d"].map((n) => JSON.stringify({ name: n, value: 1, ts: t })).join("\n")
    });
    expect((await res.json()).errors[0].reason).toBe("series_limit");

    const policies = [
      { signal: "metrics", resolutionSeconds: 0, retentionDays: 30 },
      { signal: "logs", resolutionSeconds: 0, retentionDays: 7 }
    ];
    const ret = await call("/api/v1/retention", { method: "PUT", body: JSON.stringify({ policies }) });
    expect((await ret.json()).policies).toHaveLength(2);
    expect((await call("/api/v1/retention", { method: "PUT", body: JSON.stringify({ policies: [] }) })).status).toBe(400);
    expect((await call("/api/v1/retention", { method: "PUT", body: "{bad" })).status).toBe(400);
  });

  it("isolates tenants", async () => {
    const { call, config } = await boot();
    const other = seedTenant(config, "globex");
    const t = now();
    await call("/api/v1/metrics", { method: "POST", body: JSON.stringify({ name: "secret_metric", value: 1, ts: t }) });
    const mine = await (await call("/api/v1/debug/series")).json();
    const theirs = await (await call("/api/v1/debug/series", { key: other.key })).json();
    expect(mine.matched).toBe(1);
    expect(theirs.matched).toBe(0);
  });

  it("survives a restart with all acknowledged data", async () => {
    const { app, call, config, tenant } = await boot();
    const t = now();
    await call("/api/v1/metrics", { method: "POST", body: [1, 2, 3].map((i) => JSON.stringify({ name: "m", value: i, ts: t + i })).join("\n") });
    await call("/api/v1/logs", { method: "POST", body: JSON.stringify({ msg: "persist me" }) });
    await app.close();
    apps.length = 0;
    const again = await startApp(config);
    apps.push(again);
    expect(again.loaded).toMatchObject({ series: 1, samples: 3, logs: 1 });
    const res = await fetch(`${again.url}/api/v1/debug/stats`, { headers: { Authorization: `Bearer ${tenant.key}` } });
    expect((await res.json()).tenant).toEqual({ series: 1, samples: 3, logs: 1 });
    const dup = await fetch(`${again.url}/api/v1/metrics`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tenant.key}` },
      body: JSON.stringify({ name: "m", value: 1, ts: t + 1 })
    });
    expect(await dup.json()).toMatchObject({ accepted: 1, newSeries: 0 });
  });
});
