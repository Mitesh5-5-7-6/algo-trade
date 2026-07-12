import type { Position } from "@neelkanth/core";

/**
 * The portfolio aggregate (plan/13 §4): a pure aggregation, no state of its
 * own beyond configuration. Two consumers need this — the dashboard and the
 * Risk Engine (whose size/exposure checks are questions about availableCapital
 * and exposure) — so computing it once keeps them reading the same numbers.
 */
export interface Portfolio {
  allocatedCapital: number;
  investedValue: number;
  currentValue: number;
  availableCapital: number;
  totalRealizedPnl: number;
  exposure: number;
}

export function computePortfolio(
  openPositions: readonly Position[],
  priceOf: (symbol: string) => number | null,
  allocatedCapital: number,
  realizedPnlToday: number,
): Portfolio {
  let investedValue = 0;
  let currentValue = 0;
  let totalRealizedPnl = 0;
  for (const position of openPositions) {
    investedValue += position.qty * position.avgEntryPrice;
    // Fall back to entry price when the feed has no live price, so an aggregate
    // is always available (staleness is surfaced elsewhere, plan/06 §7).
    const price = priceOf(position.symbol) ?? position.avgEntryPrice;
    currentValue += position.qty * price;
    totalRealizedPnl += position.realizedPnl;
  }
  return {
    allocatedCapital,
    investedValue,
    currentValue,
    availableCapital: allocatedCapital - investedValue + realizedPnlToday,
    totalRealizedPnl,
    exposure: allocatedCapital > 0 ? investedValue / allocatedCapital : 0,
  };
}
