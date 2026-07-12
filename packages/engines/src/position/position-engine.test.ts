import { describe, expect, it } from "vitest";
import type { Position } from "@neelkanth/core";
import type { EventName, EventPayload } from "@neelkanth/contracts";
import { PositionEngine } from "./position-engine.js";
import type { PositionPorts } from "./ports.js";

function harness() {
  const written: Position[] = [];
  const events: { name: EventName; payload: unknown }[] = [];
  const errors: unknown[] = [];
  const ports: PositionPorts = {
    writePosition: (position) => {
      written.push(position);
      return Promise.resolve();
    },
    publish: (name, payload) => {
      events.push({ name, payload });
      return Promise.resolve();
    },
  };
  let idSeq = 0;
  const engine = new PositionEngine({
    ports,
    nextPositionId: () => {
      idSeq += 1;
      return `pos_${String(idSeq)}`;
    },
    now: () => 5000,
    onError: (error) => errors.push(error),
  });
  return { engine, written, events, errors };
}

function filled(
  overrides: Partial<EventPayload<"ORDER_FILLED">> = {},
): EventPayload<"ORDER_FILLED"> {
  return {
    orderId: "o1",
    strategyId: "str_1",
    symbol: "NSE:X-EQ",
    side: "BUY",
    qty: 10,
    filledPrice: 100,
    slippage: 0,
    charges: 5,
    filledAt: 1000,
    mode: "paper",
    ts: 1000,
    ...overrides,
  };
}

describe("PositionEngine fills (plan/13 §3)", () => {
  it("opens a position, writes it, and emits POSITION_UPDATED", async () => {
    const h = harness();
    await h.engine.onOrderFilled(filled());
    const position = h.engine.getPosition("str_1", "NSE:X-EQ");
    expect(position?.side).toBe("LONG");
    expect(position?.qty).toBe(10);
    expect(position?.realizedPnl).toBe(-5); // entry charges
    expect(h.events[0]?.name).toBe("POSITION_UPDATED");
    expect(h.engine.realizedPnl()).toBe(-5);
  });

  it("is idempotent — a re-delivered fill is ignored (plan/13 §3)", async () => {
    const h = harness();
    await h.engine.onOrderFilled(filled({ orderId: "dup" }));
    await h.engine.onOrderFilled(filled({ orderId: "dup" })); // same orderId
    expect(h.written).toHaveLength(1);
    expect(h.engine.getPosition("str_1", "NSE:X-EQ")?.qty).toBe(10);
  });

  it("tracks realized PnL across a reduce and a close", async () => {
    const h = harness();
    await h.engine.onOrderFilled(filled({ orderId: "o1", charges: 0 })); // open 10 @100
    await h.engine.onOrderFilled(
      filled({
        orderId: "o2",
        side: "SELL",
        qty: 10,
        filledPrice: 120,
        charges: 0,
      }),
    ); // close @120
    const position = h.engine.getPosition("str_1", "NSE:X-EQ");
    expect(position).toBeNull(); // closed
    expect(h.engine.realizedPnl()).toBe(200); // (120−100)·10
    expect(h.engine.realizedPnlForStrategy("str_1")).toBe(200);
  });

  it("sets closedAt when a position closes", async () => {
    const h = harness();
    await h.engine.onOrderFilled(filled({ orderId: "o1", charges: 0 }));
    await h.engine.onOrderFilled(
      filled({ orderId: "o2", side: "SELL", qty: 10, charges: 0 }),
    );
    const closed = h.written[h.written.length - 1];
    expect(closed?.status).toBe("CLOSED");
    expect(closed?.closedAt).toBe(5000);
  });

  it("handles a reversal by closing then opening the remainder as a new position", async () => {
    const h = harness();
    await h.engine.onOrderFilled(
      filled({ orderId: "o1", qty: 10, charges: 0 }),
    ); // long 10
    await h.engine.onOrderFilled(
      filled({
        orderId: "o2",
        side: "SELL",
        qty: 15,
        filledPrice: 110,
        charges: 0,
      }),
    ); // sell 15 → close long, open short 5
    const updates = h.events.filter((e) => e.name === "POSITION_UPDATED");
    expect(updates).toHaveLength(3); // open, close, new-short-open
    const current = h.engine.getPosition("str_1", "NSE:X-EQ");
    expect(current?.side).toBe("SHORT");
    expect(current?.qty).toBe(5);
    expect(h.engine.realizedPnl()).toBe(100); // (110−100)·10 from the close
  });
});

describe("PositionEngine lifecycle helpers (plan/13 §5, §8)", () => {
  it("resetDaily zeroes the realized counters", async () => {
    const h = harness();
    await h.engine.onOrderFilled(
      filled({
        orderId: "o1",
        side: "SELL",
        qty: 10,
        filledPrice: 100,
        charges: 5,
      }),
    );
    h.engine.resetDaily();
    expect(h.engine.realizedPnl()).toBe(0);
    expect(h.engine.getTradeCount()).toBe(0);
  });

  it("hydrate rebuilds open-position state on boot", () => {
    const h = harness();
    const open: Position = {
      positionId: "pos_x",
      symbol: "NSE:Y-EQ",
      strategyId: "str_2",
      side: "LONG",
      qty: 20,
      avgEntryPrice: 50,
      status: "OPEN",
      realizedPnl: 0,
      unrealizedPnl: 0,
      openedAt: 1,
      mode: "paper",
    };
    h.engine.hydrate([open]);
    expect(h.engine.getPosition("str_2", "NSE:Y-EQ")?.qty).toBe(20);
  });
});
