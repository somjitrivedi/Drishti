import { describe, expect, it } from "vitest";
import { ApiKeyError, createApiKey, listApiKeys, lookupApiKey, parseScopes, revokeApiKey } from "../src/meta/apiKeys.js";
import { currentVersion, migrate, openMetaDb } from "../src/meta/db.js";
import {
  OrgError,
  createOrg,
  defaultRetention,
  getLimitOverrides,
  getOrgBySlug,
  listRetention,
  resolveLimits,
  setLimitOverrides,
  setRetention
} from "../src/meta/orgs.js";
import { UserError, checkPassword, createUser, hashPassword, verifyUser } from "../src/meta/users.js";
import { Authenticator, extractKey } from "../src/auth/authenticator.js";
import { defaultConfig } from "../src/shared/config.js";

function db() {
  const d = openMetaDb(":memory:");
  migrate(d);
  return d;
}

describe("migrations", () => {
  it("applies once and records the version", () => {
    const d = openMetaDb(":memory:");
    expect(migrate(d)).toEqual([1]);
    expect(migrate(d)).toEqual([]);
    expect(currentVersion(d)).toBe(1);
    const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["orgs", "org_limits", "users", "api_keys", "retention_policies", "dashboards", "alert_rules"]));
  });
});

describe("orgs", () => {
  it("creates an org with default retention", () => {
    const d = db();
    const org = createOrg(d, { slug: "acme", name: "Acme" });
    expect(getOrgBySlug(d, "acme")?.id).toBe(org.id);
    expect(listRetention(d, org.id)).toEqual([...defaultRetention].sort((a, b) => a.signal.localeCompare(b.signal) || a.resolutionSeconds - b.resolutionSeconds));
  });

  it("rejects bad and duplicate slugs", () => {
    const d = db();
    createOrg(d, { slug: "acme", name: "Acme" });
    expect(() => createOrg(d, { slug: "acme", name: "Again" })).toThrow(OrgError);
    expect(() => createOrg(d, { slug: "Bad Slug", name: "x" })).toThrow(/slug/);
    expect(() => createOrg(d, { slug: "-x", name: "x" })).toThrow(/slug/);
  });

  it("merges limit overrides over defaults and clears with null", () => {
    const d = db();
    const org = createOrg(d, { slug: "acme", name: "Acme" });
    const defaults = defaultConfig().limits;
    expect(resolveLimits(d, org.id, defaults)).toEqual(defaults);
    setLimitOverrides(d, org.id, { maxSeries: 5, samplesPerSec: 300_000 });
    const l = resolveLimits(d, org.id, defaults);
    expect(l.maxSeries).toBe(5);
    expect(l.samplesBurst).toBe(300_000);
    setLimitOverrides(d, org.id, { maxSeries: null });
    expect(getLimitOverrides(d, org.id)).toEqual({ samplesPerSec: 300_000 });
    expect(() => setLimitOverrides(d, org.id, { maxSeries: -1 })).toThrow(OrgError);
    expect(() => setLimitOverrides(d, org.id, { bogus: 1 } as never)).toThrow(/unknown limit/);
  });

  it("validates retention policies", () => {
    const d = db();
    const org = createOrg(d, { slug: "acme", name: "Acme" });
    const ok = [
      { signal: "metrics" as const, resolutionSeconds: 0, retentionDays: 7 },
      { signal: "logs" as const, resolutionSeconds: 0, retentionDays: 3 }
    ];
    expect(setRetention(d, org.id, ok)).toHaveLength(2);
    expect(() => setRetention(d, org.id, [ok[0]!])).toThrow(/logs needs a raw/);
    expect(() => setRetention(d, org.id, [...ok, ok[0]!])).toThrow(/duplicate/);
    expect(() => setRetention(d, org.id, [...ok, { signal: "logs", resolutionSeconds: 60, retentionDays: 1 }])).toThrow(/logs only/);
    expect(listRetention(d, org.id)).toHaveLength(2);
  });
});

describe("users", () => {
  it("hashes passwords with scrypt and verifies", () => {
    const h = hashPassword("correct horse battery");
    expect(h).toMatch(/^scrypt\$/);
    expect(checkPassword("correct horse battery", h)).toBe(true);
    expect(checkPassword("wrong", h)).toBe(false);
    expect(checkPassword("x", "garbage")).toBe(false);
  });

  it("creates users and verifies logins case-insensitively", () => {
    const d = db();
    const org = createOrg(d, { slug: "acme", name: "Acme" });
    createUser(d, { orgId: org.id, email: "Owner@Example.test", name: "Owner", password: "long-enough-pw", role: "owner" });
    expect(verifyUser(d, "owner@example.test", "long-enough-pw")?.role).toBe("owner");
    expect(verifyUser(d, "owner@example.test", "nope")).toBeUndefined();
    expect(() => createUser(d, { orgId: org.id, email: "owner@example.test", name: "x", password: "long-enough-pw", role: "admin" })).toThrow(UserError);
    expect(() => createUser(d, { orgId: org.id, email: "bad", name: "x", password: "long-enough-pw", role: "admin" })).toThrow(/email/);
    expect(() => createUser(d, { orgId: org.id, email: "a@b.test", name: "x", password: "short", role: "admin" })).toThrow(/password/);
  });
});

describe("api keys", () => {
  it("stores only a hash and looks keys up", () => {
    const d = db();
    const org = createOrg(d, { slug: "acme", name: "Acme" });
    const { key, record } = createApiKey(d, { orgId: org.id, name: "ci", scopes: ["ingest"] });
    expect(key).toMatch(/^drk_[0-9a-f]{12}_/);
    const row = d.prepare("SELECT key_hash FROM api_keys WHERE id = ?").get(record.id) as { key_hash: string };
    expect(row.key_hash).not.toContain(key);
    expect(lookupApiKey(d, key)?.scopes).toEqual(["ingest"]);
    expect(lookupApiKey(d, key.slice(0, -1) + (key.endsWith("A") ? "B" : "A"))).toBeUndefined();
    expect(lookupApiKey(d, "nonsense")).toBeUndefined();
    expect(revokeApiKey(d, org.id, record.id)).toBe(true);
    expect(revokeApiKey(d, org.id, record.id)).toBe(false);
    expect(lookupApiKey(d, key)).toBeUndefined();
    expect(listApiKeys(d, org.id)[0]?.revokedAt).not.toBeNull();
  });

  it("parses scopes", () => {
    expect(parseScopes("ingest, query,ingest")).toEqual(["ingest", "query"]);
    expect(() => parseScopes("")).toThrow(ApiKeyError);
    expect(() => parseScopes(["write"])).toThrow(/unknown scope/);
  });

  it("caches principals and throttles last-used updates", () => {
    const d = db();
    const org = createOrg(d, { slug: "acme", name: "Acme" });
    const { key, record } = createApiKey(d, { orgId: org.id, name: "ci", scopes: ["query"] });
    let now = 1_000_000;
    const auth = new Authenticator(d, 30_000, () => now);
    expect(auth.authenticate(key)).toMatchObject({ orgId: org.id, orgSlug: "acme", scopes: ["query"] });
    const firstTouch = (d.prepare("SELECT last_used_at FROM api_keys WHERE id = ?").get(record.id) as { last_used_at: number }).last_used_at;
    expect(firstTouch).toBe(now);
    revokeApiKey(d, org.id, record.id);
    now += 1000;
    expect(auth.authenticate(key)).not.toBeNull();
    now += 30_000;
    expect(auth.authenticate(key)).toBeNull();
    expect(auth.authenticate(undefined)).toBeNull();
  });

  it("extracts keys from bearer or x-api-key headers", () => {
    expect(extractKey({ authorization: "Bearer abc" })).toBe("abc");
    expect(extractKey({ authorization: "bearer   abc " })).toBe("abc");
    expect(extractKey({ "x-api-key": "xyz" })).toBe("xyz");
    expect(extractKey({ authorization: "Basic foo" })).toBeUndefined();
  });
});
