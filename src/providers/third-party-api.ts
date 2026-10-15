// The simulated third-party API: a computer-vision model watching the broadcast.
// It reports live, every call, with an estimate for every round so far,
// including the one in progress. It only sees fights that are live.
// Its own format: bouts named its own way, fighters by corner with a first
// name, a last name and an age from the vendor's roster, never our ids; counts
// as [landed, attempted] pairs, ISO times, a confidence score. It never reports
// knockdowns, status or result: those are the scorekeeper's.
// Its faults: 15% of the time it re-sends its previous answer (a duplicate),
// 10% of the time a count is one too high (noise), one frame in five sends
// takedowns as "n/a" (a broken stat), and every 13th call takes 3 seconds to
// answer, longer than the caller is willing to wait (latency).
import express from "express";
import { setTimeout as sleep } from "node:timers/promises";
import { fights, ticksSoFar } from "../world.ts";
import type { WorldFighter } from "../world.ts";
import type { FighterStats } from "../types.ts";
import { DARK_AFTER_TICK, faultsOn, thirdPartyApiDown } from "../scenario.ts";

export const thirdPartyApiApp = express();

// The third-party API's own names for the bouts. It has never heard of our ids.
const BOUT_NAMES: Record<string, string> = {
  "fight-1": "main-card-1",
  "fight-2": "main-card-2",
  "fight-3": "prelim-1",
};

function noisy(n: number): number {
  return faultsOn() && Math.random() < 0.1 ? n + 1 : n;
}

// Gone dark: do not answer at all, so the caller's timeout is what ends the call.
function dark(): boolean {
  return thirdPartyApiDown() && ticksSoFar() >= DARK_AFTER_TICK;
}

function pair(count: { landed: number; attempted: number }): [number, number] {
  const attempted = noisy(count.attempted);
  return [Math.min(noisy(count.landed), attempted), attempted];
}

function corner(f: WorldFighter) {
  return { first: f.firstName, last: f.lastName, age: f.age };
}

function thirdPartyApiStats(s: FighterStats) {
  return {
    sig: pair(s.sigStrikes),
    total: pair(s.totalStrikes),
    // Broken stat: in the flaky scenario one frame in five sends takedowns as text.
    td: faultsOn() && Math.random() < 0.2 ? "n/a" : pair(s.takedowns),
    // No kd: a camera model cannot tell a knockdown from a slip, so it does not try.
    ctrl_s: noisy(s.controlSeconds),
  };
}

let lastResponse: unknown = null;
let calls = 0;

thirdPartyApiApp.get("/feed", async (_req, res) => {
  if (dark()) return;
  calls += 1;
  // Slow: the first try times out, the retry gets a quick answer.
  if (faultsOn() && calls % 13 === 0) await sleep(3000);
  if (faultsOn() && lastResponse !== null && Math.random() < 0.15) {
    res.json(lastResponse);
    return;
  }
  const frames = fights
    .filter((f) => f.status === "live")
    .map((f) => ({
      bout: BOUT_NAMES[f.id] ?? f.id,
      corners: { red: corner(f.red), blue: corner(f.blue) },
      round_est: f.round,
      clock_est: f.clock,
      rounds: f.rounds.map((r) => ({
        rnd: r.round,
        red: thirdPartyApiStats(r.fighters[f.red.id]),
        blue: thirdPartyApiStats(r.fighters[f.blue.id]),
      })),
      conf: 0.8 + Math.random() * 0.2,
      frame_ts: new Date().toISOString(),
    }));
  const response = { frames };
  lastResponse = response;
  res.json(response);
});
