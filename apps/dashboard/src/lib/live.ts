import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "./api-client";
import { qk } from "./query-keys";
import {
  getMockSnapshot,
  type DashboardSnapshot,
  type StrategyRow,
  type SystemStatus,
} from "./data";

export interface LiveDashboard {
  snapshot: DashboardSnapshot;
  /** First paint hasn't resolved any live query yet. */
  isLoading: boolean;
  /** A query failed with 401 — the session is missing/expired (→ login). */
  unauthenticated: boolean;
}

function phaseToMarket(phase: string): SystemStatus["market"]["phase"] {
  if (phase === "open") return "open";
  if (phase === "pre-open") return "pre-open";
  return "closed";
}

/**
 * Assemble the dashboard snapshot from the live read models (plan/06 §5).
 * One mock-filled surface remains — broker health, which needs the live FYERS
 * broker (blocked on credentials); it is marked below as the single place to
 * remove. Every component keeps reading the same `DashboardSnapshot`.
 */
export function useDashboardData(enabled = true): LiveDashboard {
  const mock = getMockSnapshot();

  const positions = useQuery({
    queryKey: qk.positions,
    queryFn: api.positions,
    initialData: mock.positions,
    enabled,
  });
  const orders = useQuery({
    queryKey: qk.orders,
    queryFn: api.orders,
    initialData: mock.orders,
    enabled,
  });
  const activity = useQuery({
    queryKey: qk.activity,
    queryFn: api.activity,
    initialData: mock.activity,
    enabled,
  });
  const strategies = useQuery({
    queryKey: qk.strategies,
    queryFn: api.strategies,
    initialData: mock.strategies.map((row) => row.config),
    enabled,
  });
  const strategyStats = useQuery({
    queryKey: qk.strategyStats,
    queryFn: api.strategyStats,
    initialData: mock.strategies.map((row) => ({
      strategyId: row.config.strategyId,
      dayRealizedPnl: row.dayRealizedPnl,
      signalsToday: row.signalsToday,
    })),
    enabled,
  });
  const settings = useQuery({
    queryKey: qk.settings,
    queryFn: api.settings,
    enabled,
  });
  const pnl = useQuery({ queryKey: qk.pnl, queryFn: api.pnl, enabled });
  const pnlCurve = useQuery({
    queryKey: qk.pnlCurve,
    queryFn: api.pnlCurve,
    // One point a minute (the sampler's cadence) — poll, don't ride the
    // socket's PNL_UPDATED cascade.
    refetchInterval: 60_000,
    enabled,
  });
  const control = useQuery({
    queryKey: qk.controlStatus,
    queryFn: api.controlStatus,
    enabled,
  });

  const queries = [
    positions,
    orders,
    activity,
    strategies,
    strategyStats,
    settings,
    pnl,
    pnlCurve,
    control,
  ];
  const unauthenticated = queries.some(
    (q) => q.error instanceof ApiError && q.error.status === 401,
  );
  const isLoading = settings.isLoading || pnl.isLoading || control.isLoading;

  // --- Live where available ---
  const livePositions = positions.data;
  const openByStrategy = (id: string): number =>
    livePositions.filter((p) => p.strategyId === id && p.status === "OPEN")
      .length;

  const strategyRows: StrategyRow[] = strategies.data.map((config) => {
    const stats = strategyStats.data.find(
      (row) => row.strategyId === config.strategyId,
    );
    return {
      config,
      dayRealizedPnl: stats?.dayRealizedPnl ?? 0,
      signalsToday: stats?.signalsToday ?? 0,
      openPositions: openByStrategy(config.strategyId),
    };
  });
  const signalsToday = strategyStats.data.reduce(
    (sum, row) => sum + row.signalsToday,
    0,
  );

  const realized = pnl.data?.realizedPnl ?? mock.dayPnl.realized;
  const unrealized = pnl.data?.unrealizedPnl ?? mock.dayPnl.unrealized;
  const lossLimit =
    settings.data?.globalRiskLimits.maxDailyLoss ?? mock.dayPnl.lossLimit;
  const lossLimitUsed = realized < 0 ? Math.min(1, -realized / lossLimit) : 0;

  const status: SystemStatus = {
    mode: mock.status.mode, // TODO(read-model): expose broker mode
    broker: mock.status.broker, // TODO(read-model): live broker health
    market: {
      exchange: mock.status.market.exchange,
      phase: control.data
        ? phaseToMarket(control.data.session.phase)
        : mock.status.market.phase,
      ts: Date.now(),
    },
    engine: {
      state: control.data
        ? control.data.tradingEnabled
          ? "running"
          : "paused"
        : mock.status.engine.state,
      signalsToday,
    },
    tradingEnabled: control.data?.tradingEnabled ?? mock.status.tradingEnabled,
  };

  // Live curve once fetched; the mock's design-frame curve only until then.
  // An empty live curve (fresh day, market not yet open) renders honestly
  // empty rather than falling back to fabricated history.
  const curve = pnlCurve.data
    ? pnlCurve.data.map((point) => ({
        ts: point.ts,
        value: point.realizedPnl + point.unrealizedPnl,
      }))
    : mock.dayPnl.curve;

  const snapshot: DashboardSnapshot = {
    status,
    dayPnl: {
      realized,
      unrealized,
      lossLimit,
      lossLimitUsed,
      curve,
      ...(mock.dayPnl.warningArmedAt !== undefined
        ? { warningArmedAt: mock.dayPnl.warningArmedAt }
        : {}),
    },
    positions: livePositions,
    orders: orders.data,
    strategies: strategyRows,
    activity: activity.data,
    settings: settings.data
      ? {
          capitalAllocation: settings.data.capitalAllocation,
          maxDailyLoss: settings.data.globalRiskLimits.maxDailyLoss,
          maxPositionSize: settings.data.globalRiskLimits.maxPositionSize,
          maxOpenPositions: settings.data.globalRiskLimits.maxOpenPositions,
          maxExposure: settings.data.globalRiskLimits.maxExposure,
          squareOffTime: settings.data.marketHours.squareOff,
        }
      : mock.settings,
  };

  return { snapshot, isLoading, unauthenticated };
}
