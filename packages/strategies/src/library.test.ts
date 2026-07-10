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
import { createStrategyRegistry } from "./index.js";

const SYM = "NSE:X-EQ";

function context(opts: {
  close: number;
  high?: number;
  low?: number;
  volume?: number;
  indicators?: Record<string, number>;
  minutesSinceOpen?: number;
  candles?: Candle[];
  position?: Position | null;
  interval?: CandleInterval;
}): MarketContext {
  const interval = opts.interval ?? "5m";
  const candle: Candle = {
    symbol: SYM,
    interval,
    open: opts.close,
    high: opts.high ?? opts.close,
    low: opts.low ?? opts.close,
    close: opts.close,
    volume: opts.volume ?? 1,
    ts: 0,
  };
  return {
    symbol: SYM,
    interval,
    candle,
    candles: opts.candles ?? [candle],
    indicators: opts.indicators ?? {},
    session: { phase: "open", minutesSinceOpen: opts.minutesSinceOpen ?? 30 },
    position: opts.position ?? null,
    sentiment: 0,
  };
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
  const build = [
    context({ close: 100, high: 105, low: 95, minutesSinceOpen: 5 }),
    context({ close: 100, high: 106, low: 94, minutesSinceOpen: 10 }),
    context({ close: 100, high: 104, low: 96, minutesSinceOpen: 15 }),
  ];

  it("builds the opening range then BUYs a close above it, stop at the midpoint", () => {
    const verdicts = run(orb, { allowShort: false }, [
      ...build,
      context({ close: 107, high: 108, low: 106, minutesSinceOpen: 20 }),
    ]);
    expect(verdicts.slice(0, 3).every((v) => v.side === "HOLD")).toBe(true);
    const buy = verdicts[3];
    expect(buy?.side).toBe("BUY");
    expect(buy?.stopLoss).toBe(100); // (106 + 94) / 2 midpoint
    expect(buy?.target).toBe(119); // close + 1× range (12)
  });

  it("is one-shot per direction per day (trap: already entered)", () => {
    const verdicts = run(orb, { allowShort: false }, [
      ...build,
      context({ close: 107, minutesSinceOpen: 20 }), // entry
      context({ close: 110, minutesSinceOpen: 25 }), // would breakout again
    ]);
    expect(verdicts[3]?.side).toBe("BUY");
    expect(verdicts[4]?.side).toBe("HOLD");
  });

  it("does not fire on a fake breakout that never closes beyond the range (trap)", () => {
    const verdicts = run(orb, { allowShort: false }, [
      ...build,
      context({ close: 100, high: 107, low: 99, minutesSinceOpen: 20 }), // wick over, close inside
    ]);
    expect(verdicts[3]?.side).toBe("HOLD");
  });

  it("re-arms on a new session (minutesSinceOpen drops)", () => {
    const verdicts = run(orb, { allowShort: false }, [
      ...build,
      context({ close: 107, minutesSinceOpen: 20 }), // day-1 entry
      // day 2:
      context({ close: 100, high: 103, low: 97, minutesSinceOpen: 5 }),
      context({ close: 100, high: 102, low: 98, minutesSinceOpen: 15 }),
      context({ close: 104, minutesSinceOpen: 20 }), // day-2 breakout
    ]);
    expect(verdicts[3]?.side).toBe("BUY"); // day-1 entry
    expect(verdicts[6]?.side).toBe("BUY"); // re-armed on day 2
  });

  it("respects the volume gate when configured", () => {
    const params = { allowShort: false, volumeMultiple: 2, avgVolPeriod: 20 };
    const verdicts = run(orb, params, [
      ...build,
      context({
        close: 107,
        minutesSinceOpen: 20,
        volume: 80,
        indicators: { avgvol20: 50 }, // 80 < 2×50 → blocked
      }),
      context({
        close: 108,
        minutesSinceOpen: 25,
        volume: 120,
        indicators: { avgvol20: 50 }, // 120 ≥ 100 → fires
      }),
    ]);
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
