import type { Relation } from "../counterfactual/attribution.js";
import { ALL } from "../counterfactual/matrix.js";
import type { Regime } from "../counterfactual/regime.js";
import type { TradeEvidence } from "./evidence.js";
import type { DailyReport } from "./report.js";

/** What a window aggregates: the parts of a daily report it reads. */
export type DailyInput = Pick<
  DailyReport,
  "date" | "symbol" | "patterns" | "trades"
>;

/** Trades, summed — with how they fell across days (Phase 9 D3). */
export interface Tally {
  n: number;
  wins: number;
  losses: number;
  net: number;
  /** Net per Trade; null without Trades. */
  expectancy: number | null;
  charges: number;
  slippage: number;
  /** Days with at least one Trade, and those whose Trades made or lost money in sum. */
  daysTraded: number;
  winningDays: number;
  losingDays: number;
}

export interface PairRow {
  patternId: string;
  strategyType: string;
  regime: Regime | typeof ALL;
  occurrences: number;
  /** Days on which the pattern occurred at all. */
  daysOccurred: number;
  relations: Record<Relation, number>;
  /** The Trades it ENTERED on those occurrences. */
  trades: Tally;
}

export interface StrategyRow {
  strategyType: string;
  trades: Tally;
  exits: Record<string, number>;
}

/** A Trade's condition (Phase 8 D2): its strategy, its entry regime, what preceded it. */
export interface ConditionRow {
  strategyType: string;
  regime: Regime;
  /** The distinct patterns that preceded the entry, sorted — or NONE. */
  preceding: string;
  trades: Tally;
}

export interface Aggregate {
  days: string[];
  instruments: string[];
  pairs: PairRow[];
  strategies: StrategyRow[];
  conditions: ConditionRow[];
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A dated Trade: evidence keys are unique only within a day. */
interface DatedTrade {
  id: string;
  date: string;
  e: TradeEvidence;
}

export function tally(trades: readonly DatedTrade[]): Tally {
  const unique = new Map(trades.map((t) => [t.id, t]));
  const byDay = new Map<string, number>();
  let net = 0;
  let wins = 0;
  let losses = 0;
  let charges = 0;
  let slippage = 0;
  for (const t of [...unique.values()].sort((a, b) => cmp(a.id, b.id))) {
    const x = t.e.outcome.net;
    net += x;
    charges += t.e.outcome.charges;
    slippage += t.e.outcome.slippage;
    if (x > 0) wins += 1;
    else if (x < 0) losses += 1;
    byDay.set(t.date, (byDay.get(t.date) ?? 0) + x);
  }
  const n = unique.size;
  const dayNets = [...byDay.values()];
  return {
    n,
    wins,
    losses,
    net: round4(net),
    expectancy: n === 0 ? null : round4(net / n),
    charges: round4(charges),
    slippage: round4(slippage),
    daysTraded: byDay.size,
    winningDays: dayNets.filter((x) => x > 0).length,
    losingDays: dayNets.filter((x) => x < 0).length,
  };
}

/**
 * Pool a window's daily reports (Phase 9 D3) — every instrument, every day.
 * A Trade counts once per row however many occurrences point at it; Trades
 * from different days never collide, however their per-day keys repeat.
 * Rows are sorted, so the aggregate does not depend on input order.
 */
export function aggregate(reports: readonly DailyInput[]): Aggregate {
  const trades = new Map<string, DatedTrade>();
  for (const r of reports)
    for (const e of r.trades) {
      const id = `${r.date}|${e.key}`;
      trades.set(id, { id, date: r.date, e });
    }

  interface PairCell {
    row: Omit<PairRow, "trades" | "daysOccurred">;
    days: Set<string>;
    entered: DatedTrade[];
  }
  const pairs = new Map<string, PairCell>();
  const cell = (
    patternId: string,
    strategyType: string,
    regime: Regime | typeof ALL,
  ): PairCell => {
    const key = [patternId, strategyType, regime].join("|");
    let c = pairs.get(key);
    if (c === undefined) {
      c = {
        row: {
          patternId,
          strategyType,
          regime,
          occurrences: 0,
          relations: { ENTERED: 0, SIGNALLED: 0, HOLDING: 0, FLAT: 0 },
        },
        days: new Set(),
        entered: [],
      };
      pairs.set(key, c);
    }
    return c;
  };
  for (const r of reports)
    for (const p of r.patterns)
      for (const [strategyType, s] of Object.entries(p.strategies))
        for (const regime of [p.regime, ALL] as const) {
          const c = cell(p.patternId, strategyType, regime);
          c.row.occurrences += 1;
          c.row.relations[s.relation] += 1;
          c.days.add(r.date);
          if (s.relation === "ENTERED" && s.tradeKey !== undefined) {
            const t = trades.get(`${r.date}|${s.tradeKey}`);
            if (t === undefined)
              throw new Error(
                `report ${r.date} ${r.symbol} names ${s.tradeKey}, which it does not hold`,
              );
            c.entered.push(t);
          }
        }

  const byStrategy = new Map<string, DatedTrade[]>();
  const byCondition = new Map<
    string,
    {
      strategyType: string;
      regime: Regime;
      preceding: string;
      list: DatedTrade[];
    }
  >();
  for (const t of trades.values()) {
    byStrategy.set(t.e.strategyType, [
      ...(byStrategy.get(t.e.strategyType) ?? []),
      t,
    ]);
    const preceding =
      [...new Set(t.e.preceding.patterns.map((p) => p.patternId))]
        .sort()
        .join("+") || "NONE";
    const key = [t.e.strategyType, t.e.preceding.regime, preceding].join("|");
    const c = byCondition.get(key) ?? {
      strategyType: t.e.strategyType,
      regime: t.e.preceding.regime,
      preceding,
      list: [],
    };
    c.list.push(t);
    byCondition.set(key, c);
  }

  return {
    days: [...new Set(reports.map((r) => r.date))].sort(),
    instruments: [...new Set(reports.map((r) => r.symbol))].sort(),
    pairs: [...pairs.values()]
      .map((c) => ({
        ...c.row,
        daysOccurred: c.days.size,
        trades: tally(c.entered),
      }))
      .sort(
        (a, b) =>
          cmp(a.patternId, b.patternId) ||
          cmp(a.strategyType, b.strategyType) ||
          cmp(a.regime, b.regime),
      ),
    strategies: [...byStrategy.entries()]
      .map(([strategyType, list]) => {
        const exits: Record<string, number> = {};
        for (const t of list)
          exits[t.e.exit.reason] = (exits[t.e.exit.reason] ?? 0) + 1;
        return {
          strategyType,
          trades: tally(list),
          exits: Object.fromEntries(
            Object.entries(exits).sort(([a], [b]) => cmp(a, b)),
          ),
        };
      })
      .sort((a, b) => cmp(a.strategyType, b.strategyType)),
    conditions: [...byCondition.values()]
      .map((c) => ({
        strategyType: c.strategyType,
        regime: c.regime,
        preceding: c.preceding,
        trades: tally(c.list),
      }))
      .sort(
        (a, b) =>
          cmp(a.strategyType, b.strategyType) ||
          cmp(a.regime, b.regime) ||
          cmp(a.preceding, b.preceding),
      ),
  };
}
