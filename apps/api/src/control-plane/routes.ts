import { randomUUID } from "node:crypto";
import { z, type ZodType } from "zod";
import type { Db } from "mongodb";
import {
  RiskLimitsSchema,
  RiskRulesSchema,
  StrategyConfigSchema,
  type RiskLimits,
  type StrategyConfig,
} from "@neelkanth/core";
import {
  OrdersRepository,
  PnlSnapshotsRepository,
  RiskLogsRepository,
  SettingsRepository,
  SignalsRepository,
  StrategiesRepository,
  type GlobalSettings,
} from "@neelkanth/db";
import { createStrategyRegistry } from "@neelkanth/strategies";
import type { ApiServer } from "../server.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { RuntimeControls, StepUpVerifier } from "./controls.js";

/** Single-operator system (plan/21 §6); replaced by the session user with auth. */
const OPERATOR_ID = "operator";
const LIST_LIMIT = 100;

function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError("invalid request", {
      issues: result.error.issues,
    });
  }
  return result.data;
}

const IdParams = z.object({ id: z.string().min(1) });

const CreateStrategyBody = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  symbols: z.array(z.string().min(1)).min(1),
  riskRules: RiskRulesSchema.optional(),
  enabled: z.boolean().default(false),
});

const UpdateStrategyBody = z.object({
  name: z.string().min(1).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  symbols: z.array(z.string().min(1)).min(1).optional(),
  riskRules: RiskRulesSchema.optional(),
});

const UpdateSettingsBody = z.object({
  capitalAllocation: z.number().nonnegative().optional(),
  globalRiskLimits: RiskLimitsSchema.optional(),
  marketHours: z
    .object({
      open: z.string().regex(/^\d{2}:\d{2}$/),
      close: z.string().regex(/^\d{2}:\d{2}$/),
      squareOff: z.string().regex(/^\d{2}:\d{2}$/),
    })
    .optional(),
  /** Password re-entry for the step-up gate (plan/21 §5), when required. */
  stepUpPassword: z.string().optional(),
});

/** Body carrying only the step-up confirmation — resume takes nothing else. */
const StepUpBody = z.object({ stepUpPassword: z.string().optional() });

/**
 * Every risk limit is an upper bound (plan/14 §4): a higher value is more
 * permissive. So "loosening" — the thing that needs step-up (plan/21 §5) — is
 * simply any field increasing. Tightening stays friction-free: cutting risk in
 * a hurry must never be gated behind a password prompt.
 */
function loosensLimits(current: RiskLimits, next: RiskLimits): boolean {
  return (
    next.maxDailyLoss > current.maxDailyLoss ||
    next.maxPositionSize > current.maxPositionSize ||
    next.maxCapitalPerTrade > current.maxCapitalPerTrade ||
    next.maxOpenPositions > current.maxOpenPositions ||
    next.maxExposure > current.maxExposure
  );
}

export interface ControlPlaneDeps {
  db: Db;
  runtime: RuntimeControls;
  /** Enforces step-up re-auth on dangerous routes (plan/21 §5). */
  verifyStepUp: StepUpVerifier;
}

/**
 * The control-plane HTTP surface (plan/05 §4.1). Every route follows the §4
 * lifecycle: Zod-validated at the boundary, a service acting on repositories +
 * the live runtime, a uniform envelope (the central error handler shapes
 * failures). Routes marked ⚠ carry step-up re-auth (plan/21 §5) — enforced by
 * the auth plugin that wraps these; the routes themselves are the surface it
 * protects. Authentication is layered on next (plan/21); until then these are
 * the unauthenticated shape.
 */
export function registerControlPlane(
  app: ApiServer,
  deps: ControlPlaneDeps,
): void {
  const strategies = new StrategiesRepository(deps.db);
  const orders = new OrdersRepository(deps.db);
  const signals = new SignalsRepository(deps.db);
  const riskLogs = new RiskLogsRepository(deps.db);
  const pnlSnapshots = new PnlSnapshotsRepository(deps.db);
  const settings = new SettingsRepository(deps.db);
  const registry = createStrategyRegistry();
  const { runtime, verifyStepUp } = deps;

  // --- Strategies (plan/06 §4, plan/15 §4) ---

  app.get("/strategies", () => strategies.listByOwner(OPERATOR_ID));

  app.post("/strategies", async (request, reply) => {
    const body = parse(CreateStrategyBody, request.body);
    if (!registry.has(body.type)) {
      throw new ValidationError(`unknown strategy type: ${body.type}`, {
        type: body.type,
      });
    }
    const now = Date.now();
    const config: StrategyConfig = parse(StrategyConfigSchema, {
      strategyId: `str_${randomUUID()}`,
      ownerId: OPERATOR_ID,
      type: body.type,
      name: body.name,
      params: body.params,
      symbols: body.symbols,
      ...(body.riskRules === undefined ? {} : { riskRules: body.riskRules }),
      enabled: body.enabled,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await strategies.create(config);
    if (config.enabled) await runtime.enableStrategy(config);
    return reply.status(201).send(config);
  });

  app.get("/strategies/:id", async (request) => {
    const { id } = parse(IdParams, request.params);
    const config = await strategies.findById(id);
    if (config === null) throw new NotFoundError("strategy not found", { id });
    return config;
  });

  app.patch("/strategies/:id", async (request) => {
    const { id } = parse(IdParams, request.params);
    const body = parse(UpdateStrategyBody, request.body);
    // Only defined keys — exactOptionalPropertyTypes rejects `T | undefined`.
    const patch: Partial<
      Pick<StrategyConfig, "name" | "params" | "symbols" | "riskRules">
    > = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.params !== undefined) patch.params = body.params;
    if (body.symbols !== undefined) patch.symbols = body.symbols;
    if (body.riskRules !== undefined) patch.riskRules = body.riskRules;
    const updated = await strategies.update(id, patch);
    if (updated === null) throw new NotFoundError("strategy not found", { id });
    // Re-provision a running strategy so param/symbol changes take effect live.
    if (updated.enabled) {
      runtime.disableStrategy(id);
      await runtime.enableStrategy(updated);
    }
    return updated;
  });

  app.delete("/strategies/:id", async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    await strategies.softDelete(id);
    runtime.disableStrategy(id);
    return reply.status(204).send();
  });

  app.post("/strategies/:id/enable", async (request) => {
    const { id } = parse(IdParams, request.params);
    const config = await strategies.setEnabled(id, true);
    if (config === null) throw new NotFoundError("strategy not found", { id });
    await runtime.enableStrategy(config);
    return config;
  });

  app.post("/strategies/:id/disable", async (request) => {
    const { id } = parse(IdParams, request.params);
    const config = await strategies.setEnabled(id, false);
    if (config === null) throw new NotFoundError("strategy not found", { id });
    runtime.disableStrategy(id);
    return config;
  });

  // --- Read models (plan/06 §5: snapshot-then-stream) ---

  app.get("/positions", () => runtime.getOpenPositions());
  app.get("/orders", () => orders.findRecent(LIST_LIMIT));
  app.get("/signals", () => signals.findRecent(LIST_LIMIT));
  app.get("/risk-logs", () => riskLogs.findRecent(LIST_LIMIT));
  app.get("/pnl", () => ({
    realizedPnl: runtime.realizedPnl(),
    unrealizedPnl: runtime.unrealizedPnl(),
  }));
  app.get("/pnl/history", () => pnlSnapshots.findByScope("global", LIST_LIMIT));

  // --- Settings (plan/07 `settings`) ---

  app.get("/settings", () => settings.getGlobal());

  // ⚠ step-up when loosening a limit or changing capital (plan/21 §5).
  app.patch("/settings", async (request) => {
    const body = parse(UpdateSettingsBody, request.body);
    const current = await settings.getGlobal();
    const changesCapital =
      body.capitalAllocation !== undefined &&
      body.capitalAllocation !== current.capitalAllocation;
    const loosens =
      body.globalRiskLimits !== undefined &&
      loosensLimits(current.globalRiskLimits, body.globalRiskLimits);
    if (changesCapital || loosens) {
      await verifyStepUp(request.authUser?.userId, body.stepUpPassword);
    }

    const patch: Partial<
      Pick<
        GlobalSettings,
        "capitalAllocation" | "globalRiskLimits" | "marketHours"
      >
    > = {};
    if (body.capitalAllocation !== undefined) {
      patch.capitalAllocation = body.capitalAllocation;
    }
    if (body.globalRiskLimits !== undefined) {
      patch.globalRiskLimits = body.globalRiskLimits;
    }
    if (body.marketHours !== undefined) patch.marketHours = body.marketHours;
    const updated = await settings.updateGlobal(patch);
    runtime.applyGlobalSettings({
      limits: updated.globalRiskLimits,
      allocatedCapital: updated.capitalAllocation,
    });
    return updated;
  });

  // --- Control (plan/06 §4, plan/12 §4) ---

  app.get("/control/status", async () => {
    const global = await settings.getGlobal();
    return {
      tradingEnabled: global.tradingEnabled,
      session: runtime.session(),
      openPositions: runtime.getOpenPositions().length,
    };
  });

  // Pause/kill are deliberately friction-free — stopping must never be gated.
  app.post("/control/pause", async () => {
    await settings.setTradingEnabled(false);
    runtime.setTradingEnabled(false);
    return { tradingEnabled: false };
  });

  app.post("/control/kill", async () => {
    await settings.setTradingEnabled(false);
    runtime.setTradingEnabled(false);
    return { killed: true, tradingEnabled: false };
  });

  // ⚠ step-up: re-enabling after a kill is where a hijacked session does the
  // most damage (plan/21 §5).
  app.post("/control/resume", async (request) => {
    const body = parse(StepUpBody, request.body ?? {});
    await verifyStepUp(request.authUser?.userId, body.stepUpPassword);
    await settings.setTradingEnabled(true);
    runtime.setTradingEnabled(true);
    return { tradingEnabled: true };
  });
}
