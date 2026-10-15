// The pretend reality: one Saturday card with three fights, run one after another.
// It moves forward on a timer. Only the simulated feeds read it.
import { logEvent } from "./log.ts";
import { emptyStats } from "./types.ts";
import type { FightResult, FighterStats, RoundStats } from "./types.ts";

export interface WorldFighter {
  id: string;
  firstName: string;
  lastName: string;
  age: number;
}

type Corner = "red" | "blue";

export interface WorldFight {
  id: string;
  red: WorldFighter;
  blue: WorldFighter;
  status: "scheduled" | "live" | "final";
  round: number;
  clock: number; // seconds left in the round
  rounds: RoundStats[]; // one entry per round so far, round 1 first
  control: Corner | null; // who is controlling the other right now
  startsAtTick: number; // a scheduled fight goes live on this tick
  finish: { atTick: number; method: "KO/TKO" | "submission"; winner: Corner } | null; // scripted, or null for a decision
  result: FightResult | null;
}

const ROUND_SECONDS = 300;
const SECONDS_PER_TICK = 5;

function newRound(round: number, red: WorldFighter, blue: WorldFighter): RoundStats {
  return { round, fighters: { [red.id]: emptyStats(), [blue.id]: emptyStats() } };
}

function fighter(id: string, firstName: string, lastName: string, age: number): WorldFighter {
  return { id, firstName, lastName, age };
}

function makeFight(
  id: string,
  red: WorldFighter,
  blue: WorldFighter,
  startsAtTick: number,
  finish: WorldFight["finish"],
): WorldFight {
  return {
    id,
    red,
    blue,
    status: startsAtTick === 0 ? "live" : "scheduled",
    round: 1,
    clock: ROUND_SECONDS,
    rounds: [newRound(1, red, blue)],
    control: null,
    startsAtTick,
    finish,
    result: null,
  };
}

// The card. Fight 1 goes the distance. Fight 2 ends by submission. Fight 3 ends by KO.
export const fights: WorldFight[] = [
  makeFight(
    "fight-1",
    fighter("f-001", "Ana", "Silva", 29),
    fighter("f-002", "Mia", "Chen", 31),
    0,
    null,
  ),
  makeFight(
    "fight-2",
    fighter("f-003", "Lena", "Novak", 27),
    fighter("f-004", "Yuki", "Tanaka", 33),
    200,
    {
      atTick: 245,
      method: "submission",
      winner: "red",
    },
  ),
  makeFight(
    "fight-3",
    fighter("f-005", "Rosa", "Duarte", 30),
    fighter("f-006", "Ha-eun", "Kim", 26),
    400,
    {
      atTick: 510,
      method: "KO/TKO",
      winner: "blue",
    },
  ),
];

let ticks = 0;
let cardFinished = false;

export function ticksSoFar(): number {
  return ticks;
}

function chance(p: number): boolean {
  return Math.random() < p;
}

function currentRound(fight: WorldFight): RoundStats {
  return fight.rounds[fight.rounds.length - 1];
}

// One tick = 5 seconds of fight time.
export function tick(): void {
  ticks += 1;
  for (const fight of fights) {
    if (fight.status === "scheduled" && ticks >= fight.startsAtTick) {
      fight.status = "live";
      logEvent("world", { event: "fight_started", tick: ticks, fight: fight.id });
    }
    if (fight.status !== "live") continue;

    fight.clock -= SECONDS_PER_TICK;
    fightFiveSeconds(fight);

    if (fight.finish !== null && ticks >= fight.finish.atTick) {
      endFight(fight, fight[fight.finish.winner].id, fight.finish.method);
    } else if (fight.clock <= 0) {
      if (fight.round === 3) {
        endFight(fight, decisionWinner(fight), "decision");
      } else {
        logEvent("world", {
          event: "round_ended",
          tick: ticks,
          fight: fight.id,
          round: fight.round,
          stats: currentRound(fight).fighters,
        });
        fight.round += 1;
        fight.clock = ROUND_SECONDS;
        fight.rounds.push(newRound(fight.round, fight.red, fight.blue));
        fight.control = null;
      }
    }
  }
  if (!cardFinished && fights.every((f) => f.status === "final")) {
    cardFinished = true;
    console.log("[world] card finished, restart to replay");
    logEvent("world", { event: "card_finished", tick: ticks });
  }
}

// What happens in five seconds of a live round.
function fightFiveSeconds(fight: WorldFight): void {
  const current = currentRound(fight);
  for (const corner of ["red", "blue"] as const) {
    const stats = current.fighters[fight[corner].id];

    if (chance(0.8)) {
      // one strike attempt
      const landed = chance(0.5);
      stats.totalStrikes.attempted += 1;
      if (landed) stats.totalStrikes.landed += 1;
      if (chance(0.6)) {
        stats.sigStrikes.attempted += 1;
        if (landed) {
          stats.sigStrikes.landed += 1;
          if (chance(0.02)) stats.knockdowns += 1;
        }
      }
    }

    if (chance(0.03)) {
      // a takedown attempt
      stats.takedowns.attempted += 1;
      if (chance(0.4)) {
        stats.takedowns.landed += 1;
        fight.control = corner;
      }
    }

    if (fight.control === corner) {
      stats.controlSeconds += SECONDS_PER_TICK;
      if (chance(0.15)) fight.control = null; // the other fighter gets free
    }
  }
}

function endFight(fight: WorldFight, winnerId: string, method: FightResult["method"]): void {
  fight.status = "final";
  fight.control = null;
  fight.result = { winnerId, method, round: fight.round, timeSeconds: ROUND_SECONDS - fight.clock };
  // The ground truth for the whole fight, in one line.
  logEvent("world", {
    event: "fight_ended",
    tick: ticks,
    fight: fight.id,
    result: fight.result,
    rounds: fight.rounds,
  });
}

// Whoever landed more significant strikes over the whole fight. Ties go to red.
function decisionWinner(fight: WorldFight): string {
  const red = sigStrikesLanded(fight, fight.red.id);
  const blue = sigStrikesLanded(fight, fight.blue.id);
  return blue > red ? fight.blue.id : fight.red.id;
}

// Significant strikes one fighter landed, added up over every round.
function sigStrikesLanded(fight: WorldFight, fighterId: string): number {
  let total = 0;
  for (const round of fight.rounds) {
    total += round.fighters[fighterId].sigStrikes.landed;
  }
  return total;
}
