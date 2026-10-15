// One test file for both adapters: the same kind of test, for two feeds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapUfcApi, translateUfcApi } from "../src/adapters/ufc-api.ts";
import type { UfcApiPayload } from "../src/adapters/ufc-api.ts";
import { mapThirdPartyApi } from "../src/adapters/third-party-api.ts";
import type { ThirdPartyApiFrame } from "../src/adapters/third-party-api.ts";
import { BadDataError } from "../src/errors.ts";

// ---------------------------------------------------------------------------
// UFC API

// A payload shaped exactly like src/providers/ufc-api.ts sends it: round 1 just ended.
const ufcSample: UfcApiPayload = {
  fight_id: "fight-1",
  status: "LIVE",
  rnd: 1,
  clock: "0:00",
  fighters: [
    { fighter_id: "f-001", first_name: "Ana", last_name: "Silva", age: 29 },
    { fighter_id: "f-002", first_name: "Mia", last_name: "Chen", age: 31 },
  ],
  rounds: [
    {
      rnd: 1,
      stats: [
        {
          fighter_id: "f-001",
          sig_str: "14 of 29",
          total_str: "24 of 48",
          td: "1 of 2",
          kd: 0,
          ctrl: "1:05",
        },
        {
          fighter_id: "f-002",
          sig_str: "9 of 20",
          total_str: "15 of 31",
          td: "0 of 1",
          kd: 1,
          ctrl: "0:00",
        },
      ],
    },
  ],
  result: null,
  as_of: 1_700_000_000,
};

test("mapUfcApi turns a UFC API payload into a CanonicalFight, result included", () => {
  assert.deepEqual(mapUfcApi(ufcSample), {
    id: "fight-1",
    status: "live", // uppercase -> lowercase
    result: null,
    round: 1,
    clockSeconds: 0, // "0:00"
    fighters: [
      { id: "f-001", firstName: "Ana", lastName: "Silva", age: 29, name: "Ana Silva" },
      { id: "f-002", firstName: "Mia", lastName: "Chen", age: 31, name: "Mia Chen" },
    ],
    rounds: [
      {
        round: 1,
        fighters: {
          "f-001": {
            sigStrikes: { landed: 14, attempted: 29 }, // "14 of 29"
            totalStrikes: { landed: 24, attempted: 48 },
            takedowns: { landed: 1, attempted: 2 },
            knockdowns: 0,
            controlSeconds: 65, // "1:05"
          },
          "f-002": {
            sigStrikes: { landed: 9, attempted: 20 },
            totalStrikes: { landed: 15, attempted: 31 },
            takedowns: { landed: 0, attempted: 1 },
            knockdowns: 1,
            controlSeconds: 0,
          },
        },
      },
    ],
    eventTime: 1_700_000_000_000, // Unix seconds -> milliseconds
    source: "ufc-api",
  });

  // A finished fight carries a result, in the UFC API's codes.
  const final = mapUfcApi({
    ...ufcSample,
    status: "FINAL",
    rnd: 2,
    clock: "2:20",
    result: { winner: "f-001", method: "SUB", rnd: 2, time: "2:40" },
  });
  assert.equal(final.status, "final");
  assert.deepEqual(final.result, {
    winnerId: "f-001",
    method: "submission",
    round: 2,
    timeSeconds: 160,
  });
});

test("mapUfcApi rejects a payload whose fight-level fields it cannot read", () => {
  assert.throws(() => mapUfcApi({ ...ufcSample, status: "PAUSED" }), /unknown status/);
  assert.throws(() => mapUfcApi({ ...ufcSample, clock: "soon" }), /bad clock/);
  assert.throws(
    () =>
      mapUfcApi({ ...ufcSample, result: { winner: "f-001", method: "NC", rnd: 1, time: "1:00" } }),
    /unknown method/,
  );
});

test("a field the feed adds is ignored, a record it breaks is rejected and the rest of the answer is kept", () => {
  const extra = { fights: [{ ...ufcSample, venue: "Las Vegas" }] };
  assert.equal(translateUfcApi(extra).fights.length, 1);

  const noStatus = { fights: [{ ...ufcSample, status: undefined }] };
  assert.throws(() => translateUfcApi(noStatus), BadDataError); // every record bad: the answer is bad

  const wrongShape = { bouts: [] };
  assert.throws(() => translateUfcApi(wrongShape), BadDataError);

  // One bad record among good ones: the good ones are kept, the bad one is named.
  const oneBad = { fights: [ufcSample, { ...ufcSample, fight_id: "fight-2", clock: "soon" }] };
  const partial = translateUfcApi(oneBad);
  assert.equal(partial.fights.length, 1);
  assert.deepEqual(partial.rejected, ['fight-2: bad clock "soon"']);
});

test("a stat the feed leaves out is a gap, a stat it sends in a bad form is dropped and reported, the rest is kept", () => {
  const noTakedowns = structuredClone(ufcSample);
  delete noTakedowns.rounds[0].stats[0].td;
  const fight = mapUfcApi(noTakedowns);
  assert.equal(fight.rounds[0].fighters["f-001"].takedowns, undefined);
  assert.deepEqual(fight.rounds[0].fighters["f-001"].sigStrikes, { landed: 14, attempted: 29 });

  const broken = structuredClone(ufcSample);
  broken.rounds[0].stats[0].td = "1/2";
  const problems: string[] = [];
  const kept = mapUfcApi(broken, problems);
  assert.equal(kept.rounds[0].fighters["f-001"].takedowns, undefined); // dropped
  assert.deepEqual(kept.rounds[0].fighters["f-001"].sigStrikes, { landed: 14, attempted: 29 }); // kept
  assert.deepEqual(problems, ['fight-1 f-001 takedowns: bad count "1/2"']);

  // Through translate, the problem is reported next to the answer, not instead of it.
  const answer = translateUfcApi({ fights: [broken] });
  assert.equal(answer.fights.length, 1);
  assert.deepEqual(answer.rejected, ['fight-1 f-001 takedowns: bad count "1/2"']);
});

// ---------------------------------------------------------------------------
// Third-party API

// A frame shaped exactly like src/providers/third-party-api.ts sends it: round 2 in progress.
const thirdPartySample: ThirdPartyApiFrame = {
  bout: "main-card-1",
  corners: {
    red: { first: "Ana", last: "Silva", age: 29 },
    blue: { first: "Mia", last: "Chen", age: 31 },
  },
  round_est: 2,
  clock_est: 180,
  rounds: [
    {
      rnd: 1,
      red: { sig: [14, 29], total: [24, 48], td: [1, 2], kd: 0, ctrl_s: 65 },
      blue: { sig: [9, 20], total: [15, 31], td: [0, 1], kd: 1, ctrl_s: 0 },
    },
    {
      rnd: 2,
      red: { sig: [5, 9], total: [8, 14], td: [0, 0], kd: 0, ctrl_s: 0 },
      blue: { sig: [3, 7], total: [6, 10], td: [0, 0], kd: 0, ctrl_s: 10 },
    },
  ],
  conf: 0.9,
  frame_ts: "2026-10-13T15:00:00.000Z",
};

test("mapThirdPartyApi turns a third-party API frame into a CanonicalFight", () => {
  assert.deepEqual(mapThirdPartyApi(thirdPartySample), {
    id: "main-card-1", // the feed's own name; the store resolves it to fight-1
    status: null, // the third-party API cannot know the official status
    result: null, // or the result
    round: 2,
    clockSeconds: 180,
    fighters: [
      { id: "red", firstName: "Ana", lastName: "Silva", age: 29, name: "Ana Silva" }, // corners, not ids
      { id: "blue", firstName: "Mia", lastName: "Chen", age: 31, name: "Mia Chen" },
    ],
    rounds: [
      {
        round: 1,
        fighters: {
          red: {
            sigStrikes: { landed: 14, attempted: 29 }, // [landed, attempted]
            totalStrikes: { landed: 24, attempted: 48 },
            takedowns: { landed: 1, attempted: 2 },
            knockdowns: 0,
            controlSeconds: 65,
          },
          blue: {
            sigStrikes: { landed: 9, attempted: 20 },
            totalStrikes: { landed: 15, attempted: 31 },
            takedowns: { landed: 0, attempted: 1 },
            knockdowns: 1,
            controlSeconds: 0,
          },
        },
      },
      {
        round: 2,
        fighters: {
          red: {
            sigStrikes: { landed: 5, attempted: 9 },
            totalStrikes: { landed: 8, attempted: 14 },
            takedowns: { landed: 0, attempted: 0 },
            knockdowns: 0,
            controlSeconds: 0,
          },
          blue: {
            sigStrikes: { landed: 3, attempted: 7 },
            totalStrikes: { landed: 6, attempted: 10 },
            takedowns: { landed: 0, attempted: 0 },
            knockdowns: 0,
            controlSeconds: 10,
          },
        },
      },
    ],
    eventTime: Date.parse("2026-10-13T15:00:00.000Z"), // ISO string -> ms
    source: "third-party-api",
  });
});

test("mapThirdPartyApi keeps the feed's own bout name: matching it to our fight is the store's job", () => {
  assert.equal(mapThirdPartyApi({ ...thirdPartySample, bout: "prelim-3" }).id, "prelim-3");
  assert.throws(
    () =>
      mapThirdPartyApi({
        ...thirdPartySample,
        corners: { ...thirdPartySample.corners, red: { first: "Ana" } as never },
      }),
    /red corner without a name/,
  );
});

test("mapThirdPartyApi rejects a frame time it cannot read", () => {
  assert.throws(
    () => mapThirdPartyApi({ ...thirdPartySample, frame_ts: "yesterday" }),
    /bad frame_ts/,
  );
});

test("a stat the frame leaves out is a gap, a broken takedown stat is dropped and reported, the rest is kept", () => {
  // Left out: the mock never sends knockdowns.
  const { kd: _dropped, ...red } = thirdPartySample.rounds[0].red;
  const noKnockdowns = {
    ...thirdPartySample,
    rounds: [{ rnd: 1, red, blue: thirdPartySample.rounds[0].blue }],
  };
  assert.equal(mapThirdPartyApi(noKnockdowns).rounds[0].fighters["red"].knockdowns, undefined);

  // Broken: in the flaky scenario the mock sometimes sends takedowns as text.
  const broken = structuredClone(thirdPartySample);
  broken.rounds[1].red.td = "n/a";
  const problems: string[] = [];
  const fight = mapThirdPartyApi(broken, problems);
  assert.equal(fight.rounds[1].fighters["red"].takedowns, undefined);
  assert.deepEqual(fight.rounds[1].fighters["red"].sigStrikes, { landed: 5, attempted: 9 });
  assert.deepEqual(problems, ['main-card-1 red takedowns: bad pair "n/a"']);
});
