export class SnappyError extends Error {}

function readPreamble(src: Uint8Array): { length: number; offset: number } {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 5 && i < src.length; i++) {
    const b = src[i]!;
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return { length: result, offset: i + 1 };
    shift += 7;
  }
  throw new SnappyError("invalid snappy length preamble");
}

export function snappyUncompressedLength(src: Uint8Array): number {
  return readPreamble(src).length;
}

export function snappyDecompress(src: Uint8Array, maxLength = Number.MAX_SAFE_INTEGER): Uint8Array {
  const { length, offset } = readPreamble(src);
  if (length > maxLength) throw new SnappyError(`decompressed size ${length} exceeds limit ${maxLength}`);
  const out = new Uint8Array(length);
  let ip = offset;
  let op = 0;
  const n = src.length;
  while (ip < n) {
    const tag = src[ip++]!;
    const kind = tag & 3;
    if (kind === 0) {
      let len = tag >>> 2;
      if (len >= 60) {
        const bytes = len - 59;
        if (ip + bytes > n) throw new SnappyError("truncated literal length");
        len = 0;
        for (let i = 0; i < bytes; i++) len += src[ip + i]! * 2 ** (8 * i);
        ip += bytes;
      }
      len += 1;
      if (ip + len > n) throw new SnappyError("truncated literal");
      if (op + len > length) throw new SnappyError("literal overflows output");
      out.set(src.subarray(ip, ip + len), op);
      ip += len;
      op += len;
      continue;
    }
    let len: number;
    let off: number;
    if (kind === 1) {
      if (ip >= n) throw new SnappyError("truncated copy1");
      len = ((tag >>> 2) & 7) + 4;
      off = ((tag >>> 5) << 8) | src[ip]!;
      ip += 1;
    } else if (kind === 2) {
      if (ip + 2 > n) throw new SnappyError("truncated copy2");
      len = (tag >>> 2) + 1;
      off = src[ip]! | (src[ip + 1]! << 8);
      ip += 2;
    } else {
      if (ip + 4 > n) throw new SnappyError("truncated copy4");
      len = (tag >>> 2) + 1;
      off = (src[ip]! | (src[ip + 1]! << 8) | (src[ip + 2]! << 16)) + src[ip + 3]! * 0x1000000;
      ip += 4;
    }
    if (off === 0 || off > op) throw new SnappyError("invalid copy offset");
    if (op + len > length) throw new SnappyError("copy overflows output");
    if (off >= len) {
      out.copyWithin(op, op - off, op - off + len);
      op += len;
    } else {
      for (let i = 0; i < len; i++, op++) out[op] = out[op - off]!;
    }
  }
  if (op !== length) throw new SnappyError(`decompressed ${op} bytes, expected ${length}`);
  return out;
}

const HASH_BITS = 14;
const HASH_MUL = 0x1e35a7bd;

export function snappyCompress(src: Uint8Array): Uint8Array {
  const n = src.length;
  const out = new Uint8Array(32 + n + Math.ceil(n / 6));
  let op = 0;
  let v = n;
  while (v >= 0x80) {
    out[op++] = (v & 0x7f) | 0x80;
    v = Math.floor(v / 128);
  }
  out[op++] = v;

  const emitLiteral = (from: number, to: number) => {
    const len = to - from;
    if (len <= 0) return;
    const l = len - 1;
    if (l < 60) out[op++] = l << 2;
    else if (l < 0x100) {
      out[op++] = 60 << 2;
      out[op++] = l;
    } else if (l < 0x10000) {
      out[op++] = 61 << 2;
      out[op++] = l & 0xff;
      out[op++] = l >>> 8;
    } else if (l < 0x1000000) {
      out[op++] = 62 << 2;
      out[op++] = l & 0xff;
      out[op++] = (l >>> 8) & 0xff;
      out[op++] = l >>> 16;
    } else {
      out[op++] = 63 << 2;
      out[op++] = l & 0xff;
      out[op++] = (l >>> 8) & 0xff;
      out[op++] = (l >>> 16) & 0xff;
      out[op++] = l >>> 24;
    }
    out.set(src.subarray(from, to), op);
    op += len;
  };

  const emitCopy2 = (offset: number, len: number) => {
    out[op++] = ((len - 1) << 2) | 2;
    out[op++] = offset & 0xff;
    out[op++] = offset >>> 8;
  };

  const emitCopy = (offset: number, len: number) => {
    while (len >= 68) {
      emitCopy2(offset, 64);
      len -= 64;
    }
    if (len > 64) {
      emitCopy2(offset, 60);
      len -= 60;
    }
    if (len <= 11 && offset < 2048) {
      out[op++] = ((offset >>> 8) << 5) | ((len - 4) << 2) | 1;
      out[op++] = offset & 0xff;
    } else {
      emitCopy2(offset, len);
    }
  };

  if (n < 16) {
    emitLiteral(0, n);
    return out.slice(0, op);
  }

  const table = new Int32Array(1 << HASH_BITS).fill(-1);
  const read32 = (i: number) => (src[i]! | (src[i + 1]! << 8) | (src[i + 2]! << 16) | (src[i + 3]! << 24)) >>> 0;
  let ip = 0;
  let litStart = 0;
  const limit = n - 4;
  while (ip <= limit) {
    const cur = read32(ip);
    const h = Math.imul(cur, HASH_MUL) >>> (32 - HASH_BITS);
    const cand = table[h]!;
    table[h] = ip;
    if (cand >= 0 && ip - cand < 0x10000 && read32(cand) === cur) {
      emitLiteral(litStart, ip);
      let len = 4;
      while (ip + len < n && src[cand + len] === src[ip + len]) len++;
      emitCopy(ip - cand, len);
      ip += len;
      litStart = ip;
    } else {
      ip++;
    }
  }
  emitLiteral(litStart, n);
  return out.slice(0, op);
}
