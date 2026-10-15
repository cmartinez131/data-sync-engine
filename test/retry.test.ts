import { test } from "node:test";
import assert from "node:assert/strict";
import { BadDataError, HttpError, parseRetryAfter } from "../src/errors.ts";
import { isRetryable, retry } from "../src/retry.ts";

// Records every wait instead of waiting, so these tests are instant.
function fakeSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

// A function that fails with the given errors in order, then succeeds.
function failsThen(errors: Error[]) {
  let calls = 0;
  const fn = async (): Promise<string> => {
    calls += 1;
    const err = errors[calls - 1];
    if (err !== undefined) throw err;
    return "ok";
  };
  return { fn, calls: () => calls };
}

function timeout(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

// random fixed at 1 makes every backoff its maximum, so the waits are exact.
const options = { attempts: 3, baseMs: 200, capMs: 5000, random: () => 1 };

test("a call that succeeds first time never waits", async () => {
  const { waits, sleep } = fakeSleep();
  const { fn, calls } = failsThen([]);
  assert.equal(await retry(fn, { ...options, sleep }), "ok");
  assert.equal(calls(), 1);
  assert.deepEqual(waits, []);
});

test("backoff waits up to 200 ms then 400 ms, scaled by the jitter, never above capMs", async () => {
  const full = fakeSleep();
  const { fn, calls } = failsThen([new HttpError(429), new HttpError(429)]);
  assert.equal(await retry(fn, { ...options, sleep: full.sleep }), "ok");
  assert.equal(calls(), 3);
  assert.deepEqual(full.waits, [200, 400]); // random 1: the maximum each time

  const half = fakeSleep();
  await retry(failsThen([new HttpError(503), new HttpError(503)]).fn, {
    ...options,
    sleep: half.sleep,
    random: () => 0.5,
  });
  assert.deepEqual(half.waits, [100, 200]); // random 0.5: half of each

  const capped = fakeSleep();
  await retry(failsThen([new HttpError(503), new HttpError(503), new HttpError(503)]).fn, {
    ...options,
    attempts: 4,
    capMs: 300,
    sleep: capped.sleep,
  });
  assert.deepEqual(capped.waits, [200, 300, 300]); // 400 and 800 are cut to the cap
});

test("Retry-After from the feed replaces the backoff, and is read as whole seconds", async () => {
  const { waits, sleep } = fakeSleep();
  const { fn } = failsThen([new HttpError(429, 2000)]);
  await retry(fn, { ...options, sleep });
  assert.deepEqual(waits, [2000]);

  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT"), null); // an HTTP date is ignored
  assert.equal(parseRetryAfter(null), null);
});

test("a Retry-After longer than capMs ends the poll at once, with no early retry", async () => {
  const { waits, sleep } = fakeSleep();
  const { fn, calls } = failsThen([new HttpError(429, 60_000)]);
  await assert.rejects(retry(fn, { ...options, sleep }), HttpError);
  assert.equal(calls(), 1);
  assert.deepEqual(waits, []);
});

test("a timeout is retried", async () => {
  const { waits, sleep } = fakeSleep();
  const { fn, calls } = failsThen([timeout()]);
  assert.equal(await retry(fn, { ...options, sleep }), "ok");
  assert.equal(calls(), 2);
  assert.deepEqual(waits, [200]);
});

test("bad data, a 404 and an unknown error are thrown at once, with no retry", async () => {
  for (const err of [
    new BadDataError('unknown status "PAUSED"'),
    new HttpError(404),
    new Error("ECONNREFUSED"),
  ]) {
    const { waits, sleep } = fakeSleep();
    const { fn, calls } = failsThen([err]);
    await assert.rejects(retry(fn, { ...options, sleep }), err);
    assert.equal(calls(), 1);
    assert.deepEqual(waits, []);
    assert.equal(isRetryable(err), false);
  }
});

test("after the last attempt the last error is thrown", async () => {
  const { waits, sleep } = fakeSleep();
  const errors = [new HttpError(503), new HttpError(503), new HttpError(502)];
  const { fn, calls } = failsThen(errors);
  await assert.rejects(retry(fn, { ...options, sleep }), errors[2]);
  assert.equal(calls(), 3);
  assert.equal(waits.length, 2);
});
