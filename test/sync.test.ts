import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { BadDataError, HttpError } from "../src/errors.ts";
import { getFight, getStatus, listFights, openStore } from "../src/store.ts";
import { RETRY, syncOnce } from "../src/sync.ts";
import { cornerRound, frame, report, roundOf, scriptedFeed } from "./fixtures.ts";

// The real retry policy, minus the waiting, so these tests are instant.
const instantRetry = { ...RETRY, sleep: async () => {} };

beforeEach(() => {
  openStore(":memory:");
});

test("when the UFC API goes dark, settled rounds stay with the UFC API and new rounds come from the third-party API, not settled", async () => {
  // The UFC API settles round 1, then every poll times out.
  const ufcApi = scriptedFeed("ufc-api", [
    [
      report("ufc-api", {
        round: 1,
        clockSeconds: 0,
        rounds: [roundOf(1, 14, 9)],
        eventTime: 1000,
      }),
    ],
    new Error("timeout"),
  ]);
  // The third-party API keeps streaming through rounds 2 and 3.
  const thirdPartyApi = scriptedFeed("third-party-api", [
    [frame({ round: 1, clockSeconds: 100, rounds: [roundOf(1, 10, 7)], eventTime: 1500 })],
    [
      frame({
        round: 2,
        clockSeconds: 200,
        rounds: [roundOf(1, 15, 9), roundOf(2, 3, 2)],
        eventTime: 2500,
      }),
    ],
    [
      frame({
        round: 3,
        clockSeconds: 250,
        rounds: [roundOf(1, 15, 9), roundOf(2, 11, 8), roundOf(3, 1, 0)],
        eventTime: 3500,
      }),
    ],
  ]);

  const feeds = [ufcApi, thirdPartyApi];
  for (let i = 0; i < 3; i++) await syncOnce(feeds, 2000);

  const now = Date.now();
  const fight = getFight("fight-1", now);
  assert.ok(fight !== null);
  assert.deepEqual(
    fight.rounds.map((r) => [r.round, r.fighters["f-001"].sigStrikes?.source, r.settled]),
    [
      [1, "ufc-api", true], // The UFC API's last word stays
      [2, "third-party-api", false], // The third-party API fills in what the UFC API never settled
      [3, "third-party-api", false],
    ],
  );
  assert.equal(fight.rounds[0].fighters["f-001"].sigStrikes?.value.landed, 14); // not the third-party API's 15
  assert.equal(fight.round, 3);
  assert.equal(fight.status, "live"); // The UFC API's last word, never the third-party API's
  assert.equal(fight.result, null);
  assert.equal(fight.stale, false); // The third-party API is still reporting

  const status = getStatus(now);
  assert.equal(status["ufc-api"].lastError, "timeout");
  assert.equal(status["ufc-api"].consecutiveFailures, 2);
  assert.deepEqual(status["ufc-api"].counters, {
    polls: 3,
    updated: 1,
    unchanged: 0,
    failed: 2,
    rejected: 0,
    retries: 0,
  });
  assert.equal(status["third-party-api"].lastError, null);
  assert.deepEqual(status["third-party-api"].counters, {
    polls: 3,
    updated: 3,
    unchanged: 0,
    failed: 0,
    rejected: 0,
    retries: 0,
  });
  assert.equal(getStatus(now + 31_000)["ufc-api"].stale, true);
});

test("when both feeds go dark, the last good data is served and marked stale", async () => {
  const ufcApi = scriptedFeed("ufc-api", [
    [
      report("ufc-api", {
        round: 1,
        clockSeconds: 0,
        rounds: [roundOf(1, 14, 9)],
        eventTime: 1000,
      }),
    ],
    new Error("timeout"),
  ]);
  const thirdPartyApi = scriptedFeed("third-party-api", [
    [
      frame({
        round: 2,
        clockSeconds: 200,
        rounds: [roundOf(1, 15, 9), roundOf(2, 3, 2)],
        eventTime: 1500,
      }),
    ],
    new Error("timeout"),
  ]);

  const feeds = [ufcApi, thirdPartyApi];
  for (let i = 0; i < 3; i++) await syncOnce(feeds, 2000);

  const now = Date.now();
  assert.equal(getFight("fight-1", now)?.stale, false); // we heard from both seconds ago
  const later = getFight("fight-1", now + 40_000);
  assert.ok(later !== null);
  assert.equal(later.stale, true); // nobody has reported in 40 s
  assert.equal(later.rounds.length, 2); // but the data is still there
  assert.equal(later.rounds[0].fighters["f-001"].sigStrikes?.source, "ufc-api");
  assert.equal(later.rounds[1].fighters["f-001"].sigStrikes?.source, "third-party-api");
  assert.equal(getStatus(now + 40_000)["ufc-api"].stale, true);
  assert.equal(getStatus(now + 40_000)["third-party-api"].stale, true);
});

test("bad data is rejected and counted, and never reaches the store", async () => {
  const ufcApi = scriptedFeed("ufc-api", [new BadDataError('unknown status "PAUSED"')]);
  const thirdPartyApi = scriptedFeed("third-party-api", [
    [frame({ round: 1, clockSeconds: 200, rounds: [roundOf(1, 4, 2)], eventTime: 1500 })],
  ]);

  const feeds = [ufcApi, thirdPartyApi];
  for (let i = 0; i < 2; i++) await syncOnce(feeds, 2000);

  const now = Date.now();
  const status = getStatus(now)["ufc-api"];
  assert.equal(status.lastError, 'unknown status "PAUSED"');
  assert.equal(status.consecutiveFailures, 2);
  assert.deepEqual(status.counters, {
    polls: 2,
    updated: 0,
    unchanged: 0,
    failed: 0,
    rejected: 2,
    retries: 0,
  });
  assert.equal(ufcApi.calls(), 2); // once per poll: bad data is never retried

  const fight = getFight("fight-1", now);
  assert.ok(fight !== null);
  assert.equal(fight.status, null); // nothing from the UFC API ever got in
  assert.deepEqual(
    fight.rounds.map((r) => r.fighters["f-001"].sigStrikes?.source),
    ["third-party-api"],
  );
});

test("a feed that fails twice then answers is retried inside the same poll", async () => {
  const ufcApi = scriptedFeed("ufc-api", [
    new HttpError(503),
    new HttpError(429, 2000),
    [
      report("ufc-api", {
        round: 1,
        clockSeconds: 0,
        rounds: [roundOf(1, 14, 9)],
        eventTime: 1000,
      }),
    ],
  ]);
  const thirdPartyApi = scriptedFeed("third-party-api", [
    [frame({ round: 1, clockSeconds: 200, rounds: [roundOf(1, 4, 2)], eventTime: 1500 })],
  ]);

  await syncOnce([ufcApi, thirdPartyApi], 2000, instantRetry);

  assert.equal(ufcApi.calls(), 3); // one poll, three tries
  const now = Date.now();
  const status = getStatus(now)["ufc-api"];
  assert.equal(status.lastError, null); // the poll succeeded in the end
  assert.equal(status.consecutiveFailures, 0);
  assert.deepEqual(status.counters, {
    polls: 1,
    updated: 1,
    unchanged: 0,
    failed: 0,
    rejected: 0,
    retries: 2,
  });
  assert.equal(getFight("fight-1", now)?.rounds[0].settled, true);
});

test("a late UFC API report settles a round the third-party API had been estimating", async () => {
  // The third-party API is already in round 3. The UFC API's numbers for rounds 1 and 2
  // arrive a poll later, with an OLDER timestamp: late in wall time, settled in fight time.
  const thirdPartyApi = scriptedFeed("third-party-api", [
    [
      frame({
        round: 3,
        clockSeconds: 250,
        rounds: [roundOf(1, 15, 9), roundOf(2, 11, 8), roundOf(3, 1, 0)],
        eventTime: 9000,
      }),
    ],
  ]);
  const ufcApi = scriptedFeed("ufc-api", [
    new Error("not yet"),
    [
      report("ufc-api", {
        round: 2,
        clockSeconds: 0,
        rounds: [roundOf(1, 14, 9), roundOf(2, 10, 12)],
        eventTime: 2000,
      }),
    ],
  ]);

  const feeds = [ufcApi, thirdPartyApi];
  await syncOnce(feeds, 2000, instantRetry);
  const before = getFight("fight-1", Date.now());
  assert.deepEqual(
    before?.rounds.map((r) => r.settled),
    [false, false, false],
  );

  await syncOnce(feeds, 2000, instantRetry);
  const after = getFight("fight-1", Date.now());
  assert.ok(after !== null);
  assert.deepEqual(
    after.rounds.map((r) => [r.round, r.fighters["f-001"].sigStrikes?.source, r.settled]),
    [
      [1, "ufc-api", true],
      [2, "ufc-api", true],
      [3, "third-party-api", false],
    ],
  );
  assert.equal(after.rounds[1].fighters["f-001"].sigStrikes?.value.landed, 10); // the UFC API's 10, not the estimate's 11
  assert.equal(after.round, 3); // still the live round, from the feed that is further along
  assert.equal(after.status, "live");
});

test("a fight only the third-party API has seen exists on its own: under our ids for a configured bout, under a provisional identity otherwise, and is linked when the UFC API shows up", async () => {
  // The third-party API sees fight 1 (configured bout) and fight 2 (nobody configured "main-card-2").
  const novakTanaka = [
    { id: "red", firstName: "Lena", lastName: "Novak", age: 27, name: "Lena Novak" },
    { id: "blue", firstName: "Yuki", lastName: "Tanaka", age: 33, name: "Yuki Tanaka" },
  ];
  const thirdPartyApi = scriptedFeed("third-party-api", [
    [
      frame({ round: 1, clockSeconds: 200, rounds: [cornerRound(1, 4, 2)], eventTime: 1500 }),
      frame({
        id: "main-card-2",
        fighters: novakTanaka,
        round: 1,
        clockSeconds: 200,
        rounds: [cornerRound(1, 4, 2)],
        eventTime: 1500,
      }),
    ],
  ]);
  // The UFC API is dark for two polls, then reports fight 2 with its roster.
  const ufcApi = scriptedFeed("ufc-api", [
    new Error("ECONNREFUSED"),
    new Error("ECONNREFUSED"),
    [
      report("ufc-api", {
        id: "fight-2",
        fighters: [
          { id: "f-003", firstName: "Lena", lastName: "Novak", age: 27, name: "Lena Novak" },
          { id: "f-004", firstName: "Yuki", lastName: "Tanaka", age: 33, name: "Yuki Tanaka" },
        ],
        round: 1,
        clockSeconds: 0,
        rounds: [
          {
            round: 1,
            fighters: {
              "f-003": roundOf(1, 5, 2).fighters["f-001"],
              "f-004": roundOf(1, 5, 2).fighters["f-002"],
            },
          },
        ],
        eventTime: 2000,
      }),
    ],
  ]);
  const feeds = [ufcApi, thirdPartyApi];

  await syncOnce(feeds, 2000, instantRetry);
  const now = Date.now();
  const configured = getFight("fight-1", now);
  assert.ok(configured !== null); // a configured bout exists under our ids from one feed
  assert.equal(configured.identity, "confirmed");
  assert.equal(configured.status, null); // but nothing only the UFC API can know
  assert.equal(configured.rounds[0].settled, false);
  const provisional = getFight("tp:main-card-2", now);
  assert.ok(provisional !== null); // an unconfigured bout exists under the camera's own identity
  assert.equal(provisional.identity, "provisional");
  assert.equal(provisional.fighters[0].id, "tp:main-card-2:red");
  assert.equal(provisional.rounds[0].fighters["tp:main-card-2:red"].sigStrikes?.value.landed, 4);
  assert.equal(getFight("fight-2", now), null);
  assert.equal(getStatus(now)["ufc-api"].lastError, "ECONNREFUSED");

  await syncOnce(feeds, 2000, instantRetry);
  await syncOnce(feeds, 2000, instantRetry); // the UFC API appears and reports fight 2

  const linked = getFight("fight-2", now);
  assert.ok(linked !== null);
  assert.equal(linked.identity, "confirmed");
  assert.equal(linked.status, "live");
  assert.equal(linked.rounds[0].settled, true);
  assert.equal(linked.rounds[0].fighters["f-003"].sigStrikes?.source, "ufc-api"); // the scorekeeper's 5
  assert.equal(linked.rounds[0].fighters["f-003"].sigStrikes?.value.landed, 5);
  assert.equal(getFight("tp:main-card-2", now), null); // the provisional fight is gone, not duplicated
  assert.deepEqual(
    listFights(now).map((f) => f.id),
    ["fight-1", "fight-2"],
  );
});
