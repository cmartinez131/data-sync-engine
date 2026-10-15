// The store is the app's memory, kept in SQLite, fresh on every start.
// Tables:
//   translated_reports  - every report an adapter produced, appended and never updated
//   observations        - the latest report from each feed, per fight
//   feed_status         - per feed: when it last worked, the last error, running counters
//   identities          - who the third-party API's bouts and corners are, in our ids
// The API reads from here. The sync loop writes here. Nobody else touches it.
// The merge rule (merge.ts) and identity matching (identity.ts) are pure
// functions this file calls; everything that touches SQLite is here.
//
// Two clocks, and they never swap jobs:
//   fight time (round, clock) decides which feed owns which numbers
//   wall time (eventTime, receivedAt) decides ordering within a feed, and staleness
import Database from "better-sqlite3";
import { CONFIGURED_IDENTITIES, matchFight, provisionalIdentity, relabel } from "./identity.ts";
import type { Identity, Match } from "./identity.ts";
import { mergeFight } from "./merge.ts";
import { AUTHORITY, ESTIMATE, STALE_AFTER_MS } from "./types.ts";
import type { CanonicalFight, FeedStatus, MergedFight, Observation } from "./types.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS translated_reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT,
    received_at INTEGER,
    report      TEXT      -- the CanonicalFight as it reached the store: translated, with our ids, not yet merged
  );

  CREATE TABLE IF NOT EXISTS observations (
    fight_id    TEXT,
    source      TEXT,
    event_time  INTEGER,  -- the feed's own timestamp, for ignoring older data
    received_at INTEGER,  -- our clock, the last time this feed reported this fight
    fight       TEXT,     -- the CanonicalFight as JSON
    PRIMARY KEY (fight_id, source)
  );

  CREATE TABLE IF NOT EXISTS feed_status (
    provider_name        TEXT PRIMARY KEY,
    last_success_at      INTEGER,
    last_error           TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    polls                INTEGER NOT NULL DEFAULT 0,
    updated              INTEGER NOT NULL DEFAULT 0,
    unchanged            INTEGER NOT NULL DEFAULT 0,
    failed               INTEGER NOT NULL DEFAULT 0,
    rejected             INTEGER NOT NULL DEFAULT 0,
    retries              INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS identities (
    bout     TEXT PRIMARY KEY,  -- the third-party API's name for a fight
    fight_id TEXT NOT NULL,     -- our id for it, or a provisional one
    red_id   TEXT NOT NULL,
    blue_id  TEXT NOT NULL,
    how      TEXT NOT NULL      -- configured | matched | provisional
  );
`;

// The shapes SQLite hands back. Column names are snake_case, like the schema.
interface ObservationRow {
  source: string;
  received_at: number;
  fight: string;
}
interface StatusRow {
  provider_name: string;
  last_success_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
  polls: number;
  updated: number;
  unchanged: number;
  failed: number;
  rejected: number;
  retries: number;
}
interface IdentityRow {
  bout: string;
  fight_id: string;
  red_id: string;
  blue_id: string;
  how: Identity["how"];
}

let db: Database.Database | null = null;

// Open (or create) the database. Call once at startup with a file path,
// or with ":memory:" in tests for a fresh, throwaway database.
export function openStore(path: string): void {
  db?.close();
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  for (const identity of CONFIGURED_IDENTITIES) {
    db.prepare(
      "INSERT OR IGNORE INTO identities (bout, fight_id, red_id, blue_id, how) VALUES (?, ?, ?, ?, ?)",
    ).run(identity.bout, identity.fightId, identity.redId, identity.blueId, identity.how);
  }
}

function getDb(): Database.Database {
  if (db === null) throw new Error("store is not open: call openStore() first");
  return db;
}

// ---------------------------------------------------------------------------
// Reports in

// Resolve a report's ids to ours. For the UFC API that is nothing to do. For the
// third-party API: a bout we know, one we can match right now against what the
// UFC API has reported, or a provisional identity of its own until it can be.
// `learned` says when something new was decided.
export function resolveIdentity(fight: CanonicalFight): {
  fight: CanonicalFight;
  learned: Identity["how"] | null;
} {
  if (fight.source !== ESTIMATE) return { fight, learned: null };

  // A bout we already know, configured or learned earlier.
  const known = readIdentity(fight.id);
  if (known !== null) {
    const relabeled = relabel(fight, known.fightId, { red: known.redId, blue: known.blueId });
    return { fight: relabeled, learned: null };
  }

  // A new bout: match its two corners against what the UFC API has reported.
  const red = fight.fighters.find((f) => f.id === "red");
  const blue = fight.fighters.find((f) => f.id === "blue");
  let match: Match | null = null;
  if (red !== undefined && blue !== undefined) {
    match = matchFight(red, blue, authoritativeFights());
  }

  let identity: Identity;
  if (match !== null) {
    identity = {
      bout: fight.id,
      fightId: match.fightId,
      redId: match.redId,
      blueId: match.blueId,
      how: "matched",
    };
  } else {
    identity = provisionalIdentity(fight.id);
  }
  writeIdentity(identity);

  const relabeled = relabel(fight, identity.fightId, {
    red: identity.redId,
    blue: identity.blueId,
  });
  return { fight: relabeled, learned: identity.how };
}

// Keep an incoming report only if it is newer than the SAME feed's previous
// report for this fight. "updated" means we stored it. "unchanged" means this feed
// had already told us this, or something newer: repeats and out-of-order deliveries.
export function applyFight(incoming: CanonicalFight, receivedAt: number): "updated" | "unchanged" {
  const db = getDb();

  // Keep every report, even the ones we go on to ignore: the history to replay from.
  db.prepare("INSERT INTO translated_reports (source, received_at, report) VALUES (?, ?, ?)").run(
    incoming.source,
    receivedAt,
    JSON.stringify(incoming),
  );

  const current = db
    .prepare("SELECT event_time FROM observations WHERE fight_id = ? AND source = ?")
    .get(incoming.id, incoming.source) as { event_time: number } | undefined;

  if (current && incoming.eventTime <= current.event_time) {
    // Nothing new, but the feed did just report this fight: that counts for freshness.
    db.prepare("UPDATE observations SET received_at = ? WHERE fight_id = ? AND source = ?").run(
      receivedAt,
      incoming.id,
      incoming.source,
    );
    return "unchanged";
  }

  db.prepare(
    `
    INSERT INTO observations (fight_id, source, event_time, received_at, fight)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(fight_id, source) DO UPDATE SET
      event_time = excluded.event_time,
      received_at = excluded.received_at,
      fight = excluded.fight
  `,
  ).run(incoming.id, incoming.source, incoming.eventTime, receivedAt, JSON.stringify(incoming));
  return "updated";
}

// After a poll, try to attach every provisional fight to the real one, now that
// the UFC API may have reported it. On a match the third-party observation is
// re-keyed in place, so nothing the camera saw before the UFC API showed up is lost.
export function linkProvisional(): { bout: string; fightId: string }[] {
  const db = getDb();
  const linked: { bout: string; fightId: string }[] = [];
  const provisional = db
    .prepare("SELECT * FROM identities WHERE how = 'provisional'")
    .all() as IdentityRow[];
  if (provisional.length === 0) return linked;

  const candidates = authoritativeFights();
  for (const row of provisional) {
    const stored = db
      .prepare("SELECT fight FROM observations WHERE fight_id = ? AND source = ?")
      .get(row.fight_id, ESTIMATE) as { fight: string } | undefined;
    if (stored === undefined) continue;
    const fight = JSON.parse(stored.fight) as CanonicalFight;
    const red = fight.fighters.find((f) => f.id === row.red_id);
    const blue = fight.fighters.find((f) => f.id === row.blue_id);
    const match =
      red !== undefined && blue !== undefined ? matchFight(red, blue, candidates) : null;
    if (match === null) continue;

    const relabeled = relabel(fight, match.fightId, {
      [row.red_id]: match.redId,
      [row.blue_id]: match.blueId,
    });
    db.transaction(() => {
      // If the real fight somehow already has a third-party report, keep that one.
      db.prepare("DELETE FROM observations WHERE fight_id = ? AND source = ?").run(
        match.fightId,
        ESTIMATE,
      );
      db.prepare(
        "UPDATE observations SET fight_id = ?, fight = ? WHERE fight_id = ? AND source = ?",
      ).run(match.fightId, JSON.stringify(relabeled), row.fight_id, ESTIMATE);
      writeIdentity({
        bout: row.bout,
        fightId: match.fightId,
        redId: match.redId,
        blueId: match.blueId,
        how: "matched",
      });
    })();
    linked.push({ bout: row.bout, fightId: match.fightId });
  }
  return linked;
}

// Every fight the UFC API has reported, as it reported it: the roster to match against.
function authoritativeFights(): CanonicalFight[] {
  const rows = getDb()
    .prepare("SELECT fight FROM observations WHERE source = ?")
    .all(AUTHORITY) as { fight: string }[];
  return rows.map((r) => JSON.parse(r.fight) as CanonicalFight);
}

function readIdentity(bout: string): Identity | null {
  const row = getDb().prepare("SELECT * FROM identities WHERE bout = ?").get(bout) as
    IdentityRow | undefined;
  return row === undefined
    ? null
    : {
        bout: row.bout,
        fightId: row.fight_id,
        redId: row.red_id,
        blueId: row.blue_id,
        how: row.how,
      };
}

function writeIdentity(identity: Identity): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO identities (bout, fight_id, red_id, blue_id, how) VALUES (?, ?, ?, ?, ?)",
    )
    .run(identity.bout, identity.fightId, identity.redId, identity.blueId, identity.how);
}

function isProvisional(fightId: string): boolean {
  return (
    getDb()
      .prepare("SELECT 1 FROM identities WHERE fight_id = ? AND how = 'provisional'")
      .get(fightId) !== undefined
  );
}

// ---------------------------------------------------------------------------
// Fights out

export function getFight(id: string, now: number): MergedFight | null {
  const rows = getDb()
    .prepare("SELECT source, received_at, fight FROM observations WHERE fight_id = ?")
    .all(id) as ObservationRow[];
  const bySource = (source: string): Observation | null => {
    const row = rows.find((r) => r.source === source);
    return row === undefined
      ? null
      : { fight: JSON.parse(row.fight) as CanonicalFight, receivedAt: row.received_at };
  };
  return mergeFight(
    bySource(AUTHORITY),
    bySource(ESTIMATE),
    now,
    isProvisional(id) ? "provisional" : "confirmed",
  );
}

export function listFights(now: number): MergedFight[] {
  const rows = getDb()
    .prepare("SELECT DISTINCT fight_id FROM observations ORDER BY fight_id")
    .all() as { fight_id: string }[];
  return rows.map((r) => getFight(r.fight_id, now)).filter((f): f is MergedFight => f !== null);
}

// ---------------------------------------------------------------------------
// Feed health

// Called once per feed at startup so /status lists it before the first poll,
// with every counter at zero.
export function registerFeed(feed: string): void {
  getDb().prepare("INSERT OR REPLACE INTO feed_status (provider_name) VALUES (?)").run(feed);
}

// A successful poll: stamp the time, clear the error, add this poll's counts.
// `retries` is how many extra tries it needed; `rejected` how many records or
// stats in the answer the adapter could not translate (partial success).
export function recordSuccess(
  feed: string,
  at: number,
  updated: number,
  unchanged: number,
  retries: number,
  rejected = 0,
): void {
  getDb()
    .prepare(
      `
      INSERT INTO feed_status (provider_name, last_success_at, last_error, consecutive_failures, polls, updated, unchanged, retries, rejected)
      VALUES (?, ?, NULL, 0, 1, ?, ?, ?, ?)
      ON CONFLICT(provider_name) DO UPDATE SET
        last_success_at = excluded.last_success_at,
        last_error = NULL,
        consecutive_failures = 0,
        polls = polls + 1,
        updated = updated + excluded.updated,
        unchanged = unchanged + excluded.unchanged,
        retries = retries + excluded.retries,
        rejected = rejected + excluded.rejected
    `,
    )
    .run(feed, at, updated, unchanged, retries, rejected);
}

// A failed poll keeps the old success time, so the age of the last good data
// keeps counting up. "failed" is no usable answer; "rejected" is data we could not translate.
export function recordFailure(
  feed: string,
  error: string,
  kind: "failed" | "rejected",
  retries: number,
): void {
  const failed = kind === "failed" ? 1 : 0;
  const rejected = kind === "rejected" ? 1 : 0;
  getDb()
    .prepare(
      `
      INSERT INTO feed_status (provider_name, last_error, consecutive_failures, polls, failed, rejected, retries)
      VALUES (?, ?, 1, 1, ?, ?, ?)
      ON CONFLICT(provider_name) DO UPDATE SET
        last_error = excluded.last_error,
        consecutive_failures = consecutive_failures + 1,
        polls = polls + 1,
        failed = failed + excluded.failed,
        rejected = rejected + excluded.rejected,
        retries = retries + excluded.retries
    `,
    )
    .run(feed, error, failed, rejected, retries);
}

// Turn raw feed health into what a reader wants: age, stale, and the counters.
// `now` is passed in, not read from the clock, so tests can pick the time.
export function getStatus(now: number): Record<string, FeedStatus> {
  const rows = getDb()
    .prepare("SELECT * FROM feed_status ORDER BY provider_name")
    .all() as StatusRow[];
  const status: Record<string, FeedStatus> = {};
  for (const row of rows) {
    const ageMs = row.last_success_at === null ? null : now - row.last_success_at;
    status[row.provider_name] = {
      lastSuccessAt: row.last_success_at,
      lastError: row.last_error,
      ageSeconds: ageMs === null ? null : Math.floor(ageMs / 1000),
      stale: ageMs === null || ageMs > STALE_AFTER_MS,
      consecutiveFailures: row.consecutive_failures,
      counters: {
        polls: row.polls,
        updated: row.updated,
        unchanged: row.unchanged,
        failed: row.failed,
        rejected: row.rejected,
        retries: row.retries,
      },
    };
  }
  return status;
}
