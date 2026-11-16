import type { Db } from "mongodb";
import { istDayStart, type Candle, type CandleInterval } from "@neelkanth/core";
import {
  CandlesRepository,
  StrategyExperimentsRepository,
} from "@neelkanth/db";
import {
  runSetupOdds,
  type SetupOddsRequest,
  type SetupOddsRun,
} from "./run.js";

/** A plan's odds over the stored dataset (Phase 17 task 17.6). */
export interface StoredSetupOddsRequest extends Omit<
  SetupOddsRequest,
  "candles"
> {
  /** Indices the rule's replay reads for its market view, beside the plan's symbol. */
  indexSymbols: string[];
  interval: CandleInterval;
  experimentId: string;
  /** When the run was made — recorded on the document, not in the result. */
  createdAt: number;
  /** False for a dry run: compute and report, keep nothing. */
  save: boolean;
}

/**
 * A plan's odds from the research database's stored bars, and the run kept
 * (design §6.1 D7).
 *
 * It touches exactly two collections: it READS `candles` and WRITES
 * `strategy_experiments`, `kind: "SETUP_ODDS"`. Nothing here can reach orders,
 * positions, trades or signals — the history's Trades live in memory and
 * inside the kept run — so a plan's odds cannot change trading state.
 *
 * The bars are asked for only up to the plan's own day (D8): what the run
 * must not see is never loaded.
 */
export async function setupOddsFromStore(
  db: Db,
  request: StoredSetupOddsRequest,
): Promise<{ run: SetupOddsRun; saved: boolean }> {
  const { indexSymbols, interval, experimentId, createdAt, save, ...rest } =
    request;
  const candles = await loadCandlesBefore(
    db,
    [...new Set([request.plan.symbol, ...indexSymbols])],
    interval,
    request.plan.date,
  );
  const run = await runSetupOdds({ ...rest, candles });
  if (!save) return { run, saved: false };

  const saved = await new StrategyExperimentsRepository(db).save({
    experimentId,
    kind: "SETUP_ODDS",
    createdAt,
    fingerprint: run.fingerprint,
    manifest: run.manifest as unknown as Record<string, unknown>,
    result: run.result as unknown as Record<string, unknown>,
  });
  return { run, saved };
}

/** Stored bars of the symbols strictly before an IST date — read only. */
export async function loadCandlesBefore(
  db: Db,
  symbols: readonly string[],
  interval: CandleInterval,
  date: string,
): Promise<Candle[]> {
  const repo = new CandlesRepository(db);
  const perSymbol = await Promise.all(
    symbols.map((symbol) =>
      repo.findRange(symbol, interval, 0, istDayStart(date)),
    ),
  );
  return perSymbol.flat();
}
