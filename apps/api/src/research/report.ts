import { createHash } from "node:crypto";
import { canonicalJson, istDateKey, type Candle } from "@neelkanth/core";
import { dayChart, tradeChart, type ChartSpec } from "./charts.js";
import { DAILY_RESEARCH_VERSION, type DayRun } from "./day.js";
import { tradeEvidence, type TradeEvidence } from "./evidence.js";
import {
  dayFeatures,
  patternObservations,
  strategyObservations,
  type DayFeatures,
  type PatternObservation,
  type StrategyObservation,
} from "./observations.js";

/** What a report read: every bar, by symbol, and their fingerprint (Phase 8 D5). */
export interface ReportInputs {
  bars: { symbol: string; count: number; firstTs: number; lastTs: number }[];
  /** sha256 of every bar read — what a later revision is detected against. */
  fingerprint: string;
}

/** One instrument's trading day, researched (Phase 8). */
export interface DailyReport {
  reportId: string;
  period: "DAY";
  date: string;
  symbol: string;
  /** 1, then 2 when a revised bar forces a recomputation — never edited (spec §5.8). */
  version: number;
  generatedAt: number;
  dailyResearchVersion: string;
  /** The sessions the run read; the last is `date`. */
  sessions: string[];
  inputs: ReportInputs;
  models: Record<string, unknown>;
  features: DayFeatures;
  patterns: PatternObservation[];
  strategies: StrategyObservation[];
  trades: TradeEvidence[];
  charts: { day: ChartSpec; trades: ChartSpec[] };
  /** sha256 of everything above except its id, version and generation time. */
  fingerprint: string;
}

const sha256 = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

/**
 * The fingerprint of a set of bars — every field a report could have read:
 * prices, volume and its quality, source and ingestion version. Independent
 * of the order the bars arrive in.
 */
export function inputsFingerprint(bars: readonly Candle[]): string {
  return sha256(
    [...bars]
      .sort(
        (a, b) =>
          a.ts - b.ts ||
          (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
      )
      .map((b) => [
        b.symbol,
        b.interval,
        b.ts,
        b.open,
        b.high,
        b.low,
        b.close,
        b.volume,
        b.volumeAvailable ?? null,
        b.volumeQuality ?? null,
        b.source,
        b.ingestionVersion ?? null,
      ]),
  );
}

function inputsOf(bars: readonly Candle[]): ReportInputs {
  const by = new Map<string, Candle[]>();
  for (const b of bars) by.set(b.symbol, [...(by.get(b.symbol) ?? []), b]);
  return {
    bars: [...by.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([symbol, list]) => ({
        symbol,
        count: list.length,
        firstTs: Math.min(...list.map((b) => b.ts)),
        lastTs: Math.max(...list.map((b) => b.ts)),
      })),
    fingerprint: inputsFingerprint(bars),
  };
}

/** `DAY|2026-03-02|NSE:NIFTY50-INDEX|v1`. */
export const reportIdOf = (
  date: string,
  symbol: string,
  version: number,
): string => `DAY|${date}|${symbol}|v${String(version)}`;

/**
 * The day's reports, one per evaluated instrument (Phase 8). Each carries the
 * whole market's inputs, because the run that produced it read them all —
 * the regime index and the indices the market view reads included.
 */
export function buildDailyReports(
  day: DayRun,
  generatedAt: number,
  version = 1,
): DailyReport[] {
  const inputs = inputsOf(day.bars);
  const m = day.evaluation.manifest;
  const models = {
    counterfactualVersion: m.counterfactualVersion,
    ...m.models,
    strategies: m.strategies.map((s) =>
      s.eligible
        ? { type: s.type, symbol: s.symbol, strategyVersion: s.strategyVersion }
        : { type: s.type, symbol: s.symbol, excluded: s.exclusion.kind },
    ),
    detectors: m.detectors.map((d) => ({
      patternId: d.definition.patternId,
      detectorVersion: d.definition.detectorVersion,
      params: d.params,
    })),
  };
  const evidence = tradeEvidence(day);
  return m.symbols.map((symbol) => {
    const trades = evidence.filter((e) => e.symbol === symbol);
    const body = {
      period: "DAY" as const,
      date: day.date,
      symbol,
      dailyResearchVersion: DAILY_RESEARCH_VERSION,
      sessions: day.sessions,
      inputs,
      models,
      features: dayFeatures(day, symbol),
      patterns: patternObservations(day, symbol),
      strategies: strategyObservations(day, symbol),
      trades,
      charts: {
        day: dayChart(day, symbol, trades),
        trades: trades.map((e) => tradeChart(day, e)),
      },
    };
    return {
      reportId: reportIdOf(day.date, symbol, version),
      version,
      generatedAt,
      ...body,
      fingerprint: sha256(body),
    };
  });
}

/**
 * Whether a report's inputs still stand (spec §5.8): the stored bars of its
 * sessions, every symbol it read, fingerprinted again. A revision anywhere in
 * them — a price, a volume flag, a source, an ingestion version, a bar added
 * or gone — makes it stale; a change on any other day does not.
 */
export function isStale(
  report: Pick<DailyReport, "sessions" | "inputs">,
  current: readonly Candle[],
): boolean {
  const sessions = new Set(report.sessions);
  const symbols = new Set(report.inputs.bars.map((b) => b.symbol));
  const read = current.filter(
    (c) => symbols.has(c.symbol) && sessions.has(istDateKey(c.ts)),
  );
  return inputsFingerprint(read) !== report.inputs.fingerprint;
}
