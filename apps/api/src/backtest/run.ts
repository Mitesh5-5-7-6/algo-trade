import { createHash } from "node:crypto";
import {
  canonicalJson,
  istDateKey,
  istDayStart,
  type Candle,
  type CandleInterval,
  type RiskLimits,
  type StrategyConfig,
  type Trade,
} from "@neelkanth/core";
import {
  DEFAULT_CHARGES,
  type ChargeConfig,
  type SlippageModel,
} from "@neelkanth/broker";
import { DEFAULT_SLIPPAGE } from "../golden/pipeline.js";
import {
  regimeAt,
  regimeTimeline,
  type RegimeModel,
} from "../counterfactual/regime.js";
import { runHistoricalReplay } from "../replay/run.js";
import type { MarketHours } from "../replay/sessions.js";
import { backtestMetrics, type BacktestMetrics } from "./metrics.js";

/** Bumped whenever what a backtest is, or how it is run, changes (Phase 13 D2, D3). */
export const BACKTEST_VERSION = "1";

/** Calendar days of bars replayed before a window so its first session starts warm. */
export const WARMUP_LEAD_DAYS = 10;

/** Cost stress (D3): slippage ×2, charges ×1.5. */
export const STRESS = { slippage: 2, charges: 1.5 } as const;

export interface BacktestRequest {
  strategyType: string;
  params: Record<string, unknown>;
  /** The instruments traded — one replay each, as the counterfactual does. */
  symbols: string[];
  interval: CandleInterval;
  /** IST trading dates, both inclusive: the Trades counted are entered in it. */
  fromDate: string;
  toDate: string;
  hours: MarketHours;
  /** Per instrument; the backtest's capital basis is this × the instruments. */
  allocatedCapital: number;
  limits: RiskLimits;
  seed: number;
  regime: RegimeModel;
  slippage?: SlippageModel;
  charges?: ChargeConfig;
  /** Replay under D3's stressed costs. */
  stressed?: boolean;
}

export interface Backtest {
  backtestVersion: string;
  strategyType: string;
  params: Record<string, unknown>;
  strategyVersion: string;
  symbols: string[];
  window: { fromDate: string; toDate: string };
  capitalBasis: number;
  costs: { slippage: SlippageModel; charges: ChargeConfig; stressed: boolean };
  /** Each instrument's replay fingerprint — what the backtest stands on. */
  replays: Record<string, string>;
  metrics: BacktestMetrics;
  /** sha256 of everything above: the same request gives the same backtest. */
  fingerprint: string;
}

/** A cost model made worse by D3's factors. */
export function stressedCosts(
  slippage: SlippageModel,
  charges: ChargeConfig,
): { slippage: SlippageModel; charges: ChargeConfig } {
  const s = STRESS.slippage;
  const c = STRESS.charges;
  return {
    slippage:
      slippage.kind === "percent"
        ? { kind: "percent", pct: slippage.pct * s }
        : slippage.kind === "fixed"
          ? { kind: "fixed", amount: slippage.amount * s }
          : slippage,
    // Every charge ×1.5; GST is a rate on brokerage and fees, so scaling its
    // base already scales it.
    charges: {
      brokeragePerOrder: charges.brokeragePerOrder * c,
      brokeragePct: charges.brokeragePct * c,
      sttPct: charges.sttPct * c,
      exchangeTxnPct: charges.exchangeTxnPct * c,
      sebiPct: charges.sebiPct * c,
      gstPct: charges.gstPct,
      stampPct: charges.stampPct * c,
    },
  };
}

/** The first date of a window's warm-up lead. */
export function warmupFrom(fromDate: string): string {
  return istDateKey(istDayStart(fromDate) - WARMUP_LEAD_DAYS * 86_400_000);
}

const configFor = (
  type: string,
  symbol: string,
  params: Record<string, unknown>,
): StrategyConfig => ({
  strategyId: `bt_${type.toLowerCase()}_${symbol.replace(/[^A-Za-z0-9]/g, "_").toLowerCase()}`,
  ownerId: "research",
  type,
  name: `${type} backtest`,
  params,
  symbols: [symbol],
  enabled: true,
  status: "active",
  createdAt: 0,
  updatedAt: 0,
});

/**
 * Backtest one parameter set over one window (Phase 13 D2, D3). A pure
 * function of the bars it is handed — the window and its warm-up lead, every
 * instrument and the regime index — and the request: each instrument
 * replayed alone, the Trades entered inside the window measured together.
 */
export async function runBacktest(
  candles: readonly Candle[],
  request: BacktestRequest,
): Promise<Backtest> {
  const base = {
    slippage: request.slippage ?? DEFAULT_SLIPPAGE,
    charges: request.charges ?? DEFAULT_CHARGES,
  };
  const costs =
    request.stressed === true
      ? stressedCosts(base.slippage, base.charges)
      : base;
  const start = istDayStart(request.fromDate);
  const end = istDayStart(request.toDate) + 86_400_000;
  const regimeBars = candles
    .filter((c) => c.symbol === request.regime.symbol && c.ts < end)
    .sort((a, b) => a.ts - b.ts);
  if (regimeBars.length === 0)
    throw new Error(`no bars for ${request.regime.symbol}, the regime index`);
  const timeline = regimeTimeline(regimeBars, request.regime);
  const inRange = candles.filter((c) => c.ts < end);

  const trades: Trade[] = [];
  const replays: Record<string, string> = {};
  const versions = new Set<string>();
  for (const symbol of [...request.symbols].sort()) {
    const replay = await runHistoricalReplay({
      strategy: configFor(request.strategyType, symbol, request.params),
      candles: [...inRange],
      hours: request.hours,
      allocatedCapital: request.allocatedCapital,
      limits: request.limits,
      seed: request.seed,
      slippage: costs.slippage,
      charges: costs.charges,
    });
    replays[symbol] = replay.fingerprint;
    versions.add(replay.manifest.strategy.strategyVersion);
    // Only Trades entered inside the window: the lead only warms.
    trades.push(...replay.trail.trades.filter((t) => t.entryTime >= start));
  }
  const [strategyVersion = ""] = versions;
  if (versions.size !== 1)
    throw new Error(
      `${request.strategyType} ran at ${String(versions.size)} versions across instruments`,
    );

  const sessions = [
    ...new Set(
      candles
        .filter(
          (c) =>
            request.symbols.includes(c.symbol) && c.ts >= start && c.ts < end,
        )
        .map((c) => istDateKey(c.ts)),
    ),
  ].sort();
  const capitalBasis = request.allocatedCapital * request.symbols.length;
  const metrics = backtestMetrics(trades, {
    allocatedCapital: capitalBasis,
    sessions,
    regimeAt: (ts) =>
      ts < (timeline.ts[0] ?? Infinity) ? null : regimeAt(timeline, ts),
  });
  const body = {
    backtestVersion: BACKTEST_VERSION,
    strategyType: request.strategyType,
    params: request.params,
    strategyVersion,
    symbols: [...request.symbols].sort(),
    window: { fromDate: request.fromDate, toDate: request.toDate },
    capitalBasis,
    costs: { ...costs, stressed: request.stressed === true },
    replays,
    metrics,
  };
  return {
    ...body,
    fingerprint: createHash("sha256").update(canonicalJson(body)).digest("hex"),
  };
}
