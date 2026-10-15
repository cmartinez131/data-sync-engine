// The shared shapes every feed is translated into, plus two helpers for the stats.
// Below the adapters, nothing knows which feed a value came from
// except through the `source` fields.

export type FightStatus = "scheduled" | "live" | "final";

export interface FightResult {
  winnerId: string;
  method: "KO/TKO" | "submission" | "decision";
  round: number;
  timeSeconds: number; // seconds into that round
}

// A fighter as a feed described them. `id` is the feed's own id until the store
// resolves it: the UFC API's ids are ours, the third-party API only knows corners.
// First name, last name and age are what identity matching works on.
export interface Fighter {
  id: string;
  firstName: string;
  lastName: string;
  age: number | null;
  name: string; // "Ana Silva", for display
}

// "23 of 41"
export interface Landed {
  landed: number;
  attempted: number;
}

// What we count for one fighter in one round.
export interface FighterStats {
  sigStrikes: Landed;
  totalStrikes: Landed;
  takedowns: Landed;
  knockdowns: number;
  controlSeconds: number; // time spent controlling the opponent
}

export function emptyStats(): FighterStats {
  return {
    sigStrikes: { landed: 0, attempted: 0 },
    totalStrikes: { landed: 0, attempted: 0 },
    takedowns: { landed: 0, attempted: 0 },
    knockdowns: 0,
    controlSeconds: 0,
  };
}

// Add `from` into `into`, field by field.
export function addStats(into: FighterStats, from: FighterStats): void {
  into.sigStrikes.landed += from.sigStrikes.landed;
  into.sigStrikes.attempted += from.sigStrikes.attempted;
  into.totalStrikes.landed += from.totalStrikes.landed;
  into.totalStrikes.attempted += from.totalStrikes.attempted;
  into.takedowns.landed += from.takedowns.landed;
  into.takedowns.attempted += from.takedowns.attempted;
  into.knockdowns += from.knockdowns;
  into.controlSeconds += from.controlSeconds;
}

// One round's numbers for both fighters, keyed by our fighter id. Complete: the world keeps these.
export interface RoundStats {
  round: number;
  fighters: Record<string, FighterStats>;
}

// What one feed reported for a fighter in a round. Any stat may be missing:
// a feed that does not report it leaves a gap, and the other feed may fill it.
export type ReportedStats = Partial<FighterStats>;

export interface ReportedRound {
  round: number;
  fighters: Record<string, ReportedStats>;
}

// What an adapter produces: one feed's view of one fight.
export interface CanonicalFight {
  id: string; // the feed's own id for the fight until the store resolves it
  status: FightStatus | null; // The third-party API cannot know it: null
  result: FightResult | null; // The third-party API cannot know it: null
  round: number; // fight time: where this report is in the fight
  clockSeconds: number; // seconds left in that round
  fighters: Fighter[];
  rounds: ReportedRound[]; // the rounds this feed has numbers for, keyed by the same fighter ids
  eventTime: number; // wall time: when the feed says this was true, ms since epoch
  source: string; // "ufc-api" or "third-party-api"
}

// What an adapter hands the loop: the records it could translate, and the
// reasons for the ones, or the stats, it could not. Some bad is partial success.
export interface FeedAnswer {
  fights: CanonicalFight[];
  rejected: string[];
}

// The two feeds by role. The authority's ids are our ids and its numbers settle
// rounds; the estimate fills in what the authority has not published yet.
export const AUTHORITY = "ufc-api";
export const ESTIMATE = "third-party-api";

// A feed that has not reported a fight for this long has gone stale.
export const STALE_AFTER_MS = 30_000;

// One feed's latest report for one fight, as the store remembers it.
export interface Observation {
  fight: CanonicalFight;
  receivedAt: number; // our clock, the last time this feed reported this fight
}

// What the API serves: both views merged by the rule in merge.ts.
// One merged value: the number, which feed it came from, and that feed's time for it.
export interface Stat<T> {
  value: T;
  source: string;
  updatedAt: number; // ms since epoch, the feed's own timestamp for the report this came from
}

// Every stat carries its own source. null means no feed reported it.
export type MergedStats = { [K in keyof FighterStats]: Stat<FighterStats[K]> | null };

export interface MergedRound {
  round: number;
  settled: boolean; // true once the UFC API has published this round, even if a stat inside was filled from the other feed
  fighters: Record<string, MergedStats>;
}

export interface MergedFight {
  id: string;
  identity: "confirmed" | "provisional"; // confirmed: keyed by the UFC API's id. provisional: only the third-party API has seen it
  status: FightStatus | null; // The UFC API only
  result: FightResult | null; // The UFC API only
  round: number;
  clockSeconds: number;
  fighters: Fighter[];
  rounds: MergedRound[];
  totals: Record<string, FighterStats>; // the rounds added up, per fighter
  source: string; // which feed the round and clock came from
  ageSeconds: number; // how old that report is
  stale: boolean; // true when no feed has reported this fight in 30 s
}

// Running totals per feed, since startup.
export interface FeedCounters {
  polls: number; // how many times we asked
  updated: number; // fight records that were newer and got stored
  unchanged: number; // fight records the feed had already given us
  failed: number; // polls that got no usable answer: timeout, HTTP error
  rejected: number; // records, or single stats, the adapter could not translate
  retries: number; // extra tries made inside polls, after a timeout, a 429 or a 5xx
}

// What /status says about each feed.
export interface FeedStatus {
  lastSuccessAt: number | null; // ms since epoch, null until the first success
  lastError: string | null; // null when the last attempt worked
  ageSeconds: number | null; // how old the last good data is, null if none yet
  stale: boolean; // true when there is no data or it is older than 30 s
  consecutiveFailures: number; // failed or rejected polls in a row, 0 after a success
  counters: FeedCounters;
}
