import { PbReader, varintSize } from "./protobuf.js";

export interface RwSample {
  value: number;
  timestamp: number;
}

export interface RwTimeSeries {
  labels: Array<[string, string]>;
  samples: RwSample[];
}

export interface RwDecodeStats {
  skippedExemplars: number;
  skippedHistograms: number;
}

function decodeLabel(r: PbReader, end: number): [string, string] {
  const outer = r.end;
  r.end = end;
  let name = "";
  let value = "";
  while (!r.done()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) name = r.string();
    else if (field === 2 && wire === 2) value = r.string();
    else r.skip(wire);
  }
  r.end = outer;
  return [name, value];
}

function decodeSample(r: PbReader, end: number): RwSample {
  const outer = r.end;
  r.end = end;
  let value = 0;
  let timestamp = 0;
  while (!r.done()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 1) value = r.double();
    else if (field === 2 && wire === 0) timestamp = r.varint();
    else r.skip(wire);
  }
  r.end = outer;
  return { value, timestamp };
}

function decodeTimeSeries(r: PbReader, end: number, stats: RwDecodeStats): RwTimeSeries {
  const outer = r.end;
  r.end = end;
  const labels: Array<[string, string]> = [];
  const samples: RwSample[] = [];
  while (!r.done()) {
    const { field, wire } = r.tag();
    if (wire === 2 && (field === 1 || field === 2)) {
      const len = r.varint();
      const subEnd = r.pos + len;
      if (subEnd > end) r.fail("truncated nested message");
      if (field === 1) labels.push(decodeLabel(r, subEnd));
      else samples.push(decodeSample(r, subEnd));
      r.pos = subEnd;
    } else {
      if (field === 3) stats.skippedExemplars++;
      if (field === 4) stats.skippedHistograms++;
      r.skip(wire);
    }
  }
  r.end = outer;
  return { labels, samples };
}

export function decodeWriteRequest(bytes: Uint8Array): { timeseries: RwTimeSeries[]; stats: RwDecodeStats } {
  const r = new PbReader(bytes);
  const timeseries: RwTimeSeries[] = [];
  const stats: RwDecodeStats = { skippedExemplars: 0, skippedHistograms: 0 };
  while (!r.done()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) {
      const len = r.varint();
      const end = r.pos + len;
      if (end > bytes.length) r.fail("truncated timeseries");
      timeseries.push(decodeTimeSeries(r, end, stats));
      r.pos = end;
    } else {
      r.skip(wire);
    }
  }
  return { timeseries, stats };
}

function writeVarint(buf: Buffer, pos: number, v: number): number {
  if (v < 0) {
    let b = BigInt.asUintN(64, BigInt(v));
    while (b >= 0x80n) {
      buf[pos++] = Number(b & 0x7fn) | 0x80;
      b >>= 7n;
    }
    buf[pos++] = Number(b);
    return pos;
  }
  while (v >= 0x80) {
    buf[pos++] = (v % 128) | 0x80;
    v = Math.floor(v / 128);
  }
  buf[pos++] = v;
  return pos;
}

export function encodeWriteRequest(series: RwTimeSeries[]): Uint8Array {
  const plan = series.map((ts) => {
    const labels = ts.labels.map(([n, v]) => {
      const nl = Buffer.byteLength(n, "utf8");
      const vl = Buffer.byteLength(v, "utf8");
      const size = 1 + varintSize(nl) + nl + 1 + varintSize(vl) + vl;
      return { n, v, nl, vl, size };
    });
    const samples = ts.samples.map((s) => ({ s, size: 9 + 1 + varintSize(s.timestamp) }));
    let size = 0;
    for (const l of labels) size += 1 + varintSize(l.size) + l.size;
    for (const s of samples) size += 1 + varintSize(s.size) + s.size;
    return { labels, samples, size };
  });
  let total = 0;
  for (const p of plan) total += 1 + varintSize(p.size) + p.size;
  const buf = Buffer.allocUnsafe(total);
  let pos = 0;
  for (const p of plan) {
    buf[pos++] = 0x0a;
    pos = writeVarint(buf, pos, p.size);
    for (const l of p.labels) {
      buf[pos++] = 0x0a;
      pos = writeVarint(buf, pos, l.size);
      buf[pos++] = 0x0a;
      pos = writeVarint(buf, pos, l.nl);
      pos += buf.write(l.n, pos, "utf8");
      buf[pos++] = 0x12;
      pos = writeVarint(buf, pos, l.vl);
      pos += buf.write(l.v, pos, "utf8");
    }
    for (const s of p.samples) {
      buf[pos++] = 0x12;
      pos = writeVarint(buf, pos, s.size);
      buf[pos++] = 0x09;
      buf.writeDoubleLE(s.s.value, pos);
      pos += 8;
      buf[pos++] = 0x10;
      pos = writeVarint(buf, pos, s.s.timestamp);
    }
  }
  return buf;
}
