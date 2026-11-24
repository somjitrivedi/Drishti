export class ProtobufError extends Error {}

export function varintSize(v: number): number {
  if (v < 0) return 10;
  let n = 1;
  while (v >= 0x80) {
    v = Math.floor(v / 128);
    n++;
  }
  return n;
}

export class PbReader {
  pos: number;
  private readonly view: DataView;
  private readonly buf: Buffer;
  constructor(
    readonly bytes: Uint8Array,
    start = 0,
    public end = bytes.length
  ) {
    this.pos = start;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  fail(message: string): never {
    throw new ProtobufError(message);
  }

  done(): boolean {
    return this.pos >= this.end;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    const start = this.pos;
    while (true) {
      if (this.pos >= this.end) throw new ProtobufError("truncated varint");
      const b = this.bytes[this.pos++]!;
      if (shift < 49) {
        result += (b & 0x7f) * 2 ** shift;
      } else {
        return this.bigVarint(start);
      }
      if ((b & 0x80) === 0) return result;
      shift += 7;
    }
  }

  private bigVarint(start: number): number {
    let v = 0n;
    let shift = 0n;
    this.pos = start;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new ProtobufError("truncated varint");
      const b = this.bytes[this.pos++]!;
      v |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return Number(BigInt.asIntN(64, v));
      shift += 7n;
    }
    throw new ProtobufError("varint too long");
  }

  tag(): { field: number; wire: number } {
    const t = this.varint();
    return { field: Math.floor(t / 8), wire: t & 7 };
  }

  double(): number {
    if (this.pos + 8 > this.end) throw new ProtobufError("truncated double");
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  lengthDelimited(): { start: number; end: number } {
    const len = this.varint();
    const start = this.pos;
    const end = start + len;
    if (end > this.end) throw new ProtobufError("truncated length-delimited field");
    this.pos = end;
    return { start, end };
  }

  string(): string {
    const { start, end } = this.lengthDelimited();
    return this.buf.toString("utf8", start, end);
  }

  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.varint();
        return;
      case 1:
        this.pos += 8;
        break;
      case 2:
        this.lengthDelimited();
        return;
      case 5:
        this.pos += 4;
        break;
      default:
        throw new ProtobufError(`unsupported wire type ${wire}`);
    }
    if (this.pos > this.end) throw new ProtobufError("truncated field");
  }
}
