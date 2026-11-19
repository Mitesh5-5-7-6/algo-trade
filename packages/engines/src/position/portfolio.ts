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

/**
 * The capital one strategy is sized against (operator decision 2026-11-18).
 *
 * With an allocation, it is the strategy's own: its allocation, the positions
 * IT holds, and the P&L IT realized today. Without one, the account's, as
 * before. The account-wide limits are checked elsewhere either way.
 */
export function portfolioForStrategy(input: {
  strategyId: string | undefined;
  /** The strategy's own capital, or undefined to share the account's. */
  allocation: number | undefined;
  openPositions: readonly Position[];
  priceOf: (symbol: string) => number | null;
  accountCapital: number;
  accountRealizedToday: number;
  strategyRealizedToday: (strategyId: string) => number;
}): Portfolio {
  if (input.strategyId === undefined || input.allocation === undefined)
    return computePortfolio(
      input.openPositions,
      input.priceOf,
      input.accountCapital,
      input.accountRealizedToday,
    );
  const own = input.strategyId;
  return computePortfolio(
    input.openPositions.filter((p) => p.strategyId === own),
    input.priceOf,
    input.allocation,
    input.strategyRealizedToday(own),
  );
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
