import { describe, expect, it } from "vitest";
import { checkpointChance, type Candle } from "@neelkanth/core";
import { buildCheckpointOdds } from "./checkpoint-odds.js";

const SYM = "NSE:NIFTY50-INDEX";
/** 2026-11-02 09:15 IST in epoch ms. */
const OPEN = Date.UTC(2026, 10, 2, 3, 45);

function bar(i: number, day: number, close: number, high: number, low: number): Candle {
  return {
    symbol: SYM,
    interval: "5m",
    ts: OPEN + day * 86_400_000 + i * 300_000,
    open: close,
    high,
    low,
    close,
    volume: 0,
    source: "BROKER_HISTORICAL",
  } as Candle;
}

describe("buildCheckpointOdds", () => {
  it("counts a move on before the move back as a hit, and the reverse as a miss", () => {
    // Day 0: from 100 the next bar reaches 100.2 → UP 0.2% back 1 is a hit.
    // Day 1: from 100 the next bar falls to 99.8 first → a miss.
    const bars = [
      bar(0, 0, 100, 100, 100),
      bar(1, 0, 100.2, 100.25, 100.05),
      bar(0, 1, 100, 100, 100),
      bar(1, 1, 99.8, 99.95, 99.75),
    ];
    const table = buildCheckpointOdds(bars, 1);
    const row = table.rows.find(
      (r) =>
        r.direction === "UP" && r.movePct === 0.002 && r.back === 1 && r.fromMinute === 0,
    );
    expect(row).toMatchObject({ samples: 2, chance: 0.5 });
    expect(table.sessions).toBe(2);
  });

  it("counts a bar that reaches both as the stop first", () => {
    const bars = [bar(0, 0, 100, 100, 100), bar(1, 0, 100, 100.3, 99.7)];
    const table = buildCheckpointOdds(bars, 1);
    const row = table.rows.find(
      (r) => r.direction === "UP" && r.movePct === 0.002 && r.back === 1,
    );
    expect(row).toMatchObject({ samples: 1, chance: 0 });
  });
});

describe("checkpointChance", () => {
  const table = {
    builtAt: 1,
    sessions: 100,
    rows: [
      { underlying: SYM, direction: "UP" as const, fromMinute: 120, movePct: 0.002, back: 1, samples: 50, chance: 0.31 },
      { underlying: SYM, direction: "UP" as const, fromMinute: 120, movePct: 0.004, back: 1, samples: 50, chance: 0.22 },
      { underlying: SYM, direction: "UP" as const, fromMinute: 180, movePct: 0.002, back: 1, samples: 10, chance: 0.9 },
    ],
  };
  const ask = (minutesSinceOpen: number, movePct: number) =>
    checkpointChance(table, { underlying: SYM, direction: "UP", minutesSinceOpen, movePct, back: 1 });

  it("takes the hour bucket and the nearest move size", () => {
    expect(ask(150, 0.0022)).toBe(0.31);
    expect(ask(150, 0.0037)).toBe(0.22);
  });

  it("has no answer without enough samples, or for a move far from any measured", () => {
    expect(ask(200, 0.002)).toBeNull(); // 10 samples
    expect(ask(150, 0.02)).toBeNull(); // 5× the largest
  });
});
