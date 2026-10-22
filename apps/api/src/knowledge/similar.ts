import type { Db } from "mongodb";
import { ResearchReportsRepository } from "@neelkanth/db";
import type { DailyReport } from "../research/report.js";

/** Bumped whenever what "similar" means changes (Phase 10 D4). */
export const SIMILARITY_MODEL_VERSION = "1";

/** What a session is compared by: its features and its patterns. */
export type SessionInput = Pick<
  DailyReport,
  "date" | "symbol" | "features" | "patterns"
>;

export interface SimilarSession {
  date: string;
  symbol: string;
  /** Euclidean distance in the standardised feature space; 0 is identical. */
  distance: number;
  /** The raw features, so a reader sees why it is close. */
  features: Record<string, number>;
}

export interface SimilarityAnswer {
  modelVersion: string;
  target: { date: string; symbol: string };
  /** Sessions compared against — every one on or before asOf, the target excluded. */
  poolSize: number;
  /** The first and last session in the pool; null when it is empty. */
  range: { fromDate: string; toDate: string } | null;
  asOf: string;
  dimensions: string[];
  nearest: SimilarSession[];
}

const REGIMES = ["BULLISH", "BEARISH", "NEUTRAL"] as const;

/** A session's raw feature vector, over the pattern ids the pool knows. */
function rawFeatures(
  s: SessionInput,
  patternIds: readonly string[],
): Record<string, number> {
  const f = s.features;
  const out: Record<string, number> = {
    returnPct: f.returnPct,
    gapPct: f.gapPct ?? 0,
    relativeRange: f.open === 0 ? 0 : f.range / f.open,
    realisedVolatility: f.realisedVolatility ?? 0,
  };
  for (const r of REGIMES) out[`regime:${r}`] = f.regimeAtClose === r ? 1 : 0;
  for (const p of patternIds)
    out[`pattern:${p}`] = s.patterns.filter((x) => x.patternId === p).length;
  return out;
}

/**
 * The sessions most like `target` (Phase 10 D4, D5): each session's day
 * features — return, gap, relative range, realised volatility, regime at the
 * close, and how often each pattern occurred — standardised over the pool,
 * compared by Euclidean distance, the nearest `k`.
 *
 * The pool is every session on or before `asOf` (by default the target's own
 * date), the target excluded; and the standardisation is over that pool only,
 * so neither a later session nor the scale of later sessions can reach the
 * answer (§5.4). A dimension with no spread in the pool carries no weight.
 */
export function similarSessions(
  target: SessionInput,
  sessions: readonly SessionInput[],
  options: { k?: number; asOf?: string; sameSymbol?: boolean } = {},
): SimilarityAnswer {
  const asOf = options.asOf ?? target.date;
  if (target.date > asOf)
    throw new Error(
      `similar sessions: the target ${target.date} is after asOf ${asOf}`,
    );
  const k = Math.max(1, options.k ?? 5);
  const pool = sessions.filter(
    (s) =>
      s.date <= asOf &&
      !(s.date === target.date && s.symbol === target.symbol) &&
      (options.sameSymbol !== true || s.symbol === target.symbol),
  );
  const patternIds = [
    ...new Set(pool.flatMap((s) => s.patterns.map((p) => p.patternId))),
  ].sort();
  const vectors = pool.map((s) => rawFeatures(s, patternIds));
  const dimensions = Object.keys(rawFeatures(target, patternIds));
  const scale: Record<string, { mean: number; sd: number }> = {};
  for (const d of dimensions) {
    const xs = vectors.map((v) => v[d] ?? 0);
    const mean =
      xs.length === 0 ? 0 : xs.reduce((a, x) => a + x, 0) / xs.length;
    const sd =
      xs.length < 2
        ? 0
        : Math.sqrt(
            xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1),
          );
    scale[d] = { mean, sd };
  }
  const z = (v: Record<string, number>, d: string): number => {
    const s = scale[d];
    return s === undefined || s.sd === 0 ? 0 : ((v[d] ?? 0) - s.mean) / s.sd;
  };
  const t = rawFeatures(target, patternIds);
  const nearest = pool
    .map((s, i) => {
      const v = vectors[i] ?? {};
      const distance = Math.sqrt(
        dimensions.reduce((a, d) => a + (z(v, d) - z(t, d)) ** 2, 0),
      );
      return {
        date: s.date,
        symbol: s.symbol,
        distance: Math.round(distance * 1e6) / 1e6,
        features: v,
      };
    })
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
        (a.symbol < b.symbol ? -1 : 1),
    )
    .slice(0, k);
  return {
    modelVersion: SIMILARITY_MODEL_VERSION,
    target: { date: target.date, symbol: target.symbol },
    poolSize: pool.length,
    range:
      pool.length === 0
        ? null
        : {
            fromDate: pool.reduce((m, x) => (x.date < m ? x.date : m), asOf),
            toDate: pool.reduce((m, x) => (x.date > m ? x.date : m), ""),
          },
    asOf,
    dimensions,
    nearest,
  };
}

/**
 * Similar sessions over the indexed daily reports (Phase 10 D4, D6): the
 * newest version of every DAY report on or before `asOf`, compared with the
 * one for `date` and `symbol`. Null when that day has no report.
 */
export async function findSimilarSessions(
  db: Db,
  q: {
    date: string;
    symbol: string;
    k?: number;
    asOf?: string;
    sameSymbol?: boolean;
  },
): Promise<SimilarityAnswer | null> {
  const { date, symbol, ...options } = q;
  const reports = new ResearchReportsRepository(db);
  const target = await reports.latest("DAY", date, symbol);
  if (target === null) return null;
  const asOf = q.asOf ?? date;
  const pool = await reports.latestInRange("DAY", "0001-01-01", asOf);
  const input = (r: Record<string, unknown>): SessionInput =>
    r as unknown as SessionInput;
  return similarSessions(
    input(target.report),
    pool.map((d) => input(d.report)),
    { ...options, asOf },
  );
}
