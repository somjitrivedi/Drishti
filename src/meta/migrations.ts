export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "core",
    sql: `
      CREATE TABLE orgs (
        id INTEGER PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE org_limits (
        org_id INTEGER PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
        samples_per_sec INTEGER,
        samples_burst INTEGER,
        log_bytes_per_sec INTEGER,
        log_bytes_burst INTEGER,
        max_series INTEGER,
        max_body_bytes INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX users_org ON users(org_id);

      CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY,
        org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL UNIQUE,
        key_hash TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX api_keys_org ON api_keys(org_id);

      CREATE TABLE retention_policies (
        org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        signal TEXT NOT NULL CHECK (signal IN ('metrics', 'logs')),
        resolution_seconds INTEGER NOT NULL,
        retention_days INTEGER NOT NULL CHECK (retention_days > 0),
        PRIMARY KEY (org_id, signal, resolution_seconds)
      );

      CREATE TABLE dashboards (
        id INTEGER PRIMARY KEY,
        org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        uid TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        definition TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX dashboards_org ON dashboards(org_id);

      CREATE TABLE alert_rules (
        id INTEGER PRIMARY KEY,
        org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        expr TEXT NOT NULL,
        for_seconds INTEGER NOT NULL DEFAULT 0,
        eval_interval_seconds INTEGER NOT NULL DEFAULT 30,
        labels TEXT NOT NULL DEFAULT '{}',
        annotations TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (org_id, name)
      );
    `
  }
];
