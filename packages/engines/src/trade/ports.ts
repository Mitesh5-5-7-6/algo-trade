import type { Trade } from "@neelkanth/core";

/**
 * Infrastructure the Trade Engine reads and writes through, injected so the
 * engine stays infra-free and unit-testable (plan/05 §3).
 */
export interface TradePorts {
  /** Persist a new or updated trade. Sole owner of the `trades` collection. */
  saveTrade(trade: Trade): Promise<void>;
  /** Every open trade, for hydrating after a restart. */
  loadOpenTrades(): Promise<Trade[]>;
}
