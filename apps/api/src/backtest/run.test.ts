import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CHARGES } from "@neelkanth/broker";
import { istDayStart, type Candle } from "@neelkanth/core";
import { goldenBudget, historicalBars } from "../replay/test-support.js";
import { DEFAULT_REGIME_MODEL } from "../counterfactual/regime.js";
import {
  runBacktest,
  stressedCosts,
  warmupFrom,
  type BacktestRequest,
} from "./run.js";

/** Task 13.2 (design D2, D3): a backtest — deterministic, warm, stressed, and blind to what follows it. */
const SYM = "NSE:TESTCO-EQ";
const INDEX = "NSE:TESTINDEX-INDEX";
let bars: Candle[];

const request = (over: Partial<BacktestRequest> = {}): BacktestRequest => ({
  strategyType: "EMA_CROSSOVER",
  params: {},
  symbols: [SYM],
  interval: "5m",
  fromDate: "2026-01-07",
  toDate: "2026-01-09",
  hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
  ...goldenBudget(),
  seed: 0,
  regime: { ...DEFAULT_REGIME_MODEL, symbol: INDEX },
  ...over,
});

beforeAll(async () => {
  // 2026-01-05 .. 2026-01-09 and 2026-01-12, 13 — each day priced apart.
  bars = await historicalBars(
    [0, 1, 2, 3, 4, 7, 8],
    (d) => 1 + (d % 5) * 0.04 + d * 0.01,
  );
}, 120_000);

describe("a backtest (13.2, D2)", () => {
  it("measures the Trades entered inside its window, and names what it stands on", async () => {
    const b = await runBacktest(bars, request());
    expect(b.metrics.trades).toBeGreaterThan(0);
    expect(b).toMatchObject({
      backtestVersion: "1",
      strategyType: "EMA_CROSSOVER",
      symbols: [SYM],
      window: { fromDate: "2026-01-07", toDate: "2026-01-09" },
      capitalBasis: goldenBudget().allocatedCapital,
      costs: { slippage: { kind: "percent", pct: 0.0005 }, stressed: false },
    });
    expect(Object.keys(b.replays)).toEqual([SYM]);
    expect(b.metrics.sessions).toBe(3);
    expect(b.strategyVersion).toMatch(/^cfg-/);
  }, 120_000);

  it("is deterministic: the same request, the same fingerprint", async () => {
    expect((await runBacktest(bars, request())).fingerprint).toBe(
      (await runBacktest(bars, request())).fingerprint,
    );
  }, 120_000);

  /** §5.4: nothing after the window can reach it. */
  it("is unchanged by bars after its window", async () => {
    const until = istDayStart("2026-01-10");
    const a = await runBacktest(
      bars.filter((c) => c.ts < until),
      request(),
    );
    const b = await runBacktest(bars, request());
    expect(b.fingerprint).toBe(a.fingerprint);
  }, 120_000);

  /** The warm-up lead: a window measured alone equals the same days inside a longer run. */
  it("counts no Trade entered before its window, and starts it warm", async () => {
    // Warm, consecutive windows tile: Jan 5–9 is exactly Jan 5–6 plus Jan 7–9.
    const whole = await runBacktest(bars, request({ fromDate: "2026-01-05" }));
    const first = await runBacktest(
      bars,
      request({ fromDate: "2026-01-05", toDate: "2026-01-06" }),
    );
    const second = await runBacktest(bars, request());
    expect(first.metrics.trades + second.metrics.trades).toBe(
      whole.metrics.trades,
    );
    expect(first.metrics.net + second.metrics.net).toBeCloseTo(
      whole.metrics.net,
      2,
    );
    expect(warmupFrom("2026-01-07")).toBe("2025-12-28");
    // And the lead is what makes it so: with no bars before the window, the
    // indicators start cold and the same window decides differently.
    const cold = await runBacktest(
      bars.filter((c) => c.ts >= istDayStart("2026-01-07")),
      request(),
    );
    expect(cold.fingerprint).not.toBe(second.fingerprint);
  }, 120_000);

  it("states its capital basis: capital per instrument × instruments", async () => {
    const two = await runBacktest(bars, request({ symbols: [SYM, INDEX] }));
    expect(two.capitalBasis).toBe(goldenBudget().allocatedCapital * 2);
  }, 120_000);
});

describe("cost stress (13.2, D3)", () => {
  it("doubles slippage and raises every charge by half — GST staying a rate on its base", () => {
    const s = stressedCosts({ kind: "percent", pct: 0.0005 }, DEFAULT_CHARGES);
    expect(s.slippage).toEqual({ kind: "percent", pct: 0.001 });
    expect(s.charges).toEqual({
      brokeragePerOrder: 30,
      brokeragePct: DEFAULT_CHARGES.brokeragePct * 1.5,
      sttPct: DEFAULT_CHARGES.sttPct * 1.5,
      exchangeTxnPct: DEFAULT_CHARGES.exchangeTxnPct * 1.5,
      sebiPct: DEFAULT_CHARGES.sebiPct * 1.5,
      gstPct: DEFAULT_CHARGES.gstPct,
      stampPct: DEFAULT_CHARGES.stampPct * 1.5,
    });
    expect(
      stressedCosts({ kind: "fixed", amount: 0.1 }, DEFAULT_CHARGES).slippage,
    ).toEqual({ kind: "fixed", amount: 0.2 });
  });

  it("costs the same Trades more, and says it was stressed", async () => {
    const normal = await runBacktest(bars, request());
    const stressed = await runBacktest(bars, request({ stressed: true }));
    expect(stressed.costs.stressed).toBe(true);
    expect(stressed.metrics.charges).toBeGreaterThan(normal.metrics.charges);
    expect(stressed.metrics.slippage).toBeGreaterThan(normal.metrics.slippage);
    expect(stressed.metrics.net).toBeLessThan(normal.metrics.net);
    expect(stressed.fingerprint).not.toBe(normal.fingerprint);
  }, 120_000);
});
