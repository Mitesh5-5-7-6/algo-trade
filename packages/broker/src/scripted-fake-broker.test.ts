import { describe, expect, it } from "vitest";
import {
  BrokerOrderStatusSchema,
  ExecutionOutcomeSchema,
  OrderUpdateSchema,
  type BrokerConnectionState,
  type BrokerOrderRequest,
} from "@neelkanth/core";
import { ScriptedFakeBroker } from "./index.js";

const order = (clientOrderId: string): BrokerOrderRequest => ({
  clientOrderId,
  symbol: "NSE:RELIANCE-EQ",
  side: "BUY",
  qty: 10,
  type: "MARKET",
});

describe("ScriptedFakeBroker — execution (plan/19 §2, plan/27 §6)", () => {
  it("auto-fills at the default price and records the submission", async () => {
    const broker = new ScriptedFakeBroker({
      defaultFillPrice: 2990,
      defaultCharges: 12.5,
    });
    const outcome = await broker.execute(order("ord_1"));

    expect(ExecutionOutcomeSchema.safeParse(outcome).success).toBe(true);
    expect(outcome.status).toBe("FILLED");
    if (outcome.status === "FILLED") {
      expect(outcome.fill.filledPrice).toBe(2990);
      expect(outcome.fill.filledQty).toBe(10);
      expect(outcome.fill.charges).toBe(12.5);
      expect(outcome.fill.clientOrderId).toBe("ord_1");
    }
    expect(broker.submitted).toHaveLength(1);
    expect(broker.submitted[0]?.clientOrderId).toBe("ord_1");
  });

  it("refuses to fabricate a fill price when unscripted (plan/11 §9)", async () => {
    const broker = new ScriptedFakeBroker(); // no defaultFillPrice
    await expect(broker.execute(order("ord_x"))).rejects.toThrow(
      /refusing to fabricate/i,
    );
  });

  it("returns a scripted REJECTED outcome verbatim", async () => {
    const broker = new ScriptedFakeBroker({ defaultFillPrice: 100 });
    broker.scriptExecution("ord_2", {
      status: "REJECTED",
      clientOrderId: "ord_2",
      reason: "margin insufficient",
      code: "FY-MARGIN",
    });
    const outcome = await broker.execute(order("ord_2"));
    expect(outcome.status).toBe("REJECTED");
    if (outcome.status === "REJECTED") {
      expect(outcome.reason).toBe("margin insufficient");
    }
  });

  it("models the live async path: PENDING then an ORDER update fills it", async () => {
    const broker = new ScriptedFakeBroker({ pendingByDefault: true });
    const updates: unknown[] = [];
    broker.onOrderUpdate((u) => updates.push(u));

    const outcome = await broker.execute(order("ord_3"));
    expect(outcome.status).toBe("PENDING");

    const before = await broker.status("ord_3");
    expect(before.found).toBe(true);
    expect(before.status).toBe("PENDING");

    broker.emitOrderUpdate({
      status: "FILLED",
      fill: {
        clientOrderId: "ord_3",
        brokerOrderId: "fyers-99",
        filledPrice: 2985.5,
        filledQty: 10,
        slippage: 0.5,
        charges: 14,
        filledAt: Date.now(),
      },
    });

    expect(updates).toHaveLength(1);
    expect(OrderUpdateSchema.safeParse(updates[0]).success).toBe(true);
    const after = await broker.status("ord_3");
    expect(after.status).toBe("FILLED");
  });
});

describe("ScriptedFakeBroker — status & reconciliation (plan/12 §8)", () => {
  it("reports found:false for an order it never saw — the safe-resubmit license", async () => {
    const broker = new ScriptedFakeBroker({ defaultFillPrice: 1 });
    const status = await broker.status("never");
    expect(BrokerOrderStatusSchema.safeParse(status).success).toBe(true);
    expect(status.found).toBe(false);
    expect(status.status).toBeUndefined();
  });

  it("reflects a cancel as CANCELLED", async () => {
    const broker = new ScriptedFakeBroker({ pendingByDefault: true });
    await broker.execute(order("ord_c"));
    await broker.cancel("ord_c");
    expect(broker.cancelled).toContain("ord_c");
    expect((await broker.status("ord_c")).status).toBe("CANCELLED");
  });
});

describe("ScriptedFakeBroker — market data (plan/17)", () => {
  it("tracks subscriptions and drives connection changes", async () => {
    const broker = new ScriptedFakeBroker({ defaultFillPrice: 1 });
    const states: BrokerConnectionState[] = [];
    broker.onConnectionChange((s) => states.push(s));

    await broker.connect();
    await broker.subscribe(["NSE:INFY-EQ", "NSE:TCS-EQ"]);
    expect(broker.connectionState).toBe("connected");
    expect(broker.subscriptions.has("NSE:INFY-EQ")).toBe(true);
    expect(broker.subscriptions.size).toBe(2);

    await broker.disconnect();
    expect(states).toEqual(["connected", "disconnected"]);
  });

  it("delivers raw data messages untranslated to the onData callback", () => {
    const broker = new ScriptedFakeBroker({ defaultFillPrice: 1 });
    const received: unknown[] = [];
    broker.onData((raw) => received.push(raw));
    const rawMessage = { s: "NSE:INFY-EQ", lp: 1500.25, weird_fyers_field: 1 };
    broker.emitData(rawMessage);
    expect(received).toEqual([rawMessage]);
  });
});
