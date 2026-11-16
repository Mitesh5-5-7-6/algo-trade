import {
  istDateKey,
  type Candle,
  type RiskLimits,
  type StrategyConfig,
} from "@neelkanth/core";
import type { ChargeConfig } from "@neelkanth/broker";
import { runHistoricalReplay } from "../replay/run.js";
import type { MarketHours } from "../replay/sessions.js";
import { OddsRefusal } from "./refusal.js";

/** Bumped whenever the same rule over the same bars would count differently. */
export const ODDS_HISTORY_VERSION = "1";

/** No charges: R is reported gross, in index points (design §6.1 D11). */
const NO_CHARGES: ChargeConfig = {
  brokeragePerOrder: 0,
  brokeragePct: 0,
  sttPct: 0,
  exchangeTxnPct: 0,
  sebiPct: 0,
  gstPct: 0,
  stampPct: 0,
};

export interface HistoryRequest {
  /** The plan's rule: the strategy configuration that would have proposed it. */
  rule: StrategyConfig;
  /** The plan's side. Only the rule's trades on this side are its history. */
  side: "LONG" | "SHORT";
  /** The plan's IST date. Only sessions strictly before it are replayed. */
  planDate: string;
  /** Bars over any range; those on or after `planDate` are never read. */
  candles: readonly Candle[];
  hours: MarketHours;
  allocatedCapital: number;
  limits: RiskLimits;
  seed: number;
}

/** One time the rule fired on the plan's side, and how it ended. */
export interface HistoryOutcome {
  date: string;
  entryTime: number;
  result: "TARGET" | "STOP" | "NEITHER";
  /**
   * What the trade aimed at, in units of its own risk — the rule's stop and
   * target move with each day, so this is not the plan's R. Null when the
   * rule set no price target.
   */
  targetR: number | null;
  /** +target/risk at the target, −1 at the stop, otherwise where it got out. */
  r: number;
  exitReason: string;
}

export interface HistoryResult {
  /** Sessions replayed — every one strictly before the plan's date. */
  sessions: number;
  /** Times the rule traded the plan's side. */
  fired: number;
  targetFirst: number;
  stopFirst: number;
  neither: number;
  /** Times the rule traded the other side: not this plan's history. */
  otherSide: number;
  /** Null when the rule never fired: there is nothing to average. */
  averageR: number | null;
  outcomes: HistoryOutcome[];
  /** The replay's own fingerprint: the same bars and rule, the same value. */
  replayFingerprint: string;
}

/**
 * Run a plan's rule over every past session through the existing replay
 * (design §6.1 D3) — real days, in their real order, the whole machine.
 *
 * Without slippage or charges (D11): the question is how often the index
 * reached the target before the stop, not what a contract would have cost.
 * A stop is scored at −1R however far through it the bar went (D4).
 */
export async function historyOf(
  request: HistoryRequest,
): Promise<HistoryResult> {
  const candles = request.candles.filter(
    (candle) => istDateKey(candle.ts) < request.planDate,
  );
  if (candles.length === 0)
    throw new OddsRefusal(
      `no session before ${request.planDate}: the rule has no history to run over`,
    );

  const run = await runHistoricalReplay({
    strategy: request.rule,
    candles,
    hours: request.hours,
    allocatedCapital: request.allocatedCapital,
    limits: request.limits,
    seed: request.seed,
    slippage: { kind: "none" },
    charges: NO_CHARGES,
  });

  const signals = new Map(run.trail.signals.map((s) => [s.signalId, s]));
  const outcomes: HistoryOutcome[] = [];
  let otherSide = 0;
  for (const trade of run.trail.trades) {
    if (trade.side !== request.side) {
      otherSide += 1;
      continue;
    }
    const signal =
      trade.entrySignalId === undefined
        ? undefined
        : signals.get(trade.entrySignalId);
    const stop = signal?.stopLoss;
    if (stop === undefined || trade.exitPrice === undefined)
      throw new Error(
        `trade ${trade.tradeId} has no stop or no exit: the rule's history cannot be scored in R`,
      );
    const direction = trade.side === "LONG" ? 1 : -1;
    const risk = Math.abs(trade.entryPrice - stop);
    const result =
      trade.exitReason === "TAKE_PROFIT"
        ? "TARGET"
        : trade.exitReason === "STOP_LOSS"
          ? "STOP"
          : "NEITHER";
    const reached =
      result === "TARGET" && signal?.target !== undefined
        ? signal.target
        : trade.exitPrice;
    outcomes.push({
      date: istDateKey(trade.entryTime),
      entryTime: trade.entryTime,
      result,
      targetR:
        signal?.target === undefined
          ? null
          : Math.abs(signal.target - trade.entryPrice) / risk,
      r:
        result === "STOP"
          ? -1
          : (direction * (reached - trade.entryPrice)) / risk,
      exitReason: trade.exitReason ?? "NONE",
    });
  }
  outcomes.sort((a, b) => a.entryTime - b.entryTime);

  const count = (result: HistoryOutcome["result"]): number =>
    outcomes.filter((o) => o.result === result).length;
  return {
    sessions: run.manifest.dataset.days.length,
    fired: outcomes.length,
    targetFirst: count("TARGET"),
    stopFirst: count("STOP"),
    neither: count("NEITHER"),
    otherSide,
    averageR:
      outcomes.length === 0
        ? null
        : outcomes.reduce((sum, o) => sum + o.r, 0) / outcomes.length,
    outcomes,
    replayFingerprint: run.fingerprint,
  };
}
