import {
  intervalMs,
  istDateKey,
  type Candle,
  type Trade,
} from "@neelkanth/core";
import { entryBarOf } from "../counterfactual/attribution.js";
import { regimeAt, type Regime } from "../counterfactual/regime.js";
import type { DayRun } from "./day.js";

/** How far back "what came before the entry" looks (Phase 8 D2): half an hour of 5m bars. */
export const DEFAULT_PRECEDING_BARS = 6;

/** A pattern that preceded an entry, and by how many bars. */
export interface PrecedingPattern {
  patternId: string;
  detectorVersion: string;
  direction: string;
  ts: number;
  /** 0 = completed on the entry bar itself. */
  barsBeforeEntry: number;
}

/** One Trade, as evidence (Phase 8 D2). */
export interface TradeEvidence {
  /**
   * Unique within the day: strategy|symbol|tradeId. A Trade id alone is not —
   * each replay numbers its Trades from one (the Phase 6 collision).
   */
  key: string;
  tradeId: string;
  strategyType: string;
  symbol: string;
  side: Trade["side"];
  quantity: number;
  entry: {
    signalId: string | null;
    /** The bar the entry was decided on. */
    barTs: number;
    time: number;
    price: number;
    reason: string | null;
  };
  exit: {
    time: number | null;
    price: number | null;
    reason: string;
  };
  outcome: {
    result: "WIN" | "LOSS" | "FLAT";
    gross: number;
    charges: number;
    slippage: number;
    net: number;
    netPerUnit: number;
  };
  held: { bars: number; minutes: number };
  /**
   * Best and worst price move against the entry, per unit, over the bars it
   * was held — how much was on the table, and how close it came to the stop.
   */
  excursion: { favourable: number; adverse: number };
  preceding: { regime: Regime; patterns: PrecedingPattern[] };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * Maximum favourable and adverse excursion over `bars`, per unit. LONG:
 * favourable is the highest high above entry, adverse the lowest low below
 * it; SHORT mirrors both. Never negative — a Trade that never moved in its
 * favour has a favourable excursion of zero.
 */
export function excursionOf(
  side: Trade["side"],
  entryPrice: number,
  bars: readonly Candle[],
): { favourable: number; adverse: number } {
  if (bars.length === 0) return { favourable: 0, adverse: 0 };
  const high = Math.max(...bars.map((b) => b.high));
  const low = Math.min(...bars.map((b) => b.low));
  const up = Math.max(0, high - entryPrice);
  const down = Math.max(0, entryPrice - low);
  return side === "LONG"
    ? { favourable: round4(up), adverse: round4(down) }
    : { favourable: round4(down), adverse: round4(up) };
}

/**
 * Evidence for every Trade entered on the day (Phase 8 D2), in entry order.
 *
 * Held bars are those after the entry bar up to the one the exit fell in:
 * the entry is decided at a bar's close, so that bar is history, not
 * exposure. What preceded the entry is the regime at its bar and every
 * occurrence on its symbol in the N bars before it — or on it — within the
 * same session; nothing after the entry bar is "preceding".
 */
export function tradeEvidence(
  day: DayRun,
  precedingBars: number = DEFAULT_PRECEDING_BARS,
): TradeEvidence[] {
  const barMs = intervalMs(day.evaluation.interval);
  const out: TradeEvidence[] = [];
  for (const sd of day.strategyDays) {
    const run = day.evaluation.runs.find(
      (r) => r.strategyType === sd.strategyType && r.symbol === sd.symbol,
    );
    const signals = new Map(
      (run?.trail.signals ?? []).map((s) => [s.signalId, s]),
    );
    const bars = day.bars.filter((b) => b.symbol === sd.symbol);
    for (const t of sd.trades) {
      const entryBar = entryBarOf(t);
      const exitTime = t.exitTime ?? null;
      const heldBars = bars.filter(
        (b) => b.ts > entryBar && (exitTime === null || b.ts <= exitTime),
      );
      const signal =
        t.entrySignalId === undefined
          ? undefined
          : signals.get(t.entrySignalId);
      const net = t.netPnl ?? 0;
      const from = entryBar - precedingBars * barMs;
      const patterns: PrecedingPattern[] = day.evaluation.occurrences
        .filter(
          (o) =>
            o.symbol === t.symbol &&
            o.ts <= entryBar &&
            o.ts >= from &&
            istDateKey(o.ts) === istDateKey(entryBar),
        )
        .map((o) => ({
          patternId: o.patternId,
          detectorVersion: o.detectorVersion,
          direction: o.direction,
          ts: o.ts,
          barsBeforeEntry: Math.round((entryBar - o.ts) / barMs),
        }))
        .sort((a, b) => b.ts - a.ts || (a.patternId < b.patternId ? -1 : 1));
      out.push({
        key: [sd.strategyType, t.symbol, t.tradeId].join("|"),
        tradeId: t.tradeId,
        strategyType: sd.strategyType,
        symbol: t.symbol,
        side: t.side,
        quantity: t.quantity,
        entry: {
          signalId: t.entrySignalId ?? null,
          barTs: entryBar,
          time: t.entryTime,
          price: t.entryPrice,
          reason: signal?.reason ?? null,
        },
        exit: {
          time: exitTime,
          price: t.exitPrice ?? null,
          reason: t.exitReason ?? "OPEN",
        },
        outcome: {
          result: net > 0 ? "WIN" : net < 0 ? "LOSS" : "FLAT",
          gross: round4(t.grossPnl ?? 0),
          charges: round4(t.charges),
          slippage: round4(t.slippage),
          net: round4(net),
          netPerUnit: round4(net / t.quantity),
        },
        held: {
          bars: heldBars.length,
          minutes: round4(((exitTime ?? t.entryTime) - t.entryTime) / 60_000),
        },
        excursion: excursionOf(t.side, t.entryPrice, heldBars),
        preceding: {
          regime: regimeAt(day.evaluation.timeline, entryBar),
          patterns,
        },
      });
    }
  }
  return out.sort(
    (a, b) =>
      a.entry.barTs - b.entry.barTs ||
      (a.strategyType < b.strategyType
        ? -1
        : a.strategyType > b.strategyType
          ? 1
          : 0) ||
      (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
  );
}
