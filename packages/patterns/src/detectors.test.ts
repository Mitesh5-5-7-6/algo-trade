import { describe, expect, it } from "vitest";
import type { Candle } from "@neelkanth/core";
import type { PatternContext } from "./contract.js";
import {
  BUILTIN_DETECTORS,
  createPatternRegistry,
  emaCross,
  orbBreakout,
  rsiReversion,
  highVolumeBreakout,
  vwapReclaim,
} from "./index.js";

/**
 * Each detector is checked on a hand-constructed sequence where the answer is
 * obvious by inspection, plus the near-miss that must NOT fire.
 *
 * The near-miss cases carry the weight. A detector that fires on everything
 * has a perfect recall and no information, and the matrix would fill with
 * structures that are really just "the market moved".
 */

const SYM = "NSE:X-EQ";
const OPEN_TS = 1_760_000_000_000;
const BAR_MS = 300_000;

const bar = (index: number, fields: Partial<Candle> = {}): Candle => ({
  symbol: SYM,
  interval: "5m",
  source: "LIVE_TICK",
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1_000,
  ts: OPEN_TS + index * BAR_MS,
  ...fields,
});

function context(
  candles: readonly Candle[],
  opts: {
    indicators?: Record<string, number>;
    previousIndicators?: Record<string, number>;
  } = {},
): PatternContext {
  const candle = candles.at(-1);
  if (candle === undefined) throw new Error("a context needs at least one bar");
  return {
    symbol: SYM,
    interval: "5m",
    candle,
    candles,
    indicators: opts.indicators ?? {},
    previousIndicators: opts.previousIndicators ?? {},
    minutesSinceOpen: (candle.ts - OPEN_TS) / 60_000 + 5,
    sessionOpenTs: OPEN_TS,
  };
}

describe("ORB_BREAKOUT", () => {
  // Bars 0–2 are the 15-minute opening range: high 105, low 95.
  const range = [
    bar(0, { high: 104, low: 96 }),
    bar(1, { high: 105, low: 95 }),
    bar(2, { high: 103, low: 97 }),
  ];

  it("fires when a later bar closes above the range high", () => {
    const result = orbBreakout.detect(
      context([...range, bar(3, { close: 106, high: 107 })]),
      orbBreakout.paramsSchema.parse({}),
    );
    expect(result?.direction).toBe("BULLISH");
    expect(result?.evidence["rangeHigh"]).toBe(105);
  });

  it("fires bearish below the range low", () => {
    const result = orbBreakout.detect(
      context([...range, bar(3, { close: 94, low: 93 })]),
      orbBreakout.paramsSchema.parse({}),
    );
    expect(result?.direction).toBe("BEARISH");
  });

  /**
   * The distinction that makes this a pattern rather than a noise generator:
   * an intrabar spike that is rejected before the bell is not a breakout, and
   * no strategy acting at bar close could have traded it.
   */
  it("does not fire when price only pierces the range intrabar", () => {
    const result = orbBreakout.detect(
      context([...range, bar(3, { high: 110, close: 101 })]),
      orbBreakout.paramsSchema.parse({}),
    );
    expect(result).toBeNull();
  });

  /**
   * The break is the event, not every bar after it (design D8). Price that
   * stays above the range for an hour is one breakout, not twelve — a state
   * counted per bar would inflate exactly the sample Phase 6 divides by.
   */
  it("fires on the break, not again on each bar that stays outside", () => {
    const params = orbBreakout.paramsSchema.parse({});
    const after = [...range, bar(3, { close: 106 }), bar(4, { close: 107 })];
    expect(
      orbBreakout.detect(context(after.slice(0, 4)), params)?.direction,
    ).toBe("BULLISH");
    expect(orbBreakout.detect(context(after), params)).toBeNull();
  });

  it("fires again when price returns inside the range and breaks out again", () => {
    const params = orbBreakout.paramsSchema.parse({});
    const bars = [
      ...range,
      bar(3, { close: 106 }),
      bar(4, { close: 101 }),
      bar(5, { close: 106 }),
    ];
    const result = orbBreakout.detect(context(bars), params);
    expect(result?.direction).toBe("BULLISH");
    expect(result?.evidence["prevClose"]).toBe(101);
  });

  it("fires bearish on a close straight through from above the range to below it", () => {
    const params = orbBreakout.paramsSchema.parse({});
    const bars = [
      ...range,
      bar(3, { close: 106 }),
      bar(4, { close: 94, low: 93 }),
    ];
    expect(orbBreakout.detect(context(bars), params)?.direction).toBe(
      "BEARISH",
    );
  });

  it("does not fire on a bar still inside the range window", () => {
    const result = orbBreakout.detect(
      context([...range.slice(0, 2)]),
      orbBreakout.paramsSchema.parse({}),
    );
    expect(result).toBeNull();
  });
});

describe("EMA_CROSS", () => {
  const params = emaCross.paramsSchema.parse({});

  it("fires when fast crosses above slow", () => {
    const result = emaCross.detect(
      context([bar(0), bar(1)], {
        indicators: { ema9: 101, ema21: 100 },
        previousIndicators: { ema9: 99, ema21: 100 },
      }),
      params,
    );
    expect(result?.direction).toBe("BULLISH");
  });

  /**
   * A cross is an EVENT — the relationship inverted. "Fast is above slow" is a
   * state, and treating it as a detection would mark every bar of a trend as a
   * fresh pattern, inflating the sample with one continuous move.
   */
  it("does not fire while fast merely stays above slow", () => {
    const result = emaCross.detect(
      context([bar(0), bar(1)], {
        indicators: { ema9: 103, ema21: 100 },
        previousIndicators: { ema9: 102, ema21: 100 },
      }),
      params,
    );
    expect(result).toBeNull();
  });

  it("returns null until the previous bar's values are available", () => {
    const result = emaCross.detect(
      context([bar(0)], { indicators: { ema9: 101, ema21: 100 } }),
      params,
    );
    expect(result).toBeNull();
  });
});

describe("RSI_REVERSION", () => {
  const params = rsiReversion.paramsSchema.parse({});

  it("fires on the re-cross up out of oversold", () => {
    const result = rsiReversion.detect(
      context([bar(0), bar(1)], {
        indicators: { rsi14: 34 },
        previousIndicators: { rsi14: 28 },
      }),
      params,
    );
    expect(result?.direction).toBe("BULLISH");
  });

  /** RSI at 22 and still falling is a knife, not a reversion. */
  it("does not fire while RSI is still falling inside oversold", () => {
    const result = rsiReversion.detect(
      context([bar(0), bar(1)], {
        indicators: { rsi14: 22 },
        previousIndicators: { rsi14: 28 },
      }),
      params,
    );
    expect(result).toBeNull();
  });

  it("fires bearish on the re-cross down out of overbought", () => {
    const result = rsiReversion.detect(
      context([bar(0), bar(1)], {
        indicators: { rsi14: 66 },
        previousIndicators: { rsi14: 74 },
      }),
      params,
    );
    expect(result?.direction).toBe("BEARISH");
  });
});

describe("VWAP_RECLAIM", () => {
  const params = vwapReclaim.paramsSchema.parse({});

  it("fires when the close crosses back above VWAP by more than the buffer", () => {
    const result = vwapReclaim.detect(
      context([bar(0, { close: 99 }), bar(1, { close: 101 })], {
        indicators: { vwap: 100 },
        previousIndicators: { vwap: 100 },
      }),
      params,
    );
    expect(result?.direction).toBe("BULLISH");
  });

  /**
   * Without the buffer this fires repeatedly while price oscillates around the
   * line. A pattern that fires ten times in a chop is not a pattern; it is a
   * way of inflating a sample size.
   */
  it("does not fire on a close sitting essentially on VWAP", () => {
    const result = vwapReclaim.detect(
      context([bar(0, { close: 99.99 }), bar(1, { close: 100.01 })], {
        indicators: { vwap: 100 },
        previousIndicators: { vwap: 100 },
      }),
      params,
    );
    expect(result).toBeNull();
  });
});

describe("HIGH_VOLUME_BREAKOUT", () => {
  const params = highVolumeBreakout.paramsSchema.parse({ lookback: 3 });
  const base = [
    bar(0, { high: 102, low: 98, volume: 1_000 }),
    bar(1, { high: 103, low: 97, volume: 1_000 }),
    bar(2, { high: 101, low: 99, volume: 1_000 }),
  ];

  it("fires on a break confirmed by volume", () => {
    const result = highVolumeBreakout.detect(
      context([...base, bar(3, { close: 104, volume: 2_000 })]),
      params,
    );
    expect(result?.direction).toBe("BULLISH");
    expect(result?.evidence["priorHigh"]).toBe(103);
  });

  /** The volume half is the entire reason this is its own pattern. */
  it("does not fire on the same break with ordinary volume", () => {
    const result = highVolumeBreakout.detect(
      context([...base, bar(3, { close: 104, volume: 1_000 })]),
      params,
    );
    expect(result).toBeNull();
  });

  /**
   * An index reports no meaningful volume. Declining is the safe direction —
   * but "no volume breakouts occurred" must not then be read as a market fact.
   */
  it("declines rather than guesses when there is no volume at all", () => {
    const flat = base.map((b) => ({ ...b, volume: 0 }));
    const result = highVolumeBreakout.detect(
      context([...flat, bar(3, { close: 104, volume: 0 })]),
      params,
    );
    expect(result).toBeNull();
  });
});

/**
 * D3 / ADR §20.6: where reliable volume is unavailable, volume-based
 * conclusions are not drawn. Every bar of the stored NIFTY and BANKNIFTY year
 * is SUSPECT — nobody has confirmed what an index's aggregate volume means —
 * so this is not an edge case: it decides what two detectors can say at all.
 *
 * Enforced by the registry, from the bars each detector declares its answer
 * rests on, so no caller going through the registry can skip it.
 */
describe("volume quality (D3, ADR §20.6)", () => {
  const registry = createPatternRegistry();
  const suspect = { volumeAvailable: true, volumeQuality: "SUSPECT" } as const;
  const breakout = (over: Partial<Candle>[] = []) =>
    [
      bar(0, { high: 102, low: 98 }),
      bar(1, { high: 103, low: 97 }),
      bar(2, { high: 101, low: 99 }),
      bar(3, { close: 104, volume: 2_000 }),
    ].map((b, i) => ({ ...b, ...(over[i] ?? {}) }));
  const hvb = registry.instantiate("HIGH_VOLUME_BREAKOUT", { lookback: 3 });

  it("is named HIGH_VOLUME_BREAKOUT, the spec's name (D2)", () => {
    expect(registry.has("HIGH_VOLUME_BREAKOUT")).toBe(true);
    expect(registry.has("VOLUME_BREAKOUT")).toBe(false);
  });

  it("finds a volume breakout on trusted volume", () => {
    expect(hvb.volumeTrusted(context(breakout()))).toBe(true);
    expect(hvb.detect(context(breakout()))?.direction).toBe("BULLISH");
  });

  it("declines when the bar judged has untrustworthy volume", () => {
    const bars = breakout([{}, {}, {}, suspect]);
    expect(hvb.volumeTrusted(context(bars))).toBe(false);
    expect(hvb.detect(context(bars))).toBeNull();
  });

  it("declines when a bar in its average has untrustworthy volume", () => {
    expect(
      hvb.detect(context(breakout([{}, { volumeAvailable: false }]))),
    ).toBeNull();
  });

  /** Only the bars the answer rests on: an older bar outside the lookback does not matter. */
  it("ignores bars outside its own window", () => {
    const older = { ...bar(-1, suspect), ts: OPEN_TS - BAR_MS };
    expect(hvb.detect(context([older, ...breakout()]))?.direction).toBe(
      "BULLISH",
    );
  });

  /**
   * VWAP is volume-weighted over the session so far, so a VWAP reclaim is a
   * volume-based conclusion too — and one untrusted bar since the open taints
   * every VWAP after it.
   */
  const vwap = registry.instantiate("VWAP_RECLAIM");
  const reclaim = (first: Partial<Candle> = {}) =>
    context([bar(0, { close: 99, ...first }), bar(1, { close: 101 })], {
      indicators: { vwap: 100 },
      previousIndicators: { vwap: 100 },
    });

  it("declines a VWAP reclaim when the session's volume is untrustworthy", () => {
    expect(vwap.detect(reclaim())?.direction).toBe("BULLISH");
    expect(vwap.volumeTrusted(reclaim(suspect))).toBe(false);
    expect(vwap.detect(reclaim(suspect))).toBeNull();
  });

  it("judges VWAP on today's session only", () => {
    const yesterday = { ...bar(0, suspect), ts: OPEN_TS - 20 * BAR_MS };
    const ctx = reclaim();
    expect(
      vwap.detect({ ...ctx, candles: [yesterday, ...ctx.candles] })?.direction,
    ).toBe("BULLISH");
  });

  it("never asks a price-only detector about volume", () => {
    const bars = [
      bar(0, { high: 104, low: 96, ...suspect }),
      bar(1, { high: 105, low: 95, ...suspect }),
      bar(2, { high: 103, low: 97, ...suspect }),
      bar(3, { close: 106, ...suspect }),
    ];
    const orb = registry.instantiate("ORB_BREAKOUT");
    expect(orb.volumeBased).toBe(false);
    expect(orb.volumeTrusted(context(bars))).toBe(true);
    expect(orb.detect(context(bars))?.direction).toBe("BULLISH");
  });

  it("marks exactly the two volume-weighted detectors as volume-based", () => {
    const based = registry
      .ids()
      .filter((id) => registry.instantiate(id).volumeBased);
    expect(based.sort()).toEqual(["HIGH_VOLUME_BREAKOUT", "VWAP_RECLAIM"]);
  });
});

describe("the detector registry (§5.1)", () => {
  it("registers every built-in detector", () => {
    const registry = createPatternRegistry();
    expect(BUILTIN_DETECTORS.length).toBe(5);
    for (const detector of BUILTIN_DETECTORS) {
      expect(registry.has(detector.patternId)).toBe(true);
    }
  });

  it("refuses to register the same pattern id twice", () => {
    const registry = createPatternRegistry();
    expect(() => {
      registry.register(orbBreakout);
    }).toThrow(/already registered/);
  });

  /**
   * Every detector declares a version, and every occurrence carries it. This
   * is what stops a redefinition six months from now from silently restating
   * what earlier research concluded.
   */
  it("stamps identity and version onto every occurrence", () => {
    const registry = createPatternRegistry();
    const detector = registry.instantiate("ORB_BREAKOUT");
    const occurrence = detector.detect(
      context([
        bar(0, { high: 104, low: 96 }),
        bar(1, { high: 105, low: 95 }),
        bar(2, { high: 103, low: 97 }),
        bar(3, { close: 106 }),
      ]),
    );

    expect(occurrence).toMatchObject({
      patternId: "ORB_BREAKOUT",
      detectorVersion: orbBreakout.detectorVersion,
      symbol: SYM,
      interval: "5m",
      direction: "BULLISH",
    });
    // The parameters in force are stored with the detection, so it can be
    // reproduced from its own record rather than from today's defaults.
    expect(occurrence?.params).toMatchObject({ rangeMinutes: 15 });
  });

  /** D4: the occurrence says which bar it saw, and what its volume was worth. */
  it("stamps the decision bar's provenance and market context", () => {
    const registry = createPatternRegistry();
    const decision = bar(3, {
      close: 106,
      source: "BROKER_HISTORICAL",
      ingestionVersion: 1,
      volumeAvailable: true,
      volumeQuality: "SUSPECT",
    });
    const occurrence = registry
      .instantiate("ORB_BREAKOUT")
      .detect(
        context([
          bar(0, { high: 104, low: 96 }),
          bar(1, { high: 105, low: 95 }),
          bar(2, { high: 103, low: 97 }),
          decision,
        ]),
      );

    expect(occurrence?.dataProvenance).toEqual({
      symbol: SYM,
      interval: "5m",
      barTs: decision.ts,
      source: "BROKER_HISTORICAL",
      ingestionVersion: 1,
    });
    expect(occurrence?.marketContext).toEqual({
      volumeAvailable: true,
      volumeQuality: "SUSPECT",
    });
  });

  it("reports the version of every registered detector", () => {
    const versions = createPatternRegistry().versionMap();
    expect(Object.keys(versions)).toHaveLength(5);
    for (const version of Object.values(versions)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  /** D5: the registry describes each detector for the `patterns` catalogue. */
  it("catalogues every detector's definition, defaults and volume use", () => {
    const catalog = createPatternRegistry().catalog();
    expect(catalog.map((d) => d.patternId)).toEqual(
      BUILTIN_DETECTORS.map((d) => d.patternId),
    );
    expect(catalog.find((d) => d.patternId === "HIGH_VOLUME_BREAKOUT")).toEqual(
      {
        patternId: "HIGH_VOLUME_BREAKOUT",
        detectorVersion: "1.0.0",
        definition: highVolumeBreakout.definition,
        defaultParams: { lookback: 20, volumeMultiple: 1.5 },
        volumeBased: true,
      },
    );
    expect(
      catalog.find((d) => d.patternId === "ORB_BREAKOUT")?.volumeBased,
    ).toBe(false);
  });

  it("rejects an unknown pattern id", () => {
    expect(() => createPatternRegistry().instantiate("NOT_A_PATTERN")).toThrow(
      /unknown pattern/,
    );
  });
});

describe("detectors cannot see the future (§5.4)", () => {
  /**
   * Structural, not conventional: the context's window ends at the decision
   * bar, so there is no later bar to read. This asserts the property every
   * detector depends on rather than trusting each one to respect it.
   */
  it("gives every detector a window ending at the decision bar", () => {
    const candles = [bar(0), bar(1), bar(2)];
    const ctx = context(candles);
    expect(ctx.candles.at(-1)).toBe(ctx.candle);
    expect(ctx.candles.every((c) => c.ts <= ctx.candle.ts)).toBe(true);
  });

  it("produces the same answer when re-run on the same context", () => {
    const registry = createPatternRegistry();
    const candles = [
      bar(0, { high: 104, low: 96 }),
      bar(1, { high: 105, low: 95 }),
      bar(2, { high: 103, low: 97 }),
      bar(3, { close: 106 }),
    ];
    const detector = registry.instantiate("ORB_BREAKOUT");
    const first = detector.detect(context(candles));
    const second = detector.detect(context(candles));
    expect(second).toEqual(first);
  });
});
