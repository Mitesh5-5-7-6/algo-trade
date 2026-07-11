import type { OrderSide } from "@neelkanth/core";

/**
 * The charge model (plan/11 §5). Paper P&L must reflect the **real** cost
 * stack, which on Indian exchanges is a composite: brokerage, STT/CTT,
 * exchange transaction charges, SEBI turnover fee, GST, and stamp duty. Rates
 * are NOT hardcoded as truth (plan/11 §5) — they differ by segment and change
 * over time, so they live in configuration and can be kept equal to the live
 * broker's real schedule. That equality is the whole point (fidelity, plan/11 §2).
 */
export interface ChargeConfig {
  /** Flat brokerage per executed order. */
  brokeragePerOrder: number;
  /** Percentage brokerage; effective brokerage = min(flat, pct·turnover). */
  brokeragePct: number;
  /** Securities Transaction Tax — intraday equity: charged on the SELL leg. */
  sttPct: number;
  /** Exchange transaction charge (on turnover). */
  exchangeTxnPct: number;
  /** SEBI turnover fee (on turnover). */
  sebiPct: number;
  /** GST on (brokerage + exchange txn + SEBI). */
  gstPct: number;
  /** Stamp duty — charged on the BUY leg. */
  stampPct: number;
}

/**
 * Illustrative Indian intraday-equity defaults (approximate). These are a
 * configuration starting point, not authoritative rates — set them to the live
 * broker's real schedule (plan/11 §5).
 */
export const DEFAULT_CHARGES: ChargeConfig = {
  brokeragePerOrder: 20,
  brokeragePct: 0.0003,
  sttPct: 0.00025,
  exchangeTxnPct: 0.0000297,
  sebiPct: 0.000001,
  gstPct: 0.18,
  stampPct: 0.00003,
};

/** Total charges for a fill of `qty` at `price` on the given side. */
export function computeCharges(
  price: number,
  qty: number,
  side: OrderSide,
  config: ChargeConfig,
): number {
  const turnover = price * qty;
  const brokerage = Math.min(
    config.brokeragePerOrder,
    turnover * config.brokeragePct,
  );
  const stt = side === "SELL" ? turnover * config.sttPct : 0;
  const exchangeTxn = turnover * config.exchangeTxnPct;
  const sebi = turnover * config.sebiPct;
  const gst = (brokerage + exchangeTxn + sebi) * config.gstPct;
  const stamp = side === "BUY" ? turnover * config.stampPct : 0;
  return brokerage + stt + exchangeTxn + sebi + gst + stamp;
}
