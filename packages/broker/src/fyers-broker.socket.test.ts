import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerConnectionState } from "@neelkanth/core";

/**
 * The market-data socket's lifecycle against a fake of the vendor SDK that
 * behaves as the shipped one does where it matters: `getInstance` builds ONE
 * socket, on the first call, and every later call returns it — whatever token
 * it is handed — until `instance` is cleared.
 */
const sdk = vi.hoisted(() => {
  class FakeSocket {
    readonly handlers = new Map<string, ((...a: unknown[]) => void)[]>();
    readonly subscribed: string[][] = [];
    subscribeResult: Promise<void> = Promise.resolve();
    closed = false;
    constructor(readonly token: string) {}
    on(event: string, handler: (...a: unknown[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    }
    emit(event: string, ...args: unknown[]) {
      for (const h of this.handlers.get(event) ?? []) h(...args);
    }
    connect() {}
    autoreconnect() {}
    subscribe(symbols: string[]) {
      this.subscribed.push(symbols);
      return this.subscribeResult;
    }
    unsubscribe() {}
    close() {
      this.closed = true;
    }
  }
  const built: FakeSocket[] = [];
  const fyersDataSocket: {
    instance?: FakeSocket;
    getInstance(token: string): FakeSocket;
  } = {
    getInstance(token: string) {
      if (fyersDataSocket.instance === undefined) {
        fyersDataSocket.instance = new FakeSocket(token);
        built.push(fyersDataSocket.instance);
      }
      return fyersDataSocket.instance;
    },
  };
  return { FakeSocket, built, fyersDataSocket };
});

vi.mock("fyers-api-v3", () => ({
  fyersDataSocket: sdk.fyersDataSocket,
  fyersOrderSocket: vi.fn(),
}));

const { FyersBroker } = await import("./fyers-broker.js");
type FeedEvent = Parameters<
  NonNullable<ConstructorParameters<typeof FyersBroker>[0]["onFeedEvent"]>
>[0];

let token: string | null;
let events: FeedEvent[];
let states: BrokerConnectionState[];
let ticks: unknown[];

function broker() {
  const b = new FyersBroker({
    appId: "APP-100",
    getToken: () => Promise.resolve(token),
    orders: "disabled",
    onFeedEvent: (e) => events.push(e),
  });
  b.onConnectionChange((s) => states.push(s));
  b.onData((raw) => ticks.push(raw));
  return b;
}
const last = () => {
  const s = sdk.built.at(-1);
  if (s === undefined) throw new Error("no socket built");
  return s;
};

beforeEach(() => {
  delete sdk.fyersDataSocket.instance;
  sdk.built.length = 0;
  token = "day-1";
  events = [];
  states = [];
  ticks = [];
});

describe("the FYERS market-data socket", () => {
  it("builds a fresh socket on the new token after the morning re-login", async () => {
    const b = broker();
    await b.connect();
    last().emit("connect");
    expect(last().token).toBe("APP-100:day-1");

    // Overnight the token dies; the operator logs in; the token is stored.
    token = "day-2";
    await b.connect();

    expect(sdk.built).toHaveLength(2);
    expect(sdk.built[0]?.closed).toBe(true);
    expect(last().token).toBe("APP-100:day-2");
    expect(events).toContainEqual({
      kind: "rebuilt",
      reason: "a new access token was stored",
    });
  });

  it("keeps a live socket on the same token", async () => {
    const b = broker();
    await b.connect();
    last().emit("connect");

    await b.connect();

    expect(sdk.built).toHaveLength(1);
    expect(sdk.built[0]?.closed).toBe(false);
  });

  it("ignores everything a replaced socket still says", async () => {
    const b = broker();
    await b.connect();
    const old = last();
    old.emit("connect");
    token = "day-2";
    await b.connect();
    last().emit("connect");
    states.length = 0;

    old.emit("close");
    old.emit("message", { symbol: "NSE:NIFTY50-INDEX", ltp: 1 });

    expect(states).toEqual([]);
    expect(ticks).toEqual([]);
  });

  it("subscribes the working set on connect, and reports a subscribe that fails", async () => {
    const b = broker();
    await b.subscribe(["NSE:NIFTY50-INDEX"]);
    await b.connect();
    last().subscribeResult = Promise.reject(new Error("error fetching tokens"));
    last().emit("connect");
    await new Promise((r) => setImmediate(r));

    expect(last().subscribed).toEqual([["NSE:NIFTY50-INDEX"]]);
    expect(events).toContainEqual({
      kind: "error",
      detail: "subscribe failed: error fetching tokens",
    });
  });

  it("restores the subscription exactly once per connection, after every reconnect", async () => {
    const b = broker();
    // The Market Data Engine resubscribes on every "connected" state change;
    // the broker resubscribes on every socket connect. Both fire at once.
    b.onConnectionChange((s) => {
      if (s === "connected") void b.subscribe(["NSE:NIFTY50-INDEX"]);
    });
    await b.subscribe(["NSE:NIFTY50-INDEX"]);
    await b.connect();

    last().emit("connect");
    last().emit("close", 1006, "dropped");
    last().emit("connect");

    expect(last().subscribed).toEqual([
      ["NSE:NIFTY50-INDEX"],
      ["NSE:NIFTY50-INDEX"],
    ]);
  });

  it("subscribes a changed set, and retries one whose subscribe failed", async () => {
    const b = broker();
    await b.subscribe(["NSE:NIFTY50-INDEX"]);
    await b.connect();
    last().subscribeResult = Promise.reject(new Error("timeout"));
    last().emit("connect");
    await new Promise((r) => setImmediate(r));
    last().subscribeResult = Promise.resolve();

    await b.subscribe(["NSE:NIFTY50-INDEX"]);
    await b.subscribe(["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"]);

    expect(last().subscribed).toEqual([
      ["NSE:NIFTY50-INDEX"],
      ["NSE:NIFTY50-INDEX"],
      ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX"],
    ]);
  });

  it("shares one connect between two callers rather than racing", async () => {
    const b = broker();

    await Promise.all([b.connect(), b.connect()]);

    expect(sdk.built).toHaveLength(1);
    expect(events.filter((e) => e.kind === "rebuilt")).toEqual([]);
  });

  it("reports why it closed and what failed, instead of swallowing them", async () => {
    const b = broker();
    await b.connect();
    last().emit("connect");

    last().emit("error", new Error("Token expired"));
    last().emit("close", 1006, "abnormal closure");

    expect(events).toEqual([
      { kind: "error", detail: "Token expired" },
      { kind: "closed", detail: "1006 abnormal closure" },
    ]);
    expect(states.at(-1)).toBe("disconnected");
  });

  it("forwards ticks, and reports the server's own messages instead", async () => {
    const b = broker();
    await b.connect();
    const tick = { symbol: "NSE:NIFTY50-INDEX", ltp: 25_000 };
    const ack = { type: "cn", s: "ok", message: "successful", code: 200 };

    last().emit("message", ack);
    last().emit("message", tick);
    last().emit("message", { type: "sub", s: "error", message: "invalid" });

    expect(ticks).toEqual([tick]);
    expect(events).toEqual([
      { kind: "control", message: ack },
      {
        kind: "error",
        detail: JSON.stringify({ type: "sub", s: "error", message: "invalid" }),
      },
    ]);
  });
});
