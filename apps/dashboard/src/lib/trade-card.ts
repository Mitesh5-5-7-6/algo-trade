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
