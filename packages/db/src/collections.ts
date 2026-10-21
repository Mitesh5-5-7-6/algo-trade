import type { Db } from "mongodb";

/**
 * The collection registry (plan/07 §4) and every index it specifies —
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
  /**
   * Completed trades — the canonical outcome primitive (ADR §9.2).
   *
   * Deliberately NOT `trade_logs`, which carries a 90-day TTL. A completed
   * trade is research evidence, and evidence on an operational TTL is a
   * dataset that silently shrinks under whoever is studying it (ADR §10.4).
   * This collection has no TTL and must never acquire one.
   */
  trades: "trades",
  tradeLogs: "trade_logs",
  riskLogs: "risk_logs",
  notifications: "notifications",
  news: "news",
  brokerTokens: "broker_tokens",
  /**
   * Per-instance strategy state, so a restart resumes rather than restarts
   * (§0.5.6). One row per (strategy, symbol), overwritten on change.
   */
  strategyState: "strategy_state",
  settings: "settings",
  /**
   * Replay runs (Phase 4 Q2) — RESEARCH database only. Untimed, like
   * `trades`: a replay is research evidence and must not expire.
   */
  replayRuns: "replay_runs",
  /**
   * Pattern detections — the other axis of the pattern × strategy matrix
   * (RND_RESEARCH_SPECIFICATION §5.3). RESEARCH database only (Phase 5 D6).
   *
   * No TTL, for the same reason `trades` has none: this is the evidence every
   * later statistic is computed from.
   */
  patternObservations: "pattern_observations",
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

    // pattern_observations — detections. No TTL: research evidence.
    //
    // Identity is all six fields. Dropping `detectorVersion` or `paramsKey`
    // would make a re-definition or a parameter sweep overwrite the evidence
    // earlier findings were built on, instead of sitting beside it.
    db.collection(COLLECTIONS.patternObservations).createIndex(
      {
        patternId: 1,
        detectorVersion: 1,
        paramsKey: 1,
        symbol: 1,
        interval: 1,
        ts: 1,
      },
      { unique: true, name: "observation_identity" },
    ),
    // "What happened to this symbol that day" — the per-instrument read.
    db
      .collection(COLLECTIONS.patternObservations)
      .createIndex({ symbol: 1, ts: 1 }),
    // "Every occurrence of this pattern across every symbol" — one row of the
    // matrix, and the query the statistics engine runs most.
    db
      .collection(COLLECTIONS.patternObservations)
      .createIndex({ patternId: 1, detectorVersion: 1, ts: 1 }),
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

    // trades — completed outcomes. No TTL: this is the research dataset.
    db
      .collection(COLLECTIONS.trades)
      .createIndex({ tradeId: 1 }, { unique: true }),
    // The research read pattern: one strategy over a date range.
    db
      .collection(COLLECTIONS.trades)
      .createIndex({ strategyId: 1, entryTime: -1 }),
    db.collection(COLLECTIONS.trades).createIndex({ symbol: 1, entryTime: -1 }),
    db.collection(COLLECTIONS.trades).createIndex({ entryTime: -1 }),
    // Finding the open trade a fill belongs to — the hot path in the Trade
    // Engine, so it is indexed rather than scanned.
    db
      .collection(COLLECTIONS.trades)
      .createIndex({ status: 1, strategyId: 1, symbol: 1 }),
    // Every order folded into a trade (multikey), so an add or an earlier
    // exit leg is recognised after a restart too — not just the two below,
    // which still serve trades written before `orderIds` existed (L1).
    db.collection(COLLECTIONS.trades).createIndex({ orderIds: 1 }),
    // Restart-durable fill idempotency: find the trade an order's fill
    // already landed in, without scanning the research dataset.
    db.collection(COLLECTIONS.trades).createIndex({ entryOrderId: 1 }),
    db.collection(COLLECTIONS.trades).createIndex({ exitOrderId: 1 }),

    // orders — the Exit Engine's durable in-flight check (Phase 3 D3).
    db.collection(COLLECTIONS.orders).createIndex({ positionId: 1, status: 1 }),

    // replay_runs — one per run; findable by what was replayed.
    db
      .collection(COLLECTIONS.replayRuns)
      .createIndex({ runId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.replayRuns).createIndex({ fingerprint: 1 }),
    db
      .collection(COLLECTIONS.replayRuns)
      .createIndex({ strategyId: 1, createdAt: -1 }),

    // strategy_state — one row per instance; the key IS the identity.
    db
      .collection(COLLECTIONS.strategyState)
      .createIndex({ strategyId: 1, symbol: 1 }, { unique: true }),

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
