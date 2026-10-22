import { createHash } from "node:crypto";
import {
  canonicalJson,
  strategyVersionOf,
  type Candle,
  type CandleInterval,
  type RiskLimits,
  type StrategyConfig,
} from "@neelkanth/core";
import {
  CHARGES_MODEL_VERSION,
  DEFAULT_CHARGES,
  SLIPPAGE_MODEL_VERSION,
  type ChargeConfig,
  type SlippageModel,
} from "@neelkanth/broker";
import { EXIT_MODEL_VERSION, SIZING_MODEL_VERSION } from "@neelkanth/engines";
import { createStrategyRegistry } from "@neelkanth/strategies";
import {
  DEFAULT_SLIPPAGE,
  runReplayWithTrail,
  type ReplayTrail,
  type GoldenRecord,
} from "../golden/pipeline.js";
import { sessionsFromCandles, type MarketHours } from "./sessions.js";

/** Bumped when what a run records, or how it is fingerprinted, changes. */
export const REPLAY_VERSION = "1";

/** One historical replay: one strategy over stored bars (design D4). */
export interface HistoricalReplayRequest {
  strategy: StrategyConfig;
  /** The dataset — every symbol the run reads, one interval, any order. */
  candles: Candle[];
  hours: MarketHours;
  allocatedCapital: number;
  limits: RiskLimits;
  /** Declared and recorded (D2); nothing consumes it yet. */
  seed: number;
  slippage?: SlippageModel;
  charges?: ChargeConfig;
}

/** Everything a run is a function of, named (design D5). */
export interface ReplayManifest {
  replayVersion: string;
  seed: number;
  strategy: {
    strategyId: string;
    type: string;
    params: Record<string, unknown>;
    symbols: string[];
    strategyVersion: string;
  };
  dataset: {
    symbols: string[];
    interval: CandleInterval;
    days: string[];
    firstBarTs: number;
    lastBarTs: number;
    bars: number;
    sources: Record<string, number>;
    ingestionVersions: number[];
  };
  /** Weekend dates opened because the dataset holds bars for them. */
  specialSessions: string[];
  /** Traded symbols that are indices, replayed in index points (Q1). */
  synthetic: string[];
  models: {
    positionSizing: string;
    exit: string;
    slippage: { version: string; model: SlippageModel };
    transactionCost: { version: string; config: ChargeConfig };
  };
  hours: MarketHours;
  allocatedCapital: number;
  limits: RiskLimits;
}

export interface ReplayRun {
  manifest: ReplayManifest;
  record: GoldenRecord;
  /** sha256 of the canonical manifest and record. */
  fingerprint: string;
  /**
   * The complete Signals, risk decisions and Trades (Phase 6 D3). Outside the
   * fingerprint, and not kept in `replay_runs`: it is what the record
   * summarises, handed to research to join on.
   */
  trail: ReplayTrail;
}

/** An NSE index — tradable only as a synthetic instrument here (Q1). */
const isIndex = (symbol: string): boolean => symbol.endsWith("-INDEX");

/**
 * Replay one strategy over stored bars, and say exactly what was measured.
 *
 * The run is a pure function of the request: same request, same record, same
 * fingerprint. It reads only what it is handed and writes nothing (D3).
 */
export async function runHistoricalReplay(
  request: HistoricalReplayRequest,
): Promise<ReplayRun> {
  const candles = [...request.candles].sort(
    (a, b) => a.ts - b.ts || a.symbol.localeCompare(b.symbol),
  );
  const interval = singleInterval(candles);
  refuseUnreplayable(request.strategy, candles, interval);
  const { sessions, specialSessions } = sessionsFromCandles(
    candles,
    request.hours,
  );
  const symbols = [...new Set(candles.map((c) => c.symbol))].sort();
  const slippage = request.slippage ?? DEFAULT_SLIPPAGE;
  const charges = request.charges ?? DEFAULT_CHARGES;

  const { record, trail } = await runReplayWithTrail({
    interval,
    // Unused for a candle source — no tick reaches the aggregator — but the
    // Market Data Engine needs one to be built.
    intervals: [interval],
    source: { kind: "candles", candles },
    sessions,
    specialSessions,
    strategies: [request.strategy],
    // The market view reads the indices in the dataset, and breadth from what
    // the strategy trades — the same roles the live settings give them.
    indexSymbols: symbols.filter(isIndex),
    breadthSymbols: request.strategy.symbols,
    allocatedCapital: request.allocatedCapital,
    limits: request.limits,
    slippage,
    charges,
    // Q1: a traded index is an equity-style instrument of lot 1, so risk sizes
    // it on the equity path, in index points. Without it, risk refuses the
    // symbol outright — "lot size unknown" — and the run can never fill.
    instruments: request.strategy.symbols.filter(isIndex).map((symbol) => ({
      symbol,
      kind: "EQUITY" as const,
      lotSize: 1,
      tickSize: 0.05,
    })),
  });

  const sources: Record<string, number> = {};
  for (const c of candles) sources[c.source] = (sources[c.source] ?? 0) + 1;
  const manifest: ReplayManifest = {
    replayVersion: REPLAY_VERSION,
    seed: request.seed,
    strategy: {
      strategyId: request.strategy.strategyId,
      type: request.strategy.type,
      params: request.strategy.params,
      symbols: request.strategy.symbols,
      strategyVersion: strategyVersionOf(request.strategy),
    },
    dataset: {
      symbols,
      interval,
      days: sessions.map((s) => s.date),
      firstBarTs: candles[0]?.ts ?? 0,
      lastBarTs: candles.at(-1)?.ts ?? 0,
      bars: candles.length,
      sources,
      ingestionVersions: [
        ...new Set(
          candles
            .map((c) => c.ingestionVersion)
            .filter((v): v is number => v !== undefined),
        ),
      ].sort((a, b) => a - b),
    },
    specialSessions,
    synthetic: request.strategy.symbols.filter(isIndex),
    models: {
      positionSizing: SIZING_MODEL_VERSION,
      exit: EXIT_MODEL_VERSION,
      slippage: { version: SLIPPAGE_MODEL_VERSION, model: slippage },
      transactionCost: { version: CHARGES_MODEL_VERSION, config: charges },
    },
    hours: request.hours,
    allocatedCapital: request.allocatedCapital,
    limits: request.limits,
  };

  return {
    manifest,
    record,
    fingerprint: fingerprintOf(manifest, record),
    trail,
  };
}

/** sha256 over the canonical serialisation — key order cannot move it. */
export function fingerprintOf(
  manifest: ReplayManifest,
  record: GoldenRecord,
): string {
  return createHash("sha256")
    .update(canonicalJson({ manifest, record }))
    .digest("hex");
}

/**
 * Refuse, by name, a strategy this dataset cannot replay (design D8).
 *
 * Each would otherwise run and produce a confident record of nothing: an
 * option-chain strategy reads an absent chain as "hold", a derivative one has
 * no contract prices to fill against, and one whose symbol or interval the
 * dataset lacks has no bars to decide on — all indistinguishable, afterwards,
 * from a quiet market.
 */
function refuseUnreplayable(
  strategy: StrategyConfig,
  candles: readonly Candle[],
  interval: CandleInterval,
): void {
  const held = new Set(candles.map((c) => c.symbol));
  for (const symbol of strategy.symbols) {
    const exclusion = replayExclusion(
      strategy.type,
      strategy.params,
      symbol,
      interval,
      held,
    );
    if (exclusion !== null) throw new Error(exclusion.reason);
  }
}

/** Why a strategy cannot be replayed on a symbol (design D8). */
export interface ReplayExclusion {
  kind: "OPTION_CHAIN" | "DERIVATIVE" | "INTERVAL" | "NO_BARS";
  reason: string;
}

/**
 * The one rule for what a dataset can replay — the refusal above throws on
 * it, and Phase 6's eligibility reports it (Phase 6 D1), so a strategy the
 * counterfactual lists as excluded is exactly one a replay would refuse.
 * Null means replayable.
 */
export function replayExclusion(
  type: string,
  params: unknown,
  symbol: string,
  interval: CandleInterval,
  heldSymbols: ReadonlySet<string>,
): ReplayExclusion | null {
  const instance = createStrategyRegistry().instantiate(type, params, symbol);
  if (instance.requiresOptionChain())
    return {
      kind: "OPTION_CHAIN",
      reason: `${type} cannot be replayed: it needs an option chain, and no chain history exists`,
    };
  if (instance.derivative() !== null)
    return {
      kind: "DERIVATIVE",
      reason: `${type} cannot be replayed: it trades a derivative contract, and the dataset holds no contract prices`,
    };
  if (instance.interval !== interval)
    return {
      kind: "INTERVAL",
      reason: `${type} decides on ${instance.interval} bars, but the dataset is ${interval}`,
    };
  if (!heldSymbols.has(symbol))
    return {
      kind: "NO_BARS",
      reason: `the dataset holds no bars for ${symbol}, which the strategy trades`,
    };
  return null;
}

function singleInterval(candles: readonly Candle[]): CandleInterval {
  const intervals = new Set(candles.map((c) => c.interval));
  const [only] = intervals;
  if (intervals.size !== 1 || only === undefined) {
    throw new Error(
      `a replay reads one interval; this dataset has ${String(intervals.size)}`,
    );
  }
  return only;
}
