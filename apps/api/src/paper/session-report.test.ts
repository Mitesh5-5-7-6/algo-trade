import { describe, expect, it } from "vitest";
import type { Order, Signal } from "@neelkanth/core";
import type { PaperReconciliationDoc } from "@neelkanth/db";
import { runHistoricalReplay } from "../replay/run.js";
import {
  emaStrategy,
  goldenBudget,
  historicalBars,
} from "../replay/test-support.js";
import { buildSessionRecord, type SessionRows } from "./session-report.js";

/**
 * Task 14.5 (design D6): what a paper session did, read back from its rows —
 * slippage against the price the decision saw, the day's P&L, the
 * reconciliation runs, and a restart told apart from a late start.
 */
const OPEN = Date.UTC(2026, 0, 5, 3, 45); // 09:15 IST

async function rows(over: Partial<SessionRows> = {}): Promise<SessionRows> {
  const { trail } = await runHistoricalReplay({
    strategy: emaStrategy(),
    candles: await historicalBars([0]),
    hours: { open: "09:15", close: "15:30", squareOff: "15:12" },
    ...goldenBudget(),
    seed: 0,
  });
  return {
    session: "2026-01-05",
    sessionOpenTs: OPEN,
    signals: trail.signals.filter((s) => s.side !== "HOLD"),
    riskLogs: trail.riskLogs,
    orders: [],
    trades: trail.trades,
    reconciliations: [run("BOOT", OPEN - 600_000), run("CLOSE", OPEN + 1e7)],
    riskEvents: [],
    ...over,
  };
}

function run(
  at: "BOOT" | "CLOSE",
  ts: number,
  clean = true,
): PaperReconciliationDoc {
  return {
    runId: `recon_${at}_${String(ts)}`,
    session: "2026-01-05",
    at,
    ts,
    clean,
    mismatches: clean ? 0 : 1,
  };
}

function filledOrder(signal: Signal, filledPrice: number): Order {
  return {
    orderId: `ord_${signal.signalId}`,
    signalId: signal.signalId,
    strategyId: signal.strategyId,
    symbol: signal.symbol,
    side: signal.side === "SELL" ? "SELL" : "BUY",
    qty: 1,
    type: "MARKET",
    status: "FILLED",
    mode: "paper",
    filledPrice,
    filledAt: signal.ts + 1_000,
    charges: 20,
    createdAt: signal.ts,
  };
}

describe("the paper session record (§14.5, D6)", () => {
  it("measures slippage against the decision price, adverse positive, either side", async () => {
    const base = await rows();
    const buy = base.signals.find((s) => s.side === "BUY");
    const sell = base.signals.find((s) => s.side === "SELL");
    if (buy === undefined || sell === undefined)
      throw new Error("the golden day needs a BUY and a SELL");
    const record = buildSessionRecord({
      ...base,
      orders: [
        filledOrder(buy, buy.contextSnapshot.price + 0.5),
        filledOrder(sell, sell.contextSnapshot.price - 0.25),
        { ...filledOrder(buy, 100), orderId: "ord_orphan", signalId: "gone" },
      ],
    });

    expect(record.orders.map((o) => o.slippageVsDecision)).toEqual([
      0.5,
      0.25,
      null,
    ]);
    expect(record.orders[0]?.decisionPrice).toBe(buy.contextSnapshot.price);
  });

  it("carries every signal with the risk decision on it, and the day's P&L", async () => {
    const base = await rows();
    const record = buildSessionRecord(base);

    expect(record.signals).toHaveLength(base.signals.length);
    expect(record.signals.every((s) => s.risk !== null)).toBe(true);
    const closed = base.trades.filter((t) => t.status === "CLOSED");
    expect(record.pnl.closedTrades).toBe(closed.length);
    expect(record.pnl.net).toBeCloseTo(
      closed.reduce((sum, t) => sum + (t.netPnl ?? 0), 0),
      4,
    );
    expect(record.pnl.openTrades).toBe(0);
  });

  it("is reconciled only with a CLOSE run, every run clean, and no risk event", async () => {
    expect(buildSessionRecord(await rows()).reconciliation.clean).toBe(true);

    const noClose = buildSessionRecord(
      await rows({ reconciliations: [run("BOOT", OPEN - 600_000)] }),
    );
    expect(noClose.reconciliation).toMatchObject({
      clean: false,
      missing: ["CLOSE"],
    });

    const dirty = buildSessionRecord(
      await rows({
        reconciliations: [run("BOOT", OPEN, false), run("CLOSE", OPEN + 1e7)],
      }),
    );
    expect(dirty.reconciliation.clean).toBe(false);

    // A process left running overnight has no BOOT today, and owes none.
    const overnight = buildSessionRecord(
      await rows({ reconciliations: [run("CLOSE", OPEN + 1e7)] }),
    );
    expect(overnight.reconciliation.clean).toBe(true);
  });

  it("counts a start after the bell as a restart only when another came first", async () => {
    const late = buildSessionRecord(
      await rows({ reconciliations: [run("BOOT", OPEN + 60_000)] }),
    );
    expect(late.restarts).toEqual([]);

    const drilled = buildSessionRecord(
      await rows({
        reconciliations: [
          run("BOOT", OPEN - 600_000),
          run("BOOT", OPEN + 3_600_000),
          run("CLOSE", OPEN + 1e7),
        ],
      }),
    );
    expect(drilled.restarts).toEqual([OPEN + 3_600_000]);
  });
});
