// The ONLY file that knows what the third-party API looks like.
// The third-party API is a computer-vision model watching the video. It estimates
// the numbers live, names the bout its own way and the fighters by corner, and
// cannot know the official status or result. It translates format only: who a
// bout and its corners are in OUR ids is decided by the store (resolveIdentity),
// so the fight id it hands over is the feed's bout name and the fighter ids are
// "red" and "blue". If the third-party API ever changes its format, this is the
// file that changes.
import { BadDataError } from "../errors.ts";
import { fetchJson, isWhole, translateAll, tryStat, wholeNumber } from "./shared.ts";
import type {
  CanonicalFight,
  FeedAnswer,
  Fighter,
  Landed,
  ReportedRound,
  ReportedStats,
} from "../types.ts";

// One frame, exactly as src/providers/third-party-api.ts sends it.
export interface ThirdPartyApiFrame {
  bout: string; // the feed's own name for the fight, e.g. "main-card-1"
  corners: {
    red: ThirdPartyApiCorner;
    blue: ThirdPartyApiCorner;
  };
  round_est: number;
  clock_est: number; // seconds left in the round
  rounds: ThirdPartyApiRound[]; // every round so far, including the one in progress
  conf: number; // 0..1, how sure the model is. Not used yet.
  frame_ts: string; // ISO 8601, e.g. "2026-10-13T15:00:00.000Z"
}

// Who is in a corner, from the vendor's roster. No ids: that is what matching is for.
export interface ThirdPartyApiCorner {
  first: string;
  last: string;
  age?: number;
}

// Pairs are [landed, attempted]. Any stat may be left out, and in the flaky
// scenario the model sometimes sends takedowns as "n/a": a broken stat.
export interface ThirdPartyApiStats {
  sig?: [number, number];
  total?: [number, number];
  td?: [number, number] | string;
  kd?: number; // the model does not judge knockdowns, so it never sends this
  ctrl_s?: number;
}

export interface ThirdPartyApiRound {
  rnd: number;
  red: ThirdPartyApiStats;
  blue: ThirdPartyApiStats;
}

// Everything the third-party API can see right now, from GET /feed.
export interface ThirdPartyApiFeed {
  frames: ThirdPartyApiFrame[];
}

// Fetch every frame the third-party API has right now. Throws on any HTTP error,
// a timeout (via the signal), or an answer we cannot translate at all.
export async function fetchThirdPartyApi(
  baseUrl: string,
  signal: AbortSignal,
): Promise<FeedAnswer> {
  const body = await fetchJson(`${baseUrl}/feed`, signal);
  return translateThirdPartyApi(body);
}

// Translate the whole answer, frame by frame. A bad frame is rejected with a
// reason and the rest are kept. There is no schema library: the cast plus the
// checks in the parsers are the whole shape check.
export function translateThirdPartyApi(body: unknown): FeedAnswer {
  const frames = (body as ThirdPartyApiFeed | null)?.frames;
  const label = (frame: ThirdPartyApiFrame): string => String(frame.bout ?? "unknown bout");
  return translateAll<ThirdPartyApiFrame>(frames, "frames", label, mapThirdPartyApi);
}

// Pure translation: no network, so it is easy to test.
// A frame-level field the adapter cannot read throws: the frame is rejected.
// A single stat it cannot read is dropped and described in `problems`: the frame is kept.
export function mapThirdPartyApi(raw: ThirdPartyApiFrame, problems: string[] = []): CanonicalFight {
  if (typeof raw.bout !== "string") throw new BadDataError("frame without a bout");
  const eventTime = Date.parse(raw.frame_ts);
  if (Number.isNaN(eventTime)) throw new BadDataError(`bad frame_ts "${raw.frame_ts}"`);

  const rounds: ReportedRound[] = raw.rounds.map((r) => ({
    round: r.rnd,
    fighters: {
      red: mapStats(r.red, `${raw.bout} red`, problems),
      blue: mapStats(r.blue, `${raw.bout} blue`, problems),
    },
  }));

  return {
    id: raw.bout,
    status: null,
    result: null,
    round: raw.round_est,
    clockSeconds: raw.clock_est,
    fighters: [mapCorner("red", raw.corners.red), mapCorner("blue", raw.corners.blue)],
    rounds,
    eventTime,
    source: "third-party-api",
  };
}

function mapCorner(corner: "red" | "blue", raw: ThirdPartyApiCorner): Fighter {
  if (typeof raw?.first !== "string" || typeof raw.last !== "string") {
    throw new BadDataError(`${corner} corner without a name`);
  }
  return {
    id: corner,
    firstName: raw.first,
    lastName: raw.last,
    age: typeof raw.age === "number" ? raw.age : null,
    name: `${raw.first} ${raw.last}`,
  };
}

// A stat the feed left out stays missing. A stat it sends in a form that cannot be read is dropped and reported.
function mapStats(s: ThirdPartyApiStats, who: string, problems: string[]): ReportedStats {
  const stats: ReportedStats = {};

  if (s.sig !== undefined) {
    stats.sigStrikes = tryStat(problems, who, "sigStrikes", () => pairOf(s.sig));
  }
  if (s.total !== undefined) {
    stats.totalStrikes = tryStat(problems, who, "totalStrikes", () => pairOf(s.total));
  }
  if (s.td !== undefined) {
    stats.takedowns = tryStat(problems, who, "takedowns", () => pairOf(s.td));
  }
  if (s.kd !== undefined) {
    stats.knockdowns = tryStat(problems, who, "knockdowns", () => wholeNumber(s.kd));
  }
  if (s.ctrl_s !== undefined) {
    stats.controlSeconds = tryStat(problems, who, "controlSeconds", () => wholeNumber(s.ctrl_s));
  }

  return stats;
}

// [landed, attempted] as two whole numbers, or bad data.
function pairOf(value: unknown): Landed {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new BadDataError("bad pair " + JSON.stringify(value));
  }
  const [landed, attempted] = value as unknown[];
  if (!isWhole(landed) || !isWhole(attempted)) {
    throw new BadDataError("bad pair " + JSON.stringify(value));
  }
  return { landed, attempted };
}
