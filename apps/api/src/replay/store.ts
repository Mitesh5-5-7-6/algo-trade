import type { Db } from "mongodb";
import { istDayStart, type Candle, type CandleInterval } from "@neelkanth/core";
import { CandlesRepository, ReplayRunsRepository } from "@neelkanth/db";
import {
  runHistoricalReplay,
  type HistoricalReplayRequest,
  type ReplayRun,
} from "./run.js";

const DAY_MS = 86_400_000;

/** A replay over the stored dataset, by date range (Phase 4 task 4.8). */
export interface StoredReplayRequest extends Omit<
  HistoricalReplayRequest,
  "candles"
> {
  /** Every symbol the run reads — what the strategy trades, and the indices. */
  symbols: string[];
  interval: CandleInterval;
  /** IST trading dates, inclusive at both ends. */
  fromDate: string;
  toDate: string;
  runId: string;
  /** When the run was made — recorded on the document, not in the result. */
  createdAt: number;
  /** False for a dry run: replay and report, keep nothing. */
  save: boolean;
}

/**
 * Replay over the research database's stored bars, and keep the run (D3).
 *
 * It touches exactly two collections, and only these two: it READS
 * `candles` and WRITES `replay_runs`. Nothing here can reach orders,
 * positions, trades or signals — the run's own orders and Trades live in
 * memory and inside its `replay_runs` document — which is what makes a
 * replay unable to modify Paper or Live trading state.
 */
export async function replayFromStore(
  db: Db,
  request: StoredReplayRequest,
): Promise<{ run: ReplayRun; saved: boolean }> {
  const candles = await loadCandles(
    db,
    request.symbols,
    request.interval,
    request.fromDate,
    request.toDate,
  );
  const run = await runHistoricalReplay({
    strategy: request.strategy,
    candles,
    hours: request.hours,
    allocatedCapital: request.allocatedCapital,
    limits: request.limits,
    seed: request.seed,
    ...(request.slippage === undefined ? {} : { slippage: request.slippage }),
    ...(request.charges === undefined ? {} : { charges: request.charges }),
  });
  if (!request.save) return { run, saved: false };

  const saved = await new ReplayRunsRepository(db).save({
    runId: request.runId,
    createdAt: request.createdAt,
    fingerprint: run.fingerprint,
    strategyId: request.strategy.strategyId,
    manifest: run.manifest as unknown as Record<string, unknown>,
    record: run.record as unknown as Record<string, unknown>,
  });
  return { run, saved };
}

/** Stored bars for the symbols over IST dates, both ends inclusive — read only. */
export async function loadCandles(
  db: Db,
  symbols: readonly string[],
  interval: CandleInterval,
  fromDate: string,
  toDate: string,
): Promise<Candle[]> {
  const repo = new CandlesRepository(db);
  const fromTs = istDayStart(fromDate);
  const toTs = istDayStart(toDate) + DAY_MS; // half-open, toDate inclusive
  const perSymbol = await Promise.all(
    symbols.map((symbol) => repo.findRange(symbol, interval, fromTs, toTs)),
  );
  return perSymbol.flat();
}
