export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
    readonly details?: unknown
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, "bad_request", message, {}, details);
export const unauthorized = (message = "missing or invalid API key") => new HttpError(401, "unauthorized", message);
export const forbidden = (message: string) => new HttpError(403, "forbidden", message);
export const notFound = (message = "not found") => new HttpError(404, "not_found", message);
export const payloadTooLarge = (message: string) => new HttpError(413, "payload_too_large", message);
export const unsupportedMedia = (message: string) => new HttpError(415, "unsupported_media_type", message);

export function tooManyRequests(message: string, retryAfterSec: number, code = "rate_limited"): HttpError {
  return new HttpError(429, code, message, { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSec))) });
}

export const unavailable = (message: string) => new HttpError(503, "unavailable", message, { "Retry-After": "5" });
