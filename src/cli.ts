#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { ApiKeyError, createApiKey, listApiKeys, parseScopes, revokeApiKey } from "./meta/apiKeys.js";
import { currentVersion, migrate, openMetaDb, type MetaDb } from "./meta/db.js";
import { OrgError, createOrg, getOrgBySlug, listOrgs } from "./meta/orgs.js";
import { UserError, createUser, listUsers, roles, type Role } from "./meta/users.js";
import { ConfigError, loadConfig, type Config } from "./shared/config.js";
import { startApp } from "./server/app.js";
import { runLoad, type LoadFormat } from "./loadgen/run.js";

export type Args = { _: string[]; flags: Record<string, string | true> };

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) out.flags[a.slice(2)] = argv[++i]!;
      else out.flags[a.slice(2)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

class UsageError extends Error {}

function str(args: Args, name: string, fallback?: string): string {
  const v = args.flags[name];
  if (typeof v === "string") return v;
  if (fallback !== undefined) return fallback;
  throw new UsageError(`--${name} is required`);
}

function num(args: Args, name: string, fallback: number): number {
  const v = args.flags[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} must be a positive number`);
  return n;
}

function withDb<T>(config: Config, fn: (db: MetaDb) => T): T {
  const db = openMetaDb(config.metaDbPath);
  try {
    migrate(db);
    return fn(db);
  } finally {
    db.close();
  }
}

function requireOrg(db: MetaDb, slug: string) {
  const org = getOrgBySlug(db, slug);
  if (!org) throw new UsageError(`org ${slug} not found`);
  return org;
}

const seedKeyPath = (config: Config) => join(config.dataDir, "seed-key.txt");

const print = (v: unknown) => process.stdout.write((typeof v === "string" ? v : JSON.stringify(v, null, 2)) + "\n");

const HELP = `drishti <command> [flags]

  migrate                                   apply metadata migrations
  seed [--org demo] [--email E] [--password P]
                                            create a demo org, owner user and an all-scope API key
  serve                                     start the ingest server (env: DRISHTI_PORT, DRISHTI_DATA_DIR, DRISHTI_FSYNC, DRISHTI_STORAGE_DB)
  org:create --slug S --name N
  org:list
  user:create --org S --email E --name N --password P [--role owner|admin|member|viewer]
  user:list --org S
  key:create --org S --name N [--scopes ingest,query,admin]
  key:list --org S
  key:revoke --org S --id ID
  loadgen [--url U] [--key K] [--series 10000] [--rate 50000] [--duration 30]
          [--batch 2000] [--concurrency 4] [--format remote-write|json] [--logs-rate 0]`;

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || cmd === "help" || args.flags.help) {
    print(HELP);
    return 0;
  }
  const config = loadConfig({ overrides: typeof args.flags["data-dir"] === "string" ? { dataDir: args.flags["data-dir"] } : undefined });

  switch (cmd) {
    case "migrate": {
      const db = openMetaDb(config.metaDbPath);
      try {
        const applied = migrate(db);
        print({ database: config.metaDbPath, applied, version: currentVersion(db) });
      } finally {
        db.close();
      }
      return 0;
    }
    case "seed": {
      const slug = str(args, "org", "demo");
      const email = str(args, "email", "admin@drishti.local");
      const result = withDb(config, (db) => {
        const org = getOrgBySlug(db, slug) ?? createOrg(db, { slug, name: slug === "demo" ? "Demo Org" : slug });
        let password: string | undefined;
        if (!listUsers(db, org.id).some((u) => u.email === email)) {
          password = typeof args.flags.password === "string" ? args.flags.password : randomBytes(9).toString("base64url");
          createUser(db, { orgId: org.id, email, name: "Demo Owner", password, role: "owner" });
        }
        const { key } = createApiKey(db, { orgId: org.id, name: "seed", scopes: ["ingest", "query", "admin"] });
        return { org, user: email, password, key };
      });
      mkdirSync(dirname(seedKeyPath(config)), { recursive: true });
      writeFileSync(seedKeyPath(config), result.key + "\n");
      print({ ...result, password: result.password ?? "(existing user, unchanged)", keyFile: seedKeyPath(config) });
      return 0;
    }
    case "serve": {
      const app = await startApp(config);
      const stop = async () => {
        await app.close();
        process.exit(0);
      };
      process.once("SIGINT", () => void stop());
      process.once("SIGTERM", () => void stop());
      return new Promise<number>(() => {});
    }
    case "org:create":
      print(withDb(config, (db) => createOrg(db, { slug: str(args, "slug"), name: str(args, "name") })));
      return 0;
    case "org:list":
      print(withDb(config, (db) => listOrgs(db)));
      return 0;
    case "user:create": {
      const role = str(args, "role", "member") as Role;
      if (!roles.includes(role)) throw new UsageError(`--role must be one of ${roles.join(", ")}`);
      print(
        withDb(config, (db) =>
          createUser(db, { orgId: requireOrg(db, str(args, "org")).id, email: str(args, "email"), name: str(args, "name"), password: str(args, "password"), role })
        )
      );
      return 0;
    }
    case "user:list":
      print(withDb(config, (db) => listUsers(db, requireOrg(db, str(args, "org")).id)));
      return 0;
    case "key:create":
      print(
        withDb(config, (db) =>
          createApiKey(db, { orgId: requireOrg(db, str(args, "org")).id, name: str(args, "name"), scopes: parseScopes(str(args, "scopes", "ingest,query")) })
        )
      );
      return 0;
    case "key:list":
      print(withDb(config, (db) => listApiKeys(db, requireOrg(db, str(args, "org")).id)));
      return 0;
    case "key:revoke": {
      const ok = withDb(config, (db) => revokeApiKey(db, requireOrg(db, str(args, "org")).id, Number(str(args, "id"))));
      if (!ok) throw new UsageError("key not found or already revoked");
      print("revoked");
      return 0;
    }
    case "loadgen": {
      let key = typeof args.flags.key === "string" ? args.flags.key : process.env.DRISHTI_KEY;
      if (!key && existsSync(seedKeyPath(config))) key = readFileSync(seedKeyPath(config), "utf8").trim();
      if (!key) throw new UsageError("--key is required (or run seed first)");
      const format = str(args, "format", "remote-write") as LoadFormat;
      if (format !== "json" && format !== "remote-write") throw new UsageError("--format must be json or remote-write");
      const report = await runLoad({
        url: str(args, "url", `http://${config.http.host}:${config.http.port}`),
        key,
        series: num(args, "series", 10_000),
        rate: num(args, "rate", 50_000),
        durationSec: num(args, "duration", 30),
        batchSize: num(args, "batch", 2_000),
        concurrency: num(args, "concurrency", 4),
        format,
        logsPerSec: args.flags["logs-rate"] === undefined ? 0 : Number(args.flags["logs-rate"]),
        reportEverySec: num(args, "report-every", 5),
        onReport: (r) => print(JSON.stringify({ progress: r }))
      });
      print({ final: report });
      return report.failures > 0 ? 1 : 0;
    }
    default:
      throw new UsageError(`unknown command ${cmd}\n\n${HELP}`);
  }
}

const isEntry = process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1]);
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof UsageError || err instanceof ConfigError || err instanceof OrgError || err instanceof UserError || err instanceof ApiKeyError) {
        process.stderr.write(`error: ${err.message}\n`);
        process.exit(2);
      }
      process.stderr.write(`${(err as Error).stack ?? err}\n`);
      process.exit(1);
    }
  );
}
