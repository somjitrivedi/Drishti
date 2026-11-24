import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Authenticator, extractKey } from "../auth/authenticator.js";
import { sendJson } from "../http/respond.js";
import { Router, type RequestContext } from "../http/router.js";
import { Head } from "../ingest/head.js";
import { Ingester } from "../ingest/ingester.js";
import { CachedLimits, RateLimiter } from "../ingest/limits.js";
import { SeriesRegistry } from "../ingest/registry.js";
import { migrate, openMetaDb, type MetaDb } from "../meta/db.js";
import type { Config } from "../shared/config.js";
import { HttpError, forbidden, unauthorized } from "../shared/errors.js";
import { createLogger, type Logger } from "../shared/logger.js";
import { MetricsRegistry } from "../shared/metrics.js";
import { SqliteStore } from "../storage/store.js";
import type { LoadCounts } from "../storage/load.js";
import { registerRoutes } from "./routes.js";

export interface App {
  server: Server;
  port: number;
  url: string;
  db: MetaDb;
  store: SqliteStore;
  head: Head;
  registry: SeriesRegistry;
  ingester: Ingester;
  metrics: MetricsRegistry;
  loaded: LoadCounts;
  close(): Promise<void>;
}

export interface StartOptions {
  logger?: Logger;
  clock?: () => number;
}

const LATENCY_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export async function startApp(config: Config, opts: StartOptions = {}): Promise<App> {
  const log = opts.logger ?? createLogger(config.log.level);
  const clock = opts.clock ?? Date.now;
  const db = openMetaDb(config.metaDbPath);
  const applied = migrate(db);
  if (applied.length) log.info("meta migrations applied", { versions: applied });

  const metrics = new MetricsRegistry();
  const registry = new SeriesRegistry();
  const head = new Head();
  const commitHist = metrics.histogram("drishti_storage_commit_duration_seconds", "SQLite group-commit latency", LATENCY_BUCKETS);

  const now = clock();
  const { store, loaded } = await SqliteStore.open(
    { path: config.storage.path, fsync: config.storage.fsync, flushIntervalMs: config.storage.flushIntervalMs, cacheMb: config.storage.cacheMb, logger: log, onCommit: (s) => commitHist.observe(s) },
    registry,
    head,
    { minSampleTs: now - config.ingest.maxSampleAgeMs, minLogTs: now - config.ingest.maxLogAgeMs }
  );
  log.info("head loaded from storage", { path: config.storage.path, series: loaded.series, samples: loaded.samples, logs: loaded.logs, ms: Math.round(loaded.durationMs) });

  const limits = new CachedLimits(db, config.limits, config.auth.limitsCacheTtlMs, clock);
  const auth = new Authenticator(db, config.auth.keyCacheTtlMs, clock);
  const counters = {
    samplesAccepted: metrics.counter("drishti_ingest_samples_accepted_total", "Samples accepted"),
    samplesRejected: metrics.counter("drishti_ingest_rejected_total", "Samples and log entries rejected, by reason"),
    logsAccepted: metrics.counter("drishti_ingest_log_entries_total", "Log entries accepted"),
    logBytes: metrics.counter("drishti_ingest_log_bytes_total", "Log bytes received"),
    throttled: metrics.counter("drishti_ingest_throttled_total", "Requests throttled, by reason")
  };
  const ingester = new Ingester({
    config: config.ingest,
    maxStoreBacklogBytes: config.storage.maxPendingBytes,
    store,
    head,
    registry,
    limits,
    rateLimiter: new RateLimiter(clock),
    counters,
    clock
  });

  const httpRequests = metrics.counter("drishti_http_requests_total", "HTTP requests by route and status");
  const httpLatency = metrics.histogram("drishti_http_request_duration_seconds", "HTTP request latency", LATENCY_BUCKETS);
  metrics.gauge("drishti_head_series", "Active series in the head", () => registry.count());
  metrics.gauge("drishti_head_samples", "Samples held in the head", () => head.sampleCount);
  metrics.gauge("drishti_head_log_entries", "Log entries held in the head", () => head.logCount());
  metrics.gauge("drishti_head_bytes", "Estimated head memory in bytes", () => head.bytes + registry.bytes);
  metrics.gauge("drishti_storage_backlog_bytes", "Bytes waiting for the next SQLite commit", () => store.backlogBytes);
  metrics.gauge("drishti_storage_samples_written", "Samples committed to SQLite since start", () => store.stats().samplesWritten);
  metrics.gauge("drishti_storage_commits", "SQLite group commits since start", () => store.stats().commits);

  let ready = false;
  const router = new Router();
  registerRoutes(router, { config, db, ingester, head, registry, store, limits, auth, metrics, ready: () => ready, clock });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const ctx: RequestContext = { req, res, url, params: {}, principal: null, route: "unmatched", bodyAborted: false };
    try {
      const m = router.match(req.method ?? "GET", url.pathname);
      if (!m) throw new HttpError(404, "not_found", `no route for ${url.pathname}`);
      if ("allowed" in m) throw new HttpError(405, "method_not_allowed", `use ${m.allowed.join(", ")}`, { Allow: m.allowed.join(", ") });
      ctx.route = m.route.pattern;
      ctx.params = m.params;
      if (m.route.scope !== null) {
        const principal = auth.authenticate(extractKey(req.headers));
        if (!principal) throw unauthorized();
        if (m.route.scope !== "any" && !principal.scopes.includes(m.route.scope) && !principal.scopes.includes("admin")) {
          throw forbidden(`API key lacks the ${m.route.scope} scope`);
        }
        ctx.principal = principal;
      }
      await m.route.handler(ctx);
    } catch (err) {
      const e = err instanceof HttpError ? err : null;
      if (!e) log.error("request failed", { route: ctx.route, err });
      if (!res.headersSent) {
        const headers: Record<string, string> = { ...(e?.headers ?? {}) };
        if (ctx.bodyAborted) {
          headers.Connection = "close";
          res.on("finish", () => req.socket.destroy());
        }
        sendJson(
          res,
          e?.status ?? 500,
          { error: { code: e?.code ?? "internal", message: e?.message ?? "internal server error" }, ...(e?.details ? { details: e.details } : {}) },
          headers
        );
      } else {
        res.destroy();
      }
    } finally {
      httpRequests.inc(1, { route: ctx.route, code: String(res.statusCode) });
      httpLatency.observe((performance.now() - started) / 1000);
    }
  };

  const server = createServer((req, res) => void handle(req, res));
  server.keepAliveTimeout = config.http.keepAliveTimeoutMs;
  server.headersTimeout = config.http.keepAliveTimeoutMs + 1000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.http.port, config.http.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  ready = true;
  const port = (server.address() as AddressInfo).port;
  const url = `http://${config.http.host}:${port}`;
  log.info("listening", { host: config.http.host, port, url });

  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= (async () => {
      ready = false;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 2000).unref();
      });
      await store.close();
      db.close();
      log.info("stopped");
    })();
    return closing;
  };

  return { server, port, url, db, store, head, registry, ingester, metrics, loaded, close };
}
