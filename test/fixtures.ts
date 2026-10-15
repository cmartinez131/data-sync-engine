// Small builders shared by the store and sync tests.
import type { Observation } from "../src/types.ts";
import type { Feed } from "../src/sync.ts";
import { emptyStats } from "../src/types.ts";
import type { CanonicalFight, Fighter, ReportedRound } from "../src/types.ts";

// Fight 1's fighters as the UFC API reports them, with our ids.
export const FIGHTERS: Fighter[] = [
  { id: "f-001", firstName: "Ana", lastName: "Silva", age: 29, name: "Ana Silva" },
  { id: "f-002", firstName: "Mia", lastName: "Chen", age: 31, name: "Mia Chen" },
];

// The same two people as the third-party API reports them: by corner, no ids.
export const CORNERS: Fighter[] = [
  { id: "red", firstName: "Ana", lastName: "Silva", age: 29, name: "Ana Silva" },
  { id: "blue", firstName: "Mia", lastName: "Chen", age: 31, name: "Mia Chen" },
];

// A round where red and blue landed the given significant strikes, keyed by our ids.
export function roundOf(round: number, redLanded: number, blueLanded: number): ReportedRound {
  return { round, fighters: { "f-001": sig(redLanded), "f-002": sig(blueLanded) } };
}

// The same round keyed the way a third-party frame keys it, before identity is resolved.
export function cornerRound(round: number, redLanded: number, blueLanded: number): ReportedRound {
  return { round, fighters: { red: sig(redLanded), blue: sig(blueLanded) } };
}

function sig(landed: number) {
  const stats = emptyStats();
  stats.sigStrikes = { landed, attempted: landed * 2 };
  return stats;
}

// One feed's report for fight-1 with our ids already in place, any field overridden.
// Store tests use this to feed the merge rule directly.
export function report(
  source: "ufc-api" | "third-party-api",
  overrides: Partial<CanonicalFight> = {},
): CanonicalFight {
  return {
    id: "fight-1",
    status: source === "ufc-api" ? "live" : null,
    result: null,
    round: 1,
    clockSeconds: 300,
    fighters: FIGHTERS,
    rounds: [],
    eventTime: 1000,
    source,
    ...overrides,
  };
}

// A third-party report as the adapter hands it to the loop: the feed's bout name
// and corner ids, for the store to resolve. Sync tests use this.
export function frame(overrides: Partial<CanonicalFight> = {}): CanonicalFight {
  return { ...report("third-party-api"), id: "main-card-1", fighters: CORNERS, ...overrides };
}

// A report as the store remembers it: the fight plus when we received it.
export function seen(fight: CanonicalFight, receivedAt: number): Observation {
  return { fight, receivedAt };
}

// A feed that answers from a script: one entry per call, a list of fights or an
// error to throw. The last entry repeats forever, so "then keeps failing" is easy.
// calls() says how many times it was asked, retries included.
export function scriptedFeed(
  name: string,
  script: (CanonicalFight[] | Error)[],
): Feed & { calls: () => number } {
  let call = 0;
  return {
    name,
    intervalMs: 0,
    calls: () => call,
    fetch: async () => {
      const step = script[Math.min(call, script.length - 1)];
      call += 1;
      if (step instanceof Error) throw step;
      return { fights: step, rejected: [] };
    },
  };
}
