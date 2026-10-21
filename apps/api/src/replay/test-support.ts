import type { Candle, StrategyConfig } from "@neelkanth/core";
import { goldenFixture } from "../golden/fixture.js";
import { runReplay } from "../golden/pipeline.js";

/**
 * Test-only: the golden day's 5m bars, as the broker's history would hold
 * them, repeated on the given IST day offsets from 2026-01-05.
 *
 * Built by running the golden ticks through the real aggregator, so the bars
 * are ones the machine itself produced — not a second hand-written path.
 */
export async function historicalBars(dayOffsets: number[]): Promise<Candle[]> {
  const fixture = goldenFixture();
  const bars: Candle[] = [];
  await runReplay({
    interval: fixture.interval,
    intervals: ["5m"],
    source: { kind: "ticks", ticks: fixture.ticks },
    sessions: [
      {
        date: "2026-01-05",
        preOpenTs: fixture.preOpenTs,
        sessionOpenTs: fixture.sessionOpenTs,
        squareOffTs: fixture.squareOffTs,
        afterCloseTs: fixture.afterCloseTs,
      },
    ],
    strategies: [],
    indexSymbols: fixture.indexSymbols,
    breadthSymbols: fixture.breadthSymbols,
    allocatedCapital: fixture.allocatedCapital,
    limits: fixture.limits,
    onCandleClosed: (candle) => bars.push(candle),
  });
  return dayOffsets.flatMap((offset) =>
    bars.map((bar) => ({
      ...bar,
      ts: bar.ts + offset * 86_400_000,
      source: "BROKER_HISTORICAL" as const,
      ingestionVersion: 1,
    })),
  );
}

/** The golden fixture's EMA strategy — it trades the golden day. */
export function emaStrategy(): StrategyConfig {
  const ema = goldenFixture().strategies.find(
    (s) => s.strategyId === "str_ema",
  );
  if (ema === undefined) throw new Error("golden fixture has no EMA strategy");
  return ema;
}

/** The golden fixture's capital and limits. */
export function goldenBudget() {
  const fixture = goldenFixture();
  return { allocatedCapital: fixture.allocatedCapital, limits: fixture.limits };
}
