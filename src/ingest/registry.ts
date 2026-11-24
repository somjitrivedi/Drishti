import { seriesKey, type Label } from "./labels.js";

export interface SeriesMeta {
  ref: number;
  tenant: number;
  labels: Label[];
  key: string;
}

const SERIES_OVERHEAD_BYTES = 160;

export class SeriesRegistry {
  private byTenant = new Map<number, Map<string, number>>();
  private byRef = new Map<number, SeriesMeta>();
  private nextRef = 1;
  private bytesEstimate = 0;

  lookup(tenant: number, key: string): number | undefined {
    return this.byTenant.get(tenant)?.get(key);
  }

  create(tenant: number, labels: Label[], key = seriesKey(labels)): SeriesMeta {
    const existing = this.lookup(tenant, key);
    if (existing !== undefined) return this.byRef.get(existing)!;
    const meta: SeriesMeta = { ref: this.nextRef++, tenant, labels, key };
    this.insert(meta);
    return meta;
  }

  restore(tenant: number, ref: number, labels: Label[]): void {
    if (this.byRef.has(ref)) return;
    this.insert({ ref, tenant, labels, key: seriesKey(labels) });
    if (ref >= this.nextRef) this.nextRef = ref + 1;
  }

  private insert(meta: SeriesMeta): void {
    let m = this.byTenant.get(meta.tenant);
    if (!m) {
      m = new Map();
      this.byTenant.set(meta.tenant, m);
    }
    m.set(meta.key, meta.ref);
    this.byRef.set(meta.ref, meta);
    this.bytesEstimate += SERIES_OVERHEAD_BYTES + meta.key.length * 4;
  }

  get(ref: number): SeriesMeta | undefined {
    return this.byRef.get(ref);
  }

  count(tenant?: number): number {
    if (tenant === undefined) return this.byRef.size;
    return this.byTenant.get(tenant)?.size ?? 0;
  }

  tenants(): number[] {
    return [...this.byTenant.keys()];
  }

  *list(tenant: number): Iterable<SeriesMeta> {
    const m = this.byTenant.get(tenant);
    if (!m) return;
    for (const ref of m.values()) yield this.byRef.get(ref)!;
  }

  get bytes(): number {
    return this.bytesEstimate;
  }
}
