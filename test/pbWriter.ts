export class PbWriter {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  pos = 0;

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  varint(v: number): this {
    this.ensure(10);
    if (v < 0) {
      let b = BigInt.asUintN(64, BigInt(v));
      while (b >= 0x80n) {
        this.buf[this.pos++] = Number(b & 0x7fn) | 0x80;
        b >>= 7n;
      }
      this.buf[this.pos++] = Number(b);
      return this;
    }
    while (v >= 0x80) {
      this.buf[this.pos++] = (v % 128) | 0x80;
      v = Math.floor(v / 128);
    }
    this.buf[this.pos++] = v;
    return this;
  }

  tag(field: number, wire: number): this {
    return this.varint(field * 8 + wire);
  }

  double(field: number, v: number): this {
    this.tag(field, 1);
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
    return this;
  }

  int64(field: number, v: number): this {
    return this.tag(field, 0).varint(v);
  }

  bytes(field: number, data: Uint8Array): this {
    this.tag(field, 2).varint(data.length);
    this.ensure(data.length);
    this.buf.set(data, this.pos);
    this.pos += data.length;
    return this;
  }

  string(field: number, s: string): this {
    return this.bytes(field, Buffer.from(s, "utf8"));
  }

  message(field: number, build: (w: PbWriter) => void): this {
    const inner = new PbWriter();
    build(inner);
    return this.bytes(field, inner.finish());
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}
