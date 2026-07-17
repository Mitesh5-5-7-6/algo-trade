import type { Order, Position, StrategyConfig } from "@neelkanth/core";
import { API_BASE } from "./config";
import type { ActivityEntry } from "./data";

/**
 * The REST half of the two data channels (plan/06 §5): request/response for
 * config, history, and control actions — the operator needs a confirmed result.
 * Live state arrives over the socket instead. Every call sends the session
 * cookie (`credentials: "include"`); a non-2xx becomes a typed {@link ApiError}
 * so callers can branch on 401 (→ login) vs the rest.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Machine-readable code from the error envelope (plan/05 §5). */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** True when the server demands password re-entry (plan/21 §5). */
export function isStepUpRequired(error: unknown): boolean {
  return error instanceof ApiError && error.code === "STEP_UP_REQUIRED";
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    let message = response.statusText;
    let code: string | undefined;
    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string };
      };
      message = body.error?.message ?? message;
      code = body.error?.code;
    } catch {
      // non-JSON body — keep the status text
    }
    throw new ApiError(response.status, message, code);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** The `/pnl` read model (plan/05 §4.1). */
export interface PnlSummary {
  realizedPnl: number;
  unrealizedPnl: number;
}

/** The `/strategies/stats` read model — per-strategy day stats (plan/06 §4). */
export interface StrategyDayStats {
  strategyId: string;
  dayRealizedPnl: number;
  signalsToday: number;
}

/** One `/pnl/curve` sample — the intraday day-curve point (plan/06 §4). */
export interface EquityPoint {
  ts: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

/** The `/settings` document the operator tunes (plan/07 `settings`). */
export interface LiveSettings {
  capitalAllocation: number;
  tradingEnabled: boolean;
  globalRiskLimits: {
    maxDailyLoss: number;
    maxPositionSize: number;
    maxCapitalPerTrade: number;
    maxOpenPositions: number;
    maxExposure: number;
  };
  marketHours: { open: string; close: string; squareOff: string };
}

/** The `/control/status` snapshot (plan/05 §4.1). */
export interface ControlStatus {
  tradingEnabled: boolean;
  session: { phase: string; minutesSinceOpen: number };
  openPositions: number;
}

/** POST /strategies body — the create form's shape. */
export interface CreateStrategyBody {
  type: string;
  name: string;
  params: Record<string, unknown>;
  symbols: string[];
  enabled: boolean;
}

/** PATCH /strategies/:id body — only the fields being changed. */
export interface UpdateStrategyBody {
  name?: string;
  params?: Record<string, unknown>;
  symbols?: string[];
}

/**
 * PATCH /settings body. `stepUpPassword` rides along when the server demands
 * re-auth — loosening a limit or changing capital (plan/21 §5).
 */
export interface UpdateSettingsBody {
  capitalAllocation?: number;
  globalRiskLimits?: LiveSettings["globalRiskLimits"];
  stepUpPassword?: string;
}

export const api = {
  login: (email: string, password: string) =>
    apiFetch<{ userId: string; email: string; role: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => apiFetch<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  positions: () => apiFetch<Position[]>("/positions"),
  orders: () => apiFetch<Order[]>("/orders"),
  activity: () => apiFetch<ActivityEntry[]>("/activity"),
  strategies: () => apiFetch<StrategyConfig[]>("/strategies"),
  strategyStats: () => apiFetch<StrategyDayStats[]>("/strategies/stats"),
  strategyTypes: () => apiFetch<string[]>("/strategies/types"),
  createStrategy: (body: CreateStrategyBody) =>
    apiFetch<StrategyConfig>("/strategies", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateStrategy: (id: string, body: UpdateStrategyBody) =>
    apiFetch<StrategyConfig>(`/strategies/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteStrategy: (id: string) =>
    apiFetch<undefined>(`/strategies/${id}`, { method: "DELETE" }),
  enableStrategy: (id: string) =>
    apiFetch<StrategyConfig>(`/strategies/${id}/enable`, { method: "POST" }),
  disableStrategy: (id: string) =>
    apiFetch<StrategyConfig>(`/strategies/${id}/disable`, { method: "POST" }),
  settings: () => apiFetch<LiveSettings>("/settings"),
  /** ⚠ step-up when loosening a limit or changing capital (plan/21 §5). */
  updateSettings: (body: UpdateSettingsBody) =>
    apiFetch<LiveSettings>("/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  pnl: () => apiFetch<PnlSummary>("/pnl"),
  pnlCurve: () => apiFetch<EquityPoint[]>("/pnl/curve"),
  controlStatus: () => apiFetch<ControlStatus>("/control/status"),

  pause: () =>
    apiFetch<{ tradingEnabled: boolean }>("/control/pause", { method: "POST" }),
  kill: () =>
    apiFetch<{ killed: boolean }>("/control/kill", { method: "POST" }),
  /** ⚠ step-up: resume requires the operator's password (plan/21 §5). */
  resume: (stepUpPassword: string) =>
    apiFetch<{ tradingEnabled: boolean }>("/control/resume", {
      method: "POST",
      body: JSON.stringify({ stepUpPassword }),
    }),
};
