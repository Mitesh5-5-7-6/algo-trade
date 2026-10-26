import { randomUUID } from "node:crypto";
import { z, type ZodType } from "zod";
import type { Db } from "mongodb";
import {
  RiskLimitsSchema,
  RiskRulesSchema,
  ExitRulesSchema,
  StrategyConfigSchema,
  type RiskLimits,
  type ExitRules,
  type StrategyConfig,
} from "@neelkanth/core";
import {
  CandlesRepository,
  TradesRepository,
  OrdersRepository,
  PnlSnapshotsRepository,
  PositionsRepository,
  RiskEventsRepository,
  RiskLogsRepository,
  SettingsRepository,
  SignalsRepository,
  StrategiesRepository,
  type GlobalSettings,
} from "@neelkanth/db";
import type { HistoryProvider } from "@neelkanth/broker";
import {
  istMidnight,
  runHistoricalBackfill,
  type BackfillReport,
} from "../jobs/historical-backfill.js";
import { resolveFnoLimits } from "@neelkanth/engines";
import { startOfDayIST } from "@neelkanth/core";
import { createStrategyRegistry } from "@neelkanth/strategies";
import type { ApiServer } from "../server.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { RuntimeControls, StepUpVerifier } from "./controls.js";
import { buildActivityFeed } from "./activity.js";

/** Single-operator system (plan/21 §6); replaced by the session user with auth. */
const OPERATOR_ID = "operator";
const LIST_LIMIT = 100;
const HISTORY_LIMIT = 1_000;

/**
 * Validate at the boundary (plan/04 §4) and tell the caller what was wrong.
 *
 * The message carries the field paths and reasons, because a bare "invalid
 * request" makes the operator guess. Zod's issues describe only the request
 * they just sent — no internal detail — so passing them through costs nothing
 * and turns a dead end into an instruction. They stay in `context` too, for
 * the structured log.
 */
function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path === "" ? issue.message : `${path}: ${issue.message}`;
      })
      .join("; ");
    throw new ValidationError(detail === "" ? "invalid request" : detail, {
      issues: result.error.issues,
    });
  }
  return result.data;
}

const IdParams = z.object({ id: z.string().min(1) });
const DateRangeQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

function istDateToUtcMs(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return Date.UTC(year, month - 1, day, -5, -30);
}

/**
 * A symbol the broker can actually stream: `EXCHANGE:INSTRUMENT`, e.g.
 * `NSE:RELIANCE-EQ` (plan/17 §7, and the form documented on `SymbolSchema`).
 *
 * Enforced HERE, at the write boundary, rather than on `SymbolSchema` itself.
 * Tightening the core schema would make existing rows unreadable — a strategy
 * saved with a bare ticker would throw on every `GET /strategies` instead of
 * being fixable through the UI.
 *
 * Why reject rather than normalize `RELIANCE` to `NSE:RELIANCE-EQ`: that guess
 * picks an exchange and a segment on the operator's behalf. The same ticker
 * exists on BSE, and as futures and options. Silently choosing one and
 * trading it is exactly the "mostly right" this system refuses (plan/02 §10).
 *
 * The failure this prevents is invisible and expensive: a bare ticker is
 * accepted, subscribed, and matches nothing. The feed reports healthy, the
 * strategy sits enabled, and it produces no signal — for an entire session,
 * with nothing anywhere saying why.
 */
const NormalizedSymbol = z
  .string()
  .regex(
    /^[A-Z]{2,6}:[A-Za-z0-9][A-Za-z0-9._&-]*$/,
    'must be EXCHANGE:INSTRUMENT, e.g. "NSE:RELIANCE-EQ" — a bare ticker ' +
      'like "RELIANCE" is not an instrument the broker can stream, so it ' +
      "would subscribe successfully and never deliver a tick",
  );

const CreateStrategyBody = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  symbols: z.array(NormalizedSymbol).min(1),
  riskRules: RiskRulesSchema.optional(),
  exitRules: ExitRulesSchema.optional(),
  enabled: z.boolean().default(false),
  stepUpPassword: z.string().optional(),
});

const UpdateStrategyBody = z.object({
  name: z.string().min(1).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  symbols: z.array(NormalizedSymbol).min(1).optional(),
  riskRules: RiskRulesSchema.optional(),
  exitRules: ExitRulesSchema.optional(),
  stepUpPassword: z.string().optional(),
});

/**
 * Whether an exit-rules change opts a strategy OUT of the square-off (D6).
 *
 * That loosens risk — a position may then carry overnight gap risk — so it
 * takes step-up, like loosening a limit in PATCH /settings. Rules that only add
 * ways out (a time exit, a trailing stop) do not, and neither does re-sending
 * an opt-out the strategy already has.
 */
function optsOutOfSquareOff(
  next: ExitRules | undefined,
  current: ExitRules | undefined,
): boolean {
  return (
    next?.squareOffAtSessionEnd === false &&
    current?.squareOffAtSessionEnd !== false
  );
}

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

/**
 * A trades query.
 *
 * Both bounds or neither: a half-specified range reads as a typo more often
 * than an intention, and answering it with an unbounded scan of the research
 * dataset is the wrong guess to make on someone's behalf.
 */
const TradesQuery = z.object({
  fromDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  toDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  strategyId: z.string().min(1).optional(),
  symbol: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

/**
 * A backfill request (design D6 entry point 3).
 *
 * `maxDaysPerRequest` is required and has no default, exactly as in the CLI.
 * §3.1 Q1 measured the cap at 100 days, but a measured number recorded in a
 * document is not the same as one baked into a request handler — the vendor
 * can change it, and a stale default would silently truncate. Making the
 * operator state it keeps the number somewhere a human looks.
 */
const BackfillBody = z.object({
  /** Defaults to `indexSymbols` in global settings (task 1.5: index-only). */
  symbols: z.array(z.string().min(1)).min(1).optional(),
  interval: z.enum(["1m", "5m", "15m", "30m", "60m"]).optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  maxDaysPerRequest: z.number().int().positive(),
  /** Fetch and report, write nothing. */
  dryRun: z.boolean().optional(),
  /**
   * Weekend dates the exchange traded anyway — the Budget session on 1
   * February, the Diwali Muhurat session. Without these a real session's bars
   * are rejected as falling on a non-trading day, which is how the first
   * one-year run silently discarded 75 genuine bars.
   */
  specialSessions: z.array(z.string()).optional(),
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
  if (
    next.maxDailyLoss > current.maxDailyLoss ||
    next.maxPositionSize > current.maxPositionSize ||
    next.maxCapitalPerTrade > current.maxCapitalPerTrade ||
    next.maxOpenPositions > current.maxOpenPositions ||
    next.maxExposure > current.maxExposure ||
    // Raising risk-per-trade enlarges every future position. It loosens the
    // envelope as surely as raising a cap does, so it takes the same step-up.
    next.riskPerTrade > current.riskPerTrade
  ) {
    return true;
  }

  // The F&O limits are optional and fall back to their equity counterparts, so
  // comparing the raw fields would miss two real loosenings: setting a
  // previously-absent F&O limit above the equity value it was inheriting, and
  // clearing one back to an inherited value that is higher than what it held.
  // Both are compared through the same resolution the Risk Engine uses, so the
  // question asked is "does the EFFECTIVE budget grow?" rather than "did a
  // field change?".
  const from = resolveFnoLimits(current);
  const to = resolveFnoLimits(next);
  return (
    to.riskPerTrade > from.riskPerTrade ||
    to.maxCapitalPerTrade > from.maxCapitalPerTrade ||
    to.maxExposure > from.maxExposure ||
    to.maxOpenPositions > from.maxOpenPositions ||
    // null means "no lot ceiling", which is the loosest possible value —
    // removing a ceiling is a loosening even though no number went up.
    (to.maxLotsPerTrade === null && from.maxLotsPerTrade !== null) ||
    (to.maxLotsPerTrade !== null &&
      from.maxLotsPerTrade !== null &&
      to.maxLotsPerTrade > from.maxLotsPerTrade)
  );
}

export interface ControlPlaneDeps {
  db: Db;
  runtime: RuntimeControls;
  /** Enforces step-up re-auth on dangerous routes (plan/21 §5). */
  verifyStepUp: StepUpVerifier;
  /**
   * Historical fetch, or null where no real provider exists (design D1).
   *
   * Null is meaningful rather than merely absent: `POST /backfill` refuses
   * outright instead of running to completion and reporting that it stored
   * nothing. A deployment with paper or scripted brokers has no history to
   * fetch, and saying so is more useful than an empty success.
   */
  historyProvider?: HistoryProvider | null;
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
  const positions = new PositionsRepository(deps.db);
  const signals = new SignalsRepository(deps.db);
  const riskEvents = new RiskEventsRepository(deps.db);
  const riskLogs = new RiskLogsRepository(deps.db);
  const pnlSnapshots = new PnlSnapshotsRepository(deps.db);
  const settings = new SettingsRepository(deps.db);
  const candles = new CandlesRepository(deps.db);
  const trades = new TradesRepository(deps.db);
  const registry = createStrategyRegistry();
  const { runtime, verifyStepUp } = deps;

  // --- Strategies (plan/06 §4, plan/15 §4) ---

  app.get("/strategies", () => strategies.listByOwner(OPERATOR_ID));

  // The create-form catalog: which `type` values the registry can run.
  app.get("/strategies/types", () => registry.types());

  // Per-strategy day stats (plan/06 §4): realized PnL + actionable signal
  // count since IST midnight, zero-filled over the operator's strategies.
  // Static segment — registered alongside /strategies/:id, static wins.
  app.get("/strategies/stats", async () => {
    const since = startOfDayIST(Date.now());
    const [
      configs,
      realizedByStrategy,
      signalsByStrategy,
      evaluationsByStrategy,
    ] = await Promise.all([
      strategies.listByOwner(OPERATOR_ID),
      positions.sumRealizedByStrategySince(since),
      signals.countActionableByStrategySince(since),
      signals.countEvaluationsByStrategySince(since),
    ]);
    return configs.map((config) => ({
      strategyId: config.strategyId,
      dayRealizedPnl: realizedByStrategy.get(config.strategyId) ?? 0,
      signalsToday: signalsByStrategy.get(config.strategyId) ?? 0,
      // Every verdict, HOLD included. Zero here means the strategy never ran —
      // a wiring or data problem. Non-zero with signalsToday at 0 means it ran
      // and found no setup, which is a normal quiet day. Without this the two
      // are indistinguishable (plan/06 §7: never look healthier than you are).
      evaluationsToday: evaluationsByStrategy.get(config.strategyId) ?? 0,
    }));
  });

  app.post("/strategies", async (request, reply) => {
    const body = parse(CreateStrategyBody, request.body);
    if (optsOutOfSquareOff(body.exitRules, undefined)) {
      await verifyStepUp(request.authUser?.userId, body.stepUpPassword);
    }
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
      ...(body.exitRules === undefined ? {} : { exitRules: body.exitRules }),
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
    if (body.exitRules !== undefined) {
      const current = await strategies.findById(id);
      if (optsOutOfSquareOff(body.exitRules, current?.exitRules)) {
        await verifyStepUp(request.authUser?.userId, body.stepUpPassword);
      }
    }
    // Only defined keys — exactOptionalPropertyTypes rejects `T | undefined`.
    const patch: Partial<
      Pick<
        StrategyConfig,
        "name" | "params" | "symbols" | "riskRules" | "exitRules"
      >
    > = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.params !== undefined) patch.params = body.params;
    if (body.symbols !== undefined) patch.symbols = body.symbols;
    if (body.riskRules !== undefined) patch.riskRules = body.riskRules;
    if (body.exitRules !== undefined) patch.exitRules = body.exitRules;
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
  app.get("/orders", async (request) => {
    // `request.query` is already `unknown` here — no route generic narrows it —
    // so the narrowing below is the only thing that gives it a shape.
    const query: unknown = request.query;
    if (
      query &&
      typeof query === "object" &&
      "from" in query &&
      "to" in query
    ) {
      const { from, to } = parse(DateRangeQuery, query);
      const fromMs = istDateToUtcMs(from);
      const toMsExclusive = istDateToUtcMs(to) + 86_400_000;
      if (fromMs >= toMsExclusive) {
        throw new ValidationError("from must be on or before to");
      }
      return orders.findByDateRange(fromMs, toMsExclusive, HISTORY_LIMIT);
    }
    return orders.findRecent(LIST_LIMIT);
  });
  app.get("/signals", () => signals.findRecent(LIST_LIMIT));
  app.get("/risk-events", () => riskEvents.findRecent(LIST_LIMIT));
  app.get("/risk-logs", () => riskLogs.findRecent(LIST_LIMIT));

  // The Overview activity feed: signals + orders + blocked entries, merged and
  // time-ordered (plan/06 §4). A read-model folded from the durable records.
  app.get("/activity", async () => {
    const [recentSignals, recentOrders, blockedRisk] = await Promise.all([
      signals.findRecent(LIST_LIMIT),
      orders.findRecent(LIST_LIMIT),
      riskLogs.findRecent(LIST_LIMIT, true),
    ]);
    return buildActivityFeed(
      recentSignals,
      recentOrders,
      blockedRisk,
      LIST_LIMIT,
    );
  });
  app.get("/pnl", () => ({
    realizedPnl: runtime.realizedPnl(),
    unrealizedPnl: runtime.unrealizedPnl(),
  }));
  // Today's intraday curve — in-memory samples (plan/06 §4); the durable
  // per-day history is /pnl/history (plan/07 pnl_snapshots).
  app.get("/pnl/curve", () => runtime.equityCurve());
  app.get("/pnl/history", () => pnlSnapshots.findByScope("global", LIST_LIMIT));

  // --- Settings (plan/07 `settings`) ---

  app.get("/settings", () => settings.getGlobal());

  // ⚠ step-up when loosening a limit or changing capital (plan/21 §5).
  app.patch("/settings", async (request) => {
    const body = parse(UpdateSettingsBody, request.body);
    const current = await settings.getGlobal();
    // Re-parse so schema defaults (riskPerTrade) are applied before the
    // limits are compared or stored — an omitted field must resolve to its
    // default, not to undefined.
    const nextLimits =
      body.globalRiskLimits === undefined
        ? undefined
        : RiskLimitsSchema.parse(body.globalRiskLimits);
    const changesCapital =
      body.capitalAllocation !== undefined &&
      body.capitalAllocation !== current.capitalAllocation;
    const loosens =
      nextLimits !== undefined &&
      loosensLimits(current.globalRiskLimits, nextLimits);
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
    if (nextLimits !== undefined) patch.globalRiskLimits = nextLimits;
    if (body.marketHours !== undefined) patch.marketHours = body.marketHours;
    const updated = await settings.updateGlobal(patch);
    runtime.applyGlobalSettings({
      limits: updated.globalRiskLimits,
      allocatedCapital: updated.capitalAllocation,
    });
    return updated;
  });

  // --- Control (plan/06 §4, plan/12 §4) ---

  /**
   * ⚠ step-up. Operator-triggered historical backfill (design D6).
   *
   * Gated for two reasons, either of which would be enough. It writes to the
   * candle collection that every backtest and every indicator warm-up reads,
   * and it spends vendor rate-limit budget on an account that is also
   * trading. Neither is something a stray click should do.
   *
   * Synchronous by design at the agreed scope: §10.2 is index-only over one
   * year, which Q1's 100-day page turns into 4 requests per symbol — the
   * measured run took under two seconds. A wider universe would need this to
   * become a queued job, and that is a decision to make when the universe
   * widens, not a generality to build now.
   */
  app.post("/backfill", async (request) => {
    const body = parse(BackfillBody, request.body);
    await verifyStepUp(request.authUser?.userId, body.stepUpPassword);

    const provider = deps.historyProvider ?? null;
    if (provider === null) {
      throw new ValidationError(
        "no history provider is configured — this deployment cannot fetch " +
          "historical candles",
      );
    }

    const global = await settings.getGlobal();
    const symbols = body.symbols ?? global.indexSymbols;
    if (symbols.length === 0) {
      throw new ValidationError(
        "no symbols: pass symbols, or set indexSymbols in global settings",
      );
    }

    const report = await runHistoricalBackfill(
      {
        symbols,
        interval: body.interval ?? "5m",
        fromDate: body.fromDate,
        toDate: body.toDate,
      },
      {
        history: provider,
        // The same holiday list the live session reads, so ingestion and
        // trading cannot disagree about which days existed.
        holidays: new Set(global.marketHolidays),
        specialSessions: new Set(body.specialSessions ?? []),
        daysPerRange: body.maxDaysPerRequest,
        saveCandle:
          (body.dryRun ?? false)
            ? () => Promise.resolve(true)
            : (candle) =>
                candles.upsert(candle as Parameters<typeof candles.upsert>[0]),
      },
    );

    return serializeBackfillReport(report, body.dryRun ?? false);
  });

  /**
   * Completed trades — the outcome primitive research reads (ADR §9.2).
   *
   * Read-only and unauthenticated beyond the usual session guard: a trade
   * is a record of what already happened, so reading one changes nothing.
   * Contrast `POST /backfill`, which writes and therefore takes step-up.
   *
   * A date range reads through `findRange`, which is served by the
   * `(strategyId, entryTime)` index; without one it falls back to the most
   * recent trades rather than scanning the whole collection.
   */
  app.get("/trades", async (request) => {
    const query = parse(TradesQuery, request.query);
    const limit = query.limit ?? LIST_LIMIT;

    if ((query.fromDate === undefined) !== (query.toDate === undefined)) {
      throw new ValidationError(
        "fromDate and toDate must be given together, or neither",
      );
    }

    if (query.fromDate === undefined || query.toDate === undefined) {
      return trades.findRecent(limit);
    }

    // Half-open, IST: `toDate` is inclusive to the operator, so the query
    // runs to the start of the following day. Consecutive ranges then tile
    // exactly, with no trade counted twice at a boundary.
    const fromTs = istMidnight(query.fromDate);
    const toTs = istMidnight(query.toDate) + 86_400_000;
    if (toTs <= fromTs) {
      throw new ValidationError(
        `range is inverted: ${query.fromDate} is after ${query.toDate}`,
      );
    }

    const rows = await trades.findRange(fromTs, toTs, {
      ...(query.strategyId === undefined
        ? {}
        : { strategyId: query.strategyId }),
      ...(query.symbol === undefined ? {} : { symbol: query.symbol }),
    });
    return rows.slice(0, limit);
  });

  /**
   * ⚠ step-up. Flatten one position immediately (Phase 3 D5).
   *
   * Behind the same gate as PATCH /settings and POST /backfill, for the
   * plainest of the three reasons: it sends a live market order. It must not
   * be a stray click, nor reachable by a session someone left open.
   *
   * Recorded as MANUAL_EMERGENCY. An operator overriding the system is a
   * different event from a strategy deciding it is done, and a dataset that
   * recorded the first as the second would teach a strategy it did something
   * it never did.
   */
  app.post("/positions/:positionId/exit", async (request) => {
    const { positionId } = parse(
      z.object({ positionId: z.string().min(1) }),
      request.params,
    );
    const body = parse(StepUpBody, request.body ?? {});
    await verifyStepUp(request.authUser?.userId, body.stepUpPassword);

    if (!(await runtime.exitPositionNow(positionId))) {
      // Not a silent 204: the position may have closed on its own, an exit
      // may already be on its way, or risk refused this one. Each is a state
      // the operator must not mistake for "done".
      throw new NotFoundError(
        `no exit sent for ${positionId}: not open, an exit is already in flight, or risk refused it`,
      );
    }
    return { positionId, exiting: true, reason: "MANUAL_EMERGENCY" };
  });

  app.get("/control/status", async () => {
    const global = await settings.getGlobal();
    return {
      tradingEnabled: global.tradingEnabled,
      session: runtime.session(),
      openPositions: runtime.getOpenPositions().length,
      // The market-data feed (plan/19 §4). Without this the dashboard cannot
      // tell "running and waiting for a signal" from "running with no data
      // arriving at all" — they look identical, and only one of them is fine.
      broker: runtime.brokerConnection(),
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

/**
 * A `ReadonlyMap` does not survive JSON, so the per-symbol rows are emitted
 * as an array. The status label leads each row: a reader must not have to
 * reach the end of the object to learn the dataset is incomplete.
 */
function serializeBackfillReport(report: BackfillReport, dryRun: boolean) {
  return {
    dryRun,
    requestedTradingDays: report.requestedTradingDays,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    /** True only when every symbol came back COMPLETE and nothing failed. */
    complete: [...report.perSymbol.values()].every(
      (row) => row.status === "COMPLETE",
    ),
    symbols: [...report.perSymbol.entries()].map(([symbol, row]) => ({
      symbol,
      ...row,
    })),
  };
}
