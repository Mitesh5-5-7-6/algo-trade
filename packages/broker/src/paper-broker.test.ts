import { describe, expect, it } from "vitest";
import {
  ExecutionOutcomeSchema,
  type BrokerOrderRequest,
} from "@neelkanth/core";
import { PaperBroker, type PaperBrokerDeps } from "./paper-broker.js";

function broker(overrides: Partial<PaperBrokerDeps> = {}): PaperBroker {
  return new PaperBroker({
    readPrice: () => Promise.resolve(100),
    readSessionOpen: () => Promise.resolve(true),
    now: () => 1_700_000_000_000,
    ...overrides,
  });
}

const order = (
  overrides: Partial<BrokerOrderRequest> = {},
): BrokerOrderRequest => ({
  clientOrderId: "ord_1",
  symbol: "NSE:RELIANCE-EQ",
  side: "BUY",
  qty: 10,
  type: "MARKET",
  ...overrides,
});

describe("PaperBroker execution (plan/11 §4)", () => {
  it("fills a MARKET buy at the adversely-slipped price with charges", async () => {
    const outcome = await broker({
      slippage: { kind: "percent", pct: 0.001 },
    }).execute(order());
    expect(ExecutionOutcomeSchema.safeParse(outcome).success).toBe(true);
    expect(outcome.status).toBe("FILLED");
    if (outcome.status === "FILLED") {
      expect(outcome.fill.filledPrice).toBeCloseTo(100.1, 6); // buy slips up
      expect(outcome.fill.slippage).toBeCloseTo(0.1, 6);
      expect(outcome.fill.charges).toBeGreaterThan(0);
      expect(outcome.fill.clientOrderId).toBe("ord_1");
    }
  });

  it("slips a SELL down and honors a 'none' slippage model", async () => {
    const sell = await broker({
      slippage: { kind: "percent", pct: 0.001 },
    }).execute(order({ side: "SELL" }));
    if (sell.status === "FILLED")
      expect(sell.fill.filledPrice).toBeCloseTo(99.9, 6);

    const exact = await broker({ slippage: { kind: "none" } }).execute(order());
    if (exact.status === "FILLED") expect(exact.fill.filledPrice).toBe(100);
  });

  it("rejects when the market is closed (plan/11 §4.1)", async () => {
    const outcome = await broker({
      readSessionOpen: () => Promise.resolve(false),
    }).execute(order());
    expect(outcome).toMatchObject({ status: "REJECTED" });
    if (outcome.status === "REJECTED") expect(outcome.reason).toMatch(/closed/);
  });

  it("refuses to fabricate a fill when no price is available (plan/11 §9)", async () => {
    const outcome = await broker({
      readPrice: () => Promise.resolve(null),
    }).execute(order());
    expect(outcome).toMatchObject({ status: "REJECTED" });
    if (outcome.status === "REJECTED")
      expect(outcome.reason).toMatch(/no current price/);
  });

  it("fills a LIMIT buy when price satisfies it, at the limit price", async () => {
    const outcome = await broker({
      readPrice: () => Promise.resolve(100),
    }).execute(order({ type: "LIMIT", price: 101 }));
    expect(outcome.status).toBe("FILLED");
    if (outcome.status === "FILLED") {
      expect(outcome.fill.filledPrice).toBe(101);
      expect(outcome.fill.slippage).toBe(0);
    }
  });

  it("holds a LIMIT buy pending when price does not satisfy it", async () => {
    const outcome = await broker({
      readPrice: () => Promise.resolve(100),
    }).execute(order({ type: "LIMIT", price: 99 }));
    expect(outcome.status).toBe("PENDING");
  });
});

describe("PaperBroker status & cancel (plan/12 §8 reconciliation)", () => {
  it("reports a filled order and an unknown one honestly", async () => {
    const b = broker();
    await b.execute(order());
    expect(await b.status("ord_1")).toMatchObject({
      found: true,
      status: "FILLED",
    });
    expect(await b.status("never")).toEqual({
      clientOrderId: "never",
      found: false,
    });
  });

  it("reflects a cancel", async () => {
    const b = broker();
    await b.execute(order({ type: "LIMIT", price: 99 })); // pending
    await b.cancel("ord_1");
    expect((await b.status("ord_1")).status).toBe("CANCELLED");
  });
});
