import type { SessionPhase } from "@neelkanth/core";
import { istDateKey } from "../market-data/session-manager.js";

/** One intraday equity sample — total PnL split at an instant. */
export interface EquityPoint {
  ts: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

/**
 * The intraday equity curve (plan/06 §4 Overview "Day P&L · 09:15 → now").
 *
 * Deliberately IN-MEMORY: plan/07 persists PnL only as the daily EOD snapshot
 * ("live PnL is derived state and is deliberately not persisted per-update") —
 * the session curve is ephemeral operational display, so it lives in the
 * runtime and dies with it. An api restart mid-session restarts the curve; the
 * durable truth (pnl_snapshots) is unaffected. If restart-proofing is ever
 * wanted, back this seam with Redis — one place changes.
 *
 * Samples are taken on a timer (composition root) but recorded only while the
 * market is open — a flat overnight line would be noise, not information. A
 * new IST trading day clears the buffer (the curve is "09:15 → now", not
 * "since boot"). `maxPoints` caps memory as a backstop: a full session at
 * one-minute cadence is ~375 points.
 */
export class EquityCurveTracker {
  private buffer: EquityPoint[] = [];
  private day = "";

  constructor(private readonly maxPoints = 1000) {}

  sample(
    now: number,
    phase: SessionPhase,
    realizedPnl: number,
    unrealizedPnl: number,
  ): void {
    const today = istDateKey(now);
    if (today !== this.day) {
      // First sample of a new IST trading day — yesterday's curve is done.
      this.day = today;
      this.buffer = [];
    }
    if (phase !== "open") return;
    this.buffer.push({ ts: now, realizedPnl, unrealizedPnl });
    if (this.buffer.length > this.maxPoints) {
      this.buffer = this.buffer.slice(-this.maxPoints);
    }
  }

  /** Today's samples, oldest first. */
  points(): readonly EquityPoint[] {
    return this.buffer;
  }
}
