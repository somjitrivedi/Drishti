export const SAMPLE_BYTES = 20;

export class SamplesRecordBuilder {
  private buf: Buffer;
  private count = 0;
  constructor(capacity: number) {
    this.buf = Buffer.allocUnsafe(4 + capacity * SAMPLE_BYTES);
  }
  get size(): number {
    return this.count;
  }
  get capacity(): number {
    return (this.buf.length - 4) / SAMPLE_BYTES;
  }
  add(ref: number, ts: number, value: number): void {
    const pos = 4 + this.count * SAMPLE_BYTES;
    this.buf.writeUInt32LE(ref, pos);
    this.buf.writeDoubleLE(ts, pos + 4);
    this.buf.writeDoubleLE(value, pos + 12);
    this.count++;
  }
  finish(): Buffer {
    this.buf.writeUInt32LE(this.count, 0);
    const out = Buffer.from(this.buf.subarray(0, 4 + this.count * SAMPLE_BYTES));
    this.count = 0;
    return out;
  }
}

export interface UnpackedSamples {
  refs: Uint32Array;
  ts: Float64Array;
  vals: Float64Array;
  count: number;
}

export function unpackSamples(chunks: Uint8Array[]): UnpackedSamples {
  const views = chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength));
  let total = 0;
  for (const b of views) {
    const n = b.readUInt32LE(0);
    if (b.length !== 4 + n * SAMPLE_BYTES) throw new Error("samples chunk length mismatch");
    total += n;
  }
  const refs = new Uint32Array(total);
  const ts = new Float64Array(total);
  const vals = new Float64Array(total);
  let i = 0;
  for (const b of views) {
    const n = b.readUInt32LE(0);
    for (let j = 0, pos = 4; j < n; j++, pos += SAMPLE_BYTES, i++) {
      refs[i] = b.readUInt32LE(pos);
      ts[i] = b.readDoubleLE(pos + 4);
      vals[i] = b.readDoubleLE(pos + 12);
    }
  }
  return { refs, ts, vals, count: total };
}
