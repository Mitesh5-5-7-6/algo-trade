import type {
  CandleInterval,
  RiskLimits,
  StrategyConfig,
} from "@neelkanth/core";
import type { GoldenFixture, RawTick } from "./pipeline.js";

const SYMBOL = "NSE:TESTCO-EQ";
const INDEX = "NSE:TESTINDEX-INDEX";
const INTERVAL = "5m" as const;
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const istTs = (h: number, m: number): number =>
  Date.UTC(2026, 0, 5, h, m) - IST_OFFSET_MS;
/** 2026-01-05 (Mon) 09:15 IST session open, as a UTC epoch. */
const SESSION_OPEN_TS = istTs(9, 15);
const BAR_MS = 5 * 60_000;
/** 09:15 → 15:10 IST: the whole regular session, so the day really ends. */
const BARS = 71;

/**
 * The intervals production aggregates, so the harness aggregates them too.
 *
 * It matters beyond tidiness: the Exit Engine judges stops on EVERY closed
 * bar, so a 1-minute bar can trigger an exit a 5-minute bar would not have
 * shown yet. A harness building only 5m would prove determinism over a system
 * that exits later than the real one.
 */
const INTERVALS = ["1m", "5m"] as const satisfies readonly CandleInterval[];

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The deterministic close path — `Math.sin`, so it is reproducible exactly. */
const closeAt = (i: number): number =>
  round2(120 + 15 * Math.sin(i / 5) + 8 * Math.sin(i / 2));

/**
 * An index that trends DOWN all session.
 *
 * Deliberately the same direction the traded symbol ends up in, so index and
 * breadth agree and the market view resolves BEARISH rather than to the
 * NEUTRAL that agreement-only would otherwise produce. A gate that is wired in
 * but never says no is not being tested.
 */
const indexCloseAt = (i: number): number => round2(22_000 - i * 4);

/**
 * One 5-minute bucket as FOUR raw ticks, in open → high → low → close order.
 *
 * The harness feeds ticks rather than finished candles, because production has
 * no source of finished candles — it has a feed. Handing the pipeline
 * pre-baked bars skipped normalization and aggregation entirely, so the golden
 * record proved nothing about the two steps every other number depends on, and
 * the end-of-day flush had no bar left open to flush.
 *
 * The ticks are spaced a minute apart so the 1-minute bars are real bars too,
 * not four ticks landing in one bucket.
 */
function ticksForBar(
  symbol: string,
  bucketStart: number,
  open: number,
  close: number,
): RawTick[] {
  const high = round2(Math.max(open, close) + 0.5);
  const low = round2(Math.min(open, close) - 0.5);
  return [
    { sym: symbol, ltp: open, vol: 250, ts: bucketStart },
    { sym: symbol, ltp: high, vol: 250, ts: bucketStart + 60_000 },
    { sym: symbol, ltp: low, vol: 250, ts: bucketStart + 120_000 },
    { sym: symbol, ltp: close, vol: 250, ts: bucketStart + 180_000 },
  ];
}

/**
 * The session's ticks, in arrival order: both symbols, bar by bar.
 *
 * Interleaved rather than one symbol then the other, because that is how a
 * feed delivers them and because the market view is recomputed on every closed
 * bar — the order the two symbols' bars close in is part of what the harness
 * is proving is deterministic.
 */
function buildTicks(): RawTick[] {
  const ticks: RawTick[] = [];
  let prevClose = closeAt(0);
  let prevIndexClose = indexCloseAt(0);
  for (let i = 0; i < BARS; i += 1) {
    const bucketStart = SESSION_OPEN_TS + i * BAR_MS;
    const close = closeAt(i);
    const indexClose = indexCloseAt(i);
    ticks.push(
      ...ticksForBar(SYMBOL, bucketStart, i === 0 ? close : prevClose, close),
      ...ticksForBar(
        INDEX,
        bucketStart,
        i === 0 ? indexClose : prevIndexClose,
        indexClose,
      ),
    );
    prevClose = close;
    prevIndexClose = indexClose;
  }
  return ticks;
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
      // A tighter stop than the default ten-bar swing, and shorts enabled.
      // Both are ordinary configuration, and between them they make the
      // record cover what a permissive setup never reaches: a protective stop
      // actually being hit, and a SHORT position being judged — which is the
      // branch of the breach test the long side cannot exercise.
      params: {
        fast: 9,
        slow: 21,
        quantity: 10,
        swingLookback: 3,
        allowShort: true,
      },
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
  riskPerTrade: 0.01,
};

export function goldenFixture(): GoldenFixture {
  return {
    symbol: SYMBOL,
    interval: INTERVAL,
    intervals: [...INTERVALS],
    sessionOpenTs: SESSION_OPEN_TS,
    ticks: buildTicks(),
    strategies: strategies(),
    indexSymbols: [INDEX],
    breadthSymbols: [SYMBOL],
    // One traded instrument is the whole universe here, so breadth is allowed
    // to decide on one. Left at the production default of five, this fixture
    // could never produce anything but NEUTRAL and the gate would be present
    // in the harness without ever being exercised.
    biasConfig: { minBreadthSymbols: 1 },
    allocatedCapital: 1_000_000,
    limits: LIMITS,
    /** 09:00 IST — the engine is up before the bell, so the open is a real edge. */
    preOpenTs: istTs(9, 0),
    /** 15:15 IST — flatten while risk will still approve the exits. */
    squareOffTs: istTs(15, 15),
    /** 15:31 IST — the first evaluation after the bell. */
    afterCloseTs: istTs(15, 31),
  };
}
