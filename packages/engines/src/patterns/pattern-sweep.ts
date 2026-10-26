import {
  intervalMs,
  istDateKey,
  sessionOpenTsFor,
  type Candle,
  type CandleInterval,
  type PatternOccurrence,
  type SessionConfig,
} from "@neelkanth/core";
import {
  atr,
  avgVolume,
  ema,
  indicatorKey,
  rsi,
  sma,
  vwap,
  type Indicator,
  type IndicatorSpec,
} from "@neelkanth/indicators";
import type { PatternContext, RunnableDetector } from "@neelkanth/patterns";

/**
 * The detector sweep (§5.3–5.4): run every detector over stored candles and
 * produce the occurrences.
 *
 * **It reuses the production indicator folds, not a copy of them.** The
 * `IndicatorEngine` cannot be used directly here — it is async and writes to
 * Redis and the event bus, none of which a historical sweep should touch — but
 * it and this both fold the same `@neelkanth/indicators` implementations. A
 * second implementation of EMA for research would mean research measures
 * something the live system never computed, and nobody would notice until a
 * strategy behaved differently in production than in its backtest.
 *
 * Pure and synchronous: candles in, occurrences out. Persistence is the
 * caller's job, which is what lets the whole thing be tested without a
 * database.
 */

/** Everything one sweep needs. */
export interface SweepRequest {
  symbol: string;
  interval: CandleInterval;
  /** Oldest → newest. May span many sessions. */
  candles: readonly Candle[];
  detectors: readonly RunnableDetector[];
  /** Defaults to NSE hours; supply the real calendar for other exchanges. */
  session?: SessionConfig;
}

/** What a sweep produced, and what it declined to judge. */
export interface SweepResult {
  occurrences: PatternOccurrence[];
  /** Bars examined. */
  barsScanned: number;
  /**
   * Bars skipped per detector because its indicators had not converged.
   *
   * Reported rather than swallowed. "This detector found nothing" and "this
   * detector was never able to look" produce the same empty result, and only
   * one of them is a fact about the market.
   */
  skippedForWarmup: Record<string, number>;
  /**
   * Warm bars each detector declined because the volume its answer rests on
   * is not trusted (Phase 5 D3) — zero for a price-only detector. Reported for
   * the same reason as warm-up: on the stored index year every bar is
   * SUSPECT, and a volume detector's silence there is not a market fact.
   */
  declinedForVolume: Record<string, number>;
  /** Sessions encountered, in order — the unit session-anchored state resets on. */
  sessions: string[];
}

/** A fold with its state boxed away, so heterogeneous indicators share a map. */
interface RunningIndicator {
  readonly key: string;
  readonly sessionAnchored: boolean;
  fold(bar: Candle): void;
  read(): Readonly<Record<string, number>> | null;
  ready(): boolean;
  reset(): void;
}

function box<S>(indicator: Indicator<S>): RunningIndicator {
  let state = indicator.init();
  return {
    key: indicator.key,
    sessionAnchored: indicator.sessionAnchored,
    fold(bar) {
      state = indicator.fold(state, bar);
    },
    read: () => indicator.read(state),
    ready: () => indicator.ready(state),
    reset() {
      state = indicator.init();
    },
  };
}

/**
 * Build the fold a spec asks for.
 *
 * Deliberately the same mapping as `registerIndicatorSpec`. If a seventh
 * indicator kind is added, both must learn it — the switch is exhaustive, so
 * TypeScript will say so rather than letting the sweep silently skip it.
 */
function foldFor(spec: IndicatorSpec): RunningIndicator {
  switch (spec.kind) {
    case "ema":
      return box(ema(spec.period));
    case "rsi":
      return box(rsi(spec.period));
    case "atr":
      return box(atr(spec.period));
    case "vwap":
      return box(vwap());
    case "sma":
      return box(sma(spec.period));
    case "avgVolume":
      return box(avgVolume(spec.period));
  }
}

/**
 * Run every detector over the candles.
 *
 * Two decisions worth stating, because both change what ends up in the store:
 *
 * **The candle window is one session.** A detector never sees across the
 * overnight gap. An opening range must be session-scoped to mean anything, and
 * a "20-bar high" spanning yesterday's close into today's open is a level that
 * the gap already invalidated. Structures that genuinely span days are the job
 * of a daily-interval sweep, not of a 5-minute one pretending to have memory.
 *
 * **Indicators are not reset between sessions unless they say to be.** EMA and
 * RSI carry across the bell, exactly as they do live; VWAP resets, because it
 * is session-anchored. That flag is the indicator's own, so the sweep cannot
 * disagree with the live engine about which is which.
 */
export function sweepPatterns(request: SweepRequest): SweepResult {
  const { symbol, interval, candles, detectors } = request;
  const occurrences: PatternOccurrence[] = [];
  const skippedForWarmup: Record<string, number> = {};
  const declinedForVolume: Record<string, number> = {};
  const sessions: string[] = [];

  if (candles.length === 0 || detectors.length === 0) {
    return {
      occurrences,
      barsScanned: 0,
      skippedForWarmup,
      declinedForVolume,
      sessions,
    };
  }

  assertJudgeableInOrder(request);

  // One fold per key, shared across detectors: three detectors wanting EMA(9)
  // cost one computation, as they do in the live engine.
  const folds = new Map<string, RunningIndicator>();
  // Which keys each detector needs before its answer means anything.
  const required = new Map<string, string[]>();
  for (const detector of detectors) {
    const keys: string[] = [];
    for (const spec of detector.requiredIndicators()) {
      const key = indicatorKey(spec);
      keys.push(key);
      if (!folds.has(key)) folds.set(key, foldFor(spec));
    }
    required.set(detector.patternId, keys);
    skippedForWarmup[detector.patternId] = 0;
    declinedForVolume[detector.patternId] = 0;
  }

  const barMs = intervalMs(interval);
  let sessionDate: string | null = null;
  let sessionOpenTs = 0;
  let sessionBars: Candle[] = [];
  let barsInSweep = 0;
  let previousIndicators: Record<string, number> = {};
  let indicators: Record<string, number> = {};

  for (const candle of candles) {
    const dateKey = istDateKey(candle.ts);
    if (dateKey !== sessionDate) {
      sessionDate = dateKey;
      sessions.push(dateKey);
      sessionOpenTs = sessionOpenTsFor(candle.ts, request.session);
      sessionBars = [];
      for (const fold of folds.values()) {
        if (fold.sessionAnchored) fold.reset();
      }
      // The previous bar is the prior session's LAST bar — but without its
      // session-anchored values. Yesterday's closing VWAP is not the previous
      // value of today's VWAP, and comparing this morning's first bar against
      // it would manufacture a reclaim that never happened. Rolling indicators
      // keep theirs, because a cross across an overnight gap is a real event.
      previousIndicators = Object.fromEntries(
        Object.entries(indicators).filter(
          ([key]) => folds.get(key)?.sessionAnchored !== true,
        ),
      );
    } else {
      previousIndicators = indicators;
    }

    for (const fold of folds.values()) fold.fold(candle);
    indicators = readAll(folds);
    sessionBars.push(candle);
    barsInSweep += 1;

    const context: PatternContext = {
      symbol,
      interval,
      candle,
      // Ends at the decision bar, so no detector can reach a later one.
      candles: sessionBars,
      indicators,
      previousIndicators,
      // Measured at the bar's CLOSE: `ts` is the bucket start, and a detector
      // judging this bar has by definition seen all of it.
      minutesSinceOpen: (candle.ts + barMs - sessionOpenTs) / 60_000,
      sessionOpenTs,
    };

    for (const detector of detectors) {
      if (!isWarm(detector, required, folds, barsInSweep)) {
        skippedForWarmup[detector.patternId] =
          (skippedForWarmup[detector.patternId] ?? 0) + 1;
        continue;
      }
      if (!detector.volumeTrusted(context)) {
        declinedForVolume[detector.patternId] =
          (declinedForVolume[detector.patternId] ?? 0) + 1;
        continue;
      }
      const occurrence = detector.detect(context);
      if (occurrence !== null) occurrences.push(occurrence);
    }
  }

  return {
    occurrences,
    barsScanned: barsInSweep,
    skippedForWarmup,
    declinedForVolume,
    sessions,
  };
}

/**
 * One series, strictly ascending (Phase 5 D7). Out of order, a later bar would
 * be judged — and its indicators folded — before an earlier one; duplicated,
 * one bar would count twice. Refused, not re-sorted: the store returns bars in
 * order, so disorder means a broken caller, and quietly fixing it would hide
 * that.
 */
function assertJudgeableInOrder(request: SweepRequest): void {
  let previous = -Infinity;
  for (const candle of request.candles) {
    if (
      candle.symbol !== request.symbol ||
      candle.interval !== request.interval
    ) {
      throw new Error(
        `sweep of ${request.symbol} ${request.interval} was given a ${candle.symbol} ${candle.interval} bar`,
      );
    }
    if (candle.ts <= previous) {
      throw new Error(
        `sweep of ${request.symbol}: bars must be strictly ascending by ts (${String(candle.ts)} after ${String(previous)})`,
      );
    }
    previous = candle.ts;
  }
}

function readAll(folds: Map<string, RunningIndicator>): Record<string, number> {
  const values: Record<string, number> = {};
  for (const fold of folds.values()) {
    const read = fold.read();
    if (read !== null) Object.assign(values, read);
  }
  return values;
}

/**
 * Whether a detector has seen enough to be believed on this bar.
 *
 * Both conditions matter. An unconverged EMA still produces a number, and a
 * cross computed from two unconverged numbers is indistinguishable from a real
 * one once it is in the store — which is the most expensive kind of wrong,
 * because it inflates the sample with detections that mean nothing.
 */
function isWarm(
  detector: RunnableDetector,
  required: Map<string, string[]>,
  folds: Map<string, RunningIndicator>,
  barsSeen: number,
): boolean {
  if (barsSeen < detector.warmupBars()) return false;
  for (const key of required.get(detector.patternId) ?? []) {
    if (folds.get(key)?.ready() !== true) return false;
  }
  return true;
}
