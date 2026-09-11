import { describe, expect, it } from "vitest";
import type {
  Candle,
  CandleInterval,
  MarketContext,
  Position,
  StrategyVerdict,
} from "@neelkanth/core";
import type { StrategyDefinition } from "./contract.js";
import { emaCrossover } from "./ema-crossover.js";
import { rsiReversion } from "./rsi-reversion.js";
import { orb } from "./orb.js";
import { indexOptionMomentum } from "./index-option-momentum.js";
import { createStrategyRegistry } from "./index.js";

const SYM = "NSE:X-EQ";

/** An arbitrary but fixed session anchor, so bar timestamps are readable. */
const DAY1_OPEN = 1_760_000_000_000;
const INTERVAL_MINUTES: Record<CandleInterval, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "60m": 60,
};

interface BarOpts {
  close: number;
  high?: number;
  low?: number;
  volume?: number;
  indicators?: Record<string, number>;
  minutesSinceOpen?: number;
  candles?: Candle[];
  position?: Position | null;
  interval?: CandleInterval;
  sessionOpenTs?: number;
}

function context(opts: BarOpts): MarketContext {
  const interval = opts.interval ?? "5m";
  const sessionOpenTs = opts.sessionOpenTs ?? DAY1_OPEN;
  const minutesSinceOpen = opts.minutesSinceOpen ?? 30;
  const candle: Candle = {
    symbol: SYM,
    interval,
    open: opts.close,
    high: opts.high ?? opts.close,
    low: opts.low ?? opts.close,
    close: opts.close,
    volume: opts.volume ?? 1,
    // `minutesSinceOpen` is when the bar CLOSED; a bucket is labelled by its
    // start, so back off one interval.
    ts:
      sessionOpenTs +
      (minutesSinceOpen - INTERVAL_MINUTES[interval]) * 60_000,
  };
  return {
    symbol: SYM,
    interval,
    candle,
    candles: opts.candles ?? [candle],
    indicators: opts.indicators ?? {},
    session: { phase: "open", minutesSinceOpen, sessionOpenTs },
    position: opts.position ?? null,
    sentiment: 0,
  };
}

/**
 * A run of bars with a *rolling* window, the way the Strategy Runner feeds one
 * (plan/15 §4) — each context sees every bar up to and including its own.
 * Session-anchored strategies read their range out of this window, so a
 * one-bar `candles` would not exercise them at all.
 */
function series(bars: BarOpts[]): MarketContext[] {
  const window: Candle[] = [];
  return bars.map((bar) => {
    const built = context(bar);
    window.push(built.candle);
    return { ...built, candles: [...window] };
  });
}

function run<P, S>(
  def: StrategyDefinition<P, S>,
  rawParams: unknown,
  contexts: MarketContext[],
): StrategyVerdict[] {
  const params = def.paramsSchema.parse(rawParams);
  const state = def.init(params, SYM);
  return contexts.map((c) => def.analyze(c, state));
}

const longPosition: Position = {
  positionId: "pos_1",
  symbol: SYM,
  strategyId: "str_1",
  side: "LONG",
  qty: 10,
  avgEntryPrice: 100,
  status: "OPEN",
  realizedPnl: 0,
  unrealizedPnl: 0,
  openedAt: 0,
  mode: "paper",
};

describe("EMA Crossover (plan/16 §2)", () => {
  it("BUYs on a fast-over-slow cross up with an R-based target", () => {
    const verdicts = run(emaCrossover, {}, [
      context({ close: 100, indicators: { ema9: 98, ema21: 99 } }), // seed
      context({ close: 100, indicators: { ema9: 101, ema21: 99 } }), // cross up
    ]);
    expect(verdicts[0]?.side).toBe("HOLD");
    const buy = verdicts[1];
    expect(buy?.side).toBe("BUY");
    expect(buy?.stopLoss).toBe(99); // below slow EMA fallback
    expect(buy?.target).toBe(102); // close + 2R, R = 1
    expect(buy?.reason).toContain("crossed above");
  });

  it("exits a long on the opposite cross (plan/16 §2)", () => {
    const verdicts = run(emaCrossover, {}, [
      context({ close: 100, indicators: { ema9: 101, ema21: 99 } }), // seed (fast>slow)
      context({
        close: 100,
        indicators: { ema9: 98, ema21: 99 },
        position: longPosition,
      }), // cross down while long
    ]);
    expect(verdicts[1]?.side).toBe("SELL");
    expect(verdicts[1]?.qtyProposal).toBe(10);
    expect(verdicts[1]?.reason).toContain("exit long");
  });

  it("does not whipsaw: no signal when fast stays above slow (trap)", () => {
    const verdicts = run(emaCrossover, {}, [
      context({ close: 100, indicators: { ema9: 102, ema21: 99 } }), // seed
      context({ close: 100, indicators: { ema9: 103, ema21: 99 } }), // still above → no new cross
    ]);
    expect(verdicts[1]?.side).toBe("HOLD");
  });

  it("rejects fast ≥ slow at the schema boundary", () => {
    expect(
      emaCrossover.paramsSchema.safeParse({ fast: 21, slow: 9 }).success,
    ).toBe(false);
  });
});

describe("RSI mean reversion (plan/16 §3)", () => {
  it("BUYs on the re-cross up through oversold", () => {
    const verdicts = run(rsiReversion, {}, [
      context({ close: 100, indicators: { rsi14: 25 } }), // seed, oversold
      context({ close: 100, indicators: { rsi14: 32 } }), // re-cross up
    ]);
    expect(verdicts[1]?.side).toBe("BUY");
    expect(verdicts[1]?.reason).toContain("re-crossed up");
  });

  it("does not catch a falling knife: no buy while still falling (trap)", () => {
    const verdicts = run(rsiReversion, {}, [
      context({ close: 100, indicators: { rsi14: 25 } }), // seed
      context({ close: 99, indicators: { rsi14: 20 } }), // deeper oversold, no re-cross
    ]);
    expect(verdicts[1]?.side).toBe("HOLD");
  });

  it("exits a long on the cross down through overbought", () => {
    const verdicts = run(rsiReversion, {}, [
      context({ close: 100, indicators: { rsi14: 75 } }), // seed, overbought
      context({
        close: 100,
        indicators: { rsi14: 68 },
        position: longPosition,
      }),
    ]);
    expect(verdicts[1]?.side).toBe("SELL");
    expect(verdicts[1]?.reason).toContain("exit long");
  });
});

describe("ORB (plan/16 §5)", () => {
  const build: BarOpts[] = [
    { close: 100, high: 105, low: 95, minutesSinceOpen: 5 },
    { close: 100, high: 106, low: 94, minutesSinceOpen: 10 },
    { close: 100, high: 104, low: 96, minutesSinceOpen: 15 },
  ];

  it("builds the opening range then BUYs a close above it, stop at the midpoint", () => {
    const verdicts = run(
      orb,
      { allowShort: false },
      series([
        ...build,
        { close: 107, high: 108, low: 106, minutesSinceOpen: 20 },
      ]),
    );
    expect(verdicts.slice(0, 3).every((v) => v.side === "HOLD")).toBe(true);
    const buy = verdicts[3];
    expect(buy?.side).toBe("BUY");
    expect(buy?.stopLoss).toBe(100); // (106 + 94) / 2 midpoint
    expect(buy?.target).toBe(119); // close + 1× range (12)
  });

  /**
   * The defect this guards: the range used to be accumulated only from bars the
   * process witnessed live, so an engine started after 09:30 held `null` and
   * returned "no opening range" for the rest of the day — ORB silently dead
   * until tomorrow, on every mid-session restart.
   */
  it("reconstructs the same range from a cold start after the opening window", () => {
    const full = series([
      ...build,
      { close: 107, high: 108, low: 106, minutesSinceOpen: 20 },
    ]);
    const warm = run(orb, { allowShort: false }, full);
    // A restarted engine evaluates only the last bar — but sees the window.
    const cold = run(orb, { allowShort: false }, full.slice(3));
    expect(warm[3]).toEqual(cold[0]);
    expect(cold[0]?.side).toBe("BUY");
    expect(cold[0]?.stopLoss).toBe(100);
  });

  it("holds when the opening bars have scrolled out of the window", () => {
    const [late] = series([{ close: 107, minutesSinceOpen: 200 }]);
    const verdicts = run(orb, { allowShort: false }, [late as MarketContext]);
    expect(verdicts[0]?.side).toBe("HOLD");
    expect(verdicts[0]?.reason).toBe("no opening range for this session");
  });

  it("is one-shot per direction per day (trap: already entered)", () => {
    const verdicts = run(
      orb,
      { allowShort: false },
      series([
        ...build,
        { close: 107, minutesSinceOpen: 20 }, // entry
        { close: 110, minutesSinceOpen: 25 }, // would breakout again
      ]),
    );
    expect(verdicts[3]?.side).toBe("BUY");
    expect(verdicts[4]?.side).toBe("HOLD");
  });

  it("does not fire on a fake breakout that never closes beyond the range (trap)", () => {
    const verdicts = run(
      orb,
      { allowShort: false },
      series([
        ...build,
        { close: 100, high: 107, low: 99, minutesSinceOpen: 20 }, // wick over, close inside
      ]),
    );
    expect(verdicts[3]?.side).toBe("HOLD");
  });

  it("re-arms on a new session (the session anchor moves)", () => {
    const day2 = DAY1_OPEN + 86_400_000;
    const verdicts = run(
      orb,
      { allowShort: false },
      series([
        ...build,
        { close: 107, minutesSinceOpen: 20 }, // day-1 entry
        {
          close: 100,
          high: 103,
          low: 97,
          minutesSinceOpen: 5,
          sessionOpenTs: day2,
        },
        {
          close: 100,
          high: 102,
          low: 98,
          minutesSinceOpen: 15,
          sessionOpenTs: day2,
        },
        { close: 104, minutesSinceOpen: 20, sessionOpenTs: day2 },
      ]),
    );
    expect(verdicts[3]?.side).toBe("BUY"); // day-1 entry
    expect(verdicts[6]?.side).toBe("BUY"); // re-armed on day 2
  });

  it("respects the volume gate when configured", () => {
    const params = { allowShort: false, volumeMultiple: 2, avgVolPeriod: 20 };
    const verdicts = run(
      orb,
      params,
      series([
        ...build,
        {
          close: 107,
          minutesSinceOpen: 20,
          volume: 80,
          indicators: { avgvol20: 50 }, // 80 < 2×50 → blocked
        },
        {
          close: 108,
          minutesSinceOpen: 25,
          volume: 120,
          indicators: { avgvol20: 50 }, // 120 ≥ 100 → fires
        },
      ]),
    );
    expect(verdicts[3]?.side).toBe("HOLD");
    expect(verdicts[4]?.side).toBe("BUY");
  });

  it("declares avgVolume required only when the volume gate is on", () => {
    expect(orb.requiredIndicators(orb.paramsSchema.parse({}))).toEqual([]);
    expect(
      orb.requiredIndicators(
        orb.paramsSchema.parse({ volumeMultiple: 2, avgVolPeriod: 20 }),
      ),
    ).toEqual([{ kind: "avgVolume", period: 20 }]);
  });
});

describe("the built-in registry (plan/15 §4, plan/28 §3)", () => {
  it("registers the three Phase-1 strategies", () => {
    const registry = createStrategyRegistry();
    expect(registry.has("EMA_CROSSOVER")).toBe(true);
    expect(registry.has("RSI")).toBe(true);
    expect(registry.has("ORB")).toBe(true);
  });
});

describe("Index Option Momentum (index in, contract out)", () => {
  const P = { underlying: "NIFTY", emaPeriod: 5, breakoutBars: 3 };

  /** A bar series where `closes` drives high/low too, so breakouts are exact. */
  function bars(closes: readonly number[], mso: number): BarOpts[] {
    return closes.map((close, i) => ({
      close,
      high: close,
      low: close,
      // Every bar inside the entry window; only the last one can trigger.
      minutesSinceOpen: mso - (closes.length - 1 - i) * 5,
      indicators: { ema5: 100, vwap: 100 },
    }));
  }

  it("declares the option contract it wants, resolved later by the runner", () => {
    const params = indexOptionMomentum.paramsSchema.parse(P);
    expect(indexOptionMomentum.derivative?.(params)).toEqual({
      underlying: "NIFTY",
      kind: "OPTION",
      strikeOffset: 0,
    });
  });

  it("declares the trend indicators it needs", () => {
    const params = indexOptionMomentum.paramsSchema.parse(P);
    expect(indexOptionMomentum.requiredIndicators(params)).toEqual([
      { kind: "ema", period: 5 },
      { kind: "vwap" },
    ]);
  });

  it("BUYs a call on a breakout above VWAP and EMA", () => {
    const verdicts = run(
      indexOptionMomentum,
      P,
      series(bars([101, 102, 103, 110], 60)),
    );
    const buy = verdicts[3];
    expect(buy?.side).toBe("BUY");
    // Percentage stops — the premium is unknown until the contract resolves.
    expect(buy?.stopLossPct).toBe(0.3);
    expect(buy?.targetPct).toBe(0.6);
    expect(buy?.stopLoss).toBeUndefined();
  });

  it("BUYs a put on a breakdown below VWAP and EMA", () => {
    const verdicts = run(
      indexOptionMomentum,
      P,
      series(bars([99, 98, 97, 90], 60)),
    );
    expect(verdicts[3]?.side).toBe("SELL"); // SELL = buy a PUT, never a short
  });

  /** Direction without movement is a losing trade for an option buyer. */
  it("holds when price is above trend but makes no new high", () => {
    const verdicts = run(
      indexOptionMomentum,
      P,
      series(bars([110, 109, 108, 107], 60)),
    );
    expect(verdicts[3]?.side).toBe("HOLD");
  });

  it("holds a breakout that disagrees with VWAP and EMA", () => {
    const rising = bars([101, 102, 103, 110], 60).map((b) => ({
      ...b,
      indicators: { ema5: 200, vwap: 200 }, // price below both
    }));
    expect(run(indexOptionMomentum, P, series(rising))[3]?.side).toBe("HOLD");
  });

  it("is one entry per direction per day", () => {
    const verdicts = run(
      indexOptionMomentum,
      P,
      series(bars([101, 102, 103, 110, 120], 65)),
    );
    expect(verdicts[3]?.side).toBe("BUY");
    expect(verdicts[4]?.side).toBe("HOLD"); // would break out again
  });

  it("refuses to enter inside the opening window", () => {
    const verdicts = run(
      indexOptionMomentum,
      { ...P, skipOpenMinutes: 20 },
      series(bars([101, 102, 103, 110], 15)),
    );
    expect(verdicts[3]?.reason).toBe("inside the opening window");
  });

  /** Decay accelerates into the close, and square-off is coming anyway. */
  it("refuses to enter after the last entry time", () => {
    const verdicts = run(
      indexOptionMomentum,
      { ...P, lastEntryMinutes: 300 },
      series(bars([101, 102, 103, 110], 320)),
    );
    expect(verdicts[3]?.reason).toBe("past the last entry time");
  });

  it("re-arms on a new session", () => {
    const day2 = DAY1_OPEN + 86_400_000;
    const verdicts = run(
      indexOptionMomentum,
      P,
      series([
        ...bars([101, 102, 103, 110], 60),
        ...bars([101, 102, 103, 110], 60).map((b) => ({
          ...b,
          sessionOpenTs: day2,
        })),
      ]),
    );
    expect(verdicts[3]?.side).toBe("BUY");
    expect(verdicts[7]?.side).toBe("BUY");
  });
});

describe("Index Option Momentum — spot index has no volume", () => {
  const bars = (closes: readonly number[]): BarOpts[] =>
    closes.map((close, i) => ({
      close,
      high: close,
      low: close,
      minutesSinceOpen: 60 - (closes.length - 1 - i) * 5,
      indicators: { ema5: 100 }, // no vwap: an index feed prints no volume
    }));

  /**
   * VWAP is only ready once real volume prints. Requiring it on a spot index
   * means the runner's readiness gate never opens and the strategy never runs
   * — indistinguishable from "no setup today".
   */
  it("does not require vwap when useVwap is false", () => {
    const params = indexOptionMomentum.paramsSchema.parse({
      emaPeriod: 5,
      useVwap: false,
    });
    expect(indexOptionMomentum.requiredIndicators(params)).toEqual([
      { kind: "ema", period: 5 },
    ]);
  });

  it("still fires on the EMA alone when vwap is off", () => {
    const verdicts = run(
      indexOptionMomentum,
      { emaPeriod: 5, breakoutBars: 3, useVwap: false },
      series(bars([101, 102, 103, 110])),
    );
    expect(verdicts[3]?.side).toBe("BUY");
  });

  it("holds instead of firing blind when vwap is required but absent", () => {
    const verdicts = run(
      indexOptionMomentum,
      { emaPeriod: 5, breakoutBars: 3, useVwap: true },
      series(bars([101, 102, 103, 110])),
    );
    expect(verdicts[3]?.reason).toBe("trend indicators not ready");
  });
});
