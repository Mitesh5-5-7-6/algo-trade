import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BrokerOrderRequest } from "@neelkanth/core";
import { FyersBroker, type FyersBrokerDeps } from "./fyers-broker.js";

/**
 * Unit tests for FyersBroker (plan/19).
 * Since the real FYERS API is external, we mock `fetch` globally and test
 * the request shaping, response normalization, and error handling.
 */

const APP_ID = "T123456";
const ACCESS_TOKEN = "test_token";

interface FyersOrderPayload {
  symbol?: string;
  qty?: number;
  type?: number;
  side?: number;
  limitPrice?: number;
  stopPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  legType?: number;
  orderTag?: string;
  productType?: string;
}

function deps(overrides: Partial<FyersBrokerDeps> = {}): FyersBrokerDeps {
  return {
    appId: APP_ID,
    getToken: () => Promise.resolve(ACCESS_TOKEN),
    ...overrides,
  };
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

describe("FyersBroker.execute (plan/19 §5)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects when no access token is available", async () => {
    const broker = new FyersBroker(
      deps({ getToken: () => Promise.resolve(null) }),
    );
    const outcome = await broker.execute(order());
    expect(outcome.status).toBe("REJECTED");
    if (outcome.status === "REJECTED") {
      expect(outcome.reason).toMatch(/access token/i);
    }
  });

  it("sends correct payload and returns PENDING on success", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ s: "ok", id: "fyers_123" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const broker = new FyersBroker(deps());
    const outcome = await broker.execute(order());

    expect(outcome.status).toBe("PENDING");
    if (outcome.status === "PENDING") {
      expect(outcome.brokerOrderId).toBe("fyers_123");
      expect(outcome.clientOrderId).toBe("ord_1");
    }

    // Verify the fetch was called with the right URL and auth header
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    // api-t1 is the live v3 host; api.fyers.in answers every v3 path with a
    // generic 500 (verified 2026-08-20).
    expect(url).toBe("https://api-t1.fyers.in/api/v3/orders/sync");
    expect(options.method).toBe("POST");
    const headers = options.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`${APP_ID}:${ACCESS_TOKEN}`);

    // Verify the order payload shape
    const body = JSON.parse(options.body as string) as FyersOrderPayload;
    expect(body.symbol).toBe("NSE:RELIANCE-EQ");
    expect(body.qty).toBe(10);
    expect(body.type).toBe(2); // MARKET = 2
    expect(body.side).toBe(1); // BUY = 1
    expect(body.orderTag).toBe("ord_1");
  });

  it("maps a LIMIT SELL order correctly", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ s: "ok", id: "fyers_456" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const broker = new FyersBroker(deps());
    await broker.execute(order({ type: "LIMIT", price: 2500, side: "SELL" }));

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as FyersOrderPayload;
    expect(body.type).toBe(1); // LIMIT = 1
    expect(body.side).toBe(-1); // SELL = -1
    expect(body.limitPrice).toBe(2500);
  });

  it("sends a MARKET entry's stop/target as point offsets on INTRADAY", async () => {
    // The regression this locks down: SL+TP used to select productType "BO",
    // which demanded a LIMIT price to subtract from. The Order Manager only
    // ever builds MARKET orders, so every strategy entry — all three attach a
    // stop and a target — was refused here, locally, before a request was
    // made. FYERS v3 takes the legs as offsets on an ordinary INTRADAY order.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ s: "ok", id: "fyers_legs" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const broker = new FyersBroker(deps());
    const outcome = await broker.execute(
      order({
        type: "MARKET",
        referencePrice: 100,
        stopLoss: 95,
        takeProfit: 110,
        side: "BUY",
      }),
    );

    expect(outcome.status).toBe("PENDING");
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as FyersOrderPayload;
    expect(body.productType).toBe("INTRADAY");
    expect(body.type).toBe(2); // still a MARKET entry
    expect(body.stopLoss).toBe(5); // 100 - 95, in points
    expect(body.takeProfit).toBe(10); // 110 - 100, in points
    expect(body.legType).toBe(1); // 1 = points
  });

  it("measures the offsets from the limit price when the order has one", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ s: "ok", id: "fyers_lim" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const broker = new FyersBroker(deps());
    await broker.execute(
      order({ type: "LIMIT", price: 100, stopLoss: 95, side: "BUY" }),
    );

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as FyersOrderPayload;
    expect(body.productType).toBe("INTRADAY");
    expect(body.stopLoss).toBe(5);
    expect(body.takeProfit).toBeUndefined(); // none was asked for
  });

  it("inverts the offsets for a SELL entry", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ s: "ok", id: "fyers_short" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const broker = new FyersBroker(deps());
    // Short at 100: the stop sits ABOVE at 104, the target BELOW at 92.
    await broker.execute(
      order({
        type: "MARKET",
        referencePrice: 100,
        stopLoss: 104,
        takeProfit: 92,
        side: "SELL",
      }),
    );

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as FyersOrderPayload;
    expect(body.stopLoss).toBe(4);
    expect(body.takeProfit).toBe(8);
  });

  it("sends no leg fields when the order asked for none", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ s: "ok", id: "fyers_bare" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const broker = new FyersBroker(deps());
    await broker.execute(order({ referencePrice: 100 }));

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as FyersOrderPayload;
    expect(body.stopLoss).toBeUndefined();
    expect(body.takeProfit).toBeUndefined();
    expect(body.legType).toBeUndefined();
  });

  it("refuses, rather than placing an unprotected entry, with no reference price", async () => {
    // Fails closed: dropping the leg would leave a live naked position that
    // the strategy and the risk engine both believe is protected.
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const broker = new FyersBroker(deps());
    const outcome = await broker.execute(
      order({ stopLoss: 95, takeProfit: 110 }), // no referencePrice
    );

    expect(outcome.status).toBe("REJECTED");
    if (outcome.status === "REJECTED") {
      expect(outcome.reason).toMatch(/referencePrice/);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuses a stop on the wrong side of the entry", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const broker = new FyersBroker(deps());
    // A BUY whose "stop" sits above the entry is not a stop at all.
    const outcome = await broker.execute(
      order({ referencePrice: 100, stopLoss: 105 }),
    );

    expect(outcome.status).toBe("REJECTED");
    if (outcome.status === "REJECTED") {
      expect(outcome.reason).toMatch(/protective side/);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns REJECTED when FYERS API responds with an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: () =>
          Promise.resolve({
            s: "error",
            message: "Insufficient margin",
            code: 1001,
          }),
      }),
    );

    const broker = new FyersBroker(deps());
    const outcome = await broker.execute(order());
    expect(outcome.status).toBe("REJECTED");
    if (outcome.status === "REJECTED") {
      expect(outcome.reason).toBe("Insufficient margin");
      expect(outcome.code).toBe("1001");
    }
  });

  it("returns REJECTED on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );

    const broker = new FyersBroker(deps());
    const outcome = await broker.execute(order());
    expect(outcome.status).toBe("REJECTED");
    if (outcome.status === "REJECTED") {
      expect(outcome.reason).toBe("ECONNREFUSED");
    }
  });

  it("invokes rate limiter before making the request", async () => {
    const checkRateLimit = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ s: "ok", id: "x" }),
      }),
    );

    const broker = new FyersBroker(deps({ checkRateLimit }));
    await broker.execute(order());
    expect(checkRateLimit).toHaveBeenCalledOnce();
  });
});

describe("FyersBroker.status (plan/12 §8 reconciliation)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns found:false when no token", async () => {
    const broker = new FyersBroker(
      deps({ getToken: () => Promise.resolve(null) }),
    );
    const s = await broker.status("ord_1");
    expect(s).toEqual({ clientOrderId: "ord_1", found: false });
  });

  it("maps FYERS status codes to internal status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            s: "ok",
            orderBook: [
              { orderTag: "ord_filled", id: "f1", status: 2 },
              { orderTag: "ord_rejected", id: "f2", status: 4 },
              { orderTag: "ord_cancelled", id: "f3", status: 1 },
              { orderTag: "ord_pending", id: "f4", status: 5 },
            ],
          }),
      }),
    );

    const broker = new FyersBroker(deps());

    expect(await broker.status("ord_filled")).toMatchObject({
      found: true,
      status: "FILLED",
    });
    expect(await broker.status("ord_rejected")).toMatchObject({
      found: true,
      status: "REJECTED",
    });
    expect(await broker.status("ord_cancelled")).toMatchObject({
      found: true,
      status: "CANCELLED",
    });
    expect(await broker.status("ord_pending")).toMatchObject({
      found: true,
      status: "PENDING",
    });
  });

  it("returns found:false when orderTag is not in the book", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ s: "ok", orderBook: [] }),
      }),
    );

    const broker = new FyersBroker(deps());
    expect(await broker.status("ghost")).toEqual({
      clientOrderId: "ghost",
      found: false,
    });
  });
});

describe("FyersBroker connection state", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("stays disconnected when no token for connect()", async () => {
    const states: string[] = [];
    const broker = new FyersBroker(
      deps({ getToken: () => Promise.resolve(null) }),
    );
    broker.onConnectionChange((s) => states.push(s));
    await broker.connect();
    // Should have gone connecting → disconnected
    expect(states).toEqual(["connecting", "disconnected"]);
  });

  it("registers onData and onOrderUpdate handlers without throwing", () => {
    const broker = new FyersBroker(deps());
    expect(() => {
      broker.onData(function () {});
    }).not.toThrow();
    expect(() => {
      broker.onOrderUpdate(function () {});
    }).not.toThrow();
  });

  it("disconnect is idempotent", async () => {
    const broker = new FyersBroker(deps());
    await broker.disconnect();
    await broker.disconnect(); // should not throw
  });

  it("subscribe stores symbols even when not connected", async () => {
    const broker = new FyersBroker(deps());
    // Should not throw even though ws is null
    await broker.subscribe(["NSE:RELIANCE-EQ", "NSE:TCS-EQ"]);
  });
});
