import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.js";
import { decodeWriteRequest } from "../src/codec/remoteWrite.js";
import { snappyDecompress } from "../src/codec/snappy.js";
import { Rng, advance, buildSeries, encodeJsonBatch, encodeRemoteWriteBatch, makeLogLine } from "../src/loadgen/generator.js";
import { runLoad } from "../src/loadgen/run.js";
import { startApp, type App } from "../src/server/app.js";
import { seedTenant, testConfig } from "./helpers.js";

const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe("load generator", () => {
  it("builds unique, deterministic series", () => {
    const a = buildSeries(500, 1);
    const b = buildSeries(500, 1);
    expect(a).toEqual(b);
    expect(new Set(a.map((s) => JSON.stringify(s.labels))).size).toBe(500);
    expect(new Set(a.map((s) => s.labels[0]![1])).size).toBe(6);
  });

  it("keeps counters monotonic and timestamps strictly increasing", () => {
    const [counter] = buildSeries(1);
    const rng = new Rng(3);
    let prev = advance(counter!, rng, 1000);
    for (let i = 0; i < 100; i++) {
      const next = advance(counter!, rng, 1000);
      expect(next.ts).toBeGreaterThan(prev.ts);
      expect(next.value).toBeGreaterThanOrEqual(prev.value);
      prev = next;
    }
  });

  it("encodes both wire formats losslessly", () => {
    const batch = buildSeries(3).map((s) => ({ labels: s.labels, samples: [{ timestamp: 5, value: 1.25 }] }));
    expect(decodeWriteRequest(snappyDecompress(encodeRemoteWriteBatch(batch))).timeseries).toEqual(batch);
    const lines = encodeJsonBatch(batch).split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ name: batch[0]!.labels[0]![1], value: 1.25, ts: 5 });
    expect(JSON.parse(makeLogLine(new Rng(1), 10))).toMatchObject({ ts: 10, msg: expect.any(String) });
  });

  it("drives a live server without losing samples", async () => {
    const config = testConfig();
    const { key } = seedTenant(config);
    const app = await startApp(config);
    apps.push(app);
    for (const format of ["remote-write", "json"] as const) {
      const report = await runLoad({ url: app.url, key, series: 200, rate: 4000, durationSec: 1, batchSize: 100, concurrency: 2, format, logsPerSec: 200, reportEverySec: 10, seed: format === "json" ? 2 : 1 });
      expect(report.failures).toBe(0);
      expect(report.samplesRejected).toBe(0);
      expect(report.samplesAcked).toBe(report.samplesSent);
      expect(report.samplesSent).toBeGreaterThan(1000);
    }
    const union = new Set([...buildSeries(200, 1), ...buildSeries(200, 2)].map((s) => JSON.stringify([...s.labels].sort())));
    expect(app.registry.count()).toBe(union.size);
    expect(app.head.logCount()).toBeGreaterThan(0);
  });
});

describe("cli args", () => {
  it("parses positionals, values, equals and bare flags", () => {
    expect(parseArgs(["loadgen", "--rate", "10", "--format=json", "--help", "--x"])).toEqual({ _: ["loadgen"], flags: { rate: "10", format: "json", help: true, x: true } });
  });
});
