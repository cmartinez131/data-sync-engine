// The ONLY file that knows what the UFC API looks like.
// It fetches the raw JSON and translates it into our CanonicalFight.
// If the UFC API ever changes its format, this is the one file that changes.
import { BadDataError } from "../errors.ts";
import { fetchJson, translateAll, tryStat, wholeNumber } from "./shared.ts";
import type {
  CanonicalFight,
  FeedAnswer,
  Fighter,
  FightResult,
  FightStatus,
  Landed,
  ReportedRound,
  ReportedStats,
} from "../types.ts";

// One fight, exactly as src/providers/ufc-api.ts sends it.
export interface UfcApiPayload {
  fight_id: string;
  status: string; // "SCHEDULED" | "LIVE" | "FINAL", uppercase
  rnd: number;
  clock: string; // "4:35", minutes:seconds
  fighters: { fighter_id: string; first_name: string; last_name: string; age: number }[];
  rounds: UfcApiRound[]; // finished rounds only
  result: { winner: string; method: string; rnd: number; time: string } | null; // method "KO" | "SUB" | "DEC"
  as_of: number; // Unix seconds
}

export interface UfcApiRound {
  rnd: number;
  stats: {
    fighter_id: string;
    sig_str?: string; // "23 of 41". Any stat may be left out.
    total_str?: string;
    td?: string;
    kd?: number;
    ctrl?: string; // "1:05"
  }[];
}

// The whole card, from GET /v1/fights.
export interface UfcApiFeed {
  fights: UfcApiPayload[];
}

// Fetch every fight on the card. Throws on any HTTP error,
// a timeout (via the signal), or an answer we cannot translate at all.
export async function fetchUfcApi(baseUrl: string, signal: AbortSignal): Promise<FeedAnswer> {
  const body = await fetchJson(`${baseUrl}/v1/fights`, signal);
  return translateUfcApi(body);
}

// Translate the whole answer, record by record. A bad record is rejected with a
// reason and the rest are kept. There is no schema library: the cast plus the
// checks in the parsers are the whole shape check.
export function translateUfcApi(body: unknown): FeedAnswer {
  const records = (body as UfcApiFeed | null)?.fights;
  const label = (record: UfcApiPayload): string => String(record.fight_id ?? "unknown fight");
  return translateAll<UfcApiPayload>(records, "fights", label, mapUfcApi);
}

// Pure translation: no network, so it is easy to test.
// A fight-level field the adapter cannot read throws: the record is rejected.
// A single stat it cannot read is dropped and described in `problems`: the record is kept.
export function mapUfcApi(raw: UfcApiPayload, problems: string[] = []): CanonicalFight {
  return {
    id: raw.fight_id,
    status: parseStatus(raw.status),
    result: raw.result === null ? null : parseResult(raw.result),
    round: raw.rnd,
    clockSeconds: parseClock(raw.clock),
    fighters: raw.fighters.map(mapFighter),
    rounds: raw.rounds.map((r) => mapRound(raw.fight_id, r, problems)),
    eventTime: raw.as_of * 1000,
    source: "ufc-api",
  };
}

function mapFighter(f: UfcApiPayload["fighters"][number]): Fighter {
  if (
    typeof f.fighter_id !== "string" ||
    typeof f.first_name !== "string" ||
    typeof f.last_name !== "string"
  ) {
    throw new BadDataError("fighter without id or name");
  }
  return {
    id: f.fighter_id,
    firstName: f.first_name,
    lastName: f.last_name,
    age: typeof f.age === "number" ? f.age : null,
    name: `${f.first_name} ${f.last_name}`,
  };
}

// A stat the feed left out stays missing. A stat it sends in a form that cannot be read is dropped and reported.
function mapRound(fightId: string, raw: UfcApiRound, problems: string[]): ReportedRound {
  const round: ReportedRound = { round: raw.rnd, fighters: {} };

  for (const s of raw.stats) {
    const who = `${fightId} ${s.fighter_id}`;
    const stats: ReportedStats = {};

    if (s.sig_str !== undefined) {
      stats.sigStrikes = tryStat(problems, who, "sigStrikes", () => parseOf(s.sig_str));
    }
    if (s.total_str !== undefined) {
      stats.totalStrikes = tryStat(problems, who, "totalStrikes", () => parseOf(s.total_str));
    }
    if (s.td !== undefined) {
      stats.takedowns = tryStat(problems, who, "takedowns", () => parseOf(s.td));
    }
    if (s.kd !== undefined) {
      stats.knockdowns = tryStat(problems, who, "knockdowns", () => wholeNumber(s.kd));
    }
    if (s.ctrl !== undefined) {
      stats.controlSeconds = tryStat(problems, who, "controlSeconds", () => parseClock(s.ctrl));
    }

    round.fighters[s.fighter_id] = stats;
  }

  return round;
}

function parseResult(raw: NonNullable<UfcApiPayload["result"]>): FightResult {
  return {
    winnerId: raw.winner,
    method: parseMethod(raw.method),
    round: raw.rnd,
    timeSeconds: parseClock(raw.time),
  };
}

function parseStatus(status: string): FightStatus {
  const lower = String(status).toLowerCase();
  if (lower === "scheduled" || lower === "live" || lower === "final") return lower;
  throw new BadDataError(`unknown status "${status}"`);
}

function parseMethod(code: string): FightResult["method"] {
  if (code === "KO") return "KO/TKO";
  if (code === "SUB") return "submission";
  if (code === "DEC") return "decision";
  throw new BadDataError(`unknown method "${code}"`);
}

// "4:35" -> 275
function parseClock(clock: unknown): number {
  const [minutes, seconds] = String(clock).split(":").map(Number);
  if (!Number.isInteger(minutes) || !Number.isInteger(seconds)) {
    throw new BadDataError(`bad clock "${clock}"`);
  }
  return minutes * 60 + seconds;
}

// "23 of 41" -> { landed: 23, attempted: 41 }
function parseOf(count: unknown): Landed {
  const match = /^(\d+) of (\d+)$/.exec(String(count));
  if (match === null) throw new BadDataError(`bad count "${count}"`);
  return { landed: Number(match[1]), attempted: Number(match[2]) };
}
