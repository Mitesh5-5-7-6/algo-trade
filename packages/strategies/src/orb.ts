import { z } from "zod";
import {
  CandleIntervalSchema,
  intervalMs,
  type StrategyVerdict,
} from "@neelkanth/core";
import type { StrategyDefinition } from "./contract.js";
import { clamp01, hold } from "./shared.js";

/**
 * Opening Range Breakout (plan/16 §5): let the first K minutes define the
 * range, then trade the close beyond it (close-based, to filter wick fakes).
 * At most one entry per direction per day. Its tax is false breakouts — break,
 * trigger, collapse back into the range (plan/16 §5 Weaknesses); the trap test
 * covers a fake that never closes beyond the range.
 *
 * The opening range is read out of the candle window using
 * `session.sessionOpenTs` (plan/15 §3) — bars whose bucket starts inside the
 * first `rangeMinutes` of the session. A change of that anchor marks a new
 * session, resetting the range and the per-direction one-shot flags.
 */
export const OrbParamsSchema = z
  .object({
    /** Opening-range window in minutes (plan/16 §5, default 15). */
    rangeMinutes: z.number().int().positive().default(15),
    interval: CandleIntervalSchema.default("5m"),
    /** Measured-move target as a multiple of the range (plan/16 §5). */
    targetMultiple: z.number().positive().default(1),
    /**
     * OPTIONAL ceiling on the entry size, in units.
     *
     * It used to default to 1, which the Risk Engine then read as "trade one
     * unit" — so every position was one share regardless of capital. An unset
     * quantity is the absence of an opinion, not an intent, so it is now left
     * off the signal entirely and the engine sizes from the risk budget
     * (plan/14 §4.4). Set it only to cap a strategy below what risk allows.
     */
    quantity: z.number().int().positive().optional(),
    allowShort: z.boolean().default(true),
    /** Optional volume confirmation: require V ≥ k · avgVol (plan/16 §5). */
    volumeMultiple: z.number().positive().optional(),
    avgVolPeriod: z.number().int().positive().default(20),
    /** Optional minimum range floor — screens out noise-level ranges (plan/16 §5). */
    minRange: z.number().nonnegative().optional(),
    /**
     * OPTIONAL entry window, in minutes after the session open, on the breakout
     * bar's CLOSE: from `entryFromMinute` (inclusive) up to `entryUntilMinute`
     * (exclusive). 45 and 135 are 10:00 and 11:30 on a 09:15 session.
     *
     * A direction's first breakout that closes outside the window is let go and
     * that direction is done for the day — the window selects fresh breakouts,
     * it does not turn an early one into a late entry.
     */
    entryFromMinute: z.number().int().nonnegative().optional(),
    entryUntilMinute: z.number().int().positive().optional(),
    /**
     * OPTIONAL trend filter: a long only while the breakout bar closes above
     * this symbol's own EMA of this period, a short only while it closes below.
     * A breakout against the trend, or exactly on the line, is let go as above.
     */
    trendEmaPeriod: z.number().int().positive().optional(),
  })
  .refine(
    (p) =>
      p.entryFromMinute === undefined ||
      p.entryUntilMinute === undefined ||
      p.entryUntilMinute > p.entryFromMinute,
    {
      path: ["entryUntilMinute"],
      message: "entryUntilMinute must be after entryFromMinute",
    },
  );

export type OrbParams = z.infer<typeof OrbParamsSchema>;

/**
 * A one-shot entry, in three states rather than two (§0.5.5).
 *
 * `proposed` is the state that was missing. A boolean forced the strategy to
 * choose between proposing twice while an order was in flight, and spending
 * the day's only entry on a signal that risk was about to block. ORB lost
 * whole days to the second: blocked at 09:20 by a stale market view, and
 * silent until the close.
 *
 * A `proposed` that never resolves stays `proposed` for the session, so the
 * failure mode is a missed entry rather than a duplicate one. That is the
 * right direction to fail in: a trade not taken costs an opportunity, a trade
 * taken twice costs money.
 *
 * `skipped` is a breakout the entry window or the trend filter let go: the
 * direction is done for the session, as after an entry, but nothing was
 * proposed and no outcome can release it.
 */
export type OrbEntryLatch = "none" | "proposed" | "entered" | "skipped";

export interface OrbState {
  params: OrbParams;
  /** The `sessionOpenTs` this state belongs to; a change means a new session. */
  sessionMarker: number | null;
  orHigh: number | null;
  orLow: number | null;
  upEntry: OrbEntryLatch;
  downEntry: OrbEntryLatch;
}

/**
 * What survives a restart (§0.5.6).
 *
 * Every field `analyze` reads back and none it does not: `params` are the
 * operator's stored config, and a second copy here could disagree with the
 * one the strategy was enabled with.
 */
const OrbSnapshotSchema = z.object({
  sessionMarker: z.number().nullable(),
  orHigh: z.number().nullable(),
  orLow: z.number().nullable(),
  upEntry: z.enum(["none", "proposed", "entered", "skipped"]),
  downEntry: z.enum(["none", "proposed", "entered", "skipped"]),
});

export const orb: StrategyDefinition<OrbParams, OrbState> = {
  type: "ORB",
  paramsSchema: OrbParamsSchema,
  interval: (p) => p.interval,
  requiredIndicators: (p) => [
    ...(p.volumeMultiple === undefined
      ? []
      : [{ kind: "avgVolume" as const, period: p.avgVolPeriod }]),
    ...(p.trendEmaPeriod === undefined
      ? []
      : [{ kind: "ema" as const, period: p.trendEmaPeriod }]),
  ],
  warmupBars: (p) =>
    Math.max(
      p.volumeMultiple === undefined ? 0 : p.avgVolPeriod,
      p.trendEmaPeriod ?? 0,
    ),
  init: (params) => ({
    params,
    sessionMarker: null,
    orHigh: null,
    orLow: null,
    upEntry: "none",
    downEntry: "none",
  }),
  analyze(context, state): StrategyVerdict {
    const p = state.params;
    const { sessionOpenTs } = context.session;

    // New session → reset the range and the one-shot flags (plan/16 §5). Keyed
    // on the session anchor rather than on a drop in minutesSinceOpen, so a
    // restart *within* a session resumes that session instead of declaring a
    // new one.
    if (state.sessionMarker !== sessionOpenTs) {
      state.orHigh = null;
      state.orLow = null;
      state.upEntry = "none";
      state.downEntry = "none";
    }
    state.sessionMarker = sessionOpenTs;

    const candle = context.candle;
    const rangeEndTs = sessionOpenTs + p.rangeMinutes * 60_000;

    // Bar buckets are labelled by their START, so a bar is inside the opening
    // range iff its ts precedes the window's end.
    if (candle.ts < rangeEndTs) return hold("building opening range");

    // Derive the range from the bars of the window rather than accumulating it
    // as they arrive. Accumulation silently required the engine to have been
    // running at the bell: started at 11:20, it had witnessed no opening-range
    // bar, held null, and returned "no opening range" for the rest of the day.
    // Reading it out of the candle window instead makes the range a property
    // of the session, identical however long the process has been up.
    //
    // Only a COMPLETE range is a range. On 2026-11-18 the feed came up at
    // 09:29 and the window held one bar of the three — built from 09:29's
    // ticks alone — and a "range" read from it was traded as if it were the
    // opening fifteen minutes. So every bucket of the window must be present
    // before the range is fixed; until then this holds and looks again on the
    // next bar, which is how bars caught up from the broker's history after
    // a late start (task 15.3) are taken in.
    if (state.orHigh === null || state.orLow === null) {
      const buckets = new Set<number>();
      let high: number | null = null;
      let low: number | null = null;
      for (const bar of context.candles) {
        if (bar.ts < sessionOpenTs || bar.ts >= rangeEndTs) continue;
        buckets.add(bar.ts);
        high = high === null ? bar.high : Math.max(high, bar.high);
        low = low === null ? bar.low : Math.min(low, bar.low);
      }
      const expected = Math.ceil(
        (p.rangeMinutes * 60_000) / intervalMs(p.interval),
      );
      if (buckets.size === 0 || high === null || low === null) {
        // Cold start so late that the opening bars have scrolled out of the
        // window — genuinely unknowable here, and not guessed at.
        return hold("no opening range for this session");
      }
      if (buckets.size < expected) {
        return hold(
          `opening range incomplete: ${String(buckets.size)} of ${String(expected)} bars`,
        );
      }
      state.orHigh = high;
      state.orLow = low;
    }

    const range = state.orHigh - state.orLow;
    if (p.minRange !== undefined && range < p.minRange) {
      return hold("opening range below floor");
    }

    // Optional volume gate (plan/16 §5).
    if (p.volumeMultiple !== undefined) {
      const avgVol = context.indicators[`avgvol${p.avgVolPeriod}`];
      if (avgVol === undefined) return hold("avgVol not ready");
      if (candle.volume < p.volumeMultiple * avgVol) {
        return hold("breakout volume below threshold");
      }
    }

    const midpoint = (state.orHigh + state.orLow) / 2; // default stop (plan/16 §5)

    const up = state.upEntry === "none" && candle.close > state.orHigh;
    const down =
      p.allowShort && state.downEntry === "none" && candle.close < state.orLow;

    // The optional entry window and trend filter judge a breakout once: one
    // they turn away is let go, and its direction is done for the session.
    if (up || down) {
      const latch = up ? "upEntry" : "downEntry";
      // The bar's own close against the session anchor — not the engine's
      // clock, which a restart or a late start would shift.
      const closedAt =
        (candle.ts + intervalMs(p.interval) - sessionOpenTs) / 60_000;
      if (
        (p.entryFromMinute !== undefined && closedAt < p.entryFromMinute) ||
        (p.entryUntilMinute !== undefined && closedAt >= p.entryUntilMinute)
      ) {
        state[latch] = "skipped";
        return hold("breakout outside the entry window");
      }
      if (p.trendEmaPeriod !== undefined) {
        const trend = context.indicators[`ema${p.trendEmaPeriod}`];
        // Not ready is not a verdict on the breakout: wait, spend nothing.
        if (trend === undefined) return hold("trend not ready");
        if (up ? candle.close <= trend : candle.close >= trend) {
          state[latch] = "skipped";
          return hold("breakout against the trend");
        }
      }
    }

    if (up) {
      // Proposed, not taken. What it becomes is decided by onSignalOutcome.
      state.upEntry = "proposed";
      const margin = (candle.close - state.orHigh) / range;
      return {
        side: "BUY",
        confidence: clamp01(0.5 + margin),
        ...(p.quantity === undefined ? {} : { qtyProposal: p.quantity }),
        stopLoss: midpoint,
        target: candle.close + p.targetMultiple * range,
        reason: "close above the opening-range high",
      };
    }

    if (down) {
      state.downEntry = "proposed";
      const margin = (state.orLow - candle.close) / range;
      return {
        side: "SELL",
        confidence: clamp01(0.5 + margin),
        ...(p.quantity === undefined ? {} : { qtyProposal: p.quantity }),
        stopLoss: midpoint,
        target: candle.close - p.targetMultiple * range,
        reason: "close below the opening-range low",
      };
    }

    return hold("no breakout");
  },

  /**
   * Confirm or release the one-shot latch (§0.5.5).
   *
   * A fill makes the entry real and spends the day's attempt. Anything else
   * — risk blocked it, the broker rejected it, the runner never forwarded it —
   * releases the latch, so the next bar that still qualifies may try again.
   *
   * Only a `proposed` latch moves. A late or duplicate resolution for an
   * entry already confirmed must not reopen it.
   */
  onSignalOutcome(state, resolution) {
    const latch = resolution.side === "BUY" ? "upEntry" : "downEntry";
    if (state[latch] !== "proposed") return;
    state[latch] = resolution.status === "FILLED" ? "entered" : "none";
  },

  /**
   * ORB is the strategy that most needs to survive a restart (§0.5.6): the
   * opening range is built once, in the first fifteen minutes, and a process
   * that starts at 11:00 can never rebuild it — the bars are in Mongo, but the
   * range they define is not. Without this it spent every afternoon holding
   * for a level it no longer knew.
   */
  stateVersion: "1.0.0",
  snapshot: (state) => ({
    sessionMarker: state.sessionMarker,
    orHigh: state.orHigh,
    orLow: state.orLow,
    upEntry: state.upEntry,
    downEntry: state.downEntry,
  }),
  restore: (state, snapshot) => {
    const parsed = OrbSnapshotSchema.parse(snapshot);
    state.sessionMarker = parsed.sessionMarker;
    state.orHigh = parsed.orHigh;
    state.orLow = parsed.orLow;
    state.upEntry = parsed.upEntry;
    state.downEntry = parsed.downEntry;
  },
};
