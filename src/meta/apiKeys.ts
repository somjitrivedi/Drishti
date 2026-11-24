import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { MetaDb } from "./db.js";

export type Scope = "ingest" | "query" | "admin";
export const scopes: Scope[] = ["ingest", "query", "admin"];

export interface ApiKey {
  id: number;
  orgId: number;
  name: string;
  prefix: string;
  scopes: Scope[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export class ApiKeyError extends Error {}

const KEY_FORMAT = /^drk_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

interface KeyRow {
  id: number;
  org_id: number;
  name: string;
  prefix: string;
  key_hash: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const toKey = (r: KeyRow): ApiKey => ({
  id: r.id,
  orgId: r.org_id,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes.split(",").filter(Boolean) as Scope[],
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at
});

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function parseScopes(input: string | string[]): Scope[] {
  const list = (Array.isArray(input) ? input : input.split(",")).map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) throw new ApiKeyError("at least one scope is required");
  for (const s of list) if (!scopes.includes(s as Scope)) throw new ApiKeyError(`unknown scope ${s}; use ${scopes.join(", ")}`);
  return [...new Set(list)] as Scope[];
}

export function createApiKey(db: MetaDb, input: { orgId: number; name: string; scopes: Scope[] }): { key: string; record: ApiKey } {
  if (!input.name.trim()) throw new ApiKeyError("name is required");
  const list = parseScopes(input.scopes);
  const prefix = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const key = `drk_${prefix}_${secret}`;
  const now = Date.now();
  const id = Number(
    db
      .prepare("INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.orgId, input.name.trim(), prefix, sha256(key), list.join(","), now).lastInsertRowid
  );
  return { key, record: { id, orgId: input.orgId, name: input.name.trim(), prefix, scopes: list, createdAt: now, lastUsedAt: null, revokedAt: null } };
}

export function lookupApiKey(db: MetaDb, key: string): ApiKey | undefined {
  const m = KEY_FORMAT.exec(key);
  if (!m) return undefined;
  const row = db.prepare("SELECT * FROM api_keys WHERE prefix = ?").get(m[1]) as KeyRow | undefined;
  if (!row || row.revoked_at !== null) return undefined;
  const a = Buffer.from(row.key_hash, "hex");
  const b = Buffer.from(sha256(key), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return toKey(row);
}

export function touchApiKey(db: MetaDb, id: number, at = Date.now()): void {
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(at, id);
}

export function listApiKeys(db: MetaDb, orgId: number): ApiKey[] {
  return (db.prepare("SELECT * FROM api_keys WHERE org_id = ? ORDER BY id").all(orgId) as KeyRow[]).map(toKey);
}

export function revokeApiKey(db: MetaDb, orgId: number, id: number): boolean {
  return db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL").run(Date.now(), id, orgId).changes > 0;
}
