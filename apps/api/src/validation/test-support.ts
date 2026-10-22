import { goldenBudget } from "../replay/test-support.js";
import type { Hypothesis } from "./hypothesis.js";

/** Test-only: a well-formed hypothesis (Phase 7 D3), to vary one field at a time. */
export function hypothesis(over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    hypothesisId: "H-0001",
    family: "F-test",
    statement: "RSI's reversions lose money on average",
    cell: {
      patternId: "RSI_REVERSION",
      strategyType: "RSI",
      symbol: "ALL",
      regime: "ALL",
    },
    metric: "expectancy",
    direction: "less",
    threshold: 0,
    alpha: 0.05,
    minSample: 30,
    inSample: { fromDate: "2025-09-29", toDate: "2026-03-27" },
    outOfSample: { fromDate: "2026-03-30", toDate: "2026-09-28" },
    run: {
      symbols: ["NSE:NIFTY50-INDEX"],
      indexSymbols: ["NSE:NIFTY50-INDEX"],
      interval: "5m",
      allocatedCapital: 1_000_000,
      limits: goldenBudget().limits,
      seed: 0,
    },
    pins: {
      strategyVersion: "cfg-abc",
      detectorVersion: "1.0.0",
      positionSizing: "1",
      exit: "1",
      slippage: "1",
      transactionCost: "1",
      regime: { version: "1" },
      attribution: { version: "1", windowBars: 0 },
    },
    registeredAt: 1_000,
    ...over,
  };
}
