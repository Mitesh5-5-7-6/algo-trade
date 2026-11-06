import { describe, expect, it } from "vitest";
import type { EventName, EventPayload } from "@neelkanth/contracts";
import type { Notification, Notifier } from "./notifier.js";
import { subscribeCatalogue, type CatalogueBus } from "./catalogue.js";

/** Task 16.4 — the event catalogue (design §5.2). */

type Handler = (event: { name: EventName; payload: unknown }) => void;

async function harness(
  opts: { includeInfo?: boolean; marketOpen?: boolean; limit?: number } = {},
) {
  const handlers = new Map<EventName, Handler[]>();
  const bus: CatalogueBus = {
    subscribe(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler as Handler);
      handlers.set(name, list);
      return Promise.resolve();
    },
  };
  const sent: Notification[] = [];
  const notifier: Notifier = {
    enabled: true,
    notify: (n) => sent.push(n),
  };
  const timers: (() => void)[] = [];
  let marketOpen = opts.marketOpen ?? true;
  await subscribeCatalogue({
    bus,
    notifier,
    mode: "paper",
    includeInfo: opts.includeInfo ?? true,
    dailyLossLimit: () => opts.limit ?? 1_000,
    marketOpen: () => marketOpen,
    schedule: (fn) => timers.push(fn),
  });
  return {
    sent,
    emit<N extends EventName>(name: N, payload: EventPayload<N>) {
      for (const h of handlers.get(name) ?? []) h({ name, payload });
    },
    /** Close every open coalescing window. */
    flush() {
      for (const fn of timers.splice(0)) fn();
    },
    setMarketOpen(open: boolean) {
      marketOpen = open;
    },
  };
}

const TS = 1_700_000_000_000;
const brief = (n: Notification) => `${n.severity} ${n.title}`;

describe("the catalogue: CRITICAL, at once (task 16.4)", () => {
  it("tells of a halt, naming who stopped trading", async () => {
    const h = await harness();
    h.emit("TRADING_HALTED", {
      source: "reconciliation",
      reason: "paper broker reconciliation mismatch at BOOT",
      mode: "paper",
      ts: TS,
    });
    expect(h.sent).toEqual([
      {
        severity: "CRITICAL",
        mode: "paper",
        title: "Trading halted (reconciliation)",
        body: "paper broker reconciliation mismatch at BOOT",
        chat: "operations",
      },
    ]);
  });

  /** D5: SYSTEM_ERROR's context can carry identifiers — only the message goes out. */
  it("tells of a system error by its message, never its context", async () => {
    const h = await harness();
    h.emit("SYSTEM_ERROR", {
      source: "orderManager.reconcile",
      level: "error",
      message: "broker reports FILLED but returned no fill price",
      context: { orderId: "ord_secret_ish", brokerOrderId: "B123" },
      ts: TS,
    });
    expect(h.sent).toHaveLength(1);
    expect(JSON.stringify(h.sent[0])).not.toContain("B123");
    expect(h.sent[0]?.severity).toBe("CRITICAL");
  });

  it("makes a disconnect or a lost token CRITICAL in session, WARNING outside it", async () => {
    const h = await harness({ marketOpen: true });
    h.emit("BROKER_DISCONNECTED", {
      broker: "fyers",
      mode: "paper",
      reason: "closed",
      ts: TS,
    });
    h.emit("BROKER_TOKEN_MISSING", {
      broker: "fyers",
      mode: "paper",
      reason: "expired",
      ts: TS,
    });
    h.setMarketOpen(false);
    h.emit("BROKER_DISCONNECTED", {
      broker: "fyers",
      mode: "paper",
      reason: "closed",
      ts: TS,
    });
    expect(h.sent.map(brief)).toEqual([
      "CRITICAL Broker fyers disconnected",
      "CRITICAL Broker fyers token expired",
      "WARNING Broker fyers disconnected",
    ]);
  });
});

describe("the catalogue: daily loss (task 16.4)", () => {
  const pnl = (realizedPnl: number): EventPayload<"PNL_UPDATED"> => ({
    scope: "global",
    realizedPnl,
    unrealizedPnl: 0,
    ts: TS,
  });

  it("warns at 50 % and 80 %, and goes CRITICAL at the limit — each once a day", async () => {
    const h = await harness({ limit: 1_000 });
    for (const p of [-100, -500, -600, -800, -900, -1_000, -1_200]) {
      h.emit("PNL_UPDATED", pnl(p));
    }
    expect(h.sent.map(brief)).toEqual([
      "WARNING Daily loss at 50% of the limit",
      "WARNING Daily loss at 80% of the limit",
      "CRITICAL Daily loss limit reached",
    ]);

    // A new day starts the ladder again.
    h.emit("MARKET_OPEN", { exchange: "NSE", session: "regular", ts: TS });
    h.emit("PNL_UPDATED", pnl(-1_000));
    expect(h.sent.map(brief).slice(3)).toEqual([
      "INFO Market open",
      "CRITICAL Daily loss limit reached",
    ]);
  });

  it("ignores per-strategy scopes and a profit", async () => {
    const h = await harness({ limit: 1_000 });
    h.emit("PNL_UPDATED", { ...pnl(-2_000), scope: "strategy:str_1" });
    h.emit("PNL_UPDATED", pnl(500));
    expect(h.sent).toEqual([]);
  });
});

describe("the catalogue: coalesced warnings (task 16.4)", () => {
  const rejected = (symbol: string): EventPayload<"ORDER_REJECTED"> => ({
    orderId: "ord_1",
    signalId: "sig_1",
    strategyId: "str_1",
    symbol,
    side: "BUY",
    qty: 65,
    reason: "Insufficient margin",
    mode: "paper",
    ts: TS,
  });

  it("gathers a window's rejections into one message", async () => {
    const h = await harness();
    for (const s of ["A", "B", "C", "D", "E", "F", "G"]) {
      h.emit("ORDER_REJECTED", rejected(`NSE:${s}-EQ`));
    }
    expect(h.sent).toEqual([]); // nothing until the window closes
    h.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.title).toBe("7 orders rejected by the broker");
    expect(h.sent[0]?.body).toContain("BUY 65 NSE:A-EQ: Insufficient margin");
    expect(h.sent[0]?.body).toContain("…and 2 more");

    // The next rejection opens a fresh window.
    h.emit("ORDER_REJECTED", rejected("NSE:H-EQ"));
    h.flush();
    expect(h.sent[1]?.title).toBe("Order rejected by the broker");
  });

  it("stays quiet about routine risk blocks, and speaks up on a burst", async () => {
    const block = (failedCheck: "marketBias" | "dailyLoss") => ({
      signalId: "sig",
      strategyId: "str",
      symbol: "NSE:X-EQ",
      failedCheck,
      reason: "r",
      ts: TS,
    });
    const h = await harness();
    h.emit("RISK_BLOCKED", block("marketBias"));
    h.emit("RISK_BLOCKED", block("marketBias"));
    h.flush();
    expect(h.sent).toEqual([]); // two in a window is routine

    for (let i = 0; i < 4; i += 1) h.emit("RISK_BLOCKED", block("marketBias"));
    h.emit("RISK_BLOCKED", block("dailyLoss"));
    h.flush();
    expect(h.sent).toEqual([
      expect.objectContaining({
        severity: "WARNING",
        title: "5 signals blocked by risk in 60 s",
        body: "marketBias × 4, dailyLoss × 1",
      }),
    ]);
  });
});

describe("the catalogue: INFO (task 16.4)", () => {
  const fill = (
    extra: Partial<EventPayload<"ORDER_FILLED">> = {},
  ): EventPayload<"ORDER_FILLED"> => ({
    orderId: "ord_1",
    strategyId: "str_orb",
    symbol: "NSE:NIFTY-INDEX",
    side: "BUY",
    qty: 1,
    filledPrice: 24_000,
    slippage: 0,
    charges: 0,
    filledAt: TS,
    mode: "paper",
    ts: TS,
    ...extra,
  });

  it("tells of an entry, and of a close with its reason and P&L", async () => {
    const h = await harness();
    h.emit("ORDER_FILLED", fill());
    h.emit("ORDER_FILLED", fill({ side: "SELL", exitReason: "STOP_LOSS" }));
    h.emit("POSITION_UPDATED", {
      symbol: "NSE:NIFTY-INDEX",
      strategyId: "str_orb",
      side: "LONG",
      qty: 0,
      avgEntryPrice: 24_000,
      status: "CLOSED",
      realizedPnl: -45.5,
      ts: TS,
    });
    expect(h.sent.map((n) => [n.severity, n.title, n.body])).toEqual([
      [
        "INFO",
        "Entry filled: BUY 1 NSE:NIFTY-INDEX @ 24000",
        "Strategy str_orb",
      ],
      [
        "INFO",
        "Position closed: NSE:NIFTY-INDEX -₹45.5",
        "Strategy str_orb — STOP_LOSS",
      ],
    ]);
  });

  it("sends no INFO when INFO is off, and still sends the rest", async () => {
    const h = await harness({ includeInfo: false });
    h.emit("ORDER_FILLED", fill());
    h.emit("MARKET_OPEN", { exchange: "NSE", session: "regular", ts: TS });
    h.emit("TRADING_RESUMED", { source: "operator", mode: "paper", ts: TS });
    expect(h.sent.map(brief)).toEqual([
      "WARNING Trading resumed by the operator",
    ]);
  });

  /** Design §5.1 D8: trades — entry fills and closes — and operations, the rest. */
  it("puts fills and closes in the trades chat, and nothing else (16.8)", async () => {
    const h = await harness();
    h.emit("MARKET_OPEN", { exchange: "NSE", session: "regular", ts: TS });
    h.emit("ORDER_FILLED", fill());
    h.emit("ORDER_FILLED", fill({ side: "SELL", exitReason: "TAKE_PROFIT" }));
    h.emit("POSITION_UPDATED", {
      symbol: "NSE:NIFTY-INDEX",
      strategyId: "str_orb",
      side: "LONG",
      qty: 0,
      avgEntryPrice: 24_000,
      status: "CLOSED",
      realizedPnl: 120,
      ts: TS,
    });
    h.emit("BROKER_CONNECTED", { broker: "fyers", mode: "paper", ts: TS });
    h.emit("FEED_RECOVERED", { broker: "fyers", mode: "paper", ts: TS });
    h.emit("TRADING_HALTED", {
      source: "kill",
      reason: "operator",
      mode: "paper",
      ts: TS,
    });
    expect(h.sent.map((n) => [n.title.split(":")[0], n.chat])).toEqual([
      ["Market open", "operations"],
      ["Entry filled", "trades"],
      ["Position closed", "trades"],
      ["Broker fyers connected", "operations"],
      ["Market feed recovered", "operations"],
      ["Trading halted (kill)", "operations"],
    ]);
  });
});
