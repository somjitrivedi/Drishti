import type { LogEntry } from "../ingest/logs.js";

export interface SeriesRow {
  ref: number;
  tenant: number;
  metric: string;
  key: string;
  labels: string;
  createdAt: number;
}

export interface LogBatch {
  tenant: number;
  entries: LogEntry[];
}

export interface FlushMessage {
  type: "flush";
  seq: number;
  series: SeriesRow[];
  samples: Uint8Array[];
  logs: LogBatch[];
}

export interface CloseMessage {
  type: "close";
}

export type ToWriter = FlushMessage | CloseMessage;

export type FromWriter =
  | { type: "ready" }
  | { type: "committed"; seq: number; ms: number; samples: number }
  | { type: "error"; seq: number; message: string }
  | { type: "closed" };

export interface WriterInit {
  path: string;
  fsync: boolean;
  cacheMb: number;
}
