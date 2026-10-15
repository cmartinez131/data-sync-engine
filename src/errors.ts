// The errors an adapter can throw, so the sync loop can tell them apart.

// The feed answered, but with data the adapter cannot translate.
// Bad data is rejected and counted. It is never stored and never retried.
export class BadDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadDataError";
  }
}

// The feed answered with a non-2xx status. A 429 or a 5xx is worth retrying,
// and a Retry-After header says how long to wait before doing so.
export class HttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, retryAfterMs: number | null = null) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// "2" -> 2000. Anything else (an HTTP date, garbage, no header) -> null.
export function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}
