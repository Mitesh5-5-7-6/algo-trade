import { describe, expect, it } from "vitest";
import type { Candle, SessionPhase, Tick } from "@neelkanth/core";
import type { EventName, EventPayload } from "@neelkanth/contracts";
import { ScriptedFakeBroker } from "@neelkanth/broker";
import { MarketDataEngine } from "./market-data-engine.js";
import { fixtureNormalizer } from "./normalize.js";
import { SessionManager } from "./session-manager.js";
import type { MarketDataPorts } from "./ports.js";

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const ist = (h: number, mi: number): number =>
  Date.UTC(2026, 0, 5, h, mi) - IST_OFFSET_MS; // Monday 2026-01-05

interface Captured {
  ports: MarketDataPorts;
  hotPrices: Map<string, Tick>;
  session: { phase?: SessionPhase };
  candles: Candle[];
  events: { name: EventName; payload: unknown }[];
  errors: { error: unknown; context: Record<string, unknown> }[];
}

function harness(): Captured {
  const hotPrices = new Map<string, Tick>();
  const session: { phase?: SessionPhase } = {};
  const candles: Candle[] = [];
  const events: { name: EventName; payload: unknown }[] = [];
  const ports: MarketDataPorts = {
    writeHotPrice(symbol, tick) {
      hotPrices.set(symbol, tick);
      return Promise.resolve();
    },
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
  return { ports, hotPrices, session, candles, events, errors: [] };
}

function engineWith(h: Captured, session?: SessionManager) {
  return new MarketDataEngine({
    ports: h.ports,
    normalizer: fixtureNormalizer,
    intervals: ["1m"],
    ...(session ? { session } : {}),
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

    expect(h.hotPrices.get("NSE:RELIANCE-EQ")?.ltp).toBe(95);
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
    expect(h.hotPrices.get("NSE:RELIANCE-EQ")?.ltp).toBe(100);
  });

  it("routes an unparseable message to onError and publishes nothing", async () => {
    const h = harness();
    const engine = engineWith(h);
    await engine.ingestRaw({ garbage: true });
    expect(h.events).toHaveLength(0);
    expect(h.errors).toHaveLength(1);
  });
});

describe("MarketDataEngine session (plan/17 §6)", () => {
  it("writes hot:session on change and emits MARKET_OPEN then MARKET_CLOSE", async () => {
    const h = harness();
    const engine = engineWith(h, new SessionManager());

    await engine.pollSession(ist(8, 30)); // closed (first eval, no transition)
    expect(h.session.phase).toBe("closed");
    await engine.pollSession(ist(9, 20)); // → open
    await engine.pollSession(ist(15, 45)); // → closed

    const names = h.events.map((e) => e.name);
    expect(names).toContain("MARKET_OPEN");
    expect(names).toContain("MARKET_CLOSE");
    expect(h.session.phase).toBe("closed");
  });

  it("flushes open bars on MARKET_CLOSE (plan/17 §5 EOD)", async () => {
    const h = harness();
    const engine = engineWith(h, new SessionManager());
    await engine.pollSession(ist(9, 16)); // open (from null → open: no transition)
    // Force a real open transition so close later fires, then leave a bar open.
    await engine.ingestRaw(raw(9_000_000, 100)); // an open, unclosed bar
    await engine.pollSession(ist(15, 45)); // close → flush

    const closed = h.events.filter((e) => e.name === "CANDLE_CLOSED");
    expect(closed).toHaveLength(1); // the still-open bar was flushed
    expect(h.candles).toHaveLength(1);
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

    expect(h.hotPrices.get("NSE:RELIANCE-EQ")?.ltp).toBe(250);
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
