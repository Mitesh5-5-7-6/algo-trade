import type { Trade } from "@neelkanth/core";
import {
  entryBarOf,
  type Attribution,
  type Relation,
  type StrategyRun,
} from "./attribution.js";
import { regimeAt, type Regime, type RegimeTimeline } from "./regime.js";

/** "Regardless of" this dimension — the pooled row. */
export const ALL = "ALL";

/** What a set of Trades earned (design D6). `n` is on every row, always. */
export interface TradeStats {
  n: number;
  wins: number;
  losses: number;
  /** wins / n; null when there are no Trades — not zero, which would be a claim. */
  winRate: number | null;
  gross: number;
  charges: number;
  slippage: number;
  net: number;
  /** Net per Trade; null without Trades. */
  expectancy: number | null;
  /** Mean of net ÷ quantity — comparable across strategies that size differently. */
  expectancyPerUnit: number | null;
  /** Largest peak-to-trough fall of cumulative net, Trades in exit order. */
  maxDrawdown: number;
  meanHoldMinutes: number | null;
  exits: Record<string, number>;
}

export interface MatrixRow {
  /** A pattern id, or `ALL` for the strategy's baseline. */
  patternId: string;
  /** The detector version — absent on a baseline row. */
  detectorVersion?: string;
  strategyType: string;
  symbol: string;
  regime: Regime | typeof ALL;
  /** Occurrences of the pattern in this cell; null on a baseline row. */
  occurrences: number | null;
  /** How the strategy related to them; null on a baseline row. */
  relations: Record<Relation, number> | null;
  /** The Trades it ENTERED on them — on a baseline row, every Trade. */
  trades: TradeStats;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export function tradeStats(trades: readonly Trade[]): TradeStats {
  const ordered = [...trades].sort(
    (a, b) =>
      (a.exitTime ?? 0) - (b.exitTime ?? 0) ||
      (a.tradeId < b.tradeId ? -1 : a.tradeId > b.tradeId ? 1 : 0),
  );
  const n = ordered.length;
  let gross = 0;
  let charges = 0;
  let slippage = 0;
  let net = 0;
  let perUnit = 0;
  let hold = 0;
  let wins = 0;
  let losses = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const exits: Record<string, number> = {};
  for (const t of ordered) {
    const tradeNet = t.netPnl ?? 0;
    gross += t.grossPnl ?? 0;
    charges += t.charges;
    slippage += t.slippage;
    net += tradeNet;
    perUnit += tradeNet / t.quantity;
    hold += ((t.exitTime ?? t.entryTime) - t.entryTime) / 60_000;
    if (tradeNet > 0) wins += 1;
    else if (tradeNet < 0) losses += 1;
    peak = Math.max(peak, net);
    maxDrawdown = Math.max(maxDrawdown, peak - net);
    const reason = t.exitReason ?? "OPEN";
    exits[reason] = (exits[reason] ?? 0) + 1;
  }
  return {
    n,
    wins,
    losses,
    winRate: n === 0 ? null : round4(wins / n),
    gross: round4(gross),
    charges: round4(charges),
    slippage: round4(slippage),
    net: round4(net),
    expectancy: n === 0 ? null : round4(net / n),
    expectancyPerUnit: n === 0 ? null : round4(perUnit / n),
    maxDrawdown: round4(maxDrawdown),
    meanHoldMinutes: n === 0 ? null : round4(hold / n),
    exits: Object.fromEntries(
      Object.entries(exits).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  };
}

/**
 * The matrix (design D6): a row per (pattern, strategy, symbol, regime),
 * each pooled over symbol and over regime as `ALL`, and a baseline row per
 * strategy — what it did regardless of pattern — because a conditional rate
 * means nothing without the unconditional one.
 *
 * A Trade counts once per row, however many occurrences point at it. Rows
 * are sorted, so the matrix does not depend on input order.
 */
export function buildMatrix(
  attributions: readonly Attribution[],
  runs: readonly StrategyRun[],
  timeline: RegimeTimeline,
): MatrixRow[] {
  const tradeById = new Map<string, Trade>();
  for (const run of runs)
    for (const t of run.trail.trades)
      tradeById.set(tradeKey(run.strategyType, run.symbol, t.tradeId), t);

  interface Cell {
    patternId: string;
    detectorVersion?: string;
    strategyType: string;
    symbol: string;
    regime: Regime | typeof ALL;
    occurrences: number;
    relations: Record<Relation, number>;
    trades: Map<string, Trade>;
  }
  const cells = new Map<string, Cell>();
  const cellFor = (
    patternId: string,
    detectorVersion: string | undefined,
    strategyType: string,
    symbol: string,
    regime: Regime | typeof ALL,
  ): Cell => {
    const key = [patternId, detectorVersion, strategyType, symbol, regime].join(
      "|",
    );
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = {
        patternId,
        ...(detectorVersion === undefined ? {} : { detectorVersion }),
        strategyType,
        symbol,
        regime,
        occurrences: 0,
        relations: { ENTERED: 0, SIGNALLED: 0, HOLDING: 0, FLAT: 0 },
        trades: new Map(),
      };
      cells.set(key, cell);
    }
    return cell;
  };

  for (const a of attributions) {
    for (const symbol of [a.symbol, ALL])
      for (const regime of [a.regime, ALL] as const) {
        const cell = cellFor(
          a.patternId,
          a.detectorVersion,
          a.strategyType,
          symbol,
          regime,
        );
        cell.occurrences += 1;
        cell.relations[a.relation] += 1;
        if (a.relation === "ENTERED" && a.tradeId !== undefined) {
          const key = tradeKey(a.strategyType, a.symbol, a.tradeId);
          const trade = tradeById.get(key);
          // An entry the runs do not hold is broken input, never a smaller cell.
          if (trade === undefined)
            throw new Error(`attribution names ${key}, which no run holds`);
          cell.trades.set(key, trade);
        }
      }
  }

  const rows: MatrixRow[] = [...cells.values()].map((c) => ({
    patternId: c.patternId,
    ...(c.detectorVersion === undefined
      ? {}
      : { detectorVersion: c.detectorVersion }),
    strategyType: c.strategyType,
    symbol: c.symbol,
    regime: c.regime,
    occurrences: c.occurrences,
    relations: c.relations,
    trades: tradeStats([...c.trades.values()]),
  }));

  // The baseline: every Trade the strategy made, by the regime at its entry bar.
  const baseline = new Map<
    string,
    {
      strategyType: string;
      symbol: string;
      regime: Regime | typeof ALL;
      trades: Trade[];
    }
  >();
  for (const run of runs)
    for (const t of run.trail.trades) {
      const regime = regimeAt(timeline, entryBarOf(t));
      for (const symbol of [run.symbol, ALL])
        for (const r of [regime, ALL] as const) {
          const key = [run.strategyType, symbol, r].join("|");
          const row = baseline.get(key) ?? {
            strategyType: run.strategyType,
            symbol,
            regime: r,
            trades: [],
          };
          row.trades.push(t);
          baseline.set(key, row);
        }
    }
  // A strategy that never traded still has a baseline row — n = 0 is an answer.
  for (const run of runs)
    for (const symbol of [run.symbol, ALL]) {
      const key = [run.strategyType, symbol, ALL].join("|");
      if (!baseline.has(key))
        baseline.set(key, {
          strategyType: run.strategyType,
          symbol,
          regime: ALL,
          trades: [],
        });
    }
  for (const b of baseline.values())
    rows.push({
      patternId: ALL,
      strategyType: b.strategyType,
      symbol: b.symbol,
      regime: b.regime,
      occurrences: null,
      relations: null,
      trades: tradeStats(b.trades),
    });

  // Code-unit order: a row's place must not depend on the machine's locale.
  return rows.sort((x, y) => {
    const a = rowKey(x);
    const b = rowKey(y);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * A Trade's identity across runs. Each symbol's replay numbers its Trades
 * from one, so an id alone collides between two symbols' runs of the same
 * strategy (found by the 6.8 acceptance run).
 */
function tradeKey(
  strategyType: string,
  symbol: string,
  tradeId: string,
): string {
  return [strategyType, symbol, tradeId].join("|");
}

/** Baseline rows first, then patterns; `ALL` before any symbol or regime. */
function rowKey(r: MatrixRow): string {
  const lead = (v: string): string => (v === ALL ? `0${v}` : `1${v}`);
  return [
    lead(r.patternId),
    r.detectorVersion ?? "",
    r.strategyType,
    lead(r.symbol),
    lead(r.regime),
  ].join("\u0000");
}
