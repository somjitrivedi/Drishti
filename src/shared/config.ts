import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { LogLevel } from "./logger.js";

export interface TenantLimits {
  samplesPerSec: number;
  samplesBurst: number;
  logBytesPerSec: number;
  logBytesBurst: number;
  maxSeries: number;
  maxBodyBytes: number;
}

export interface Config {
  dataDir: string;
  metaDbPath: string;
  http: {
    host: string;
    port: number;
    keepAliveTimeoutMs: number;
  };
  storage: {
    path: string;
    fsync: boolean;
    flushIntervalMs: number;
    maxPendingBytes: number;
    cacheMb: number;
  };
  ingest: {
    maxLabels: number;
    maxLabelNameLength: number;
    maxLabelValueLength: number;
    maxSampleAgeMs: number;
    maxFutureSkewMs: number;
    maxLogAgeMs: number;
    maxLogLineBytes: number;
    maxLogFields: number;
    headMaxBytes: number;
    maxSamplesPerRecord: number;
  };
  auth: {
    keyCacheTtlMs: number;
    limitsCacheTtlMs: number;
  };
  limits: TenantLimits;
  log: {
    level: LogLevel;
  };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid configuration: ${issues.join("; ")}`);
    this.name = "ConfigError";
  }
}

const MiB = 1024 * 1024;

export function defaultConfig(dataDir = "data"): Config {
  return {
    dataDir,
    metaDbPath: "",
    http: { host: "127.0.0.1", port: 9400, keepAliveTimeoutMs: 65_000 },
    storage: { path: "", fsync: true, flushIntervalMs: 5, maxPendingBytes: 64 * MiB, cacheMb: 256 },
    ingest: {
      maxLabels: 30,
      maxLabelNameLength: 128,
      maxLabelValueLength: 2048,
      maxSampleAgeMs: 2 * 3600_000,
      maxFutureSkewMs: 10 * 60_000,
      maxLogAgeMs: 7 * 24 * 3600_000,
      maxLogLineBytes: 16 * 1024,
      maxLogFields: 64,
      headMaxBytes: 2048 * MiB,
      maxSamplesPerRecord: 8192
    },
    auth: { keyCacheTtlMs: 30_000, limitsCacheTtlMs: 10_000 },
    limits: {
      samplesPerSec: 100_000,
      samplesBurst: 200_000,
      logBytesPerSec: 10 * MiB,
      logBytesBurst: 20 * MiB,
      maxSeries: 500_000,
      maxBodyBytes: 16 * MiB
    },
    log: { level: "info" }
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(base)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

function envPatch(env: NodeJS.ProcessEnv): { patch: DeepPartial<Config>; issues: string[] } {
  const patch: DeepPartial<Config> = {};
  const issues: string[] = [];
  const int = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n)) {
      issues.push(`${name} must be an integer`);
      return undefined;
    }
    return n;
  };
  if (env.DRISHTI_DATA_DIR) patch.dataDir = env.DRISHTI_DATA_DIR;
  if (env.DRISHTI_META_DB) patch.metaDbPath = env.DRISHTI_META_DB;
  const port = int("DRISHTI_PORT");
  const http: DeepPartial<Config["http"]> = {};
  if (port !== undefined) http.port = port;
  if (env.DRISHTI_HOST) http.host = env.DRISHTI_HOST;
  if (Object.keys(http).length) patch.http = http;
  const storage: DeepPartial<Config["storage"]> = {};
  if (env.DRISHTI_STORAGE_DB) storage.path = env.DRISHTI_STORAGE_DB;
  if (env.DRISHTI_FSYNC !== undefined && env.DRISHTI_FSYNC !== "") {
    if (env.DRISHTI_FSYNC === "true" || env.DRISHTI_FSYNC === "1") storage.fsync = true;
    else if (env.DRISHTI_FSYNC === "false" || env.DRISHTI_FSYNC === "0") storage.fsync = false;
    else issues.push("DRISHTI_FSYNC must be true or false");
  }
  const flush = int("DRISHTI_FLUSH_MS");
  if (flush !== undefined) storage.flushIntervalMs = flush;
  if (Object.keys(storage).length) patch.storage = storage;
  if (env.DRISHTI_LOG_LEVEL) patch.log = { level: env.DRISHTI_LOG_LEVEL as LogLevel };
  return { patch, issues };
}

export function validateConfig(c: Config): string[] {
  const issues: string[] = [];
  const positive = (path: string, v: number) => {
    if (!Number.isFinite(v) || v <= 0) issues.push(`${path} must be a positive number`);
  };
  if (!c.dataDir) issues.push("dataDir is required");
  if (!Number.isInteger(c.http.port) || c.http.port < 0 || c.http.port > 65535) issues.push("http.port must be 0-65535");
  if (!Number.isFinite(c.storage.flushIntervalMs) || c.storage.flushIntervalMs < 0) issues.push("storage.flushIntervalMs must be >= 0");
  positive("storage.maxPendingBytes", c.storage.maxPendingBytes);
  positive("storage.cacheMb", c.storage.cacheMb);
  positive("ingest.maxLabels", c.ingest.maxLabels);
  positive("ingest.maxLabelNameLength", c.ingest.maxLabelNameLength);
  positive("ingest.maxLabelValueLength", c.ingest.maxLabelValueLength);
  positive("ingest.maxSampleAgeMs", c.ingest.maxSampleAgeMs);
  positive("ingest.maxFutureSkewMs", c.ingest.maxFutureSkewMs);
  positive("ingest.maxLogLineBytes", c.ingest.maxLogLineBytes);
  positive("ingest.headMaxBytes", c.ingest.headMaxBytes);
  positive("ingest.maxSamplesPerRecord", c.ingest.maxSamplesPerRecord);
  for (const [k, v] of Object.entries(c.limits)) positive(`limits.${k}`, v);
  if (c.limits.samplesBurst < c.limits.samplesPerSec) issues.push("limits.samplesBurst must be >= limits.samplesPerSec");
  if (c.limits.logBytesBurst < c.limits.logBytesPerSec) issues.push("limits.logBytesBurst must be >= limits.logBytesPerSec");
  if (!["debug", "info", "warn", "error", "silent"].includes(c.log.level)) issues.push("log.level must be debug, info, warn, error or silent");
  return issues;
}

export interface LoadConfigOptions {
  file?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: DeepPartial<Config>;
  cwd?: string;
}

export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  let config = defaultConfig();
  const issues: string[] = [];
  const file = opts.file ?? env.DRISHTI_CONFIG ?? (existsSync(join(cwd, "drishti.config.json")) ? join(cwd, "drishti.config.json") : undefined);
  if (file) {
    try {
      config = deepMerge(config, JSON.parse(readFileSync(resolve(cwd, file), "utf8")));
    } catch (err) {
      issues.push(`cannot read config file ${file}: ${(err as Error).message}`);
    }
  }
  const fromEnv = envPatch(env);
  issues.push(...fromEnv.issues);
  config = deepMerge(config, fromEnv.patch);
  if (opts.overrides) config = deepMerge(config, opts.overrides);
  config.dataDir = isAbsolute(config.dataDir) ? config.dataDir : resolve(cwd, config.dataDir);
  if (!config.metaDbPath) config.metaDbPath = join(config.dataDir, "meta.db");
  if (!config.storage.path) config.storage.path = join(config.dataDir, "tsdb.db");
  issues.push(...validateConfig(config));
  if (issues.length) throw new ConfigError(issues);
  return config;
}
