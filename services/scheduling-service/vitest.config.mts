import { defineConfig } from "vitest/config";

// Stage 05 finding (pre-existing, not introduced by Stage 05 itself):
// every test file here runs real scheduling pipeline runs against one
// shared Postgres/Redis, and Operator (packages/domain/prisma/schema.prisma)
// has no plantId at all — every plant's placement logic draws from the
// exact same global operator pool. Vitest's default file-level
// parallelism runs each *.test.ts file in its own worker simultaneously,
// which is safe for every other service's tests (genuinely isolated
// fixtures) but not for this one: concurrent files legitimately contend
// for the same global operators' ResourceReservation rows (the real GiST
// exclusion constraint doing its job) and the same Redis-backed
// capacity/lock keys, producing real but misleading failures that have
// nothing to do with the code under test. Running files sequentially
// avoids that without changing what any single test verifies.
export default defineConfig({
  test: {
    fileParallelism: false,
    // Real Redis capacity-bucket initialization across a multi-week
    // horizon (plus two real end-to-end runs in some concurrency tests)
    // can genuinely take longer than Vitest's 5s default against a real,
    // shared dev Postgres/Redis — a timed-out test aborts mid-run and can
    // leave its plant lock un-released, cascading into unrelated-looking
    // failures in whichever test happens to run next. 15s gives real runs
    // real headroom without masking an actual hang.
    testTimeout: 15_000,
  },
});
