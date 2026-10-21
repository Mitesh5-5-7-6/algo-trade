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

  /**
   * And it actually trades. Risk refuses a non-equity symbol it has no
   * instrument for — "lot size unknown" — so without a synthetic instrument
   * the label above would sit on a run that could never fill anything. Found
   * replaying a real week of NIFTY: four BUYs, all blocked at positionSize.
   */
  it("sizes and fills a synthetic index, in index points", async () => {
    const strategy = emaStrategy();
    const index = await runHistoricalReplay(
      await request({
        strategy: { ...strategy, symbols: ["NSE:TESTINDEX-INDEX"] },
      }),
    );

    const blocked = index.record.riskDecisions.filter(
      (d) => d.failedCheck === "positionSize",
    );
    expect(blocked).toEqual([]);
    expect(index.record.orders.length).toBeGreaterThan(0);
  });
});

/**
 * Task 4.6 — what a run refuses, and what it cannot see.
 */
describe("a run refuses what it cannot replay (§4.6, D8)", () => {
  /**
   * An option-chain strategy evaluated against an absent chain reads it as
   * "hold" — a confident record of nothing. Refused by name instead.
   */
  it("refuses a strategy that needs an option chain", async () => {
    const strategy = {
      ...emaStrategy(),
      strategyId: "str_pcr",
      type: "INDEX_OPTION_PCR_OI",
      params: {},
    };
    await expect(
      runHistoricalReplay(await request({ strategy })),
    ).rejects.toThrow(/INDEX_OPTION_PCR_OI.*option chain/);
  });

  /** A derivative strategy trades contracts the index-only dataset never priced. */
  it("refuses a strategy that trades a derivative contract", async () => {
    const strategy = {
      ...emaStrategy(),
      strategyId: "str_opt",
      type: "INDEX_OPTION_MOMENTUM",
      params: {},
    };
    await expect(
      runHistoricalReplay(await request({ strategy })),
    ).rejects.toThrow(/INDEX_OPTION_MOMENTUM.*contract/);
  });

  /** No bars for what it trades means nothing to decide on — not a quiet day. */
  it("refuses a strategy whose symbol the dataset does not hold", async () => {
    const strategy = { ...emaStrategy(), symbols: ["NSE:ABSENT-EQ"] };
    await expect(
      runHistoricalReplay(await request({ strategy })),
    ).rejects.toThrow(/NSE:ABSENT-EQ/);
  });

  it("refuses a strategy that decides on another interval", async () => {
    const ema = emaStrategy();
    const strategy = { ...ema, params: { ...ema.params, interval: "15m" } };
    await expect(
      runHistoricalReplay(await request({ strategy })),
    ).rejects.toThrow(/15m.*5m/);
  });
});

describe("no decision sees the future (§4.6, D7)", () => {
  /**
   * The behavioural statement of "Feature(t) = f(candles ≤ t)": appending a
   * later day to the dataset changes nothing that was decided before it. If
   * any decision on days 1–2 read a bar from day 3, adding day 3 would move it.
   */
  it("decides the same on earlier days whether or not later days exist", async () => {
    // The later day must DIFFER from the earlier ones: were it a copy, a
    // decision that read it would see what it would have seen anyway, and
    // a leak would pass unnoticed.
    const scale = (offset: number) => (offset === 2 ? 1.3 : 1);
    const short = await runHistoricalReplay(
      await request({ candles: await historicalBars([0, 1], scale) }),
    );
    const long = await runHistoricalReplay(
      await request({ candles: await historicalBars([0, 1, 2], scale) }),
    );

    expect(long.record.signals.slice(0, short.record.signals.length)).toEqual(
      short.record.signals,
    );
    expect(long.record.orders.slice(0, short.record.orders.length)).toEqual(
      short.record.orders,
    );
    expect(long.record.trades.slice(0, short.record.trades.length)).toEqual(
      short.record.trades,
    );
    // Positions carry the stop and target levels, which the decisions above
    // do not — and a leaked window moves a stop long before it moves a fill.
    expect(
      long.record.positions.slice(0, short.record.positions.length),
    ).toEqual(short.record.positions);
    expect(long.record.signals.length).toBeGreaterThan(
      short.record.signals.length,
    );
  });

  /** Bars are replayed in time order, whatever order they were handed in. */
  it("is indifferent to the order the bars arrive in", async () => {
    const bars = await historicalBars([0, 1]);
    const ordered = await runHistoricalReplay(await request({ candles: bars }));
    const shuffled = await runHistoricalReplay(
      await request({ candles: [...bars].reverse() }),
    );
    expect(shuffled.fingerprint).toBe(ordered.fingerprint);
  });
});

describe("one strategy per run (§4.6, D4)", () => {
  /**
   * Isolation is the request's shape — one strategy — and the record shows
   * it: nothing in it belongs to anyone else.
   */
  it("records only the strategy it was given", async () => {
    const { record } = await runHistoricalReplay(await request());
    const ids = new Set([
      ...record.signals.map((s) => s.strategyId),
      ...record.trades.map((t) => t.strategyId),
    ]);
    expect(ids).toEqual(new Set(["str_ema"]));
  });
});
