import type { RiskLog, Signal, Trade } from "@neelkanth/core";

/** Bumped when what is compared, or how a difference is judged, changes. */
export const PARITY_VERSION = "1";

/**
 * How far a paper fill may sit from the replay's and still be the same
 * decision (D6). A paper fill lands on a tick after the decision; the replay
 * fills at the bar's close — the timing, not the decision, differs. Exits
 * get more room: a live stop fires on the tick that crosses it, the replay's
 * on the bar that closed beyond it.
 */
export interface ParityTolerance {
  entryPriceBps: number;
  exitPriceBps: number;
  /** How many decision bars apart the two exits may land. */
  exitBars: number;
  /** Charges follow turnover; relative room, in percent. */
  chargesPct: number;
}

export const PARITY_TOLERANCE: ParityTolerance = {
  entryPriceBps: 10,
  exitPriceBps: 50,
  exitBars: 1,
  chargesPct: 1,
};

/** One way the paper session and its replay disagree — never averaged away. */
export interface ParityDifference {
  kind: "SIGNAL" | "RISK" | "TRADE" | "STRATEGY_VERSION" | "REPLAY";
  /** What is being compared, readable: strategy, symbol, side, bar. */
  key: string;
  field: string;
  paper: string;
  replay: string;
}

export interface ParityResult {
  version: string;
  tolerance: ParityTolerance;
  compared: {
    paperSignals: number;
    replaySignals: number;
    paperTrades: number;
    replayTrades: number;
  };
  differences: ParityDifference[];
  clean: boolean;
}

/** The two sides of one session, each already the session's rows only. */
export interface ParityInput {
  paper: { signals: Signal[]; riskLogs: RiskLog[]; trades: Trade[] };
  replay: { signals: Signal[]; riskLogs: RiskLog[]; trades: Trade[] };
  /** The strategy versions the replay ran, by strategy id. */
  replayedVersions: ReadonlyMap<string, string>;
  /**
   * Strategies the replay could not run, and why. Each is a difference in its
   * own right: its paper decisions have nothing to be held against.
   */
  excluded?: ReadonlyArray<{ strategyId: string; reason: string }>;
  /** The decision bar's length, for exit timing. */
  intervalMs: number;
  tolerance?: ParityTolerance;
}

const show = (v: string | number | undefined | null): string =>
  v === undefined || v === null ? "—" : String(v);
const iso = (ts: number | undefined): string =>
  ts === undefined ? "—" : new Date(ts).toISOString();

/**
 * Hold a paper session against the replay of its own bars, decision by
 * decision (D6): the same signals on the same bars, the same risk verdicts,
 * the same Trades entered on the same bars and ended for the same reasons;
 * prices and P&L apart only within the declared tolerance.
 *
 * Signals are matched on (strategy, symbol, side, decision bar). An Exit
 * Engine decision has no decision bar and is compared through its Trade.
 */
export function compareWithReplay(input: ParityInput): ParityResult {
  const tolerance = input.tolerance ?? PARITY_TOLERANCE;
  const differences: ParityDifference[] = (input.excluded ?? []).map((e) => ({
    kind: "REPLAY" as const,
    key: e.strategyId,
    field: "replayable",
    paper: "traded",
    replay: e.reason,
  }));

  // --- Strategy versions: a mid-session edit makes every later match moot.
  for (const s of input.paper.signals) {
    const replayed = input.replayedVersions.get(s.strategyId);
    if (replayed === undefined) continue;
    if (s.strategyVersion !== undefined && s.strategyVersion !== replayed) {
      const key = s.strategyId;
      if (
        !differences.some((d) => d.kind === "STRATEGY_VERSION" && d.key === key)
      )
        differences.push({
          kind: "STRATEGY_VERSION",
          key,
          field: "strategyVersion",
          paper: s.strategyVersion,
          replay: replayed,
        });
    }
  }

  // --- Signals, and the risk verdict on each.
  const decided = (signals: Signal[]) =>
    new Map(
      signals
        .filter((s) => s.side !== "HOLD" && s.dataProvenance !== undefined)
        .map((s) => [signalKey(s), s]),
    );
  const paperSignals = decided(input.paper.signals);
  const replaySignals = decided(input.replay.signals);
  const paperRisk = new Map(input.paper.riskLogs.map((l) => [l.signalId, l]));
  const replayRisk = new Map(input.replay.riskLogs.map((l) => [l.signalId, l]));

  for (const key of sortedUnion(paperSignals, replaySignals)) {
    const p = paperSignals.get(key);
    const r = replaySignals.get(key);
    if (p === undefined || r === undefined) {
      differences.push({
        kind: "SIGNAL",
        key,
        field: "presence",
        paper: p === undefined ? "absent" : p.reason,
        replay: r === undefined ? "absent" : r.reason,
      });
      continue;
    }
    if ((p.exitReason ?? null) !== (r.exitReason ?? null))
      differences.push({
        kind: "SIGNAL",
        key,
        field: "exitReason",
        paper: show(p.exitReason),
        replay: show(r.exitReason),
      });
    const pr = paperRisk.get(p.signalId);
    const rr = replayRisk.get(r.signalId);
    const verdict = (l: RiskLog | undefined) =>
      l === undefined
        ? "no decision recorded"
        : `${l.decision}${l.failedCheck === undefined ? "" : ` (${l.failedCheck})`}`;
    if (verdict(pr) !== verdict(rr))
      differences.push({
        kind: "RISK",
        key,
        field: "decision",
        paper: verdict(pr),
        replay: verdict(rr),
      });
  }

  // --- Trades: entered on the same bar, ended the same way.
  const byEntry = (trades: Trade[]) =>
    new Map(trades.map((t) => [tradeKey(t, input.intervalMs), t]));
  const paperTrades = byEntry(input.paper.trades);
  const replayTrades = byEntry(input.replay.trades);
  for (const key of sortedUnion(paperTrades, replayTrades)) {
    const p = paperTrades.get(key);
    const r = replayTrades.get(key);
    if (p === undefined || r === undefined) {
      differences.push({
        kind: "TRADE",
        key,
        field: "presence",
        paper: p === undefined ? "absent" : describeTrade(p),
        replay: r === undefined ? "absent" : describeTrade(r),
      });
      continue;
    }
    differences.push(...compareTrades(key, p, r, input.intervalMs, tolerance));
  }

  return {
    version: PARITY_VERSION,
    tolerance,
    compared: {
      paperSignals: paperSignals.size,
      replaySignals: replaySignals.size,
      paperTrades: paperTrades.size,
      replayTrades: replayTrades.size,
    },
    differences,
    clean: differences.length === 0,
  };
}

function compareTrades(
  key: string,
  p: Trade,
  r: Trade,
  intervalMs: number,
  tolerance: ParityTolerance,
): ParityDifference[] {
  const out: ParityDifference[] = [];
  const diff = (
    field: string,
    paper: string | number | undefined,
    replay: string | number | undefined,
  ) =>
    out.push({
      kind: "TRADE",
      key,
      field,
      paper: show(paper),
      replay: show(replay),
    });

  if (p.quantity !== r.quantity) diff("quantity", p.quantity, r.quantity);
  if (p.status !== r.status) diff("status", p.status, r.status);
  if ((p.exitReason ?? null) !== (r.exitReason ?? null))
    diff("exitReason", p.exitReason, r.exitReason);

  const entryRoom = (r.entryPrice * tolerance.entryPriceBps) / 1e4;
  if (Math.abs(p.entryPrice - r.entryPrice) > entryRoom)
    diff("entryPrice", p.entryPrice, r.entryPrice);

  // Exit fields only mean something when both closed.
  if (p.status !== "CLOSED" || r.status !== "CLOSED") return out;
  const exitRoom = ((r.exitPrice ?? 0) * tolerance.exitPriceBps) / 1e4;
  if (Math.abs((p.exitPrice ?? 0) - (r.exitPrice ?? 0)) > exitRoom)
    diff("exitPrice", p.exitPrice, r.exitPrice);
  if (
    Math.abs((p.exitTime ?? 0) - (r.exitTime ?? 0)) >
    tolerance.exitBars * intervalMs
  )
    diff("exitTime", iso(p.exitTime), iso(r.exitTime));

  // Gross P&L may differ by what the two prices may: both legs' room, per unit.
  const pnlRoom = r.quantity * (entryRoom + exitRoom);
  if (Math.abs((p.grossPnl ?? 0) - (r.grossPnl ?? 0)) > pnlRoom)
    diff("grossPnl", p.grossPnl, r.grossPnl);
  const chargesRoom =
    (Math.max(p.charges, r.charges) * tolerance.chargesPct) / 100;
  if (Math.abs(p.charges - r.charges) > chargesRoom)
    diff("charges", p.charges, r.charges);
  return out;
}

function signalKey(s: Signal): string {
  return `${s.strategyId} ${s.symbol} ${s.side} @${iso(s.dataProvenance?.barTs)}`;
}

/**
 * A Trade is known by its entry bar. One without provenance is placed in the
 * bar its entry fill landed in, so it can still be matched rather than lost.
 */
function tradeKey(t: Trade, intervalMs: number): string {
  const bar =
    t.dataProvenance?.barTs ??
    Math.floor(t.entryTime / intervalMs) * intervalMs;
  return `${t.strategyId} ${t.symbol} ${t.side} entry@${iso(bar)}`;
}

function describeTrade(t: Trade): string {
  return `${t.side} ${String(t.quantity)} @ ${String(t.entryPrice)} → ${show(t.exitPrice)} (${show(t.exitReason)}), net ${show(t.netPnl)}`;
}

function sortedUnion<K extends string>(
  a: ReadonlyMap<K, unknown>,
  b: ReadonlyMap<K, unknown>,
): K[] {
  return [...new Set([...a.keys(), ...b.keys()])].sort();
}
