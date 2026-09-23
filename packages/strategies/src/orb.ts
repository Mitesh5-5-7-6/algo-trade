import { z } from "zod";
import { CandleIntervalSchema, type StrategyVerdict } from "@neelkanth/core";
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
export const OrbParamsSchema = z.object({
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
});

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
 */
export type OrbEntryLatch = "none" | "proposed" | "entered";

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
  upEntry: z.enum(["none", "proposed", "entered"]),
  downEntry: z.enum(["none", "proposed", "entered"]),
});

export const orb: StrategyDefinition<OrbParams, OrbState> = {
  type: "ORB",
  paramsSchema: OrbParamsSchema,
  interval: (p) => p.interval,
  requiredIndicators: (p) =>
    p.volumeMultiple === undefined
      ? []
      : [{ kind: "avgVolume", period: p.avgVolPeriod }],
  warmupBars: (p) => (p.volumeMultiple === undefined ? 0 : p.avgVolPeriod),
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
    if (state.orHigh === null || state.orLow === null) {
      for (const bar of context.candles) {
        if (bar.ts < sessionOpenTs || bar.ts >= rangeEndTs) continue;
        state.orHigh =
          state.orHigh === null ? bar.high : Math.max(state.orHigh, bar.high);
        state.orLow =
          state.orLow === null ? bar.low : Math.min(state.orLow, bar.low);
      }
    }
    if (state.orHigh === null || state.orLow === null) {
      // Cold start so late that the opening bars have scrolled out of the
      // window — genuinely unknowable here, and not guessed at.
      return hold("no opening range for this session");
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

    if (state.upEntry === "none" && candle.close > state.orHigh) {
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

    if (
      p.allowShort &&
      state.downEntry === "none" &&
      candle.close < state.orLow
    ) {
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
