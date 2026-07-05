import type { Db } from "mongodb";

/**
 * The 14-collection registry (plan/07 §4) and every index it specifies —
 * database design as code, applied idempotently at boot. Collection names
 * are used ONLY through this constant (plan/25 §3).
 */
export const COLLECTIONS = {
  users: "users",
  strategies: "strategies",
  signals: "signals",
  orders: "orders",
  positions: "positions",
  pnlSnapshots: "pnl_snapshots",
  marketTicks: "market_ticks",
  candles: "candles",
  tradeLogs: "trade_logs",
  riskLogs: "risk_logs",
  notifications: "notifications",
  news: "news",
  brokerTokens: "broker_tokens",
  settings: "settings",
} as const;

/** Retention windows (plan/07 §6) in seconds; configurable later if needed. */
const DAY = 86_400;
export const TTL = {
  marketTicks: 2 * DAY, // firehose: short retention, live value is in Redis
  tradeLogs: 90 * DAY,
  notifications: 90 * DAY,
  news: 30 * DAY,
  holdSignals: 30 * DAY, // HOLD rows only (operator decision 2026-07-05)
} as const;

/**
 * Create every plan/07 index, idempotently (createIndex is a no-op when the
 * index already exists). Called once at boot by the composition root.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    // users
    db
      .collection(COLLECTIONS.users)
      .createIndex({ email: 1 }, { unique: true }),

    // strategies
    db.collection(COLLECTIONS.strategies).createIndex({ ownerId: 1 }),
    db.collection(COLLECTIONS.strategies).createIndex({ enabled: 1 }),
    db.collection(COLLECTIONS.strategies).createIndex({ type: 1 }),

    // signals — split retention: HOLD rows expire, BUY/SELL are permanent
    db.collection(COLLECTIONS.signals).createIndex({ strategyId: 1, ts: -1 }),
    db.collection(COLLECTIONS.signals).createIndex({ symbol: 1, ts: -1 }),
    db.collection(COLLECTIONS.signals).createIndex({ ts: -1 }),
    db.collection(COLLECTIONS.signals).createIndex(
      { expireAt: 1 },
      { expireAfterSeconds: 0 }, // only HOLD docs carry expireAt (plan/07 §4)
    ),

    // orders — the duplicate-execution backstop (plan/12 §6)
    db
      .collection(COLLECTIONS.orders)
      .createIndex({ signalId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.orders).createIndex({ status: 1 }),
    db
      .collection(COLLECTIONS.orders)
      .createIndex({ strategyId: 1, createdAt: -1 }),
    db.collection(COLLECTIONS.orders).createIndex({ brokerOrderId: 1 }),
    db.collection(COLLECTIONS.orders).createIndex({ symbol: 1, createdAt: -1 }),

    // positions
    db.collection(COLLECTIONS.positions).createIndex({ status: 1 }),
    db.collection(COLLECTIONS.positions).createIndex({ symbol: 1, status: 1 }),
    db.collection(COLLECTIONS.positions).createIndex({ strategyId: 1 }),

    // pnl_snapshots — one row per scope per day (plan/07, added 2026-07-05)
    db
      .collection(COLLECTIONS.pnlSnapshots)
      .createIndex({ scope: 1, date: 1 }, { unique: true }),
    db.collection(COLLECTIONS.pnlSnapshots).createIndex({ date: -1 }),

    // market_ticks — firehose with TTL (plan/07 §6)
    db.collection(COLLECTIONS.marketTicks).createIndex({ symbol: 1, ts: -1 }),
    db
      .collection(COLLECTIONS.marketTicks)
      .createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL.marketTicks }),

    // candles — one bar per symbol/interval/time (plan/07)
    db
      .collection(COLLECTIONS.candles)
      .createIndex({ symbol: 1, interval: 1, ts: 1 }, { unique: true }),

    // trade_logs
    db.collection(COLLECTIONS.tradeLogs).createIndex({ ts: -1 }),
    db.collection(COLLECTIONS.tradeLogs).createIndex({ strategyId: 1, ts: -1 }),
    db
      .collection(COLLECTIONS.tradeLogs)
      .createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL.tradeLogs }),

    // risk_logs — append-only audit, retained
    db.collection(COLLECTIONS.riskLogs).createIndex({ ts: -1 }),
    db.collection(COLLECTIONS.riskLogs).createIndex({ decision: 1, ts: -1 }),
    db.collection(COLLECTIONS.riskLogs).createIndex({ strategyId: 1, ts: -1 }),

    // notifications
    db
      .collection(COLLECTIONS.notifications)
      .createIndex({ userId: 1, read: 1, createdAt: -1 }),
    db
      .collection(COLLECTIONS.notifications)
      .createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL.notifications }),

    // news
    db
      .collection(COLLECTIONS.news)
      .createIndex({ symbols: 1, publishedAt: -1 }),
    db
      .collection(COLLECTIONS.news)
      .createIndex({ fetchedAt: 1 }, { expireAfterSeconds: TTL.news }),

    // broker_tokens
    db.collection(COLLECTIONS.brokerTokens).createIndex({ userId: 1 }),
    db.collection(COLLECTIONS.brokerTokens).createIndex({ expiresAt: 1 }),

    // settings
    db
      .collection(COLLECTIONS.settings)
      .createIndex({ scope: 1 }, { unique: true }),
  ]);
}
