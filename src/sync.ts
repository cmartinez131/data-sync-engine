// The sync loop. Each feed gets its own loop on its own schedule: ask the feed
// for everything it has, hand each fight to the store, record whether the feed
// worked, sleep, repeat. One feed failing never stops the other, and a failure
// never crashes the app.
import { setTimeout as sleep } from "node:timers/promises";
import { fetchUfcApi } from "./adapters/ufc-api.ts";
import { fetchThirdPartyApi } from "./adapters/third-party-api.ts";
import { BadDataError } from "./errors.ts";
import { logEvent } from "./log.ts";
import { retry } from "./retry.ts";
import type { RetryOptions } from "./retry.ts";
import {
  applyFight,
  linkProvisional,
  recordFailure,
  recordSuccess,
  registerFeed,
  resolveIdentity,
} from "./store.ts";
import type { CanonicalFight, FeedAnswer, Landed, ReportedStats } from "./types.ts";

export interface SyncOptions {
  ufcApi: { url: string; intervalMs: number };
  thirdPartyApi: { url: string; intervalMs: number };
  timeoutMs: number; // give up on one fetch after this long
}

// Up to 3 tries per poll, waiting up to 200 ms, then up to 400 ms, between them.
// A Retry-After header from the feed replaces the wait, capped at 5 s.
export const RETRY: RetryOptions = { attempts: 3, baseMs: 200, capMs: 5000 };

// A feed is a name, how often to ask, and a way to fetch. The loop does not care which is which.
export interface Feed {
  name: string;
  intervalMs: number;
  fetch: (signal: AbortSignal) => Promise<FeedAnswer>;
}

export function buildFeeds(opts: SyncOptions): Feed[] {
  return [
    {
      name: "ufc-api",
      intervalMs: opts.ufcApi.intervalMs,
      fetch: (signal) => fetchUfcApi(opts.ufcApi.url, signal),
    },
    {
      name: "third-party-api",
      intervalMs: opts.thirdPartyApi.intervalMs,
      fetch: (signal) => fetchThirdPartyApi(opts.thirdPartyApi.url, signal),
    },
  ];
}

// How many times each feed has been polled, for the log.
const polls = new Map<string, number>();

// Poll every feed once, all at the same time. Handy for tests, which pass their
// own retry options so nothing waits.
export async function syncOnce(
  feeds: Feed[],
  timeoutMs: number,
  retryOpts: RetryOptions = RETRY,
): Promise<void> {
  await Promise.allSettled(feeds.map((feed) => syncFeed(feed, timeoutMs, retryOpts)));
}

async function syncFeed(feed: Feed, timeoutMs: number, retryOpts: RetryOptions): Promise<void> {
  const poll = (polls.get(feed.name) ?? 0) + 1;
  polls.set(feed.name, poll);
  const started = Date.now();
  let retries = 0;
  try {
    // Each try gets its own timeout. A retry is logged before the wait.
    const answer = await retry(() => feed.fetch(AbortSignal.timeout(timeoutMs)), {
      ...retryOpts,
      onRetry: (attempt, waitMs, error) => {
        retries += 1;
        logEvent("sync", {
          poll,
          feed: feed.name,
          event: "retry",
          attempt,
          waitMs: Math.round(waitMs),
          error: error.message,
        });
      },
    });
    const updated: string[] = []; // ids of the fights this poll changed
    for (const reported of answer.fights) {
      // Who is this? Our ids for the fight and its fighters, decided by the store.
      const { fight, learned } = resolveIdentity(reported);
      if (learned !== null) {
        log(feed.name, learned + " identity for " + reported.id + ": " + fight.id);
        logEvent("sync", {
          poll,
          feed: feed.name,
          event: "identity",
          bout: reported.id,
          fightId: fight.id,
          how: learned,
        });
      }
      if (applyFight(fight, Date.now()) === "updated") {
        updated.push(fight.id);
        logUpdate(poll, feed.name, fight);
      }
    }
    const unchanged = answer.fights.length - updated.length;
    recordSuccess(
      feed.name,
      Date.now(),
      updated.length,
      unchanged,
      retries,
      answer.rejected.length,
    );
    // A provisional fight may be matchable now that this poll has landed.
    for (const link of linkProvisional()) {
      log(feed.name, "linked " + link.bout + " to " + link.fightId);
      logEvent("sync", {
        poll,
        feed: feed.name,
        event: "identity_linked",
        bout: link.bout,
        fightId: link.fightId,
      });
    }
    log(feed.name, describe(answer.fights.length, updated, unchanged, retries, answer.rejected));
    logEvent("sync", {
      poll,
      feed: feed.name,
      event: "poll",
      fetched: answer.fights.length,
      updated: updated.length,
      unchanged,
      updatedFights: updated,
      rejected: answer.rejected,
      retries,
      ms: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Bad data is the adapter refusing to translate. Everything else is the feed not answering.
    const kind = err instanceof BadDataError ? "rejected" : "failed";
    recordFailure(feed.name, message, kind, retries);
    log(
      feed.name,
      kind === "rejected" ? `rejected bad data: ${message}` : `poll failed: ${message}`,
    );
    logEvent("sync", {
      poll,
      feed: feed.name,
      event: kind === "rejected" ? "poll_rejected" : "poll_failed",
      error: message,
      retries,
      ms: Date.now() - started,
      level: "error",
    });
  }
}

// Start one self-scheduling loop per feed: poll, sleep that feed's interval, repeat.
// Returns a function that stops them all after their current poll.
export function startSync(opts: SyncOptions): () => void {
  const feeds = buildFeeds(opts);
  let running = true;

  for (const feed of feeds) {
    registerFeed(feed.name);
    const loop = async (): Promise<void> => {
      while (running) {
        await syncFeed(feed, opts.timeoutMs, RETRY);
        await sleep(feed.intervalMs);
      }
    };
    void loop();
  }

  return () => {
    running = false;
  };
}

// "fetched 3 fight records: 1 updated (fight-1), 2 unchanged, after 1 retry"
//   fetched   = fight records in the feed's answer, one per fight it reported on
//   updated   = newer than this feed's last record for that fight, so stored
//   unchanged = this feed had already told us this, so nothing stored
//   rejected  = records or stats the adapter could not translate, with the reason
//   after N retries = only shown when the poll needed extra tries
// Zero counts are left out, so a quiet feed reads as quiet.
function describe(
  fetched: number,
  updated: string[],
  unchanged: number,
  retries: number,
  rejected: string[],
): string {
  // Problems and retries go at the end, and only when there were any.
  let suffix = "";
  if (rejected.length > 0) suffix += `, ${rejected.length} rejected (${rejected.join("; ")})`;
  if (retries === 1) suffix += ", after 1 retry";
  if (retries > 1) suffix += `, after ${retries} retries`;

  if (fetched === 0) return `fetched 0 fight records${suffix}`;

  if (fetched === 1) {
    const what = updated.length === 1 ? `updated (${updated[0]})` : "unchanged";
    return `fetched 1 fight record: ${what}${suffix}`;
  }

  // Several records: say how many went each way, or "all" when it was all of them.
  const count = (n: number): string => (n === fetched ? "all" : String(n));
  const parts: string[] = [];
  if (updated.length > 0) parts.push(`${count(updated.length)} updated (${updated.join(", ")})`);
  if (unchanged > 0) parts.push(`${count(unchanged)} unchanged`);
  return `fetched ${fetched} fight records: ${parts.join(", ")}${suffix}`;
}

// One updates.log line per report stored: where it came from, which fight, where the
// fight is, and the numbers in the latest round the report carries. The previous line
// for the same fight and feed is what it replaced.
function logUpdate(poll: number, feed: string, fight: CanonicalFight): void {
  const latest = fight.rounds[fight.rounds.length - 1];
  const numbers: Record<string, string> = {};
  if (latest !== undefined) {
    for (const [fighterId, stats] of Object.entries(latest.fighters)) {
      numbers[fighterId] = describeStats(stats);
    }
  }
  logEvent("updates", {
    poll,
    feed,
    fight: fight.id,
    status: fight.status,
    round: fight.round,
    clockSeconds: fight.clockSeconds,
    roundsReported: fight.rounds.length,
    latestRound: latest === undefined ? null : latest.round,
    numbers,
    result: fight.result,
    eventTime: fight.eventTime,
  });
}

// "sig 5/9 total 8/14 td 0/0 kd 0 ctrl 10s". A stat the feed left out shows as "-".
function describeStats(stats: ReportedStats): string {
  const pair = (p: Landed | undefined): string => {
    if (p === undefined) return "-";
    return `${p.landed}/${p.attempted}`;
  };
  const count = (n: number | undefined): string => {
    if (n === undefined) return "-";
    return String(n);
  };
  return [
    `sig ${pair(stats.sigStrikes)}`,
    `total ${pair(stats.totalStrikes)}`,
    `td ${pair(stats.takedowns)}`,
    `kd ${count(stats.knockdowns)}`,
    `ctrl ${count(stats.controlSeconds)}s`,
  ].join(" ");
}

function log(feed: string, message: string): void {
  console.log(`[sync] ${feed}: ${message}`);
}
