import type { TenantLimits } from "../shared/config.js";
import type { MetaDb } from "../meta/db.js";
import { resolveLimits } from "../meta/orgs.js";

export interface LimitsProvider {
  get(tenant: number): TenantLimits;
}

export class CachedLimits implements LimitsProvider {
  private cache = new Map<number, { limits: TenantLimits; expires: number }>();
  constructor(
    private readonly db: MetaDb,
    private readonly defaults: TenantLimits,
    private readonly ttlMs: number,
    private readonly clock: () => number = Date.now
  ) {}
  get(tenant: number): TenantLimits {
    const now = this.clock();
    const hit = this.cache.get(tenant);
    if (hit && hit.expires > now) return hit.limits;
    const limits = resolveLimits(this.db, tenant, this.defaults);
    this.cache.set(tenant, { limits, expires: now + this.ttlMs });
    return limits;
  }
  invalidate(tenant?: number): void {
    if (tenant === undefined) this.cache.clear();
    else this.cache.delete(tenant);
  }
}

export class StaticLimits implements LimitsProvider {
  constructor(private readonly limits: TenantLimits) {}
  get(): TenantLimits {
    return this.limits;
  }
}

export type TakeResult = { ok: true } | { ok: false; retryAfterSec: number; exceedsBurst: boolean };

export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private rate: number,
    private burst: number,
    private readonly clock: () => number
  ) {
    this.tokens = burst;
    this.last = clock();
  }
  reconfigure(rate: number, burst: number): void {
    if (rate === this.rate && burst === this.burst) return;
    this.refill();
    this.rate = rate;
    this.burst = burst;
    this.tokens = Math.min(this.tokens, burst);
  }
  take(n: number): TakeResult {
    if (n > this.burst) return { ok: false, retryAfterSec: 1, exceedsBurst: true };
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return { ok: true };
    }
    return { ok: false, retryAfterSec: (n - this.tokens) / this.rate, exceedsBurst: false };
  }
  available(): number {
    this.refill();
    return this.tokens;
  }
  private refill(): void {
    const now = this.clock();
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
  }
}

export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  constructor(private readonly clock: () => number = Date.now) {}
  take(tenant: number, kind: "samples" | "logBytes", n: number, limits: TenantLimits): TakeResult {
    const rate = kind === "samples" ? limits.samplesPerSec : limits.logBytesPerSec;
    const burst = kind === "samples" ? limits.samplesBurst : limits.logBytesBurst;
    const key = `${tenant}:${kind}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = new TokenBucket(rate, burst, this.clock);
      this.buckets.set(key, b);
    } else {
      b.reconfigure(rate, burst);
    }
    return b.take(n);
  }
}
