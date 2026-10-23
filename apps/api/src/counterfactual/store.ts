import type { Db } from "mongodb";
import type { CandleInterval } from "@neelkanth/core";
import { StrategyExperimentsRepository } from "@neelkanth/db";
import { loadCandles } from "../replay/store.js";
import { DEFAULT_REGIME_MODEL } from "./regime.js";
import {
  runCounterfactual,
  type CounterfactualRequest,
  type CounterfactualRun,
} from "./run.js";

/** A counterfactual run over the stored dataset, by date range (6.6). */
export interface StoredCounterfactualRequest extends Omit<
  CounterfactualRequest,
  "candles"
> {
  /** Indices the market reads beside the evaluated symbols, and the regime index. */
  indexSymbols: string[];
  interval: CandleInterval;
  /** IST trading dates, inclusive at both ends. */
  fromDate: string;
  toDate: string;
  experimentId: string;
  /** When the run was made — on the document, never in the result. */
  createdAt: number;
  /** False for a dry run: evaluate and report, keep nothing. */
  save: boolean;
}

/**
 * Evaluate over the research database's stored bars and keep the run (D7).
 *
 * It touches exactly two collections: it READS `candles` and WRITES
 * `strategy_experiments`. The replays inside it hold their orders and
 * Trades in memory (Phase 4 D3); nothing here can reach orders, positions,
 * trades or signals.
 */
export async function counterfactualFromStore(
  db: Db,
  request: StoredCounterfactualRequest,
): Promise<{ run: CounterfactualRun; saved: boolean }> {
  const regimeSymbol = (request.regime ?? DEFAULT_REGIME_MODEL).symbol;
  const symbols = [
    ...new Set([...request.symbols, ...request.indexSymbols, regimeSymbol]),
  ];
  const candles = await loadCandles(
    db,
    symbols,
    request.interval,
    request.fromDate,
    request.toDate,
  );
  const run = await runCounterfactual({
    candles,
    symbols: request.symbols,
    hours: request.hours,
    allocatedCapital: request.allocatedCapital,
    limits: request.limits,
    seed: request.seed,
    ...(request.slippage === undefined ? {} : { slippage: request.slippage }),
    ...(request.charges === undefined ? {} : { charges: request.charges }),
    ...(request.strategyParams === undefined
      ? {}
      : { strategyParams: request.strategyParams }),
    ...(request.detectors === undefined
      ? {}
      : { detectors: request.detectors }),
    ...(request.regime === undefined ? {} : { regime: request.regime }),
    ...(request.attribution === undefined
      ? {}
      : { attribution: request.attribution }),
  });
  if (!request.save) return { run, saved: false };

  const saved = await new StrategyExperimentsRepository(db).save({
    experimentId: request.experimentId,
    kind: "COUNTERFACTUAL",
    createdAt: request.createdAt,
    fingerprint: run.fingerprint,
    manifest: run.manifest as unknown as Record<string, unknown>,
    result: { patterns: run.patterns, matrix: run.matrix },
  });
  return { run, saved };
}
