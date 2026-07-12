import type { Candle, RiskLimits, StrategyConfig } from "@neelkanth/core";
import type { GoldenFixture } from "./pipeline.js";

const SYMBOL = "NSE:TESTCO-EQ";
const INTERVAL = "5m" as const;
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
/** 2026-01-05 (Mon) 09:15 IST session open, as a UTC epoch. */
const SESSION_OPEN_TS = Date.UTC(2026, 0, 5, 9, 15) - IST_OFFSET_MS;
const BAR_MS = 5 * 60_000;
const BARS = 60;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * A constructed day of 5m candles for one symbol (plan/27 §4). The close path
 * oscillates deterministically around 120 so both EMAs cross repeatedly (up
 * and down) and RSI swings through its bands — enough to warm the indicators
 * and exercise entries and exits. `Math.sin` is deterministic, so the whole
 * fixture is reproducible bit-for-bit.
 */
function buildCandles(): Candle[] {
  const candles: Candle[] = [];
  let prevClose = 120;
  for (let i = 0; i < BARS; i += 1) {
    const close = round2(120 + 15 * Math.sin(i / 5) + 8 * Math.sin(i / 2));
    const open = i === 0 ? close : prevClose;
    candles.push({
      symbol: SYMBOL,
      interval: INTERVAL,
      open,
      high: round2(Math.max(open, close) + 0.5),
      low: round2(Math.min(open, close) - 0.5),
      close,
      volume: 1000,
      ts: SESSION_OPEN_TS + (i + 1) * BAR_MS,
    });
    prevClose = close;
  }
  return candles;
}

function strategies(): StrategyConfig[] {
  const base = {
    ownerId: "usr_golden",
    symbols: [SYMBOL],
    enabled: true,
    status: "active" as const,
    createdAt: 0,
    updatedAt: 0,
  };
  return [
    {
      ...base,
      strategyId: "str_ema",
      type: "EMA_CROSSOVER",
      name: "EMA 9/21",
      params: { fast: 9, slow: 21, quantity: 10 },
    },
    {
      ...base,
      strategyId: "str_rsi",
      type: "RSI",
      name: "RSI 14",
      params: { period: 14, quantity: 10 },
    },
  ];
}

const LIMITS: RiskLimits = {
  maxDailyLoss: 50_000,
  maxPositionSize: 1_000,
  maxCapitalPerTrade: 500_000,
  maxOpenPositions: 10,
  maxExposure: 0.9,
};

export function goldenFixture(): GoldenFixture {
  return {
    symbol: SYMBOL,
    interval: INTERVAL,
    sessionOpenTs: SESSION_OPEN_TS,
    candles: buildCandles(),
    strategies: strategies(),
    allocatedCapital: 1_000_000,
    limits: LIMITS,
  };
}
