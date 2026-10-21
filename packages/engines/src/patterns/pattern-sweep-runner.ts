import type {
  Candle,
  CandleInterval,
  PatternOccurrence,
} from "@neelkanth/core";
import type { RunnableDetector } from "@neelkanth/patterns";
import { sweepPatterns, type SweepResult } from "./pattern-sweep.js";

/** Where the sweep reads candles from. */
export interface SweepCandleSource {
  /** Bars in `[fromTs, toTs)`, oldest first — `CandlesRepository.findRange`. */
  findRange(
    symbol: string,
    interval: CandleInterval,
    fromTs: number,
    toTs: number,
  ): Promise<Candle[]>;
}

/** Where the sweep writes what it found. */
export interface ObservationSink {
  /** Returns how many rows were NEW — `PatternObservationsRepository`. */
  recordMany(
    occurrences: readonly PatternOccurrence[],
    observedAt: number,
  ): Promise<number>;
}

export interface SweepRunnerDeps {
  candles: SweepCandleSource;
  observations: ObservationSink;
  detectors: readonly RunnableDetector[];
  /** Injected, so a run is reproducible and a test needs no fake timers. */
  now: () => number;
  /** Required error sink — no silent failures (plan/02 §10). */
  onError: (error: unknown, context: Record<string, unknown>) => void;
}

export interface SweepRunReport extends SweepResult {
  symbol: string;
  interval: CandleInterval;
  fromTs: number;
  toTs: number;
  /** Detections the store did not already have. */
  recorded: number;
  /** Detections that were already stored — a re-run, not an error. */
  alreadyKnown: number;
}

/**
 * Runs the sweep against storage (§5.4).
 *
 * Behind ports rather than repositories, so `engines` keeps its rule of never
 * importing a database driver, and so the whole run is testable with two small
 * fakes instead of a Mongo instance.
 *
 * **Re-running is the normal case, not an exception.** Backfills arrive late,
 * detectors get added, a day gets re-fetched. The store's identity rule makes
 * a repeat write a no-op, and this reports the difference between "found 40,
 * stored 40" and "found 40, stored 0" so an operator can tell a fresh sweep
 * from a repeat without querying anything.
 */
export class PatternSweepRunner {
  private readonly deps: SweepRunnerDeps;

  constructor(deps: SweepRunnerDeps) {
    this.deps = deps;
  }

  /**
   * Sweep `[fromTs, toTs)` for one series.
   *
   * Half-open, like every other range query here, so consecutive days tile
   * exactly and no bar is judged twice.
   */
  async run(
    symbol: string,
    interval: CandleInterval,
    fromTs: number,
    toTs: number,
  ): Promise<SweepRunReport> {
    const empty: SweepRunReport = {
      symbol,
      interval,
      fromTs,
      toTs,
      occurrences: [],
      barsScanned: 0,
      skippedForWarmup: {},
      sessions: [],
      recorded: 0,
      alreadyKnown: 0,
    };
    if (toTs <= fromTs) return empty;

    try {
      const candles = await this.deps.candles.findRange(
        symbol,
        interval,
        fromTs,
        toTs,
      );
      const result = sweepPatterns({
        symbol,
        interval,
        candles,
        detectors: this.deps.detectors,
      });
      const recorded = await this.deps.observations.recordMany(
        result.occurrences,
        this.deps.now(),
      );
      return {
        ...empty,
        ...result,
        recorded,
        alreadyKnown: result.occurrences.length - recorded,
      };
    } catch (error) {
      // A failed sweep must not look like a market with no patterns in it.
      // Reporting and returning an empty result would be exactly that lie, so
      // this reports AND rethrows — the caller decides whether one bad day
      // stops a year-long backfill.
      this.deps.onError(error, {
        where: "PatternSweepRunner.run",
        symbol,
        interval,
        fromTs,
        toTs,
      });
      throw error;
    }
  }
}
