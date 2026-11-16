import type { SessionPool } from "./pool.js";
import { OddsRefusal } from "./refusal.js";

/**
 * Bumped whenever the same plan, pool, seed and window would give different
 * odds — the draw, the order of the checks, or how an outcome is scored.
 */
export const ODDS_RESAMPLING_VERSION = "1";

/** One plan: where it got in, and where it gets out either way. */
export interface OddsPlan {
  side: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  /**
   * The bar of the session the entry was decided on, counted from the bell
   * (0 is 09:15). The bars after it are the ones replayed.
   */
  entryBar: number;
}

export interface ResampleOptions {
  replays: number;
  seed: number;
  /** How many bars either side of its own time of day a draw may come from. */
  window: number;
}

export interface ResampleResult {
  replays: number;
  seed: number;
  window: number;
  /** The target's distance in units of the stop's: what a win pays. */
  targetR: number;
  targetFirst: number;
  stopFirst: number;
  /** Neither level reached by the close. */
  neither: number;
  /**
   * Stops reached by a bar that OPENED beyond the stop. Each is scored at
   * −1R, which understates it: the real fill is at the open, past the stop.
   */
  gapThroughStop: number;
  /** +targetR at the target, −1 at the stop, otherwise where it closed. */
  averageR: number;
  /**
   * Where the replayed days closed, as percentiles of the closing price.
   * Every replay runs to the close, past the plan's own exit: the bands
   * describe the day, not the trade.
   */
  closeBands: CloseBands;
}

export interface CloseBands {
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

/**
 * Replay the rest of a plan's day many times over, each bar drawn from past
 * sessions' bars at the same time of day (design §6.1 D3, D4, D10).
 *
 * A drawn bar is taken as ratios to the close before it and scaled to where
 * this replay's price now stands, so a past day's level does not matter —
 * only how its bars moved. The stop is checked before the target, so a bar
 * that reaches both counts as the stop (D4).
 *
 * What this cannot show (D9): each bar is drawn on its own, so a replayed day
 * has none of a real day's momentum or volatility clustering.
 */
export function resample(
  plan: OddsPlan,
  pool: SessionPool,
  options: ResampleOptions,
): ResampleResult {
  const long = plan.side === "LONG";
  if (long ? plan.stop >= plan.entry : plan.stop <= plan.entry)
    throw new OddsRefusal(
      `a ${long ? "long" : "short"}'s stop must be ${long ? "below" : "above"} its entry`,
    );
  if (long ? plan.target <= plan.entry : plan.target >= plan.entry)
    throw new OddsRefusal(
      `a ${long ? "long" : "short"}'s target must be ${long ? "above" : "below"} its entry`,
    );
  if (pool.sessions.length === 0)
    throw new OddsRefusal("no sessions in the pool: nothing to draw from");
  const lastBar = pool.barsPerSession - 1;
  if (
    !Number.isInteger(plan.entryBar) ||
    plan.entryBar < 0 ||
    plan.entryBar > lastBar
  )
    throw new OddsRefusal(
      `entryBar ${String(plan.entryBar)} is not a bar of a ${String(pool.barsPerSession)}-bar session`,
    );

  const risk = Math.abs(plan.entry - plan.stop);
  const targetR = Math.abs(plan.target - plan.entry) / risk;
  const random = mulberry32(options.seed);
  const span = 2 * options.window + 1;

  let targetFirst = 0;
  let stopFirst = 0;
  let gapThroughStop = 0;
  let totalR = 0;
  const closes = new Float64Array(options.replays);

  for (let replay = 0; replay < options.replays; replay += 1) {
    let price = plan.entry;
    let outcome: "TARGET" | "STOP" | null = null;
    for (let bar = plan.entryBar + 1; bar <= lastBar; bar += 1) {
      const session =
        pool.sessions[Math.floor(random() * pool.sessions.length)];
      const offset = Math.floor(random() * span) - options.window;
      // Never bar 0: its ratio would be to the day before, the overnight gap.
      const at = Math.min(lastBar, Math.max(1, bar + offset));
      const drawn = session?.bars[at];
      const before = session?.bars[at - 1];
      if (drawn === undefined || before === undefined)
        throw new Error("the pool holds a session shorter than barsPerSession");
      // The plan is decided once; the day carries on to its close regardless.
      if (outcome === null) {
        const open = (price * drawn.open) / before.close;
        const high = (price * drawn.high) / before.close;
        const low = (price * drawn.low) / before.close;
        if (long ? low <= plan.stop : high >= plan.stop) {
          outcome = "STOP";
          if (long ? open <= plan.stop : open >= plan.stop) gapThroughStop += 1;
        } else if (long ? high >= plan.target : low <= plan.target) {
          outcome = "TARGET";
        }
      }
      price = (price * drawn.close) / before.close;
    }
    closes[replay] = price;

    if (outcome === "TARGET") {
      targetFirst += 1;
      totalR += targetR;
    } else if (outcome === "STOP") {
      stopFirst += 1;
      totalR -= 1;
    } else {
      totalR += ((long ? 1 : -1) * (price - plan.entry)) / risk;
    }
  }

  return {
    replays: options.replays,
    seed: options.seed,
    window: options.window,
    targetR,
    targetFirst,
    stopFirst,
    neither: options.replays - targetFirst - stopFirst,
    gapThroughStop,
    averageR: totalR / options.replays,
    closeBands: bandsOf(closes),
  };
}

/** Nearest-rank percentiles: each band is a close some replay really had. */
function bandsOf(closes: Float64Array): CloseBands {
  const sorted = closes.slice().sort();
  const at = (percentile: number): number =>
    sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)] ??
    Number.NaN;
  return { p5: at(5), p25: at(25), p50: at(50), p75: at(75), p95: at(95) };
}

/** A small seeded generator (mulberry32): the same seed, the same draws. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
