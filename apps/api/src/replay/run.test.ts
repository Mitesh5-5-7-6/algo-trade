import { describe, expect, it } from "vitest";
import { DEFAULT_CHARGES } from "@neelkanth/broker";
import { runHistoricalReplay, type HistoricalReplayRequest } from "./run.js";
import { emaStrategy, goldenBudget, historicalBars } from "./test-support.js";

/**
 * Task 4.5 (design D5): a run declares everything it is a function of, and
 * carries a fingerprint of its result — so "the same replay twice" is checked
 * by comparing two strings, and a difference in any declared input shows.
 */
async function request(
  over: Partial<HistoricalReplayRequest> = {},
): Promise<HistoricalReplayRequest> {
  return {
    strategy: emaStrategy(),
    candles: await historicalBars([0, 1]),
    hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
    ...goldenBudget(),
    seed: 7,
    ...over,
  };
}

describe("a replay run's manifest and fingerprint (§4.5, D5)", () => {
  it("gives the same fingerprint for the same request, twice", async () => {
    const a = await runHistoricalReplay(await request());
    const b = await runHistoricalReplay(await request());

    // A run that traded nothing would make this comparison hollow.
    expect(a.record.trades.length).toBeGreaterThan(0);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.record).toEqual(a.record);
  });

  it.each([
    ["the seed", { seed: 8 }],
    [
      "the slippage model",
      { slippage: { kind: "percent" as const, pct: 0.001 } },
    ],
    ["the capital", { allocatedCapital: 200_000 }],
  ])("changes when %s changes", async (_what, over) => {
    const base = await runHistoricalReplay(await request());
    const other = await runHistoricalReplay(await request(over));
    expect(other.fingerprint).not.toBe(base.fingerprint);
  });

  it("changes when the strategy's params change", async () => {
    const strategy = emaStrategy();
    const base = await runHistoricalReplay(await request());
    const other = await runHistoricalReplay(
      await request({
        strategy: { ...strategy, params: { ...strategy.params, quantity: 5 } },
      }),
    );
    expect(other.manifest.strategy.strategyVersion).not.toBe(
      base.manifest.strategy.strategyVersion,
    );
    expect(other.fingerprint).not.toBe(base.fingerprint);
  });

  /** The spec's four model versions, plus the dataset and the strategy. */
  it("names what the run was measured with", async () => {
    const { manifest } = await runHistoricalReplay(await request());

    expect(manifest.models).toEqual({
      positionSizing: "1",
      exit: "1",
      slippage: { version: "1", model: { kind: "percent", pct: 0.0005 } },
      transactionCost: { version: "1", config: DEFAULT_CHARGES },
    });
    expect(manifest.dataset).toMatchObject({
      symbols: ["NSE:TESTCO-EQ", "NSE:TESTINDEX-INDEX"],
      interval: "5m",
      days: ["2026-01-05", "2026-01-06"],
      bars: 284,
      sources: { BROKER_HISTORICAL: 284 },
      ingestionVersions: [1],
    });
    expect(manifest.strategy).toMatchObject({
      strategyId: "str_ema",
      type: "EMA_CROSSOVER",
    });
    expect(manifest.strategy.strategyVersion).toMatch(/^cfg-/);
    expect(manifest.seed).toBe(7);
  });

  /** Q1: an index traded by a run is labelled synthetic on the manifest. */
  it("labels a traded index as a synthetic instrument", async () => {
    const strategy = emaStrategy();
    const equity = await runHistoricalReplay(await request());
    const index = await runHistoricalReplay(
      await request({
        strategy: { ...strategy, symbols: ["NSE:TESTINDEX-INDEX"] },
      }),
    );

    expect(equity.manifest.synthetic).toEqual([]);
    expect(index.manifest.synthetic).toEqual(["NSE:TESTINDEX-INDEX"]);
  });
});
