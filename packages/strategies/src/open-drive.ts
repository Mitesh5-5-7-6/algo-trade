import { z } from "zod";
import {
  CandleIntervalSchema,
  type DerivativeTarget,
  type StrategyVerdict,
} from "@neelkanth/core";
import type { StrategyDefinition } from "./contract.js";
import { clamp01, hold } from "./shared.js";

/**
 * Open-drive — an EXPERIMENT for the paper forward test (PLAN.md 14.24,
 * operator decision 2026-11-28).
 *
 * From the charts of 17–27 Nov 2026: on every trend day the day's low (or
 * high) was made in the first 15–30 minutes and never revisited, and the
 * close came near the other extreme. Market Profile calls it an open-drive
 * day. The rule: at `atMinute` after the open, the index is at least
 * `minMovePct` away from the open and has never been back across it by more
 * than `tolerancePct` — buy the option in the drive's direction.
 *
 * The evidence is mixed, which is why this is a forward test and not a
 * strategy anyone should trust: on 14 months of 5m bars it won 60% of 25
 * trades from June 2026 (PF 1.92 at monthly-option decay) and lost badly in
 * the eight months before (PF 0.34). Judge it on 20+ paper trades.
 *
 * Bought one strike in the money on an expiry at least `minDaysToExpiry`
 * away, where decay per index point is a fraction of a near ATM's (14.24).
 * One decision a day: at the judging bar only.
 */
export const OpenDriveParamsSchema = z.object({
  /** Underlying as the symbol master names it, e.g. "NIFTY". */
  underlying: z.string().min(1).default("NIFTY"),
  interval: CandleIntervalSchema.default("5m"),
  /** Minutes after the open at which the drive is judged: the bar that closes then. */
  atMinute: z.number().int().positive().default(30),
  /** How far from the open the index must be by then. */
  minMovePct: z.number().gt(0).lt(0.05).default(0.005),
  /** How far back across the open still counts as "never came back". */
  tolerancePct: z.number().nonnegative().lt(0.01).default(0.001),
  /** -1 = one strike in the money. */
  strikeOffset: z.number().int().default(-1),
  minDaysToExpiry: z.number().int().nonnegative().default(5),
  /** Premium stop: about the index returning to the open, at ITM delta. */
  stopLossPct: z.number().gt(0).lt(1).default(0.3),
  targetPct: z.number().gt(0).default(0.6),
  quantity: z.number().int().positive().optional(),
  allowPut: z.boolean().default(true),
});

export type OpenDriveParams = z.infer<typeof OpenDriveParamsSchema>;

export interface OpenDriveState {
  params: OpenDriveParams;
  sessionMarker: number | null;
  decided: boolean;
}

export const openDrive: StrategyDefinition<OpenDriveParams, OpenDriveState> = {
  type: "OPEN_DRIVE",
  paramsSchema: OpenDriveParamsSchema,
  interval: (p) => p.interval,
  requiredIndicators: () => [],
  warmupBars: () => 1,
  derivative: (p): DerivativeTarget => ({
    underlying: p.underlying,
    kind: "OPTION",
    strikeOffset: p.strikeOffset,
    ...(p.minDaysToExpiry > 0 ? { minDaysToExpiry: p.minDaysToExpiry } : {}),
  }),
  init: (params) => ({ params, sessionMarker: null, decided: false }),
  analyze(context, state): StrategyVerdict {
    const p = state.params;
    const { sessionOpenTs } = context.session;
    if (state.sessionMarker !== sessionOpenTs) state.decided = false;
    state.sessionMarker = sessionOpenTs;
    if (state.decided) return hold("today's drive already judged");

    // The bar that CLOSES at atMinute: judged on bar time, so a restart or a
    // late bar cannot move the decision.
    const barMs = context.candle.ts - sessionOpenTs;
    const intervalMs =
      context.candles.length > 1
        ? context.candle.ts - (context.candles.at(-2)?.ts ?? context.candle.ts)
        : 5 * 60_000;
    const closesAt = (barMs + intervalMs) / 60_000;
    if (closesAt < p.atMinute) return hold("before the drive is judged");
    if (closesAt > p.atMinute) {
      state.decided = true;
      return hold("past the judging bar");
    }
    state.decided = true;

    const today = context.candles.filter((c) => c.ts >= sessionOpenTs);
    const first = today[0];
    if (first === undefined) return hold("no bars since the open");
    const open = first.open;
    const close = context.candle.close;
    const lowest = Math.min(...today.map((c) => c.low));
    const highest = Math.max(...today.map((c) => c.high));
    const move = (close - open) / open;

    if (move >= p.minMovePct && lowest >= open * (1 - p.tolerancePct)) {
      return {
        side: "BUY", // → buy a CALL
        confidence: clamp01(0.5 + (move - p.minMovePct) * 50),
        ...(p.quantity === undefined ? {} : { qtyProposal: p.quantity }),
        stopLossPct: p.stopLossPct,
        targetPct: p.targetPct,
        reason: `open-drive up: ${(move * 100).toFixed(2)}% from the open by ${String(p.atMinute)} min, never back below it`,
      };
    }
    if (
      p.allowPut &&
      -move >= p.minMovePct &&
      highest <= open * (1 + p.tolerancePct)
    ) {
      return {
        side: "SELL", // → buy a PUT (never a short)
        confidence: clamp01(0.5 + (-move - p.minMovePct) * 50),
        ...(p.quantity === undefined ? {} : { qtyProposal: p.quantity }),
        stopLossPct: p.stopLossPct,
        targetPct: p.targetPct,
        reason: `open-drive down: ${(-move * 100).toFixed(2)}% from the open by ${String(p.atMinute)} min, never back above it`,
      };
    }
    return hold("no open-drive today");
  },
};
