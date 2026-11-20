import type { Position, Trade, TradeCard } from "@neelkanth/core";

/** A position as the runtime serves it: with the last price it heard, and when. */
export type LivePosition = Position & {
  /** The last traded price the feed delivered, or absent if none yet. */
  ltp?: number;
  /** When that price arrived, epoch ms. */
  ltpAt?: number;
};

/**
 * What became of a trade card's entry (operator request 2026-11-20: "target
 * achieved but the order is still open" — the dashboard showed no live
 * state at all). Read-only: joins the card to its paper trade and, while open,
 * to the live position.
 */
export type CardLive =
  | {
      state: "OPEN";
      /** The symbol paper trading actually holds — the index for an ORB card. */
      symbol: string;
      qty: number;
      avgEntryPrice: number;
      ltp: number | null;
      ltpAt: number | null;
      unrealizedPnl: number | null;
      stopLoss: number | null;
      target: number | null;
      /** True when the price is older than `staleAfterMs` — the feed has lost it. */
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

export interface CardStatusInput {
  card: TradeCard;
  /** The paper trade whose entry was this card's signal, if any. */
  trade: Trade | null;
  /** The open position that trade belongs to, if it is still open. */
  position: LivePosition | null;
  now: number;
  /** A price older than this counts as stale while the market is open. */
  staleAfterMs?: number;
  marketOpen: boolean;
}

/** Two minutes: far longer than any gap between ticks on a traded contract. */
const STALE_AFTER_MS = 120_000;

export function cardLive(input: CardStatusInput): CardLive {
  const { trade, position } = input;
  if (trade === null) return { state: "NOT_FILLED" };
  if (trade.status === "CLOSED" || position === null)
    return {
      state: "CLOSED",
      symbol: trade.symbol,
      exitPrice: trade.exitPrice ?? null,
      exitReason: trade.exitReason ?? null,
      exitTime: trade.exitTime ?? null,
      netPnl: trade.netPnl ?? null,
    };
  const ltp = position.ltp ?? null;
  const ltpAt = position.ltpAt ?? null;
  const direction = position.side === "LONG" ? 1 : -1;
  return {
    state: "OPEN",
    symbol: position.symbol,
    qty: position.qty,
    avgEntryPrice: position.avgEntryPrice,
    ltp,
    ltpAt,
    unrealizedPnl:
      ltp === null
        ? null
        : direction * (ltp - position.avgEntryPrice) * position.qty,
    stopLoss: position.stopLoss ?? null,
    target: position.target ?? null,
    stale:
      input.marketOpen &&
      (ltpAt === null ||
        input.now - ltpAt > (input.staleAfterMs ?? STALE_AFTER_MS)),
  };
}
