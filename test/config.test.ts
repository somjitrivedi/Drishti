import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, deepMerge, defaultConfig, loadConfig } from "../src/shared/config.js";
import { createLogger } from "../src/shared/logger.js";
import { tempDir } from "./helpers.js";

describe("config", () => {
  it("derives storage paths from the data dir", () => {
    const dir = tempDir();
    const c = loadConfig({ env: {}, cwd: dir });
    expect(c.dataDir).toBe(join(dir, "data"));
    expect(c.metaDbPath).toBe(join(dir, "data", "meta.db"));
    expect(c.storage.path).toBe(join(dir, "data", "tsdb.db"));
    expect(c.storage.fsync).toBe(true);
  });

  it("applies file, then env, then overrides", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "drishti.config.json"), JSON.stringify({ http: { port: 7000 }, limits: { maxSeries: 10 } }));
    const c = loadConfig({ env: { DRISHTI_PORT: "7100", DRISHTI_FSYNC: "false" }, cwd: dir, overrides: { limits: { maxSeries: 20 } } });
    expect(c.http.port).toBe(7100);
    expect(c.storage.fsync).toBe(false);
    expect(c.limits.maxSeries).toBe(20);
    expect(c.limits.samplesPerSec).toBe(defaultConfig().limits.samplesPerSec);
  });

  it("collects every validation problem", () => {
    const dir = tempDir();
    try {
      loadConfig({ env: { DRISHTI_PORT: "abc", DRISHTI_FSYNC: "maybe" }, cwd: dir, overrides: { limits: { samplesPerSec: 10, samplesBurst: 5 }, log: { level: "loud" as never } } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const issues = (err as ConfigError).issues.join("\n");
      expect(issues).toMatch(/DRISHTI_PORT/);
      expect(issues).toMatch(/DRISHTI_FSYNC/);
      expect(issues).toMatch(/samplesBurst/);
      expect(issues).toMatch(/log.level/);
    }
  });

  it("reports an unreadable config file", () => {
    expect(() => loadConfig({ env: {}, cwd: tempDir(), file: "missing.json" })).toThrow(/cannot read config file/);
  });

  it("deep merges without touching arrays or the base", () => {
    const base = { a: { b: 1, c: [1, 2] }, d: 1 };
    const out = deepMerge(base, { a: { c: [3] }, d: undefined });
    expect(out).toEqual({ a: { b: 1, c: [3] }, d: 1 });
    expect(base.a.c).toEqual([1, 2]);
  });
});

describe("logger", () => {
  it("writes JSON lines at or above the level", () => {
    const lines: string[] = [];
    const log = createLogger("info", (l) => lines.push(l)).child({ component: "test" });
    log.debug("hidden");
    log.info("shown", { n: 1 });
    log.error("boom", { err: new Error("bad") });
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({ level: "info", msg: "shown", component: "test", n: 1 });
    expect(JSON.parse(lines[1]!).err.message).toBe("bad");
  });
});
