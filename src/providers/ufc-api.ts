// The simulated UFC API: the authoritative scorekeeper.
// Like real UFC stats, it only publishes at fight start, at the end of each
// round, and at the end of the fight. Between those moments it repeats its
// last publication, as_of included. In the "ufc-api-lagging" scenario every
// publication after the first one becomes visible a minute late.
// Its own format: fighter ids, uppercase statuses, "4:35" clock strings,
// "23 of 41" counts, Unix-second times. Its fault: a quota of 20 requests a
// minute, like a real API. Past that it answers 429 with Retry-After.
import express from "express";
import type { Response } from "express";
import { fights, ticksSoFar } from "../world.ts";
import type { WorldFight, WorldFighter } from "../world.ts";
import type { FightResult, FighterStats } from "../types.ts";
import {
  DARK_AFTER_TICK,
  LAG_TICKS,
  LATE_START_TICK,
  faultsOn,
  ufcApiDown,
  ufcApiLagging,
  ufcApiLateStart,
} from "../scenario.ts";

export const ufcApiApp = express();

// What the scorekeeper has published for a fight, in order. A new entry is
// written whenever the status or the number of finished rounds changes.
interface Publication {
  tick: number; // when it was written
  asOf: number; // Unix seconds when it was written: the feed's own timestamp
  status: WorldFight["status"];
  finishedRounds: number;
  result: FightResult | null;
}
const publications = new Map<string, Publication[]>();

// Write a new publication if the fight has moved on, then return the one that
// is visible now: the latest, or, when lagging, the latest that is old enough.
// The first publication is always visible, so the card is never empty.
function currentPublication(fight: WorldFight): Publication {
  const history = publications.get(fight.id) ?? [];
  const finishedRounds = fight.status === "final" ? fight.rounds.length : fight.rounds.length - 1;
  const last = history[history.length - 1];
  if (
    last === undefined ||
    last.status !== fight.status ||
    last.finishedRounds !== finishedRounds
  ) {
    history.push({
      tick: ticksSoFar(),
      asOf: Math.floor(Date.now() / 1000),
      status: fight.status,
      finishedRounds,
      result: fight.result,
    });
    publications.set(fight.id, history);
  }
  const visible = history.filter(
    (p, i) => i === 0 || !ufcApiLagging() || p.tick + LAG_TICKS <= ticksSoFar(),
  );
  return visible[visible.length - 1];
}

const METHOD_CODES = { "KO/TKO": "KO", submission: "SUB", decision: "DEC" } as const;

function clockString(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function ufcApiFighter(f: WorldFighter) {
  return { fighter_id: f.id, first_name: f.firstName, last_name: f.lastName, age: f.age };
}

function ufcApiStats(fighterId: string, s: FighterStats) {
  return {
    fighter_id: fighterId,
    sig_str: `${s.sigStrikes.landed} of ${s.sigStrikes.attempted}`,
    total_str: `${s.totalStrikes.landed} of ${s.totalStrikes.attempted}`,
    td: `${s.takedowns.landed} of ${s.takedowns.attempted}`,
    kd: s.knockdowns,
    ctrl: clockString(s.controlSeconds),
  };
}

function snapshot(fight: WorldFight) {
  const pub = currentPublication(fight);
  const result = pub.result;

  // Where the scorekeeper says the fight is.
  let rnd: number;
  let clock: number;
  if (result !== null) {
    // It ended: where it ended.
    rnd = result.round;
    clock = 300 - result.timeSeconds;
  } else if (pub.finishedRounds === 0) {
    // Nothing published yet: the start of round 1.
    rnd = 1;
    clock = 300;
  } else {
    // The end of the last finished round.
    rnd = pub.finishedRounds;
    clock = 0;
  }

  return {
    fight_id: fight.id,
    status: pub.status.toUpperCase(),
    rnd,
    clock: clockString(clock),
    fighters: [ufcApiFighter(fight.red), ufcApiFighter(fight.blue)],
    // Finished rounds never change, so the world's numbers are the published numbers.
    rounds: fight.rounds.slice(0, pub.finishedRounds).map((r) => ({
      rnd: r.round,
      stats: [
        ufcApiStats(fight.red.id, r.fighters[fight.red.id]),
        ufcApiStats(fight.blue.id, r.fighters[fight.blue.id]),
      ],
    })),
    result:
      result === null
        ? null
        : {
            winner: result.winnerId,
            method: METHOD_CODES[result.method],
            rnd: result.round,
            time: clockString(result.timeSeconds),
          },
    as_of: pub.asOf,
  };
}

// Gone dark: do not answer at all, so the caller's timeout is what ends the call.
function dark(): boolean {
  if (ufcApiLateStart()) return ticksSoFar() < LATE_START_TICK;
  return ufcApiDown() && ticksSoFar() >= DARK_AFTER_TICK;
}

// Rate limit like a real API: at most LIMIT_PER_MINUTE requests in any 60 second
// window. The sync loop uses 6 of them. Curls by hand use the rest.
const LIMIT_PER_MINUTE = 20;
const recent: number[] = []; // when each allowed request in the last minute arrived, ms

function rateLimited(res: Response): boolean {
  if (!faultsOn()) return false;
  const now = Date.now();
  while (recent.length > 0 && recent[0] <= now - 60_000) recent.shift();
  if (recent.length >= LIMIT_PER_MINUTE) {
    const retryAfter = Math.ceil((recent[0] + 60_000 - now) / 1000);
    res.status(429).set("Retry-After", String(retryAfter)).json({ error: "too many requests" });
    return true;
  }
  recent.push(now);
  return false;
}

// The whole card in one call. This is what the sync loop polls.
ufcApiApp.get("/v1/fights", (_req, res) => {
  if (dark()) return;
  if (rateLimited(res)) return;
  res.json({ fights: fights.map(snapshot) });
});

// One fight, for looking at the raw feed by hand.
ufcApiApp.get("/v1/fights/:id", (req, res) => {
  if (dark()) return;
  if (rateLimited(res)) return;
  const fight = fights.find((f) => f.id === req.params.id);
  if (fight === undefined) {
    res.status(404).json({ error: "no such fight" });
    return;
  }
  res.json(snapshot(fight));
});
