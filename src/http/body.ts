import { gunzipSync, inflateSync } from "node:zlib";
import { SnappyError, snappyDecompress } from "../codec/snappy.js";
import { badRequest, payloadTooLarge, unsupportedMedia } from "../shared/errors.js";
import type { RequestContext } from "./router.js";

export async function readRawBody(ctx: RequestContext, limit: number): Promise<Buffer> {
  const { req } = ctx;
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    ctx.bodyAborted = true;
    throw payloadTooLarge(`request body of ${declared} bytes exceeds the ${limit} byte limit`);
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const onData = (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        ctx.bodyAborted = true;
        cleanup();
        reject(payloadTooLarge(`request body exceeds the ${limit} byte limit`));
        return;
      }
      chunks.push(c);
    };
    const onEnd = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, size));
    };
    const onError = (err: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

export function decodeBody(raw: Buffer, encoding: string | undefined, limit: number): Buffer {
  const enc = (encoding ?? "identity").trim().toLowerCase();
  try {
    switch (enc) {
      case "":
      case "identity":
        return raw;
      case "gzip":
      case "x-gzip":
        return gunzipSync(raw, { maxOutputLength: limit });
      case "deflate":
        return inflateSync(raw, { maxOutputLength: limit });
      case "snappy":
        return Buffer.from(snappyDecompress(raw, limit));
      default:
        throw unsupportedMedia(`unsupported Content-Encoding ${enc}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) throw payloadTooLarge(`decompressed body exceeds the ${limit} byte limit`);
    if (err instanceof SnappyError && /exceeds limit/.test(err.message)) throw payloadTooLarge(err.message);
    if (err instanceof SnappyError) throw badRequest(`invalid snappy body: ${err.message}`);
    if ((err as NodeJS.ErrnoException).code?.startsWith("Z_")) throw badRequest(`invalid ${enc} body: ${(err as Error).message}`);
    throw err;
  }
}

export async function readBody(ctx: RequestContext, limit: number): Promise<Buffer> {
  const raw = await readRawBody(ctx, limit);
  return decodeBody(raw, ctx.req.headers["content-encoding"], limit);
}

export async function readJson(ctx: RequestContext, limit = 1024 * 1024): Promise<unknown> {
  const body = await readBody(ctx, limit);
  if (body.length === 0) throw badRequest("request body is required");
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (err) {
    throw badRequest(`invalid JSON: ${(err as Error).message}`);
  }
}

export function mediaType(ctx: RequestContext): string {
  return (ctx.req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
}
