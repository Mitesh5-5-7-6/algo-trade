import { beforeAll, describe, expect, it } from "vitest";
import { istDateKey } from "@neelkanth/core";
import { createStrategyRegistry } from "@neelkanth/strategies";
import { goldenBudget, historicalBars } from "../replay/test-support.js";
import { DEFAULT_REGIME_MODEL, regimeAt } from "../counterfactual/regime.js";
import { runDay, type DayRun } from "./day.js";
import { tradeEvidence } from "./evidence.js";
import {
  dayFeatures,
  patternObservations,
  strategyObservations,
} from "./observations.js";

/** Task 8.3 (design D3): the day, its patterns compared across strategies, each strategy's day. */
const SYM = "NSE:TESTCO-EQ";
let day: DayRun;
let single: DayRun;
beforeAll(async () => {
  const candles = await historicalBars(
    [0, 1, 2, 3, 4, 7, 8, 9],
    (d) => 1 + (d % 5) * 0.04 + d * 0.01,
  );
  const base = {
    candles,
    symbols: [SYM],
    hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
    ...goldenBudget(),
    seed: 0,
    regime: { ...DEFAULT_REGIME_MODEL, symbol: "NSE:TESTINDEX-INDEX" },
  };
  day = await runDay({ ...base, date: "2026-01-14" });
  single = await runDay({ ...base, date: "2026-01-14", lookbackSessions: 1 });
}, 120_000);

describe("day features (8.3, D3)", () => {
  it("are computed from the day's own bars", () => {
    const bars = day.bars.filter(
      (b) => b.symbol === SYM && istDateKey(b.ts) === "2026-01-14",
    );
    const f = dayFeatures(day, SYM);
    expect(f).toMatchObject({
      bars: bars.length,
      open: bars[0]?.open,
      close: bars.at(-1)?.close,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      specialSession: false,
      sources: { BROKER_HISTORICAL: bars.length },
      ingestionVersions: [1],
      volumeQuality: { REAL: bars.length },
    });
    expect(f.returnPct).toBeCloseTo(
      (bars.at(-1)?.close ?? 0) / (bars[0]?.open ?? 1) - 1,
      6,
    );
    expect(f.regimeAtClose).toBe(
      regimeAt(day.evaluation.timeline, bars.at(-1)?.ts ?? 0),
    );
    expect(f.realisedVolatility).toBeGreaterThan(0);
  });

  it("measures the gap from the prior session's close — and claims none without one", () => {
    const prior = day.bars
      .filter((b) => b.symbol === SYM && istDateKey(b.ts) === "2026-01-13")
      .at(-1);
    expect(dayFeatures(day, SYM).gapPct).toBeCloseTo(
      dayFeatures(day, SYM).open / (prior?.close ?? 1) - 1,
      6,
    );
    expect(dayFeatures(single, SYM).gapPct).toBeNull();
  });

  it("refuses a symbol with no bars that day", () => {
    expect(() => dayFeatures(day, "NSE:ABSENT-EQ")).toThrow(
      /no bars on 2026-01-14/,
    );
  });
});

describe("patterns compared across strategies (8.3, D3)", () => {
  it("puts every occurrence of the day to every strategy that ran on its symbol", () => {
    const obs = patternObservations(day, SYM);
    expect(obs).toHaveLength(
      day.occurrences.filter((o) => o.symbol === SYM).length,
    );
    expect(obs.length).toBeGreaterThan(0);
    for (const o of obs)
      expect(Object.keys(o.strategies).sort()).toEqual([
        "EMA_CROSSOVER",
        "ORB",
        "RSI",
      ]);
  });

  it("agrees with the attributions, and points ENTERED and HOLDING at the day's evidence", () => {
    const keys = new Set(tradeEvidence(day).map((e) => e.key));
    let entered = 0;
    for (const o of patternObservations(day, SYM))
      for (const [type, s] of Object.entries(o.strategies)) {
        const a = day.attributions.find(
          (x) =>
            x.ts === o.ts &&
            x.patternId === o.patternId &&
            x.strategyType === type,
        );
        expect(s.relation).toBe(a?.relation);
        if (s.relation === "ENTERED") {
          entered += 1;
          expect(keys.has(s.tradeKey ?? "")).toBe(true);
        }
        if (s.relation === "FLAT" || s.relation === "SIGNALLED")
          expect(s.tradeKey).toBeUndefined();
      }
    expect(entered).toBeGreaterThan(0);
  });
});

describe("each strategy's day (8.3, D3)", () => {
  it("accounts for every registered strategy — evaluated, or excluded with its reason", () => {
    const obs = strategyObservations(day, SYM);
    expect(obs.map((o) => o.type)).toEqual(createStrategyRegistry().types());
    expect(
      obs
        .filter((o) => !o.eligible)
        .every((o) => o.exclusion.reason.length > 0),
    ).toBe(true);
  });

  it("counts its proposals, what risk did with them, and what it traded", () => {
    for (const o of strategyObservations(day, SYM)) {
      if (!o.eligible) continue;
      const sd = day.strategyDays.find((d) => d.strategyType === o.type);
      const blocked = Object.values(o.blocked).reduce((n, v) => n + v, 0);
      expect(o.approved + blocked).toBe(o.actionable);
      expect(o.actionable + o.holds + o.mechanicalExits).toBe(
        sd?.signals.length,
      );
      expect(o.trades).toBe(sd?.trades.length);
      expect(o.net).toBeCloseTo(
        (sd?.trades ?? []).reduce((n, t) => n + (t.netPnl ?? 0), 0),
        4,
      );
    }
  });
});
