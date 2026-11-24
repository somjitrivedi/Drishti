import type { Authenticator } from "../auth/authenticator.js";
import { decodeWriteRequest } from "../codec/remoteWrite.js";
import { ProtobufError } from "../codec/protobuf.js";
import { decodeBody, mediaType, readJson, readRawBody } from "../http/body.js";
import { sendEmpty, sendJson, sendText } from "../http/respond.js";
import type { RequestContext, Router } from "../http/router.js";
import { ApiKeyError, createApiKey, listApiKeys, parseScopes, revokeApiKey } from "../meta/apiKeys.js";
import type { MetaDb } from "../meta/db.js";
import { OrgError, getLimitOverrides, listRetention, setLimitOverrides, setRetention, type RetentionPolicy } from "../meta/orgs.js";
import type { Config, TenantLimits } from "../shared/config.js";
import { badRequest, notFound, unsupportedMedia } from "../shared/errors.js";
import type { MetricsRegistry } from "../shared/metrics.js";
import type { SqliteStore } from "../storage/store.js";
import type { Head } from "../ingest/head.js";
import { resultStatus, type IngestIssue, type Ingester } from "../ingest/ingester.js";
import { METRIC_NAME, formatSeries } from "../ingest/labels.js";
import type { CachedLimits } from "../ingest/limits.js";
import { parseLogBody } from "../ingest/logs.js";
import { parseMetricsJson, type IncomingSeries } from "../ingest/metricsJson.js";
import type { SeriesRegistry } from "../ingest/registry.js";

export interface RouteDeps {
  config: Config;
  db: MetaDb;
  ingester: Ingester;
  head: Head;
  registry: SeriesRegistry;
  store: SqliteStore;
  limits: CachedLimits;
  auth: Authenticator;
  metrics: MetricsRegistry;
  ready: () => boolean;
  clock: () => number;
}

function tenantOf(ctx: RequestContext): number {
  return ctx.principal!.orgId;
}

function intParam(ctx: RequestContext, name: string, fallback: number, max: number): number {
  const raw = ctx.url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${name} must be a positive integer`);
  return Math.min(n, max);
}

function optionalNumber(ctx: RequestContext, name: string): number | undefined {
  const raw = ctx.url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw badRequest(`${name} must be a number`);
  return n;
}

export function registerRoutes(router: Router, d: RouteDeps): void {
  const bodyLimit = (ctx: RequestContext) => d.limits.get(tenantOf(ctx)).maxBodyBytes;

  router.add("GET", "/healthz", null, (ctx) => sendJson(ctx.res, 200, { status: "ok" }));

  router.add("GET", "/readyz", null, (ctx) => {
    if (!d.ready() || d.store.failed) return sendJson(ctx.res, 503, { status: "not_ready", storageFailed: Boolean(d.store.failed) });
    sendJson(ctx.res, 200, { status: "ready" });
  });

  router.add("GET", "/metrics", null, (ctx) => sendText(ctx.res, 200, d.metrics.render(), "text/plain; version=0.0.4; charset=utf-8"));

  router.add("GET", "/api/v1/me", "any", (ctx) => {
    const p = ctx.principal!;
    sendJson(ctx.res, 200, { org: { id: p.orgId, slug: p.orgSlug }, key: { id: p.keyId, name: p.keyName, scopes: p.scopes } });
  });

  router.add("POST", "/api/v1/write", "ingest", async (ctx) => {
    d.ingester.checkCapacity();
    const limit = bodyLimit(ctx);
    const raw = await readRawBody(ctx, limit);
    const encoding = ctx.req.headers["content-encoding"] ?? "snappy";
    const body = decodeBody(raw, encoding, limit);
    let decoded;
    try {
      decoded = decodeWriteRequest(body);
    } catch (err) {
      if (err instanceof ProtobufError) throw badRequest(`invalid remote-write payload: ${err.message}`);
      throw err;
    }
    const series: IncomingSeries[] = decoded.timeseries.map((ts, index) => ({
      index,
      labels: ts.labels,
      samples: ts.samples.map((s) => ({ ts: s.timestamp, value: s.value }))
    }));
    const result = await d.ingester.ingestSamples(tenantOf(ctx), series);
    if (result.rejected === 0) return sendEmpty(ctx.res, 204);
    sendJson(ctx.res, 400, { error: { code: "partial_write", message: `${result.rejected} samples rejected, ${result.accepted} accepted` }, ...result });
  });

  router.add("POST", "/api/v1/metrics", "ingest", async (ctx) => {
    d.ingester.checkCapacity();
    const type = mediaType(ctx);
    if (type && !["application/json", "application/x-ndjson", "application/jsonl", "text/plain"].includes(type)) {
      throw unsupportedMedia("metrics accept application/json or application/x-ndjson");
    }
    const raw = await readRawBody(ctx, bodyLimit(ctx));
    const body = decodeBody(raw, ctx.req.headers["content-encoding"], bodyLimit(ctx)).toString("utf8");
    const { series, issues } = parseMetricsJson(body, d.clock());
    const pre: IngestIssue[] = issues.map((i) => ({ index: i.index, reason: "parse_error", message: i.reason }));
    if (series.length === 0 && pre.length === 0) throw badRequest("no metrics in request body");
    const result = await d.ingester.ingestSamples(tenantOf(ctx), series, pre);
    sendJson(ctx.res, resultStatus(result), result);
  });

  router.add("POST", "/api/v1/logs", "ingest", async (ctx) => {
    d.ingester.checkCapacity();
    const type = mediaType(ctx);
    let mode: "json" | "text";
    if (type === "" || type === "application/json" || type === "application/x-ndjson" || type === "application/jsonl") mode = "json";
    else if (type === "text/plain") mode = "text";
    else throw unsupportedMedia("logs accept application/json, application/x-ndjson or text/plain");
    const raw = await readRawBody(ctx, bodyLimit(ctx));
    const decoded = decodeBody(raw, ctx.req.headers["content-encoding"], bodyLimit(ctx));
    const extraFields: Record<string, string> = {};
    for (const [k, v] of ctx.url.searchParams) if (k !== "service") extraFields[k] = v;
    const parsed = parseLogBody(decoded.toString("utf8"), mode, {
      now: d.clock(),
      defaultService: ctx.url.searchParams.get("service") ?? (ctx.req.headers["x-drishti-service"] as string | undefined),
      extraFields,
      maxLineBytes: d.config.ingest.maxLogLineBytes,
      maxFields: d.config.ingest.maxLogFields
    });
    if (parsed.entries.length === 0 && parsed.errors.length === 0) throw badRequest("no log lines in request body");
    const pre: IngestIssue[] = parsed.errors.map((e) => ({ index: e.line, reason: "parse_error", message: e.reason }));
    const result = await d.ingester.ingestLogs(tenantOf(ctx), parsed.entries, decoded.length, pre);
    sendJson(ctx.res, resultStatus(result), result);
  });

  router.add("GET", "/api/v1/keys", "admin", (ctx) => {
    sendJson(ctx.res, 200, { keys: listApiKeys(d.db, tenantOf(ctx)) });
  });

  router.add("POST", "/api/v1/keys", "admin", async (ctx) => {
    const body = (await readJson(ctx)) as { name?: unknown; scopes?: unknown };
    try {
      if (typeof body?.name !== "string") throw new ApiKeyError("name is required");
      const scopes = parseScopes(Array.isArray(body.scopes) || typeof body.scopes === "string" ? (body.scopes as string[] | string) : "");
      const { key, record } = createApiKey(d.db, { orgId: tenantOf(ctx), name: body.name, scopes });
      sendJson(ctx.res, 201, { key, record });
    } catch (err) {
      if (err instanceof ApiKeyError) throw badRequest(err.message);
      throw err;
    }
  });

  router.add("DELETE", "/api/v1/keys/:id", "admin", (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id)) throw badRequest("key id must be an integer");
    if (!revokeApiKey(d.db, tenantOf(ctx), id)) throw notFound("key not found or already revoked");
    d.auth.invalidate();
    sendEmpty(ctx.res, 204);
  });

  router.add("GET", "/api/v1/limits", "any", (ctx) => {
    const tenant = tenantOf(ctx);
    sendJson(ctx.res, 200, { effective: d.limits.get(tenant), overrides: getLimitOverrides(d.db, tenant), defaults: d.config.limits });
  });

  router.add("PUT", "/api/v1/limits", "admin", async (ctx) => {
    const tenant = tenantOf(ctx);
    const body = await readJson(ctx);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("body must be an object of limits");
    try {
      const overrides = setLimitOverrides(d.db, tenant, body as Partial<Record<keyof TenantLimits, number | null>>);
      d.limits.invalidate(tenant);
      sendJson(ctx.res, 200, { effective: d.limits.get(tenant), overrides });
    } catch (err) {
      if (err instanceof OrgError) throw badRequest(err.message);
      throw err;
    }
  });

  router.add("GET", "/api/v1/retention", "any", (ctx) => sendJson(ctx.res, 200, { policies: listRetention(d.db, tenantOf(ctx)) }));

  router.add("PUT", "/api/v1/retention", "admin", async (ctx) => {
    const body = (await readJson(ctx)) as { policies?: unknown };
    if (!Array.isArray(body?.policies)) throw badRequest("policies must be an array");
    try {
      sendJson(ctx.res, 200, { policies: setRetention(d.db, tenantOf(ctx), body.policies as RetentionPolicy[]) });
    } catch (err) {
      if (err instanceof OrgError) throw badRequest(err.message);
      throw err;
    }
  });

  router.add("GET", "/api/v1/debug/stats", "query", (ctx) => {
    const tenant = tenantOf(ctx);
    let samples = 0;
    for (const s of d.registry.list(tenant)) samples += d.head.summary(s.ref).samples;
    sendJson(ctx.res, 200, {
      tenant: { series: d.registry.count(tenant), samples, logs: d.head.logCount(tenant) },
      head: { bytes: d.head.bytes + d.registry.bytes, maxBytes: d.config.ingest.headMaxBytes },
      storage: d.store.stats()
    });
  });

  router.add("GET", "/api/v1/debug/series", "query", (ctx) => {
    const tenant = tenantOf(ctx);
    const name = ctx.url.searchParams.get("name");
    const prefix = ctx.url.searchParams.get("prefix");
    const matchers = ctx.url.searchParams.getAll("label").map((m) => {
      const i = m.indexOf("=");
      if (i <= 0) throw badRequest("label filters look like label=name=value");
      return [m.slice(0, i), m.slice(i + 1)] as const;
    });
    const limit = intParam(ctx, "limit", 100, 10_000);
    const withSamples = ctx.url.searchParams.get("samples") === "true";
    const from = optionalNumber(ctx, "from");
    const to = optionalNumber(ctx, "to");
    const out: unknown[] = [];
    let matched = 0;
    for (const s of d.registry.list(tenant)) {
      const metric = s.labels.find((l) => l.name === METRIC_NAME)?.value ?? "";
      if (name && metric !== name) continue;
      if (prefix && !metric.startsWith(prefix)) continue;
      if (!matchers.every(([k, v]) => s.labels.some((l) => l.name === k && l.value === v))) continue;
      matched++;
      if (out.length >= limit) continue;
      const entry: Record<string, unknown> = {
        series: formatSeries(s.labels),
        labels: Object.fromEntries(s.labels.map((l) => [l.name, l.value])),
        ...d.head.summary(s.ref)
      };
      if (withSamples) {
        const r = d.head.range(s.ref, from, to, 10_000);
        entry.points = r.ts.map((t, i) => [t, r.values[i]]);
      }
      out.push(entry);
    }
    sendJson(ctx.res, 200, { matched, series: out });
  });

  router.add("GET", "/api/v1/debug/logs", "query", (ctx) => {
    const p = ctx.url.searchParams;
    const entries = d.head.queryLogs(tenantOf(ctx), {
      service: p.get("service") ?? undefined,
      level: p.get("level") ?? undefined,
      contains: p.get("contains") ?? undefined,
      from: optionalNumber(ctx, "from"),
      to: optionalNumber(ctx, "to"),
      limit: intParam(ctx, "limit", 100, 5_000)
    });
    sendJson(ctx.res, 200, { entries });
  });
}
