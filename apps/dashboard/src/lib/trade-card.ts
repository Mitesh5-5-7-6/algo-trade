import type { TradeCard } from "@neelkanth/core";

export type { TradeCard };

/** A price for a card: Indian grouping, at most two decimals, or a dash. */
export function price(value: number | null): string {
  return value === null
    ? "—"
    : value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/** The card's time of day in IST, HH:MM. */
export function cardTime(ts: number): string {
  return new Date(ts + 19_800_000).toISOString().slice(11, 16);
}

/** `NSE:BANKNIFTY26NOV62100CE` → `BANKNIFTY26NOV62100CE`. */
export function bareSymbol(symbol: string): string {
  return symbol.replace(/^[A-Z]+:/, "");
}

/** Where the card's numbers come from, in the operator's words. */
export function describeBasis(card: TradeCard): string {
  switch (card.basis) {
    case "OPTION_STRATEGY":
      return "The option strategy's own order";
    case "INDEX_SUGGESTED":
      return card.estimated
        ? `Suggested ATM option; SL and target estimated from the index at delta ${String(card.assumedDelta ?? 0.5)}`
        : "Suggested ATM option; its premium is unknown";
    case "DIRECT":
      return "The symbol itself";
  }
}

/** What became of a card's entry, as the API serves it (2026-11-20). */
export type CardLive =
  | {
      state: "OPEN";
      symbol: string;
      qty: number;
      avgEntryPrice: number;
      ltp: number | null;
      ltpAt: number | null;
      unrealizedPnl: number | null;
      stopLoss: number | null;
      target: number | null;
      stale: boolean;
    }
  | {
      state: "CLOSED";
      symbol: string;
      exitPrice: number | null;
      exitReason: string | null;
      exitTime: number | null;
      netPnl: number | null;
    }
  | { state: "NOT_FILLED" };

export type LiveTradeCard = TradeCard & { live?: CardLive };

/**
 * The three-part target the Exit Engine runs (PLAN.md 14.17): the way from
 * the buy price to the final target in equal thirds. From the live position
 * when there is one — those are the levels the engine judges, an index
 * strategy's in index points — else from the card's own numbers.
 *
 * `stopAtEntry`: the stop has been moved to the buy price, which the engine
 * does only once T1 is reached and the chance of T2 was good enough to hold.
 */
export interface CardCheckpoints {
  t1: number;
  t2: number;
  t3: number;
  /** SL1 / SL2 on the way to the stop, while the stop is still below the buy price. */
  sl1: number | null;
  sl2: number | null;
  stop: number | null;
  /** The symbol the levels are in: the option, or the index a strategy holds. */
  on: string;
  /** The stop has moved up: past the buy price (after T1) or past T1 (after T2). */
  stopAtEntry: boolean;
  stopPastT1: boolean;
  /** A rebound trade (14.19 rule 3): its target was lowered to T1. */
  rebound: boolean;
}

export function cardCheckpoints(card: LiveTradeCard): CardCheckpoints | null {
  const live = card.live?.state === "OPEN" ? card.live : null;
  const entry = live?.avgEntryPrice ?? card.entry;
  // A rebound trade's live target is its T1; the levels stay those of the
  // strategy's own target, which only an option strategy's card has in the
  // same units as its position.
  const rebound =
    live !== null &&
    card.basis === "OPTION_STRATEGY" &&
    live.target !== null &&
    card.target !== null &&
    Math.abs(live.target - card.target) > 0.01 * Math.abs(card.target);
  const target = rebound ? card.target : (live?.target ?? card.target);
  const on = live?.symbol ?? card.contract ?? card.underlying;
  if (entry === null || target === null || target === entry) return null;
  const third = (target - entry) / 3;
  const long = target > entry;
  const sign = long ? 1 : -1;
  const stop = live === null ? card.stopLoss : live.stopLoss;
  const t1 = entry + third;
  // SL1 / SL2 exist only while the stop is still on the loss side.
  const lossSide = stop !== null && sign * (entry - stop) > 0;
  const riskPart = lossSide ? Math.abs(entry - stop) / 3 : 0;
  return {
    t1,
    t2: entry + 2 * third,
    t3: target,
    sl1: lossSide ? entry - sign * riskPart : null,
    sl2: lossSide ? entry - sign * 2 * riskPart : null,
    stop,
    on,
    stopAtEntry: stop !== null && sign * (stop - entry) >= -0.005,
    stopPastT1: stop !== null && sign * (stop - t1) >= -0.005,
    rebound,
  };
}

/** How long ago a price arrived, in the fewest words: "5s", "3m", "22h". */
export function age(ts: number | null | undefined, now: number): string {
  if (ts === null || ts === undefined) return "no price yet";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${String(s)}s ago`;
  if (s < 3600) return `${String(Math.round(s / 60))}m ago`;
  return `${String(Math.round(s / 3600))}h ago`;
}

/**
 * Where a price sits between the stop (0) and the target (1), for a progress
 * bar; clamped to the bar. Null without both levels. A short position's stop
 * is above its target, and the same arithmetic holds.
 */
export function progress(
  value: number | null | undefined,
  stop: number | null | undefined,
  target: number | null | undefined,
): number | null {
  if (
    value === null ||
    value === undefined ||
    stop === null ||
    stop === undefined ||
    target === null ||
    target === undefined ||
    target === stop
  )
    return null;
  return Math.min(1, Math.max(0, (value - stop) / (target - stop)));
}

/** How a closed trade ended, in the operator's words. */
export function describeExit(reason: string | null): string {
  switch (reason) {
    case "TAKE_PROFIT":
      return "Target hit";
    case "STOP_LOSS":
      return "Stopped out";
    case "SESSION_CLOSE":
      return "Squared off at 15:12";
    case "STRATEGY_EXIT":
      return "Strategy exit";
    case "MANUAL":
      return "Closed by hand";
    default:
      return reason ?? "Closed";
  }
}
