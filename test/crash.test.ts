import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedTenant, testConfig } from "./helpers.js";

const root = resolve(import.meta.dirname, "..");
const children: ChildProcess[] = [];

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
});

function startServer(dataDir: string): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
    cwd: root,
    env: { ...process.env, DRISHTI_DATA_DIR: dataDir, DRISHTI_PORT: "0", DRISHTI_FSYNC: "true", DRISHTI_LOG_LEVEL: "info" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  return new Promise((resolvePromise, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}${err}`)), 30_000);
    child.stderr!.on("data", (d) => (err += d));
    child.stdout!.on("data", (d) => {
      out += d;
      const m = /"msg":"listening".*"url":"([^"]+)"/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolvePromise({ child, url: m[1]! });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}: ${out}${err}`));
    });
  });
}

describe("crash recovery", () => {
  it("keeps every acknowledged write after kill -9", async () => {
    const config = testConfig();
    const { key } = seedTenant(config);
    const first = await startServer(config.dataDir);
    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/x-ndjson" };
    const acked = new Set<number>();
    const t0 = Date.now();
    let killed = false;
    const writer = async (w: number) => {
      for (let i = w; !killed; i += 4) {
        const body = Array.from({ length: 10 }, (_, j) => JSON.stringify({ name: `crash_${i}`, value: j, ts: t0 + j })).join("\n");
        try {
          const res = await fetch(`${first.url}/api/v1/metrics`, { method: "POST", headers, body });
          if (res.status === 200 && (await res.json()).accepted === 10) acked.add(i);
        } catch {
          return;
        }
      }
    };
    const writers = [0, 1, 2, 3].map(writer);
    while (acked.size < 150) await new Promise((r) => setTimeout(r, 5));
    const exited = new Promise((r) => first.child.once("exit", r));
    first.child.kill("SIGKILL");
    killed = true;
    await exited;
    await Promise.all(writers);

    const second = await startServer(config.dataDir);
    const res = await fetch(`${second.url}/api/v1/debug/series?prefix=crash_&limit=10000`, { headers: { Authorization: `Bearer ${key}` } });
    const body = (await res.json()) as { series: Array<{ labels: { __name__: string }; samples: number }> };
    const stored = new Map(body.series.map((s) => [Number(s.labels.__name__.slice(6)), s.samples]));
    const missing = [...acked].filter((i) => stored.get(i) !== 10);
    expect(missing).toEqual([]);
    for (const n of stored.values()) expect(n).toBe(10);
    expect(stored.size).toBeGreaterThanOrEqual(acked.size);
    second.child.kill("SIGKILL");
  }, 90_000);
});
