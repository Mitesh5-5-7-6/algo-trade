import { describe, expect, it } from "vitest";
import type { Candle, CandleInterval } from "@neelkanth/core";
import { ema, rsi, vwap } from "@neelkanth/indicators";
import { IndicatorEngine } from "./indicator-engine.js";
import type { IndicatorPorts, IndicatorSnapshot } from "./ports.js";

const SYM = "NSE:RELIANCE-EQ";
const INT: CandleInterval = "5m";

function candle(
  close: number,
  opts: { volume?: number; ts?: number; interval?: CandleInterval } = {},
): Candle {
  return {
    symbol: SYM,
    interval: opts.interval ?? INT,
    open: close,
    high: close,
    low: close,
    close,
    volume: opts.volume ?? 0,
    ts: opts.ts ?? 0,
  };
}

function harness(history: Candle[] = []) {
  const hot = new Map<string, IndicatorSnapshot>();
  const events: { name: string; payload: unknown }[] = [];
  const errors: { error: unknown; context: Record<string, unknown> }[] = [];
  const warmupLimits: number[] = [];
  const ports: IndicatorPorts = {
    writeHotIndicators(symbol, interval, snapshot) {
      hot.set(`${symbol}|${interval}`, snapshot);
      return Promise.resolve();
    },
    loadWarmupCandles(_symbol, _interval, limit) {
      warmupLimits.push(limit);
      return Promise.resolve(history);
    },
    publish(name, payload) {
      events.push({ name, payload });
      return Promise.resolve();
    },
  };
  const engine = new IndicatorEngine({
    ports,
    onError: (error, context) => errors.push({ error, context }),
  });
  return { engine, hot, events, errors, warmupLimits };
}

describe("IndicatorEngine folding & readiness (plan/18 §4, §6)", () => {
  it("folds a closed candle, gating unready values but emitting ready ones", async () => {
    const h = harness();
    h.engine.register(SYM, INT, ema(3));

    await h.engine.onCandleClosed(candle(1, { ts: 1 }));
    await h.engine.onCandleClosed(candle(2, { ts: 2 }));
    // Not ready yet: no ema3 in values, ready flag false.
    let snap = h.hot.get(`${SYM}|${INT}`);
    expect(snap?.values["ema3"]).toBeUndefined();
    expect(snap?.ready["ema3"]).toBe(false);

    await h.engine.onCandleClosed(candle(3, { ts: 3 }));
    snap = h.hot.get(`${SYM}|${INT}`);
    expect(snap?.values["ema3"]).toBeCloseTo(2, 10); // SMA(1,2,3)
    expect(snap?.ready["ema3"]).toBe(true);

    const updates = h.events.filter((e) => e.name === "INDICATORS_UPDATED");
    expect(updates).toHaveLength(3);
    expect(
      (updates[2]?.payload as { indicators: Record<string, number> })
        .indicators["ema3"],
    ).toBeCloseTo(2, 10);
  });

  it("does nothing for a series with no registered indicators", async () => {
    const h = harness();
    await h.engine.onCandleClosed(candle(1, { ts: 1 }));
    expect(h.events).toHaveLength(0);
    expect(h.hot.size).toBe(0);
    expect(h.errors).toHaveLength(0);
  });

  it("only folds indicators registered for the candle's interval", async () => {
    const h = harness();
    h.engine.register(SYM, "5m", ema(2));
    await h.engine.onCandleClosed(candle(10, { ts: 1, interval: "15m" }));
    expect(h.hot.has(`${SYM}|15m`)).toBe(false); // no 15m registration
    expect(h.hot.has(`${SYM}|5m`)).toBe(false); // 5m didn't get this bar
  });
});

describe("IndicatorEngine warm-up (plan/18 §4)", () => {
  it("loads max(warmupBars) history and seeds recursive indicators before live", async () => {
    const history = [candle(1), candle(2), candle(3)];
    const h = harness(history);
    h.engine.register(SYM, INT, ema(3));
    h.engine.register(SYM, INT, rsi(14)); // warmup 15 > ema's 3

    await h.engine.warmUp(SYM, INT);

    expect(h.warmupLimits).toEqual([15]); // the union's max
    const snap = h.hot.get(`${SYM}|${INT}`);
    expect(snap?.ready["ema3"]).toBe(true); // seeded from the 3 bars
    expect(snap?.values["ema3"]).toBeCloseTo(2, 10);
    // Warm-up is seeding, not a live close — no event emitted (plan/18 §6).
    expect(h.events).toHaveLength(0);
  });

  it("does NOT warm a session-anchored VWAP from prior-session history (plan/18 §5)", async () => {
    const history = [
      candle(10, { volume: 100 }),
      candle(11, { volume: 100 }),
      candle(12, { volume: 100 }),
    ];
    const h = harness(history);
    h.engine.register(SYM, INT, ema(3));
    h.engine.register(SYM, INT, vwap());

    await h.engine.warmUp(SYM, INT);

    const snap = h.hot.get(`${SYM}|${INT}`);
    expect(snap?.ready["ema3"]).toBe(true); // rolling: warmed
    expect(snap?.ready["vwap"]).toBe(false); // session: skipped, starts at open
    expect(snap?.values["vwap"]).toBeUndefined();
  });
});

describe("IndicatorEngine session reset (plan/18 §5)", () => {
  it("resets VWAP on MARKET_OPEN but leaves rolling indicators intact", async () => {
    const h = harness();
    h.engine.register(SYM, INT, ema(2));
    h.engine.register(SYM, INT, vwap());

    await h.engine.onCandleClosed(candle(10, { volume: 100, ts: 1 }));
    await h.engine.onCandleClosed(candle(12, { volume: 100, ts: 2 }));
    let snap = h.hot.get(`${SYM}|${INT}`);
    expect(snap?.ready["vwap"]).toBe(true);
    expect(snap?.ready["ema2"]).toBe(true);

    h.engine.onMarketOpen();
    await h.engine.onCandleClosed(candle(20, { volume: 0, ts: 3 })); // no volume yet
    snap = h.hot.get(`${SYM}|${INT}`);
    expect(snap?.ready["vwap"]).toBe(false); // reset — no cumulative volume
    expect(snap?.ready["ema2"]).toBe(true); // rolling — survived the bell
  });
});

describe("IndicatorEngine dedup & failure (plan/18 §2, plan/02 §10)", () => {
  it("deduplicates a repeated registration", async () => {
    const h = harness();
    h.engine.register(SYM, INT, ema(2));
    h.engine.register(SYM, INT, ema(2)); // same key — no-op
    await h.engine.onCandleClosed(candle(1, { ts: 1 }));
    await h.engine.onCandleClosed(candle(3, { ts: 2 }));
    const snap = h.hot.get(`${SYM}|${INT}`);
    expect(Object.keys(snap?.ready ?? {})).toEqual(["ema2"]); // one entry
  });

  it("routes a port failure to onError without throwing", async () => {
    const h = harness();
    const engine = new IndicatorEngine({
      ports: {
        writeHotIndicators: () => Promise.reject(new Error("redis down")),
        loadWarmupCandles: () => Promise.resolve([]),
        publish: () => Promise.resolve(),
      },
      onError: (error, context) => h.errors.push({ error, context }),
    });
    engine.register(SYM, INT, ema(2));
    await engine.onCandleClosed(candle(1, { ts: 1 }));
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.context["where"]).toBe("onCandleClosed");
  });
});
