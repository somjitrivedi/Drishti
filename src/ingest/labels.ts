export interface Label {
  name: string;
  value: string;
}

export interface LabelLimits {
  maxLabels: number;
  maxLabelNameLength: number;
  maxLabelValueLength: number;
}

export class LabelError extends Error {}

export const METRIC_NAME = "__name__";

const VALID_LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const VALID_METRIC = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

export function sanitizeLabelName(name: string): string {
  if (VALID_LABEL.test(name)) return name;
  const s = name.replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[0-9]/.test(s) ? `_${s}` : s;
}

export function sanitizeMetricName(name: string): string {
  if (VALID_METRIC.test(name)) return name;
  const s = name.replace(/[^a-zA-Z0-9_:]/g, "_");
  return /^[0-9]/.test(s) ? `_${s}` : s;
}

export function normalizeLabels(pairs: Iterable<readonly [string, string]>, limits: LabelLimits): Label[] {
  const out: Label[] = [];
  const seen = new Set<string>();
  let hasName = false;
  for (const [rawName, rawValue] of pairs) {
    if (typeof rawName !== "string" || rawName === "") throw new LabelError("label name must be a non-empty string");
    if (typeof rawValue !== "string") throw new LabelError(`label ${rawName} value must be a string`);
    if (rawValue === "") continue;
    let name: string;
    let value = rawValue;
    if (rawName === METRIC_NAME) {
      name = METRIC_NAME;
      value = sanitizeMetricName(rawValue);
      hasName = true;
    } else {
      name = sanitizeLabelName(rawName);
      if (name.startsWith("__")) throw new LabelError(`label name ${rawName} is reserved`);
    }
    if (name.length > limits.maxLabelNameLength) throw new LabelError(`label name ${name.slice(0, 32)}... longer than ${limits.maxLabelNameLength}`);
    if (value.length > limits.maxLabelValueLength) throw new LabelError(`label ${name} value longer than ${limits.maxLabelValueLength}`);
    if (seen.has(name)) throw new LabelError(`duplicate label ${name}`);
    seen.add(name);
    out.push({ name, value });
  }
  if (!hasName) throw new LabelError("metric name (__name__) is required");
  if (out.length > limits.maxLabels) throw new LabelError(`series has ${out.length} labels, limit is ${limits.maxLabels}`);
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

export function seriesKey(labels: readonly Label[]): string {
  let k = "";
  for (const l of labels) k += `${l.name.length}:${l.name}${l.value.length}:${l.value}`;
  return k;
}

export function metricName(labels: readonly Label[]): string {
  return labels.find((l) => l.name === METRIC_NAME)?.value ?? "";
}

export function formatSeries(labels: readonly Label[]): string {
  const rest = labels.filter((l) => l.name !== METRIC_NAME);
  const inner = rest.map((l) => `${l.name}=${JSON.stringify(l.value)}`).join(", ");
  return `${metricName(labels)}{${inner}}`;
}
