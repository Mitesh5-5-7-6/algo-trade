import type { Instrument, TradeMode } from "@neelkanth/core";

/** An NSE index: a price to read, never a contract the exchange trades. */
export const isIndexSymbol = (symbol: string): boolean =>
  symbol.endsWith("-INDEX");

/**
 * An index traded as a synthetic instrument: lot 1, in index points.
 *
 * The replay has always sized a traded index this way (Phase 4 Q1). The paper
 * runtime does too (Phase 14 D1), because FYERS lists the indices with a lot
 * size of 0 — the symbol master drops them, and risk would otherwise refuse
 * every entry as "lot size unknown". One definition, so a paper session and
 * the replay it is held against size the same Trade the same way. Never in
 * live: there is no index contract to place an order for.
 */
export function syntheticIndexInstrument(symbol: string): Instrument {
  return { symbol, kind: "EQUITY", lotSize: 1, tickSize: 0.05 };
}

/**
 * The instrument risk sizes against: the symbol master's, and — in paper
 * only — a synthetic one for an index the master does not list.
 */
export function instrumentLookup(
  mode: TradeMode,
  master: (symbol: string) => Instrument | null,
): (symbol: string) => Instrument | null {
  return (symbol) =>
    master(symbol) ??
    (mode === "paper" && isIndexSymbol(symbol)
      ? syntheticIndexInstrument(symbol)
      : null);
}
