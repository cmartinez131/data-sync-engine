# Tests

`npm run check` typechecks and runs the 32 tests. Each test is named after a claim in the README, so a failing test says which promise broke. The tests use an in-memory database and never start the servers, so the whole suite runs in well under a second.

- `adapters.test.ts`: each adapter maps a sample payload, rejects what it cannot read, ignores an added field, treats a left-out stat as a gap and drops an unreadable one while keeping the rest.
- `store.test.ts`: per-feed ordering, the merge rule from `merge.ts`, per-stat filling with source and time, status and result from the UFC API only, staleness, counters, identity matching from `identity.ts` and provisional linking.
- `sync.test.ts`: scripted feeds, no servers. The UFC API going dark, both going dark, bad data rejected, a poll retried, a late UFC report settling a round, a fight that only the third-party feed has seen, configured or provisional, linked when the UFC API shows up.
- `retry.test.ts`: exact waits on a fake clock, `Retry-After`, the cap, what is and is not retried.
- `world.test.ts`: the scripted card and consistent counts.
