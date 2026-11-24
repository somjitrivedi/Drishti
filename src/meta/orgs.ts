import type { TenantLimits } from "../shared/config.js";
import type { MetaDb } from "./db.js";

export interface Org {
  id: number;
  slug: string;
  name: string;
  createdAt: number;
}

export interface RetentionPolicy {
  signal: "metrics" | "logs";
  resolutionSeconds: number;
  retentionDays: number;
}

export const defaultRetention: RetentionPolicy[] = [
  { signal: "metrics", resolutionSeconds: 0, retentionDays: 15 },
  { signal: "metrics", resolutionSeconds: 300, retentionDays: 90 },
  { signal: "metrics", resolutionSeconds: 3600, retentionDays: 365 },
  { signal: "logs", resolutionSeconds: 0, retentionDays: 14 }
];

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export class OrgError extends Error {}

interface OrgRow {
  id: number;
  slug: string;
  name: string;
  created_at: number;
}

const toOrg = (r: OrgRow): Org => ({ id: r.id, slug: r.slug, name: r.name, createdAt: r.created_at });

export function createOrg(db: MetaDb, input: { slug: string; name: string }): Org {
  if (!SLUG.test(input.slug)) throw new OrgError("slug must be 1-40 lowercase letters, digits or dashes");
  if (!input.name.trim()) throw new OrgError("name is required");
  if (getOrgBySlug(db, input.slug)) throw new OrgError(`org ${input.slug} already exists`);
  const now = Date.now();
  return db.transaction(() => {
    const id = Number(db.prepare("INSERT INTO orgs (slug, name, created_at) VALUES (?, ?, ?)").run(input.slug, input.name.trim(), now).lastInsertRowid);
    const ins = db.prepare("INSERT INTO retention_policies (org_id, signal, resolution_seconds, retention_days) VALUES (?, ?, ?, ?)");
    for (const p of defaultRetention) ins.run(id, p.signal, p.resolutionSeconds, p.retentionDays);
    return { id, slug: input.slug, name: input.name.trim(), createdAt: now };
  })();
}

export function getOrg(db: MetaDb, id: number): Org | undefined {
  const r = db.prepare("SELECT * FROM orgs WHERE id = ?").get(id) as OrgRow | undefined;
  return r && toOrg(r);
}

export function getOrgBySlug(db: MetaDb, slug: string): Org | undefined {
  const r = db.prepare("SELECT * FROM orgs WHERE slug = ?").get(slug) as OrgRow | undefined;
  return r && toOrg(r);
}

export function listOrgs(db: MetaDb): Org[] {
  return (db.prepare("SELECT * FROM orgs ORDER BY id").all() as OrgRow[]).map(toOrg);
}

const limitColumns: Array<[keyof TenantLimits, string]> = [
  ["samplesPerSec", "samples_per_sec"],
  ["samplesBurst", "samples_burst"],
  ["logBytesPerSec", "log_bytes_per_sec"],
  ["logBytesBurst", "log_bytes_burst"],
  ["maxSeries", "max_series"],
  ["maxBodyBytes", "max_body_bytes"]
];

export function getLimitOverrides(db: MetaDb, orgId: number): Partial<TenantLimits> {
  const row = db.prepare("SELECT * FROM org_limits WHERE org_id = ?").get(orgId) as Record<string, number | null> | undefined;
  const out: Partial<TenantLimits> = {};
  if (!row) return out;
  for (const [key, col] of limitColumns) {
    const v = row[col];
    if (v !== null && v !== undefined) out[key] = v;
  }
  return out;
}

export function resolveLimits(db: MetaDb, orgId: number, defaults: TenantLimits): TenantLimits {
  const merged = { ...defaults, ...getLimitOverrides(db, orgId) };
  merged.samplesBurst = Math.max(merged.samplesBurst, merged.samplesPerSec);
  merged.logBytesBurst = Math.max(merged.logBytesBurst, merged.logBytesPerSec);
  return merged;
}

export function setLimitOverrides(db: MetaDb, orgId: number, patch: Partial<Record<keyof TenantLimits, number | null>>): Partial<TenantLimits> {
  for (const [key] of limitColumns) {
    const v = patch[key];
    if (v === undefined || v === null) continue;
    if (!Number.isInteger(v) || v <= 0) throw new OrgError(`${key} must be a positive integer`);
  }
  const unknown = Object.keys(patch).filter((k) => !limitColumns.some(([key]) => key === k));
  if (unknown.length) throw new OrgError(`unknown limit ${unknown.join(", ")}`);
  const current = getLimitOverrides(db, orgId) as Record<string, number | null | undefined>;
  const next: Record<string, number | null> = {};
  for (const [key] of limitColumns) {
    const v = key in patch ? patch[key] : current[key];
    next[key] = v ?? null;
  }
  db.prepare(
    `INSERT INTO org_limits (org_id, samples_per_sec, samples_burst, log_bytes_per_sec, log_bytes_burst, max_series, max_body_bytes, updated_at)
     VALUES (@orgId, @samplesPerSec, @samplesBurst, @logBytesPerSec, @logBytesBurst, @maxSeries, @maxBodyBytes, @now)
     ON CONFLICT(org_id) DO UPDATE SET samples_per_sec = excluded.samples_per_sec, samples_burst = excluded.samples_burst,
       log_bytes_per_sec = excluded.log_bytes_per_sec, log_bytes_burst = excluded.log_bytes_burst,
       max_series = excluded.max_series, max_body_bytes = excluded.max_body_bytes, updated_at = excluded.updated_at`
  ).run({ orgId, ...next, now: Date.now() });
  return getLimitOverrides(db, orgId);
}

export function listRetention(db: MetaDb, orgId: number): RetentionPolicy[] {
  const rows = db
    .prepare("SELECT signal, resolution_seconds, retention_days FROM retention_policies WHERE org_id = ? ORDER BY signal, resolution_seconds")
    .all(orgId) as Array<{ signal: "metrics" | "logs"; resolution_seconds: number; retention_days: number }>;
  return rows.map((r) => ({ signal: r.signal, resolutionSeconds: r.resolution_seconds, retentionDays: r.retention_days }));
}

export function setRetention(db: MetaDb, orgId: number, policies: RetentionPolicy[]): RetentionPolicy[] {
  const seen = new Set<string>();
  for (const p of policies) {
    if (p.signal !== "metrics" && p.signal !== "logs") throw new OrgError("signal must be metrics or logs");
    if (!Number.isInteger(p.resolutionSeconds) || p.resolutionSeconds < 0) throw new OrgError("resolutionSeconds must be a non-negative integer");
    if (!Number.isInteger(p.retentionDays) || p.retentionDays <= 0) throw new OrgError("retentionDays must be a positive integer");
    if (p.signal === "logs" && p.resolutionSeconds !== 0) throw new OrgError("logs only support resolutionSeconds 0");
    const k = `${p.signal}:${p.resolutionSeconds}`;
    if (seen.has(k)) throw new OrgError(`duplicate policy ${k}`);
    seen.add(k);
  }
  for (const signal of ["metrics", "logs"] as const) {
    if (!policies.some((p) => p.signal === signal && p.resolutionSeconds === 0)) throw new OrgError(`${signal} needs a raw (resolutionSeconds 0) policy`);
  }
  db.transaction(() => {
    db.prepare("DELETE FROM retention_policies WHERE org_id = ?").run(orgId);
    const ins = db.prepare("INSERT INTO retention_policies (org_id, signal, resolution_seconds, retention_days) VALUES (?, ?, ?, ?)");
    for (const p of policies) ins.run(orgId, p.signal, p.resolutionSeconds, p.retentionDays);
  })();
  return listRetention(db, orgId);
}
