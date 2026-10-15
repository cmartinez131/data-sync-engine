// Who is who, the pure part. The UFC API uses our ids. The third-party API names
// a bout its own way and the fighters by corner, with a first name, a last name
// and an age. These functions decide whether two descriptions are the same people
// and rewrite a report's ids. The store decides when to call them and remembers
// the answers.
import type { CanonicalFight, Fighter, ReportedStats } from "./types.ts";

// Who a third-party bout and its corners are, in our ids, and how we know.
export interface Identity {
  bout: string;
  fightId: string;
  redId: string;
  blueId: string;
  how: "configured" | "matched" | "provisional";
}

// The answer to "which of the UFC API's fights is this bout": our ids for it.
export interface Match {
  fightId: string;
  redId: string;
  blueId: string;
}

// Bouts we were told about up front. main-card-2 is left out on purpose: it is
// learned at runtime by matching names and ages against what the UFC API reports.
export const CONFIGURED_IDENTITIES: Identity[] = [
  { bout: "main-card-1", fightId: "fight-1", redId: "f-001", blueId: "f-002", how: "configured" },
  { bout: "prelim-1", fightId: "fight-3", redId: "f-005", blueId: "f-006", how: "configured" },
];

// Given a bout's two corners, the one UFC API fight whose two fighters have the
// same first name, last name and age. Two candidates is no match: never guess.
export function matchFight(
  red: Fighter,
  blue: Fighter,
  candidates: CanonicalFight[],
): Match | null {
  const found: Match[] = [];
  for (const candidate of candidates) {
    const redMatch = candidate.fighters.find((f) => samePerson(f, red));
    const blueMatch = candidate.fighters.find((f) => samePerson(f, blue));
    // Both corners found, and they are two different people.
    if (redMatch !== undefined && blueMatch !== undefined && redMatch.id !== blueMatch.id) {
      found.push({ fightId: candidate.id, redId: redMatch.id, blueId: blueMatch.id });
    }
  }
  return found.length === 1 ? found[0] : null;
}

// An identity of the camera's own, for a bout nobody has matched yet.
export function provisionalIdentity(bout: string): Identity {
  return {
    bout,
    fightId: `tp:${bout}`,
    redId: `tp:${bout}:red`,
    blueId: `tp:${bout}:blue`,
    how: "provisional",
  };
}

// Give a report new ids: the fight id, the fighter ids, and the keys of every round.
// `ids` maps old fighter ids to new ones; ids not in the map are left as they are.
export function relabel(
  fight: CanonicalFight,
  fightId: string,
  ids: Record<string, string>,
): CanonicalFight {
  const fighters = fight.fighters.map((f) => ({ ...f, id: ids[f.id] ?? f.id }));

  const rounds = fight.rounds.map((round) => {
    const renamed: Record<string, ReportedStats> = {};
    for (const [id, stats] of Object.entries(round.fighters)) {
      renamed[ids[id] ?? id] = stats;
    }
    return { round: round.round, fighters: renamed };
  });

  return { ...fight, id: fightId, fighters, rounds };
}

function samePerson(a: Fighter, b: Fighter): boolean {
  if (a.age === null || a.age !== b.age) return false;
  return norm(a.firstName) === norm(b.firstName) && norm(a.lastName) === norm(b.lastName);
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}
