import type { Db } from "mongodb";
import { istDateKey, type CandleInterval } from "@neelkanth/core";
import {
  BacktestsRepository,
  COLLECTIONS,
  StrategyCandidatesRepository,
  WalkForwardResultsRepository,
} from "@neelkanth/db";
import { loadCandles } from "../replay/store.js";
import { warmupFrom } from "./run.js";
import {
  completeMonths,
  planFolds,
  walkForward,
  type WalkForwardResult,
  type WalkForwardSettings,
} from "./walk-forward.js";

/** The first and last stored session every instrument has (D5). */
export async function coveredSessions(
  db: Db,
  symbols: readonly string[],
  interval: CandleInterval,
): Promise<{ first: string; last: string } | null> {
  let first = "";
  let last = "9999-12-31";
  for (const symbol of symbols) {
    const ends = await Promise.all(
      [1, -1].map((order) =>
        db
          .collection(COLLECTIONS.candles)
          .find({ symbol, interval }, { projection: { _id: 0, ts: 1 } })
          .sort({ ts: order as 1 | -1 })
          .limit(1)
          .toArray(),
      ),
    );
    const [lo, hi] = ends.map((d) => d[0]?.["ts"] as number | undefined);
    if (lo === undefined || hi === undefined) return null;
    if (istDateKey(lo) > first) first = istDateKey(lo);
    if (istDateKey(hi) < last) last = istDateKey(hi);
  }
  return first === "" ? null : { first, last };
}

/**
 * Walk a declared candidate forward over the stored bars (Phase 13 D4, D5):
 * the folds are the complete months every instrument covers; the bars are
 * read once; the result is kept in `walk_forward_results`, and every
 * backtest it ran in `backtests`, each saying which fold and role it was —
 * insert-only. Reads `candles` and the candidate; writes those two only.
 */
export async function walkForwardFromStore(
  db: Db,
  candidateId: string,
  settings: WalkForwardSettings,
  keep:
    { save: false } | { save: true; walkForwardId: string; createdAt: number },
): Promise<{ result: WalkForwardResult; saved: boolean }> {
  const candidate = await new StrategyCandidatesRepository(db).findById(
    candidateId,
  );
  if (candidate === null) throw new Error(`no candidate ${candidateId}`);
  const covered = await coveredSessions(
    db,
    candidate.symbols,
    settings.interval,
  );
  if (covered === null)
    throw new Error(`no stored bars for ${candidate.symbols.join(", ")}`);
  const folds = planFolds(completeMonths(covered.first, covered.last));
  if (folds.length === 0)
    throw new Error(
      `the data (${covered.first} .. ${covered.last}) holds no complete three months followed by a complete month`,
    );
  const candles = await loadCandles(
    db,
    [...new Set([...candidate.symbols, settings.regime.symbol])],
    settings.interval,
    warmupFrom(folds[0]?.train.fromDate ?? covered.first),
    folds.at(-1)?.test.toDate ?? covered.last,
  );
  const { result, backtests } = await walkForward(
    candles,
    candidate,
    folds,
    settings,
  );
  if (!keep.save) return { result, saved: false };

  const saved = await new WalkForwardResultsRepository(db).save({
    walkForwardId: keep.walkForwardId,
    candidateId,
    createdAt: keep.createdAt,
    fingerprint: result.fingerprint,
    result: result as unknown as Record<string, unknown>,
  });
  if (saved) {
    const repo = new BacktestsRepository(db);
    for (const { backtest, role, fold } of backtests.values())
      await repo.save({
        backtestId: `${keep.walkForwardId}:fold${String(fold)}:${role}`,
        createdAt: keep.createdAt,
        strategyType: backtest.strategyType,
        window: backtest.window,
        stressed: backtest.costs.stressed,
        context: { candidateId, walkForwardId: keep.walkForwardId, fold, role },
        fingerprint: backtest.fingerprint,
        backtest: Object.fromEntries(
          Object.entries(backtest).filter(([k]) => k !== "trail"),
        ),
      });
  }
  return { result, saved };
}
