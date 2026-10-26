import { beforeAll, describe, expect, it } from "vitest";
import { intervalMs, istDateKey, type Candle } from "@neelkanth/core";
import { goldenBudget, historicalBars } from "../replay/test-support.js";
import { DEFAULT_REGIME_MODEL } from "../counterfactual/regime.js";
import { runDay, type DayRun, type DayRunRequest } from "./day.js";
import { tradeEvidence } from "./evidence.js";
import { dayChart, tradeChart } from "./charts.js";

/** Task 8.4 (design D4): charts as specifications — and no volume line from untrusted volume. */
const SYM = "NSE:TESTCO-EQ";
let candles: Candle[];
let day: DayRun;
const request = (c: Candle[]): DayRunRequest => ({
  date: "2026-01-14",
  candles: c,
  symbols: [SYM],
  hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
  ...goldenBudget(),
  seed: 0,
  regime: { ...DEFAULT_REGIME_MODEL, symbol: "NSE:TESTINDEX-INDEX" },
});
beforeAll(async () => {
  candles = await historicalBars(
    [0, 1, 2, 3, 4, 7, 8, 9],
    (d) => 1 + (d % 5) * 0.04 + d * 0.01,
  );
  day = await runDay(request(candles));
}, 120_000);

describe("the day's chart (8.4, D4)", () => {
  it("spans the day and marks every pattern, entry, exit and blocked proposal", () => {
    const evidence = tradeEvidence(day);
    const chart = dayChart(day, SYM, evidence);
    const bars = day.bars.filter(
      (b) => b.symbol === SYM && istDateKey(b.ts) === "2026-01-14",
    );
    expect(chart.start).toBe(bars[0]?.ts);
    expect(chart.end).toBeGreaterThanOrEqual(bars.at(-1)?.ts ?? Infinity);
    for (const m of chart.markers) {
      expect(m.ts).toBeGreaterThanOrEqual(chart.start);
      expect(m.ts).toBeLessThan(chart.end + intervalMs("5m"));
    }
    const kinds = (k: string) =>
      chart.markers.filter((m) => m.kind === k).length;
    expect(kinds("PATTERN")).toBe(
      day.occurrences.filter((o) => o.symbol === SYM).length,
    );
    expect(kinds("ENTRY")).toBe(evidence.length);
    expect(kinds("EXIT")).toBe(
      evidence.filter((e) => e.exit.time !== null).length,
    );
    expect(
      chart.markers.every(
        (m, i, all) => i === 0 || (all[i - 1]?.ts ?? 0) <= m.ts,
      ),
    ).toBe(true);
    expect(chart.chartId).toBe("2026-01-14|NSE:TESTCO-EQ|day");
  });

  it("overlays the trend EMA and each strategy's own indicators, price-scaled on the price pane", () => {
    const chart = dayChart(day, SYM, tradeEvidence(day));
    expect(chart.overlays).toContainEqual({
      kind: "ema",
      period: 21,
      pane: "price",
    });
    for (const o of chart.overlays)
      expect(o.pane).toBe(
        ["ema", "sma", "vwap"].includes(o.kind) ? "price" : "lower",
      );
    const ids = chart.overlays.map((o) => `${o.kind}${String(o.period ?? "")}`);
    expect(new Set(ids).size).toBe(ids.length); // each once
  });

  /** Phase 5 D3, for pictures too: no VWAP line from SUSPECT volume. */
  it("draws VWAP only on REAL volume, and says when it did not", async () => {
    expect(dayChart(day, SYM, []).overlays.some((o) => o.kind === "vwap")).toBe(
      true,
    );
    const suspect = await runDay(
      request(
        candles.map((c) => ({
          ...c,
          volumeAvailable: true,
          volumeQuality: "SUSPECT" as const,
        })),
      ),
    );
    const chart = dayChart(suspect, SYM, []);
    expect(
      chart.overlays.some((o) => o.kind === "vwap" || o.kind === "avgVolume"),
    ).toBe(false);
    expect(
      chart.annotations.some((a) =>
        /^vwap omitted: volume is not REAL on \d+ bar/.test(a),
      ),
    ).toBe(true);
  }, 120_000);
});

describe("blocked proposals on the day's chart (8.4, D4)", () => {
  /** A budget too small to size anything: risk blocks, and the chart says where. */
  it("marks every proposal risk blocked, on the bar it was made", async () => {
    const poor = await runDay({ ...request(candles), allocatedCapital: 1 });
    let expected = 0;
    for (const r of poor.evaluation.runs) {
      const blocked = new Set(
        r.trail.riskLogs
          .filter((l) => l.decision === "blocked")
          .map((l) => l.signalId),
      );
      expected += (
        poor.strategyDays.find((d) => d.strategyType === r.strategyType)
          ?.signals ?? []
      ).filter((x) => blocked.has(x.signalId)).length;
    }
    expect(expected).toBeGreaterThan(0); // a fair test
    const chart = dayChart(poor, SYM, tradeEvidence(poor));
    expect(chart.markers.filter((m) => m.kind === "BLOCKED")).toHaveLength(
      expected,
    );
  }, 120_000);
});

describe("each Trade's chart (8.4, D4)", () => {
  it("runs from what preceded the entry to just after the exit", () => {
    const barMs = intervalMs("5m");
    const evidence = tradeEvidence(day);
    expect(evidence.length).toBeGreaterThan(0);
    for (const e of evidence) {
      const chart = tradeChart(day, e, 6);
      expect(chart.start).toBeGreaterThanOrEqual(e.entry.barTs - 6 * barMs);
      expect(chart.start).toBeLessThanOrEqual(e.entry.barTs);
      expect(chart.end).toBeGreaterThanOrEqual(
        Math.floor((e.exit.time ?? 0) / barMs) * barMs,
      );
      // A chart contains its own markers: every one falls in its span.
      for (const m of chart.markers) {
        expect(m.ts).toBeGreaterThanOrEqual(chart.start);
        expect(m.ts).toBeLessThan(chart.end + barMs);
      }
      expect(chart.markers.filter((m) => m.kind === "ENTRY")).toHaveLength(1);
      expect(chart.markers.filter((m) => m.kind === "PATTERN")).toHaveLength(
        e.preceding.patterns.length,
      );
      expect(chart.chartId).toBe(`2026-01-14|${e.symbol}|trade|${e.key}`);
      expect(chart.annotations[0]).toContain(e.outcome.result);
    }
    const ids = evidence.map((e) => tradeChart(day, e).chartId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is the same specification every time", () => {
    const [e] = tradeEvidence(day);
    if (e === undefined) throw new Error("no Trade");
    expect(tradeChart(day, e)).toEqual(tradeChart(day, e));
    expect(JSON.stringify(dayChart(day, SYM, [e]))).not.toMatch(
      /png|jpe?g|image|url/i,
    );
  });
});
