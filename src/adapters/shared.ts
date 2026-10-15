// Plumbing every adapter needs and no feed's format cares about: fetching JSON,
// translating a list of records one by one, and trying one stat at a time.
// Each adapter keeps its own format and its own map function; this is the rest.
import { BadDataError, HttpError, parseRetryAfter } from "../errors.ts";
import type { CanonicalFight, FeedAnswer } from "../types.ts";

// Fetch a URL and give back its JSON body. A non-2xx answer is an HttpError
// carrying its Retry-After. A body that is not JSON is bad data.
export async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new HttpError(res.status, parseRetryAfter(res.headers.get("retry-after")));
  }
  try {
    return await res.json();
  } catch {
    throw new BadDataError("answer is not JSON");
  }
}

// Translate a list of records one by one. A record that cannot be translated is
// rejected with its reason and the rest are kept. If every record is bad, the
// whole answer is bad. Nothing half-translated is ever returned.
export function translateAll<T>(
  records: unknown,
  what: string, // "fights" or "frames", for the error message
  label: (record: T) => string, // how to name a record in a problem
  map: (record: T, problems: string[]) => CanonicalFight,
): FeedAnswer {
  if (!Array.isArray(records)) throw new BadDataError(`answer has no ${what} list`);

  const answer: FeedAnswer = { fights: [], rejected: [] };
  for (const record of records as T[]) {
    try {
      answer.fights.push(map(record, answer.rejected));
    } catch (err) {
      answer.rejected.push(`${label(record)}: ${message(err)}`);
    }
  }

  if (answer.fights.length === 0 && answer.rejected.length > 0) {
    throw new BadDataError(answer.rejected[0]);
  }
  return answer;
}

// Run one stat's parser. If it fails, note the problem and hand back nothing,
// so that stat is a gap and the rest of the record is kept.
export function tryStat<T>(
  problems: string[],
  who: string,
  name: string,
  parse: () => T,
): T | undefined {
  try {
    return parse();
  } catch (err) {
    problems.push(`${who} ${name}: ${message(err)}`);
    return undefined;
  }
}

// A whole number, zero or more, or bad data.
export function wholeNumber(value: unknown): number {
  if (isWhole(value)) return value;
  throw new BadDataError("bad count " + JSON.stringify(value));
}

export function isWhole(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
