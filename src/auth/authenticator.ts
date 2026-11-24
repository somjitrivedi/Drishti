import type { MetaDb } from "../meta/db.js";
import { lookupApiKey, touchApiKey, type Scope } from "../meta/apiKeys.js";
import { getOrg } from "../meta/orgs.js";

export interface Principal {
  orgId: number;
  orgSlug: string;
  keyId: number;
  keyName: string;
  scopes: Scope[];
}

interface Entry {
  principal: Principal | null;
  expires: number;
}

export class Authenticator {
  private cache = new Map<string, Entry>();
  private lastTouched = new Map<number, number>();

  constructor(
    private readonly db: MetaDb,
    private readonly ttlMs: number,
    private readonly clock: () => number = Date.now,
    private readonly touchIntervalMs = 60_000
  ) {}

  authenticate(rawKey: string | undefined): Principal | null {
    if (!rawKey) return null;
    const now = this.clock();
    const hit = this.cache.get(rawKey);
    let principal: Principal | null;
    if (hit && hit.expires > now) {
      principal = hit.principal;
    } else {
      principal = this.load(rawKey);
      if (this.cache.size > 10_000) this.cache.clear();
      this.cache.set(rawKey, { principal, expires: now + (principal ? this.ttlMs : Math.min(this.ttlMs, 5_000)) });
    }
    if (principal) this.touch(principal.keyId, now);
    return principal;
  }

  invalidate(): void {
    this.cache.clear();
  }

  private load(rawKey: string): Principal | null {
    const key = lookupApiKey(this.db, rawKey);
    if (!key) return null;
    const org = getOrg(this.db, key.orgId);
    if (!org) return null;
    return { orgId: org.id, orgSlug: org.slug, keyId: key.id, keyName: key.name, scopes: key.scopes };
  }

  private touch(keyId: number, now: number): void {
    const last = this.lastTouched.get(keyId) ?? 0;
    if (now - last < this.touchIntervalMs) return;
    this.lastTouched.set(keyId, now);
    touchApiKey(this.db, keyId, now);
  }
}

export function extractKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  const auth = headers["authorization"];
  const value = Array.isArray(auth) ? auth[0] : auth;
  if (value) {
    const m = /^Bearer\s+(.+)$/i.exec(value.trim());
    if (m) return m[1]!.trim();
  }
  const x = headers["x-api-key"];
  const xv = Array.isArray(x) ? x[0] : x;
  return xv?.trim() || undefined;
}
