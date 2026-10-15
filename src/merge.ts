// The merge rule. Pure: two reports and a clock in, one fight out. No database.
//   - Rounds: the UFC API owns every round it has published (settled). Inside a round,
//     each stat is the UFC API's value if it reported one, else the third-party's, else null.
//     Every value says which feed it came from and that feed's time for it.
//   - Round and clock come from whichever report is further into the fight. Ties go to the UFC API.
//   - Status and result come from the UFC API only.
//   - Stale means no feed has reported this fight in 30 seconds.
import { STALE_AFTER_MS, addStats, emptyStats } from "./types.ts";
import type {
  CanonicalFight,
  FighterStats,
  MergedFight,
  MergedRound,
  MergedStats,
  Observation,
  ReportedRound,
  ReportedStats,
  Stat,
} from "./types.ts";

const ROUND_SECONDS = 300;

export function mergeFight(
  ufcApi: Observation | null,
  thirdPartyApi: Observation | null,
  now: number,
  identity: MergedFight["identity"] = "confirmed",
): MergedFight | null {
  const reports = [ufcApi, thirdPartyApi].filter((o): o is Observation => o !== null);
  if (reports.length === 0) return null;

  // The report that is further into the fight gives us the round and the clock.
  let ahead = reports[0];
  for (const report of reports) {
    if (elapsed(report.fight) > elapsed(ahead.fight)) ahead = report;
  }

  // Which rounds exist: up to the highest round number either feed has reported.
  const ufcApiRounds = ufcApi?.fight.rounds ?? [];
  const thirdPartyApiRounds = thirdPartyApi?.fight.rounds ?? [];
  const roundNumbers = [...ufcApiRounds, ...thirdPartyApiRounds].map((r) => r.round);
  const lastRound = Math.max(0, ...roundNumbers);

  const rounds: MergedRound[] = [];
  for (let n = 1; n <= lastRound; n++) {
    const fromUfcApi = ufcApiRounds.find((r) => r.round === n);
    const fromThirdParty = thirdPartyApiRounds.find((r) => r.round === n);
    if (fromUfcApi === undefined && fromThirdParty === undefined) continue;

    // Every fighter either feed mentioned in this round.
    const fighterIds = new Set<string>();
    for (const id of Object.keys(fromUfcApi?.fighters ?? {})) fighterIds.add(id);
    for (const id of Object.keys(fromThirdParty?.fighters ?? {})) fighterIds.add(id);

    const fighters: Record<string, MergedStats> = {};
    for (const id of fighterIds) {
      const preferred = reportFor(ufcApi, fromUfcApi, id);
      const fallback = reportFor(thirdPartyApi, fromThirdParty, id);
      fighters[id] = mergeStats(preferred, fallback);
    }
    rounds.push({ round: n, settled: fromUfcApi !== undefined, fighters });
  }

  return {
    id: ahead.fight.id,
    identity,
    status: ufcApi?.fight.status ?? null,
    result: ufcApi?.fight.result ?? null,
    round: ahead.fight.round,
    clockSeconds: ahead.fight.clockSeconds,
    fighters: ufcApi?.fight.fighters ?? ahead.fight.fighters,
    rounds,
    totals: sumRounds(rounds),
    source: ahead.fight.source,
    ageSeconds: Math.floor((now - ahead.fight.eventTime) / 1000),
    stale: reports.every((r) => now - r.receivedAt > STALE_AFTER_MS),
  };
}

// One feed's stats for one fighter in one round, with where and when they came from.
interface Reported {
  stats: ReportedStats | undefined;
  source: string;
  updatedAt: number;
}

// What one feed said about one fighter in one round, or null if that feed has no such round.
function reportFor(
  observation: Observation | null,
  round: ReportedRound | undefined,
  fighterId: string,
): Reported | null {
  if (observation === null || round === undefined) return null;
  return {
    stats: round.fighters[fighterId],
    source: observation.fight.source,
    updatedAt: observation.fight.eventTime,
  };
}

// Per stat: the preferred feed's value if it reported one, else the fallback's, else null.
// `pick` is generic so that each stat keeps its own type: a Landed pair for strikes,
// a number for knockdowns and control time.
function mergeStats(preferred: Reported | null, fallback: Reported | null): MergedStats {
  const pick = <K extends keyof FighterStats>(key: K): Stat<FighterStats[K]> | null => {
    for (const report of [preferred, fallback]) {
      if (report === null) continue;
      const value = report.stats?.[key];
      if (value !== undefined) {
        return { value, source: report.source, updatedAt: report.updatedAt };
      }
    }
    return null;
  };
  return {
    sigStrikes: pick("sigStrikes"),
    totalStrikes: pick("totalStrikes"),
    takedowns: pick("takedowns"),
    knockdowns: pick("knockdowns"),
    controlSeconds: pick("controlSeconds"),
  };
}

// Seconds into the fight, so reports can be compared in fight time.
function elapsed(fight: CanonicalFight): number {
  return (fight.round - 1) * ROUND_SECONDS + (ROUND_SECONDS - fight.clockSeconds);
}

// The rounds added up per fighter. A stat nobody reported counts as zero here.
function sumRounds(rounds: MergedRound[]): Record<string, FighterStats> {
  const totals: Record<string, FighterStats> = {};
  for (const round of rounds) {
    for (const [fighterId, stats] of Object.entries(round.fighters)) {
      if (totals[fighterId] === undefined) totals[fighterId] = emptyStats();
      addStats(totals[fighterId], {
        sigStrikes: stats.sigStrikes?.value ?? { landed: 0, attempted: 0 },
        totalStrikes: stats.totalStrikes?.value ?? { landed: 0, attempted: 0 },
        takedowns: stats.takedowns?.value ?? { landed: 0, attempted: 0 },
        knockdowns: stats.knockdowns?.value ?? 0,
        controlSeconds: stats.controlSeconds?.value ?? 0,
      });
    }
  }
  return totals;
}
