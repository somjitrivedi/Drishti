export function normalizeEpoch(n: number): number {
  const abs = Math.abs(n);
  if (abs < 1e11) return Math.round(n * 1000);
  if (abs < 1e14) return Math.round(n);
  if (abs < 1e17) return Math.round(n / 1000);
  return Math.round(n / 1e6);
}

const NUMERIC = /^-?\d+(?:\.\d+)?$/;
const LOCAL_ISO = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:[.,](\d{1,9}))?$/;

export function parseTimestamp(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? normalizeEpoch(v) : undefined;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s) return undefined;
  if (NUMERIC.test(s)) return normalizeEpoch(Number(s));
  const local = LOCAL_ISO.exec(s);
  if (local) {
    const frac = local[3] ? `.${local[3].slice(0, 3).padEnd(3, "0")}` : "";
    const t = Date.parse(`${local[1]}T${local[2]}${frac}Z`);
    return Number.isNaN(t) ? undefined : t;
  }
  const t = Date.parse(s.replace(",", "."));
  return Number.isNaN(t) ? undefined : t;
}
