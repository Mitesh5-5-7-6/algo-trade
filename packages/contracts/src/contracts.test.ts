import { describe, expect, it } from "vitest";
import {
  buildEvent,
  EVENT_NAMES,
  EVENT_PAYLOAD_SCHEMAS,
  eventChannel,
  marketCandleChannel,
  marketTickChannel,
  parseEvent,
} from "./index.js";

describe("event catalog (plan/09 §6)", () => {
  it("contains exactly the 14 catalogued events, no duplicates", () => {
    expect(EVENT_NAMES).toHaveLength(14);
    expect(new Set(EVENT_NAMES).size).toBe(14);
  });

  it("has a payload schema for every event name", () => {
    for (const name of EVENT_NAMES) {
      expect(EVENT_PAYLOAD_SCHEMAS[name]).toBeDefined();
    }
  });
});

describe("envelope (plan/09 §3)", () => {
  const fill = {
    orderId: "ord_1",
    strategyId: "str_1",
    symbol: "NSE:RELIANCE-EQ",
    side: "BUY",
    qty: 10,
    filledPrice: 3001.2,
    slippage: 1.2,
    charges: 23.5,
    filledAt: 1_730_000_000_000,
    mode: "paper",
    ts: 1_730_000_000_000,
  } as const;

  it("builds a validated event carrying the correlation id", () => {
    const event = buildEvent("ORDER_FILLED", fill, "sig_1");
    expect(event.name).toBe("ORDER_FILLED");
    expect(event.correlationId).toBe("sig_1");
    expect(event.payload.filledPrice).toBe(3001.2);
  });

  it("round-trips through the wire and back", () => {
    const wire = JSON.parse(
      JSON.stringify(buildEvent("ORDER_FILLED", fill, "sig_1")),
    ) as unknown;
    const parsed = parseEvent(wire);
    expect(parsed.name).toBe("ORDER_FILLED");
  });

  it("rejects an unknown event name at the boundary", () => {
    expect(() =>
      parseEvent({ name: "ORDER_TELEPORTED", ts: 1, payload: {} }),
    ).toThrow();
  });

  it("rejects a catalogued event whose payload is malformed", () => {
    expect(() =>
      parseEvent({
        name: "ORDER_FILLED",
        ts: 1_730_000_000_000,
        payload: { ...fill, qty: -10 },
      }),
    ).toThrow();
  });

  it("refuses to build an event with an out-of-clamp sentiment (the firewall shape, plan/20 §3)", () => {
    expect(() =>
      buildEvent("SIGNAL_CREATED", {
        signalId: "sig_1",
        strategyId: "str_1",
        symbol: "NSE:RELIANCE-EQ",
        side: "BUY",
        confidence: 0.7,
        contextSnapshot: {
          price: 3000,
          indicators: {},
          session: "open",
          sentiment: 2, // outside [-1, 1]
        },
        ts: 1_730_000_000_000,
      }),
    ).toThrow();
  });
});

describe("channel builders (plan/08 §3, plan/25 §3)", () => {
  it("produces namespace-prefixed channel names", () => {
    expect(eventChannel("ORDER_FILLED")).toBe("events:ORDER_FILLED");
    expect(marketTickChannel("NSE:INFY-EQ")).toBe("market:tick:NSE:INFY-EQ");
    expect(marketCandleChannel("NSE:INFY-EQ", "5m")).toBe(
      "market:candle:NSE:INFY-EQ:5m",
    );
  });
});
