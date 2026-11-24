# Drishti

Self-hosted observability for small teams: metrics, logs and alerts in one place, on one machine, without a Datadog bill.

This repository currently contains **Phase 0 (foundations)** and **Phase 1 (ingestion pipeline)**. The time-series engine with Gorilla compression, the log index, the query language, downsampling and alerting come in later phases.

## Requirements

- Node.js 22 or newer
- No Docker and no external database. Everything is stored in SQLite files under `data/`.

## Quick start

```bash
npm install
npm run db:migrate
npm run db:seed        # prints an all-scope API key and saves it to data/seed-key.txt
npm run dev            # http://127.0.0.1:9400
npm run loadgen        # 50k samples/sec for 30 s against the local server
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run db:migrate` | Applies the metadata schema migrations |
| `npm run db:seed` | Creates the `demo` org, an owner user and an API key |
| `npm run dev` / `npm run serve` | Starts the ingest server (watch mode / plain) |
| `npm run loadgen -- [flags]` | Synthetic load: `--series 10000 --rate 50000 --duration 30 --batch 2000 --concurrency 4 --format remote-write\|json --logs-rate 0` |
| `npm run typecheck` | TypeScript check of `src` and `test` |
| `npm test` | Vitest suite (unit, HTTP end-to-end and kill -9 crash recovery) |
| `npm run build` | Compiles to `dist/`; run with `node dist/cli.js serve` |
| `npm run drishti -- <cmd>` | `org:create`, `org:list`, `user:create`, `user:list`, `key:create`, `key:list`, `key:revoke` |

## Configuration

Settings come from the defaults, then an optional `drishti.config.json` (or `DRISHTI_CONFIG=path`), then environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DRISHTI_DATA_DIR` | `./data` | Holds `meta.db` (orgs, users, keys, limits) and `tsdb.db` (series, samples, logs) |
| `DRISHTI_PORT` / `DRISHTI_HOST` | `9400` / `127.0.0.1` | Listen address |
| `DRISHTI_FSYNC` | `true` | `true`: SQLite `synchronous=FULL`, acknowledged writes survive power loss. `false`: `NORMAL`, survives process crashes only |
| `DRISHTI_FLUSH_MS` | `5` | Group-commit window |
| `DRISHTI_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |

Per-tenant limits default to 100k samples/sec (burst 200k), 10 MiB/sec of logs, 500k active series and 16 MiB request bodies. You can override them per org with `PUT /api/v1/limits`.

## API

Authenticate with `Authorization: Bearer <key>` or `X-Api-Key: <key>`. Keys have scopes `ingest`, `query` and `admin`; `admin` implies the other two.

| Method and path | Scope | Purpose |
| --- | --- | --- |
| `POST /api/v1/write` | ingest | Prometheus remote-write (protobuf + snappy). 204 on success, 400 with details on partial rejection |
| `POST /api/v1/metrics` | ingest | JSON array or NDJSON: `{"name","labels","value","ts"}` or `{"name","labels","samples":[[ts,v],...]}` |
| `POST /api/v1/logs` | ingest | NDJSON or JSON array (`ts/time`, `level/severity`, `msg/message`, `service`; other fields are kept and flattened), or `text/plain` lines with a leading timestamp, level and logfmt pairs. Query parameters such as `?service=nginx&host=web-1` are added to every line |
| `GET /api/v1/me` | any | Key and org identity |
| `GET/POST /api/v1/keys`, `DELETE /api/v1/keys/:id` | admin | API key management |
| `GET/PUT /api/v1/limits` | any / admin | Effective limits and overrides |
| `GET/PUT /api/v1/retention` | any / admin | Retention policies (used from Phase 5) |
| `GET /api/v1/debug/stats`, `/debug/series`, `/debug/logs` | query | Inspect what was ingested until the query language lands |
| `GET /healthz`, `/readyz`, `/metrics` | none | Liveness, readiness and Prometheus self-metrics |

Bodies may be sent with `Content-Encoding` set to `gzip`, `deflate` or `snappy`. Decompressed size is checked against the tenant body limit.

To point Prometheus at Drishti:

```yaml
remote_write:
  - url: http://127.0.0.1:9400/api/v1/write
    authorization:
      credentials: <api key>
```

## How ingestion works

1. **Auth and limits.** The API key and the tenant limits are cached in memory. The tenant's token buckets are checked before any parsing; a full bucket returns 429 with `Retry-After`, and a batch larger than the burst returns 413.
2. **Parsing.** Remote-write is decoded by a hand-written snappy and protobuf decoder. Labels are sanitized and sorted, empty values are dropped, and the reserved `__` prefix, duplicates and oversized names or values are rejected.
3. **Validation against the head.** The in-memory head knows every series and its samples for the ingest window (2 h by default). A new series past the tenant's series limit is rejected. A sample is rejected if it is out of order or too old or new, or if it has a different value at an existing timestamp. An exact resend is accepted as a no-op, so client retries are idempotent.
4. **Durability.** Accepted rows go to a dedicated SQLite writer thread. That thread group-commits everything queued in the flush window as one transaction. The HTTP response is sent only after that commit, so an acknowledged write is on disk.
5. **Backpressure.** If the commit backlog or the head memory passes its limit, new requests get 429 until it drains.
6. **Restart.** On startup, series and the recent window of samples and logs are loaded from `tsdb.db` back into the head.

`samples` is an append-only rowid table on purpose. A `(ref, ts)` primary key dirties one B-tree page per active series on every commit, and in testing it fell from 116k to about 20k rows/sec as the table grew. Ordering and dedup live in the head instead. Phase 2 compacts these rows into Gorilla-compressed chunks.

## Phase 0-1 results

Measured on a Windows 11 laptop. The load generator ran on the same machine. Data is 10,000 series of realistic counters, gauges and latencies, with fsync on.

| Run | Result |
| --- | --- |
| Remote-write, 50k samples/sec target, 60 s, plus 2k log lines/sec | **49,955 samples/sec sustained**, 3.0M samples and 120k log lines, 0 failures, p50 60 ms, p99 234 ms, mean SQLite commit 4.7 ms |
| NDJSON, 50k samples/sec target, 20 s | 49,867 samples/sec, 0 failures |
| Remote-write, 100k target, 8 connections, 20k series | 62k samples/sec peak on this machine |
| `kill -9` during concurrent writes, then restart | every acknowledged batch present (test/crash.test.ts) |

## Layout

```
src/
  cli.ts             commands
  shared/            config, logger, errors, self-metrics
  meta/              metadata SQLite: migrations, orgs, limits, retention, users, API keys
  auth/              API key authentication cache
  codec/             snappy, protobuf reader, Prometheus remote-write
  ingest/            labels, parsers, head, series registry, rate limits, ingester
  storage/           tsdb SQLite schema, writer worker, group-commit store, startup load
  http/ server/      router, body handling, routes, app wiring
  loadgen/           synthetic metrics and logs generator
test/                vitest suites
```
