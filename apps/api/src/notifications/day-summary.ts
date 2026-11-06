import type { Db } from "mongodb";
import { istDayStart, type TradeMode } from "@neelkanth/core";
import {
  OrdersRepository,
  PaperReconciliationsRepository,
  RiskLogsRepository,
  TradesRepository,
} from "@neelkanth/db";
import type { DaySummary } from "./daily.js";

/**
 * The day's summary, read from storage (task 16.5): so a mid-session restart
 * does not quietly halve the day. Trades entered on the IST day; closed ones
 * for wins, losses and net P&L; rejected orders; blocked risk decisions; and,
 * in paper, the close reconciliation.
 */
export async function readDaySummary(
  db: Db,
  mode: TradeMode,
  day: string,
): Promise<DaySummary> {
  const from = istDayStart(day);
  const to = from + 86_400_000;
  const dayTrades = await new TradesRepository(db).findRange(from, to);
  const closed = dayTrades.filter((t) => t.status === "CLOSED");
  const runs =
    mode === "paper"
      ? await new PaperReconciliationsRepository(db).forSession(day)
      : [];
  const close = runs.find((run) => run.at === "CLOSE");
  return {
    trades: dayTrades.length,
    closed: closed.length,
    wins: closed.filter((t) => (t.netPnl ?? 0) > 0).length,
    losses: closed.filter((t) => (t.netPnl ?? 0) < 0).length,
    netPnl: closed.reduce((sum, t) => sum + (t.netPnl ?? 0), 0),
    rejections: (
      await new OrdersRepository(db).findAllByDateRange(from, to)
    ).filter((o) => o.status === "REJECTED").length,
    riskBlocks: (await new RiskLogsRepository(db).findRange(from, to)).filter(
      (log) => log.decision === "blocked",
    ).length,
    reconciliation:
      mode !== "paper"
        ? "not applicable"
        : close === undefined
          ? "not run"
          : close.clean
            ? "clean"
            : "mismatch",
  };
}
