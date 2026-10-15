// Which faults the simulated feeds produce. Chosen once at startup with --scenario.
export const SCENARIOS = [
  "flaky",
  "calm",
  "ufc-api-down",
  "third-party-api-down",
  "both-down",
  "ufc-api-lagging",
  "ufc-api-late-start",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

let current: Scenario = "flaky";

export function setScenario(scenario: Scenario): void {
  current = scenario;
}

// The everyday faults: rate limits, repeats, noise, slow answers, a broken stat. Only in "flaky".
export function faultsOn(): boolean {
  return current === "flaky";
}

// In the "down" scenarios a feed works until this tick, 30 seconds into round 2
// of fight 1 (long enough for the UFC API to have published round 1), then goes
// dark: every call hangs until the caller gives up.
export const DARK_AFTER_TICK = 90;

export function ufcApiDown(): boolean {
  return current === "ufc-api-down" || current === "both-down";
}

export function thirdPartyApiDown(): boolean {
  return current === "third-party-api-down" || current === "both-down";
}

// In "ufc-api-lagging" the UFC API answers every poll, but every publication
// after its first one shows up this many ticks (seconds) late: a minute.
export const LAG_TICKS = 60;

export function ufcApiLagging(): boolean {
  return current === "ufc-api-lagging";
}

// In "ufc-api-late-start" the UFC API is dark until this tick, 40 seconds after
// fight 2 has started. Until then only the third-party API has seen fight 2, so
// it exists under a provisional identity, and is linked when the UFC API appears.
export const LATE_START_TICK = 240;

export function ufcApiLateStart(): boolean {
  return current === "ufc-api-late-start";
}
