import { defineConfig } from "vitest/config";

/**
 * Run this package's test FILES one at a time.
 *
 * Several suites here talk to the same Mongo database and the same Redis
 * instance, and two of them read and write `risk:dailyLoss:<istDate>` — the
 * composition-root suite boots a runtime that restores it, while the restart
 * suite deliberately writes it. Run in parallel, whichever lands second sees
 * the other's value, and the failure appears in the suite that did nothing
 * wrong. That is exactly the bug the restart suite exists to prove is fixed,
 * which made the diagnosis unusually confusing.
 *
 * The key is date-derived by design, so it cannot be namespaced per suite
 * without changing production behaviour for a test's convenience. Serial
 * files is the honest trade: a slower suite that means what it says.
 *
 * Tests WITHIN a file still run concurrently — this only stops two files
 * racing for one row of shared state.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
