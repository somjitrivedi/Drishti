export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export type LogSink = (line: string) => void;

const stdoutSink: LogSink = (line) => {
  process.stdout.write(line + "\n");
};

function serializeError(v: unknown): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
  return v;
}

export function createLogger(level: LogLevel = "info", sink: LogSink = stdoutSink, base: LogFields = {}): Logger {
  const min = rank[level];
  const emit = (lvl: Exclude<LogLevel, "silent">, msg: string, fields?: LogFields) => {
    if (rank[lvl] < min) return;
    const record: LogFields = { ts: new Date().toISOString(), level: lvl, msg, ...base };
    if (fields) for (const [k, v] of Object.entries(fields)) record[k] = serializeError(v);
    sink(JSON.stringify(record));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger(level, sink, { ...base, ...fields })
  };
}

export const silentLogger: Logger = createLogger("silent", () => {});
