import { createHash } from "node:crypto";
import {
  canonicalJson,
  intervalMs,
  istDateKey,
  NSE_DEFAULT_SESSION,
  parseHHMM,
  strategyVersionOf,
  type Candle,
  type RiskLimits,
  type SessionConfig,
  type StrategyConfig,
} from "@neelkanth/core";
import { replayExclusion, REPLAY_VERSION } from "../replay/run.js";
import type { MarketHours } from "../replay/sessions.js";
import {
  historyOf,
  ODDS_HISTORY_VERSION,
  type HistoryResult,
} from "./history.js";
import { buildPool, ODDS_POOL_VERSION, type PoolExclusion } from "./pool.js";
import { OddsRefusal } from "./refusal.js";
import {
  ODDS_RESAMPLING_VERSION,
  resample,
  type ResampleResult,
} from "./resample.js";
import {
  DEFAULT_VERDICT_POLICY,
  judgeHistory,
  judgeResampled,
  ODDS_VERDICT_VERSION,
  type HistoryVerdict,
  type ResampledVerdict,
  type VerdictPolicy,
} from "./verdict.js";

/** Bumped when what a run records, or how it is fingerprinted, changes. */
export const SETUP_ODDS_VERSION = "1";

/** One plan, as the operator types it (design §6.1 D12). */
export interface SetupOddsPlan {
  /** The underlying whose bars the odds are computed on (D1). */
  symbol: string;
  side: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  /** The plan's IST date, "YYYY-MM-DD". Nothing on or after it is read. */
  date: string;
  /** IST "HH:MM": when the entry was decided. */
  time: string;
}

export interface SetupOddsRequest {
  plan: SetupOddsPlan;
  /**
   * Every bar the run may read: the plan's symbol, and any index the rule's
   * replay reads for its market view. One interval, any order.
   */
  candles: readonly Candle[];
  resampling: { replays: number; seed: number; window: number };
  /** Use only the most recent N full sessions. Absent: every one held. */
  lookbackSessions?: number;
  /**
   * The plan's rule as a strategy configuration (D3), for the history
   * method. Absent: no history is run, and the report says so.
   */
  rule?: { type: string; params: Record<string, unknown> };
  session?: SessionConfig;
  hours: MarketHours;
  allocatedCapital: number;
  limits: RiskLimits;
  policy?: VerdictPolicy;
}

/** Everything a run is a function of, named (design §6.1 D7). */
export interface SetupOddsManifest {
  setupOddsVersion: string;
  plan: SetupOddsPlan & {
    /** The last bar that had closed by the plan's time, from the bell. */
    entryBar: number;
    targetR: number;
  };
  session: { open: string; close: string; exchange: string };
  pool: {
    version: string;
    intervalMinutes: number;
    barsPerSession: number;
    lookbackSessions: number | null;
    sessions: number;
    dates: string[];
    excluded: PoolExclusion[];
    /** The pool's bars by candle source, and their ingestion versions. */
    sources: Record<string, number>;
    ingestionVersions: number[];
  };
  resampling: {
    version: string;
    replays: number;
    seed: number;
    window: number;
  };
  history: {
    version: string;
    replayVersion: string;
    rule: {
      type: string;
      params: Record<string, unknown>;
      strategyVersion: string;
    };
    hours: MarketHours;
    allocatedCapital: number;
    limits: RiskLimits;
  } | null;
  verdict: { version: string; policy: VerdictPolicy };
}

export interface SetupOddsResult {
  resampled: ResampleResult;
  resampledVerdict: ResampledVerdict;
  /** Null when the plan named no rule. */
  history: HistoryResult | null;
  historyVerdict: HistoryVerdict | null;
}

export interface SetupOddsRun {
  manifest: SetupOddsManifest;
  result: SetupOddsResult;
  /** sha256 of the canonical manifest and result. */
  fingerprint: string;
}

/**
 * A plan's odds, by both methods, never blended (design §6.1 D3).
 *
 * Resampling replays the rest of the plan's day from past sessions' bars; the
 * history runs the plan's rule over those same past sessions through the
 * existing replay. Each is judged on its own (D5, D6). The run is a pure
 * function of the request — same request, same fingerprint — reads only the
 * bars it is handed, and of those only the ones before the plan's date (D8).
 */
export async function runSetupOdds(
  request: SetupOddsRequest,
): Promise<SetupOddsRun> {
  const { plan } = request;
  const session = request.session ?? NSE_DEFAULT_SESSION;
  const policy = request.policy ?? DEFAULT_VERDICT_POLICY;

  // D8, once and for everything below: nothing on or after the plan's date.
  const past = request.candles.filter((c) => istDateKey(c.ts) < plan.date);
  const own = past.filter((c) => c.symbol === plan.symbol);
  const interval = own[0]?.interval;
  if (interval === undefined || own.some((c) => c.interval !== interval))
    throw new OddsRefusal(noSession(plan));
  const intervalMinutes = intervalMs(interval) / 60_000;

  const full = buildPool(own, {
    planDate: plan.date,
    intervalMinutes,
    session,
  });
  const sessions =
    request.lookbackSessions === undefined
      ? full.sessions
      : full.sessions.slice(-request.lookbackSessions);
  const since = sessions[0]?.date;
  if (since === undefined) throw new OddsRefusal(noSession(plan));
  const pool = {
    barsPerSession: full.barsPerSession,
    sessions,
    excluded: full.excluded.filter((e) => e.date >= since),
  };

  // The last bar that had closed by the plan's time: the bars after it are
  // the ones still to come.
  const sinceOpen = parseHHMM(plan.time) - parseHHMM(session.open);
  const entryBar = Math.floor(sinceOpen / intervalMinutes) - 1;
  if (entryBar < 0)
    throw new OddsRefusal(
      `${plan.time} is before the first bar of the session has closed`,
    );
  if (entryBar > pool.barsPerSession - 2)
    throw new OddsRefusal(
      `${plan.time} is at or after the session's last bar: nothing left to replay`,
    );

  const resampled = resample(
    {
      side: plan.side,
      entry: plan.entry,
      stop: plan.stop,
      target: plan.target,
      entryBar,
    },
    pool,
    request.resampling,
  );

  let history: HistoryResult | null = null;
  let historyManifest: SetupOddsManifest["history"] = null;
  if (request.rule !== undefined) {
    // Said before anything runs, in the rule's own words: an unknown type,
    // parameters its schema rejects, or a rule this dataset cannot replay.
    let exclusion: ReturnType<typeof replayExclusion>;
    try {
      exclusion = replayExclusion(
        request.rule.type,
        request.rule.params,
        plan.symbol,
        interval,
        new Set(past.map((c) => c.symbol)),
      );
    } catch (error) {
      throw new OddsRefusal(
        `the rule ${request.rule.type} cannot be used: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (exclusion !== null) throw new OddsRefusal(exclusion.reason);

    const rule: StrategyConfig = {
      strategyId: `odds_${request.rule.type}`,
      ownerId: "odds",
      type: request.rule.type,
      name: `${request.rule.type}, the plan's rule`,
      params: request.rule.params,
      symbols: [plan.symbol],
      enabled: true,
      status: "active",
      createdAt: 0,
      updatedAt: 0,
    };
    history = await historyOf({
      rule,
      side: plan.side,
      planDate: plan.date,
      // The same days as the pool, so the two methods describe one period.
      candles: past.filter((c) => istDateKey(c.ts) >= since),
      hours: request.hours,
      allocatedCapital: request.allocatedCapital,
      limits: request.limits,
      seed: request.resampling.seed,
    });
    historyManifest = {
      version: ODDS_HISTORY_VERSION,
      replayVersion: REPLAY_VERSION,
      rule: {
        type: request.rule.type,
        params: request.rule.params,
        strategyVersion: strategyVersionOf(rule),
      },
      hours: request.hours,
      allocatedCapital: request.allocatedCapital,
      limits: request.limits,
    };
  }

  const sources: Record<string, number> = {};
  const versions = new Set<number>();
  for (const s of sessions)
    for (const bar of s.bars) {
      sources[bar.source] = (sources[bar.source] ?? 0) + 1;
      if (bar.ingestionVersion !== undefined)
        versions.add(bar.ingestionVersion);
    }

  const manifest: SetupOddsManifest = {
    setupOddsVersion: SETUP_ODDS_VERSION,
    plan: { ...plan, entryBar, targetR: resampled.targetR },
    session: {
      open: session.open,
      close: session.close,
      exchange: session.exchange,
    },
    pool: {
      version: ODDS_POOL_VERSION,
      intervalMinutes,
      barsPerSession: pool.barsPerSession,
      lookbackSessions: request.lookbackSessions ?? null,
      sessions: sessions.length,
      dates: sessions.map((s) => s.date),
      excluded: pool.excluded,
      sources,
      ingestionVersions: [...versions].sort((a, b) => a - b),
    },
    resampling: {
      version: ODDS_RESAMPLING_VERSION,
      ...request.resampling,
    },
    history: historyManifest,
    verdict: { version: ODDS_VERDICT_VERSION, policy },
  };
  const result: SetupOddsResult = {
    resampled,
    resampledVerdict: judgeResampled(resampled, policy),
    history,
    historyVerdict: history === null ? null : judgeHistory(history, policy),
  };
  return { manifest, result, fingerprint: fingerprintOf(manifest, result) };
}

/** sha256 over the canonical serialisation — key order cannot move it. */
export function fingerprintOf(
  manifest: SetupOddsManifest,
  result: SetupOddsResult,
): string {
  return createHash("sha256")
    .update(canonicalJson({ manifest, result }))
    .digest("hex");
}

const noSession = (plan: SetupOddsPlan): string =>
  `no full session of ${plan.symbol} before ${plan.date}: nothing to draw from`;
