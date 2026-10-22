import { canonicalJson } from "@neelkanth/core";
import type { Db } from "mongodb";
import {
  ResearchReportsRepository,
  StrategyExperimentsRepository,
  type StrategyExperimentDoc,
} from "@neelkanth/db";
import type { Relation } from "../counterfactual/attribution.js";
import type { TradeEvidence } from "../research/evidence.js";
import type { DailyReport } from "../research/report.js";
import type { Hypothesis } from "../validation/hypothesis.js";
import type { HypothesisTest } from "../validation/gate.js";
import { MAX_RESULTS, searchKnowledge, type KnowledgeHit } from "./search.js";

/** Bumped whenever a read model's meaning changes (Phase 10 D6). */
export const READ_MODEL_VERSION = "1";

/**
 * What every answer carries (Phase 10 D6, spec Phase 11): how many things it
 * counted, over which sessions, as of when, under which versions and which
 * cost assumptions — so no number travels without its context.
 */
export interface Provenance {
  readModelVersion: string;
  /** The things the answer counts — occurrences, Trades, entries. */
  n: number;
  /** The first and last session read; null when nothing was read. */
  range: { fromDate: string; toDate: string } | null;
  asOf: string | null;
  /** Daily reports (or experiments) read to answer. */
  sources: number;
  versions: {
    dailyResearch: string[];
    counterfactual: string[];
    gatePolicy: string[];
    /** TYPE@version. */
    strategies: string[];
    /** PATTERN@version. */
    detectors: string[];
  };
  /** Every distinct slippage and transaction-cost model the money was costed with. */
  costs: { slippage: unknown; transactionCost: unknown }[];
}

/** Which daily reports a question reads. */
export interface ReportScope {
  symbols?: string[];
  fromDate?: string;
  toDate?: string;
  /** Nothing about a session after this date (D5). */
  asOf?: string;
}

const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();
const lower = (a: string | undefined, b: string | undefined) =>
  a === undefined ? b : b === undefined ? a : a < b ? a : b;

/** The reports in scope, oldest first, then by symbol. */
export function inScope(
  reports: readonly DailyReport[],
  q: ReportScope,
): DailyReport[] {
  const to = lower(q.toDate, q.asOf);
  return reports
    .filter(
      (r) =>
        (q.fromDate === undefined || r.date >= q.fromDate) &&
        (to === undefined || r.date <= to) &&
        (q.symbols === undefined || q.symbols.includes(r.symbol)),
    )
    .sort((a, b) =>
      a.date < b.date
        ? -1
        : a.date > b.date
          ? 1
          : a.symbol < b.symbol
            ? -1
            : a.symbol > b.symbol
              ? 1
              : 0,
    );
}

function distinctCosts(
  models: readonly Record<string, unknown>[],
): Provenance["costs"] {
  const seen = new Map<string, Provenance["costs"][number]>();
  for (const m of models) {
    const c = {
      slippage: m["slippage"],
      transactionCost: m["transactionCost"],
    };
    seen.set(canonicalJson(c), c);
  }
  return [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, c]) => c);
}

/** The provenance of an answer read from these daily reports. */
export function reportProvenance(
  reports: readonly DailyReport[],
  n: number,
  asOf: string | undefined,
): Provenance {
  const strategies: string[] = [];
  const detectors: string[] = [];
  const counterfactual: string[] = [];
  for (const r of reports) {
    for (const s of r.strategies)
      if (s.eligible) strategies.push(`${s.type}@${s.strategyVersion}`);
    const m = r.models as {
      counterfactualVersion?: string;
      detectors?: { patternId: string; detectorVersion: string }[];
    };
    if (m.counterfactualVersion !== undefined)
      counterfactual.push(m.counterfactualVersion);
    for (const d of m.detectors ?? [])
      detectors.push(`${d.patternId}@${d.detectorVersion}`);
  }
  const first = reports[0];
  const last = reports.at(-1);
  return {
    readModelVersion: READ_MODEL_VERSION,
    n,
    range:
      first === undefined || last === undefined
        ? null
        : { fromDate: first.date, toDate: last.date },
    asOf: asOf ?? null,
    sources: reports.length,
    versions: {
      dailyResearch: sorted(reports.map((r) => r.dailyResearchVersion)),
      counterfactual: sorted(counterfactual),
      gatePolicy: [],
      strategies: sorted(strategies),
      detectors: sorted(detectors),
    },
    costs: distinctCosts(reports.map((r) => r.models)),
  };
}

// ── findPatterns ────────────────────────────────────────────────────────────

export interface PatternOccurrence {
  date: string;
  symbol: string;
  patternId: string;
  detectorVersion: string;
  ts: number;
  direction: string;
  regime: string;
  /** What each strategy on the symbol did with it — and, when it traded, how that ended. */
  strategies: {
    type: string;
    relation: Relation;
    trade?: { key: string; result: string; net: number };
  }[];
}

/** Pattern retrieval (D6): where and when a pattern occurred, in which regime, what each strategy did. */
export function findPatterns(
  reports: readonly DailyReport[],
  q: ReportScope & {
    patterns?: string[];
    regimes?: string[];
    direction?: string;
  } = {},
): Provenance & { occurrences: PatternOccurrence[] } {
  const scoped = inScope(reports, q);
  const occurrences: PatternOccurrence[] = [];
  for (const r of scoped) {
    const trades = new Map(r.trades.map((t) => [t.key, t]));
    for (const p of r.patterns) {
      if (q.patterns !== undefined && !q.patterns.includes(p.patternId))
        continue;
      if (q.regimes !== undefined && !q.regimes.includes(p.regime)) continue;
      if (q.direction !== undefined && p.direction !== q.direction) continue;
      occurrences.push({
        date: r.date,
        symbol: r.symbol,
        patternId: p.patternId,
        detectorVersion: p.detectorVersion,
        ts: p.ts,
        direction: p.direction,
        regime: p.regime,
        strategies: Object.entries(p.strategies)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([type, s]) => {
            const t =
              s.tradeKey === undefined ? undefined : trades.get(s.tradeKey);
            return t === undefined
              ? { type, relation: s.relation }
              : {
                  type,
                  relation: s.relation,
                  trade: {
                    key: t.key,
                    result: t.outcome.result,
                    net: t.outcome.net,
                  },
                };
          }),
      });
    }
  }
  occurrences.sort((a, b) => a.ts - b.ts || (a.symbol < b.symbol ? -1 : 1));
  return {
    ...reportProvenance(scoped, occurrences.length, q.asOf),
    occurrences,
  };
}

// ── tradeHistory ────────────────────────────────────────────────────────────

export interface TradeSummary {
  wins: number;
  losses: number;
  flat: number;
  net: number;
  /** Net per Trade; null with no Trades. */
  expectancy: number | null;
}

const summarise = (trades: readonly TradeEvidence[]): TradeSummary => {
  const net = trades.reduce((a, t) => a + t.outcome.net, 0);
  const count = (r: string) =>
    trades.filter((t) => t.outcome.result === r).length;
  return {
    wins: count("WIN"),
    losses: count("LOSS"),
    flat: count("FLAT"),
    net,
    expectancy: trades.length === 0 ? null : net / trades.length,
  };
};

/**
 * Strategy history (D6): the Trades, by strategy, by a pattern among those
 * that preceded the entry, by the regime at the entry, by outcome — and their
 * summary, over exactly the Trades listed.
 */
export function tradeHistory(
  reports: readonly DailyReport[],
  q: ReportScope & {
    strategies?: string[];
    patterns?: string[];
    regimes?: string[];
    outcome?: "WIN" | "LOSS" | "FLAT";
  } = {},
): Provenance & {
  trades: (TradeEvidence & { date: string })[];
  summary: TradeSummary;
} {
  const scoped = inScope(reports, q);
  const trades = scoped.flatMap((r) =>
    r.trades
      .filter(
        (t) =>
          (q.strategies === undefined ||
            q.strategies.includes(t.strategyType)) &&
          (q.patterns === undefined ||
            t.preceding.patterns.some((p) =>
              q.patterns?.includes(p.patternId),
            )) &&
          (q.regimes === undefined || q.regimes.includes(t.preceding.regime)) &&
          (q.outcome === undefined || t.outcome.result === q.outcome),
      )
      .map((t) => ({ ...t, date: r.date })),
  );
  return {
    ...reportProvenance(scoped, trades.length, q.asOf),
    trades,
    summary: summarise(trades),
  };
}

// ── strategyMatrix ──────────────────────────────────────────────────────────

export interface StrategyMatrixRow {
  strategyType: string;
  /** Occurrences of the pattern on an instrument the strategy ran on. */
  occurrences: number;
  relations: Record<Relation, number>;
  /** The Trades its occurrences led to, and how they ended. */
  trades: number;
  summary: TradeSummary;
}

/**
 * One pattern against every strategy (D6), from the daily reports: for each
 * strategy, how often it was on the instrument when the pattern fired, what
 * it did, and how the Trades it took on the pattern ended. Strategies that
 * could not run are listed apart, with why.
 */
export function strategyMatrix(
  reports: readonly DailyReport[],
  q: ReportScope & { patternId: string },
): Provenance & {
  patternId: string;
  rows: StrategyMatrixRow[];
  excluded: { strategyType: string; reason: string }[];
} {
  const scoped = inScope(reports, q);
  const acc = new Map<
    string,
    { occ: number; rel: Record<Relation, number>; trades: TradeEvidence[] }
  >();
  const excluded = new Map<string, string>();
  let occurrences = 0;
  for (const r of scoped) {
    for (const s of r.strategies)
      if (!s.eligible) excluded.set(s.type, s.exclusion.kind);
    const trades = new Map(r.trades.map((t) => [t.key, t]));
    for (const p of r.patterns) {
      if (p.patternId !== q.patternId) continue;
      occurrences += 1;
      for (const [type, s] of Object.entries(p.strategies)) {
        const a = acc.get(type) ?? {
          occ: 0,
          rel: { ENTERED: 0, SIGNALLED: 0, HOLDING: 0, FLAT: 0 },
          trades: [],
        };
        a.occ += 1;
        a.rel[s.relation] += 1;
        const t = s.tradeKey === undefined ? undefined : trades.get(s.tradeKey);
        if (t !== undefined) a.trades.push(t);
        acc.set(type, a);
      }
    }
  }
  const rows = [...acc.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([strategyType, a]) => ({
      strategyType,
      occurrences: a.occ,
      relations: a.rel,
      trades: a.trades.length,
      summary: summarise(a.trades),
    }));
  return {
    ...reportProvenance(scoped, occurrences, q.asOf),
    patternId: q.patternId,
    rows,
    excluded: [...excluded.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([strategyType, reason]) => ({ strategyType, reason })),
  };
}

// ── experimentHistory ───────────────────────────────────────────────────────

export interface ExperimentEntry {
  docId: string;
  kind: string;
  title: string;
  text: string;
  subject: { fromDate: string; toDate: string };
  n: number | null;
  outcome: string | null;
  sourceId: string;
}

/**
 * Experiment history (D6) — counterfactual runs, hypotheses and findings for
 * a strategy or pattern — from their indexed documents, with the versions and
 * cost models read from the experiments behind them.
 */
export function experimentHistoryOf(
  hits: readonly KnowledgeHit[],
  experiments: readonly StrategyExperimentDoc[],
  asOf: string | undefined,
): Provenance & { entries: ExperimentEntry[] } {
  const ids = new Set(hits.map((h) => h.source.id));
  // A FINDING's source is its test; a HYPOTHESIS's and a run's, themselves.
  const behind = experiments.filter((e) => ids.has(e.experimentId));
  const counterfactual: string[] = [];
  const gatePolicy: string[] = [];
  const strategies: string[] = [];
  const detectors: string[] = [];
  const costs: Record<string, unknown>[] = [];
  for (const e of behind) {
    if (e.kind === "COUNTERFACTUAL") {
      const m = e.manifest as {
        counterfactualVersion: string;
        strategies: {
          type: string;
          eligible: boolean;
          strategyVersion?: string;
        }[];
        detectors: {
          definition: { patternId: string; detectorVersion: string };
        }[];
        models: Record<string, { version: string }>;
      };
      counterfactual.push(m.counterfactualVersion);
      for (const s of m.strategies)
        if (s.eligible && s.strategyVersion !== undefined)
          strategies.push(`${s.type}@${s.strategyVersion}`);
      for (const d of m.detectors)
        detectors.push(
          `${d.definition.patternId}@${d.definition.detectorVersion}`,
        );
      costs.push(m.models);
    } else if (e.kind === "HYPOTHESIS") {
      const h = e.manifest as unknown as Hypothesis;
      strategies.push(`${h.cell.strategyType}@${h.pins.strategyVersion}`);
      detectors.push(`${h.cell.patternId}@${h.pins.detectorVersion}`);
      costs.push({
        slippage: { version: h.pins.slippage },
        transactionCost: { version: h.pins.transactionCost },
      });
    } else {
      gatePolicy.push(
        (e.result as unknown as HypothesisTest).gatePolicyVersion,
      );
    }
  }
  const entries = hits.map((h) => ({
    docId: h.docId,
    kind: h.kind,
    title: h.title,
    text: h.text,
    subject: h.subject,
    n: h.facets.n ?? null,
    outcome: h.facets.outcome ?? null,
    sourceId: h.source.id,
  }));
  const from = entries.reduce<string | undefined>(
    (m, e) => lower(m, e.subject.fromDate),
    undefined,
  );
  const to = entries.reduce<string | undefined>(
    (m, e) => (m === undefined || e.subject.toDate > m ? e.subject.toDate : m),
    undefined,
  );
  return {
    readModelVersion: READ_MODEL_VERSION,
    n: entries.length,
    range:
      from === undefined || to === undefined
        ? null
        : { fromDate: from, toDate: to },
    asOf: asOf ?? null,
    sources: behind.length,
    versions: {
      dailyResearch: [],
      counterfactual: sorted(counterfactual),
      gatePolicy: sorted(gatePolicy),
      strategies: sorted(strategies),
      detectors: sorted(detectors),
    },
    costs: distinctCosts(costs),
    entries,
  };
}

// ── Over the research database ──────────────────────────────────────────────

/** The newest version of every daily report in scope. */
export async function readDailyReports(
  db: Db,
  q: ReportScope,
): Promise<DailyReport[]> {
  const docs = await new ResearchReportsRepository(db).latestInRange(
    "DAY",
    q.fromDate ?? "0001-01-01",
    lower(q.toDate, q.asOf) ?? "9999-12-31",
  );
  return inScope(
    docs.map((d) => d.report as unknown as DailyReport),
    q,
  );
}

/** experimentHistoryOf over the indexed documents and `strategy_experiments`. */
export async function experimentHistory(
  db: Db,
  q: { strategies?: string[]; patterns?: string[]; asOf?: string },
): Promise<Provenance & { entries: ExperimentEntry[] }> {
  const hits = await searchKnowledge(db, {
    kinds: ["COUNTERFACTUAL", "HYPOTHESIS", "FINDING"],
    ...q,
    limit: MAX_RESULTS,
  });
  const repo = new StrategyExperimentsRepository(db);
  const experiments = [
    ...(await repo.listByKind("COUNTERFACTUAL")),
    ...(await repo.listByKind("HYPOTHESIS")),
    ...(await repo.listByKind("HYPOTHESIS_TEST")),
  ];
  return experimentHistoryOf(hits, experiments, q.asOf);
}
