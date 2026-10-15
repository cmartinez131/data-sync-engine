import { test } from "node:test";
import assert from "node:assert/strict";
import { fights, tick } from "../src/world.ts";

function fight(id: string) {
  const found = fights.find((f) => f.id === id);
  if (found === undefined) throw new Error(`no fight ${id}`);
  return found;
}

function run(ticks: number): void {
  for (let i = 0; i < ticks; i++) tick();
}

test("the card runs in order and each fight ends the way its script says", () => {
  assert.equal(fight("fight-1").status, "live");
  assert.equal(fight("fight-2").status, "scheduled");
  assert.equal(fight("fight-3").status, "scheduled");

  // Fight 1 goes three full rounds and ends in a decision at tick 180.
  run(180);
  const one = fight("fight-1");
  assert.equal(one.status, "final");
  assert.equal(one.rounds.length, 3);
  assert.equal(one.result?.method, "decision");
  assert.equal(one.result?.round, 3);
  assert.equal(one.result?.timeSeconds, 300);
  assert.ok(one.result !== null && ["f-001", "f-002"].includes(one.result.winnerId));
  assert.equal(fight("fight-2").status, "scheduled"); // not until tick 200

  // Fight 2 starts at tick 200 and is submitted at tick 245: 46 ticks into round 1.
  run(65);
  assert.deepEqual(fight("fight-2").result, {
    winnerId: "f-003",
    method: "submission",
    round: 1,
    timeSeconds: 230,
  });

  // Fight 3 starts at tick 400 and is knocked out at tick 510: 51 ticks into round 2.
  run(265);
  assert.deepEqual(fight("fight-3").result, {
    winnerId: "f-006",
    method: "KO/TKO",
    round: 2,
    timeSeconds: 255,
  });
});

test("the numbers stay consistent: landed never exceeds attempted", () => {
  for (const f of fights) {
    for (const round of f.rounds) {
      for (const stats of Object.values(round.fighters)) {
        assert.ok(stats.sigStrikes.landed <= stats.sigStrikes.attempted);
        assert.ok(stats.totalStrikes.landed <= stats.totalStrikes.attempted);
        assert.ok(stats.takedowns.landed <= stats.takedowns.attempted);
        assert.ok(stats.sigStrikes.attempted <= stats.totalStrikes.attempted);
        assert.ok(stats.knockdowns <= stats.sigStrikes.landed);
        assert.ok(stats.controlSeconds >= 0 && stats.controlSeconds <= 300);
      }
    }
  }
});
