import type { Order, Position, StrategyConfig } from "@neelkanth/core";

/**
 * The dashboard's data seam.
 *
 * Until milestone 1.9 wires TanStack Query + Socket.IO to the live API
 * (plan/06 §5), every page reads from this typed mock snapshot. The shapes
 * are the REAL `core` shapes — the mock is validated against the Zod schemas
 * in tests — so swapping mocks for live data changes the transport, not a
 * single component.
 *
 * Numbers reproduce the operator-supplied design frame (plan/06 §4) so the
 * first render is a faithful implementation check against the reference.
 */

export interface SystemStatus {
  mode: "paper" | "live";
  broker: { name: string; connected: boolean; latencyMs: number };
  market: {
    exchange: string;
    phase: "pre-open" | "open" | "closed";
    ts: number;
  };
  engine: { state: "running" | "paused" | "killed"; signalsToday: number };
  tradingEnabled: boolean;
}

export interface DayPnl {
  realized: number;
  unrealized: number;
  /** Fraction of the daily loss limit consumed by realized loss (plan/14 §4.3). */
  lossLimitUsed: number;
  lossLimit: number;
  /** Time the 80% warning armed, if it has (plan/23 §6 act-now tier). */
  warningArmedAt?: number;
  /** Equity curve points for the session, one per minute. */
  curve: ReadonlyArray<{ ts: number; value: number }>;
}

export interface StrategyRow {
  config: StrategyConfig;
  dayRealizedPnl: number;
  signalsToday: number;
  openPositions: number;
}

export interface ActivityEntry {
  ts: number;
  kind: "signal" | "order" | "fill" | "risk_block" | "system";
  message: string;
}

export interface RiskSettings {
  capitalAllocation: number;
  maxDailyLoss: number;
  maxPositionSize: number;
  maxOpenPositions: number;
  maxExposure: number;
  squareOffTime: string; // "15:12" IST
}

export interface DashboardSnapshot {
  status: SystemStatus;
  dayPnl: DayPnl;
  positions: Position[];
  orders: Order[];
  strategies: StrategyRow[];
  activity: ActivityEntry[];
  settings: RiskSettings;
}

/** 2026-07-05 13:42:27 IST, the moment captured in the design reference. */
const NOW = Date.UTC(2026, 6, 5, 8, 12, 27);
const minsAgo = (m: number) => NOW - m * 60_000;

/** Session-shaped declining curve echoing the design's SVG polyline. */
function buildCurve(): Array<{ ts: number; value: number }> {
  const points: Array<{ ts: number; value: number }> = [];
  const sessionMinutes = 267; // 09:15 → 13:42 IST
  let value = 2400;
  for (let i = 0; i <= sessionMinutes; i += 3) {
    const t = i / sessionMinutes;
    // Gentle decline to ≈ −18.7k; never approaches the −25k limit — the
    // design frame shows the limit at 82%, not breached (and entries would
    // have auto-halted at 100%, plan/14 §4.3).
    const drift = -17_000 * t * (1 - 0.25 * Math.cos(t * Math.PI));
    const wobble =
      1900 * Math.sin(i / 7) * (1 - t * 0.6) + 900 * Math.sin(i / 3.1);
    value = 2400 + drift + wobble;
    points.push({ ts: minsAgo(sessionMinutes - i), value: Math.round(value) });
  }
  const last = points[points.length - 1];
  if (last) last.value = -18_683;
  return points;
}

const strategies: StrategyRow[] = [
  {
    config: {
      strategyId: "str_ema_nifty",
      ownerId: "usr_operator",
      type: "EMA_CROSSOVER",
      name: "EMA 9/21 · index majors",
      params: { fast: 9, slow: 21, interval: "5m" },
      symbols: ["NSE:RELIANCE-EQ", "NSE:HDFCBANK-EQ"],
      enabled: true,
      status: "active",
      createdAt: minsAgo(6_000),
      updatedAt: minsAgo(300),
    },
    dayRealizedPnl: -9_320,
    signalsToday: 9,
    openPositions: 1,
  },
  {
    config: {
      strategyId: "str_orb_banknifty",
      ownerId: "usr_operator",
      type: "ORB",
      name: "ORB 15m · banks",
      params: { rangeMinutes: 15, volumeMultiple: 1.5 },
      symbols: ["NSE:ICICIBANK-EQ", "NSE:AXISBANK-EQ"],
      enabled: true,
      status: "active",
      createdAt: minsAgo(6_000),
      updatedAt: minsAgo(280),
    },
    dayRealizedPnl: -13_710,
    signalsToday: 6,
    openPositions: 1,
  },
  {
    config: {
      strategyId: "str_rsi_it",
      ownerId: "usr_operator",
      type: "RSI",
      name: "RSI 14 fade · IT",
      params: { period: 14, oversold: 30, overbought: 70 },
      symbols: ["NSE:INFY-EQ", "NSE:TCS-EQ"],
      enabled: true,
      status: "active",
      createdAt: minsAgo(6_000),
      updatedAt: minsAgo(260),
    },
    dayRealizedPnl: 2_490,
    signalsToday: 11,
    openPositions: 1,
  },
  {
    config: {
      strategyId: "str_vwap_energy",
      ownerId: "usr_operator",
      type: "VWAP",
      name: "VWAP pullback · energy",
      params: { band: 0.001 },
      symbols: ["NSE:ONGC-EQ"],
      enabled: false,
      status: "active",
      createdAt: minsAgo(6_000),
      updatedAt: minsAgo(2_000),
    },
    dayRealizedPnl: 0,
    signalsToday: 0,
    openPositions: 0,
  },
];

const positions: Position[] = [
  {
    positionId: "pos_1",
    symbol: "NSE:RELIANCE-EQ",
    strategyId: "str_ema_nifty",
    side: "LONG",
    qty: 50,
    avgEntryPrice: 2_986.4,
    status: "OPEN",
    realizedPnl: 0,
    unrealizedPnl: 1_410,
    openedAt: minsAgo(96),
    mode: "paper",
  },
  {
    positionId: "pos_2",
    symbol: "NSE:ICICIBANK-EQ",
    strategyId: "str_orb_banknifty",
    side: "SHORT",
    qty: 120,
    avgEntryPrice: 1_248.7,
    status: "OPEN",
    realizedPnl: -3_890,
    unrealizedPnl: -1_020,
    openedAt: minsAgo(64),
    mode: "paper",
  },
  {
    positionId: "pos_3",
    symbol: "NSE:INFY-EQ",
    strategyId: "str_rsi_it",
    side: "LONG",
    qty: 80,
    avgEntryPrice: 1_512.2,
    status: "OPEN",
    realizedPnl: 0,
    unrealizedPnl: 1_467,
    openedAt: minsAgo(23),
    mode: "paper",
  },
];

const orders: Order[] = [
  {
    orderId: "ord_1043",
    signalId: "sig_2087",
    strategyId: "str_rsi_it",
    symbol: "NSE:INFY-EQ",
    side: "BUY",
    qty: 80,
    type: "MARKET",
    status: "FILLED",
    mode: "paper",
    slippage: 0.35,
    charges: 42.6,
    filledPrice: 1_512.2,
    filledAt: minsAgo(23),
    createdAt: minsAgo(23),
  },
  {
    orderId: "ord_1042",
    signalId: "sig_2081",
    strategyId: "str_orb_banknifty",
    symbol: "NSE:AXISBANK-EQ",
    side: "SELL",
    qty: 100,
    type: "MARKET",
    status: "REJECTED",
    mode: "paper",
    createdAt: minsAgo(41),
  },
  {
    orderId: "ord_1041",
    signalId: "sig_2075",
    strategyId: "str_orb_banknifty",
    symbol: "NSE:ICICIBANK-EQ",
    side: "SELL",
    qty: 120,
    type: "MARKET",
    status: "FILLED",
    mode: "paper",
    slippage: 0.6,
    charges: 51.2,
    filledPrice: 1_248.7,
    filledAt: minsAgo(64),
    createdAt: minsAgo(64),
  },
  {
    orderId: "ord_1040",
    signalId: "sig_2066",
    strategyId: "str_ema_nifty",
    symbol: "NSE:RELIANCE-EQ",
    side: "BUY",
    qty: 50,
    type: "MARKET",
    status: "FILLED",
    mode: "paper",
    slippage: 0.45,
    charges: 47.8,
    filledPrice: 2_986.4,
    filledAt: minsAgo(96),
    createdAt: minsAgo(96),
  },
];

const activity: ActivityEntry[] = [
  {
    ts: minsAgo(4),
    kind: "risk_block",
    message:
      "RISK_BLOCKED sig_2093 (EMA_CROSSOVER, HDFCBANK) — daily loss at 82% blocks new entries above size cap",
  },
  {
    ts: minsAgo(23),
    kind: "fill",
    message: "ORDER_FILLED ord_1043 BUY 80 INFY @ 1,512.20 (RSI re-cross 30)",
  },
  {
    ts: minsAgo(27),
    kind: "system",
    message: "Daily-loss warning ARMED at 80% of limit (13:15 IST)",
  },
  {
    ts: minsAgo(41),
    kind: "order",
    message:
      "ORDER_REJECTED ord_1042 SELL 100 AXISBANK — duplicate intent in flight",
  },
  {
    ts: minsAgo(64),
    kind: "fill",
    message:
      "ORDER_FILLED ord_1041 SELL 120 ICICIBANK @ 1,248.70 (ORB breakdown)",
  },
];

export function getMockSnapshot(): DashboardSnapshot {
  return {
    status: {
      mode: "paper",
      broker: { name: "FYERS", connected: true, latencyMs: 44 },
      market: { exchange: "NSE", phase: "open", ts: NOW },
      engine: { state: "running", signalsToday: 26 },
      tradingEnabled: true,
    },
    dayPnl: {
      realized: -20_540,
      unrealized: 1_857,
      lossLimitUsed: 0.82,
      lossLimit: 25_000,
      warningArmedAt: Date.UTC(2026, 6, 5, 7, 45, 0), // 13:15 IST
      curve: buildCurve(),
    },
    positions,
    orders,
    strategies,
    activity,
    settings: {
      capitalAllocation: 600_000,
      maxDailyLoss: 25_000,
      maxPositionSize: 150,
      maxOpenPositions: 6,
      maxExposure: 0.6,
      squareOffTime: "15:12",
    },
  };
}
