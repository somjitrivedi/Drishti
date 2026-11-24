type LabelValues = Record<string, string>;

function labelKey(labels: LabelValues): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}="${escapeValue(labels[k] ?? "")}"`).join(",");
}

function escapeValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatNumber(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "+Inf";
  if (v === -Infinity) return "-Inf";
  return String(v);
}

interface Metric {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
  render(): string[];
}

export class Counter implements Metric {
  readonly type = "counter" as const;
  private values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  inc(by = 1, labels: LabelValues = {}): void {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  get(labels: LabelValues = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }
  render(): string[] {
    if (this.values.size === 0) return [`${this.name} 0`];
    return [...this.values].map(([k, v]) => `${this.name}${k ? `{${k}}` : ""} ${formatNumber(v)}`);
  }
}

export class Gauge implements Metric {
  readonly type = "gauge" as const;
  constructor(readonly name: string, readonly help: string, private readonly collect: () => number | Array<[LabelValues, number]>) {}
  render(): string[] {
    const v = this.collect();
    if (typeof v === "number") return [`${this.name} ${formatNumber(v)}`];
    return v.map(([labels, n]) => {
      const k = labelKey(labels);
      return `${this.name}${k ? `{${k}}` : ""} ${formatNumber(n)}`;
    });
  }
}

export class Histogram implements Metric {
  readonly type = "histogram" as const;
  private counts: number[];
  private sum = 0;
  private count = 0;
  constructor(readonly name: string, readonly help: string, readonly buckets: number[]) {
    this.counts = new Array(buckets.length).fill(0);
  }
  observe(v: number): void {
    this.sum += v;
    this.count++;
    for (let i = 0; i < this.buckets.length; i++) if (v <= this.buckets[i]!) this.counts[i]!++;
  }
  snapshot(): { count: number; sum: number } {
    return { count: this.count, sum: this.sum };
  }
  render(): string[] {
    const lines = this.buckets.map((b, i) => `${this.name}_bucket{le="${formatNumber(b)}"} ${this.counts[i]}`);
    lines.push(`${this.name}_bucket{le="+Inf"} ${this.count}`);
    lines.push(`${this.name}_sum ${formatNumber(this.sum)}`);
    lines.push(`${this.name}_count ${this.count}`);
    return lines;
  }
}

export class MetricsRegistry {
  private metrics: Metric[] = [];
  counter(name: string, help: string): Counter {
    const c = new Counter(name, help);
    this.metrics.push(c);
    return c;
  }
  gauge(name: string, help: string, collect: () => number | Array<[LabelValues, number]>): Gauge {
    const g = new Gauge(name, help, collect);
    this.metrics.push(g);
    return g;
  }
  histogram(name: string, help: string, buckets: number[]): Histogram {
    const h = new Histogram(name, help, buckets);
    this.metrics.push(h);
    return h;
  }
  render(): string {
    const out: string[] = [];
    for (const m of this.metrics) {
      out.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type}`, ...m.render());
    }
    return out.join("\n") + "\n";
  }
}
