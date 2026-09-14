import { describe, expect, it } from "vitest";
import type { Candle, SessionPhase, Tick } from "@neelkanth/core";
import type { EventName, EventPayload } from "@neelkanth/contracts";
import { ScriptedFakeBroker } from "@neelkanth/broker";
import { MarketDataEngine } from "./market-data-engine.js";
import { fixtureNormalizer } from "./normalize.js";
import type { MarketDataPorts } from "./ports.js";

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const ist = (h: number, mi: number): number =>
  Date.UTC(2026, 0, 5, h, mi) - IST_OFFSET_MS; // Monday 2026-01-05

interface Captured {
  ports: MarketDataPorts;
  /** The latest MARKET_TICK payload per symbol — the observable that replaced
   *  the per-tick Redis write. */
  lastTick: (symbol: string) => Tick | undefined;
  session: { phase?: SessionPhase };
  candles: Candle[];
  events: { name: EventName; payload: unknown }[];
  errors: { error: unknown; context: Record<string, unknown> }[];
}

function harness(): Captured {
  const session: { phase?: SessionPhase } = {};
  const candles: Candle[] = [];
  const events: { name: EventName; payload: unknown }[] = [];
  const ports: MarketDataPorts = {
    writeHotSession(phase) {
      session.phase = phase;
      return Promise.resolve();
    },
    saveCandle(candle) {
      candles.push(candle);
      return Promise.resolve();
    },
    publish<N extends EventName>(name: N, payload: EventPayload<N>) {
      events.push({ name, payload });
      return Promise.resolve();
    },
  };
  const lastTick = (symbol: string): Tick | undefined =>
    events
      .filter((e) => e.name === "MARKET_TICK")
      .map((e) => e.payload as Tick)
      .filter((t) => t.symbol === symbol)
      .at(-1);
  return { ports, lastTick, session, candles, events, errors: [] };
}

function engineWith(h: Captured) {
  return new MarketDataEngine({
    ports: h.ports,
    normalizer: fixtureNormalizer,
    intervals: ["1m"],
    onError: (error, context) => h.errors.push({ error, context }),
  });
}

const raw = (ts: number, ltp: number, vol = 1) => ({
  sym: "NSE:RELIANCE-EQ",
  ltp,
  vol,
  ts,
});

describe("MarketDataEngine tick path (plan/17 §4)", () => {
  it("writes hot price, publishes MARKET_TICK, and emits CANDLE_CLOSED on a boundary", async () => {
    const h = harness();
    const engine = engineWith(h);

    await engine.ingestRaw(raw(1_000, 100, 5));
    await engine.ingestRaw(raw(2_000, 110, 5));
    await engine.ingestRaw(raw(61_000, 95, 5)); // crosses the 1m boundary

    expect(h.lastTick("NSE:RELIANCE-EQ")?.ltp).toBe(95);
    const ticks = h.events.filter((e) => e.name === "MARKET_TICK");
    const closed = h.events.filter((e) => e.name === "CANDLE_CLOSED");
    expect(ticks).toHaveLength(3);
    expect(closed).toHaveLength(1);
    expect(h.candles).toHaveLength(1);
    expect((closed[0]?.payload as Candle).open).toBe(100);
    expect((closed[0]?.payload as Candle).volume).toBe(10);
  });

  it("drops a stale/out-of-order tick — monotonic hot state (plan/17 §8)", async () => {
    const h = harness();
    const engine = engineWith(h);
    await engine.ingestRaw(raw(5_000, 100));
    await engine.ingestRaw(raw(3_000, 999)); // older — dropped
    await engine.ingestRaw(raw(5_000, 999)); // equal — dropped
    expect(h.events.filter((e) => e.name === "MARKET_TICK")).toHaveLength(1);
    expect(h.lastTick("NSE:RELIANCE-EQ")?.ltp).toBe(100);
  });

  it("routes an unparseable message to onError and publishes nothing", async () => {
    const h = harness();
    const engine = engineWith(h);
    await engine.ingestRaw({ garbage: true });
    expect(h.events).toHaveLength(0);
    expect(h.errors).toHaveLength(1);
  });
});

describe("MarketDataEngine end-of-session flush (plan/17 §5 EOD)", () => {
  /**
   * The regression this guards: the aggregator holds each interval's final
   * bucket open until a later tick pushes it forward, and after the close no
   * such tick arrives. The flush was only ever reachable through a
   * `pollSession` nothing in production called, so the day's last bar either
   * died with the process overnight or surfaced at the NEXT session's first
   * tick as a CANDLE_CLOSED carrying yesterday's timestamp — into a live open
   * market, where the exit engine judges stops against it.
   */
  it("persists and publishes the bar left open at the close", async () => {
    const h = harness();
    const engine = engineWith(h);

    await engine.ingestRaw(raw(ist(15, 28), 100, 5)); // the day's last bar
    expect(h.candles).toHaveLength(0); // still open — no boundary crossed

    await engine.flushOpenBars();

    expect(h.candles).toHaveLength(1);
    expect(h.candles[0]?.close).toBe(100);
    expect(h.events.filter((e) => e.name === "CANDLE_CLOSED")).toHaveLength(1);
  });

  it("flushes every symbol and interval that has an open bar", async () => {
    const h = harness();
    const engine = new MarketDataEngine({
      ports: h.ports,
      normalizer: fixtureNormalizer,
      intervals: ["1m", "5m"],
      onError: (error, context) => h.errors.push({ error, context }),
    });

    await engine.ingestRaw(raw(ist(15, 28), 100));
    await engine.ingestRaw({ ...raw(ist(15, 28), 250), sym: "NSE:INFY-EQ" });
    await engine.flushOpenBars();

    // Two symbols × two intervals.
    expect(h.candles).toHaveLength(4);
    expect(new Set(h.candles.map((c) => c.symbol))).toEqual(
      new Set(["NSE:RELIANCE-EQ", "NSE:INFY-EQ"]),
    );
    expect(new Set(h.candles.map((c) => c.interval))).toEqual(
      new Set(["1m", "5m"]),
    );
  });

  it("is idempotent — a second flush emits nothing", async () => {
    const h = harness();
    const engine = engineWith(h);
    await engine.ingestRaw(raw(ist(15, 28), 100));

    await engine.flushOpenBars();
    await engine.flushOpenBars();

    expect(h.candles).toHaveLength(1);
  });

  it("flushes nothing when no bar is open", async () => {
    const h = harness();
    const engine = engineWith(h);
    await engine.flushOpenBars();
    expect(h.candles).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("routes a persistence failure to onError instead of rejecting", async () => {
    const h = harness();
    const engine = new MarketDataEngine({
      ports: {
        ...h.ports,
        saveCandle: () => Promise.reject(new Error("mongo down")),
      },
      normalizer: fixtureNormalizer,
      intervals: ["1m"],
      onError: (error, context) => h.errors.push({ error, context }),
    });
    await engine.ingestRaw(raw(ist(15, 28), 100));

    // Must not throw: a failed flush cannot take down the session transition.
    await expect(engine.flushOpenBars()).resolves.toBeUndefined();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.context).toMatchObject({ where: "flushOpenBars" });
  });

  /**
   * The engine no longer drives the session. The runtime does, on its own
   * timer, with its own SessionManager — and `evaluate()` consumes the
   * open/close edge, so a second driver sharing that manager would eat the
   * transition the runtime's MARKET_OPEN/MARKET_CLOSE publishing depends on.
   */
  it("exposes no session driver at all", () => {
    const h = harness();
    const engine = engineWith(h);
    expect("pollSession" in engine).toBe(false);
  });
});

describe("MarketDataEngine broker attach (plan/17 §7-8)", () => {
  it("ingests raw data delivered by the broker feed", async () => {
    const h = harness();
    const engine = engineWith(h);
    const broker = new ScriptedFakeBroker({ defaultFillPrice: 1 });
    engine.attach(broker);

    broker.emitData(raw(1_000, 250));
    await Promise.resolve(); // let the async ingest settle
    await Promise.resolve();

    expect(h.lastTick("NSE:RELIANCE-EQ")?.ltp).toBe(250);
  });

  it("re-subscribes the working set on reconnect (subscriptions don't survive)", async () => {
    const h = harness();
    const engine = engineWith(h);
    const broker = new ScriptedFakeBroker({ defaultFillPrice: 1 });
    engine.attach(broker);
    await engine.subscribe(["NSE:INFY-EQ", "NSE:TCS-EQ"]);

    broker.subscriptions.clear(); // simulate the broker dropping subs on drop
    broker.setConnectionState("connected"); // reconnect
    await Promise.resolve();
    await Promise.resolve();

    expect(broker.subscriptions.has("NSE:INFY-EQ")).toBe(true);
    expect(broker.subscriptions.has("NSE:TCS-EQ")).toBe(true);
  });
});

describe("MarketDataEngine — Redis is off the tick path", () => {
  /**
   * The regression this guards: every tick used to issue a Redis SET for
   * `hot:price:{symbol}` on top of the publish. Across ~15 ticks/sec that was
   * ~96% of all Redis commands, for a key the trading path never reads — the
   * engine, risk and the paper broker all read the in-process price.
   *
   * Asserted as "the port does not exist on the hot path" rather than as a
   * command count, so it stays meaningful if the plumbing moves.
   */
  it("exposes no per-tick hot-state write port at all", () => {
    const h = harness();
    expect("writeHotPrice" in h.ports).toBe(false);
  });

  it("still publishes every accepted tick and persists closed bars", async () => {
    const h = harness();
    const engine = engineWith(h);
    await engine.ingestRaw(raw(1_000, 100, 5));
    await engine.ingestRaw(raw(61_000, 110, 5));

    expect(h.events.filter((e) => e.name === "MARKET_TICK")).toHaveLength(2);
    expect(h.candles).toHaveLength(1);
    expect(h.lastTick("NSE:RELIANCE-EQ")?.ltp).toBe(110);
  });
});
