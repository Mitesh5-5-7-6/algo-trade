import type { OrderSide } from "@neelkanth/core";

/**
 * Slippage model (plan/11 §4.3): real market orders rarely fill at the quote,
 * so the Paper Broker adjusts the execution price *adversely* — a buy fills a
 * little higher, a sell a little lower. Modeling this is what keeps paper P&L
 * honest (plan/11 §2); a costless fill would make Phase 1 a comforting lie.
 * Configurable so the operator can tune how conservative the rehearsal is
 * (plan/11 §10).
 */
export type SlippageModel =
  | { readonly kind: "none" }
  | { readonly kind: "percent"; readonly pct: number } // fraction, e.g. 0.0005 = 5bps
  | { readonly kind: "fixed"; readonly amount: number }; // absolute, per share

/** Apply adverse slippage to a reference price for the given side. */
export function applySlippage(
  price: number,
  side: OrderSide,
  model: SlippageModel,
): number {
  const adverse = side === "BUY" ? 1 : -1; // buy up, sell down
  switch (model.kind) {
    case "none":
      return price;
    case "percent":
      return price * (1 + adverse * model.pct);
    case "fixed":
      return price + adverse * model.amount;
  }
}
