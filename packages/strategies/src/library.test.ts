import { describe, expect, it } from "vitest";
import type {
  Candle,
  CandleInterval,
  MarketContext,
  OptionChainSnapshot,
  Position,
  StrategyVerdict,
} from "@neelkanth/core";
import type { StrategyDefinition } from "./contract.js";
import { emaCrossover } from "./ema-crossover.js";
import { rsiReversion } from "./rsi-reversion.js";
import { orb } from "./orb.js";
import { indexOptionMomentum } from "./index-option-momentum.js";
import { indexOptionFlowBreakout } from "./index-option-flow.js";
import { indexOptionSentimentFade } from "./index-option-sentiment-fade.js";
import { indexOptionPcrOi } from "./index-option-pcr-oi.js";
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
  sentiment?: number;
  optionChain?: OptionChainSnapshot;
}

function context(opts: BarOpts): MarketContext {
  const interval = opts.interval ?? "5m";
  const sessionOpenTs = opts.sessionOpenTs ?? DAY1_OPEN;
  const minutesSinceOpen = opts.minutesSinceOpen ?? 30;
  const candle: Candle = {
    symbol: SYM,
    interval,
    source: "LIVE_TICK",
    open: opts.close,
    high: opts.high ?? opts.close,
    low: opts.low ?? opts.close,
    close: opts.close,
    volume: opts.volume ?? 1,
    // `minutesSinceOpen` is when the bar CLOSED; a bucket is labelled by its
    // start, so back off one interval.
    ts:
      sessionOpenTs + (minutesSinceOpen - INTERVAL_MINUTES[interval]) * 60_000,
  };
  return {
    symbol: SYM,
    interval,
    candle,
    candles: opts.candles ?? [candle],
    indicators: opts.indicators ?? {},
    session: { phase: "open", minutesSinceOpen, sessionOpenTs },
    position: opts.position ?? null,
    sentiment: opts.sentiment ?? 0,
    ...(opts.optionChain === undefined
      ? {}
      : { optionChain: opts.optionChain }),
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
    // An explicit exit (Phase 3 D1): the trade records STRATEGY_EXIT, and the
    // runner closes the whole position instead of netting an opposite side.
    expect(verdicts[1]?.exit).toBe(true);
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
    expect(verdicts[1]?.exit).toBe(true); // Phase 3 D1
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

  describe("the entry window", () => {
    // The breakout bar must CLOSE from 45 up to, not including, 135 minutes
    // after the open: 10:00 to 11:30 on a 09:15 session.
    const windowed = {
      allowShort: false,
      entryFromMinute: 45,
      entryUntilMinute: 135,
    };

    it("takes a first breakout that closes inside the window, at either edge", () => {
      for (const minutesSinceOpen of [45, 130]) {
        const verdicts = run(
          orb,
          windowed,
          series([
            ...build,
            { close: 100, minutesSinceOpen: 20 }, // inside the range
            { close: 107, minutesSinceOpen },
          ]),
        );
        expect(verdicts[4]?.side).toBe("BUY");
        expect(verdicts[4]?.stopLoss).toBe(100);
        expect(verdicts[4]?.target).toBe(119);
      }
    });

    it("lets a breakout before the window go, and does not chase it later", () => {
      const verdicts = run(
        orb,
        windowed,
        series([
          ...build,
          { close: 107, minutesSinceOpen: 40 }, // five minutes early
          { close: 109, minutesSinceOpen: 45 }, // still above, now inside
          { close: 111, minutesSinceOpen: 60 },
        ]),
      );
      expect(verdicts[3]).toMatchObject({
        side: "HOLD",
        reason: "breakout outside the entry window",
      });
      // The day's breakout already happened; a later bar is not a fresh one.
      expect(verdicts[4]?.side).toBe("HOLD");
      expect(verdicts[5]?.side).toBe("HOLD");
    });

    it("lets a breakout at or after the window's end go", () => {
      const verdicts = run(
        orb,
        windowed,
        series([...build, { close: 107, minutesSinceOpen: 135 }]),
      );
      expect(verdicts[3]).toMatchObject({
        side: "HOLD",
        reason: "breakout outside the entry window",
      });
    });

    it("spends one direction only: a late upside breakout leaves the downside armed", () => {
      const verdicts = run(
        orb,
        { ...windowed, allowShort: true },
        series([
          ...build,
          { close: 107, minutesSinceOpen: 20 }, // up, too early: let go
          { close: 93, minutesSinceOpen: 60 }, // down, inside the window
        ]),
      );
      expect(verdicts[3]?.side).toBe("HOLD");
      expect(verdicts[4]?.side).toBe("SELL");
    });

    it("reads the time from the bar, not from how long the engine has been up", () => {
      // A restarted engine may report any minutesSinceOpen; the bar's own
      // timestamp against the session anchor is what places it in the window.
      const contexts = series([...build, { close: 107, minutesSinceOpen: 60 }]);
      const last = contexts[3] as MarketContext;
      const lying = {
        ...last,
        session: { ...last.session, minutesSinceOpen: 300 },
      };
      const verdicts = run(orb, windowed, [...contexts.slice(0, 3), lying]);
      expect(verdicts[3]?.side).toBe("BUY");
    });

    it("re-arms the next session after letting a breakout go", () => {
      const day2 = DAY1_OPEN + 86_400_000;
      const verdicts = run(
        orb,
        windowed,
        series([
          ...build,
          { close: 107, minutesSinceOpen: 20 }, // day 1: too early
          {
            close: 100,
            high: 103,
            low: 97,
            minutesSinceOpen: 15,
            sessionOpenTs: day2,
          },
          { close: 104, minutesSinceOpen: 60, sessionOpenTs: day2 },
        ]),
      );
      expect(verdicts[3]?.side).toBe("HOLD");
      expect(verdicts[5]?.side).toBe("BUY");
    });

    it("refuses a window that ends at or before it starts", () => {
      expect(() =>
        orb.paramsSchema.parse({ entryFromMinute: 135, entryUntilMinute: 45 }),
      ).toThrow(/entryUntilMinute/);
      expect(() =>
        orb.paramsSchema.parse({ entryFromMinute: 45, entryUntilMinute: 45 }),
      ).toThrow(/entryUntilMinute/);
    });
  });

  describe("the trend filter", () => {
    const trending = { trendEmaPeriod: 21 };

    it("takes a long above the trend line and a short below it", () => {
      const long = run(
        orb,
        trending,
        series([
          ...build,
          { close: 107, minutesSinceOpen: 20, indicators: { ema21: 103 } },
        ]),
      );
      expect(long[3]?.side).toBe("BUY");
      const short = run(
        orb,
        trending,
        series([
          ...build,
          { close: 93, minutesSinceOpen: 20, indicators: { ema21: 97 } },
        ]),
      );
      expect(short[3]?.side).toBe("SELL");
    });

    it("lets a breakout against the trend go, and does not take it when the trend turns", () => {
      const verdicts = run(
        orb,
        trending,
        series([
          ...build,
          // Above the range but below the trend line: against the trend.
          { close: 107, minutesSinceOpen: 20, indicators: { ema21: 110 } },
          { close: 112, minutesSinceOpen: 25, indicators: { ema21: 110 } },
        ]),
      );
      expect(verdicts[3]).toMatchObject({
        side: "HOLD",
        reason: "breakout against the trend",
      });
      expect(verdicts[4]?.side).toBe("HOLD");
    });

    it("treats a close exactly on the trend line as no trend", () => {
      const verdicts = run(
        orb,
        trending,
        series([
          ...build,
          { close: 107, minutesSinceOpen: 20, indicators: { ema21: 107 } },
        ]),
      );
      expect(verdicts[3]?.reason).toBe("breakout against the trend");
    });

    it("waits, without spending the day's entry, while the trend line is not ready", () => {
      const verdicts = run(
        orb,
        trending,
        series([
          ...build,
          { close: 107, minutesSinceOpen: 20 }, // no ema21 yet
          { close: 108, minutesSinceOpen: 25, indicators: { ema21: 103 } },
        ]),
      );
      expect(verdicts[3]).toMatchObject({
        side: "HOLD",
        reason: "trend not ready",
      });
      expect(verdicts[4]?.side).toBe("BUY");
    });

    it("declares the trend EMA and its warm-up only when the filter is on", () => {
      const on = orb.paramsSchema.parse(trending);
      expect(orb.requiredIndicators(on)).toEqual([{ kind: "ema", period: 21 }]);
      expect(orb.warmupBars(on)).toBe(21);
      const both = orb.paramsSchema.parse({ ...trending, volumeMultiple: 2 });
      expect(orb.requiredIndicators(both)).toEqual([
        { kind: "avgVolume", period: 20 },
        { kind: "ema", period: 21 },
      ]);
      expect(orb.warmupBars(both)).toBe(21);
      expect(orb.warmupBars(orb.paramsSchema.parse({}))).toBe(0);
    });
  });

  it("survives a restart knowing which breakout it let go", () => {
    const params = orb.paramsSchema.parse({
      allowShort: false,
      entryFromMinute: 45,
      entryUntilMinute: 135,
    });
    const contexts = series([
      ...build,
      { close: 107, minutesSinceOpen: 20 }, // too early: let go
      { close: 109, minutesSinceOpen: 60 },
    ]);
    const before = orb.init(params, SYM);
    for (const c of contexts.slice(0, 4)) orb.analyze(c, before);
    const after = orb.init(params, SYM);
    orb.restore?.(after, JSON.parse(JSON.stringify(orb.snapshot?.(before))));
    expect(orb.analyze(contexts[4] as MarketContext, after).side).toBe("HOLD");
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
  it("registers the built-in strategy catalog used by the dashboard selector", () => {
    const registry = createStrategyRegistry();
    expect(registry.has("EMA_CROSSOVER")).toBe(true);
    expect(registry.has("RSI")).toBe(true);
    expect(registry.has("ORB")).toBe(true);
    expect(registry.has("INDEX_OPTION_MOMENTUM")).toBe(true);
    expect(registry.has("INDEX_OPTION_FLOW_BREAKOUT")).toBe(true);
    expect(registry.has("INDEX_OPTION_SENTIMENT_FADE")).toBe(true);
    expect(registry.has("INDEX_OPTION_PCR_OI")).toBe(true);
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

describe("Index Option Flow Breakout", () => {
  const base = {
    underlying: "NIFTY",
    emaPeriod: 5,
    rsiPeriod: 14,
    breakoutBars: 3,
    volumeMultiple: 1.2,
    sentimentThreshold: 0.2,
    skipOpenMinutes: 20,
    lastEntryMinutes: 300,
  };

  it("buys a call when breakout, volume expansion, trend, and sentiment align", () => {
    const verdicts = run(
      indexOptionFlowBreakout,
      base,
      series([
        {
          close: 101,
          high: 102,
          low: 99,
          volume: 100,
          minutesSinceOpen: 30,
          indicators: { ema5: 100, rsi14: 52, vwap: 100 },
          sentiment: 0.3,
        },
        {
          close: 103,
          high: 104,
          low: 100,
          volume: 170,
          minutesSinceOpen: 35,
          indicators: { ema5: 100, rsi14: 62, vwap: 101 },
          sentiment: 0.35,
        },
        {
          close: 104,
          high: 105,
          low: 101,
          volume: 175,
          minutesSinceOpen: 40,
          indicators: { ema5: 101, rsi14: 63, vwap: 102 },
          sentiment: 0.4,
        },
        {
          close: 107,
          high: 109,
          low: 103,
          volume: 190,
          minutesSinceOpen: 45,
          indicators: { ema5: 103, rsi14: 68, vwap: 103 },
          sentiment: 0.45,
        },
      ]),
    );

    expect(verdicts[3]?.side).toBe("BUY");
    expect(verdicts[3]?.reason).toContain("flow breakout");
  });
});

describe("Index Option Sentiment Fade", () => {
  const base = {
    underlying: "NIFTY",
    emaPeriod: 5,
    rsiPeriod: 14,
    swingLookback: 10,
    oversold: 30,
    overbought: 70,
    sentimentThreshold: 0.35,
    skipOpenMinutes: 20,
    lastEntryMinutes: 300,
  };

  it("fades bearish extremes with a bullish reversal when RSI and sentiment are stretched", () => {
    const verdicts = run(
      indexOptionSentimentFade,
      base,
      series([
        {
          close: 103,
          high: 104,
          low: 101,
          volume: 50,
          minutesSinceOpen: 30,
          indicators: { ema5: 106, rsi14: 20 },
          sentiment: -0.45,
        },
        {
          close: 101,
          high: 102,
          low: 99,
          volume: 55,
          minutesSinceOpen: 35,
          indicators: { ema5: 105, rsi14: 28 },
          sentiment: -0.5,
        },
        {
          close: 100,
          high: 101,
          low: 98,
          volume: 60,
          minutesSinceOpen: 40,
          indicators: { ema5: 104, rsi14: 35 },
          sentiment: -0.6,
        },
        {
          close: 102,
          high: 103,
          low: 100,
          volume: 62,
          minutesSinceOpen: 45,
          indicators: { ema5: 103, rsi14: 42 },
          sentiment: -0.4,
        },
      ]),
    );

    expect(verdicts[2]?.side).toBe("BUY");
    expect(verdicts[2]?.reason).toContain("fade");
  });
});

describe("Index Option PCR/OI hybrid", () => {
  const chain = (asOf = DAY1_OPEN + 40 * 60_000): OptionChainSnapshot => ({
    underlying: "NIFTY",
    expiry: DAY1_OPEN + 86_400_000,
    asOf,
    spot: 100,
    rows: [
      {
        strike: 100,
        callOI: 100,
        putOI: 130,
        callChangeOI: 2,
        putChangeOI: 20,
      },
      {
        strike: 105,
        callOI: 100,
        putOI: 120,
        callChangeOI: 1,
        putChangeOI: 15,
      },
    ],
  });

  it("buys a call when price, PCR, and put OI buildup align", () => {
    const verdicts = run(
      indexOptionPcrOi,
      { underlying: "NIFTY", emaPeriod: 5, minOiChangePct: 0.05 },
      series([
        {
          close: 101,
          minutesSinceOpen: 45,
          indicators: { ema5: 100 },
          optionChain: chain(),
        },
      ]),
    );
    expect(verdicts[0]?.side).toBe("BUY");
    expect(verdicts[0]?.reason).toContain("put OI buildup");
  });

  it("buys a put when price, low PCR, and call OI buildup align", () => {
    const bearishChain: OptionChainSnapshot = {
      ...chain(),
      rows: [
        {
          strike: 100,
          callOI: 150,
          putOI: 80,
          callChangeOI: 20,
          putChangeOI: 2,
        },
        {
          strike: 105,
          callOI: 150,
          putOI: 70,
          callChangeOI: 18,
          putChangeOI: 1,
        },
      ],
    };
    const verdicts = run(
      indexOptionPcrOi,
      { underlying: "NIFTY", emaPeriod: 5, minOiChangePct: 0.05 },
      series([
        {
          close: 99,
          minutesSinceOpen: 45,
          indicators: { ema5: 100 },
          optionChain: bearishChain,
        },
      ]),
    );
    expect(verdicts[0]?.side).toBe("SELL");
  });

  it("holds without a current chain instead of trading index direction alone", () => {
    const verdict = run(
      indexOptionPcrOi,
      { underlying: "NIFTY", emaPeriod: 5 },
      series([{ close: 101, minutesSinceOpen: 45, indicators: { ema5: 100 } }]),
    )[0];
    expect(verdict?.side).toBe("HOLD");
    expect(verdict?.reason).toBe("option chain not available");
  });

  it("holds stale chain data", () => {
    const verdict = run(
      indexOptionPcrOi,
      { underlying: "NIFTY", emaPeriod: 5, maxChainAgeMinutes: 5 },
      series([
        {
          close: 101,
          minutesSinceOpen: 45,
          indicators: { ema5: 100 },
          optionChain: chain(DAY1_OPEN),
        },
      ]),
    )[0];
    expect(verdict?.side).toBe("HOLD");
    expect(verdict?.reason).toBe("option chain is stale");
  });
});
