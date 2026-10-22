import { createHash } from "node:crypto";
import {
  canonicalJson,
  istDateKey,
  type Candle,
  type CandleInterval,
  type PatternDefinition,
  type PatternOccurrence,
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
import {
  EXIT_MODEL_VERSION,
  SIZING_MODEL_VERSION,
  sweepPatterns,
} from "@neelkanth/engines";
import { createPatternRegistry } from "@neelkanth/patterns";
import {
  runHistoricalReplay,
  type ReplayExclusion,
  type ReplayManifest,
} from "../replay/run.js";
import type { MarketHours } from "../replay/sessions.js";
import { DEFAULT_SLIPPAGE } from "../golden/pipeline.js";
import {
  attribute,
  DEFAULT_ATTRIBUTION_MODEL,
  type AttributionModel,
  type StrategyRun,
} from "./attribution.js";
import { strategyEligibility } from "./eligibility.js";
import { buildMatrix, type MatrixRow } from "./matrix.js";
import {
  DEFAULT_REGIME_MODEL,
  regimeTimeline,
  type RegimeModel,
} from "./regime.js";

/** Bumped when what a counterfactual run records, or how, changes. */
export const COUNTERFACTUAL_VERSION = "1";

/** One counterfactual evaluation: every strategy, the same market (Phase 6). */
export interface CounterfactualRequest {
  /** The dataset — the evaluated symbols, the indices, the regime index. */
  candles: Candle[];
  /** The symbols strategies are evaluated on, one replay each (D2). */
  symbols: string[];
  hours: MarketHours;
  allocatedCapital: number;
  limits: RiskLimits;
  seed: number;
  slippage?: SlippageModel;
  charges?: ChargeConfig;
  /** A strategy type's configuration; one not named runs at its defaults. */
  strategyParams?: Record<string, Record<string, unknown>>;
  /** \`patternId → params\`; absent means every built-in at its defaults. */
  detectors?: Record<string, unknown>;
  regime?: RegimeModel;
  attribution?: AttributionModel;
}

/** One strategy on one symbol: replayed, or excluded with its reason (D1). */
export type StrategyEntry =
  | {
      type: string;
      symbol: string;
      eligible: true;
      params: Record<string, unknown>;
      strategyVersion: string;
      /** The underlying replay's own fingerprint (Phase 4 D5). */
      replayFingerprint: string;
      trades: number;
    }
  | {
      type: string;
      symbol: string;
      eligible: false;
      exclusion: ReplayExclusion;
    };

/** What a symbol's sweep found, and what it declined to judge. */
export interface PatternSummary {
  symbol: string;
  found: Record<string, number>;
  declinedForVolume: Record<string, number>;
  skippedForWarmup: Record<string, number>;
}

/** Everything a counterfactual run is a function of, named (D7, spec §5.3). */
export interface CounterfactualManifest {
  counterfactualVersion: string;
  seed: number;
  dataset: ReplayManifest["dataset"];
  symbols: string[];
  strategies: StrategyEntry[];
  detectors: {
    definition: PatternDefinition;
    params: Record<string, unknown>;
  }[];
  models: ReplayManifest["models"] & {
    regime: RegimeModel;
    attribution: AttributionModel;
  };
  hours: MarketHours;
  allocatedCapital: number;
  limits: RiskLimits;
}

export interface CounterfactualRun {
  manifest: CounterfactualManifest;
  patterns: PatternSummary[];
  matrix: MatrixRow[];
  /** sha256 of the canonical manifest, pattern summaries and matrix. */
  fingerprint: string;
}

/**
 * Evaluate every registered strategy against the same market (Phase 6).
 *
 * Each eligible strategy is replayed alone on each symbol (D2) — the whole
 * dataset is its market, so every strategy sees the same indices — and every
 * other strategy is listed with the replay's own reason for refusing it
 * (D1). The detectors sweep each symbol; each occurrence is put to every
 * strategy run on that symbol (D5) and labelled with the regime at its bar
 * (D4); the matrix pools it all (D6). A pure function of the request: the
 * same request gives the same fingerprint.
 */
export async function runCounterfactual(
  request: CounterfactualRequest,
): Promise<CounterfactualRun> {
  const regime = request.regime ?? DEFAULT_REGIME_MODEL;
  const attribution = request.attribution ?? DEFAULT_ATTRIBUTION_MODEL;
  const candles = [...request.candles].sort(
    (a, b) =>
      a.ts - b.ts || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
  );
  const interval = onlyInterval(candles);
  const held = new Set(candles.map((c) => c.symbol));
  const regimeBars = candles.filter((c) => c.symbol === regime.symbol);
  if (regimeBars.length === 0)
    throw new Error(
      `the dataset holds no bars for ${regime.symbol}, the regime index`,
    );
  const timeline = regimeTimeline(regimeBars, regime);

  // --- Every strategy, on every symbol: replayed alone, or excluded.
  const strategies: StrategyEntry[] = [];
  const runs: StrategyRun[] = [];
  for (const symbol of request.symbols) {
    for (const row of strategyEligibility(
      symbol,
      interval,
      held,
      request.strategyParams,
    )) {
      if (row.exclusion !== undefined) {
        strategies.push({
          type: row.type,
          symbol,
          eligible: false,
          exclusion: row.exclusion,
        });
        continue;
      }
      const replay = await runHistoricalReplay({
        strategy: configFor(row.type, symbol, row.params),
        candles,
        hours: request.hours,
        allocatedCapital: request.allocatedCapital,
        limits: request.limits,
        seed: request.seed,
        ...(request.slippage === undefined
          ? {}
          : { slippage: request.slippage }),
        ...(request.charges === undefined ? {} : { charges: request.charges }),
      });
      strategies.push({
        type: row.type,
        symbol,
        eligible: true,
        params: row.params,
        strategyVersion: replay.manifest.strategy.strategyVersion,
        replayFingerprint: replay.fingerprint,
        trades: replay.trail.trades.length,
      });
      runs.push({ strategyType: row.type, symbol, trail: replay.trail });
    }
  }

  // --- The patterns, on the same bars.
  const registry = createPatternRegistry();
  const chosen =
    request.detectors ??
    Object.fromEntries(registry.ids().map((id) => [id, {}]));
  const detectors = Object.entries(chosen).map(([id, params]) =>
    registry.instantiate(id, params),
  );
  const occurrences: PatternOccurrence[] = [];
  const patterns: PatternSummary[] = [];
  for (const symbol of request.symbols) {
    const sweep = sweepPatterns({
      symbol,
      interval,
      candles: candles.filter((c) => c.symbol === symbol),
      detectors,
    });
    occurrences.push(...sweep.occurrences);
    const found: Record<string, number> = {};
    for (const o of sweep.occurrences)
      found[o.patternId] = (found[o.patternId] ?? 0) + 1;
    patterns.push({
      symbol,
      found,
      declinedForVolume: sweep.declinedForVolume,
      skippedForWarmup: sweep.skippedForWarmup,
    });
  }

  const matrix = buildMatrix(
    attribute(occurrences, runs, timeline, interval, attribution),
    runs,
    timeline,
  );

  const dataset = datasetOf(candles, interval);
  const manifest: CounterfactualManifest = {
    counterfactualVersion: COUNTERFACTUAL_VERSION,
    seed: request.seed,
    dataset,
    symbols: [...request.symbols],
    strategies,
    detectors: registry
      .catalog()
      .filter((d) => Object.hasOwn(chosen, d.patternId))
      .map((definition) => ({
        definition,
        params:
          detectors.find((d) => d.patternId === definition.patternId)?.params ??
          {},
      })),
    // The same models every replay in this run declared (spec §5.3).
    models: {
      positionSizing: SIZING_MODEL_VERSION,
      exit: EXIT_MODEL_VERSION,
      slippage: {
        version: SLIPPAGE_MODEL_VERSION,
        model: request.slippage ?? DEFAULT_SLIPPAGE,
      },
      transactionCost: {
        version: CHARGES_MODEL_VERSION,
        config: request.charges ?? DEFAULT_CHARGES,
      },
      regime,
      attribution,
    },
    hours: request.hours,
    allocatedCapital: request.allocatedCapital,
    limits: request.limits,
  };
  return {
    manifest,
    patterns,
    matrix,
    fingerprint: createHash("sha256")
      .update(canonicalJson({ manifest, patterns, matrix }))
      .digest("hex"),
  };
}

function configFor(
  type: string,
  symbol: string,
  params: Record<string, unknown>,
): StrategyConfig {
  return {
    strategyId: `cf_${type.toLowerCase()}_${symbol.replace(/[^A-Za-z0-9]/g, "_").toLowerCase()}`,
    ownerId: "research",
    type,
    name: `${type} counterfactual`,
    params,
    symbols: [symbol],
    enabled: true,
    status: "active",
    createdAt: 0,
    updatedAt: 0,
  };
}

function onlyInterval(candles: readonly Candle[]): CandleInterval {
  const intervals = new Set(candles.map((c) => c.interval));
  const [only] = intervals;
  if (intervals.size !== 1 || only === undefined)
    throw new Error(
      `a counterfactual run needs bars of one interval, got ${[...intervals].join(", ") || "none"}`,
    );
  return only;
}

function datasetOf(
  candles: readonly Candle[],
  interval: CandleInterval,
): ReplayManifest["dataset"] {
  const sources: Record<string, number> = {};
  for (const c of candles) sources[c.source] = (sources[c.source] ?? 0) + 1;
  const days = new Set<string>();
  for (const c of candles) days.add(istDateKey(c.ts));
  return {
    symbols: [...new Set(candles.map((c) => c.symbol))].sort(),
    interval,
    days: [...days].sort(),
    firstBarTs: candles[0]?.ts ?? 0,
    lastBarTs: candles.at(-1)?.ts ?? 0,
    bars: candles.length,
    sources: Object.fromEntries(
      Object.entries(sources).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    ingestionVersions: [
      ...new Set(
        candles
          .map((c) => c.ingestionVersion)
          .filter((v): v is number => v !== undefined),
      ),
    ].sort((a, b) => a - b),
  };
}
