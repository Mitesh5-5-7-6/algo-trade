import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import {
  canonicalJson,
  intervalMs,
  istDayStart,
  parseHHMM,
  strategyVersionOf,
  type CandleInterval,
  type StrategyConfig,
} from "@neelkanth/core";
import {
  OrdersRepository,
  PaperReconciliationsRepository,
  PaperSessionReportsRepository,
  RiskEventsRepository,
  RiskLogsRepository,
  SettingsRepository,
  SignalsRepository,
  StrategiesRepository,
  TradesRepository,
} from "@neelkanth/db";
import { createStrategyRegistry } from "@neelkanth/strategies";
import { runReplayWithTrail } from "../golden/pipeline.js";
import { replayExclusion } from "../replay/run.js";
import { sessionsFromCandles } from "../replay/sessions.js";
import { loadCandles } from "../replay/store.js";
import { warmupFrom } from "../backtest/run.js";
import {
  isIndexSymbol,
  syntheticIndexInstrument,
} from "../engines/synthetic-index.js";
import { buildSessionRecord, type SessionRecord } from "./session-report.js";
import { compareWithReplay, type ParityResult } from "./parity.js";

const DAY_MS = 86_400_000;

/** Bumped when what a report holds changes. */
export const SESSION_REPORT_VERSION = "1";

/** A paper session, reported and held against its replay (Phase 14 D6). */
export interface PaperSessionReport {
  reportVersion: string;
  session: string;
  generatedAt: number;
  record: SessionRecord;
  replay: {
    interval: CandleInterval | null;
    /** The days replayed: the warm-up lead, then the session. */
    fromDate: string;
    bars: number;
    /** sha256 of the bars replayed — the same bars, the same fingerprint. */
    barsFingerprint: string;
    strategies: Array<{ strategyId: string; type: string; version: string }>;
    /** Strategies the replay could not run, and why — not silently dropped. */
    excluded: Array<{ strategyId: string; reason: string }>;
  };
  parity: ParityResult;
  /** Reconciliation clean, the day flat, and the replay agreeing throughout. */
  clean: boolean;
}

/**
 * Report one paper session from the paper database, and hold it against the
 * replay of the bars the session itself built (Phase 14 D6).
 *
 * The replay runs the strategies as configured now, from the warm-up lead
 * the backtest uses — the live indicators were warmed from stored bars too —
 * and only the session's own decisions are compared. Index instruments are
 * the Phase 4 replay's: lot 1, in points.
 *
 * Reads; writes `paper_session_reports` only, and only when asked.
 */
export async function reportSessionFromStore(
  db: Db,
  request: { session: string; generatedAt: number },
  keep: { save: false } | { save: true; reportId: string },
): Promise<{ report: PaperSessionReport; saved: boolean }> {
  const { session } = request;
  const from = istDayStart(session);
  const to = from + DAY_MS;
  const settings = await new SettingsRepository(db).getGlobal();

  const [signals, riskLogs, orders, trades, reconciliations, riskEvents] =
    await Promise.all([
      new SignalsRepository(db).findActionableRange(from, to),
      new RiskLogsRepository(db).findRange(from, to),
      new OrdersRepository(db).findAllByDateRange(from, to),
      new TradesRepository(db).findRange(from, to),
      new PaperReconciliationsRepository(db).forSession(session),
      new RiskEventsRepository(db).forSession(session),
    ]);
  const sessionOpenTs = from + parseHHMM(settings.marketHours.open) * 60_000;
  const record = buildSessionRecord({
    session,
    sessionOpenTs,
    signals,
    riskLogs,
    orders,
    trades,
    reconciliations,
    riskEvents,
  });

  // --- The subject: what is enabled now, and anything that signalled today.
  const strategiesRepo = new StrategiesRepository(db);
  const configs = new Map(
    (await strategiesRepo.findEnabled()).map((c) => [c.strategyId, c]),
  );
  for (const id of new Set(signals.map((s) => s.strategyId))) {
    if (configs.has(id)) continue;
    const config = await strategiesRepo.findById(id);
    if (config !== null) configs.set(id, config);
  }

  const registry = createStrategyRegistry();
  const intervalOf = (c: StrategyConfig): CandleInterval | null => {
    const symbol = c.symbols[0];
    return symbol === undefined
      ? null
      : registry.instantiate(c.type, c.params, symbol).interval;
  };
  const intervals = new Set(
    [...configs.values()]
      .map(intervalOf)
      .filter((i): i is CandleInterval => i !== null),
  );
  if (intervals.size > 1)
    throw new Error(
      `the subject decides on ${[...intervals].join(" and ")} bars; a replay reads one interval`,
    );
  const [interval = null] = intervals;
  const fromDate = warmupFrom(session);

  const candles =
    interval === null
      ? []
      : await loadCandles(
          db,
          [
            ...new Set([
              ...[...configs.values()].flatMap((c) => c.symbols),
              ...settings.indexSymbols,
              ...settings.breadthSymbols,
            ]),
          ],
          interval,
          fromDate,
          session,
        );
  const held = new Set(candles.map((c) => c.symbol));

  const runnable: StrategyConfig[] = [];
  const excluded: Array<{ strategyId: string; reason: string }> = [];
  for (const config of configs.values()) {
    const why =
      interval === null
        ? null
        : config.symbols
            .map((symbol) =>
              replayExclusion(
                config.type,
                config.params,
                symbol,
                interval,
                held,
              ),
            )
            .find((e) => e !== null);
    if (interval === null || why === undefined || why === null)
      runnable.push(config);
    else excluded.push({ strategyId: config.strategyId, reason: why.reason });
  }

  const inSession = (ts: number) => ts >= from && ts < to;
  let replayTrail = {
    signals: [] as typeof signals,
    riskLogs: [] as typeof riskLogs,
    trades: [] as typeof trades,
  };
  if (
    interval !== null &&
    runnable.length > 0 &&
    candles.some((c) => inSession(c.ts))
  ) {
    const sorted = [...candles].sort(
      (a, b) => a.ts - b.ts || a.symbol.localeCompare(b.symbol),
    );
    const { sessions, specialSessions } = sessionsFromCandles(
      sorted,
      settings.marketHours,
    );
    const { trail } = await runReplayWithTrail({
      interval,
      intervals: [interval],
      source: { kind: "candles", candles: sorted },
      sessions,
      specialSessions,
      strategies: runnable,
      indexSymbols: settings.indexSymbols,
      breadthSymbols: settings.breadthSymbols,
      allocatedCapital: settings.capitalAllocation,
      limits: settings.globalRiskLimits,
      instruments: [...new Set(runnable.flatMap((c) => c.symbols))]
        .filter(isIndexSymbol)
        .map(syntheticIndexInstrument),
    });
    replayTrail = {
      signals: trail.signals.filter((s) => inSession(s.ts)),
      riskLogs: trail.riskLogs.filter((l) => inSession(l.ts)),
      trades: trail.trades.filter((t) => inSession(t.entryTime)),
    };
  }

  const replayedVersions = new Map(
    runnable.map((c) => [c.strategyId, strategyVersionOf(c)]),
  );
  const parity = compareWithReplay({
    paper: { signals, riskLogs, trades },
    replay: replayTrail,
    replayedVersions,
    excluded,
    intervalMs: interval === null ? 5 * 60_000 : intervalMs(interval),
  });

  const report: PaperSessionReport = {
    reportVersion: SESSION_REPORT_VERSION,
    session,
    generatedAt: request.generatedAt,
    record,
    replay: {
      interval,
      fromDate,
      bars: candles.length,
      barsFingerprint: createHash("sha256")
        .update(
          canonicalJson(
            [...candles]
              .sort((a, b) => a.ts - b.ts || a.symbol.localeCompare(b.symbol))
              .map((c) => [c.symbol, c.ts, c.open, c.high, c.low, c.close]),
          ),
        )
        .digest("hex"),
      strategies: runnable.map((c) => ({
        strategyId: c.strategyId,
        type: c.type,
        version: strategyVersionOf(c),
      })),
      excluded,
    },
    parity,
    clean:
      record.reconciliation.clean &&
      record.pnl.openTrades === 0 &&
      parity.clean,
  };

  if (!keep.save) return { report, saved: false };
  const saved = await new PaperSessionReportsRepository(db).save({
    reportId: keep.reportId,
    session,
    generatedAt: request.generatedAt,
    clean: report.clean,
    report: report as unknown as Record<string, unknown>,
  });
  return { report, saved };
}
