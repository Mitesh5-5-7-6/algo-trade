import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "@neelkanth/logger";
import { ScriptedFakeBroker } from "@neelkanth/broker";
import { istDateKey } from "@neelkanth/core";
import {
  ensureIndexes,
  NotificationsRepository,
  SettingsRepository,
  type NotificationRecord,
} from "@neelkanth/db";
import {
  createRedisConnections,
  riskDailyLossKey,
  type RedisConnections,
} from "@neelkanth/redis";
import {
  closeProbe,
  probeMongo,
  STRICT,
  type MongoProbe,
} from "../test-support/infra.js";
import { startEngineRuntime, type EngineRuntime } from "../engines/runtime.js";
import { createLiveMarketState } from "../engines/live-market-state.js";
import { subscribeCatalogue } from "./catalogue.js";
import { createDailyMessages } from "./daily.js";
import { readDaySummary } from "./day-summary.js";
import { createNotifier } from "./create.js";
import { recordOf } from "./record.js";
import type { Notifier } from "./notifier.js";
import type { Db } from "mongodb";

/**
 * Task 16.7 — Phase 16's acceptance, the automated half (design §5).
 *
 * The real paper runtime on scratch MongoDB and Redis, the catalogue and the
 * daily messages wired to it as the composition root wires them, and one
 * scripted session: its own pause, kill and resume; real fills that move
 * positions, Trades, P&L and the daily-loss counter; and, for what other
 * components raise in a live session, their bus events.
 *
 * Run three times. With Telegram answering, every category of design §5.2
 * reaches its chat (D8) and is kept (D7). With Telegram hung, and with it
 * refusing, the trading state the session leaves is identical, and nothing
 * the session does waits on it (D2).
 *
 * The live half — a real paper session into a real test chat — is 14.7's
 * first session (PLAN §30).
 */

const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/placeholder";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const IT_DB = "neelkanth_it_notify_acceptance";
const TOKEN = "123456789:AAH-acceptance_token";
const OPS = "-100ops";
const TRADES = "-100trades";

/** A fixed weekday, so the session is open whenever the suite runs. */
const DAY = "2026-01-05";
const at = (hhmm: string) => Date.parse(`${DAY}T${hhmm}:00+05:30`);
const SYMBOL = "NSE:ACCEPT-EQ";
const STRATEGY = "str_accept";

let probe: MongoProbe | undefined;
let redis: RedisConnections | undefined;
let reachable = false;

const silent = () =>
  createLogger({
    level: "fatal",
    name: "test",
    destination: { write: () => true },
  });

type Telegram = "answering" | "hung" | "refusing";

/** Telegram's sendMessage, as each run finds it. */
function telegram(kind: Telegram, seen: { chat: string; text: string }[]) {
  return (_url: string | URL | Request, init?: RequestInit) => {
    if (kind === "hung") return new Promise<Response>(() => undefined);
    if (kind === "refusing")
      return Promise.reject(new Error("connect ECONNREFUSED"));
    const raw = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(raw) as { chat_id: string; text: string };
    seen.push({ chat: body.chat_id, text: body.text });
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  };
}

interface Run {
  readonly db: Db;
  readonly runtime: EngineRuntime;
  readonly notifier: Notifier;
  readonly seen: { chat: string; text: string }[];
  readonly kept: Promise<void>[];
  /** The slowest single step of the session, in ms. */
  slowest: number;
}

async function boot(kind: Telegram): Promise<Run> {
  if (probe?.reachable !== true || redis === undefined)
    throw new Error("infrastructure not probed");
  const db = probe.connection.db;
  await db.dropDatabase();
  await ensureIndexes(db);
  // The operator has enabled trading for the session; a fresh database
  // boots halted, and a pause from halted is no transition to tell of.
  await new SettingsRepository(db).setTradingEnabled(true);
  await redis.client.del(riskDailyLossKey(istDateKey(Date.now())));

  const seen: { chat: string; text: string }[] = [];
  const kept: Promise<void>[] = [];
  const records = new NotificationsRepository(db);
  const notifier = createNotifier(
    {
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_CHAT_ID: OPS,
      TELEGRAM_TRADES_CHAT_ID: TRADES,
    },
    () => undefined,
    (outcome) => {
      kept.push(
        records.record(
          recordOf(outcome, `ntf_${String(kept.length)}`, Date.now()),
        ),
      );
    },
    {
      fetch: telegram(kind, seen),
      sleep: () => Promise.resolve(),
    },
  );
  const runtime = await startEngineRuntime({
    redis,
    mongo: probe.connection,
    logger: silent(),
    broker: new ScriptedFakeBroker(),
    mode: "paper",
    liveState: createLiveMarketState(),
  });
  await subscribeCatalogue({
    bus: runtime.bus,
    notifier,
    mode: "paper",
    includeInfo: true,
    dailyLossLimit: () => runtime.riskLimits().maxDailyLoss,
    marketOpen: () => runtime.session().phase === "open",
    windowMs: 20,
  });
  return { db, runtime, notifier, seen, kept, slowest: 0 };
}

/** Time one step; the session must never wait on Telegram (D2). */
async function step(run: Run, fn: () => unknown) {
  const started = Date.now();
  await fn();
  run.slowest = Math.max(run.slowest, Date.now() - started);
}

/** One round trip through the runtime's own fill path; waits for its P&L. */
async function roundTrip(
  run: Run,
  n: number,
  entry: number,
  exit: number,
  qty: number,
  exitReason: "STOP_LOSS" | "TAKE_PROFIT",
) {
  const before = run.runtime.realizedPnl();
  const base = {
    strategyId: STRATEGY,
    symbol: SYMBOL,
    qty,
    slippage: 0,
    charges: 0,
    mode: "paper" as const,
  };
  await step(run, () =>
    run.runtime.bus.publish("ORDER_FILLED", {
      ...base,
      orderId: `ord_in_${String(n)}`,
      side: "BUY",
      filledPrice: entry,
      filledAt: at("10:00") + n * 60_000,
      ts: at("10:00") + n * 60_000,
    }),
  );
  await step(run, () =>
    run.runtime.bus.publish("ORDER_FILLED", {
      ...base,
      orderId: `ord_out_${String(n)}`,
      side: "SELL",
      filledPrice: exit,
      filledAt: at("10:00") + n * 60_000 + 30_000,
      ts: at("10:00") + n * 60_000 + 30_000,
      exitReason,
    }),
  );
  await vi.waitFor(
    () => {
      expect(run.runtime.realizedPnl()).toBeCloseTo(
        before + (exit - entry) * qty,
        4,
      );
    },
    { timeout: 20_000, interval: 50 },
  );
}

/** The session: every category of design §5.2, once. */
async function session(run: Run): Promise<void> {
  const { runtime } = run;
  const bus = runtime.bus;
  const ts = at("10:00");
  const daily = createDailyMessages({
    notifier: run.notifier,
    mode: "paper",
    includeInfo: true,
    isTradingDay: () => Promise.resolve(true),
    tokenStatus: () => Promise.resolve("absent" as const),
    readSummary: (day) => readDaySummary(run.db, "paper", day),
    onError: () => undefined,
  });

  await step(run, () => daily.tick(at("09:05"))); // the pre-open token message
  // Before the bell, then after it: MARKET_OPEN is the transition, never a
  // boot that finds the market already open.
  await step(run, () => runtime.syncSession(at("09:10")));
  await step(run, () => runtime.syncSession(at("09:20")));
  expect(runtime.session().phase).toBe("open");

  const limit = runtime.riskLimits().maxDailyLoss;
  expect(limit).toBeGreaterThan(0);
  // A win, then losses to 55 %, 85 % and past 100 % of the limit.
  await roundTrip(run, 1, 100, 110, 10, "TAKE_PROFIT");
  await roundTrip(run, 2, 100, 99, Math.ceil(limit * 0.55) + 100, "STOP_LOSS");
  await roundTrip(run, 3, 100, 99, Math.ceil(limit * 0.3), "STOP_LOSS");
  await roundTrip(run, 4, 100, 99, Math.ceil(limit * 0.2), "STOP_LOSS");

  for (let i = 0; i < 2; i += 1)
    await step(run, () =>
      bus.publish("ORDER_REJECTED", {
        orderId: `ord_rej_${String(i)}`,
        signalId: `sig_rej_${String(i)}`,
        strategyId: STRATEGY,
        symbol: SYMBOL,
        side: "BUY",
        qty: 1,
        reason: "RMS: insufficient margin",
        mode: "paper",
        ts,
      }),
    );
  for (let i = 0; i < 5; i += 1)
    await step(run, () =>
      bus.publish("RISK_BLOCKED", {
        signalId: `sig_blk_${String(i)}`,
        strategyId: STRATEGY,
        symbol: SYMBOL,
        failedCheck: "dailyLoss",
        reason: "daily loss limit reached",
        ts,
      }),
    );
  await step(run, () =>
    bus.publish("FEED_SILENT", {
      broker: "fyers",
      mode: "paper",
      silentSeconds: 90,
      subscribed: 1,
      ts,
    }),
  );
  await step(run, () =>
    bus.publish("FEED_RECOVERED", { broker: "fyers", mode: "paper", ts }),
  );
  await step(run, () =>
    bus.publish("BROKER_DISCONNECTED", {
      broker: "fyers",
      mode: "paper",
      reason: "socket closed",
      ts,
    }),
  );
  await step(run, () =>
    bus.publish("BROKER_TOKEN_MISSING", {
      broker: "fyers",
      mode: "paper",
      reason: "expired",
      ts,
    }),
  );
  await step(run, () =>
    bus.publish("SYSTEM_ERROR", {
      source: "orderManager.reconcile",
      level: "error",
      message: "broker reports FILLED but returned no fill price",
      context: { brokerOrderId: "B-SECRET" },
      ts,
    }),
  );
  await step(run, () => {
    runtime.setTradingEnabled({ enabled: false, source: "pause" });
  });
  await step(run, () => {
    runtime.setTradingEnabled({ enabled: true, source: "operator" });
  });
  await step(run, () => {
    runtime.setTradingEnabled({ enabled: false, source: "kill" });
  });
  // The coalescing windows close (20 ms here), then the day's summary.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await step(run, () => daily.tick(at("15:50")));
}

/** What the session leaves behind that a decision could have changed. */
async function tradingState(run: Run) {
  if (probe?.reachable !== true || redis === undefined)
    throw new Error("infrastructure not probed");
  const db = probe.connection.db;
  const strip = (doc: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(doc).filter(
        ([k]) =>
          ![
            "_id",
            "tradeId",
            "positionId",
            "createdAt",
            "updatedAt",
            "expireAt",
          ].includes(k),
      ),
    );
  const rows = async (name: string, sort: Record<string, 1>) =>
    (await db.collection(name).find({}).sort(sort).toArray()).map(strip);
  return {
    trades: await rows("trades", { entryTime: 1 }),
    positions: await rows("positions", { symbol: 1 }),
    realized: run.runtime.realizedPnl(),
    dailyLoss: await redis.client.get(riskDailyLossKey(istDateKey(Date.now()))),
    phase: run.runtime.session().phase,
  };
}

beforeAll(async () => {
  probe = await probeMongo(MONGO_URI, IT_DB, "notifications acceptance");
  let redisOk = false;
  try {
    redis = createRedisConnections(REDIS_URL, () => undefined);
    await redis.client.ping();
    redisOk = true;
  } catch {
    redisOk = false;
  }
  reachable = probe.reachable && redisOk;
  if (!reachable && STRICT)
    throw new Error(
      "notifications acceptance: MongoDB or Redis unreachable and REQUIRE_INTEGRATION=1",
    );
}, 120_000);

afterAll(async () => {
  await closeProbe(probe);
  await redis?.quit();
});

const CATEGORIES: [RegExp, "CRITICAL" | "WARNING" | "INFO", string][] = [
  [/^Broker token missing before the open$/, "WARNING", OPS],
  [/^Market open$/, "INFO", OPS],
  [/^Entry filled: /, "INFO", TRADES],
  [/^Position closed: .* \+₹100$/, "INFO", TRADES],
  [/^Daily loss at 50% of the limit$/, "WARNING", OPS],
  [/^Daily loss at 80% of the limit$/, "WARNING", OPS],
  [/^Daily loss limit reached$/, "CRITICAL", OPS],
  [/^2 orders rejected by the broker$/, "WARNING", OPS],
  [/^5 signals blocked by risk in /, "WARNING", OPS],
  [/^Market feed silent$/, "WARNING", OPS],
  [/^Market feed recovered$/, "INFO", OPS],
  [/^Broker fyers disconnected$/, "CRITICAL", OPS],
  [/^Broker fyers token expired$/, "CRITICAL", OPS],
  [/^System error — orderManager\.reconcile$/, "CRITICAL", OPS],
  [/^Trading halted \(pause\)$/, "CRITICAL", OPS],
  [/^Trading resumed by the operator$/, "WARNING", OPS],
  [/^Trading halted \(kill\)$/, "CRITICAL", OPS],
  [new RegExp(`^Day summary ${DAY}$`), "INFO", OPS],
];

describe("Phase 16 acceptance — one paper session (16.7)", () => {
  let baseline: Awaited<ReturnType<typeof tradingState>> | undefined;

  it("delivers every category to its chat, and keeps each one", async (ctx) => {
    if (!reachable) return ctx.skip();
    const run = await boot("answering");
    try {
      await session(run);
      await vi.waitFor(
        () => {
          expect(run.seen.length).toBeGreaterThanOrEqual(CATEGORIES.length);
        },
        { timeout: 20_000, interval: 50 },
      );
      await Promise.all(run.kept);
      baseline = await tradingState(run);
      // Something to compare: four Trades, a loss past the limit, and the
      // counter that carries it.
      expect(baseline.trades).toHaveLength(4);
      expect(baseline.realized).toBeLessThan(0);
      expect(baseline.dailyLoss).not.toBeNull();
    } finally {
      await run.runtime.shutdown();
    }

    const heads = run.seen.map((m) => {
      const [head = ""] = m.text.split("\n");
      const match = /^\[PAPER\] (CRITICAL|WARNING|INFO) — (.*)$/.exec(head);
      return { severity: match?.[1], title: match?.[2] ?? head, chat: m.chat };
    });
    // Each category at least once — fills and closes once per Trade — and
    // every one at its severity, in its chat.
    for (const [title, severity, chat] of CATEGORIES) {
      const hits = heads.filter((h) => title.test(h.title));
      expect(hits.length, String(title)).toBeGreaterThan(0);
      expect(
        hits.filter((h) => h.severity !== severity || h.chat !== chat),
        String(title),
      ).toEqual([]);
    }
    // Nothing secret left in a message (D5).
    expect(JSON.stringify(run.seen)).not.toMatch(/B-SECRET|AAH-acceptance/);

    if (probe?.reachable !== true) return;
    const records: NotificationRecord[] = await new NotificationsRepository(
      probe.connection.db,
    ).findRecent(100);
    expect(records).toHaveLength(run.seen.length);
    expect(
      records.every((r) => r.outcome === "sent" && r.mode === "paper"),
    ).toBe(true);
    expect(
      records
        .filter((r) => r.chat === "trades")
        .map((r) => r.title.split(":")[0]),
    ).toEqual(expect.arrayContaining(["Entry filled", "Position closed"]));
  }, 180_000);

  for (const kind of ["hung", "refusing"] as const)
    it(`changes nothing the session decides with Telegram ${kind}`, async (ctx) => {
      if (!reachable || baseline === undefined) return ctx.skip();
      const run = await boot(kind);
      try {
        await session(run);
        expect(await tradingState(run)).toEqual(baseline);
        expect(run.seen).toEqual([]);
        // Each step returned at once: none waited on the dead chat.
        expect(run.slowest).toBeLessThan(5_000);
      } finally {
        await run.runtime.shutdown();
      }
    }, 180_000);
});
