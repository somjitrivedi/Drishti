import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { createApiKey, type Scope } from "../src/meta/apiKeys.js";
import { openMigrated } from "../src/meta/db.js";
import { createOrg } from "../src/meta/orgs.js";
import { loadConfig, type Config, type DeepPartial } from "../src/shared/config.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
});

export function tempDir(prefix = "drishti-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

export function testConfig(overrides: DeepPartial<Config> = {}, dataDir = tempDir()): Config {
  return loadConfig({
    env: {},
    cwd: dataDir,
    overrides: { dataDir, http: { port: 0 }, storage: { flushIntervalMs: 2 }, log: { level: "silent" }, ...overrides }
  });
}

export function seedTenant(config: Config, slug = "acme", scopes: Scope[] = ["ingest", "query", "admin"]): { orgId: number; key: string } {
  const db = openMigrated(config.metaDbPath);
  try {
    const org = createOrg(db, { slug, name: slug });
    const { key } = createApiKey(db, { orgId: org.id, name: "test", scopes });
    return { orgId: org.id, key };
  } finally {
    db.close();
  }
}

export function addKey(config: Config, orgId: number, scopes: Scope[]): string {
  const db = openMigrated(config.metaDbPath);
  try {
    return createApiKey(db, { orgId, name: `k-${scopes.join("-")}`, scopes }).key;
  } finally {
    db.close();
  }
}
