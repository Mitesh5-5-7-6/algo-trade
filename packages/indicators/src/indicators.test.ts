import { describe, expect, it } from "vitest";
import type { Candle } from "@neelkanth/core";
import {
  atr,
  avgVolume,
  ema,
  rsi,
  sma,
  trueRange,
  vwap,
  type Indicator,
} from "./index.js";

/** Build a bar; unspecified OHLC default to `close`, volume to 0. */
function bar(fields: Partial<Candle> & { close: number }): Candle {
  return {
    symbol: "T",
    interval: "1m",
    open: fields.open ?? fields.close,
    high: fields.high ?? fields.close,
    low: fields.low ?? fields.close,
    close: fields.close,
    volume: fields.volume ?? 0,
    ts: fields.ts ?? 0,
  };
}

const closes = (values: number[]): Candle[] =>
  values.map((c) => bar({ close: c }));

/** Fold a whole series, returning the terminal state. */
function run<S>(ind: Indicator<S>, bars: Candle[]): S {
  let state = ind.init();
  for (const b of bars) state = ind.fold(state, b);
  return state;
}

describe("ema (plan/16 §2 — SMA-seeded)", () => {
  const ind = ema(3);

  it("is not ready before N bars, ready after, seeded with SMA(N)", () => {
    let state = ind.init();
    state = ind.fold(state, bar({ close: 1 }));
    state = ind.fold(state, bar({ close: 2 }));
    expect(ind.ready(state)).toBe(false);
    expect(ind.read(state)).toBeNull();
    state = ind.fold(state, bar({ close: 3 }));
    expect(ind.ready(state)).toBe(true);
    expect(ind.read(state)).toEqual({ ema3: 2 }); // SMA(1,2,3)
  });

  it("folds subsequent bars with α = 2/(N+1)", () => {
    const state = run(ind, closes([1, 2, 3, 4, 5]));
    // bar4: 0.5·4 + 0.5·2 = 3 ; bar5: 0.5·5 + 0.5·3 = 4
    expect(ind.read(state)?.["ema3"]).toBeCloseTo(4, 10);
  });

  it("rejects a non-positive or non-integer period", () => {
    expect(() => ema(0)).toThrow();
    expect(() => ema(1.5)).toThrow();
  });
});

describe("rsi (plan/16 §3 — Wilder)", () => {
  const ind = rsi(3);

  it("needs N+1 closes and matches the Wilder computation", () => {
    let state = ind.init();
    for (const c of [10, 11, 10]) state = ind.fold(state, bar({ close: c }));
    expect(ind.ready(state)).toBe(false); // only 2 deltas so far
    state = ind.fold(state, bar({ close: 11 })); // 3rd delta → seeded
    expect(ind.ready(state)).toBe(true);
    // avgGain=2/3, avgLoss=1/3, RS=2, RSI=100−100/3
    expect(ind.read(state)?.["rsi3"]).toBeCloseTo(66.6667, 3);
    state = ind.fold(state, bar({ close: 12 }));
    // avgGain=(0.6667·2+1)/3=0.7778, avgLoss=(0.3333·2)/3=0.2222, RS=3.5
    expect(ind.read(state)?.["rsi3"]).toBeCloseTo(77.7778, 3);
  });

  it("reads 100 when average loss is zero (only gains)", () => {
    const state = run(ind, closes([1, 2, 3, 4, 5]));
    expect(ind.read(state)?.["rsi3"]).toBe(100);
  });
});

describe("atr (plan/16 §7 — Wilder)", () => {
  it("computes true range with and without a previous close", () => {
    expect(trueRange(bar({ high: 10, low: 8, close: 9 }), null)).toBe(2);
    expect(trueRange(bar({ high: 15, low: 11, close: 14 }), 11)).toBe(4);
  });

  it("seeds with the mean TR over N bars, then Wilder-smooths", () => {
    const ind = atr(3);
    const seed = [
      bar({ high: 10, low: 8, close: 9 }), // TR 2
      bar({ high: 11, low: 9, close: 10 }), // TR 2
      bar({ high: 12, low: 10, close: 11 }), // TR 2 → seed ATR 2
    ];
    let state = ind.init();
    for (const b of seed) state = ind.fold(state, b);
    expect(ind.read(state)?.["atr3"]).toBeCloseTo(2, 10);
    state = ind.fold(state, bar({ high: 15, low: 11, close: 14 })); // TR 4 → (2·2+4)/3
    expect(ind.read(state)?.["atr3"]).toBeCloseTo(2.6667, 3);
  });
});

describe("vwap (plan/16 §4 — session-anchored)", () => {
  it("is flagged session-anchored for the engine's daily reset (plan/18 §5)", () => {
    expect(vwap().sessionAnchored).toBe(true);
  });

  it("accumulates typical-price × volume over the session", () => {
    const ind = vwap();
    let state = ind.init();
    state = ind.fold(state, bar({ high: 10, low: 8, close: 9, volume: 100 }));
    expect(ind.read(state)?.["vwap"]).toBeCloseTo(9, 10); // TP 9
    state = ind.fold(state, bar({ high: 12, low: 10, close: 11, volume: 200 }));
    // (9·100 + 11·200) / 300
    expect(ind.read(state)?.["vwap"]).toBeCloseTo(10.3333, 3);
  });

  it("is not ready with zero cumulative volume (early session, plan/16 §4)", () => {
    const ind = vwap();
    const state = ind.fold(ind.init(), bar({ close: 9, volume: 0 }));
    expect(ind.ready(state)).toBe(false);
  });
});

describe("rolling means (plan/16 §8)", () => {
  it("sma averages the last N closes and slides the window", () => {
    const ind = sma(3);
    let state = ind.init();
    state = ind.fold(state, bar({ close: 1 }));
    state = ind.fold(state, bar({ close: 2 }));
    expect(ind.read(state)).toBeNull(); // not ready
    state = ind.fold(state, bar({ close: 3 }));
    expect(ind.read(state)?.["sma3"]).toBeCloseTo(2, 10);
    state = ind.fold(state, bar({ close: 4 })); // window (2,3,4)
    expect(ind.read(state)?.["sma3"]).toBeCloseTo(3, 10);
    state = ind.fold(state, bar({ close: 5 })); // window (3,4,5)
    expect(ind.read(state)?.["sma3"]).toBeCloseTo(4, 10);
  });

  it("avgVolume averages traded volume", () => {
    const ind = avgVolume(2);
    let state = ind.init();
    state = ind.fold(state, bar({ close: 1, volume: 10 }));
    state = ind.fold(state, bar({ close: 1, volume: 20 }));
    expect(ind.read(state)?.["avgvol2"]).toBeCloseTo(15, 10);
    state = ind.fold(state, bar({ close: 1, volume: 30 }));
    expect(ind.read(state)?.["avgvol2"]).toBeCloseTo(25, 10); // (20+30)/2
  });
});
