import { describe, expect, it } from "vitest";
import { createStrategyRegistry } from "@neelkanth/strategies";
import { runHistoricalReplay } from "../replay/run.js";
import { goldenBudget, historicalBars } from "../replay/test-support.js";
import { ALL } from "./matrix.js";
import { DEFAULT_REGIME_MODEL } from "./regime.js";
import { runCounterfactual, type CounterfactualRequest } from "./run.js";

/**
 * Task 6.5 (design D2, D7): every strategy against the same market, each
 * alone per symbol, with a manifest naming everything the run is a function
 * of and a fingerprint of what it found.
 */
const EQ = "NSE:TESTCO-EQ";
const INDEX = "NSE:TESTINDEX-INDEX";
const HOURS = { open: "09:15", close: "15:30", squareOff: "15:12" };

async function request(
  over: Partial<CounterfactualRequest> = {},
): Promise<CounterfactualRequest> {
  return {
    // Three days that differ, so nothing passes by repetition.
    candles: await historicalBars([0, 1, 2], (d) => 1 + d * 0.07),
    symbols: [EQ],
    hours: HOURS,
    ...goldenBudget(),
    seed: 7,
    regime: { ...DEFAULT_REGIME_MODEL, symbol: INDEX },
    ...over,
  };
}

describe("a counterfactual run (6.5)", () => {
  it("accounts for every registered strategy on every symbol (D1)", async () => {
    const run = await runCounterfactual(
      await request({ symbols: [EQ, INDEX] }),
    );
    const types = createStrategyRegistry().types();
    for (const symbol of [EQ, INDEX])
      expect(
        run.manifest.strategies
          .filter((s) => s.symbol === symbol)
          .map((s) => s.type),
      ).toEqual(types);
    expect(
      run.manifest.strategies.filter((s) => s.eligible).map((s) => s.type),
    ).toEqual(["EMA_CROSSOVER", "RSI", "ORB", "EMA_CROSSOVER", "RSI", "ORB"]);
  }, 120_000);

  /**
   * D2: a strategy's evidence is what it does alone. Its baseline here is
   * exactly the Trades the same replay makes run on its own.
   */
  it("replays each strategy alone — its baseline is its own replay's Trades", async () => {
    const req = await request();
    const run = await runCounterfactual(req);
    // A fair test: strategies did trade here.
    const traded = run.manifest.strategies.filter(
      (s) => s.eligible && s.trades > 0,
    );
    expect(traded.length).toBeGreaterThanOrEqual(2);
    for (const entry of run.manifest.strategies.filter((s) => s.eligible)) {
      const alone = await runHistoricalReplay({
        strategy: {
          strategyId: `cf_${entry.type.toLowerCase()}_nse_testco_eq`,
          ownerId: "research",
          type: entry.type,
          name: `${entry.type} counterfactual`,
          params: {},
          symbols: [EQ],
          enabled: true,
          status: "active",
          createdAt: 0,
          updatedAt: 0,
        },
        candles: req.candles,
        hours: HOURS,
        ...goldenBudget(),
        seed: 7,
      });
      expect(entry.replayFingerprint).toBe(alone.fingerprint);
      const baseline = run.matrix.find(
        (r) =>
          r.patternId === ALL &&
          r.strategyType === entry.type &&
          r.symbol === ALL &&
          r.regime === ALL,
      );
      expect(baseline?.trades.n).toBe(alone.trail.trades.length);
      expect(baseline?.trades.net).toBeCloseTo(
        alone.trail.trades.reduce((n, t) => n + (t.netPnl ?? 0), 0),
        3,
      );
    }
  }, 120_000);

  it("puts every pattern to every evaluated strategy", async () => {
    const run = await runCounterfactual(await request());
    const found = Object.keys(run.patterns[0]?.found ?? {});
    expect(found.length).toBeGreaterThan(0);
    for (const patternId of found)
      for (const type of ["EMA_CROSSOVER", "RSI", "ORB"]) {
        const row = run.matrix.find(
          (r) =>
            r.patternId === patternId &&
            r.strategyType === type &&
            r.symbol === ALL &&
            r.regime === ALL,
        );
        expect(row?.occurrences).toBe(run.patterns[0]?.found[patternId]);
        const rel = row?.relations;
        expect(
          (rel?.ENTERED ?? 0) +
            (rel?.SIGNALLED ?? 0) +
            (rel?.HOLDING ?? 0) +
            (rel?.FLAT ?? 0),
        ).toBe(row?.occurrences);
      }
  }, 120_000);

  it("names every model, version and detector it was measured with (D7)", async () => {
    const { manifest } = await runCounterfactual(await request());
    // 2 since Phase 7 D2: cells carry their spread.
    expect(manifest.counterfactualVersion).toBe("2");
    expect(manifest.models).toMatchObject({
      positionSizing: expect.any(String) as string,
      exit: expect.any(String) as string,
      slippage: { version: "1" },
      transactionCost: { version: "1" },
      regime: {
        version: "1",
        kind: "INDEX_TREND",
        symbol: INDEX,
        emaPeriod: 21,
      },
      attribution: { version: "1", windowBars: 0 },
    });
    expect(
      manifest.detectors.map(
        (d) => `${d.definition.patternId}@${d.definition.detectorVersion}`,
      ),
    ).toEqual([
      "ORB_BREAKOUT@1.0.0",
      "EMA_CROSS@1.0.0",
      "RSI_REVERSION@1.0.0",
      "VWAP_RECLAIM@1.0.0",
      "HIGH_VOLUME_BREAKOUT@1.0.0",
    ]);
    expect(manifest.detectors[0]?.params).toEqual({
      rangeMinutes: 15,
      minMinutesSinceOpen: 15,
    });
    expect(manifest.dataset).toMatchObject({
      symbols: [EQ, INDEX],
      interval: "5m",
      days: ["2026-01-05", "2026-01-06", "2026-01-07"],
    });
  }, 120_000);

  it("gives the same fingerprint twice, whatever order the bars arrive in", async () => {
    const req = await request();
    const a = await runCounterfactual(req);
    const b = await runCounterfactual({
      ...req,
      candles: [...req.candles].reverse(),
    });
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);

  it("changes the fingerprint when a declared model changes", async () => {
    const req = await request();
    const base = await runCounterfactual(req);
    const wider = await runCounterfactual({
      ...req,
      attribution: { version: "1", windowBars: 2 },
    });
    const slower = await runCounterfactual({
      ...req,
      regime: { ...DEFAULT_REGIME_MODEL, symbol: INDEX, emaPeriod: 9 },
    });
    expect(wider.fingerprint).not.toBe(base.fingerprint);
    expect(slower.fingerprint).not.toBe(base.fingerprint);
    // Not just the label: the declared models are the ones the matrix used.
    const entered = (m: typeof base.matrix) =>
      m
        .filter((r) => r.symbol === ALL && r.regime === ALL)
        .reduce((n, r) => n + (r.relations?.ENTERED ?? 0), 0);
    expect(entered(wider.matrix)).toBeGreaterThan(entered(base.matrix));
    const regimes = (m: typeof base.matrix) =>
      JSON.stringify(
        m
          .filter((r) => r.regime !== ALL)
          .map((r) => [r.patternId, r.strategyType, r.regime, r.occurrences]),
      );
    expect(regimes(slower.matrix)).not.toBe(regimes(base.matrix));
  }, 120_000);

  it("refuses a dataset without its regime index", async () => {
    const req = await request();
    await expect(
      runCounterfactual({
        ...req,
        candles: req.candles.filter((c) => c.symbol !== INDEX),
      }),
    ).rejects.toThrow(/NSE:TESTINDEX-INDEX, the regime index/);
  }, 120_000);
});
