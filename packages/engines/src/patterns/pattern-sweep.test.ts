import { describe, expect, it } from "vitest";
import {
  sessionOpenTsFor,
  type Candle,
  type PatternOccurrence,
} from "@neelkanth/core";
import {
  createPatternRegistry,
  type RunnableDetector,
} from "@neelkanth/patterns";
import { sweepPatterns } from "./pattern-sweep.js";
import { PatternSweepRunner } from "./pattern-sweep-runner.js";

/**
 * The sweep is where a detector meets real data, and where the mistakes stop
 * being visible by inspection. What is tested here is mostly what the sweep
 * REFUSES to do: fire before indicators have converged, carry an opening range
 * into the next day, or compare this morning's VWAP against yesterday's.
 */

/** 2026-01-05 was a Monday. 09:15 IST = 03:45 UTC. */
const DAY_1_OPEN = Date.UTC(2026, 0, 5, 3, 45);
const DAY_2_OPEN = Date.UTC(2026, 0, 6, 3, 45);
const BAR_MS = 300_000;

const bar = (
  openTs: number,
  index: number,
  fields: Partial<Candle> = {},
): Candle => ({
  symbol: "NSE:SWEEP-EQ",
  interval: "5m",
  source: "BROKER_HISTORICAL",
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1_000,
  ts: openTs + index * BAR_MS,
  ...fields,
});

const registry = createPatternRegistry();
const detector = (id: string, params: unknown = {}): RunnableDetector =>
  registry.instantiate(id, params);

describe("sweepPatterns — session anchoring", () => {
  /**
   * The ORB range is bars 0–2 (09:15–09:30). A close above it at 09:35 is a
   * breakout; the sweep must give the detector a session open of 09:15 for it
   * to measure against, computed from the same clock the live session uses.
   */
  it("finds an opening-range breakout on the right bar", () => {
    const candles = [
      bar(DAY_1_OPEN, 0, { high: 104, low: 96 }),
      bar(DAY_1_OPEN, 1, { high: 105, low: 95 }),
      bar(DAY_1_OPEN, 2, { high: 103, low: 97 }),
      bar(DAY_1_OPEN, 3, { close: 106, high: 107 }),
      bar(DAY_1_OPEN, 4, { close: 101 }),
    ];
    const result = sweepPatterns({
      symbol: "NSE:SWEEP-EQ",
      interval: "5m",
      candles,
      detectors: [detector("ORB_BREAKOUT")],
    });

    expect(result.barsScanned).toBe(5);
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]).toMatchObject({
      patternId: "ORB_BREAKOUT",
      direction: "BULLISH",
      ts: DAY_1_OPEN + 3 * BAR_MS,
    });
  });

  it("anchors the range to the exchange open, not to the first bar it was given", () => {
    // A sweep that starts mid-morning must not treat 11:00 as the session open
    // and call the next bar an opening-range breakout.
    const lateStart = DAY_1_OPEN + 21 * BAR_MS;
    const candles = [
      bar(lateStart, 0, { high: 104, low: 96 }),
      bar(lateStart, 1, { close: 110 }),
    ];
    const result = sweepPatterns({
      symbol: "NSE:SWEEP-EQ",
      interval: "5m",
      candles,
      detectors: [detector("ORB_BREAKOUT")],
    });

    expect(sessionOpenTsFor(lateStart)).toBe(DAY_1_OPEN);
    // The real opening range is not in this window, so there is nothing to
    // break out of — and the sweep says nothing rather than inventing a range.
    expect(result.occurrences).toHaveLength(0);
  });

  /**
   * The failure this prevents: yesterday's range leaking into today, so the
   * first bars of every session read as breakouts of a level that expired at
   * the bell.
   */
  it("starts a new candle window at each session", () => {
    const day1 = [
      bar(DAY_1_OPEN, 0, { high: 104, low: 96 }),
      bar(DAY_1_OPEN, 1, { high: 105, low: 95 }),
      bar(DAY_1_OPEN, 2, { high: 103, low: 97 }),
      bar(DAY_1_OPEN, 3, { close: 106 }),
    ];
    // Day 2 opens far above day 1's range but forms its own, tighter one.
    const day2 = [
      bar(DAY_2_OPEN, 0, { open: 120, high: 122, low: 119, close: 121 }),
      bar(DAY_2_OPEN, 1, { open: 121, high: 123, low: 120, close: 122 }),
      bar(DAY_2_OPEN, 2, { open: 122, high: 122, low: 120, close: 121 }),
      bar(DAY_2_OPEN, 3, { open: 121, high: 124, low: 121, close: 124 }),
    ];
    const result = sweepPatterns({
      symbol: "NSE:SWEEP-EQ",
      interval: "5m",
      candles: [...day1, ...day2],
      detectors: [detector("ORB_BREAKOUT")],
    });

    expect(result.sessions).toEqual(["2026-01-05", "2026-01-06"]);
    expect(result.occurrences.map((o) => o.ts)).toEqual([
      DAY_1_OPEN + 3 * BAR_MS,
      DAY_2_OPEN + 3 * BAR_MS,
    ]);
    // Day 2's breakout is measured against day 2's range (high 123), not
    // against day 1's (high 105) — which every day-2 bar already exceeds.
    expect(result.occurrences[1]?.evidence["rangeHigh"]).toBe(123);
  });
});

/**
 * The Budget Sunday (2026-02-01) is a real session with real bars. The sweep
 * groups bars by IST date and never asks the weekday rule, so a weekend
 * session is swept like any other — anchored to its own open, its range its
 * own — rather than silently dropped or merged into Monday.
 */
describe("sweepPatterns — special sessions", () => {
  const SUNDAY_OPEN = Date.UTC(2026, 1, 1, 3, 45);
  const MONDAY_OPEN = Date.UTC(2026, 1, 2, 3, 45);

  it("sweeps a Budget Sunday as its own session", () => {
    const sunday = [
      bar(SUNDAY_OPEN, 0, { high: 104, low: 96 }),
      bar(SUNDAY_OPEN, 1, { high: 105, low: 95 }),
      bar(SUNDAY_OPEN, 2, { high: 103, low: 97 }),
      bar(SUNDAY_OPEN, 3, { close: 106, high: 107 }),
    ];
    const monday = [
      bar(MONDAY_OPEN, 0, { open: 120, high: 122, low: 119, close: 121 }),
      bar(MONDAY_OPEN, 1, { open: 121, high: 123, low: 120, close: 122 }),
      bar(MONDAY_OPEN, 2, { open: 122, high: 122, low: 120, close: 121 }),
      bar(MONDAY_OPEN, 3, { open: 121, high: 124, low: 121, close: 124 }),
    ];
    const result = sweepPatterns({
      symbol: "NSE:SWEEP-EQ",
      interval: "5m",
      candles: [...sunday, ...monday],
      detectors: [detector("ORB_BREAKOUT")],
    });

    expect(result.sessions).toEqual(["2026-02-01", "2026-02-02"]);
    expect(result.occurrences.map((o) => o.ts)).toEqual([
      SUNDAY_OPEN + 3 * BAR_MS,
      MONDAY_OPEN + 3 * BAR_MS,
    ]);
    expect(result.occurrences[0]?.evidence["rangeHigh"]).toBe(105);
    expect(result.occurrences[1]?.evidence["rangeHigh"]).toBe(123);
  });
});

/**
 * "Found nothing" and "could not look" are different facts. On SUSPECT volume
 * the volume-based detectors could not look, and the sweep says so per
 * detector, as it does for warm-up — while price-only detectors still judge.
 */
describe("sweepPatterns — volume quality (D3)", () => {
  it("counts the bars each volume-based detector declined, and still runs the rest", () => {
    const suspect = {
      volumeAvailable: true,
      volumeQuality: "SUSPECT",
    } as const;
    const candles = [
      bar(DAY_1_OPEN, 0, { high: 104, low: 96, ...suspect }),
      bar(DAY_1_OPEN, 1, { high: 105, low: 95, ...suspect }),
      bar(DAY_1_OPEN, 2, { high: 103, low: 97, ...suspect }),
      bar(DAY_1_OPEN, 3, { close: 106, high: 107, volume: 5_000, ...suspect }),
    ];
    const result = sweepPatterns({
      symbol: "NSE:SWEEP-EQ",
      interval: "5m",
      candles,
      detectors: [
        detector("ORB_BREAKOUT"),
        detector("HIGH_VOLUME_BREAKOUT", { lookback: 2 }),
      ],
    });

    expect(result.occurrences.map((o) => o.patternId)).toEqual([
      "ORB_BREAKOUT",
    ]);
    // Warm for bars 2 and 3 (lookback + 1 = 3 bars), declined on both.
    expect(result.declinedForVolume).toEqual({
      ORB_BREAKOUT: 0,
      HIGH_VOLUME_BREAKOUT: 2,
    });
    expect(result.skippedForWarmup["HIGH_VOLUME_BREAKOUT"]).toBe(2);
  });

  it("declines nothing on trusted volume", () => {
    const candles = [0, 1, 2, 3].map((i) => bar(DAY_1_OPEN, i));
    const result = sweepPatterns({
      symbol: "NSE:SWEEP-EQ",
      interval: "5m",
      candles,
      detectors: [detector("HIGH_VOLUME_BREAKOUT", { lookback: 2 })],
    });
    expect(result.declinedForVolume).toEqual({ HIGH_VOLUME_BREAKOUT: 0 });
  });
});

describe("sweepPatterns — warm-up", () => {
  /**
   * An EMA has a value after one bar; it does not have a MEANING for another
   * twenty. A cross computed from two unconverged numbers looks exactly like a
   * real one once it is in the store, which is the most expensive kind of
   * wrong: it inflates the sample with detections that mean nothing.
   */
  it("refuses to judge until a detector's indicators have converged", () => {
    // A ramp then a collapse — an EMA(9)/EMA(21) cross is guaranteed, but only
    // well after the start.
    const candles = Array.from({ length: 40 }, (_, i) =>
      bar(DAY_1_OPEN, i, { close: i < 20 ? 100 + i * 2 : 140 - (i - 20) * 4 }),
    );
    const emaCross = detector("EMA_CROSS");
    const result = sweepPatterns({
      symbol: "NSE:SWEEP-EQ",
      interval: "5m",
      candles,
      detectors: [emaCross],
    });

    // It declares it needs 22 bars of history, so the 22nd bar is the first it
    // is allowed to judge and the 21 before it are skipped.
    const firstJudgedIndex = emaCross.warmupBars() - 1;
    expect(result.skippedForWarmup["EMA_CROSS"]).toBe(firstJudgedIndex);
    expect(result.occurrences.length).toBeGreaterThan(0);
    for (const occurrence of result.occurrences) {
      const barIndex = (occurrence.ts - DAY_1_OPEN) / BAR_MS;
      expect(barIndex).toBeGreaterThanOrEqual(firstJudgedIndex);
    }
  });

  /**
   * "This detector found nothing" and "this detector was never able to look"
   * produce the same empty list, and only one of them is a fact about the
   * market. The count is what separates them.
   */
  it("reports the bars it skipped rather than silently returning nothing", () => {
    const candles = [bar(DAY_1_OPEN, 0), bar(DAY_1_OPEN, 1)];
    const result = sweepPatterns({
      symbol: "NSE:SWEEP-EQ",
      interval: "5m",
      candles,
      detectors: [detector("EMA_CROSS"), detector("RSI_REVERSION")],
    });

    expect(result.occurrences).toHaveLength(0);
    expect(result.skippedForWarmup).toEqual({
      EMA_CROSS: 2,
      RSI_REVERSION: 2,
    });
  });

  /**
   * An index reports no volume, so VWAP never converges and VWAP_RECLAIM can
   * never fire. That must show up as skipped bars, not as a clean zero — a
   * clean zero would be read as "this index had no VWAP reclaims", which is a
   * statement about the feed, not the market.
   */
  it("never lets a detector fire on an indicator that never became ready", () => {
    const candles = Array.from({ length: 10 }, (_, i) =>
      bar(DAY_1_OPEN, i, {
        symbol: "NSE:INDEX-INDEX",
        volume: 0,
        close: 100 + (i % 2 === 0 ? -2 : 2),
      }),
    );
    const result = sweepPatterns({
      symbol: "NSE:INDEX-INDEX",
      interval: "5m",
      candles,
      detectors: [detector("VWAP_RECLAIM")],
    });

    expect(result.occurrences).toHaveLength(0);
    expect(result.skippedForWarmup["VWAP_RECLAIM"]).toBe(10);
  });
});

describe("sweepPatterns — indicator continuity across the bell", () => {
  /**
   * VWAP is session-anchored: it resets, and so must its "previous" value.
   * Otherwise today's first bar is compared against yesterday's closing VWAP
   * and a reclaim is manufactured out of the overnight gap.
   */
  it("does not compare the first bar of a session against yesterday's VWAP", () => {
    // Day 1 settles around 100. Day 2 gaps up and trades at 130 all day, so a
    // stale previous VWAP of ~100 would read as a reclaim on the very first bar.
    const day1 = Array.from({ length: 6 }, (_, i) =>
      bar(DAY_1_OPEN, i, { open: 100, high: 101, low: 99, close: 100 }),
    );
    const day2 = Array.from({ length: 6 }, (_, i) =>
      bar(DAY_2_OPEN, i, { open: 130, high: 131, low: 129, close: 130 }),
    );
    const result = sweepPatterns({
      symbol: "NSE:SWEEP-EQ",
      interval: "5m",
      candles: [...day1, ...day2],
      detectors: [detector("VWAP_RECLAIM")],
    });

    const firstBarOfDay2 = result.occurrences.filter(
      (o) => o.ts === DAY_2_OPEN,
    );
    expect(firstBarOfDay2).toHaveLength(0);
  });

  /**
   * The other half of the same decision: rolling indicators DO carry across,
   * exactly as they do live, because a cross over the overnight gap is a real
   * event and suppressing it would lose a genuine detection.
   */
  it("carries rolling indicators across the bell", () => {
    // 30 falling bars on day 1, then a gap up and a hard rally on day 2. A
    // fresh EMA on day 2 could not produce a cross this early; a carried one
    // can, and should.
    const day1 = Array.from({ length: 30 }, (_, i) =>
      bar(DAY_1_OPEN, i, { close: 200 - i * 2 }),
    );
    const day2 = Array.from({ length: 12 }, (_, i) =>
      bar(DAY_2_OPEN, i, { close: 150 + i * 6 }),
    );
    const result = sweepPatterns({
      symbol: "NSE:SWEEP-EQ",
      interval: "5m",
      candles: [...day1, ...day2],
      detectors: [detector("EMA_CROSS")],
    });

    const onDay2 = result.occurrences.filter((o) => o.ts >= DAY_2_OPEN);
    expect(onDay2.length).toBeGreaterThan(0);
    expect(onDay2[0]?.direction).toBe("BULLISH");
  });
});

describe("sweepPatterns — determinism and provenance", () => {
  const candles = [
    bar(DAY_1_OPEN, 0, { high: 104, low: 96 }),
    bar(DAY_1_OPEN, 1, { high: 105, low: 95 }),
    bar(DAY_1_OPEN, 2, { high: 103, low: 97 }),
    bar(DAY_1_OPEN, 3, { close: 106 }),
  ];

  it("produces the identical result on a second run", () => {
    const request = {
      symbol: "NSE:SWEEP-EQ",
      interval: "5m" as const,
      candles,
      detectors: [detector("ORB_BREAKOUT"), detector("HIGH_VOLUME_BREAKOUT")],
    };
    expect(sweepPatterns(request)).toEqual(sweepPatterns(request));
  });

  it("stamps every occurrence with the detector version and its parameters", () => {
    const result = sweepPatterns({
      symbol: "NSE:SWEEP-EQ",
      interval: "5m",
      candles,
      detectors: [detector("ORB_BREAKOUT", { rangeMinutes: 15 })],
    });
    expect(result.occurrences[0]).toMatchObject({
      detectorVersion: "1.0.0",
      symbol: "NSE:SWEEP-EQ",
      interval: "5m",
      params: { rangeMinutes: 15 },
    });
  });

  /**
   * The same detector at two parameter sets is two independent observers of
   * the same bar. Both answers are kept; the store's identity rule is what
   * keeps them apart.
   */
  it("runs one detector at two parameter sets without them colliding", () => {
    const result = sweepPatterns({
      symbol: "NSE:SWEEP-EQ",
      interval: "5m",
      candles,
      detectors: [
        detector("ORB_BREAKOUT", { rangeMinutes: 15 }),
        detector("ORB_BREAKOUT", { rangeMinutes: 5 }),
      ],
    });
    expect(result.occurrences).toHaveLength(2);
    expect(result.occurrences.map((o) => o.params["rangeMinutes"])).toEqual([
      15, 5,
    ]);
  });

  /** D4, across a whole sweep: each occurrence's provenance is its own bar. */
  it("gives every occurrence the provenance of the bar it fired on", () => {
    const candles = [
      bar(DAY_1_OPEN, 0, { high: 104, low: 96, ingestionVersion: 1 }),
      bar(DAY_1_OPEN, 1, { high: 105, low: 95, ingestionVersion: 1 }),
      bar(DAY_1_OPEN, 2, { high: 103, low: 97, ingestionVersion: 1 }),
      bar(DAY_1_OPEN, 3, { close: 106, ingestionVersion: 1 }),
      bar(DAY_2_OPEN, 0, { high: 104, low: 96 }),
      bar(DAY_2_OPEN, 1, { high: 105, low: 95 }),
      bar(DAY_2_OPEN, 2, { high: 103, low: 97 }),
      bar(DAY_2_OPEN, 3, { close: 106, source: "LIVE_TICK" }),
    ];
    const result = sweepPatterns({
      symbol: "NSE:SWEEP-EQ",
      interval: "5m",
      candles,
      detectors: [detector("ORB_BREAKOUT")],
    });

    expect(result.occurrences).toHaveLength(2);
    expect(result.occurrences.map((o) => o.dataProvenance)).toEqual([
      {
        symbol: "NSE:SWEEP-EQ",
        interval: "5m",
        barTs: DAY_1_OPEN + 3 * BAR_MS,
        source: "BROKER_HISTORICAL",
        ingestionVersion: 1,
      },
      {
        symbol: "NSE:SWEEP-EQ",
        interval: "5m",
        barTs: DAY_2_OPEN + 3 * BAR_MS,
        source: "LIVE_TICK",
      },
    ]);
  });

  it("scans nothing when given nothing", () => {
    const result = sweepPatterns({
      symbol: "NSE:SWEEP-EQ",
      interval: "5m",
      candles: [],
      detectors: [detector("ORB_BREAKOUT")],
    });
    expect(result).toEqual({
      occurrences: [],
      barsScanned: 0,
      skippedForWarmup: {},
      declinedForVolume: {},
      sessions: [],
    });
  });
});

describe("PatternSweepRunner", () => {
  const candles = [
    bar(DAY_1_OPEN, 0, { high: 104, low: 96 }),
    bar(DAY_1_OPEN, 1, { high: 105, low: 95 }),
    bar(DAY_1_OPEN, 2, { high: 103, low: 97 }),
    bar(DAY_1_OPEN, 3, { close: 106 }),
  ];

  /** A sink with the same identity rule as the real repository. */
  const fakeSink = () => {
    const stored = new Set<string>();
    return {
      stored,
      recordMany: (occurrences: readonly PatternOccurrence[]) => {
        let added = 0;
        for (const o of occurrences) {
          const key = `${o.patternId}|${o.detectorVersion}|${JSON.stringify(o.params)}|${o.symbol}|${o.interval}|${String(o.ts)}`;
          if (!stored.has(key)) {
            stored.add(key);
            added += 1;
          }
        }
        return Promise.resolve(added);
      },
    };
  };

  const runnerWith = (sink: ReturnType<typeof fakeSink>) =>
    new PatternSweepRunner({
      candles: {
        findRange: (_s, _i, fromTs, toTs) =>
          Promise.resolve(candles.filter((c) => c.ts >= fromTs && c.ts < toTs)),
      },
      observations: sink,
      detectors: [detector("ORB_BREAKOUT")],
      now: () => 1_760_100_000_000,
      onError: () => undefined,
    });

  it("reads candles, sweeps, and records what it found", async () => {
    const sink = fakeSink();
    const report = await runnerWith(sink).run(
      "NSE:SWEEP-EQ",
      "5m",
      DAY_1_OPEN,
      DAY_1_OPEN + 10 * BAR_MS,
    );

    expect(report.barsScanned).toBe(4);
    expect(report.occurrences).toHaveLength(1);
    expect(report.recorded).toBe(1);
    expect(report.alreadyKnown).toBe(0);
  });

  /**
   * The acceptance test for §5.4: a day of candles produces observations, and
   * a re-run adds none. Re-running is the normal case — backfills arrive late,
   * detectors get added — so a repeat must be a cheap no-op, not a doubling.
   */
  it("adds nothing on a second run over the same day", async () => {
    const sink = fakeSink();
    const runner = runnerWith(sink);
    await runner.run(
      "NSE:SWEEP-EQ",
      "5m",
      DAY_1_OPEN,
      DAY_1_OPEN + 10 * BAR_MS,
    );
    const second = await runner.run(
      "NSE:SWEEP-EQ",
      "5m",
      DAY_1_OPEN,
      DAY_1_OPEN + 10 * BAR_MS,
    );

    expect(second.occurrences).toHaveLength(1);
    expect(second.recorded).toBe(0);
    expect(second.alreadyKnown).toBe(1);
    expect(sink.stored.size).toBe(1);
  });

  it("does nothing for an inverted range", async () => {
    const sink = fakeSink();
    const report = await runnerWith(sink).run(
      "NSE:SWEEP-EQ",
      "5m",
      DAY_1_OPEN + 1,
      DAY_1_OPEN,
    );
    expect(report.barsScanned).toBe(0);
    expect(sink.stored.size).toBe(0);
  });

  /**
   * A failed sweep must not look like a market with no patterns in it. It
   * reports AND rethrows, so the caller decides whether one bad day stops a
   * year-long backfill — rather than the backfill quietly writing a hole.
   */
  it("reports and rethrows a read failure instead of returning an empty day", async () => {
    const seen: Record<string, unknown>[] = [];
    const runner = new PatternSweepRunner({
      candles: {
        findRange: () => Promise.reject(new Error("mongo is down")),
      },
      observations: { recordMany: () => Promise.resolve(0) },
      detectors: [detector("ORB_BREAKOUT")],
      now: () => 1,
      onError: (_error, context) => seen.push(context),
    });

    await expect(
      runner.run("NSE:SWEEP-EQ", "5m", DAY_1_OPEN, DAY_1_OPEN + BAR_MS),
    ).rejects.toThrow("mongo is down");
    expect(seen[0]).toMatchObject({
      where: "PatternSweepRunner.run",
      symbol: "NSE:SWEEP-EQ",
    });
  });
});
