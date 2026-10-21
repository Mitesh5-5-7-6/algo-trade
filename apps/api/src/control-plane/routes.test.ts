import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  closeProbe,
  probeMongo,
  type MongoProbe,
} from "../test-support/infra.js";
import type {
  Position,
  RiskLimits,
  SessionContext,
  StrategyConfig,
} from "@neelkanth/core";
import {
  ensureIndexes,
  PositionsRepository,
  SignalsRepository,
  StrategiesRepository,
  type MongoConnection,
} from "@neelkanth/db";
import { createLogger } from "@neelkanth/logger";
import type { HistoryProvider, HistoryResult } from "@neelkanth/broker";
import { buildServer, type ApiServer } from "../server.js";
import { registerControlPlane } from "./routes.js";
import type { RuntimeControls, StepUpVerifier } from "./controls.js";

const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/neelkanth_cp_test";

let probe: MongoProbe | undefined;
let connection: MongoConnection;

beforeAll(async () => {
  probe = await probeMongo(
    MONGO_URI,
    "neelkanth_it_cp",
    "apps/api/src/control-plane/routes.test.ts",
  );
  if (!probe.reachable) return;
  connection = probe.connection;
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
});

afterAll(async () => {
  await closeProbe(probe);
});

/**
 * Skip every test in this file when the database is unreachable (§0.4).
 *
 * A `beforeEach` rather than a guard inside each test: reachability is only
 * known after `beforeAll` has run, so `describe.skipIf` — which is evaluated
 * at collection time — cannot see it.
 */
beforeEach((ctx) => {
  if (probe?.reachable !== true) ctx.skip();
});

/** Records what the routes drive into the live runtime (plan/05 §2 seam). */
function fakeRuntime() {
  const calls: string[] = [];
  let tradingEnabled = true;
  const controls: RuntimeControls = {
    setTradingEnabled(enabled) {
      tradingEnabled = enabled;
      calls.push(`setTradingEnabled:${String(enabled)}`);
    },
    enableStrategy(config) {
      calls.push(`enable:${config.strategyId}`);
      return Promise.resolve();
    },
    disableStrategy(strategyId) {
      calls.push(`disable:${strategyId}`);
    },
    applyGlobalSettings() {
      calls.push("applyGlobalSettings");
    },
    getOpenPositions: (): Position[] => [],
    realizedPnl: () => 250,
    unrealizedPnl: () => 40,
    session: (): SessionContext => ({
      phase: "open",
      minutesSinceOpen: 30,
      sessionOpenTs: 0,
    }),
    equityCurve: () => [{ ts: 1000, realizedPnl: 250, unrealizedPnl: 40 }],
    brokerConnection: () => ({
      state: "connected" as const,
      connected: true,
      since: 5000,
    }),
  };
  return { controls, calls, isTradingEnabled: () => tradingEnabled };
}

function silentLogger() {
  return createLogger({
    level: "fatal",
    name: "test",
    destination: {
      write() {
        return true;
      },
    },
  });
}

let app: ApiServer;
let runtime: ReturnType<typeof fakeRuntime>;
let stepUps: Array<string | undefined>;
/**
 * Set before `makeApp()` to choose whether this deployment can fetch history.
 * Null is the default, because null is the honest default: most deployments
 * have no real provider (design D1).
 */
let historyProvider: HistoryProvider | null = null;

function makeApp() {
  runtime = fakeRuntime();
  stepUps = [];
  // Permissive step-up here — this suite proves routing/repo/runtime wiring;
  // the enforced gate is proven in auth.test.ts with the real verifier.
  const verifyStepUp: StepUpVerifier = (_userId, password) => {
    stepUps.push(password);
    return Promise.resolve();
  };
  app = buildServer({ logger: silentLogger(), readinessChecks: [] });
  registerControlPlane(app, {
    db: connection.db,
    runtime: runtime.controls,
    verifyStepUp,
    historyProvider,
  });
}

afterEach(async () => {
  historyProvider = null;
  await app.close();
  await connection.db.collection("strategies").deleteMany({});
  await connection.db.collection("settings").deleteMany({});
  await connection.db.collection("candles").deleteMany({});
  await connection.db.collection("trades").deleteMany({});
});

const createBody = {
  type: "EMA_CROSSOVER",
  name: "EMA 9/21",
  params: { fast: 9, slow: 21 },
  symbols: ["NSE:X-EQ"],
  enabled: true,
};

describe("strategies routes (plan/05 §4.1)", () => {
  it("creates an enabled strategy, enabling it live, and lists it", async () => {
    makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/strategies",
      payload: createBody,
    });
    expect(created.statusCode).toBe(201);
    const config = created.json<StrategyConfig>();
    expect(config.type).toBe("EMA_CROSSOVER");
    expect(runtime.calls).toContain(`enable:${config.strategyId}`);

    const list = await app.inject({ method: "GET", url: "/strategies" });
    expect(list.json<StrategyConfig[]>()).toHaveLength(1);
  });

  it("lists the registered strategy types for the create form", async () => {
    makeApp();
    const res = await app.inject({ method: "GET", url: "/strategies/types" });
    expect(res.statusCode).toBe(200);
    expect(res.json<string[]>()).toContain("EMA_CROSSOVER");
    expect(res.json<string[]>()).toContain("RSI");
  });

  it("rejects an unknown strategy type with 400", async () => {
    makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/strategies",
      payload: { ...createBody, type: "GHOST" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("rejects a malformed body with 400", async () => {
    makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/strategies",
      payload: { name: "no type", symbols: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("enables and disables an existing strategy live", async () => {
    makeApp();
    const repo = new StrategiesRepository(connection.db);
    await repo.create({
      strategyId: "str_x",
      ownerId: "operator",
      type: "RSI",
      name: "RSI",
      params: { period: 14 },
      symbols: ["NSE:Y-EQ"],
      enabled: false,
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });

    const enabled = await app.inject({
      method: "POST",
      url: "/strategies/str_x/enable",
    });
    expect(enabled.statusCode).toBe(200);
    expect(runtime.calls).toContain("enable:str_x");

    const disabled = await app.inject({
      method: "POST",
      url: "/strategies/str_x/disable",
    });
    expect(disabled.statusCode).toBe(200);
    expect(runtime.calls).toContain("disable:str_x");
  });

  it("404s a missing strategy and soft-deletes on DELETE", async () => {
    makeApp();
    expect(
      (await app.inject({ method: "GET", url: "/strategies/ghost" }))
        .statusCode,
    ).toBe(404);

    const repo = new StrategiesRepository(connection.db);
    await repo.create({
      strategyId: "str_d",
      ownerId: "operator",
      type: "RSI",
      name: "RSI",
      params: { period: 14 },
      symbols: ["NSE:Y-EQ"],
      enabled: true,
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });
    const del = await app.inject({
      method: "DELETE",
      url: "/strategies/str_d",
    });
    expect(del.statusCode).toBe(204);
    expect(runtime.calls).toContain("disable:str_d");
    expect(await repo.findEnabled()).toHaveLength(0);
  });
});

describe("read-model routes", () => {
  it("returns live positions and the current pnl", async () => {
    makeApp();
    expect(
      (await app.inject({ method: "GET", url: "/positions" })).json(),
    ).toEqual([]);
    const pnl = await app.inject({ method: "GET", url: "/pnl" });
    expect(pnl.json()).toEqual({ realizedPnl: 250, unrealizedPnl: 40 });

    const curve = await app.inject({ method: "GET", url: "/pnl/curve" });
    expect(curve.json()).toEqual([
      { ts: 1000, realizedPnl: 250, unrealizedPnl: 40 },
    ]);
  });

  it("aggregates per-strategy day stats, zero-filled (plan/06 §4)", async () => {
    makeApp();
    const now = Date.now();
    const strategyRepo = new StrategiesRepository(connection.db);
    const config: StrategyConfig = {
      strategyId: "str_stats_a",
      ownerId: "operator",
      type: "RSI",
      name: "RSI",
      params: { period: 14 },
      symbols: ["NSE:Y-EQ"],
      enabled: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    await strategyRepo.create(config);
    await strategyRepo.create({
      ...config,
      strategyId: "str_stats_idle",
      name: "idle",
    });

    const positionsRepo = new PositionsRepository(connection.db);
    await positionsRepo.upsert({
      positionId: "pos_stats_1",
      symbol: "NSE:Y-EQ",
      strategyId: "str_stats_a",
      side: "LONG",
      qty: 0,
      avgEntryPrice: 100,
      status: "CLOSED",
      realizedPnl: 320,
      unrealizedPnl: 0,
      openedAt: now,
      mode: "paper",
    });

    const signalsRepo = new SignalsRepository(connection.db);
    await signalsRepo.insert({
      signalId: "sig_stats_1",
      strategyId: "str_stats_a",
      symbol: "NSE:Y-EQ",
      side: "BUY",
      confidence: 0.9,
      reason: "test",
      contextSnapshot: {
        price: 1,
        indicators: {},
        session: "open",
        sentiment: 0,
      },
      ts: now,
    });

    const res = await app.inject({ method: "GET", url: "/strategies/stats" });
    expect(res.statusCode).toBe(200);
    const rows = res
      .json<{ strategyId: string }[]>()
      .sort((a, b) => a.strategyId.localeCompare(b.strategyId));
    // `evaluationsToday` counts every bar the strategy judged, signal or not.
    // It is asserted rather than ignored because it is the field that tells an
    // operator "this strategy is running and choosing not to trade" apart from
    // "this strategy is not running" — and a `toEqual` that omitted it would
    // pass just as happily if the route stopped returning it.
    expect(rows).toEqual([
      {
        strategyId: "str_stats_a",
        dayRealizedPnl: 320,
        signalsToday: 1,
        evaluationsToday: 1,
      },
      {
        strategyId: "str_stats_idle",
        dayRealizedPnl: 0,
        signalsToday: 0,
        evaluationsToday: 0,
      },
    ]);
  });
});

describe("settings & control routes", () => {
  it("reads settings, patches them, and applies to the runtime", async () => {
    makeApp();
    const get = await app.inject({ method: "GET", url: "/settings" });
    expect(get.statusCode).toBe(200);

    const limits: RiskLimits = {
      maxDailyLoss: 30_000,
      maxPositionSize: 500,
      maxCapitalPerTrade: 200_000,
      maxOpenPositions: 4,
      maxExposure: 0.5,
      riskPerTrade: 0.01,
    };
    const patched = await app.inject({
      method: "PATCH",
      url: "/settings",
      payload: { capitalAllocation: 600_000, globalRiskLimits: limits },
    });
    expect(patched.statusCode).toBe(200);
    expect(
      patched.json<{ capitalAllocation: number }>().capitalAllocation,
    ).toBe(600_000);
    expect(runtime.calls).toContain("applyGlobalSettings");
  });

  it("pause and resume flip the kill flag through settings and runtime", async () => {
    makeApp();
    const paused = await app.inject({ method: "POST", url: "/control/pause" });
    expect(paused.json()).toEqual({ tradingEnabled: false });
    expect(runtime.isTradingEnabled()).toBe(false);

    const status = await app.inject({ method: "GET", url: "/control/status" });
    expect(status.json<{ tradingEnabled: boolean }>().tradingEnabled).toBe(
      false,
    );

    const resumed = await app.inject({
      method: "POST",
      url: "/control/resume",
      payload: { stepUpPassword: "hunter2" },
    });
    expect(resumed.json()).toEqual({ tradingEnabled: true });
    expect(runtime.isTradingEnabled()).toBe(true);
    // Resume is a ⚠ route — it must go through the step-up gate (plan/21 §5).
    expect(stepUps).toEqual(["hunter2"]);
  });
});

describe("POST /backfill (design D6 entry point 3)", () => {
  const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
  const ist = (y: number, mo: number, d: number, h: number, mi: number) =>
    Date.UTC(y, mo, d, h, mi) - IST_OFFSET_MS;

  /** Bars for Monday 2026-01-05, the only trading day these tests request. */
  function providerReturning(count: number): HistoryProvider {
    const open = ist(2026, 0, 5, 9, 15);
    const candles = Array.from({ length: count }, (_, i) => ({
      symbol: "NSE:NIFTY50-INDEX",
      interval: "5m" as const,
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1_000,
      ts: open + i * 300_000,
      source: "BROKER_HISTORICAL" as const,
    }));
    const result: HistoryResult = {
      candles,
      coverage: {
        requestedFrom: open,
        requestedTo: open + 86_400_000,
        requestedDays: ["2026-01-05"],
        coveredDays: count > 0 ? ["2026-01-05"] : [],
        missingDays: count > 0 ? [] : ["2026-01-05"],
        truncated: false,
      },
      rejected: [],
      empty: count === 0,
      pagesFetched: 1,
    };
    return { getHistory: () => Promise.resolve(result) };
  }

  const body = {
    symbols: ["NSE:NIFTY50-INDEX"],
    fromDate: "2026-01-05",
    toDate: "2026-01-05",
    maxDaysPerRequest: 100,
    stepUpPassword: "pw",
  };

  /**
   * D1's whole reason for being a capability interface rather than a widening
   * of `Broker`. A deployment with no real provider must say so — running to
   * completion and reporting that it stored nothing is indistinguishable from
   * a genuinely empty range.
   */
  it("refuses when no history provider is configured", async () => {
    makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/backfill",
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("no history provider");
  });

  it("takes step-up before doing anything", async () => {
    historyProvider = providerReturning(75);
    makeApp();
    await app.inject({
      method: "POST",
      url: "/backfill",
      payload: body,
    });

    expect(stepUps).toContain("pw");
  }, 30_000);

  /**
   * The gate runs BEFORE the provider check, so an unconfigured deployment
   * cannot be used to probe whether a password was accepted.
   */
  it("takes step-up even when it will then refuse", async () => {
    makeApp();
    await app.inject({
      method: "POST",
      url: "/backfill",
      payload: body,
    });

    expect(stepUps).toContain("pw");
  });

  it("stores the bars and reports COMPLETE", { timeout: 30_000 }, async () => {
    historyProvider = providerReturning(75);
    makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/backfill",
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json<{
      complete: boolean;
      dryRun: boolean;
      symbols: { symbol: string; status: string; stored: number }[];
    }>();
    expect(payload.complete).toBe(true);
    expect(payload.dryRun).toBe(false);
    expect(payload.symbols[0]).toMatchObject({
      symbol: "NSE:NIFTY50-INDEX",
      status: "COMPLETE",
      stored: 75,
    });
    expect(await connection.db.collection("candles").countDocuments()).toBe(75);
  });

  it("writes nothing on a dry run, but still reports", async () => {
    historyProvider = providerReturning(75);
    makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/backfill",
      payload: { ...body, dryRun: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ dryRun: boolean }>().dryRun).toBe(true);
    expect(await connection.db.collection("candles").countDocuments()).toBe(0);
  }, 30_000);

  /**
   * The label has to survive the HTTP boundary. A `ReadonlyMap` does not
   * serialize, and a partial dataset that arrives looking complete is exactly
   * what PARTIAL_HISTORY exists to prevent.
   */
  it("reports PARTIAL_HISTORY when a requested day produced nothing", async () => {
    historyProvider = providerReturning(0);
    makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/backfill",
      payload: body,
    });

    const payload = response.json<{
      complete: boolean;
      symbols: { status: string; missingPeriods: { cause: string }[] }[];
    }>();
    expect(payload.complete).toBe(false);
    expect(payload.symbols[0]?.status).toBe("EMPTY");
    expect(payload.symbols[0]?.missingPeriods[0]?.cause).toBe("DATA_MISSING");
  }, 30_000);

  /**
   * §3.1 Q1 measured the cap at 100 days, but a measured number in a document
   * is not one baked into a handler. Requiring it keeps the value somewhere a
   * human looks, and stops a stale default silently truncating.
   */
  it("requires maxDaysPerRequest", async () => {
    historyProvider = providerReturning(75);
    makeApp();
    const { maxDaysPerRequest, ...without } = body;
    void maxDaysPerRequest;
    const response = await app.inject({
      method: "POST",
      url: "/backfill",
      payload: without,
    });

    expect(response.statusCode).toBe(400);
  });

  it.each([
    ["05-01-2026", "a non-ISO date"],
    ["2026-1-5", "an unpadded date"],
  ])("rejects %s (%s)", async (fromDate) => {
    historyProvider = providerReturning(75);
    makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/backfill",
      payload: { ...body, fromDate },
    });

    expect(response.statusCode).toBe(400);
  });

  it(
    "falls back to indexSymbols when no symbols are given",
    { timeout: 30_000 },
    async () => {
      historyProvider = providerReturning(75);
      makeApp();
      const { symbols, ...without } = body;
      void symbols;
      const response = await app.inject({
        method: "POST",
        url: "/backfill",
        payload: without,
      });

      // The default settings document names the two indices, so the run covers
      // both rather than silently doing nothing.
      expect(response.statusCode).toBe(200);
      const payload = response.json<{ symbols: { symbol: string }[] }>();
      expect(payload.symbols.map((r) => r.symbol)).toEqual([
        "NSE:NIFTY50-INDEX",
        "NSE:NIFTYBANK-INDEX",
      ]);
    },
  );
});

describe("GET /trades (§2.9)", () => {
  const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
  const istMid = (day: string) =>
    Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS;

  const trade = (over: Record<string, unknown> = {}) => ({
    tradeId: "trd_1",
    strategyId: "str_a",
    symbol: "NSE:A-EQ",
    side: "LONG",
    mode: "paper",
    entryOrderId: "ord_in",
    entryTime: istMid("2026-01-05") + 3_600_000,
    entryPrice: 100,
    quantity: 10,
    openQuantity: 0,
    status: "CLOSED",
    charges: 0,
    slippage: 0,
    grossPnl: 50,
    netPnl: 50,
    openedAt: istMid("2026-01-05") + 3_600_000,
    ...over,
  });

  async function seed(rows: Record<string, unknown>[]) {
    await connection.db.collection("trades").insertMany(rows);
  }

  it("returns the most recent trades when no range is given", async () => {
    makeApp();
    await seed([
      trade({ tradeId: "trd_old", entryTime: istMid("2026-01-05") }),
      trade({ tradeId: "trd_new", entryTime: istMid("2026-02-05") }),
    ]);

    const response = await app.inject({ method: "GET", url: "/trades" });
    expect(response.statusCode).toBe(200);
    const rows = response.json<{ tradeId: string }[]>();
    expect(rows.map((r) => r.tradeId)).toEqual(["trd_new", "trd_old"]);
  });

  /**
   * `toDate` is inclusive to the operator but the query is half-open, so a
   * trade on the last day must be included. Getting this backwards silently
   * drops a day from every range anyone asks for.
   */
  it("includes trades on the final day of the range", async () => {
    makeApp();
    await seed([
      trade({ tradeId: "trd_last", entryTime: istMid("2026-01-09") + 60_000 }),
      trade({ tradeId: "trd_after", entryTime: istMid("2026-01-10") + 60_000 }),
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/trades?fromDate=2026-01-05&toDate=2026-01-09",
    });
    const rows = response.json<{ tradeId: string }[]>();
    expect(rows.map((r) => r.tradeId)).toEqual(["trd_last"]);
  });

  it("filters by strategy and by symbol", async () => {
    makeApp();
    await seed([
      trade({ tradeId: "trd_a", strategyId: "str_a", symbol: "NSE:A-EQ" }),
      trade({ tradeId: "trd_b", strategyId: "str_b", symbol: "NSE:B-EQ" }),
    ]);

    const byStrategy = await app.inject({
      method: "GET",
      url: "/trades?fromDate=2026-01-01&toDate=2026-01-31&strategyId=str_b",
    });
    expect(
      byStrategy.json<{ tradeId: string }[]>().map((r) => r.tradeId),
    ).toEqual(["trd_b"]);

    const bySymbol = await app.inject({
      method: "GET",
      url: "/trades?fromDate=2026-01-01&toDate=2026-01-31&symbol=NSE:A-EQ",
    });
    expect(
      bySymbol.json<{ tradeId: string }[]>().map((r) => r.tradeId),
    ).toEqual(["trd_a"]);
  });

  /**
   * A half-specified range reads as a typo more often than an intention, and
   * answering it with an unbounded scan of the research dataset is the wrong
   * guess to make for someone.
   */
  it.each([
    ["/trades?fromDate=2026-01-05", "only fromDate"],
    ["/trades?toDate=2026-01-09", "only toDate"],
  ])("refuses %s (%s)", async (url) => {
    makeApp();
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(400);
  });

  it("refuses an inverted range", async () => {
    makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/trades?fromDate=2026-01-09&toDate=2026-01-05",
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a malformed date", async () => {
    makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/trades?fromDate=05-01-2026&toDate=2026-01-09",
    });
    expect(response.statusCode).toBe(400);
  });

  it("honours an explicit limit", async () => {
    makeApp();
    await seed([
      trade({ tradeId: "t1", entryTime: istMid("2026-01-05") }),
      trade({ tradeId: "t2", entryTime: istMid("2026-01-06") }),
      trade({ tradeId: "t3", entryTime: istMid("2026-01-07") }),
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/trades?limit=2",
    });
    expect(response.json<unknown[]>()).toHaveLength(2);
  });

  /** Reading a record of what already happened changes nothing. */
  it("takes no step-up", async () => {
    makeApp();
    await app.inject({ method: "GET", url: "/trades" });
    expect(stepUps).toEqual([]);
  });
});

/**
 * Task 3.4, audit A4: exit rules can be set through the API. The engine
 * honoured them, but no route accepted them, so a time exit was reachable
 * only by editing Mongo — the shape of Phase 2's strategyVersion gap.
 */
describe("strategy exit rules (§3.4, audit A4)", () => {
  it("accepts exit rules on create", async () => {
    makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/strategies",
      payload: { ...createBody, exitRules: { maxHoldMinutes: 30 } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<StrategyConfig>().exitRules).toEqual({
      maxHoldMinutes: 30,
    });
  });

  it("updates exit rules, re-provisioning a running strategy", async () => {
    makeApp();
    const created = (
      await app.inject({
        method: "POST",
        url: "/strategies",
        payload: createBody,
      })
    ).json<StrategyConfig>();
    const res = await app.inject({
      method: "PATCH",
      url: `/strategies/${created.strategyId}`,
      payload: { exitRules: { maxHoldMinutes: 45 } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<StrategyConfig>().exitRules).toEqual({
      maxHoldMinutes: 45,
    });
    expect(runtime.calls).toContain(`disable:${created.strategyId}`);
  });

  it("rejects a non-positive hold limit", async () => {
    makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/strategies",
      payload: { ...createBody, exitRules: { maxHoldMinutes: 0 } },
    });
    expect(res.statusCode).toBe(400);
  });
});
