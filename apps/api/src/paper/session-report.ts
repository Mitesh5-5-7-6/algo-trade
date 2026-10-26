import type { Order, RiskEvent, RiskLog, Signal, Trade } from "@neelkanth/core";
import type { PaperReconciliationDoc } from "@neelkanth/db";

/**
 * What one paper session did, from the paper database (Phase 14 D6): every
 * signal and the risk decision on it, every order and its fill — slippage
 * measured against the price the decision saw — every Trade and why it ended,
 * the day's P&L, the reconciliation runs, and any restart.
 *
 * A pure function of the rows it is handed; reading them is the store's job.
 */
export interface SessionRows {
  /** The IST trading date, "YYYY-MM-DD". */
  session: string;
  /** The bell — a process start after it, following another, is a restart. */
  sessionOpenTs: number;
  /** BUY/SELL signals of the session; HOLD is a pulse, not a decision. */
  signals: Signal[];
  riskLogs: RiskLog[];
  orders: Order[];
  /** Trades entered in the session. */
  trades: Trade[];
  reconciliations: PaperReconciliationDoc[];
  riskEvents: RiskEvent[];
}

export interface SignalLine {
  signalId: string;
  strategyId: string;
  strategyVersion: string | null;
  symbol: string;
  side: string;
  ts: number;
  /** The bar the decision was made on; null for an Exit Engine decision. */
  barTs: number | null;
  decisionPrice: number;
  reason: string;
  exitReason: string | null;
  /** Null when no risk decision was recorded for it — itself a finding. */
  risk: { decision: string; failedCheck: string | null } | null;
}

export interface OrderLine {
  orderId: string;
  signalId: string;
  strategyId: string;
  symbol: string;
  side: string;
  qty: number;
  type: string;
  status: string;
  exitReason: string | null;
  /** What the deciding signal saw; null when that signal is not on record. */
  decisionPrice: number | null;
  filledPrice: number | null;
  filledAt: number | null;
  /**
   * Per unit, against the decision price, positive when adverse: paid more on
   * a BUY, received less on a SELL. Null until filled, or without a decision
   * price. Not the book's `slippage`, which is against the price at the fill.
   */
  slippageVsDecision: number | null;
  charges: number | null;
  rejectReason: string | null;
}

export interface TradeLine {
  tradeId: string;
  strategyId: string;
  symbol: string;
  side: string;
  status: string;
  quantity: number;
  entryTime: number;
  entryBarTs: number | null;
  entryPrice: number;
  exitTime: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  grossPnl: number | null;
  charges: number;
  netPnl: number | null;
}

export interface SessionRecord {
  session: string;
  signals: SignalLine[];
  orders: OrderLine[];
  trades: TradeLine[];
  pnl: {
    closedTrades: number;
    /** Trades still open in the record — the day must end flat. */
    openTrades: number;
    gross: number;
    charges: number;
    net: number;
  };
  reconciliation: {
    runs: PaperReconciliationDoc[];
    /** Every run clean, and the session closed with a CLOSE run. */
    clean: boolean;
    /** What the session lacks — "CLOSE" when it was never reconciled at the bell. */
    missing: string[];
    riskEventIds: string[];
  };
  /** Process starts after the bell that followed an earlier start (D7). */
  restarts: number[];
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Assemble a session's record from its rows. */
export function buildSessionRecord(rows: SessionRows): SessionRecord {
  const riskBySignal = new Map(rows.riskLogs.map((l) => [l.signalId, l]));
  const signalById = new Map(rows.signals.map((s) => [s.signalId, s]));

  const signals: SignalLine[] = rows.signals.map((s) => {
    const risk = riskBySignal.get(s.signalId);
    return {
      signalId: s.signalId,
      strategyId: s.strategyId,
      strategyVersion: s.strategyVersion ?? null,
      symbol: s.symbol,
      side: s.side,
      ts: s.ts,
      barTs: s.dataProvenance?.barTs ?? null,
      decisionPrice: s.contextSnapshot.price,
      reason: s.reason,
      exitReason: s.exitReason ?? null,
      risk:
        risk === undefined
          ? null
          : { decision: risk.decision, failedCheck: risk.failedCheck ?? null },
    };
  });

  const orders: OrderLine[] = rows.orders.map((o) => {
    const decisionPrice =
      signalById.get(o.signalId)?.contextSnapshot.price ?? null;
    const filled = o.status === "FILLED" && o.filledPrice !== undefined;
    return {
      orderId: o.orderId,
      signalId: o.signalId,
      strategyId: o.strategyId,
      symbol: o.symbol,
      side: o.side,
      qty: o.qty,
      type: o.type,
      status: o.status,
      exitReason: o.exitReason ?? null,
      decisionPrice,
      filledPrice: o.filledPrice ?? null,
      filledAt: o.filledAt ?? null,
      slippageVsDecision:
        filled && decisionPrice !== null && o.filledPrice !== undefined
          ? round4(
              o.side === "BUY"
                ? o.filledPrice - decisionPrice
                : decisionPrice - o.filledPrice,
            )
          : null,
      charges: o.charges ?? null,
      rejectReason: o.rejectReason ?? null,
    };
  });

  const trades: TradeLine[] = rows.trades.map((t) => ({
    tradeId: t.tradeId,
    strategyId: t.strategyId,
    symbol: t.symbol,
    side: t.side,
    status: t.status,
    quantity: t.quantity,
    entryTime: t.entryTime,
    entryBarTs: t.dataProvenance?.barTs ?? null,
    entryPrice: t.entryPrice,
    exitTime: t.exitTime ?? null,
    exitPrice: t.exitPrice ?? null,
    exitReason: t.exitReason ?? null,
    grossPnl: t.grossPnl ?? null,
    charges: t.charges,
    netPnl: t.netPnl ?? null,
  }));

  const closed = rows.trades.filter((t) => t.status === "CLOSED");
  const pnl = {
    closedTrades: closed.length,
    openTrades: rows.trades.length - closed.length,
    gross: round4(closed.reduce((sum, t) => sum + (t.grossPnl ?? 0), 0)),
    charges: round4(closed.reduce((sum, t) => sum + t.charges, 0)),
    net: round4(closed.reduce((sum, t) => sum + (t.netPnl ?? 0), 0)),
  };

  const runs = [...rows.reconciliations].sort((a, b) => a.ts - b.ts);
  // A BOOT run is not owed: a process left running from the day before had
  // no boot in this session. The CLOSE run is — the session is not settled
  // until the book has been held against the trading state at the bell.
  const missing = runs.some((r) => r.at === "CLOSE") ? [] : ["CLOSE"];
  const boots = runs.filter((r) => r.at === "BOOT");
  const restarts = boots
    .filter((r, i) => i > 0 && r.ts >= rows.sessionOpenTs)
    .map((r) => r.ts);

  return {
    session: rows.session,
    signals,
    orders,
    trades,
    pnl,
    reconciliation: {
      runs,
      clean:
        missing.length === 0 &&
        runs.every((r) => r.clean) &&
        rows.riskEvents.length === 0,
      missing,
      riskEventIds: rows.riskEvents.map((e) => e.riskEventId),
    },
    restarts,
  };
}
