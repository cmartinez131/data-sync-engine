// Retry with exponential backoff and full jitter: try, wait, try, wait longer, try.
// Only errors that might go away on their own are retried: timeouts, 429 and 5xx.
// Bad data and every other error are thrown at once.
//
// The wait before try n is random() * min(capMs, baseMs * 2^(n-2)): up to 200 ms,
// then up to 400 ms, and so on. The randomness is "full jitter": it stops many
// clients that failed at the same moment from retrying at the same moment too.
// If the feed sent Retry-After, that wait is used instead. If it asks for longer than
// capMs, the poll gives up at once rather than retry early; the next poll is the retry.
import { setTimeout as sleepFor } from "node:timers/promises";
import { BadDataError, HttpError } from "./errors.ts";

export interface RetryOptions {
  attempts: number; // total tries, including the first
  baseMs: number; // the first wait, before jitter
  capMs: number; // the longest wait we are willing to make inside one poll
  sleep?: (ms: number) => Promise<void>; // tests inject one that records instead of waiting
  random?: () => number; // [0, 1); tests inject a fixed one so waits are exact
  onRetry?: (attempt: number, waitMs: number, error: Error) => void; // called before each wait
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof BadDataError) return false;
  if (err instanceof HttpError)
    return err.status === 429 || (err.status >= 500 && err.status <= 599);
  return err instanceof Error && err.name === "TimeoutError";
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => sleepFor(ms));
  const random = opts.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.attempts || !isRetryable(err)) throw err;
      // A feed asking for more patience than capMs gets it: give up this poll now,
      // and the next poll is the retry. Hammering a feed that said "wait" is worse than waiting.
      const askedFor = retryAfter(err);
      if (askedFor !== null && askedFor > opts.capMs) throw err;
      const error = err instanceof Error ? err : new Error(String(err));
      const backoff = random() * Math.min(opts.capMs, opts.baseMs * 2 ** (attempt - 1));
      const waitMs = askedFor ?? backoff;
      opts.onRetry?.(attempt, waitMs, error);
      await sleep(waitMs);
    }
  }
}

function retryAfter(err: unknown): number | null {
  return err instanceof HttpError ? err.retryAfterMs : null;
}
