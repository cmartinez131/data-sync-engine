import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { matchFight } from "../src/identity.ts";
import { mergeFight } from "../src/merge.ts";
import {
  applyFight,
  getFight,
  getStatus,
  linkProvisional,
  listFights,
  openStore,
  recordFailure,
  recordSuccess,
  registerFeed,
  resolveIdentity,
} from "../src/store.ts";
import type { ReportedRound } from "../src/types.ts";
import { CORNERS, FIGHTERS, cornerRound, frame, report, roundOf, seen } from "./fixtures.ts";

// A fresh, throwaway database before every test.
beforeEach(() => {
  openStore(":memory:");
});

test("applyFight keeps the newest report per feed, not across feeds, and getFight merges them back", () => {
  assert.equal(applyFight(report("ufc-api", { eventTime: 1000 }), 1), "updated");
  assert.equal(applyFight(report("third-party-api", { eventTime: 1500 }), 2), "updated");
  // Newer for the UFC API, even though the third-party API's latest is at 1500.
  assert.equal(applyFight(report("ufc-api", { eventTime: 1200 }), 3), "updated");
  assert.equal(applyFight(report("ufc-api", { eventTime: 1200 }), 4), "unchanged"); // repeat
  assert.equal(applyFight(report("ufc-api", { eventTime: 900 }), 5), "unchanged"); // out of order

  // What comes back is the two feeds' latest reports, merged.
  applyFight(
    report("ufc-api", { round: 1, clockSeconds: 0, rounds: [roundOf(1, 14, 9)], eventTime: 2000 }),
    100_000,
  );
  applyFight(
    report("third-party-api", {
      round: 2,
      clockSeconds: 200,
      rounds: [roundOf(1, 15, 9), roundOf(2, 3, 4)],
      eventTime: 2500,
    }),
    101_000,
  );
  const fight = getFight("fight-1", 102_000);
  assert.ok(fight !== null);
  assert.equal(fight.status, "live");
  assert.equal(fight.round, 2);
  assert.deepEqual(
    fight.rounds.map((r) => r.settled),
    [true, false],
  );
  assert.equal(fight.totals["f-002"].sigStrikes.landed, 9 + 4);
  assert.deepEqual(listFights(102_000), [fight]);
  assert.equal(getFight("nope", 102_000), null);
});

test("the UFC API owns the rounds it has reported, the third-party API fills in the round in progress", () => {
  const ufcApi = seen(
    report("ufc-api", {
      round: 2,
      clockSeconds: 0,
      rounds: [roundOf(1, 14, 9), roundOf(2, 10, 12)],
    }),
    100_000,
  );
  const thirdPartyApi = seen(
    report("third-party-api", {
      round: 3,
      clockSeconds: 250,
      rounds: [roundOf(1, 15, 9), roundOf(2, 11, 12), roundOf(3, 2, 1)],
    }),
    109_000,
  );
  const merged = mergeFight(ufcApi, thirdPartyApi, 110_000);
  assert.ok(merged !== null);
  assert.deepEqual(
    merged.rounds.map((r) => [r.round, r.fighters["f-001"].sigStrikes?.source, r.settled]),
    [
      [1, "ufc-api", true],
      [2, "ufc-api", true],
      [3, "third-party-api", false],
    ],
  );
  assert.equal(merged.rounds[0].fighters["f-001"].sigStrikes?.value.landed, 14); // The UFC API's 14, not the third-party API's 15
  assert.equal(merged.totals["f-001"].sigStrikes.landed, 14 + 10 + 2);
  assert.equal(merged.totals["f-002"].sigStrikes.landed, 9 + 12 + 1);
});

test("round and clock come from whichever feed is further into the fight", () => {
  const ufcApi = seen(report("ufc-api", { round: 2, clockSeconds: 0 }), 100_000);
  const thirdPartyAhead = seen(report("third-party-api", { round: 3, clockSeconds: 250 }), 100_000);
  const thirdPartyBehind = seen(
    report("third-party-api", { round: 1, clockSeconds: 100 }),
    100_000,
  );
  const thirdPartyTied = seen(report("third-party-api", { round: 2, clockSeconds: 0 }), 100_000);

  assert.deepEqual(pick(mergeFight(ufcApi, thirdPartyAhead, 110_000)), {
    round: 3,
    clockSeconds: 250,
    source: "third-party-api",
  });
  assert.deepEqual(pick(mergeFight(ufcApi, thirdPartyBehind, 110_000)), {
    round: 2,
    clockSeconds: 0,
    source: "ufc-api",
  });
  assert.deepEqual(pick(mergeFight(ufcApi, thirdPartyTied, 110_000)), {
    round: 2,
    clockSeconds: 0,
    source: "ufc-api",
  });
});

test("status and result only come from the UFC API", () => {
  const thirdPartyApi = seen(report("third-party-api", { round: 3, clockSeconds: 10 }), 100_000);
  const thirdPartyOnly = mergeFight(null, thirdPartyApi, 110_000);
  assert.equal(thirdPartyOnly?.status, null);
  assert.equal(thirdPartyOnly?.result, null);

  const result = { winnerId: "f-001", method: "submission" as const, round: 3, timeSeconds: 290 };
  const ufcApi = seen(
    report("ufc-api", { status: "final", result, round: 3, clockSeconds: 10 }),
    100_000,
  );
  const merged = mergeFight(ufcApi, thirdPartyApi, 110_000);
  assert.equal(merged?.status, "final");
  assert.deepEqual(merged?.result, result);
});

test("a fight is stale only when no feed has reported it in 30 s, and a repeat counts as hearing from the feed", () => {
  const ufcApi = seen(report("ufc-api"), 100_000);
  const thirdPartyApi = seen(report("third-party-api"), 105_000);
  assert.equal(mergeFight(ufcApi, thirdPartyApi, 130_000)?.stale, false); // the third-party API reported 25 s ago
  assert.equal(mergeFight(ufcApi, thirdPartyApi, 140_000)?.stale, true); // 40 s and 35 s ago
  assert.equal(mergeFight(ufcApi, null, 120_000)?.stale, false);

  // A feed re-sending the same report is still a feed we heard from.
  applyFight(report("ufc-api", { eventTime: 1000 }), 50_000);
  assert.equal(getFight("fight-1", 90_000)?.stale, true); // 40 s since we heard from anyone
  assert.equal(applyFight(report("ufc-api", { eventTime: 1000 }), 100_000), "unchanged");
  assert.equal(getFight("fight-1", 120_000)?.stale, false); // 20 s since the repeat
});

test("status reports age, staleness, the last error and running counters per feed", () => {
  registerFeed("ufc-api");
  const zero = { polls: 0, updated: 0, unchanged: 0, failed: 0, rejected: 0, retries: 0 };

  // Nothing fetched yet: no age, counts as stale, no error, all counters at zero.
  assert.deepEqual(getStatus(0)["ufc-api"], {
    lastSuccessAt: null,
    lastError: null,
    ageSeconds: null,
    stale: true,
    consecutiveFailures: 0,
    counters: zero,
  });

  // A success 10 s ago is fresh, and its counts are added. This one needed 1 retry.
  recordSuccess("ufc-api", 100_000, 3, 0, 1);
  assert.deepEqual(getStatus(110_000)["ufc-api"], {
    lastSuccessAt: 100_000,
    lastError: null,
    ageSeconds: 10,
    stale: false,
    consecutiveFailures: 0,
    counters: { ...zero, polls: 1, updated: 3, retries: 1 },
  });

  // Failures keep the old success time, record the error, and count by kind.
  recordFailure("ufc-api", "HTTP 429", "failed", 2);
  recordFailure("ufc-api", 'bad clock "soon"', "rejected", 0);
  const after = getStatus(110_000)["ufc-api"];
  assert.equal(after.lastSuccessAt, 100_000);
  assert.equal(after.lastError, 'bad clock "soon"');
  assert.equal(after.consecutiveFailures, 2);
  assert.deepEqual(after.counters, {
    polls: 3,
    updated: 3,
    unchanged: 0,
    failed: 1,
    rejected: 1,
    retries: 3,
  });

  // The next success resets the streak but not the totals.
  recordSuccess("ufc-api", 120_000, 0, 3, 0);
  assert.equal(getStatus(121_000)["ufc-api"].consecutiveFailures, 0);
  assert.deepEqual(getStatus(121_000)["ufc-api"].counters, {
    polls: 4,
    updated: 3,
    unchanged: 3,
    failed: 1,
    rejected: 1,
    retries: 3,
  });

  // 31 s after the last success it is stale.
  assert.equal(getStatus(151_000)["ufc-api"].stale, true);
});

test("a stat the UFC API does not report is filled from the third-party API, every value naming its source and time", () => {
  // The UFC API settled round 1 without takedowns. The third-party API has everything but knockdowns.
  const ufcRound: ReportedRound = {
    round: 1,
    fighters: { "f-001": { sigStrikes: { landed: 14, attempted: 29 }, knockdowns: 1 } },
  };
  const thirdPartyRound: ReportedRound = {
    round: 1,
    fighters: {
      "f-001": {
        sigStrikes: { landed: 15, attempted: 30 },
        takedowns: { landed: 1, attempted: 2 },
      },
    },
  };
  const merged = mergeFight(
    seen(
      report("ufc-api", { round: 1, clockSeconds: 0, rounds: [ufcRound], eventTime: 2000 }),
      100_000,
    ),
    seen(
      report("third-party-api", {
        round: 2,
        clockSeconds: 250,
        rounds: [thirdPartyRound],
        eventTime: 9000,
      }),
      100_000,
    ),
    110_000,
  );
  assert.ok(merged !== null);
  const stats = merged.rounds[0].fighters["f-001"];
  assert.deepEqual(stats.sigStrikes, {
    value: { landed: 14, attempted: 29 },
    source: "ufc-api",
    updatedAt: 2000,
  }); // the UFC API has it
  assert.deepEqual(stats.takedowns, {
    value: { landed: 1, attempted: 2 },
    source: "third-party-api",
    updatedAt: 9000,
  }); // filled
  assert.deepEqual(stats.knockdowns, { value: 1, source: "ufc-api", updatedAt: 2000 });
  assert.equal(stats.controlSeconds, null); // nobody reported it: null, never zero
  assert.equal(merged.rounds[0].settled, true); // the UFC API published the round, gaps and all
  assert.equal(merged.totals["f-001"].takedowns.landed, 1);
});

test("matchFight finds the one UFC fight with the same two people by first name, last name and age", () => {
  const fight1 = report("ufc-api");
  const fight2 = report("ufc-api", {
    id: "fight-2",
    fighters: [
      { id: "f-003", firstName: "Lena", lastName: "Novak", age: 27, name: "Lena Novak" },
      { id: "f-004", firstName: "Yuki", lastName: "Tanaka", age: 33, name: "Yuki Tanaka" },
    ],
  });
  const [ana, mia] = CORNERS;

  assert.deepEqual(matchFight(ana, mia, [fight1, fight2]), {
    fightId: "fight-1",
    redId: "f-001",
    blueId: "f-002",
  });
  assert.deepEqual(matchFight(mia, ana, [fight1, fight2]), {
    fightId: "fight-1",
    redId: "f-002",
    blueId: "f-001",
  }); // corners swapped
  assert.equal(matchFight({ ...ana, age: 30 }, mia, [fight1, fight2]), null); // same name, wrong age
  assert.equal(matchFight({ ...ana, age: null }, mia, [fight1, fight2]), null); // no age, no match
  assert.equal(matchFight(ana, mia, [fight1, { ...fight1, id: "fight-9" }]), null); // two candidates: never guess
});

test("resolveIdentity: configured bouts, bouts matched by roster, and provisional ones that are linked later", () => {
  // Configured: main-card-1 was in the table from the start.
  const configured = resolveIdentity(frame({ rounds: [cornerRound(1, 3, 1)] }));
  assert.equal(configured.learned, null);
  assert.equal(configured.fight.id, "fight-1");
  assert.deepEqual(
    configured.fight.fighters.map((f) => f.id),
    ["f-001", "f-002"],
  );
  assert.deepEqual(Object.keys(configured.fight.rounds[0].fighters), ["f-001", "f-002"]);

  // Matched: a bout nobody configured, but the UFC API has reported those two people.
  applyFight(report("ufc-api", { id: "fight-7", fighters: FIGHTERS }), 1);
  const matched = resolveIdentity(frame({ id: "main-card-7" }));
  assert.equal(matched.learned, "matched");
  assert.equal(matched.fight.id, "fight-7");
  assert.equal(resolveIdentity(frame({ id: "main-card-7" })).learned, null); // remembered

  // Provisional: nobody configured it and the UFC API has not reported those people.
  const lena = { id: "red", firstName: "Lena", lastName: "Novak", age: 27, name: "Lena Novak" };
  const yuki = { id: "blue", firstName: "Yuki", lastName: "Tanaka", age: 33, name: "Yuki Tanaka" };
  const provisional = resolveIdentity(
    frame({
      id: "main-card-2",
      fighters: [lena, yuki],
      rounds: [cornerRound(1, 4, 2)],
      eventTime: 1500,
    }),
  );
  assert.equal(provisional.learned, "provisional");
  assert.equal(provisional.fight.id, "tp:main-card-2");
  assert.deepEqual(Object.keys(provisional.fight.rounds[0].fighters), [
    "tp:main-card-2:red",
    "tp:main-card-2:blue",
  ]);
  applyFight(provisional.fight, 2);
  assert.equal(getFight("tp:main-card-2", 3)?.identity, "provisional");
  assert.deepEqual(linkProvisional(), []); // nothing to link to yet

  // The UFC API reports fight 2: the provisional fight is re-keyed, nothing lost.
  applyFight(
    report("ufc-api", {
      id: "fight-2",
      fighters: [
        { id: "f-003", firstName: "Lena", lastName: "Novak", age: 27, name: "Lena Novak" },
        { id: "f-004", firstName: "Yuki", lastName: "Tanaka", age: 33, name: "Yuki Tanaka" },
      ],
      eventTime: 2000,
    }),
    4,
  );
  assert.deepEqual(linkProvisional(), [{ bout: "main-card-2", fightId: "fight-2" }]);
  const fight2 = getFight("fight-2", 5);
  assert.equal(fight2?.identity, "confirmed");
  assert.equal(fight2?.rounds[0].fighters["f-003"].sigStrikes?.value.landed, 4); // the camera's round, now under our ids
  assert.equal(getFight("tp:main-card-2", 5), null);
  assert.equal(
    resolveIdentity(frame({ id: "main-card-2", fighters: [lena, yuki] })).fight.id,
    "fight-2",
  ); // and remembered
});

function pick(fight: ReturnType<typeof mergeFight>) {
  assert.ok(fight !== null);
  return { round: fight.round, clockSeconds: fight.clockSeconds, source: fight.source };
}
