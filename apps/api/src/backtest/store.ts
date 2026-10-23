import type { Db } from "mongodb";
import { BacktestsRepository } from "@neelkanth/db";
import { loadCandles } from "../replay/store.js";
import {
  runBacktest,
  warmupFrom,
  type Backtest,
  type BacktestRequest,
} from "./run.js";

/**
 * A backtest over the stored bars (Phase 13 D2): the window and its warm-up
 * lead, every instrument and the regime index, read from `candles`; the
 * result kept in `backtests` when asked — insert-only, under its id — and
 * nothing else written.
 */
export async function backtestFromStore(
  db: Db,
  request: BacktestRequest,
  keep:
    | { save: false }
    | {
        save: true;
        backtestId: string;
        createdAt: number;
        context: Record<string, unknown>;
      },
): Promise<{ backtest: Backtest; saved: boolean }> {
  const symbols = [...new Set([...request.symbols, request.regime.symbol])];
  const candles = await loadCandles(
    db,
    symbols,
    request.interval,
    warmupFrom(request.fromDate),
    request.toDate,
  );
  const backtest = await runBacktest(candles, request);
  if (!keep.save) return { backtest, saved: false };
  const saved = await new BacktestsRepository(db).save({
    backtestId: keep.backtestId,
    createdAt: keep.createdAt,
    strategyType: backtest.strategyType,
    window: backtest.window,
    stressed: backtest.costs.stressed,
    context: keep.context,
    fingerprint: backtest.fingerprint,
    // The trail is what the metrics summarise; it is not kept.
    backtest: Object.fromEntries(
      Object.entries(backtest).filter(([k]) => k !== "trail"),
    ),
  });
  return { backtest, saved };
}
