import { describe, expect, it } from "vitest";
import type { StrategyConfig } from "@neelkanth/core";
import { createStrategyRegistry } from "@neelkanth/strategies";
import { runHistoricalReplay } from "../replay/run.js";
import { goldenBudget, historicalBars } from "../replay/test-support.js";
import { strategyEligibility } from "./eligibility.js";

/**
 * Task 6.2 (design D1): every registered strategy is evaluated or excluded
 * with its reason — and "excluded" means exactly "a replay would refuse it".
 */
const SYMBOL = "NSE:TESTCO-EQ";
const held = new Set([SYMBOL, "NSE:TESTINDEX-INDEX"]);

describe("strategy eligibility (6.2, D1)", () => {
  const rows = strategyEligibility(SYMBOL, "5m", held);

  it("accounts for every registered strategy", () => {
    expect(rows.map((r) => r.type)).toEqual(createStrategyRegistry().types());
    expect(rows).toHaveLength(8);
  });

  it("evaluates the three that trade the analysed instrument", () => {
    expect(rows.filter((r) => r.eligible).map((r) => r.type)).toEqual([
      "EMA_CROSSOVER",
      "RSI",
      "ORB",
    ]);
  });

  /** Chain-dependent first: that is the stronger reason, and spec §5.8's. */
  it("excludes the index-option strategies, each with its reason", () => {
    const excluded = Object.fromEntries(
      rows.filter((r) => !r.eligible).map((r) => [r.type, r.exclusion?.kind]),
    );
    expect(excluded).toEqual({
      INDEX_OPTION_MOMENTUM: "DERIVATIVE",
      INDEX_OPTION_FLOW_BREAKOUT: "DERIVATIVE",
      INDEX_OPTION_SENTIMENT_FADE: "DERIVATIVE",
      INDEX_OPTION_PCR_OI: "OPTION_CHAIN",
      OPTION_MOMENTUM_SCALPER: "OPTION_CHAIN",
    });
    for (const r of rows.filter((x) => !x.eligible))
      expect(r.exclusion?.reason).toContain(r.type);
  });

  it("reads a configured interval and a missing symbol", () => {
    const at15 = strategyEligibility(SYMBOL, "5m", held, {
      EMA_CROSSOVER: { interval: "15m" },
    }).find((r) => r.type === "EMA_CROSSOVER");
    expect(at15?.exclusion?.kind).toBe("INTERVAL");
    const absent = strategyEligibility("NSE:ABSENT-EQ", "5m", held);
    expect(absent.find((r) => r.type === "RSI")?.exclusion?.kind).toBe(
      "NO_BARS",
    );
  });

  /** The point of sharing the rule: the two can never disagree. */
  it("agrees with the replay, strategy by strategy", async () => {
    const candles = await historicalBars([0]);
    for (const row of rows) {
      const strategy: StrategyConfig = {
        strategyId: `str_${row.type.toLowerCase()}`,
        ownerId: "research",
        type: row.type,
        name: row.type,
        params: row.params,
        symbols: [SYMBOL],
        enabled: true,
        status: "active",
        createdAt: 0,
        updatedAt: 0,
      };
      const replay = runHistoricalReplay({
        strategy,
        candles,
        hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
        ...goldenBudget(),
        seed: 0,
      });
      if (row.eligible) await expect(replay).resolves.toBeDefined();
      else await expect(replay).rejects.toThrow(row.exclusion?.reason ?? "?");
    }
  }, 60_000);
});
