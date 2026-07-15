import type { Order, RiskLog, Signal } from "@neelkanth/core";

/**
 * The activity feed read-model (plan/06 §4 Overview): the recent life of the
 * machine — signals raised, orders placed/filled/rejected, entries the Risk
 * Engine blocked — merged into one time-ordered stream. Built by folding the
 * durable records (plan/07) rather than tapping the live bus, so a page load
 * shows history immediately; the socket then keeps it current (plan/06 §5).
 *
 * A pure function over already-fetched records, so it is unit-tested without a
 * database.
 */
export type ActivityKind = "signal" | "order" | "fill" | "risk_block";

export interface ActivityEntry {
  ts: number;
  kind: ActivityKind;
  message: string;
}

/** "NSE:RELIANCE-EQ" → "RELIANCE" — the design shows the bare ticker. */
function ticker(symbol: string): string {
  return symbol.replace("NSE:", "").replace("-EQ", "");
}

function fromSignal(signal: Signal): ActivityEntry | null {
  // HOLD is recorded but never forwarded (plan/18 §6) — not activity.
  if (signal.side === "HOLD") return null;
  return {
    ts: signal.ts,
    kind: "signal",
    message: `SIGNAL ${signal.side} ${ticker(signal.symbol)} — ${signal.reason}`,
  };
}

function fromOrder(order: Order): ActivityEntry {
  const sym = ticker(order.symbol);
  const size = `${order.side} ${String(order.qty)} ${sym}`;
  if (order.status === "FILLED") {
    const at =
      order.filledPrice === undefined
        ? ""
        : ` @ ${order.filledPrice.toFixed(2)}`;
    return {
      ts: order.filledAt ?? order.createdAt,
      kind: "fill",
      message: `ORDER_FILLED ${order.orderId} ${size}${at}`,
    };
  }
  return {
    ts: order.createdAt,
    kind: "order",
    message: `ORDER_${order.status} ${order.orderId} ${size}`,
  };
}

function fromRiskLog(log: RiskLog): ActivityEntry {
  const why = log.reason ?? log.failedCheck ?? "blocked";
  return {
    ts: log.ts,
    kind: "risk_block",
    message: `RISK_BLOCKED ${ticker(log.symbol)} — ${why}`,
  };
}

export function buildActivityFeed(
  signals: readonly Signal[],
  orders: readonly Order[],
  riskLogs: readonly RiskLog[],
  limit: number,
): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const signal of signals) {
    const entry = fromSignal(signal);
    if (entry !== null) entries.push(entry);
  }
  for (const order of orders) entries.push(fromOrder(order));
  for (const log of riskLogs) entries.push(fromRiskLog(log));
  entries.sort((a, b) => b.ts - a.ts);
  return entries.slice(0, limit);
}
