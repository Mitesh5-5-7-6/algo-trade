import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  Position,
  RiskLimits,
  SessionContext,
  StrategyConfig,
} from "@neelkanth/core";
import {
  connectMongo,
  ensureIndexes,
  PositionsRepository,
  SignalsRepository,
  StrategiesRepository,
  type MongoConnection,
} from "@neelkanth/db";
import { createLogger } from "@neelkanth/logger";
import { buildServer, type ApiServer } from "../server.js";
import { registerControlPlane } from "./routes.js";
import type { RuntimeControls, StepUpVerifier } from "./controls.js";

const MONGO_URI =
  process.env["MONGO_URI"] ?? "mongodb://localhost:27017/neelkanth_cp_test";

let connection: MongoConnection;

beforeAll(async () => {
  connection = await connectMongo(MONGO_URI, "neelkanth_it_cp");
  await connection.db.dropDatabase();
  await ensureIndexes(connection.db);
});

afterAll(async () => {
  await connection.close();
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
    session: (): SessionContext => ({ phase: "open", minutesSinceOpen: 30 }),
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
  });
}

afterEach(async () => {
  await app.close();
  await connection.db.collection("strategies").deleteMany({});
  await connection.db.collection("settings").deleteMany({});
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
    expect(rows).toEqual([
      { strategyId: "str_stats_a", dayRealizedPnl: 320, signalsToday: 1 },
      { strategyId: "str_stats_idle", dayRealizedPnl: 0, signalsToday: 0 },
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
