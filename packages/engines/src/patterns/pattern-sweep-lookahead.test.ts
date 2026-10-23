import { describe, expect, it } from "vitest";
import type { Candle, PatternOccurrence } from "@neelkanth/core";
import { createPatternRegistry } from "@neelkanth/patterns";
import { sweepPatterns, type SweepResult } from "./pattern-sweep.js";
import { fixedSeries } from "./test-support/fixed-series.js";

/**
 * Phase 5 D7 — a detection at bar t sees only bars ≤ t (spec §5.4), proved by
 * behaviour rather than by reading the code, as Phase 4 proved replay.
 *
 * The strong form: for EVERY prefix of a series, sweeping the prefix yields
 * exactly the full sweep's observations up to that prefix's last bar. Any
 * leak — an indicator folded ahead, a window reaching past the decision bar,
 * a session range taken from the whole day — makes some prefix disagree.
 * The series continues with sessions unlike the earlier ones, because
 * repeated data hides a leak (the Phase 4 lesson).
 */
const registry = createPatternRegistry();
const detectors = () => registry.ids().map((id) => registry.instantiate(id));
const sweep = (candles: readonly Candle[]): SweepResult =>
  sweepPatterns({
    symbol: "NSE:PIN-EQ",
    interval: "5m",
    candles,
    detectors: detectors(),
  });
const upTo = (occurrences: readonly PatternOccurrence[], ts: number) =>
  occurrences.filter((o) => o.ts <= ts);

describe("the sweep cannot see the future (D7)", () => {
  const candles = fixedSeries(4);
  const full = sweep(candles);

  it("is a fair test: every detector fires, and later sessions differ", () => {
    const fired = new Set(full.occurrences.map((o) => o.patternId));
    expect([...fired].sort()).toEqual(registry.ids().sort());
    const closes = (day: number) =>
      candles.slice(day * 75, day * 75 + 75).map((c) => c.close);
    expect(closes(3)).not.toEqual(closes(2));
  });

  it("agrees with the full sweep on every prefix", () => {
    const disagreements: number[] = [];
    for (let n = 1; n <= candles.length; n += 1) {
      const last = candles[n - 1];
      if (last === undefined) throw new Error("unreachable");
      const prefix = sweep(candles.slice(0, n)).occurrences;
      if (
        JSON.stringify(prefix) !==
        JSON.stringify(upTo(full.occurrences, last.ts))
      )
        disagreements.push(n);
    }
    expect(disagreements).toEqual([]);
  });

  it("produces the identical result twice", () => {
    expect(sweep(candles)).toEqual(full);
  });
});

/**
 * Bars out of order are lookahead by another name: a later bar would be
 * judged before an earlier one, with its indicators folded first. The store
 * returns them sorted, so a disorder means a broken caller — refused loudly,
 * never silently re-sorted.
 */
describe("the sweep refuses a series it cannot judge in time order", () => {
  const candles = fixedSeries(1).slice(0, 10);

  it("refuses bars out of order", () => {
    const swapped = [...candles];
    [swapped[3], swapped[4]] = [swapped[4] as Candle, swapped[3] as Candle];
    expect(() => sweep(swapped)).toThrow(/ascending/);
  });

  it("refuses a duplicated bar", () => {
    expect(() =>
      sweep([
        ...candles.slice(0, 5),
        candles[4] as Candle,
        ...candles.slice(5),
      ]),
    ).toThrow(/ascending/);
  });

  it("refuses a bar from another series", () => {
    const stray = { ...(candles[5] as Candle), symbol: "NSE:OTHER-EQ" };
    expect(() => sweep([...candles.slice(0, 5), stray])).toThrow(
      /NSE:OTHER-EQ/,
    );
    const coarse = { ...(candles[5] as Candle), interval: "15m" as const };
    expect(() => sweep([...candles.slice(0, 5), coarse])).toThrow(/15m/);
  });
});
